import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../transport/mock'
import { defs } from '../defs'
import { decodePayload } from '../decode'
import { encodeFrame, FrameParser } from '../frame'
import { encodePayload } from '../encode'
import { MavRouter } from '../router'
import {
  ParamCountDriftError,
  ParamFetchBusyError,
  ParamFetchError,
  ParamFetchNoResponseError,
  ParamPrecisionLossError,
  ParamStore,
  ParamStoreDisposedError,
  ParamUnknownError,
  ParamWriteBusyError,
  ParamWriteMismatchError,
  ParamWriteTimeoutError,
  type Param,
} from '../params'

const PARAM_REQUEST_READ_MSGID = 20
const PARAM_REQUEST_LIST_MSGID = 21
const PARAM_VALUE_MSGID = 22
const PARAM_SET_MSGID = 23

const MAV_PARAM_TYPE_INT32 = 6
const MAV_PARAM_TYPE_REAL32 = 9

function paramValueFrame(opts: {
  name: string
  value: number
  type: number
  count: number
  index: number
  sysid?: number
  compid?: number
  seq?: number
}): Uint8Array {
  const payload = encodePayload(defs, PARAM_VALUE_MSGID, {
    param_id: opts.name,
    param_value: opts.value,
    param_type: opts.type,
    param_count: opts.count,
    param_index: opts.index,
  })
  return encodeFrame(defs, { msgid: PARAM_VALUE_MSGID, payload }, opts.seq ?? 0, opts.sysid ?? 1, opts.compid ?? 1)
}

function decodeSent(bytes: Uint8Array): { msgid: number; fields: Record<string, unknown> } {
  const parser = new FrameParser(defs)
  const [frame] = parser.push(bytes)
  return { msgid: frame.msgid, fields: decodePayload(defs, frame).fields }
}

/** Subscriber-count introspection, same accepted pattern as command.test.ts. */
function subscriberCount(router: MavRouter): number {
  return (router as unknown as { subscribers: Set<unknown> }).subscribers.size
}

/** Feeds a passive PARAM_VALUE so the given name is cached before `set()` needs it. */
async function seedParam(transport: MockTransport, name: string, value: number, type: number, index = 0): Promise<void> {
  transport.feed(paramValueFrame({ name, value, type, count: 1, index }))
  await vi.advanceTimersByTimeAsync(0)
}

