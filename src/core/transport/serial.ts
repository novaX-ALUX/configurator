import { BaseTransport } from './types'

/**
 * `Transport` over a Web Serial `SerialPort`. The port is injected via the
 * constructor — this class never calls `navigator.serial.requestPort()`
 * itself, so the (unavoidably real-hardware-only) permission-prompt flow
 * lives in the caller, not here.
 */
export class SerialTransport extends BaseTransport {
  private readonly port: SerialPort
  private readonly baud: number
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null

  constructor(port: SerialPort, baud: number) {
    super()
    this.port = port
    this.baud = baud
  }

  protected async doOpen(): Promise<void> {
    await this.port.open({ baudRate: this.baud })
    if (!this.port.readable || !this.port.writable) {
      throw new Error('SerialPort did not expose readable/writable streams after open()')
    }
    this.reader = this.port.readable.getReader()
    this.writer = this.port.writable.getWriter()
    void this.pump()
  }

  /** Reads `port.readable` until it ends (gracefully or via error/disconnect) and relays bytes onto our own `readable`. */
  private async pump(): Promise<void> {
    const reader = this.reader
    if (!reader) return
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          void this.terminateAndTeardown('serial port closed')
          return
        }
        if (value) this.enqueue(value)
      }
    } catch (err) {
      // The Web Serial spec errors `readable` on physical disconnect
      // (typically a NetworkError) — this is the disconnect path.
      void this.terminateAndTeardown(err instanceof Error ? err.message : 'serial read error')
    }
  }

  protected async doWrite(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('Transport is not open')
    await this.writer.write(data)
  }

  protected async doClose(): Promise<void> {
    try {
      await this.reader?.cancel()
    } catch {
      // Best-effort: the port may already be gone.
    }
    this.reader?.releaseLock()
    this.reader = null

    try {
      await this.writer?.close()
    } catch {
      // Best-effort: the port may already be gone.
    }
    this.writer?.releaseLock()
    this.writer = null

    try {
      await this.port.close()
    } catch {
      // Best-effort: the port may already be gone (physical disconnect).
    }
  }
}
