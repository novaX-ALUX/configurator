import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../core/transport/mock'
import { defs } from '../../core/mavlink/defs'
import { encodeFrame, FrameParser } from '../../core/mavlink/frame'
import { encodePayload } from '../../core/mavlink/encode'
import { decodePayload } from '../../core/mavlink/decode'
import { Telemetry } from '../../core/mavlink/telemetry'
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
    vi.restoreAllMocks()
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
      vi.spyOn(Telemetry.prototype, 'stopStreams').mockResolvedValue(undefined)

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
      vi.spyOn(Telemetry.prototype, 'stopStreams').mockResolvedValue(undefined)

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

  describe('session', () => {
    it('is assembled once connected: router/target/paramStore/telemetry all set, paramStore is the same instance the store exposes', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      const { session, paramStore } = store.getState()
      expect(session).not.toBeNull()
      expect(session!.router).toBeDefined()
      expect(session!.target).toEqual({ sysid: 1, compid: 1 })
      expect(session!.paramStore).toBe(paramStore)
      expect(session!.telemetry).toBeDefined()
    })

    it('is null before connecting', () => {
      const store = createConnectionStore(async () => {
        throw new Error('should never be called')
      })
      expect(store.getState().session).toBeNull()
    })

    it('disposes telemetry alongside paramStore on disconnect(), and clears session', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      const { session } = store.getState()
      vi.spyOn(session!.telemetry, 'stopStreams').mockResolvedValue(undefined)
      const telemetryDisposeSpy = vi.spyOn(session!.telemetry, 'dispose')
      const paramStoreDisposeSpy = vi.spyOn(session!.paramStore, 'dispose')

      await store.getState().disconnect()

      expect(telemetryDisposeSpy).toHaveBeenCalledTimes(1)
      expect(paramStoreDisposeSpy).toHaveBeenCalledTimes(1)
      expect(store.getState().session).toBeNull()
    })

    it('disposes telemetry alongside paramStore on an unplug', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      const { session } = store.getState()
      const telemetryDisposeSpy = vi.spyOn(session!.telemetry, 'dispose')

      transport.simulateDisconnect('device unplugged')
      await flush()

      expect(telemetryDisposeSpy).toHaveBeenCalledTimes(1)
      expect(store.getState().session).toBeNull()
    })

    it('disposes telemetry on takeoverForFlash() same as paramStore', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      const { session } = store.getState()
      const telemetryDisposeSpy = vi.spyOn(session!.telemetry, 'dispose')

      store.getState().takeoverForFlash()

      expect(telemetryDisposeSpy).toHaveBeenCalledTimes(1)
      expect(store.getState().session).toBeNull()
    })

    it('rebuilds a fresh session (new instances) on reconnect', async () => {
      const transports = [new MockTransport(), new MockTransport()]
      let calls = 0
      const picker: PortPicker = async () => {
        const transport = transports[calls]
        calls++
        return { transport, portInfo: {} }
      }
      const store = createConnectionStore(picker)

      await store.getState().connect(115200)
      transports[0].feed(heartbeatFrame())
      await flush()
      const firstSession = store.getState().session
      vi.spyOn(firstSession!.telemetry, 'stopStreams').mockResolvedValue(undefined)
      await store.getState().disconnect()

      await store.getState().connect(115200)
      transports[1].feed(heartbeatFrame())
      await flush()

      const secondSession = store.getState().session
      expect(secondSession).not.toBeNull()
      expect(secondSession).not.toBe(firstSession)
      expect(secondSession!.router).not.toBe(firstSession!.router)
      expect(secondSession!.paramStore).not.toBe(firstSession!.paramStore)
      expect(secondSession!.telemetry).not.toBe(firstSession!.telemetry)
    })
  })

  describe('telemetry stream lifecycle', () => {
    /** The per-message rates the store is documented to request (task brief's suggested defaults). */
    const EXPECTED_RATES = {
      ATTITUDE: 10,
      SYS_STATUS: 2,
      GPS_RAW_INT: 2,
      RC_CHANNELS: 5,
      SERVO_OUTPUT_RAW: 5,
    }

    it('requests telemetry streams once connected, with the documented per-message rates', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))
      const requestStreamsSpy = vi.spyOn(Telemetry.prototype, 'requestStreams').mockResolvedValue(undefined)

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      expect(requestStreamsSpy).toHaveBeenCalledTimes(1)
      expect(requestStreamsSpy).toHaveBeenCalledWith(EXPECTED_RATES)
    })

    it('a requestStreams() rejection does not break the connected state', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))
      vi.spyOn(Telemetry.prototype, 'requestStreams').mockRejectedValue(new Error('board refused'))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      // Never awaited by connect() — the rejection above must be caught
      // internally (no unhandled rejection) and must not have blocked the
      // 'connected' transition.
      expect(store.getState().phase).toBe('connected')
    })

    it('calls stopStreams() before the transport is closed, on a graceful disconnect()', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))
      vi.spyOn(Telemetry.prototype, 'requestStreams').mockResolvedValue(undefined)
      const stopStreamsSpy = vi.spyOn(Telemetry.prototype, 'stopStreams').mockResolvedValue(undefined)
      const closeSpy = vi.spyOn(transport, 'close')

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      await store.getState().disconnect()

      expect(stopStreamsSpy).toHaveBeenCalledTimes(1)
      expect(closeSpy).toHaveBeenCalledTimes(1)
      expect(stopStreamsSpy.mock.invocationCallOrder[0]).toBeLessThan(closeSpy.mock.invocationCallOrder[0])
      expect(store.getState().phase).toBe('disconnected')
    })

    it('disconnect() still tears down and resolves even if stopStreams() rejects (best-effort — the board may already be gone)', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))
      vi.spyOn(Telemetry.prototype, 'requestStreams').mockResolvedValue(undefined)
      vi.spyOn(Telemetry.prototype, 'stopStreams').mockRejectedValue(new Error('board already gone'))

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      await expect(store.getState().disconnect()).resolves.toBeUndefined()
      expect(store.getState().phase).toBe('disconnected')
    })

    it('does not call stopStreams() on an unplug (link is already gone), but still disposes telemetry', async () => {
      const transport = new MockTransport()
      const store = createConnectionStore(pickerFor(transport))
      vi.spyOn(Telemetry.prototype, 'requestStreams').mockResolvedValue(undefined)
      const stopStreamsSpy = vi.spyOn(Telemetry.prototype, 'stopStreams').mockResolvedValue(undefined)

      await store.getState().connect(115200)
      transport.feed(heartbeatFrame())
      await flush()

      const telemetryDisposeSpy = vi.spyOn(store.getState().session!.telemetry, 'dispose')

      transport.simulateDisconnect('device unplugged')
      await flush()

      expect(stopStreamsSpy).not.toHaveBeenCalled()
      expect(telemetryDisposeSpy).toHaveBeenCalledTimes(1)
      expect(store.getState().session).toBeNull()
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