describe('ParamStore', () => {
  let transport: MockTransport
  let router: MavRouter
  const target = { sysid: 1, compid: 1 }

  beforeEach(async () => {
    vi.useFakeTimers()
    transport = new MockTransport()
    router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('fetchAll: happy path', () => {
    it('sends PARAM_REQUEST_LIST and resolves once all indices 0..count-1 are seen, populating `all`', async () => {
      const store = new ParamStore(router, target)
      const promise = store.fetchAll()
      await vi.advanceTimersByTimeAsync(0)

      expect(transport.sent).toHaveLength(1)
      const sent = decodeSent(transport.sent[0])
      expect(sent.msgid).toBe(PARAM_REQUEST_LIST_MSGID)
      expect(sent.fields).toMatchObject({ target_system: 1, target_component: 1 })

      transport.feed(paramValueFrame({ name: 'THR_MIN', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 0 }))
      transport.feed(paramValueFrame({ name: 'THR_MAX', value: 1000, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 1 }))
      await vi.advanceTimersByTimeAsync(0)

      await expect(promise).resolves.toBeUndefined()
      expect(store.all.size).toBe(2)
      expect(store.get('THR_MIN')).toEqual({ name: 'THR_MIN', value: 0, type: MAV_PARAM_TYPE_REAL32, index: 0 })
      expect(store.get('THR_MAX')).toEqual({ name: 'THR_MAX', value: 1000, type: MAV_PARAM_TYPE_REAL32, index: 1 })
    })

    it('tolerates out-of-order and duplicate PARAM_VALUE delivery', async () => {
      const store = new ParamStore(router, target)
      const promise = store.fetchAll()
      await vi.advanceTimersByTimeAsync(0)

      // Out of order: index 2 before 0/1. Duplicate: index 1 sent twice.
      transport.feed(paramValueFrame({ name: 'P2', value: 2, type: MAV_PARAM_TYPE_REAL32, count: 3, index: 2 }))
      transport.feed(paramValueFrame({ name: 'P1', value: 1, type: MAV_PARAM_TYPE_REAL32, count: 3, index: 1 }))
      transport.feed(paramValueFrame({ name: 'P1', value: 1, type: MAV_PARAM_TYPE_REAL32, count: 3, index: 1 }))
      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 3, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      await expect(promise).resolves.toBeUndefined()
      expect(store.all.size).toBe(3)
    })

    it('calls onProgress as PARAM_VALUEs arrive', async () => {
      const onProgress = vi.fn()
      const store = new ParamStore(router, target)
      const promise = store.fetchAll({ onProgress })
      await vi.advanceTimersByTimeAsync(0)

      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(onProgress).toHaveBeenCalledWith(1, 2)

      transport.feed(paramValueFrame({ name: 'P1', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 1 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(onProgress).toHaveBeenCalledWith(2, 2)

      await promise
    })
  })

  describe('fetchAll: gap-fill', () => {
    it('after the silence window, re-requests missing indices by PARAM_REQUEST_READ and resolves once filled', async () => {
      const store = new ParamStore(router, target, { fetchSilenceMs: 700 })
      const promise = store.fetchAll()
      await vi.advanceTimersByTimeAsync(0)

      // Only index 0 and 2 of 3 arrive; index 1 is missing.
      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 3, index: 0 }))
      transport.feed(paramValueFrame({ name: 'P2', value: 2, type: MAV_PARAM_TYPE_REAL32, count: 3, index: 2 }))
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(700) // silence window elapses -> gap-fill kicks in
      const gapFillRequest = transport.sent.find((bytes) => decodeSent(bytes).msgid === PARAM_REQUEST_READ_MSGID)
      expect(gapFillRequest).toBeDefined()
      expect(decodeSent(gapFillRequest!).fields).toMatchObject({ param_index: 1 })

      transport.feed(paramValueFrame({ name: 'P1', value: 1, type: MAV_PARAM_TYPE_REAL32, count: 3, index: 1 }))
      await vi.advanceTimersByTimeAsync(0)

      await expect(promise).resolves.toBeUndefined()
      expect(store.all.size).toBe(3)
    })

    it('retries a gap-fill request up to the configured limit, then rejects with ParamFetchError listing missing indices if rounds are exhausted', async () => {
      const store = new ParamStore(router, target, {
        fetchSilenceMs: 100,
        fetchRequestTimeoutMs: 50,
        fetchRetries: 2,
        fetchMaxRounds: 1,
      })
      const promise = store.fetchAll()
      const rejection = expect(promise).rejects.toBeInstanceOf(ParamFetchError)
      await vi.advanceTimersByTimeAsync(0)

      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      // Index 1 never arrives at all: silence window, then 1 round x (fetchRetries=2 -> 3 total
      // attempts, same "retries after the first" convention as command.ts) of PARAM_REQUEST_READ,
      // all unanswered.
      await vi.advanceTimersByTimeAsync(100) // silence window
      await vi.advanceTimersByTimeAsync(50) // gap-fill attempt 1 timeout
      await vi.advanceTimersByTimeAsync(50) // gap-fill attempt 2 timeout
      await vi.advanceTimersByTimeAsync(50) // gap-fill attempt 3 timeout -> round exhausted, rounds cap 1 -> reject

      await rejection
      const err = await promise.catch((e: unknown) => e as ParamFetchError)
      expect((err as ParamFetchError).missing).toEqual([1])
    })

    it('rejects with ParamFetchNoResponseError (not a silent empty-table success) if no PARAM_VALUE ever arrives', async () => {
      const store = new ParamStore(router, target, { fetchSilenceMs: 100 })
      const promise = store.fetchAll()
      const rejection = expect(promise).rejects.toBeInstanceOf(ParamFetchNoResponseError)
      await vi.advanceTimersByTimeAsync(0)

      // Nothing fed at all: the FC never answers PARAM_REQUEST_LIST.
      await vi.advanceTimersByTimeAsync(100)

      await rejection
      expect(store.all.size).toBe(0)
    })

    it('caps the silence window from resetting forever on a device that keeps emitting PARAM_VALUE without ever completing the table', async () => {
      const store = new ParamStore(router, target, {
        // Deliberately huge: with this window, a real per-arrival reset could never plausibly
        // elapse during this test — so if phase 1 ends at all, it can only be the reset-count
        // cap below, not a timing coincidence against the window duration.
        fetchSilenceMs: 100_000,
        fetchMaxSilenceResets: 3,
        fetchRequestTimeoutMs: 10,
        fetchRetries: 0,
        fetchMaxRounds: 1,
      })
      const promise = store.fetchAll()
      const rejection = expect(promise).rejects.toBeInstanceOf(ParamFetchError)
      await vi.advanceTimersByTimeAsync(0)

      // index 0 of 5 re-arrives repeatedly (a broken/duplicating link) — only the reset-count
      // cap (3) can plausibly end phase 1 here, given the silence window above is effectively infinite.
      for (let i = 0; i < 4; i++) {
        transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 5, index: 0 }))
        await vi.advanceTimersByTimeAsync(1)
      }

      // Gap-fill for indices 1-4 (batch), 1 try each, 10ms timeout, 1 round -> exhausted -> reject.
      await vi.advanceTimersByTimeAsync(10)
      await rejection
    })
  })

  describe('fetchAll: param_count drift', () => {
    it('rejects with ParamCountDriftError if param_count changes mid-fetch', async () => {
      const store = new ParamStore(router, target)
      const promise = store.fetchAll()
      const rejection = expect(promise).rejects.toBeInstanceOf(ParamCountDriftError)
      await vi.advanceTimersByTimeAsync(0)

      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 3, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      transport.feed(paramValueFrame({ name: 'P1', value: 1, type: MAV_PARAM_TYPE_REAL32, count: 5, index: 1 }))
      await vi.advanceTimersByTimeAsync(0)

      await rejection
    })

    it('does not call onProgress with a lying "(N, N) looks complete" on the arrival that triggers param_count drift', async () => {
      const onProgress = vi.fn()
      const store = new ParamStore(router, target)
      const promise = store.fetchAll({ onProgress })
      const rejection = expect(promise).rejects.toBeInstanceOf(ParamCountDriftError)
      await vi.advanceTimersByTimeAsync(0)

      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(onProgress).toHaveBeenCalledWith(1, 2)
      onProgress.mockClear()

      // received.size becomes 2 here, coincidentally equal to the OLD (pre-drift) expectedCount
      // of 2 — a naive onProgress(received.size, expectedCount) call on this same arrival would
      // report the lying "(2, 2) looks complete" right before fetchAll rejects on the drift.
      transport.feed(paramValueFrame({ name: 'P1', value: 1, type: MAV_PARAM_TYPE_REAL32, count: 5, index: 1 }))
      await vi.advanceTimersByTimeAsync(0)

      expect(onProgress).not.toHaveBeenCalled()
      await rejection
    })
  })

  describe('fetchProgress / onFetchProgress', () => {
    it('starts inactive, got 0, total undefined, not completed, before any fetch has ever run', () => {
      const store = new ParamStore(router, target)
      expect(store.fetchProgress).toEqual({ active: false, got: 0, total: undefined, completed: false })
    })

    it('reflects an active fetch — readable by a consumer that never called fetchAll() itself', async () => {
      const store = new ParamStore(router, target)
      void store.fetchAll() // no onProgress passed — a second "observer" reads fetchProgress instead
      await vi.advanceTimersByTimeAsync(0)
      expect(store.fetchProgress).toEqual({ active: true, got: 0, total: undefined, completed: false })

      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(store.fetchProgress).toEqual({ active: true, got: 1, total: 2, completed: false })

      transport.feed(paramValueFrame({ name: 'P1', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 1 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(store.fetchProgress).toEqual({ active: false, got: 2, total: 2, completed: true })
    })

    it('goes inactive once fetchAll resolves, retaining the final got/total (not reset to 0/undefined), and marks completed', async () => {
      const store = new ParamStore(router, target)
      const promise = store.fetchAll()
      await vi.advanceTimersByTimeAsync(0)
      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      await promise

      expect(store.fetchProgress).toEqual({ active: false, got: 1, total: 1, completed: true })
    })

    it('goes inactive (frozen count, no fake completion) when fetchAll rejects, e.g. ParamFetchNoResponseError', async () => {
      const store = new ParamStore(router, target, { fetchSilenceMs: 20 })
      const promise = store.fetchAll()
      const rejection = expect(promise).rejects.toBeInstanceOf(ParamFetchNoResponseError)
      await vi.advanceTimersByTimeAsync(0)

      // Nothing fed at all: the FC never answers PARAM_REQUEST_LIST.
      await vi.advanceTimersByTimeAsync(20)

      await rejection
      expect(store.fetchProgress).toEqual({ active: false, got: 0, total: undefined, completed: false })
    })

    it('notifies onFetchProgress subscribers on start, each arrival, and completion', async () => {
      const store = new ParamStore(router, target)
      const onFetchProgress = vi.fn()
      store.onFetchProgress(onFetchProgress)

      const promise = store.fetchAll()
      await vi.advanceTimersByTimeAsync(0)
      expect(onFetchProgress).toHaveBeenCalledWith({ active: true, got: 0, total: undefined, completed: false })

      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      await promise

      expect(onFetchProgress).toHaveBeenCalledWith({ active: true, got: 1, total: 1, completed: false })
      expect(onFetchProgress).toHaveBeenCalledWith({ active: false, got: 1, total: 1, completed: true })
    })

    it('onFetchProgress returns an unsubscribe function', async () => {
      const store = new ParamStore(router, target)
      const onFetchProgress = vi.fn()
      const unsubscribe = store.onFetchProgress(onFetchProgress)
      unsubscribe()

      void store.fetchAll()
      await vi.advanceTimersByTimeAsync(0)

      expect(onFetchProgress).not.toHaveBeenCalled()
    })

    it('does not report a lying "(N, N) looks complete" fetchProgress on the arrival that triggers param_count drift', async () => {
      const store = new ParamStore(router, target)
      const promise = store.fetchAll()
      const rejection = expect(promise).rejects.toBeInstanceOf(ParamCountDriftError)
      await vi.advanceTimersByTimeAsync(0)

      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(store.fetchProgress).toEqual({ active: true, got: 1, total: 2, completed: false })

      // Same coincidence as the onProgress drift test above: received.size becomes 2 here,
      // matching the stale expectedCount of 2 — fetchProgress must not report (2, 2) as if
      // the pull were complete. fetchAll rejects synchronously off the back of this same
      // arrival, so by the time this tick settles it's already inactive again — but frozen
      // at the last *honest* (1, 2) snapshot, never the lying (2, 2).
      transport.feed(paramValueFrame({ name: 'P1', value: 1, type: MAV_PARAM_TYPE_REAL32, count: 5, index: 1 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(store.fetchProgress).toEqual({ active: false, got: 1, total: 2, completed: false })

      await rejection
      expect(store.fetchProgress).toEqual({ active: false, got: 1, total: 2, completed: false })
    })

    it('issue #20: a passively-received PARAM_VALUE with no fetchAll ever run leaves completed false, even though `all` is non-empty', async () => {
      const store = new ParamStore(router, target)
      // ArduPilot re-broadcasting a changed param unprompted — no PARAM_REQUEST_LIST/READ sent.
      transport.feed(paramValueFrame({ name: 'STAT_RUNTIME', value: 6693, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      expect(store.all.size).toBe(1)
      expect(store.fetchProgress).toEqual({ active: false, got: 0, total: undefined, completed: false })
    })

    it('issue #20: completed stays true after a later fetchAll() fails, since the earlier full pull is still in the cache', async () => {
      const store = new ParamStore(router, target, { fetchSilenceMs: 20 })
      const promise = store.fetchAll()
      await vi.advanceTimersByTimeAsync(0)
      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      await promise
      expect(store.fetchProgress.completed).toBe(true)

      const secondPromise = store.fetchAll()
      const rejection = expect(secondPromise).rejects.toBeInstanceOf(ParamFetchNoResponseError)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(20) // silence window, nothing fed for the second attempt
      await rejection

      expect(store.fetchProgress.completed).toBe(true)
    })
  })

  describe('fetchAll: re-entrancy and abort', () => {
    it('rejects a second concurrent fetchAll() call with ParamFetchBusyError', async () => {
      const store = new ParamStore(router, target)
      const first = store.fetchAll()
      await vi.advanceTimersByTimeAsync(0)

      await expect(store.fetchAll()).rejects.toBeInstanceOf(ParamFetchBusyError)

      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      await first
    })

    it('an aborted signal stops fetchAll cleanly and rejects with AbortError', async () => {
      const controller = new AbortController()
      const store = new ParamStore(router, target)
      const before = subscriberCount(router)
      const promise = store.fetchAll({ signal: controller.signal })
      await vi.advanceTimersByTimeAsync(0)

      controller.abort()
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })

      // ParamStore keeps its own single lifetime subscription (constructor-scoped),
      // so subscriberCount should be unaffected by an aborted fetchAll.
      expect(subscriberCount(router)).toBe(before)
    })
  })

  describe('passive PARAM_VALUE updates', () => {
    it('updates the cache and fires onChange for a PARAM_VALUE received with no fetchAll/set in flight', async () => {
      const store = new ParamStore(router, target)
      const onChange = vi.fn()
      store.onChange(onChange)

      transport.feed(paramValueFrame({ name: 'RC1_MIN', value: 1000, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      expect(store.get('RC1_MIN')).toEqual({ name: 'RC1_MIN', value: 1000, type: MAV_PARAM_TYPE_REAL32, index: 0 })
      expect(onChange).toHaveBeenCalledWith({ name: 'RC1_MIN', value: 1000, type: MAV_PARAM_TYPE_REAL32, index: 0 })
    })

    it('onChange returns an unsubscribe function', async () => {
      const store = new ParamStore(router, target)
      const onChange = vi.fn()
      const unsubscribe = store.onChange(onChange)
      unsubscribe()

      transport.feed(paramValueFrame({ name: 'RC1_MIN', value: 1000, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      expect(onChange).not.toHaveBeenCalled()
    })
  })

  describe('set()', () => {
    it('rejects with ParamUnknownError for a name never seen via fetchAll/PARAM_VALUE', async () => {
      const store = new ParamStore(router, target)
      await expect(store.set('NEVER_SEEN', 1)).rejects.toBeInstanceOf(ParamUnknownError)
      expect(transport.sent).toHaveLength(0)
    })

    it('sends PARAM_SET with the cached param_type and resolves with the echoed Param on a matching PARAM_VALUE', async () => {
      const store = new ParamStore(router, target)
      await seedParam(transport, 'THR_MIN', 0, MAV_PARAM_TYPE_REAL32)

      const promise = store.set('THR_MIN', 0.25)
      await vi.advanceTimersByTimeAsync(0)

      expect(transport.sent).toHaveLength(1)
      const sent = decodeSent(transport.sent[0])
      expect(sent.msgid).toBe(PARAM_SET_MSGID)
      expect(sent.fields).toMatchObject({ param_id: 'THR_MIN', param_type: MAV_PARAM_TYPE_REAL32 })
      expect(sent.fields.param_value as number).toBeCloseTo(0.25, 5)

      transport.feed(paramValueFrame({ name: 'THR_MIN', value: 0.25, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      const result: Param = await promise
      expect(result.name).toBe('THR_MIN')
      expect(result.value).toBeCloseTo(0.25, 5)
      expect(store.get('THR_MIN')?.value).toBeCloseTo(0.25, 5)
    })

    it('rejects with ParamWriteMismatchError carrying {requested, actual} when the FC echoes a different value (clamped), and updates the cache with the actual value', async () => {
      const store = new ParamStore(router, target)
      await seedParam(transport, 'THR_MAX', 500, MAV_PARAM_TYPE_REAL32)

      const promise = store.set('THR_MAX', 2000)
      // Attached before advancing timers: the promise rejects synchronously
      // inside the advance() below, and a handler must already be attached
      // at that point to avoid an unhandled-rejection warning (same fix as
      // command.test.ts).
      const errPromise = promise.catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(0)

      transport.feed(paramValueFrame({ name: 'THR_MAX', value: 1000, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      const err = await errPromise
      expect(err).toBeInstanceOf(ParamWriteMismatchError)
      expect((err as ParamWriteMismatchError).requested).toBeCloseTo(2000, 5)
      expect((err as ParamWriteMismatchError).actual).toBeCloseTo(1000, 5)
      expect(store.get('THR_MAX')?.value).toBeCloseTo(1000, 5) // cache reflects reality, not the request
    })

    it('rejects with ParamWriteTimeoutError and never retransmits on a missing echo', async () => {
      const store = new ParamStore(router, target, { setTimeoutMs: 100 })
      await seedParam(transport, 'THR_MIN', 0, MAV_PARAM_TYPE_REAL32)

      const promise = store.set('THR_MIN', 0.5)
      const rejection = expect(promise).rejects.toBeInstanceOf(ParamWriteTimeoutError)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(100)
      expect(transport.sent).toHaveLength(1) // no retransmission — writes are dangerous

      await rejection
    })

    it('rejects with ParamPrecisionLossError before sending anything, for an integer-type value not exactly representable as float32', async () => {
      const store = new ParamStore(router, target)
      await seedParam(transport, 'SERIAL1_BAUD', 115200, MAV_PARAM_TYPE_INT32)

      // 2^24 + 1 = 16777217 is the smallest positive integer float32 cannot represent exactly.
      await expect(store.set('SERIAL1_BAUD', 16777217)).rejects.toBeInstanceOf(ParamPrecisionLossError)
      expect(transport.sent).toHaveLength(0)
    })

    it('does not reject on precision-loss grounds for a REAL32 param (non-integer types are inherently float32)', async () => {
      const store = new ParamStore(router, target)
      await seedParam(transport, 'SOME_GAIN', 0.1, MAV_PARAM_TYPE_REAL32)

      const promise = store.set('SOME_GAIN', 0.123456789)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent).toHaveLength(1)

      const requestedFloat32 = Math.fround(0.123456789)
      transport.feed(paramValueFrame({ name: 'SOME_GAIN', value: requestedFloat32, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      await expect(promise).resolves.toMatchObject({ name: 'SOME_GAIN' })
    })

    it('an already-aborted signal rejects immediately with nothing sent', async () => {
      const store = new ParamStore(router, target)
      await seedParam(transport, 'THR_MIN', 0, MAV_PARAM_TYPE_REAL32)

      const controller = new AbortController()
      controller.abort()
      await expect(store.set('THR_MIN', 0.1, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
      expect(transport.sent).toHaveLength(0)
    })

    it('rejects a second concurrent set() for the same name with ParamWriteBusyError, while the first still resolves correctly', async () => {
      const store = new ParamStore(router, target)
      await seedParam(transport, 'THR_MIN', 0, MAV_PARAM_TYPE_REAL32)

      const first = store.set('THR_MIN', 0.25)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent).toHaveLength(1) // only the first call's PARAM_SET was ever sent

      // Without the busy guard, this second call's echo-waiter for 'THR_MIN' would also see
      // the first call's echo below and wrongly reject with ParamWriteMismatchError (0.5 !== 0.25).
      await expect(store.set('THR_MIN', 0.5)).rejects.toBeInstanceOf(ParamWriteBusyError)
      expect(transport.sent).toHaveLength(1) // the second call never sent anything

      transport.feed(paramValueFrame({ name: 'THR_MIN', value: 0.25, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      await expect(first).resolves.toMatchObject({ name: 'THR_MIN', value: expect.closeTo(0.25, 5) })
    })

    it('allows concurrent set() calls for different names', async () => {
      const store = new ParamStore(router, target)
      await seedParam(transport, 'THR_MIN', 0, MAV_PARAM_TYPE_REAL32, 0)
      await seedParam(transport, 'THR_MAX', 1000, MAV_PARAM_TYPE_REAL32, 1)

      const first = store.set('THR_MIN', 0.1)
      const second = store.set('THR_MAX', 900)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent).toHaveLength(2)

      transport.feed(paramValueFrame({ name: 'THR_MIN', value: 0.1, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      transport.feed(paramValueFrame({ name: 'THR_MAX', value: 900, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 1 }))
      await vi.advanceTimersByTimeAsync(0)

      await expect(first).resolves.toMatchObject({ name: 'THR_MIN' })
      await expect(second).resolves.toMatchObject({ name: 'THR_MAX' })
    })

    it('allows a fresh set() for the same name once the first call has settled', async () => {
      const store = new ParamStore(router, target)
      await seedParam(transport, 'THR_MIN', 0, MAV_PARAM_TYPE_REAL32)

      const first = store.set('THR_MIN', 0.25)
      await vi.advanceTimersByTimeAsync(0)
      transport.feed(paramValueFrame({ name: 'THR_MIN', value: 0.25, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      await first

      const second = store.set('THR_MIN', 0.5)
      await vi.advanceTimersByTimeAsync(0)
      transport.feed(paramValueFrame({ name: 'THR_MIN', value: 0.5, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)
      await expect(second).resolves.toMatchObject({ value: expect.closeTo(0.5, 5) })
    })
  })

  describe('dispose()', () => {
    it('unsubscribes from the router', async () => {
      const before = subscriberCount(router)
      const store = new ParamStore(router, target)
      expect(subscriberCount(router)).toBe(before + 1)

      store.dispose()
      expect(subscriberCount(router)).toBe(before)
    })

    it('rejects an in-flight fetchAll with ParamStoreDisposedError', async () => {
      const store = new ParamStore(router, target)
      const promise = store.fetchAll()
      await vi.advanceTimersByTimeAsync(0)

      store.dispose()
      await expect(promise).rejects.toBeInstanceOf(ParamStoreDisposedError)
    })

    it('stops delivering passive PARAM_VALUE updates after dispose', async () => {
      const store = new ParamStore(router, target)
      store.dispose()

      transport.feed(paramValueFrame({ name: 'RC1_MIN', value: 1000, type: MAV_PARAM_TYPE_REAL32, count: 1, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      expect(store.get('RC1_MIN')).toBeUndefined()
    })

    it('rejects an in-flight set() with ParamStoreDisposedError', async () => {
      const store = new ParamStore(router, target)
      await seedParam(transport, 'THR_MIN', 0, MAV_PARAM_TYPE_REAL32)

      const promise = store.set('THR_MIN', 0.5)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent).toHaveLength(1) // PARAM_SET was sent; still waiting on the echo

      store.dispose()
      await expect(promise).rejects.toBeInstanceOf(ParamStoreDisposedError)
    })

    it('rejects an in-flight fetchAll with ParamStoreDisposedError when disposed mid-gap-fill', async () => {
      const store = new ParamStore(router, target, { fetchSilenceMs: 50 })
      const promise = store.fetchAll()
      const rejection = expect(promise).rejects.toBeInstanceOf(ParamStoreDisposedError)
      await vi.advanceTimersByTimeAsync(0)

      // Only index 0 of 2 arrives; index 1 is missing.
      transport.feed(paramValueFrame({ name: 'P0', value: 0, type: MAV_PARAM_TYPE_REAL32, count: 2, index: 0 }))
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(50) // silence window elapses -> gap-fill sends PARAM_REQUEST_READ for index 1
      const gapFillRequest = transport.sent.find((bytes) => decodeSent(bytes).msgid === PARAM_REQUEST_READ_MSGID)
      expect(gapFillRequest).toBeDefined() // confirms we're actually mid-gap-fill, waiting on that request's echo

      store.dispose()
      await rejection
    })
  })
})
