import { describe, expect, it, vi } from 'vitest'
import { WebSocketTransport, type WebSocketLike } from '../websocket'
import { describeTransportContract } from './contract'

/**
 * Scripted fake implementing the slice of the DOM `WebSocket` surface
 * `WebSocketTransport` uses. Auto-"connects" on a microtask (mirroring a
 * real WebSocket never opening synchronously) unless `failToConnect` is set.
 * Exercising the real constructor against SITL is Task 2.6's job; this is
 * what lets the transport's own logic run under Vitest without a `ws` dep.
 */
class FakeWebSocket implements WebSocketLike {
  binaryType = ''
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readonly sentFrames: Uint8Array[] = []
  closeCalls = 0

  constructor(
    readonly url: string,
    private readonly failToConnect = false,
  ) {
    queueMicrotask(() => {
      if (this.failToConnect) {
        this.onerror?.(new Event('error'))
        this.onclose?.(new CloseEvent('close', { code: 1006, reason: 'connect failed' }))
      } else {
        this.onopen?.(new Event('open'))
      }
    })
  }

  send(data: ArrayBufferLike | ArrayBufferView): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
    this.sentFrames.push(bytes)
  }

  close(): void {
    this.closeCalls += 1
    this.onclose?.(new CloseEvent('close', { code: 1000, reason: 'closed by caller' }))
  }

  /** Test helper: delivers a message frame as the peer would. */
  simulateMessage(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    this.onmessage?.(new MessageEvent('message', { data: buf }))
  }

  /** Test helper: simulates the peer/network ending the connection. */
  simulateServerClose(reason: string): void {
    this.onclose?.(new CloseEvent('close', { code: 1006, reason }))
  }
}

function makeHarness() {
  let ws: FakeWebSocket | null = null
  const transport = new WebSocketTransport('wss://example.invalid/mavlink', {
    wsFactory: (url) => {
      ws = new FakeWebSocket(url)
      return ws
    },
  })
  return {
    transport,
    feed: (bytes: Uint8Array) => ws?.simulateMessage(bytes),
    getSent: () => ws?.sentFrames ?? [],
    simulateDisconnect: (reason: string) => ws?.simulateServerClose(reason),
  }
}

describeTransportContract('WebSocketTransport', makeHarness)

describe('WebSocketTransport', () => {
  it('sets binaryType to arraybuffer before the socket connects', async () => {
    const ref: { ws: FakeWebSocket | null } = { ws: null }
    const transport = new WebSocketTransport('wss://example.invalid', {
      wsFactory: (url) => {
        ref.ws = new FakeWebSocket(url)
        return ref.ws
      },
    })

    await transport.open()

    expect(ref.ws?.binaryType).toBe('arraybuffer')
  })

  it('passes the constructor url to the injected wsFactory', async () => {
    const wsFactory = vi.fn((url: string) => new FakeWebSocket(url))
    const transport = new WebSocketTransport('wss://example.invalid/mavlink', { wsFactory })

    await transport.open()

    expect(wsFactory).toHaveBeenCalledWith('wss://example.invalid/mavlink')
  })

  it('rejects open() if the socket fails to connect', async () => {
    const transport = new WebSocketTransport('wss://example.invalid', {
      wsFactory: (url) => new FakeWebSocket(url, true),
    })

    await expect(transport.open()).rejects.toThrow()
  })

  it('close() calls the underlying socket close()', async () => {
    const ref: { ws: FakeWebSocket | null } = { ws: null }
    const transport = new WebSocketTransport('wss://example.invalid', {
      wsFactory: (url) => {
        ref.ws = new FakeWebSocket(url)
        return ref.ws
      },
    })
    await transport.open()

    await transport.close()

    expect(ref.ws?.closeCalls).toBe(1)
  })
})
