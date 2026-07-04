/**
 * Parameter protocol state machine: full-table fetch (`fetchAll`), single
 * writes with mandatory readback (`set`), and passive cache maintenance from
 * any `PARAM_VALUE` the router sees for `target` — the parameter-write path
 * this project's #1 lesson-learned exists for (see spec §8: a competitor
 * tool corrupted users' compass configs by writing parameters without a
 * confirmed readback; every write here goes through the same
 * request -> wait-for-echo -> compare path, and a mismatch is surfaced to
 * the caller rather than silently trusted).
 *
 * ArduPilot specifics (this is the ArduPilot parameter protocol, not PX4's):
 * - `param_id` is a 16-byte `char[]`, NUL-trimmed on decode (`decode.ts`) and
 *   NUL-padded on encode (`encode.ts`) — both handled transparently by
 *   `encodePayload`/`decodePayload`, nothing extra needed here.
 * - Every parameter value travels as a **float32, by value** in
 *   `param_value` (ArduPilot convention — NOT PX4's byte-cast union): an
 *   INT32 param holding the integer 17 arrives as the float 17.0, not as 17
 *   reinterpreted through its bit pattern. `param_type` (MAV_PARAM_TYPE,
 *   1-10) is only a label for how to interpret the number: 1-8 are the
 *   integer types (INT8/UINT8/.../INT64/UINT64), 9 is REAL32, 10 is REAL64.
 *   `Param.value` is always a plain JS `number`.
 * - **float32 precision limit.** A float32 can only represent integers
 *   exactly up to 2^24. An integer-typed param write whose value exceeds
 *   that (`Math.fround(value) !== value`) would silently be transmitted as
 *   a *different* integer than the one requested — `set()` refuses such
 *   writes up front (`ParamPrecisionLossError`, nothing sent) rather than
 *   silently rounding, per the same "never silently mutate what the user
 *   asked for" principle as the readback check below. This is deliberately
 *   a hard reject, not a warning-only path: a value this large practically
 *   never occurs in real ArduPilot params (baud rates, bitmasks, etc. all
 *   fit well under 2^24), so refusing costs nothing in practice and avoids
 *   ever writing a value other than the one the caller typed.
 *
 * ## fetchAll
 *
 * `PARAM_REQUEST_LIST` triggers a "storm" of `PARAM_VALUE`s from the FC, in
 * whatever order and with whatever duplicates the link produces — `fetchAll`
 * collects into an index-keyed table (`param_index` is the key; a duplicate
 * for an already-seen index is a harmless overwrite) until either every
 * index in `0..param_count-1` has been seen, or a silence window
 * (`ParamStoreOpts.fetchSilenceMs`, default 700ms) passes with no new
 * arrival. A safety cap (`fetchMaxSilenceResets`) also ends this phase after
 * that many arrivals even if the window itself never elapses — otherwise a
 * device that never stops emitting `PARAM_VALUE` (duplicates, unrelated
 * broadcasts) without ever completing the table could reset the window
 * forever, the same "unbounded wait" class `command.ts`'s
 * `maxProgressResets` guards against for `MAV_RESULT_IN_PROGRESS`.
 *
 * If not every index was seen by the end of that phase, `fetchAll` falls
 * back to gap-fill: batching `PARAM_REQUEST_READ(param_index)` for whatever
 * indices are still missing (at most `fetchBatchSize` outstanding at a
 * time), each with its own timeout+retry (`fetchRequestTimeoutMs`/
 * `fetchRetries`, the latter meaning "retries after the first attempt" —
 * `fetchRetries: 0` still makes one attempt, same convention as
 * `command.ts`'s `retries`), across up to `fetchMaxRounds` rounds. If
 * indices are still missing after that, the returned promise rejects with
 * `ParamFetchError` (carrying the final missing-index list) — the caller
 * decides whether a partial table is usable, this layer never pretends an
 * incomplete fetch succeeded.
 *
 * **No response at all.** If not even one `PARAM_VALUE` arrives before the
 * initial phase ends, `fetchAll` rejects with `ParamFetchNoResponseError`
 * rather than resolving with an empty table — a real ArduPilot vehicle
 * always has hundreds of parameters, so an empty `all` can only mean the FC
 * never answered (dead link, wrong target, unsupported request), and
 * silently reporting that as success would be indistinguishable from a
 * genuinely-empty (and therefore misleading) result.
 *
 * **param_count drift.** If a `PARAM_VALUE` arrives mid-fetch reporting a
 * different `param_count` than the first one seen, the collected table's
 * indices can no longer be trusted to mean "0..count-1 of the *same*
 * parameter set" (a firmware that changes its param count while a fetch is
 * in flight is already in an unusual state) — `fetchAll` rejects with
 * `ParamCountDriftError` rather than silently restarting or continuing with
 * a table that might mix two different counts. Restarting-and-retrying was
 * considered but rejected: a caller that gets a clear rejection can decide
 * to retry itself; a store that silently restarts could mask a genuinely
 * unstable link/FC state that the caller should know about.
 *
 * **Re-entrancy.** Only one `fetchAll` may run at a time per store; a second
 * concurrent call rejects immediately with `ParamFetchBusyError` (the first
 * call is unaffected and keeps running).
 *
 * ## set()
 *
 * `set(name, value)` requires `name` to already be in the cache (from a
 * prior `fetchAll()` or any passively-received `PARAM_VALUE` for that name)
 * — the cached entry is the only source for `param_type`, which `PARAM_SET`
 * must carry. An unknown name rejects with `ParamUnknownError` before
 * anything is sent.
 *
 * `PARAM_SET` is sent once and the call waits for a `PARAM_VALUE` echo for
 * the same name (default 1500ms, `ParamStoreOpts.setTimeoutMs`) —
 * deliberately **never retried on timeout** (`ParamWriteTimeoutError`):
 * unlike a read, retransmitting a write whose first attempt might have
 * already landed risks stacking writes, and MAVLink gives no way to tell
 * "FC never received it" apart from "FC's echo was lost in transit" — the
 * caller must explicitly retry `set()` itself if that's what they want.
 *
 * The echo is compared against the request with `Math.fround(value) ===
 * echoed.value` — one comparison for every `param_type`, integer or
 * REAL32/REAL64 alike, because both directions of the round-trip go through
 * the same float32 wire representation: what was actually transmitted is
 * `Math.fround(value)`, so that (not the caller's raw `value`) is the
 * correct expectation for what a compliant FC echoes back unchanged. A
 * mismatch means the FC clamped, rejected, or otherwise altered the write —
 * `set()` rejects with `ParamWriteMismatchError` (carrying `{requested,
 * actual}`) but **still updates the cache to the actual value**, since that
 * is what the FC is now holding, and lying to the cache would risk exactly
 * the kind of stale-config surprise this module exists to prevent.
 *
 * **No cross-call correlation.** Like `command.ts`'s `sendCommand`,
 * `PARAM_VALUE` carries no nonce — a coincidentally-arriving `PARAM_VALUE`
 * for the same name (another GCS writing the same param, or a periodic
 * broadcast) could resolve/reject an in-flight `set()` call that didn't
 * actually cause it. Not disambiguable at the protocol level.
 *
 * ## Passive updates and lifecycle
 *
 * Every `PARAM_VALUE` the router delivers for `target` — whether caused by
 * this store's own `fetchAll`/`set`, another GCS's write, or the FC's own
 * unsolicited broadcast — updates the cache and fires every `onChange`
 * listener. This is unconditional and independent of whatever `fetchAll`/
 * `set` machinery may also be watching the same message.
 *
 * `ParamStore` holds exactly one `MavRouter.subscribe` for its whole
 * lifetime (constructor to `dispose()`), not one per operation — cheaper
 * than resubscribing per call, and it's what lets passive updates work even
 * with no `fetchAll`/`set` in flight. Every internal wait (the `fetchAll`
 * silence window, a gap-fill request, a `set()` echo wait) listens on a
 * store-owned `AbortController` in addition to whatever `signal` the caller
 * passed in, so `dispose()` — which unsubscribes from the router and aborts
 * that controller — immediately rejects any in-flight `fetchAll`/`set` with
 * `ParamStoreDisposedError` (rather than leaving them to eventually time out
 * on their own). Intended for Task 3.1's connection store to call on
 * disconnect/teardown.
 */
