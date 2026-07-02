import { BaseTransport } from './types'

/**
 * The slice of the DOM `WebSocket` surface `WebSocketTransport` uses.
 * Abstracted (rather than depending on the global `WebSocket` directly) so
 * tests can inject a scripted fake without a real `ws` server — see
 * `__tests__/websocket.test.ts`. The real global `WebSocket` satisfies this
 * shape as-is.
 */
export interface WebSocketLike {
  binaryType: string
  onopen: ((ev: Event) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onclose: ((ev: CloseEvent) => void) | null
  onerror: ((ev: Event) => void) | null
  send(data: ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

/** `Transport` over a WebSocket bridge (e.g. mavlink-router's ws endpoint, or a SITL bridge — wired in Task 2.6). */
export class WebSocketTransport extends BaseTransport {
  private readonly url: string
  private readonly wsFactory: WebSocketFactory
  private ws: WebSocketLike | null = null

  constructor(url: string, opts?: { wsFactory?: WebSocketFactory }) {
    super()
    this.url = url
    this.wsFactory = opts?.wsFactory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike)
  }

  protected doOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.wsFactory(this.url)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        this.ws = ws
        resolve()
      }
      ws.onerror = () => {
        reject(new Error(`WebSocket connection to ${this.url} failed`))
      }
      ws.onmessage = (ev) => {
        this.enqueue(new Uint8Array(ev.data as ArrayBuffer))
      }
      ws.onclose = (ev) => {
        void this.terminateAndTeardown(ev.reason || `WebSocket closed (code ${ev.code})`)
      }
    })
  }

  protected async doWrite(data: Uint8Array): Promise<void> {
    this.ws?.send(data)
  }

  protected async doClose(): Promise<void> {
    this.ws?.close()
  }
}
