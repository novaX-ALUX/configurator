import { describe, expect, it, vi } from 'vitest'
import { SerialTransport } from '../serial'
import { describeTransportContract } from './contract'

/**
 * Fake `SerialPort` backed by real `ReadableStream`/`WritableStream`
 * instances, so `SerialTransport`'s pump-loop and writer-lifecycle logic
 * (the part that isn't a browser permission prompt) runs for real under
 * Vitest. What this can't cover — `navigator.serial.requestPort()`,
 * the real USB/serial device round-trip, actual baud-rate/framing
 * behavior — is real-hardware-only; `SerialTransport` never calls
 * `requestPort()` itself (the port is injected via the constructor per the
 * task brief), so that gap is entirely outside this module's code.
 *
 * `readable`/`writable` are nulled out by `close()`, matching the real Web
 * Serial spec (an earlier version of this fake left them lying around
 * post-close, which was too permissive). By default `open()` resolves
 * promptly; pass `{ manualOpen: true }` and drive completion explicitly via
 * `resolveOpenAt()` to script the exact interleaving of two overlapping
 * `open()` calls needed by the generation-race regression tests below.
 */
class FakeSerialPort extends EventTarget implements SerialPort {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  /** Not exercised by this file's tests (they cover `SerialTransport`'s stream/generation logic, not physical-disconnect detection — that's `reconnect.test.ts`'s job) — present only to satisfy the `SerialPort` interface. */
  connected = true
  readonly sentFrames: Uint8Array[] = []
  readonly openCalls: SerialOptions[] = []
  closeCalls = 0

  /**
   * Every open()'s own stream controller, indexed by *call* order (index
   * reserved synchronously in `open()`, filled in once that call
   * completes) — not completion order, which can differ once opens
   * resolve out of order under `manualOpen`. Survives later opens/closes
   * clobbering `readable`/`writable`.
   */
  private readonly opens: Array<{ controller: ReadableStreamDefaultController<Uint8Array> } | undefined> = []
  private readonly pendingOpens: Array<() => void> = []

  constructor(private readonly opts: { manualOpen?: boolean } = {}) {
    super()
  }

  open(options: SerialOptions): Promise<void> {
    this.openCalls.push(options)
    const index = this.opens.length
    this.opens.push(undefined)
    const finish = () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      this.readable = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c
        },
      })
      this.writable = new WritableStream<Uint8Array>({
        write: (chunk) => {
          this.sentFrames.push(chunk)
        },
      })
      this.opens[index] = { controller }
    }
    if (!this.opts.manualOpen) {
      finish()
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.pendingOpens.push(() => {
        finish()
        resolve()
      })
    })
  }

  /** Test helper (manualOpen mode): completes a specific still-queued open() call by index (0 = first ever called), possibly out of order. */
  resolveOpenAt(index: number): void {
    const resolver = this.pendingOpens[index]
    this.pendingOpens[index] = () => {}
    resolver?.()
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.readable = null
    this.writable = null
  }

  async forget(): Promise<void> {}

  getInfo(): SerialPortInfo {
    return {}
  }

  /** Test helper: delivers bytes on the Nth open()'s readable (defaults to the most recent one), as if received over the wire. */
  feed(bytes: Uint8Array, index = this.opens.length - 1): void {
    this.opens[index]?.controller.enqueue(bytes)
  }

  /** Test helper: simulates a physical disconnect on the Nth open()'s readable — the Web Serial spec errors `readable` (e.g. NetworkError). */
  simulateReadError(reason: string, index = this.opens.length - 1): void {
    this.opens[index]?.controller.error(new Error(reason))
  }

  /** Test helper: simulates the Nth open()'s readable ending gracefully (not the disconnect path, but valid Web Serial behavior). */
  simulateReadableDone(index = this.opens.length - 1): void {
    this.opens[index]?.controller.close()
  }
}

function makeHarness() {
  const port = new FakeSerialPort()
  const transport = new SerialTransport(port, 57600)
  return {
    transport,
    feed: (bytes: Uint8Array) => port.feed(bytes),
    getSent: () => port.sentFrames,
    simulateDisconnect: (reason: string) => port.simulateReadError(reason),
  }
}

describeTransportContract('SerialTransport', makeHarness)

describe('SerialTransport', () => {
  it('opens the port with the constructor baud rate', async () => {
    const port = new FakeSerialPort()
    const transport = new SerialTransport(port, 115200)

    await transport.open()

    expect(port.openCalls).toEqual([{ baudRate: 115200 }])
  })

  it('close() releases the reader/writer locks and closes the port', async () => {
    const port = new FakeSerialPort()
    const transport = new SerialTransport(port, 57600)
    await transport.open()
    const { readable, writable } = port
    expect(readable?.locked).toBe(true)
    expect(writable?.locked).toBe(true)

    await transport.close()

    expect(readable?.locked).toBe(false)
    expect(writable?.locked).toBe(false)
    expect(port.readable).toBeNull()
    expect(port.writable).toBeNull()
    expect(port.closeCalls).toBe(1)
  })

  it('a graceful end of port.readable (done) also ends the transport and fires onDisconnect', async () => {
    const port = new FakeSerialPort()
    const transport = new SerialTransport(port, 57600)
    await transport.open()
    const reader = transport.readable.getReader()
    const onDisconnect = vi.fn()
    transport.onDisconnect(onDisconnect)

    port.simulateReadableDone()

    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  describe('generation races (close()/reopen() interleaved with an in-flight open())', () => {
    it('a stale generation completing port.open() late does not clobber a newer, live generation', async () => {
      const port = new FakeSerialPort({ manualOpen: true })
      const transport = new SerialTransport(port, 57600)

      // gen1: start opening, but don't let port.open() resolve yet ("slow").
      const gen1Open = transport.open()

      // close() while gen1 is still pending.
      await transport.close()
      expect(port.closeCalls).toBe(1)

      // gen2: opens and connects (its own, independent port.open() call — index 1).
      const gen2Open = transport.open()
      port.resolveOpenAt(1)
      await gen2Open

      const onDisconnect = vi.fn()
      transport.onDisconnect(onDisconnect)

      // gen1's port.open() (index 0) finally completes late, well after gen2 is live.
      port.resolveOpenAt(0)
      await gen1Open

      // gen2 must be completely unaffected: still open, writable, its own readable intact.
      await expect(transport.write(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined()
      expect(port.sentFrames).toEqual([new Uint8Array([1, 2, 3])])
      const reader = transport.readable.getReader()
      port.feed(new Uint8Array([9, 9]), 1) // feed on gen2's specific stream (index 1)
      await expect(reader.read()).resolves.toEqual({ value: new Uint8Array([9, 9]), done: false })
      expect(onDisconnect).not.toHaveBeenCalled()

      // gen1's belatedly-opened port state must have been released again
      // (no leak): once for the close() that raced it, once for its own
      // late self-cleanup on discovering it was stale.
      expect(port.closeCalls).toBe(2)
    })

    it('close() before a pending open() completes still releases the underlying resource once it does complete', async () => {
      const port = new FakeSerialPort({ manualOpen: true })
      const transport = new SerialTransport(port, 57600)

      const openPromise = transport.open()
      await transport.close()
      expect(port.closeCalls).toBe(1)

      port.resolveOpenAt(0) // port.open() finally completes late
      await openPromise

      expect(port.closeCalls).toBe(2) // released again once the belated open() discovered it was stale
      expect(() => transport.readable).toThrow()
      await expect(transport.write(new Uint8Array([1]))).rejects.toThrow()
    })
  })
})
