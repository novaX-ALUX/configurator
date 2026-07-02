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
 */
class FakeSerialPort extends EventTarget implements SerialPort {
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  readonly sentFrames: Uint8Array[] = []
  openCalls: SerialOptions[] = []
  closeCalls = 0

  private readController: ReadableStreamDefaultController<Uint8Array> | null = null

  constructor() {
    super()
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readController = controller
      },
    })
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.sentFrames.push(chunk)
      },
    })
  }

  async open(options: SerialOptions): Promise<void> {
    this.openCalls.push(options)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }

  async forget(): Promise<void> {}

  getInfo(): SerialPortInfo {
    return {}
  }

  /** Test helper: delivers bytes as if received over the wire. */
  feed(bytes: Uint8Array): void {
    this.readController?.enqueue(bytes)
  }

  /** Test helper: simulates a physical disconnect — the Web Serial spec errors `readable` (e.g. NetworkError). */
  simulateReadError(reason: string): void {
    this.readController?.error(new Error(reason))
  }

  /** Test helper: simulates the port's readable ending gracefully (not the disconnect path, but valid Web Serial behavior). */
  simulateReadableDone(): void {
    this.readController?.close()
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
    expect(port.readable?.locked).toBe(true)
    expect(port.writable?.locked).toBe(true)

    await transport.close()

    expect(port.readable?.locked).toBe(false)
    expect(port.writable?.locked).toBe(false)
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
})
