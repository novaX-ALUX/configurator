/**
 * MavRouter: the session layer sitting on top of a `Transport` (task 2.1)
 * and the frame/decode layers (task 2.2). It is the one thing every MAVLink
 * consumer (command layer, param store, UI) talks to instead of touching
 * `Transport`/`FrameParser`/`decodePayload` directly.
 *
 * Responsibilities:
 * - Runs the byte -> `MavFrame` -> `DecodedMessage` pipeline and fans
 *   decoded messages out to filtered subscribers.
 * - Maintains a HEARTBEAT-derived component registry and a single
 *   link-state machine (idle/connecting/connected/lost).
 * - Owns outgoing sequencing (`send()`), using the router's own configured
 *   source sysid/compid.
 *
 * Router does **not** own the transport's open/close lifecycle — the
 * caller opens (and eventually closes) the `Transport`; the router only
 * reads from `transport.readable` and writes via `transport.write()`.
 *
 * Lifecycle (the one chosen of the two options named in the task brief):
 * call `start()` exactly once, after `transport.open()` has resolved.
 * `start()` synchronously acquires a reader on `transport.readable` — the
 * same fail-fast contract `Transport.write()` already uses, so calling it
 * before `open()` (or after `close()`) throws immediately instead of
 * silently doing nothing — then begins pumping bytes through the parser in
 * the background. `linkState` is `'idle'` until `start()` is called,
 * `'connecting'` from `start()` until the first HEARTBEAT, `'connected'`
 * while HEARTBEATs keep arriving inside `heartbeatTimeoutMs` of each other,
 * and `'lost'` once that timeout elapses (recovering to `'connected'` on
 * the next HEARTBEAT). A transport disconnect (any reason, including a
 * caller-initiated `close()`) moves `linkState` to `'idle'`, since the
 * link itself is gone rather than merely quiet — the pump stops cleanly
 * (the underlying stream ends gracefully per the `Transport` contract) and
 * no further subscriber callbacks fire.
 */
import type { Transport } from '../transport/types'
import type { GeneratedDefs } from './defs'
import { encodeFrame, FrameParser, type MavFrame } from './frame'
import { decodePayload, type DecodedMessage } from './decode'

/** MAVLink spec guarantees msgid 0 is HEARTBEAT in every dialect. */
const HEARTBEAT_MSGID = 0

const DEFAULT_SYSID = 255
const DEFAULT_COMPID = 190
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 3000

export interface EncodableMessage {
  msgid: number
  payload: Uint8Array
}

export interface ComponentInfo {
  sysid: number
  compid: number
  type: number
  autopilot: number
  baseMode: number
  customMode: number
  systemStatus: number
  /** Timestamp (from the router's injected clock) of the last HEARTBEAT seen from this component. */
  lastSeen: number
}

export type LinkState = 'idle' | 'connecting' | 'connected' | 'lost'

export interface MavRouterFilter {
  msgid?: number
  sysid?: number
  compid?: number
}

export interface MavRouterStats {
  /** Frames the parser handed to the router (received === FrameParser.stats.received). */
  framesIn: number
  framesOut: number
  decodeErrors: number
  signedDropped: number
  crcErrors: number
  badMsgId: number
  dropped: number
}

export interface MavRouterOpts {
  /** Source system ID used by `send()`. Defaults to 255 (a GCS/companion computer, per MAVLink convention). */
  sysid?: number
  /** Source component ID used by `send()`. Defaults to 190 (MAV_COMP_ID_MISSIONPLANNER-ish GCS convention). */
  compid?: number
  /** No HEARTBEAT within this many ms of the last one moves `linkState` to `'lost'`. */
  heartbeatTimeoutMs?: number
  /** Clock used for `ComponentInfo.lastSeen`, injectable for tests. */
  now?: () => number
}

function matchesFilter(filter: MavRouterFilter, frame: MavFrame): boolean {
  if (filter.msgid !== undefined && filter.msgid !== frame.msgid) return false
  if (filter.sysid !== undefined && filter.sysid !== frame.sysid) return false
  if (filter.compid !== undefined && filter.compid !== frame.compid) return false
  return true
}

interface Subscriber {
  filter: MavRouterFilter
  cb: (msg: DecodedMessage, frame: MavFrame) => void
}

export class MavRouter {
  private readonly sysid: number
  private readonly compid: number
  private readonly heartbeatTimeoutMs: number
  private readonly now: () => number

  private readonly parser: FrameParser
  private readonly subscribers = new Set<Subscriber>()
  private readonly linkStateListeners = new Set<(s: LinkState) => void>()
  private readonly components = new Map<string, ComponentInfo>()

