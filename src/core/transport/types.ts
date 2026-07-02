/**
 * Transport abstraction the MAVLink router (Task 2.3) and PX4 flasher (Task
 * 3.3) sit on. A `Transport` moves raw bytes over some physical link (serial
 * port, WebSocket bridge, or an in-memory mock for tests) without knowing
 * anything about MAVLink framing.
 *
 * Locked-down semantics (contract-tested identically for every
 * implementation in `__tests__/contract.ts`):
 *
 * - **Double `open()`**: calling `open()` while already open (or mid-open)
 *   **rejects** — it is not idempotent. A second `open()` almost always
 *   means two consumers are racing to own the same physical connection,
 *   which is a bug we want surfaced, not silently swallowed. Callers that
 *   want to reopen (e.g. the PX4 flasher around a bootloader reboot) call
 *   `close()` first; `open()` after `close()` is always allowed and starts
 *   a fresh generation of `readable`.
 * - **`readable` before `open()` / after `close()`**: accessing the getter
 *   throws. It only "becomes available" (per the task brief) once `open()`
 *   has resolved, and stops being available the instant the transport is
 *   closed. Readers obtained *while* open keep working after `close()` —
 *   see the next point — this only affects new accesses of the getter.
 * - **End-of-stream is always graceful.** Whether the connection ends
 *   because the caller called `close()`, the peer/device disconnected, or a
 *   read failed, the outward-facing `readable` always ends via a clean
 *   stream close (`reader.read()` resolves `{ done: true }`), never a
 *   stream error. The *reason* for the end is carried exclusively by
 *   `onDisconnect`, not by the stream itself — this keeps consumers from
 *   needing try/catch around every read just to detect disconnects.
 * - **`onDisconnect` fires for every kind of connection end**, including a
 *   caller-initiated `close()`, exactly once per open/close cycle. It
 *   re-arms on the next successful `open()`.
 */
export interface Transport {
  /**
   * Opens the underlying connection. Rejects if already open/opening (see
   * module doc), or immediately with no side effects if `opts.signal` is
   * already aborted.
   */
  open(opts?: { signal?: AbortSignal }): Promise<void>
  /** Idempotent: closing an already-closed (or never-opened) transport is a no-op. */
  close(): Promise<void>
  /** One-shot stream, valid only while open; throws when accessed before `open()` or after `close()`. */
  readonly readable: ReadableStream<Uint8Array>
  /** Rejects if the transport is not currently open. */
  write(data: Uint8Array): Promise<void>
  /** Registers a disconnect listener; returns an unsubscribe function. */
  onDisconnect(cb: (reason: string) => void): () => void
}

type DisconnectListener = (reason: string) => void

/**
 * Shared bookkeeping for `onDisconnect`'s "fire at most once per
 * open/close cycle, subscriptions persist across cycles" semantics.
 * Identical for all three `Transport` implementations, so it lives here
 * instead of being copy-pasted three times.
 */
class DisconnectEmitter {
  private readonly listeners = new Set<DisconnectListener>()
  private fired = false

  subscribe(cb: DisconnectListener): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** Re-arms the emitter for a new open()/close() cycle. Subscriptions are kept. */
  reset(): void {
    this.fired = false
  }

  /** No-op if already fired since the last reset(). */
  fire(reason: string): void {
    if (this.fired) return
    this.fired = true
    for (const cb of this.listeners) cb(reason)
  }
}

type TransportState = 'idle' | 'opening' | 'open' | 'closed'

/**
 * Shared state machine + `readable` bookkeeping for the three `Transport`
 * implementations. Not part of the public contract (that's `Transport`
 * above) — an internal base class so the idempotent-close /
 * fire-once-disconnect / reject-after-close rules are implemented and
 * tested once instead of three times with three chances to drift.
 *
 * Subclasses implement `doOpen`/`doWrite`/`doClose` for their specific byte
 * source, and call `enqueue()` as bytes arrive and `terminateAndTeardown()`
 * when the underlying resource ends unexpectedly (read error / stream done
 * / peer closed).
 */
export abstract class BaseTransport implements Transport {
  private state: TransportState = 'idle'
  private currentReadable: ReadableStream<Uint8Array> | null = null
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private readonly disconnect = new DisconnectEmitter()
  /**
   * Bumped by `terminateAndTeardown()` and by every `open()` call. Lets a
   * pending `open()` notice that a concurrent `close()` (or a newer
   * `open()`) won the race while `doOpen()` was in flight, instead of
   * blindly setting `state = 'open'` and clobbering the close that already
   * happened.
   */
  private openGeneration = 0

