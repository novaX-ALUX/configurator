/**
 * Issue #2 (Recorder + History Buffer): every test here goes through the
 * connection store's external seams only — injected port picker + MockTransport
 * for frames in, injected clock (`createConnectionStore`'s `now` opt, the same
 * convention as `TelemetryOpts.now`) for time, and the store's `history`
 * (History Buffer) for Samples out. No Recorder internals are asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../core/transport/mock'
import { defs } from '../../core/mavlink/defs'
import { encodeFrame } from '../../core/mavlink/frame'
import { encodePayload } from '../../core/mavlink/encode'
import { Telemetry } from '../../core/mavlink/telemetry'
import { createConnectionStore, type PortPicker } from '../connection'

const HEARTBEAT_MSGID = 0
const SYS_STATUS_MSGID = 1
const GPS_RAW_INT_MSGID = 24
const ATTITUDE_MSGID = 30
const SERVO_OUTPUT_RAW_MSGID = 36
const RC_CHANNELS_MSGID = 65

const RAD_TO_DEG = 180 / Math.PI

/** The full Series set the spec names: attitude 3, power 3, GPS 2, RC 18 channels + RSSI, servo 16 — and nothing else (no fix_type, no heartbeat). */
const EXPECTED_SERIES_IDS = [
  'attitude.roll',
  'attitude.pitch',
  'attitude.yaw',
  'power.voltage',
  'power.current',
  'power.batteryRemaining',
  'gps.satellites',
  'gps.hdop',
  ...Array.from({ length: 18 }, (_, i) => `rc.ch${i + 1}`),
  'rc.rssi',
  ...Array.from({ length: 16 }, (_, i) => `servo.out${i + 1}`),
]

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, 1, 1)
}

function heartbeatFrame(seq = 0): Uint8Array {
  return frame(
    HEARTBEAT_MSGID,
    { type: 2, autopilot: 3, base_mode: 81, custom_mode: 0, system_status: 4, mavlink_version: 3 },
    seq,
  )
}

function attitudeFrame(opts: { roll?: number; pitch?: number; yaw?: number }, seq = 0): Uint8Array {
  return frame(ATTITUDE_MSGID, { roll: opts.roll ?? 0, pitch: opts.pitch ?? 0, yaw: opts.yaw ?? 0 }, seq)
}

function sysStatusFrame(opts: { voltage?: number; current?: number; remaining?: number }, seq = 0): Uint8Array {
  return frame(
    SYS_STATUS_MSGID,
    {
      voltage_battery: opts.voltage ?? 12000,
      current_battery: opts.current ?? 100,
      battery_remaining: opts.remaining ?? 80,
    },
    seq,
  )
}

function gpsFrame(opts: { eph?: number; fixType?: number; sats?: number }, seq = 0): Uint8Array {
  return frame(
    GPS_RAW_INT_MSGID,
    { eph: opts.eph ?? 150, fix_type: opts.fixType ?? 3, satellites_visible: opts.sats ?? 9 },
    seq,
  )
}

function rcFrame(opts: { rssi?: number; base?: number }, seq = 0): Uint8Array {
  const fields: Record<string, number> = {}
  for (let i = 1; i <= 18; i++) fields[`chan${i}_raw`] = (opts.base ?? 1000) + i
  fields.rssi = opts.rssi ?? 200
  return frame(RC_CHANNELS_MSGID, fields, seq)
}

function servoFrame(base = 1500, seq = 0): Uint8Array {
  const fields: Record<string, number> = {}
  for (let i = 1; i <= 16; i++) fields[`servo${i}_raw`] = base + i
  return frame(SERVO_OUTPUT_RAW_MSGID, fields, seq)
}

/** Lets pending reader.read()/microtask chains from the router's pump settle without relying on real timers — same pattern as connection.test.ts. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/**
 * Manually-advanced clock injected as the store's `now`: Block/Sample `ts`
 * move only when a test says so, independently of the fake timers (so e.g.
 * jumping Sample time 60s forward never trips the router's heartbeat
 * timeout). Advancing ≥ the telemetry notify throttle (100ms) per frame keeps
 * every notification on the immediate leading edge.
 */
function makeClock(start = 100_000) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
    t: () => t,
  }
}

type Clock = ReturnType<typeof makeClock>

