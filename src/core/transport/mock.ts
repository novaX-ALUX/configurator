import { BaseTransport } from './types'

/** In-memory `Transport` for tests: no real I/O, bytes only move when `feed()`/`write()` are called. */
export class MockTransport extends BaseTransport {
  /** Bytes passed to `write()` so far, in call order. */
  readonly sent: Uint8Array[] = []

  protected async doOpen(): Promise<void> {
    // Nothing to do: there is no real resource to open.
  }

  protected async doWrite(data: Uint8Array): Promise<void> {
    this.sent.push(data)
  }

  protected async doClose(): Promise<void> {
    // Nothing to do: there is no real resource to release.
  }

  /** Test helper: injects bytes into `readable`, as if received from the wire. */
  feed(bytes: Uint8Array): void {
    this.enqueue(bytes)
  }

  /** Test helper: simulates an external disconnect (device unplugged, peer closed, ...). */
  simulateDisconnect(reason: string): void {
    void this.terminateAndTeardown(reason)
  }
}
