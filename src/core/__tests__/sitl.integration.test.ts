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
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WebSocketTransport } from '../transport/websocket'
import { defs } from '../mavlink/defs'
import { MavRouter, type LinkState } from '../mavlink/router'
import { ParamStore } from '../mavlink/params'
import { AVAILABLE_METADATA_VERSIONS, buildParamMetaTable, lookupParamMeta, matchFirmwareVersion, type ParamMetaFile, type ParamMetaTable } from '../paramMetadata'

const BRIDGE_URL = process.env.SITL_WS_URL ?? 'ws://localhost:5761'
const TEST_PARAM = 'LOG_BITMASK'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const METADATA_DIR = path.join(REPO_ROOT, 'public/param-metadata')

/**
 * Reads the generated metadata file straight off disk (`node:fs`, not
 * `fetchParamMetadata`'s HTTP `fetch`) — this test runs under Vitest's
 * `node` environment with no dev/preview server behind it, so there's no
 * same-origin URL to fetch. `public/param-metadata/*.json` is committed
 * (PRD #12 §1.1), so a normal checkout already has it; if the submodule pin
 * has moved since it was last regenerated, re-run
 * `node tools/generate-param-metadata.mjs` first, same as this test already
 * requires building SITL itself (docs/notes/sitl.md).
 */
function loadBundledMetadataForTest(): ParamMetaTable {
  const version = matchFirmwareVersion(AVAILABLE_METADATA_VERSIONS, undefined) // newest bundled — this test doesn't decode AUTOPILOT_VERSION itself
  const filePath = path.join(METADATA_DIR, `${version}.json`)
  if (!existsSync(filePath)) {
    throw new Error(
      `SITL integration: ${filePath} not found — run \`node tools/generate-param-metadata.mjs\` first ` +
        '(requires the ardupilot submodule + python3, see that script\'s own module doc)',
    )
  }
  const json = JSON.parse(readFileSync(filePath, 'utf8')) as ParamMetaFile
  return buildParamMetaTable(json)
}

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

          // Proves the generated JSON actually matches live protocol data
          // (issue #13 / PRD #12 §4) — a real param name fetched from a live
          // SITL instance built from the same pinned submodule commit must
          // resolve through lookupParamMeta against the bundled metadata,
          // not just round-trip the generation script's own output.
          const metaTable = loadBundledMetadataForTest()
          const meta = lookupParamMeta(metaTable, TEST_PARAM)
          expect(meta).toBeDefined()
          expect(meta!.displayName.length).toBeGreaterThan(0)
          console.info(`SITL integration: ${TEST_PARAM} metadata -> "${meta!.displayName}"`)

          const original = store.get(TEST_PARAM)
          expect(original).toBeDefined()
          const originalValue = original!.value

          // Toggle the low bit: always a different, still-valid int32
          // bitmask value, regardless of what SITL's default happens to be.
          const candidateValue = originalValue ^ 1

          // Non-pollution is the whole point of this test (see spec §8's
          // write-safety rule, cited in params.ts's own module doc) — so the
          // restore below must run even if an assertion in between throws,
          // and a failure during that best-effort restore must never mask
          // the original failure it's trying to clean up after. `succeeded`
          // is only set true right before the `finally`, so anything that
          // throws first (the `set()` call itself, or either `expect()`)
          // takes the swallow-and-log branch instead of the assert branch.
          let succeeded = false
          try {
            const written = await store.set(TEST_PARAM, candidateValue)
            console.info(`SITL integration: ${TEST_PARAM} ${originalValue} -> ${written.value} (set confirmed)`)
            expect(written.value).toBe(candidateValue)
            expect(store.get(TEST_PARAM)?.value).toBe(candidateValue)
            succeeded = true
          } finally {
            if (succeeded) {
              // Happy path: restoring (and confirming it) is itself part of
              // what this test asserts, so a failure here is a real test
              // failure, not something to swallow.
              const restored = await store.set(TEST_PARAM, originalValue)
              console.info(`SITL integration: ${TEST_PARAM} restored to ${restored.value}`)
              expect(restored.value).toBe(originalValue)
              expect(store.get(TEST_PARAM)?.value).toBe(originalValue)
            } else {
              // Something above already threw — restore best-effort and log
              // rather than throw, so the original failure (the one the
              // caller actually needs to see) still propagates.
              try {
                await store.set(TEST_PARAM, originalValue)
                console.info(`SITL integration: ${TEST_PARAM} restored to ${originalValue} (best-effort, after an earlier failure)`)
              } catch (restoreErr) {
                console.error(
                  `SITL integration: FAILED to restore ${TEST_PARAM} to ${originalValue} after an earlier failure — SITL's eeprom.bin may be left modified`,
                  restoreErr,
                )
              }
            }
          }
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
