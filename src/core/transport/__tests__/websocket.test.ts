import { describe, expect, it, vi } from 'vitest'
import { WebSocketTransport, type WebSocketLike } from '../websocket'
import { describeTransportContract } from './contract'

/**
 * Scripted fake implementing the slice of the DOM `WebSocket` surface
 * `WebSocketTransport` uses. By default auto-"connects" on a microtask
 * (mirroring a real WebSocket never opening synchronously); pass
 * `autoOpen: false` to drive the handshake manually via `triggerOpen()`,
 * needed to script the exact interleaving of two concurrent sockets in the
 * generation-race regression tests below. Exercising the real constructor
 * against SITL is Task 2.6's job; this is what lets the transport's own
 * logic run under Vitest without a `ws` dep.
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
    private readonly opts: { failToConnect?: boolean; autoOpen?: boolean } = {},
  ) {
    if (opts.autoOpen ?? true) {
      queueMicrotask(() => this.triggerOpen())
    }
  }

  send(data: ArrayBufferLike | ArrayBufferView): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
    this.sentFrames.push(bytes)
  }

  close(): void {
    this.closeCalls += 1
    this.onclose?.(new CloseEvent('close', { code: 1000, reason: 'closed by caller' }))
  }

  /** Test helper: completes the connect handshake — fires automatically unless constructed with `autoOpen: false`. */
  triggerOpen(): void {
    if (this.opts.failToConnect) {
      this.onerror?.(new Event('error'))
      this.onclose?.(new CloseEvent('close', { code: 1006, reason: 'connect failed' }))
    } else {
      this.onopen?.(new Event('open'))
    }
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
      wsFactory: (url) => new FakeWebSocket(url, { failToConnect: true }),
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

  describe('generation races (close()/reopen() interleaved with an in-flight open())', () => {
    it('a stale generation connecting late does not clobber a newer, live generation', async () => {
      const sockets: FakeWebSocket[] = []
      const transport = new WebSocketTransport('wss://example.invalid', {
        wsFactory: (url) => {
          const ws = new FakeWebSocket(url, { autoOpen: false })
          sockets.push(ws)
          return ws
        },
      })

      // gen1: start opening, but don't let it connect yet ("slow").
      const gen1Open = transport.open()
      const ws1 = sockets[0]

      // close() while gen1 is still pending.
      await transport.close()

      // gen2: opens and connects normally (fast, before gen1 does).
      const gen2Open = transport.open()
      const ws2 = sockets[1]
      ws2.triggerOpen()
      await gen2Open

      const onDisconnect = vi.fn()
      transport.onDisconnect(onDisconnect)

      // gen1's connection finally completes late, well after gen2 is live.
      ws1.triggerOpen()
      await gen1Open

      // gen2 must be completely unaffected: still open, writable, readable intact.
      expect(ws2.closeCalls).toBe(0)
      await expect(transport.write(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined()
      expect(ws2.sentFrames).toEqual([new Uint8Array([1, 2, 3])])
      const reader = transport.readable.getReader()
      ws2.simulateMessage(new Uint8Array([9, 9]))
      await expect(reader.read()).resolves.toEqual({ value: new Uint8Array([9, 9]), done: false })
      expect(onDisconnect).not.toHaveBeenCalled()

      // gen1's abandoned socket must have been physically closed (no leak),
      // without ever becoming `this.ws`.
      expect(ws1.closeCalls).toBe(1)
    })

    it('close() before a pending open() connects still releases the underlying socket once it does connect', async () => {
      const ref: { ws: FakeWebSocket | null } = { ws: null }
      const transport = new WebSocketTransport('wss://example.invalid', {
        wsFactory: (url) => {
          ref.ws = new FakeWebSocket(url, { autoOpen: false })
          return ref.ws
        },
      })

      const openPromise = transport.open()
      await transport.close()
      expect(ref.ws?.closeCalls).toBe(0) // not connected yet, nothing to close yet

      ref.ws?.triggerOpen() // connects late
      await openPromise

      expect(ref.ws?.closeCalls).toBe(1) // released once it did connect
      expect(() => transport.readable).toThrow()
      await expect(transport.write(new Uint8Array([1]))).rejects.toThrow()
    })
  })
})
