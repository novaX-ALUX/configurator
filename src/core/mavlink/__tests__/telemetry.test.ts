import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../transport/mock'
import { defs } from '../defs'
import { decodePayload } from '../decode'
import { encodeFrame, FrameParser } from '../frame'
import { encodePayload } from '../encode'
import { MavRouter } from '../router'
import type { CommandAck } from '../command'
import { Telemetry, type TelemetryState } from '../telemetry'

const HEARTBEAT_MSGID = 0
const SYS_STATUS_MSGID = 1
const GPS_RAW_INT_MSGID = 24
const RAW_IMU_MSGID = 27
const ATTITUDE_MSGID = 30
const SERVO_OUTPUT_RAW_MSGID = 36
const RC_CHANNELS_MSGID = 65
const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77
const REQUEST_DATA_STREAM_MSGID = 66

const MAV_CMD_SET_MESSAGE_INTERVAL = 511
const MAV_RESULT_ACCEPTED = 0
const MAV_RESULT_UNSUPPORTED = 3

const MAV_DATA_STREAM_RAW_SENSORS = 1
const MAV_DATA_STREAM_EXTENDED_STATUS = 2
const MAV_DATA_STREAM_RC_CHANNELS = 3
const MAV_DATA_STREAM_EXTRA1 = 10

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0, sysid = 1, compid = 1): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, sysid, compid)
}

function attitudeFrame(opts: { roll?: number; pitch?: number; yaw?: number }, seq = 0): Uint8Array {
  return frame(ATTITUDE_MSGID, { roll: opts.roll ?? 0, pitch: opts.pitch ?? 0, yaw: opts.yaw ?? 0 }, seq)
}

function sysStatusFrame(
  opts: { voltage?: number; current?: number; remaining?: number; present?: number; enabled?: number; health?: number },
  seq = 0,
): Uint8Array {
  return frame(
    SYS_STATUS_MSGID,
    {
      voltage_battery: opts.voltage ?? 12000,
      current_battery: opts.current ?? 100,
      battery_remaining: opts.remaining ?? 80,
      onboard_control_sensors_present: opts.present ?? 0,
      onboard_control_sensors_enabled: opts.enabled ?? 0,
      onboard_control_sensors_health: opts.health ?? 0,
    },
    seq,
  )
}

function gpsFrame(opts: { eph?: number; fixType?: number; sats?: number }, seq = 0): Uint8Array {
  return frame(
    GPS_RAW_INT_MSGID,
    {
      eph: opts.eph ?? 150,
      fix_type: opts.fixType ?? 3,
      satellites_visible: opts.sats ?? 9,
    },
    seq,
  )
}

function rcFrame(opts: { rssi?: number; base?: number }, seq = 0): Uint8Array {
  const fields: Record<string, number> = {}
  for (let i = 1; i <= 18; i++) fields[`chan${i}_raw`] = (opts.base ?? 1000) + i
  fields.rssi = opts.rssi ?? 200
  return frame(RC_CHANNELS_MSGID, fields, seq)
}

function rawImuFrame(opts: { acc?: [number, number, number]; gyro?: [number, number, number] }, seq = 0): Uint8Array {
  const [xacc, yacc, zacc] = opts.acc ?? [0, 0, 0]
  const [xgyro, ygyro, zgyro] = opts.gyro ?? [0, 0, 0]
  return frame(RAW_IMU_MSGID, { time_usec: 0n, xacc, yacc, zacc, xgyro, ygyro, zgyro, xmag: 0, ymag: 0, zmag: 0 }, seq)
}

function servoFrame(base = 1500, seq = 0): Uint8Array {
  const fields: Record<string, number> = {}
  for (let i = 1; i <= 16; i++) fields[`servo${i}_raw`] = base + i
  return frame(SERVO_OUTPUT_RAW_MSGID, fields, seq)
}

function heartbeatFrame(opts: { baseMode?: number; customMode?: number; systemStatus?: number }, seq = 0): Uint8Array {
  return frame(
    HEARTBEAT_MSGID,
    {
      custom_mode: opts.customMode ?? 5,
      type: 6,
      autopilot: 8,
      base_mode: opts.baseMode ?? 0,
      system_status: opts.systemStatus ?? 4,
    },
    seq,
  )
}

function ackFrame(opts: { command: number; result: number; sysid?: number; compid?: number; seq?: number }): Uint8Array {
  return frame(
    COMMAND_ACK_MSGID,
    { command: opts.command, result: opts.result, progress: 0, result_param2: 0 },
    opts.seq ?? 0,
    opts.sysid ?? 1,
    opts.compid ?? 1,
  )
}