import { defs } from './defs'
import { encodePayload } from './encode'
import type { MavRouter } from './router'

const PARAM_REQUEST_READ_MSGID = 20
const PARAM_REQUEST_LIST_MSGID = 21
const PARAM_VALUE_MSGID = 22
const PARAM_SET_MSGID = 23

/** MAV_PARAM_TYPE 1-8: the integer types (as opposed to 9 REAL32 / 10 REAL64). */
const INTEGER_PARAM_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8])

const DEFAULT_FETCH_SILENCE_MS = 700
/** Safety cap on consecutive silence-window resets during fetchAll's initial burst — see module doc. */
const DEFAULT_FETCH_MAX_SILENCE_RESETS = 10_000
const DEFAULT_FETCH_MAX_ROUNDS = 5
const DEFAULT_FETCH_BATCH_SIZE = 10
/** Retries after the first attempt (so 2 -> 3 total tries), matching command.ts's `retries` convention. */
const DEFAULT_FETCH_RETRIES = 2
const DEFAULT_FETCH_REQUEST_TIMEOUT_MS = 300
const DEFAULT_SET_TIMEOUT_MS = 1500

export interface Param {
  name: string
  value: number
  /** MAV_PARAM_TYPE (1-10). */
  type: number
  index: number
}

/**
 * Injectable knobs for `fetchAll`'s gap-fill behavior and `set`'s write
 * timeout. Not part of `fetchAll`/`set`'s own per-call `opts` (those only
 * carry `signal`/`onProgress` per the task's Produces signature) — these are
 * store-lifetime configuration, mirroring how `MavRouter`'s own
 * `heartbeatTimeoutMs`/`now` are constructor options rather than per-call ones.
 */
