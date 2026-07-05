import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { encodeFrame } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { MavRouter } from '../../../core/mavlink/router'
import { Telemetry, type TelemetryState } from '../../../core/mavlink/telemetry'
import type { MavSession } from '../../../core/mavlink/session'
import { useTelemetry } from '../useTelemetry'

const ATTITUDE_MSGID = 30

function attitudeFrame(roll: number, seq = 0): Uint8Array {
  const payload = encodePayload(defs, ATTITUDE_MSGID, { roll, pitch: 0, yaw: 0 })
  return encodeFrame(defs, { msgid: ATTITUDE_MSGID, payload }, seq, 1, 1)
}

/** Lets the router's read-pump microtask chain settle without relying on real timers — same pattern as connection.test.ts/telemetry.test.ts. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/**
 * A real `Telemetry` wired to a `MockTransport`+`MavRouter` (same pattern as
 * telemetry.test.ts), wrapped in a minimal object that's only good for its
 * `telemetry` field — the hook never reads `router`/`target`/`paramStore`,
 * so those are deliberately not built for real here.
 */
async function makeSession(): Promise<{ session: MavSession; transport: MockTransport }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs)
  await transport.open()
  router.start()
  const telemetry = new Telemetry(router, { sysid: 1, compid: 1 })
  return { session: { telemetry } as unknown as MavSession, transport }
}

describe('useTelemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null when there is no session', () => {
    const { result } = renderHook(() => useTelemetry(null))
    expect(result.current).toBeNull()
  })

  it('renders telemetry updates as they arrive on a fed session', async () => {
    const { session, transport } = await makeSession()
    const { result } = renderHook(() => useTelemetry(session))
    expect(result.current).toEqual({})

    await act(async () => {
      transport.feed(attitudeFrame(Math.PI / 2))
      await flush()
    })

    expect(result.current?.attitude?.rollDeg).toBeCloseTo(90)
  })

  it('returns null once the session becomes null (disconnect)', async () => {
    const { session, transport } = await makeSession()
    const { result, rerender } = renderHook(({ s }: { s: MavSession | null }) => useTelemetry(s), {
      initialProps: { s: session as MavSession | null },
    })

    await act(async () => {
      transport.feed(attitudeFrame(Math.PI / 4))
      await flush()
    })
    expect(result.current?.attitude).not.toBeUndefined()

    rerender({ s: null })

    expect(result.current).toBeNull()
  })

  it('unsubscribes on unmount — no further state updates, no act warnings', async () => {
    const { session, transport } = await makeSession()
    const unsubscribeSpy = vi.spyOn(session.telemetry, 'subscribe')
    const { unmount } = renderHook(() => useTelemetry(session))
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)

    unmount()

    // Feeding after unmount must not throw/warn (no setState-after-unmount) —
    // the hook's cleanup must have actually unsubscribed from `telemetry`.
    await act(async () => {
      transport.feed(attitudeFrame(0.1))
      await flush()
    })
  })

  it('ignores a late callback from the previous telemetry that fires after the session swap but before its own unsubscribe runs', async () => {
    // Regression test for the gap between the render-phase state swap (an
    // effect hasn't necessarily cleaned up yet) and the old effect's actual
    // cleanup: capture the *raw* callback `subscribe()` was given for the
    // first session, swap sessions, then invoke that stale callback
    // directly — simulating a message landing in exactly that gap, which
    // `act()`'s synchronous effect-flushing in this test environment could
    // otherwise never reproduce via a real `transport.feed()`.
    const first = await makeSession()
    const second = await makeSession()
    let firstCallback: ((s: Readonly<TelemetryState>) => void) | undefined
    vi.spyOn(first.session.telemetry, 'subscribe').mockImplementation((cb) => {
      firstCallback = cb
      return () => {}
    })

    const { result, rerender } = renderHook(({ s }: { s: MavSession }) => useTelemetry(s), {
      initialProps: { s: first.session },
    })
    expect(firstCallback).toBeDefined()

    rerender({ s: second.session })
    act(() => {
      firstCallback!({ attitude: { rollDeg: 999, pitchDeg: 0, yawDeg: 0, ts: 0 } })
    })

    expect(result.current?.attitude).toBeUndefined() // the stale callback must not have clobbered state
  })

  it('re-subscribes when the session identity changes (reconnect) and drops the previous subscription', async () => {
    const first = await makeSession()
    const second = await makeSession()

    const { result, rerender } = renderHook(({ s }: { s: MavSession }) => useTelemetry(s), {
      initialProps: { s: first.session },
    })

    rerender({ s: second.session })

    await act(async () => {
      first.transport.feed(attitudeFrame(Math.PI / 2)) // stale session — must be ignored
      await flush()
    })
    expect(result.current?.attitude).toBeUndefined()

    await act(async () => {
      second.transport.feed(attitudeFrame(Math.PI / 4))
      await flush()
    })
    expect(result.current?.attitude?.rollDeg).toBeCloseTo(45)
  })
})