  private seq = 0
  private started = false
  /**
   * Set once the transport disconnects, so the pump can discard any frame
   * that was already buffered in the stream at that moment (the stream
   * still delivers already-enqueued chunks before it ends, per the
   * `Transport` contract's "graceful end of stream" guarantee — without
   * this flag such a frame would resurrect `linkState`/reach subscribers
   * after `onDisconnect` already fired).
   */
  private stopped = false
  private currentLinkState: LinkState = 'idle'
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  private framesOut = 0
  private decodeErrors = 0
  private signedDropped = 0

  constructor(
    private readonly transport: Transport,
    private readonly defs: GeneratedDefs,
    opts: MavRouterOpts = {},
  ) {
    this.sysid = opts.sysid ?? DEFAULT_SYSID
    this.compid = opts.compid ?? DEFAULT_COMPID
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    this.now = opts.now ?? Date.now
    this.parser = new FrameParser(defs)

    this.transport.onDisconnect(() => {
      this.stopped = true
      this.clearHeartbeatTimer()
      this.setLinkState('idle')
    })
  }

  get linkState(): LinkState {
    return this.currentLinkState
  }

  get stats(): MavRouterStats {
    return {
      framesIn: this.parser.stats.received,
      framesOut: this.framesOut,
      decodeErrors: this.decodeErrors,
      signedDropped: this.signedDropped,
      crcErrors: this.parser.stats.crcErrors,
      badMsgId: this.parser.stats.badMsgId,
      dropped: this.parser.stats.dropped,
    }
  }

  /** See the class-level doc for the full lifecycle contract. Throws if already started, or if the transport isn't open. */
  start(): void {
    if (this.started) {
      throw new Error('MavRouter.start() called twice')
    }
    const reader = this.transport.readable.getReader() // throws if transport isn't open
    this.started = true
    this.setLinkState('connecting')
    void this.pump(reader)
  }

  subscribe(filter: MavRouterFilter, cb: (msg: DecodedMessage, frame: MavFrame) => void): () => void {
    const subscriber: Subscriber = { filter, cb }
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  async send(msg: EncodableMessage): Promise<void> {
    const seq = this.seq
    this.seq = (this.seq + 1) & 0xff
    const bytes = encodeFrame(this.defs, msg, seq, this.sysid, this.compid)
    await this.transport.write(bytes)
    this.framesOut++
  }

  /** Read-only snapshot (a copy, not a live view) of the HEARTBEAT-derived component registry. */
  getComponents(): ReadonlyMap<string, ComponentInfo> {
    return new Map(this.components)
  }

  onLinkState(cb: (s: LinkState) => void): () => void {
    this.linkStateListeners.add(cb)
    return () => {
      this.linkStateListeners.delete(cb)
    }
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || this.stopped) break
        for (const frame of this.parser.push(value)) {
          this.handleFrame(frame)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private handleFrame(frame: MavFrame): void {
    if (frame.signed) {
      this.signedDropped++
      return
    }

    let decoded: DecodedMessage
    try {
      decoded = decodePayload(this.defs, frame)
    } catch {
      this.decodeErrors++
      return
    }

    if (frame.msgid === HEARTBEAT_MSGID) {
      this.handleHeartbeat(frame, decoded)
    }

    for (const { filter, cb } of this.subscribers) {
      if (!matchesFilter(filter, frame)) continue
      // A subscriber's callback is external, less-trusted code (UI/consumer
      // logic) — isolate it the same way a decode error is isolated above,
      // so one buggy subscriber can't take down the read pump for every
      // other subscriber and every later frame.
      try {
        cb(decoded, frame)
      } catch (err) {
        console.error('MavRouter: subscriber callback threw', err)
      }
    }
  }

  private handleHeartbeat(frame: MavFrame, decoded: DecodedMessage): void {
    const key = `${frame.sysid}:${frame.compid}`
    this.components.set(key, {
      sysid: frame.sysid,
      compid: frame.compid,
      type: Number(decoded.fields.type),
      autopilot: Number(decoded.fields.autopilot),
      baseMode: Number(decoded.fields.base_mode),
      customMode: Number(decoded.fields.custom_mode),
      systemStatus: Number(decoded.fields.system_status),
      lastSeen: this.now(),
    })

    this.setLinkState('connected')
    this.armHeartbeatTimer()
  }

  private armHeartbeatTimer(): void {
    this.clearHeartbeatTimer()
    this.heartbeatTimer = setTimeout(() => {
      this.setLinkState('lost')
    }, this.heartbeatTimeoutMs)
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private setLinkState(state: LinkState): void {
    if (this.currentLinkState === state) return
    this.currentLinkState = state
    for (const cb of this.linkStateListeners) {
      try {
        cb(state)
      } catch (err) {
        console.error('MavRouter: onLinkState callback threw', err)
      }
    }
  }
}