export interface ParamStoreOpts {
  /** Silence window after the last `PARAM_VALUE` during the initial burst before switching to gap-fill, default 700ms. */
  fetchSilenceMs?: number
  /** Safety cap on consecutive silence-window resets during the initial burst, default 10000 — see module doc. */
  fetchMaxSilenceResets?: number
  /** Max gap-fill rounds before giving up, default 5. */
  fetchMaxRounds?: number
  /** Max outstanding `PARAM_REQUEST_READ` requests during gap-fill, default 10. */
  fetchBatchSize?: number
  /** Gap-fill retries after the first attempt (default 2, so 3 total tries) — `0` still makes one attempt. */
  fetchRetries?: number
  /** Per-attempt timeout for a single gap-fill `PARAM_REQUEST_READ`, default 300ms. */
  fetchRequestTimeoutMs?: number
  /** Timeout waiting for `set()`'s `PARAM_VALUE` echo, default 1500ms. Never retried (see module doc). */
  setTimeoutMs?: number
}

/** Rejected by `fetchAll` if some indices are still missing after gap-fill rounds are exhausted. */
export class ParamFetchError extends Error {
  constructor(public readonly missing: readonly number[]) {
    super(`ParamStore.fetchAll: ${missing.length} param(s) still missing after gap-fill rounds exhausted: indices [${missing.join(', ')}]`)
    this.name = 'ParamFetchError'
  }
}

/** Rejected by `fetchAll` if not even one `PARAM_VALUE` arrives after `PARAM_REQUEST_LIST` (see module doc). */
export class ParamFetchNoResponseError extends Error {
  constructor() {
    super('ParamStore.fetchAll: no PARAM_VALUE received at all after PARAM_REQUEST_LIST (dead link, wrong target, or unsupported request) — refusing to report success with an empty table')
    this.name = 'ParamFetchNoResponseError'
  }
}

