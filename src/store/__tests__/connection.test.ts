import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../core/transport/mock'
import { defs } from '../../core/mavlink/defs'
import { encodeFrame, FrameParser } from '../../core/mavlink/frame'
import { encodePayload } from '../../core/mavlink/encode'
import { decodePayload } from '../../core/mavlink/decode'
import { createConnectionStore, type PickedPort, type PortPicker } from '../connection'

const HEARTBEAT_MSGID = 0
const STATUSTEXT_MSGID = 253
const AUTOPILOT_VERSION_MSGID = 148
const COMMAND_ACK_MSGID = 77
const MAV_CMD_REQUEST_MESSAGE = 512

function heartbeatFrame(opts?: { sysid?: number; compid?: number; seq?: number }): Uint8Array {
  const payload = encodePayload(defs, HEARTBEAT_MSGID, {
    type: 2,
    autopilot: 3,
    base_mode: 81,
    custom_mode: 0,
    system_status: 4,
    mavlink_version: 3,
  })
  return encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload }, opts?.seq ?? 0, opts?.sysid ?? 1, opts?.compid ?? 1)
}

function statustextFrame(opts: { severity: number; text: string; sysid?: number; compid?: number; seq?: number }): Uint8Array {
  const payload = encodePayload(defs, STATUSTEXT_MSGID, {
    severity: opts.severity,
    text: opts.text,
    id: 0,
    chunk_seq: 0,
  })
  return encodeFrame(defs, { msgid: STATUSTEXT_MSGID, payload }, opts.seq ?? 0, opts.sysid ?? 1, opts.compid ?? 1)
}

/**
 * `encodePayload` doesn't support the numeric-array fields AUTOPILOT_VERSION
 * carries (flight/middleware/os_custom_version, uid2) — this builds the
 * scalar prefix (through product_id) by hand, DataView-style, same as
 * router.test.ts's `heartbeatPayload()`. `decodePayload` zero-extends the
 * rest (the array fields), which is fine since nothing here asserts them.
 */
function autopilotVersionFrame(opts: { flightSwVersion: number; productId: number; sysid?: number; compid?: number; seq?: number }): Uint8Array {
  const buf = new Uint8Array(36)
  const view = new DataView(buf.buffer)
  view.setBigUint64(0, 0n, true) // capabilities
  view.setBigUint64(8, 0n, true) // uid
  view.setUint32(16, opts.flightSwVersion, true)
  view.setUint32(20, 0, true) // middleware_sw_version
  view.setUint32(24, 0, true) // os_sw_version
  view.setUint32(28, 0, true) // board_version
  view.setUint16(32, 0, true) // vendor_id
  view.setUint16(34, opts.productId, true)
  return encodeFrame(defs, { msgid: AUTOPILOT_VERSION_MSGID, payload: buf }, opts.seq ?? 0, opts.sysid ?? 1, opts.compid ?? 1)
}

function decodeLastSent(transport: MockTransport): { msgid: number; fields: Record<string, unknown> } {
  const parser = new FrameParser(defs)
  const [frame] = parser.push(transport.sent[transport.sent.length - 1])
  return { msgid: frame.msgid, fields: decodePayload(defs, frame).fields }
}

function ackFrame(opts: { command: number; result: number; sysid?: number; compid?: number; seq?: number }): Uint8Array {
  const payload = encodePayload(defs, COMMAND_ACK_MSGID, {
    command: opts.command,
    result: opts.result,
    progress: 0,
    result_param2: 0,
  })
  return encodeFrame(defs, { msgid: COMMAND_ACK_MSGID, payload }, opts.seq ?? 0, opts.sysid ?? 1, opts.compid ?? 1)
}

