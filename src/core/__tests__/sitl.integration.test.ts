/**
 * SITL integration test — proves the whole stack (`WebSocketTransport` ->
 * `MavRouter` -> `ParamStore`) against a REAL ArduPilot SITL instance
 * reached through `tools/sitl-bridge.mjs`, not the pymavlink-generated
 * fixtures the rest of the mavlink/ suite uses. Skipped unless `SITL=1` is
 * set. See docs/notes/sitl.md for how to build+launch SITL and the bridge
 * before running:
 *
 *   SITL=1 npx vitest run src/core/__tests__/sitl.integration.test.ts
 *
 * Runs under Vitest's `node` environment rather than the project-wide
 * `jsdom` default (vite.config.ts) so `WebSocketTransport`'s default
 * `wsFactory` picks up Node's own global `WebSocket` (stable since Node 22,
 * this repo's minimum) — the "real" client this test is meant to exercise,
 * as opposed to the injected `FakeWebSocket` `websocket.test.ts` uses.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { WebSocketTransport } from '../transport/websocket'
import { defs } from '../mavlink/defs'
import { MavRouter, type LinkState } from '../mavlink/router'
import { ParamStore } from '../mavlink/params'

const BRIDGE_URL = process.env.SITL_WS_URL ?? 'ws://localhost:5761'
const TEST_PARAM = 'LOG_BITMASK'

// SITL over a TCP round trip (plus its own param-storm pacing) is much
// slower than the MockTransport-backed unit tests elsewhere in mavlink/ —
// these are deliberately generous per the task brief. TEST_TIMEOUT_MS is the
// overall budget (connect + fetchAll + two set() round trips);
// LINK_CONNECTED_TIMEOUT_MS bounds just the post-connect wait for the first
// HEARTBEAT.
const LINK_CONNECTED_TIMEOUT_MS = 5_000
const TEST_TIMEOUT_MS = 60_000

/** Waits for `router.linkState` to reach 'connected', or rejects after `timeoutMs`. */
function waitForConnected(router: MavRouter, timeoutMs: number): Promise<void> {
  if (router.linkState === 'connected') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`linkState did not reach 'connected' within ${timeoutMs}ms (stuck at '${router.linkState}')`))
    }, timeoutMs)
    const unsubscribe = router.onLinkState((state: LinkState) => {
      if (state !== 'connected') return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

/**
 * Opens `transport` and starts `router`, retrying the `open()` once on
 * failure — the one retry the task brief allows, to absorb a SITL/bridge
 * that's still finishing its own startup handshake right as the test's
 * first connection attempt lands. Nothing past the initial `open()` is
 * retried.
 */
async function connectWithRetry(transport: WebSocketTransport, router: MavRouter): Promise<void> {
  try {
    await transport.open()
  } catch (err) {
    console.warn('SITL integration: initial connect failed, retrying once:', err)
    await transport.open()
  }
  router.start()
  await waitForConnected(router, LINK_CONNECTED_TIMEOUT_MS)
}

describe.skipIf(process.env.SITL !== '1')('SITL integration (real ArduPilot via tools/sitl-bridge.mjs)', () => {
  it(
    'connects, fetches the full param table, and round-trips a write with readback',
    async () => {
      const transport = new WebSocketTransport(BRIDGE_URL)
      const router = new MavRouter(transport, defs)

      try {
        await connectWithRetry(transport, router)

        // The autopilot component that just sent us a HEARTBEAT — this is
        // ParamStore's addressing target, not a hardcoded sysid/compid.
        const [target] = router.getComponents().values()
        expect(target).toBeDefined()

        const store = new ParamStore(router, { sysid: target!.sysid, compid: target!.compid })
        try {
          // fetchAll() itself rejects (ParamFetchError) if any index is
          // still missing after gap-fill — reaching here already proves
          // "no missing", not just ">500 collected".
          await store.fetchAll()
          expect(store.all.size).toBeGreaterThan(500)
          console.info(`SITL integration: fetchAll collected ${store.all.size} params`)

          const original = store.get(TEST_PARAM)
          expect(original).toBeDefined()

          // Toggle the low bit: always a different, still-valid int32
          // bitmask value, regardless of what SITL's default happens to be.
          const candidateValue = original!.value ^ 1

          const written = await store.set(TEST_PARAM, candidateValue)
          expect(written.value).toBe(candidateValue)
          expect(store.get(TEST_PARAM)?.value).toBe(candidateValue)
          console.info(`SITL integration: ${TEST_PARAM} ${original!.value} -> ${written.value} (set confirmed)`)

          const restored = await store.set(TEST_PARAM, original!.value)
          expect(restored.value).toBe(original!.value)
          expect(store.get(TEST_PARAM)?.value).toBe(original!.value)
          console.info(`SITL integration: ${TEST_PARAM} restored to ${restored.value}`)
        } finally {
          store.dispose()
        }
      } finally {
        await transport.close()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