/** Rejected by a second concurrent `fetchAll()` call while one is already running on the same store. */
export class ParamFetchBusyError extends Error {
  constructor() {
    super('ParamStore.fetchAll: a fetchAll() call is already in progress on this store')
    this.name = 'ParamFetchBusyError'
  }
}

/** Rejected by `fetchAll` if `param_count` changes mid-fetch (see module doc). */
export class ParamCountDriftError extends Error {
  constructor(
    public readonly previousCount: number,
    public readonly newCount: number,
  ) {
    super(`ParamStore.fetchAll: param_count changed mid-fetch (${previousCount} -> ${newCount}) — aborting rather than trusting a possibly-inconsistent collection table`)
    this.name = 'ParamCountDriftError'
  }
}

/** Rejected by `set()` for a name with no cached entry (no prior `fetchAll()`/`PARAM_VALUE`). */
export class ParamUnknownError extends Error {
  constructor(public readonly paramName: string) {
    super(`ParamStore.set: unknown parameter '${paramName}' — call fetchAll() first, or wait for a PARAM_VALUE for this name`)
    this.name = 'ParamUnknownError'
  }
}

/** Rejected by `set()`, before sending anything, for an integer-type value that isn't exactly representable as float32 (see module doc). */
export class ParamPrecisionLossError extends Error {
  constructor(
    public readonly paramName: string,
    public readonly requested: number,
  ) {
    super(`ParamStore.set: ${paramName}=${requested} is not exactly representable as float32 (ArduPilot params are transmitted as float32-by-value) — refusing to write an ambiguous integer value`)
    this.name = 'ParamPrecisionLossError'
  }
}

/** Rejected by `set()` if the FC's `PARAM_VALUE` echo doesn't match the requested (float32-rounded) value — see module doc for why the cache is still updated to `actual`. */
export class ParamWriteMismatchError extends Error {
  constructor(
    public readonly paramName: string,
    public readonly requested: number,
    public readonly actual: number,
  ) {
    super(`ParamStore.set: ${paramName} write mismatch — requested ${requested}, FC reports ${actual} (clamped or rejected)`)
    this.name = 'ParamWriteMismatchError'
  }
}

/** Rejected by `set()` if no `PARAM_VALUE` echo arrives in time. Never retried — see module doc. */
export class ParamWriteTimeoutError extends Error {
  constructor(public readonly paramName: string) {
    super(`ParamStore.set: ${paramName} write timed out waiting for PARAM_VALUE echo (no retry — parameter writes are not safely retransmittable)`)
    this.name = 'ParamWriteTimeoutError'
  }
}

/** Rejected for any `fetchAll`/`set` still in flight when `dispose()` is called. */
export class ParamStoreDisposedError extends Error {
  constructor() {
    super('ParamStore: operation aborted because dispose() was called')
    this.name = 'ParamStoreDisposedError'
  }
}

function toAbortError(): DOMException {
  return new DOMException('ParamStore: operation aborted', 'AbortError')
}

/** Every index in `[0, count)` not present as a key in `received`. */
function missingIndices(received: ReadonlyMap<number, Param>, count: number): number[] {
  const missing: number[] = []
  for (let i = 0; i < count; i++) {
    if (!received.has(i)) missing.push(i)
  }
  return missing
}

/** `Map<K, Set<V>>` add, creating the `Set` on first use. */
function addToMapSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(value)
}

/** `Map<K, Set<V>>` remove, dropping the `Set` once empty. */
function removeFromMapSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key)
  if (!set) return
  set.delete(value)
  if (set.size === 0) map.delete(key)
}

export class ParamStore {
  private readonly params = new Map<string, Param>()
  private readonly changeListeners = new Set<(p: Param) => void>()
  private readonly nameWaiters = new Map<string, Set<(p: Param) => void>>()
  private readonly indexWaiters = new Map<number, Set<() => void>>()
  private readonly unsubscribeRouter: () => void
  /** Aborted by `dispose()`; every internal wait listens on this in addition to any caller-supplied `signal`. */
  private readonly disposeController = new AbortController()