/** Lets pending reader.read()/microtask chains from the router's pump settle without relying on real timers — same pattern as router.test.ts. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function pickerFor(transport: MockTransport, portInfo: PickedPort['portInfo'] = {}): PortPicker {
  return async () => ({ transport, portInfo })
}

describe('connection store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('connect()', () => {
    it('goes disconnected -> connecting -> connected as the transport opens and the first HEARTBEAT arrives', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))
      expect(store.getState().phase).toBe('disconnected')

      const connectPromise = store.getState().connect(115200)
      await flush()
      expect(store.getState().phase).toBe('connecting')

      transport.feed(heartbeatFrame())
      await flush()
      expect(store.getState().phase).toBe('connected')

      await connectPromise
    })

    it('stores the baud passed to connect() and the picked port info', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport, { usbVendorId: 0x1209, usbProductId: 7 }))

      await store.getState().connect(57600)
      await flush()

      expect(store.getState().baud).toBe(57600)
      expect(store.getState().portInfo).toEqual({ usbVendorId: 0x1209, usbProductId: 7 })
    })

    it('is a no-op while already connecting/connected (guards re-entrant Connect clicks)', async () => {
      const transport = new MockTransport()
      let calls = 0
      const picker: PortPicker = async () => {
        calls++
        return { transport, portInfo: {} }
      }
      const store = createConnectionStore(picker)

      const first = store.getState().connect(115200)
      const second = store.getState().connect(115200) // fired while the first is still 'connecting'
      await flush()
      await first
      await second

      expect(calls).toBe(1)
    })

    it('resolves to disconnected (no throw) when the user dismisses the native port picker', async () => {
      const store = createConnectionStore(async () => null)

      await store.getState().connect(115200)

      expect(store.getState().phase).toBe('disconnected')
      expect(store.getState().lastDisconnectReason).toBeNull()
    })

    it('records a reason and returns to disconnected if the picker itself rejects', async () => {
      const store = createConnectionStore(async () => {
        throw new Error('Web Serial is not available in this browser')
      })

      await store.getState().connect(115200)

      expect(store.getState().phase).toBe('disconnected')
      expect(store.getState().lastDisconnectReason).toContain('Web Serial')
    })
  })

  describe('STATUSTEXT ring buffer', () => {
    async function connected(): Promise<{ store: ReturnType<typeof createConnectionStore>; transport: MockTransport }> {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))
      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()
      return { store, transport }
    }

    it('appends STATUSTEXT messages with severity/text/ts', async () => {
      const { store, transport } = await connected()

      transport.feed(statustextFrame({ severity: 4, text: 'Arm: check batt' }))
      await flush()

      expect(store.getState().statustext).toEqual([
        expect.objectContaining({ severity: 4, text: 'Arm: check batt' }),
      ])
    })

    it('caps the buffer at 500, dropping the oldest entries', async () => {
      const { store, transport } = await connected()

      for (let i = 0; i < 510; i++) {
        transport.feed(statustextFrame({ severity: 6, text: `msg ${i}`, seq: i & 0xff }))
      }
      await flush()

      const buf = store.getState().statustext
      expect(buf).toHaveLength(500)
      expect(buf[0].text).toBe('msg 10') // the first 10 were evicted
      expect(buf[buf.length - 1].text).toBe('msg 509')
    })

    it('clearStatustext() empties the buffer', async () => {
      const { store, transport } = await connected()
      transport.feed(statustextFrame({ severity: 6, text: 'hello' }))
      await flush()
      expect(store.getState().statustext).toHaveLength(1)

      store.getState().clearStatustext()

      expect(store.getState().statustext).toEqual([])
    })
  })

  describe('AUTOPILOT_VERSION identity', () => {
    it('requests AUTOPILOT_VERSION via MAV_CMD_REQUEST_MESSAGE once connected, and decodes an eventual reply', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      const sent = decodeLastSent(transport)
      expect(sent.fields.command).toBe(MAV_CMD_REQUEST_MESSAGE)
      expect(sent.fields.param1).toBe(AUTOPILOT_VERSION_MSGID)
      expect(store.getState().identity).toBeNull() // no reply yet

      // ACK for the request, then the actual AUTOPILOT_VERSION message.
      transport.feed(ackFrame({ command: MAV_CMD_REQUEST_MESSAGE, result: 0 }))
      // 4.5.7 stable: major=4 minor=5 patch=7 type=255 (official/no suffix)
      const flightSwVersion = (4 << 24) | (5 << 16) | (7 << 8) | 255
      transport.feed(autopilotVersionFrame({ flightSwVersion, productId: 1099 }))
      await flush()

      expect(store.getState().identity).toEqual({ boardId: 1099, fwVersion: '4.5.7', vehicleName: undefined })
    })

    it('leaves identity null and does not block anything if AUTOPILOT_VERSION is never answered', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      // No ACK, no AUTOPILOT_VERSION ever arrives — connect() must already have
      // resolved and phase must already be 'connected' (nothing awaits the
      // identity request).
      expect(store.getState().phase).toBe('connected')
      expect(store.getState().identity).toBeNull()
    })
  })

  describe('disconnect() / teardown', () => {
    it('disposes the ParamStore, drops identity/portInfo/linkStats, and returns to disconnected', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      const paramStore = store.getState().paramStore
      expect(paramStore).not.toBeNull()
      const disposeSpy = vi.spyOn(paramStore!, 'dispose')

      await store.getState().disconnect()

      expect(disposeSpy).toHaveBeenCalledTimes(1)
      expect(store.getState().phase).toBe('disconnected')
      expect(store.getState().identity).toBeNull()
      expect(store.getState().portInfo).toBeNull()
      expect(store.getState().linkStats).toBeNull()
      expect(store.getState().paramStore).toBeNull()
      expect(store.getState().lastDisconnectReason).toBe('closed')
    })

    it('auto-tears-down on an unplug (transport-initiated disconnect) without disconnect() being called', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()
      expect(store.getState().phase).toBe('connected')

      transport.simulateDisconnect('device unplugged')
      await flush()

      expect(store.getState().phase).toBe('disconnected')
      expect(store.getState().lastDisconnectReason).toBe('device unplugged')
      expect(store.getState().paramStore).toBeNull()
    })

    it('disconnect() is a no-op when there is nothing connected', async () => {
      const store = createConnectionStore(async () => {
        throw new Error('should never be called')
      })

      await expect(store.getState().disconnect()).resolves.toBeUndefined()
      expect(store.getState().phase).toBe('disconnected')
    })

    it('allows a fresh connect() after a full disconnect (no generation reuse)', async () => {
      const transport1 = new MockTransport()
      let calls = 0
      const picker: PortPicker = async () => {
        calls++
        return { transport: calls === 1 ? transport1 : new MockTransport(), portInfo: {} }
      }
      const store = createConnectionStore(picker)

      await store.getState().connect(115200)
      transport1.feed(heartbeatFrame())
      await flush()
      await store.getState().disconnect()
      expect(store.getState().phase).toBe('disconnected')

      await store.getState().connect(115200)
      await flush()

      expect(calls).toBe(2)
      expect(store.getState().phase).toBe('connecting')
    })
  })

  describe('takeoverForFlash()', () => {
    it('tears down telemetry/paramStore like disconnect(), but returns the live transport instead of closing it', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      const paramStore = store.getState().paramStore
      expect(paramStore).not.toBeNull()
      const disposeSpy = vi.spyOn(paramStore!, 'dispose')

      const handedOff = store.getState().takeoverForFlash()

      expect(handedOff).toBe(transport)
      expect(disposeSpy).toHaveBeenCalledTimes(1)
      expect(store.getState().phase).toBe('disconnected')
      expect(store.getState().paramStore).toBeNull()
      expect(store.getState().identity).toBeNull()
      expect(store.getState().portInfo).toBeNull()
      // Not a real disconnect — no reason should be recorded.
      expect(store.getState().lastDisconnectReason).toBeNull()
    })

    it('does not re-run teardown when the caller later closes the handed-off transport itself', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      store.getState().takeoverForFlash()
      await transport.close() // simulates px4bl.ts's sendRebootToBootloader closing the transport

      // teardown() must not have fired a second time and clobbered state
      // (e.g. it would otherwise set a stray lastDisconnectReason).
      expect(store.getState().phase).toBe('disconnected')
      expect(store.getState().lastDisconnectReason).toBeNull()
    })

    it('returns null when not connected', () => {
      const store = createConnectionStore(async () => {
        throw new Error('should never be called')
      })

      expect(store.getState().takeoverForFlash()).toBeNull()
    })
  })

  describe('linkStats', () => {
    it('is populated immediately on connect and refreshed every second while connected', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      await flush()
      expect(store.getState().linkStats).not.toBeNull()
      expect(store.getState().linkStats?.framesIn).toBe(0)

      transport.feed(heartbeatFrame())
      await flush()
      await vi.advanceTimersByTimeAsync(1000)

      expect(store.getState().linkStats?.framesIn).toBe(1)
    })
  })
})