  async open(opts?: { signal?: AbortSignal }): Promise<void> {
    if (opts?.signal?.aborted) {
      throw new DOMException('open() aborted', 'AbortError')
    }
    if (this.state === 'opening' || this.state === 'open') {
      throw new Error('Transport is already open')
    }

    const generation = ++this.openGeneration
    this.state = 'opening'
    this.disconnect.reset()
    this.currentReadable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
      },
    })

    try {
      await this.doOpen(generation, opts)
    } catch (err) {
      if (generation === this.openGeneration) this.state = 'closed'
      throw err
    }

    if (generation !== this.openGeneration) {
      // A close() (or a newer open()) already won the race while doOpen()
      // was in flight. `doOpen(generation, ...)` is responsible for not
      // adopting stale resources into shared fields (this.ws, this.reader,
      // ...) and for releasing whatever it privately set up itself — by
      // now those fields may already belong to a *newer* generation, so
      // there is nothing left for this method to safely tear down here.
      return
    }
    this.state = 'open'
  }

  get readable(): ReadableStream<Uint8Array> {
    if (!this.currentReadable || this.state !== 'open') {
      throw new Error('Transport is not open')
    }
    return this.currentReadable
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.state !== 'open') {
      throw new Error('Transport is not open')
    }
    await this.doWrite(data)
  }

  async close(): Promise<void> {
    if (this.state === 'idle') {
      this.state = 'closed'
      return
    }
    await this.terminateAndTeardown('closed')
  }

  onDisconnect(cb: (reason: string) => void): () => void {
    return this.disconnect.subscribe(cb)
  }

  /**
   * The generation currently considered "live". Subclasses capture the
   * generation number passed into their `doOpen(generation, ...)` call and
   * compare it against this later (in event handlers that can fire after
   * being superseded) to decide whether they're still allowed to touch
   * shared state.
   */
  protected get currentGeneration(): number {
    return this.openGeneration
  }

  /** True if `generation` is still the live one — i.e. hasn't been superseded by a `close()` or a newer `open()`. */
  protected isCurrentGeneration(generation: number): boolean {
    return generation === this.openGeneration
  }

  /**
   * Bytes arriving from the underlying resource; enqueues onto the
   * consumer-facing `readable`. `generation` defaults to "whichever is
   * current right now" (fine for callers with no multi-generation race of
   * their own, e.g. MockTransport's test-only `feed()`); WebSocket/Serial
   * pass the generation their event handler/pump loop was opened with, so
   * a stale generation's still-arriving bytes are dropped instead of
   * enqueued onto a controller that may since belong to a newer
   * generation (or have already been closed).
   */
  protected enqueue(bytes: Uint8Array, generation: number = this.openGeneration): void {
    if (!this.isCurrentGeneration(generation)) return
    if (!this.controller) {
      throw new Error('Transport is not open')
    }
    if (this.state !== 'open') return
    this.controller.enqueue(bytes)
  }

  /**
   * Single teardown path for both caller-initiated `close()` and
   * subclass-detected abnormal disconnects. Idempotent: a second call for
   * the *same* generation is a no-op. A call tagged with a *stale*
   * generation (see `enqueue()` doc) is unconditionally a no-op too — it
   * must never mutate `state`/`controller`/`disconnect`, since those may
   * belong to a newer, live generation by the time it fires. Ends
   * `readable` gracefully and fires `onDisconnect` with `reason` before
   * best-effort releasing the underlying resource via `doClose()`.
   */
  protected async terminateAndTeardown(reason: string, generation: number = this.openGeneration): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return
    if (this.state === 'closed') return
    this.state = 'closed'
    this.openGeneration++
    this.controller?.close()
    this.disconnect.fire(reason)
    try {
      await this.doClose()
    } catch {
      // Best-effort: the underlying resource may already be gone (e.g. the
      // device was physically unplugged before we got to close it).
    }
  }

  /**
   * `generation` is this call's own generation number (see
   * `currentGeneration`/`isCurrentGeneration`). Implementations must check
   * it — via their event handlers/pump loop, and once more right after any
   * `await` inside `doOpen` itself — before adopting a resource into a
   * shared field (`this.ws`, `this.reader`, ...): if superseded, release
   * what was just set up directly (it's still in a local variable) instead
   * of assigning it to the shared field, which may already hold a newer,
   * live generation's resource.
   */
  protected abstract doOpen(generation: number, opts?: { signal?: AbortSignal }): Promise<void>
  protected abstract doWrite(data: Uint8Array): Promise<void>
  protected abstract doClose(): Promise<void>
}