  private readonly fetchSilenceMs: number
  private readonly fetchMaxSilenceResets: number
  private readonly fetchMaxRounds: number
  private readonly fetchBatchSize: number
  private readonly fetchRetries: number
  private readonly fetchRequestTimeoutMs: number
  private readonly setTimeoutMs: number

  private fetchActive = false
  /** Set only while a `fetchAll()` is running; invoked by the router-value handler on every arrival, used by the initial-burst silence-window wait. */
  private notifyFetchArrival: (() => void) | undefined
  /** Set only while `fetchAll` is running; receives every arriving `PARAM_VALUE` (name, count included) to update the collection table. */
  private fetchArrivalHandler: ((param: Param, count: number) => void) | undefined

  constructor(
    private readonly router: MavRouter,
    private readonly target: { sysid: number; compid: number },
    opts: ParamStoreOpts = {},
  ) {
    this.fetchSilenceMs = opts.fetchSilenceMs ?? DEFAULT_FETCH_SILENCE_MS
    this.fetchMaxSilenceResets = opts.fetchMaxSilenceResets ?? DEFAULT_FETCH_MAX_SILENCE_RESETS
    this.fetchMaxRounds = opts.fetchMaxRounds ?? DEFAULT_FETCH_MAX_ROUNDS
    this.fetchBatchSize = opts.fetchBatchSize ?? DEFAULT_FETCH_BATCH_SIZE
    this.fetchRetries = opts.fetchRetries ?? DEFAULT_FETCH_RETRIES
    this.fetchRequestTimeoutMs = opts.fetchRequestTimeoutMs ?? DEFAULT_FETCH_REQUEST_TIMEOUT_MS
    this.setTimeoutMs = opts.setTimeoutMs ?? DEFAULT_SET_TIMEOUT_MS

    this.unsubscribeRouter = router.subscribe(
      { msgid: PARAM_VALUE_MSGID, sysid: target.sysid, compid: target.compid },
      (msg) => this.handleParamValue(msg.fields),
    )
  }

  get all(): ReadonlyMap<string, Param> {
    return this.params
  }

  get(name: string): Param | undefined {
    return this.params.get(name)
  }

  onChange(cb: (p: Param) => void): () => void {
    this.changeListeners.add(cb)
    return () => {
      this.changeListeners.delete(cb)
    }
  }

  /** Unsubscribes from the router and rejects any in-flight `fetchAll`/`set` with `ParamStoreDisposedError`. Idempotent-ish: safe to call once; a second call is a harmless no-op. */
  dispose(): void {
    this.unsubscribeRouter()
    this.disposeController.abort()
    this.changeListeners.clear()
  }