async function connected(clock: Clock): Promise<{ store: ReturnType<typeof createConnectionStore>; transport: MockTransport }> {
  const transport = new MockTransport()
  const store = createConnectionStore(async () => ({ transport, portInfo: {} }), { now: clock.now })
  await store.getState().connect(115200)
  transport.feed(heartbeatFrame())
  await flush()
  expect(store.getState().phase).toBe('connected')
  return { store, transport }
}

describe('telemetry recording (Recorder + History Buffer)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts recording at connect: a Block update becomes one Sample per numeric Series, stamped with the Block ts', async () => {
    const clock = makeClock()
    const { store, transport } = await connected(clock)

    clock.advance(200)
    transport.feed(attitudeFrame({ roll: 0.1, pitch: -0.2, yaw: 0.3 }, 1))
    await flush()

    const history = store.getState().history
    const roll = history.getSamples('attitude.roll')
    expect(roll).toHaveLength(1)
    expect(roll[0].ts).toBe(clock.t())
    expect(roll[0].value).toBeCloseTo(0.1 * RAD_TO_DEG, 3)
    expect(history.getSamples('attitude.pitch')[0].value).toBeCloseTo(-0.2 * RAD_TO_DEG, 3)
    expect(history.getSamples('attitude.yaw')[0].value).toBeCloseTo(0.3 * RAD_TO_DEG, 3)
  })

  it('stamps each Sample with its own Block receive time across successive updates', async () => {
    const clock = makeClock()
    const { store, transport } = await connected(clock)

    clock.advance(200)
    const t1 = clock.t()
    transport.feed(attitudeFrame({ roll: 0.1 }, 1))
    await flush()

    clock.advance(300)
    const t2 = clock.t()
    transport.feed(attitudeFrame({ roll: 0.2 }, 2))
    await flush()

    const roll = store.getState().history.getSamples('attitude.roll')
    expect(roll.map((s) => s.ts)).toEqual([t1, t2])
  })

  it('appends nothing for a Block whose ts did not change (per-Block dedupe)', async () => {
    const clock = makeClock()
    const { store, transport } = await connected(clock)

    clock.advance(200)
    transport.feed(attitudeFrame({ roll: 0.1 }, 1))
    await flush()

    // A heartbeat updates the snapshot (and notifies subscribers) without
    // touching the attitude Block — no attitude Sample may be appended, and
    // heartbeat itself has no numeric Series.
    clock.advance(200)
    transport.feed(heartbeatFrame(2))
    await flush()

    const history = store.getState().history
    expect(history.getSamples('attitude.roll')).toHaveLength(1)
    expect(history.seriesIds()).toEqual(['attitude.roll', 'attitude.pitch', 'attitude.yaw'])
  })

  it('records every numeric Series from the spec — 43 in all, fix_type not among them', async () => {
    const clock = makeClock()
    const { store, transport } = await connected(clock)

    const feeds = [attitudeFrame({}, 1), sysStatusFrame({}, 2), gpsFrame({}, 3), rcFrame({}, 4), servoFrame(1500, 5)]
    for (const bytes of feeds) {
      clock.advance(200)
      transport.feed(bytes)
      await flush()
    }

    const ids = store.getState().history.seriesIds()
    expect(new Set(ids)).toEqual(new Set(EXPECTED_SERIES_IDS))
    expect(ids).toHaveLength(43)
  })

  it('records undefined field values as gaps (null), never as zeros', async () => {
    const clock = makeClock()
    const { store, transport } = await connected(clock)

    // The documented MAVLink "not available" sentinels, which Telemetry maps
    // to `undefined`: voltage 0xffff, current -1, remaining -1, eph 0xffff,
    // rssi 255.
    clock.advance(200)
    transport.feed(sysStatusFrame({ voltage: 0xffff, current: -1, remaining: -1 }, 1))
    await flush()
    clock.advance(200)
    transport.feed(gpsFrame({ eph: 0xffff, sats: 7 }, 2))
    await flush()
    clock.advance(200)
    transport.feed(rcFrame({ rssi: 255 }, 3))
    await flush()

    const history = store.getState().history
    expect(history.getSamples('power.voltage')[0].value).toBeNull()
    expect(history.getSamples('power.current')[0].value).toBeNull()
    expect(history.getSamples('power.batteryRemaining')[0].value).toBeNull()
    expect(history.getSamples('gps.hdop')[0].value).toBeNull()
    expect(history.getSamples('gps.satellites')[0].value).toBe(7)
    expect(history.getSamples('rc.rssi')[0].value).toBeNull()
    expect(history.getSamples('rc.ch1')[0].value).toBe(1001)
  })

  it('evicts Samples older than 60 seconds — the buffer stays bounded', async () => {
    const clock = makeClock()
    const { store, transport } = await connected(clock)

    for (let i = 0; i <= 120; i++) {
      clock.advance(1000)
      transport.feed(attitudeFrame({ roll: 0.1 }, i & 0xff))
      await flush()
    }

    const roll = store.getState().history.getSamples('attitude.roll')
    expect(roll).toHaveLength(61) // 121 appended over 120s; only the trailing 60s window survives
    expect(roll[0].ts).toBe(roll[roll.length - 1].ts - 60_000)
  })

  it('never fabricates Samples: with no incoming frames the buffer does not grow', async () => {
    const clock = makeClock()
    const { store, transport } = await connected(clock)

    clock.advance(200)
    transport.feed(attitudeFrame({ roll: 0.1 }, 1))
    await flush()

    // Real time passes (timers: throttle windows, heartbeat timeout, stats
    // ticks) and the telemetry clock jumps a full window forward — but no
    // frame arrives, so nothing may be appended.
    await vi.advanceTimersByTimeAsync(10_000)
    clock.advance(60_000)
    await flush()

    const history = store.getState().history
    expect(history.getSamples('attitude.roll')).toHaveLength(1)
    expect(history.seriesIds()).toEqual(['attitude.roll', 'attitude.pitch', 'attitude.yaw'])
  })

  it('freezes the History Buffer on disconnect() but leaves it readable', async () => {
    vi.spyOn(Telemetry.prototype, 'stopStreams').mockResolvedValue(undefined)
    const clock = makeClock()
    const { store, transport } = await connected(clock)

    clock.advance(200)
    transport.feed(attitudeFrame({ roll: 0.1 }, 1))
    await flush()

    await store.getState().disconnect()

    expect(store.getState().phase).toBe('disconnected')
    const roll = store.getState().history.getSamples('attitude.roll')
    expect(roll).toHaveLength(1)
    expect(roll[0].value).toBeCloseTo(0.1 * RAD_TO_DEG, 3)
  })

  it('freezes the History Buffer on an unplug too', async () => {
    const clock = makeClock()
    const { store, transport } = await connected(clock)

    clock.advance(200)
    transport.feed(attitudeFrame({ roll: 0.1 }, 1))
    await flush()

    transport.simulateDisconnect('device unplugged')
    await flush()

    expect(store.getState().phase).toBe('disconnected')
    expect(store.getState().history.getSamples('attitude.roll')).toHaveLength(1)
  })

  it('clears the History Buffer on the next connect, before new Samples arrive', async () => {
    vi.spyOn(Telemetry.prototype, 'stopStreams').mockResolvedValue(undefined)
    const clock = makeClock()
    const transports = [new MockTransport(), new MockTransport()]
    let calls = 0
    const picker: PortPicker = async () => ({ transport: transports[calls++], portInfo: {} })
    const store = createConnectionStore(picker, { now: clock.now })

    await store.getState().connect(115200)
    transports[0].feed(heartbeatFrame())
    await flush()
    clock.advance(200)
    transports[0].feed(attitudeFrame({ roll: 0.1 }, 1))
    await flush()
    await store.getState().disconnect()
    expect(store.getState().history.getSamples('attitude.roll')).toHaveLength(1) // survives the disconnect...

    await store.getState().connect(115200)
    transports[1].feed(heartbeatFrame())
    await flush()
    expect(store.getState().history.seriesIds()).toEqual([]) // ...and is cleared before any new Sample

    clock.advance(200)
    transports[1].feed(attitudeFrame({ roll: 0.2 }, 1))
    await flush()

    const roll = store.getState().history.getSamples('attitude.roll')
    expect(roll).toHaveLength(1) // only the new session's Sample
    expect(roll[0].value).toBeCloseTo(0.2 * RAD_TO_DEG, 3)
  })
})
