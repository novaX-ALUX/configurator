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
      await this.doOpen(opts)
    } catch (err) {
      if (generation === this.openGeneration) this.state = 'closed'
      throw err
    }

    if (generation !== this.openGeneration) {
      // A close() (or a newer open()) already won the race while doOpen()
      // was in flight. The resource doOpen() just set up is now stale —
      // release it instead of reporting this transport as open.
      await this.doClose().catch(() => {})
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

  /** Bytes arriving from the underlying resource; enqueues onto the consumer-facing `readable`. */
  protected enqueue(bytes: Uint8Array): void {
    if (!this.controller) {
      throw new Error('Transport is not open')
    }
    // A close() can race a still-in-flight open() (see openGeneration
    // above): once that happens this generation's resource is stale, and
    // any bytes it still delivers must be dropped rather than enqueued
    // onto an already-closed controller (which throws).
    if (this.state !== 'open') return
    this.controller.enqueue(bytes)
  }

  /**
   * Single teardown path for both caller-initiated `close()` and
   * subclass-detected abnormal disconnects. Idempotent: a second call
   * (from either source) is a no-op. Ends `readable` gracefully and fires
   * `onDisconnect` with `reason` before best-effort releasing the
   * underlying resource via `doClose()`.
   */
  protected async terminateAndTeardown(reason: string): Promise<void> {
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

  protected abstract doOpen(opts?: { signal?: AbortSignal }): Promise<void>
  protected abstract doWrite(data: Uint8Array): Promise<void>
  protected abstract doClose(): Promise<void>
}