/** Decodes every COMMAND_LONG frame in `sent`, in order. */
function decodeCommandLongs(sent: Uint8Array[]): Array<Record<string, unknown>> {
  const parser = new FrameParser(defs)
  const out: Array<Record<string, unknown>> = []
  for (const bytes of sent) {
    const [f] = parser.push(bytes)
    if (f.msgid === COMMAND_LONG_MSGID) out.push(decodePayload(defs, f).fields)
  }
  return out
}

/** Decodes every REQUEST_DATA_STREAM frame in `sent`, in order. */
function decodeDataStreamRequests(sent: Uint8Array[]): Array<Record<string, unknown>> {
  const parser = new FrameParser(defs)
  const out: Array<Record<string, unknown>> = []
  for (const bytes of sent) {
    const [f] = parser.push(bytes)
    if (f.msgid === REQUEST_DATA_STREAM_MSGID) out.push(decodePayload(defs, f).fields)
  }
  return out
}

function routerSubscriberCount(router: MavRouter): number {
  return (router as unknown as { subscribers: Set<unknown> }).subscribers.size
}

function routerLinkStateListenerCount(router: MavRouter): number {
  return (router as unknown as { linkStateListeners: Set<unknown> }).linkStateListeners.size
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('Telemetry', () => {
  let transport: MockTransport
  let router: MavRouter
  const target = { sysid: 1, compid: 1 }

  beforeEach(async () => {
    vi.useFakeTimers()
    transport = new MockTransport()
    router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('getState() unit conversions', () => {
    it('ATTITUDE: radians -> degrees', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(attitudeFrame({ roll: Math.PI / 2, pitch: Math.PI / 4, yaw: -Math.PI / 2 }))
      await flush()

      const attitude = telemetry.getState().attitude
      expect(attitude?.rollDeg).toBeCloseTo(90)
      expect(attitude?.pitchDeg).toBeCloseTo(45)
      expect(attitude?.yawDeg).toBeCloseTo(-90)
    })

    it('SYS_STATUS: mV -> V, cA -> A, percent passes through', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(sysStatusFrame({ voltage: 12600, current: 1550, remaining: 77 }))
      await flush()

      expect(telemetry.getState().power).toMatchObject({ voltage: 12.6, current: 15.5, batteryRemaining: 77 })
    })

    it('SYS_STATUS: voltage_battery=UINT16_MAX -> undefined, current_battery=-1 -> undefined, battery_remaining=-1 -> undefined', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(sysStatusFrame({ voltage: 0xffff, current: -1, remaining: -1 }))
      await flush()

      expect(telemetry.getState().power).toMatchObject({
        voltage: undefined,
        current: undefined,
        batteryRemaining: undefined,
      })
    })

    it('SYS_STATUS: onboard_control_sensors_present/enabled/health bitmasks pass through into the sensors block', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(sysStatusFrame({ present: 0x12f, enabled: 0x2f, health: 0x0d }))
      await flush()

      expect(telemetry.getState().sensors).toMatchObject({ present: 0x12f, enabled: 0x2f, health: 0x0d })
    })

    it('GPS_RAW_INT: eph (cm-scaled hdop) -> hdop, fix_type/satellites pass through', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(gpsFrame({ eph: 150, fixType: 3, sats: 11 }))
      await flush()

      expect(telemetry.getState().gps).toMatchObject({ hdop: 1.5, fixType: 3, satellites: 11 })
    })

    it('GPS_RAW_INT: eph=UINT16_MAX -> undefined', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(gpsFrame({ eph: 0xffff }))
      await flush()

      expect(telemetry.getState().gps?.hdop).toBeUndefined()
    })

    it('RC_CHANNELS: chanN_raw packed into an array, rssi passes through', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(rcFrame({ rssi: 180, base: 1000 }))
      await flush()

      const rc = telemetry.getState().rc
      expect(rc?.channels).toHaveLength(18)
      expect(rc?.channels[0]).toBe(1001) // chan1_raw
      expect(rc?.channels[17]).toBe(1018) // chan18_raw
      expect(rc?.rssi).toBe(180)
    })

    it('RC_CHANNELS: rssi=UINT8_MAX -> undefined', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(rcFrame({ rssi: 0xff }))
      await flush()

      expect(telemetry.getState().rc?.rssi).toBeUndefined()
    })

    it('RAW_IMU: milli-g -> m/s², mrad/s -> deg/s (ArduPilot scales despite the message name)', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(rawImuFrame({ acc: [50, -20, -1000], gyro: [1000, -500, 0] }))
      await flush()

      const imu = telemetry.getState().imu
      expect(imu?.accX).toBeCloseTo(0.490, 3) // 50 mG
      expect(imu?.accY).toBeCloseTo(-0.196, 3)
      expect(imu?.accZ).toBeCloseTo(-9.807, 3) // -1 g, the at-rest Z reading
      expect(imu?.gyroX).toBeCloseTo(57.296, 3) // 1000 mrad/s
      expect(imu?.gyroY).toBeCloseTo(-28.648, 3)
      expect(imu?.gyroZ).toBeCloseTo(0)
    })

    it('SERVO_OUTPUT_RAW: servoN_raw packed into an array', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(servoFrame(1500))
      await flush()

      const servo = telemetry.getState().servo
      expect(servo?.outputs).toHaveLength(16)
      expect(servo?.outputs[0]).toBe(1501)
      expect(servo?.outputs[15]).toBe(1516)
    })

    it('HEARTBEAT: armed derived from MAV_MODE_FLAG_SAFETY_ARMED bit, other fields pass through', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(heartbeatFrame({ baseMode: 0b1000_0001, customMode: 3, systemStatus: 4 }))
      await flush()

      expect(telemetry.getState().heartbeat).toMatchObject({
        armed: true,
        baseMode: 0b1000_0001,
        customMode: 3,
        systemStatus: 4,
      })
    })

    it('HEARTBEAT: safety-armed bit unset -> armed false', async () => {
      const telemetry = new Telemetry(router, target)
      transport.feed(heartbeatFrame({ baseMode: 0b0000_0001 }))
      await flush()

      expect(telemetry.getState().heartbeat?.armed).toBe(false)
    })
  })

  describe('requestStreams()', () => {
    it('sends one SET_MESSAGE_INTERVAL COMMAND_LONG per message, param1=msgid, param2=interval in µs (default 10Hz -> 100000µs)', async () => {
      const telemetry = new Telemetry(router, target)
      const promise = telemetry.requestStreams()
      await flush()

      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(6)
      for (const c of cmds) {
        expect(c.command).toBe(MAV_CMD_SET_MESSAGE_INTERVAL)
        expect(c.param2).toBe(100000)
      }
      const msgids = cmds.map((c) => c.param1).sort((a, b) => Number(a) - Number(b))
      // HEARTBEAT is deliberately excluded: the FC broadcasts it unconditionally, no stream request needed.
      expect(msgids).toEqual([SYS_STATUS_MSGID, GPS_RAW_INT_MSGID, RAW_IMU_MSGID, ATTITUDE_MSGID, SERVO_OUTPUT_RAW_MSGID, RC_CHANNELS_MSGID].sort((a, b) => a - b))

      // resolve every pending sendCommand so the test doesn't leak a hanging promise/timer
      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
    })

    it('honors per-message rate overrides via msgRates', async () => {
      const telemetry = new Telemetry(router, target)
      const promise = telemetry.requestStreams({ ATTITUDE: 50 })
      await flush()

      const cmds = decodeCommandLongs(transport.sent)
      const attitudeCmd = cmds.find((c) => c.param1 === ATTITUDE_MSGID)
      expect(attitudeCmd?.param2).toBe(20000) // 1e6 / 50Hz

      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
    })
  })

  describe('requestStreams() fallback to REQUEST_DATA_STREAM', () => {
    it('falls back per stream GROUP (not per message) when the ACK reports UNSUPPORTED, deduping messages that share a group', async () => {
      const sendCommandFn = vi.fn(async (_router, _target, cmd): Promise<CommandAck> => {
        // SYS_STATUS and GPS_RAW_INT both fail -> both map to MAV_DATA_STREAM_EXTENDED_STATUS,
        // so only ONE REQUEST_DATA_STREAM should be sent for that group.
        const unsupported = cmd.param1 === SYS_STATUS_MSGID || cmd.param1 === GPS_RAW_INT_MSGID
        return { command: cmd.command, result: unsupported ? MAV_RESULT_UNSUPPORTED : MAV_RESULT_ACCEPTED, progress: 0, resultParam2: 0 }
      })
      const telemetry = new Telemetry(router, target, { sendCommandFn })
      await telemetry.requestStreams()

      const requests = decodeDataStreamRequests(transport.sent)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        req_stream_id: MAV_DATA_STREAM_EXTENDED_STATUS,
        req_message_rate: 10,
        start_stop: 1,
        target_system: target.sysid,
        target_component: target.compid,
      })
    })

    it('falls back when the command times out (sendCommandFn rejects), for the failing message only', async () => {
      const sendCommandFn = vi.fn(async (_router, _target, cmd): Promise<CommandAck> => {
        if (cmd.param1 === ATTITUDE_MSGID) throw new Error('simulated CommandTimeoutError')
        return { command: cmd.command, result: MAV_RESULT_ACCEPTED, progress: 0, resultParam2: 0 }
      })
      const telemetry = new Telemetry(router, target, { sendCommandFn })
      await telemetry.requestStreams()

      const requests = decodeDataStreamRequests(transport.sent)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ req_stream_id: MAV_DATA_STREAM_EXTRA1, start_stop: 1 })
    })

    it('RAW_IMU falls back to the RAW_SENSORS stream group', async () => {
      const sendCommandFn = vi.fn(async (_router, _target, cmd): Promise<CommandAck> => ({
        command: cmd.command,
        result: cmd.param1 === RAW_IMU_MSGID ? MAV_RESULT_UNSUPPORTED : MAV_RESULT_ACCEPTED,
        progress: 0,
        resultParam2: 0,
      }))
      const telemetry = new Telemetry(router, target, { sendCommandFn })
      await telemetry.requestStreams()

      const requests = decodeDataStreamRequests(transport.sent)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ req_stream_id: MAV_DATA_STREAM_RAW_SENSORS, start_stop: 1 })
    })

    it('does not fall back for messages whose ACK is accepted', async () => {
      const sendCommandFn = vi.fn(async (_router, _target, cmd): Promise<CommandAck> => {
        return { command: cmd.command, result: cmd.param1 === RC_CHANNELS_MSGID ? MAV_RESULT_UNSUPPORTED : MAV_RESULT_ACCEPTED, progress: 0, resultParam2: 0 }
      })
      const telemetry = new Telemetry(router, target, { sendCommandFn })
      await telemetry.requestStreams()

      const requests = decodeDataStreamRequests(transport.sent)
      expect(requests).toHaveLength(1)
      expect(requests[0].req_stream_id).toBe(MAV_DATA_STREAM_RC_CHANNELS)
    })
  })

  describe('stopStreams()', () => {
    it('sends SET_MESSAGE_INTERVAL with interval_us=-1 for every message', async () => {
      const telemetry = new Telemetry(router, target)
      const promise = telemetry.stopStreams()
      await flush()

      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(6)
      for (const c of cmds) {
        expect(c.command).toBe(MAV_CMD_SET_MESSAGE_INTERVAL)
        expect(c.param2).toBe(-1)
      }

      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
    })

    it('falls back to REQUEST_DATA_STREAM(start_stop=0) when the ACK is unsupported', async () => {
      const sendCommandFn = vi.fn(async (_router, _target, cmd): Promise<CommandAck> => ({
        command: cmd.command,
        result: cmd.param1 === ATTITUDE_MSGID ? MAV_RESULT_UNSUPPORTED : MAV_RESULT_ACCEPTED,
        progress: 0,
        resultParam2: 0,
      }))
      const telemetry = new Telemetry(router, target, { sendCommandFn })
      await telemetry.stopStreams()

      const requests = decodeDataStreamRequests(transport.sent)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ req_stream_id: MAV_DATA_STREAM_EXTRA1, req_message_rate: 0, start_stop: 0 })
    })
  })

  describe('subscribe() throttling', () => {
    it('coalesces rapid updates to ~10Hz, with a trailing notify carrying the latest state', async () => {
      const telemetry = new Telemetry(router, target)
      const seen: Array<Readonly<TelemetryState>> = []
      telemetry.subscribe((s) => seen.push(s))

      transport.feed(attitudeFrame({ roll: 0 }))
      await flush()
      expect(seen).toHaveLength(1) // leading edge: first update notifies immediately

      // Several rapid updates within the same 100ms throttle window.
      transport.feed(attitudeFrame({ roll: 0.1 }, 1))
      transport.feed(attitudeFrame({ roll: 0.2 }, 2))
      transport.feed(attitudeFrame({ roll: 0.3 }, 3))
      await flush()
      expect(seen).toHaveLength(1) // still coalesced, no new notify yet

      await vi.advanceTimersByTimeAsync(100) // trailing edge fires
      expect(seen).toHaveLength(2)
      expect(seen[1].attitude?.rollDeg).toBeCloseTo(0.3 * (180 / Math.PI)) // latest value, not dropped
    })

    it('uses the injected now (not a hardwired Date.now) to drive ts and the throttle gate', async () => {
      let clock = 0
      const now = vi.fn(() => (clock += 1000)) // large strides -> every update looks like a fresh window (never coalesced)
      const telemetry = new Telemetry(router, target, { now })
      const seen: Array<Readonly<TelemetryState>> = []
      telemetry.subscribe((s) => seen.push(s))

      transport.feed(attitudeFrame({ roll: 0 }, 0))
      transport.feed(attitudeFrame({ roll: 0.5 }, 1))
      await flush()

      expect(now).toHaveBeenCalled()
      expect(seen).toHaveLength(2) // both notified immediately since `now` jumps by 1000ms each call
      expect(seen[0].attitude?.ts).toBe(1000)
      expect(seen[1].attitude?.ts).toBeGreaterThan(1000)
    })

    it('unsubscribe stops further notifications to that callback only', async () => {
      const telemetry = new Telemetry(router, target)
      const a: unknown[] = []
      const b: unknown[] = []
      const unsubA = telemetry.subscribe((s) => a.push(s))
      telemetry.subscribe((s) => b.push(s))

      transport.feed(attitudeFrame({ roll: 0 }, 0))
      await flush()
      unsubA()

      transport.feed(attitudeFrame({ roll: 1 }, 1))
      await vi.advanceTimersByTimeAsync(100)

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(2)
    })
  })

  describe('disconnect freezes the snapshot', () => {
    it('stops applying updates once linkState is lost, and resumes once connected again', async () => {
      // A dedicated transport/router (rather than the shared `beforeEach` ones)
      // so this test controls heartbeatTimeoutMs directly.
      const localTransport = new MockTransport()
      const heartbeatRouter = new MavRouter(localTransport, defs, { heartbeatTimeoutMs: 3000 })
      await localTransport.open()
      heartbeatRouter.start()
      const telemetry = new Telemetry(heartbeatRouter, target)

      localTransport.feed(heartbeatFrame({}))
      localTransport.feed(attitudeFrame({ roll: 1.0 }, 1))
      await flush()
      expect(heartbeatRouter.linkState).toBe('connected')
      expect(telemetry.getState().attitude?.rollDeg).toBeCloseTo(1.0 * (180 / Math.PI))

      await vi.advanceTimersByTimeAsync(3000) // heartbeat timeout -> 'lost'
      expect(heartbeatRouter.linkState).toBe('lost')

      localTransport.feed(attitudeFrame({ roll: 2.0 }, 2))
      await flush()
      // frozen: still the pre-lost value, not the new one
      expect(telemetry.getState().attitude?.rollDeg).toBeCloseTo(1.0 * (180 / Math.PI))

      localTransport.feed(heartbeatFrame({}, 3)) // recovers link
      await flush()
      expect(heartbeatRouter.linkState).toBe('connected')

      localTransport.feed(attitudeFrame({ roll: 3.0 }, 4))
      await flush()
      expect(telemetry.getState().attitude?.rollDeg).toBeCloseTo(3.0 * (180 / Math.PI))
    })
  })

  describe('dispose()', () => {
    it('unsubscribes from the router (message + linkState) and stops notifying telemetry subscribers', async () => {
      const telemetry = new Telemetry(router, target)
      const subBefore = routerSubscriberCount(router)
      const linkBefore = routerLinkStateListenerCount(router)
      expect(subBefore).toBeGreaterThan(0)
      expect(linkBefore).toBeGreaterThan(0)

      const seen: unknown[] = []
      telemetry.subscribe((s) => seen.push(s))
      transport.feed(attitudeFrame({ roll: 0 }, 0))
      await flush()
      expect(seen).toHaveLength(1)

      telemetry.dispose()
      expect(routerSubscriberCount(router)).toBe(subBefore - 1)
      expect(routerLinkStateListenerCount(router)).toBe(linkBefore - 1)

      transport.feed(attitudeFrame({ roll: 1 }, 1))
      await vi.advanceTimersByTimeAsync(200)
      expect(seen).toHaveLength(1) // no further notifications after dispose
    })
  })
})