  async fetchAll(opts: { signal?: AbortSignal; onProgress?: (got: number, total: number) => void } = {}): Promise<void> {
    if (this.disposeController.signal.aborted) throw new ParamStoreDisposedError()
    if (this.fetchActive) throw new ParamFetchBusyError()
    const { signal, onProgress } = opts
    if (signal?.aborted) throw toAbortError()

    this.fetchActive = true
    const received = new Map<number, Param>()
    let expectedCount: number | undefined
    let driftError: ParamCountDriftError | undefined

    // Registered before the request is even sent, so nothing arriving in
    // the (vanishingly unlikely, but not impossible) window while that send
    // is still in flight is ever missed.
    const onArrival = (param: Param, count: number): void => {
      if (expectedCount === undefined) {
        expectedCount = count
      } else if (count !== expectedCount && !driftError) {
        driftError = new ParamCountDriftError(expectedCount, count)
      }
      received.set(param.index, param)
      onProgress?.(received.size, expectedCount)
      this.notifyFetchArrival?.()
    }
    this.fetchArrivalHandler = onArrival

    try {
      await this.router.send({
        msgid: PARAM_REQUEST_LIST_MSGID,
        payload: encodePayload(defs, PARAM_REQUEST_LIST_MSGID, {
          target_system: this.target.sysid,
          target_component: this.target.compid,
        }),
      })

      // Phase 1: collect the initial PARAM_VALUE storm until either every
      // index is seen, the silence window elapses with no new arrival, or
      // (safety net — see module doc) fetchMaxSilenceResets is hit.
      let silenceResets = 0
      for (;;) {
        if (this.disposeController.signal.aborted) throw new ParamStoreDisposedError()
        if (signal?.aborted) throw toAbortError()
        if (driftError) throw driftError
        if (expectedCount !== undefined && missingIndices(received, expectedCount).length === 0) break
        const event = await this.waitForFetchArrivalOrTimeout(this.fetchSilenceMs, signal)
        if (event === 'timeout') break
        silenceResets++
        if (silenceResets >= this.fetchMaxSilenceResets) break
      }
      if (this.disposeController.signal.aborted) throw new ParamStoreDisposedError()
      if (signal?.aborted) throw toAbortError()
      if (driftError) throw driftError

      if (expectedCount === undefined) {
        throw new ParamFetchNoResponseError()
      }

      // Phase 2: gap-fill whatever indices are still missing, in rounds.
      let round = 0
      for (;;) {
        const missing = missingIndices(received, expectedCount)
        if (missing.length === 0 || round >= this.fetchMaxRounds) break
        for (let i = 0; i < missing.length; i += this.fetchBatchSize) {
          const batch = missing.slice(i, i + this.fetchBatchSize)
          await Promise.all(batch.map((index) => this.requestByIndexWithRetry(index, signal)))
          if (driftError) throw driftError
          if (this.disposeController.signal.aborted) throw new ParamStoreDisposedError()
          if (signal?.aborted) throw toAbortError()
        }
        round++
      }

      const stillMissing = missingIndices(received, expectedCount)
      if (stillMissing.length > 0) {
        throw new ParamFetchError(stillMissing)
      }
    } finally {
      this.fetchActive = false
      this.notifyFetchArrival = undefined
      this.fetchArrivalHandler = undefined
    }
  }

  async set(name: string, value: number, opts: { signal?: AbortSignal } = {}): Promise<Param> {
    if (this.disposeController.signal.aborted) throw new ParamStoreDisposedError()
    const { signal } = opts
    if (signal?.aborted) throw toAbortError()

    const cached = this.params.get(name)
    if (!cached) {
      throw new ParamUnknownError(name)
    }
    if (INTEGER_PARAM_TYPES.has(cached.type) && Math.fround(value) !== value) {
      throw new ParamPrecisionLossError(name, value)
    }

    return this.doSet(name, value, cached.type, signal)
  }

  // --- internals ---------------------------------------------------------

  private handleParamValue(fields: Record<string, unknown>): void {
    const name = String(fields.param_id)
    const value = Number(fields.param_value)
    const type = Number(fields.param_type)
    const index = Number(fields.param_index)
    const count = Number(fields.param_count)
    const param: Param = { name, value, type, index }

    this.params.set(name, param)
    for (const cb of this.changeListeners) cb(param)

    this.fetchArrivalHandler?.(param, count)

    const indexCbs = this.indexWaiters.get(index)
    if (indexCbs) for (const cb of [...indexCbs]) cb()

    const nameCbs = this.nameWaiters.get(name)
    if (nameCbs) for (const cb of [...nameCbs]) cb(param)
  }

  /**
   * Listens for whichever fires first: the store's own dispose-signal, or
   * the caller-supplied `signal`. `onAbort` is told which one it was, so
   * callers can reject with `ParamStoreDisposedError` vs. a plain
   * `AbortError` accordingly. Returns a cleanup function that must be called
   * once the operation settles for any other reason, to avoid leaking the
   * listeners.
   */
  private listenForAbort(signal: AbortSignal | undefined, onAbort: (isDispose: boolean) => void): () => void {
    const disposeSignal = this.disposeController.signal
    const onDisposeAbort = (): void => onAbort(true)
    const onExternalAbort = (): void => onAbort(false)
    disposeSignal.addEventListener('abort', onDisposeAbort)
    signal?.addEventListener('abort', onExternalAbort)
    return () => {
      disposeSignal.removeEventListener('abort', onDisposeAbort)
      signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  private abortError(isDispose: boolean): Error {
    return isDispose ? new ParamStoreDisposedError() : toAbortError()
  }

  /** Resolves 'arrival' on the next PARAM_VALUE this fetchAll sees, or 'timeout' after `timeoutMs` with none, or rejects on abort/dispose. */
  private waitForFetchArrivalOrTimeout(timeoutMs: number, signal?: AbortSignal): Promise<'arrival' | 'timeout'> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => finish(() => resolve('timeout')), timeoutMs)
      const stopListening = this.listenForAbort(signal, (isDispose) => finish(() => reject(this.abortError(isDispose))))

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.notifyFetchArrival = undefined
        stopListening()
        fn()
      }

      this.notifyFetchArrival = () => finish(() => resolve('arrival'))
    })
  }

  /** Sends one `PARAM_REQUEST_READ(param_index)`, waiting up to `fetchRequestTimeoutMs` for an arrival at that index, retrying up to `fetchRetries` times after the first attempt. Gives up silently (leaves the index missing for the caller's next round/final check) if every try times out. */
  private async requestByIndexWithRetry(index: number, signal?: AbortSignal): Promise<void> {
    const maxAttempts = this.fetchRetries + 1
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.disposeController.signal.aborted) throw new ParamStoreDisposedError()
      if (signal?.aborted) throw toAbortError()
      const arrived = await this.waitForIndexAfterSend(index, signal)
      if (arrived) return
    }
  }

  private waitForIndexAfterSend(index: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let settled = false
      const onArrive = (): void => finish(() => resolve(true))
      const timer = setTimeout(() => finish(() => resolve(false)), this.fetchRequestTimeoutMs)
      const stopListening = this.listenForAbort(signal, (isDispose) => finish(() => reject(this.abortError(isDispose))))

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        removeFromMapSet(this.indexWaiters, index, onArrive)
        stopListening()
        fn()
      }

      addToMapSet(this.indexWaiters, index, onArrive)

      let payload: Uint8Array
      try {
        payload = encodePayload(defs, PARAM_REQUEST_READ_MSGID, {
          target_system: this.target.sysid,
          target_component: this.target.compid,
          param_index: index,
        })
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
        return
      }
      this.router.send({ msgid: PARAM_REQUEST_READ_MSGID, payload }).catch((err: unknown) => {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      })
    })
  }

  private doSet(name: string, value: number, type: number, signal?: AbortSignal): Promise<Param> {
    return new Promise<Param>((resolve, reject) => {
      let settled = false
      const onEcho = (param: Param): void => {
        finish(() => {
          if (Math.fround(value) === param.value) {
            resolve(param)
          } else {
            reject(new ParamWriteMismatchError(name, value, param.value))
          }
        })
      }
      const timer = setTimeout(() => finish(() => reject(new ParamWriteTimeoutError(name))), this.setTimeoutMs)
      const stopListening = this.listenForAbort(signal, (isDispose) => finish(() => reject(this.abortError(isDispose))))

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        removeFromMapSet(this.nameWaiters, name, onEcho)
        stopListening()
        fn()
      }

      addToMapSet(this.nameWaiters, name, onEcho)

      let payload: Uint8Array
      try {
        payload = encodePayload(defs, PARAM_SET_MSGID, {
          target_system: this.target.sysid,
          target_component: this.target.compid,
          param_id: name,
          param_value: value,
          param_type: type,
        })
      } catch (err) {
        finish(() => reject(err))
        return
      }
      this.router.send({ msgid: PARAM_SET_MSGID, payload }).catch((err: unknown) => {
        finish(() => reject(err))
      })
    })
  }
}
