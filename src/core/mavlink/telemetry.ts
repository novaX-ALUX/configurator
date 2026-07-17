/**
 * Telemetry stream core layer: requests a live telemetry stream from the
 * target component, decodes+unit-converts every arriving message into a
 * single `TelemetryState` snapshot, and fans that snapshot out to throttled
 * subscribers. This is the layer Dashboard (task 6.2), motor feedback, and
 * (later) calibration all read live vehicle state through — nothing else in
 * the app should decode ATTITUDE/SYS_STATUS/GPS_RAW_INT/RC_CHANNELS/
 * SERVO_OUTPUT_RAW/HEARTBEAT payloads directly.
 *
 * **Unit conversion happens here, once.** `TelemetryState` never stores a
 * raw wire value — every field is already in the unit a UI would want to
 * render directly:
 * - ATTITUDE roll/pitch/yaw: radians -> degrees.
 * - SYS_STATUS.voltage_battery: mV -> V; UINT16_MAX (65535, "not sent by
 *   autopilot" per the MAVLink spec) -> `undefined`.
 * - SYS_STATUS.current_battery: cA (centi-amps) -> A; -1 ("not measured")
 *   -> `undefined`.
 * - SYS_STATUS.battery_remaining: already percent; -1 ("unknown") ->
 *   `undefined`.
 * - SYS_STATUS.onboard_control_sensors_present/enabled/health: pass through
 *   as-is into the `sensors` block (dimensionless `MAV_SYS_STATUS_SENSOR`
 *   bitmasks, nothing to unit-convert) — per-sensor bit interpretation is a
 *   UI concern (dashboardUtils' sensor tiles), not this layer's.
 * - GPS_RAW_INT.eph: cm-scaled HDOP -> `hdop` (divide by 100); UINT16_MAX
 *   (65535, "unknown") -> `undefined`. `fix_type`/`satellites_visible` pass
 *   through as-is (no conversion, no sentinel).
 * - RC_CHANNELS.rssi: UINT8_MAX (255, "invalid/unknown" per the MAVLink
 *   spec) -> `undefined`; `chanN_raw` (µs, already the unit a UI wants)
 *   packed into a 18-element `channels` array, index 0 = `chan1_raw`.
 * - SERVO_OUTPUT_RAW.servoN_raw: packed into a 16-element `outputs` array
 *   (µs pass-through, no conversion), index 0 = `servo1_raw`.
 * - HEARTBEAT: `armed` derived from `base_mode & MAV_MODE_FLAG_SAFETY_ARMED`
 *   (bit 0x80); `custom_mode`/`base_mode`/`system_status` pass through.
 * - RAW_IMU (issue #53): despite the message's "raw values without scaling"
 *   spec wording, ArduPilot sends the first IMU scaled — acc in milli-g,
 *   gyro in mrad/s (GCS_Common's send_raw_imu; Mission Planner relies on
 *   the same convention) — converted here to m/s² and deg/s.
 *
 * The `voltage`/`current`/`batteryRemaining`/`hdop`/`rssi` sentinel-to-
 * `undefined` mappings above go slightly beyond the task brief's explicit
 * example (which named only `battery_remaining`) — they're included because
 * (a) they're real, documented MAVLink sentinels (not a guess) and (b) the
 * `TelemetryState` Produces interface already marks exactly these fields
 * (and no others in their block) optional, which only makes sense if they
 * can genuinely be absent. Flagged here for easy review/revert if a
 * stricter reading is wanted.
 *
 * Every block's `ts` is this layer's own receive-time clock (`opts.now`,
 * default `Date.now`), not a device-relative field from the message —
 * SYS_STATUS carries no time field at all, so a uniform local-receive-time
 * convention across all seven blocks (rather than "device time where
 * available, local time otherwise") is what keeps `ts` comparable across
 * blocks.
 *
 * ## requestStreams / stopStreams
 *
 * Primary path: `MAV_CMD_SET_MESSAGE_INTERVAL` (511) as a `COMMAND_LONG`,
 * one command per message — `param1` = msgid, `param2` = interval in
 * microseconds (`stopStreams` sends `-1`, the spec's "disable" sentinel).
 * Rates are expressed to callers in Hz (`msgRates`), converted to
 * microseconds here.
 *
 * Fallback path: if the ACK reports `MAV_RESULT_UNSUPPORTED`/`FAILED`, or
 * the command times out entirely (`sendCommand`'s own retry/timeout
 * policy), that *specific message* falls back to the legacy
 * `REQUEST_DATA_STREAM` (msgid 66) — sent as a plain message via
 * `router.send`, not `sendCommand` (it has no COMMAND_ACK to correlate).
 * **This fallback is per stream *group*, not per message** —
 * `REQUEST_DATA_STREAM` predates per-message rates and can only ask for a
 * bundle (e.g. ArduPilot's EXTENDED_STATUS group carries SYS_STATUS *and*
 * GPS_RAW_INT together; RC_CHANNELS group carries RC_CHANNELS *and*
 * SERVO_OUTPUT_RAW). `STREAM_GROUP_FOR_MSG` records that grouping; a
 * fallback for one message in a group also (harmlessly) re-requests
 * whatever else shares that group, and a group is only ever sent once per
 * `requestStreams`/`stopStreams` call even if multiple of its messages need
 * the fallback (deduped via a per-call `Set`).
 */
import { defs } from './defs'
import { encodePayload } from './encode'
import { sendCommand, type CommandAck, type SendCommandOpts } from './command'
import { MAV_CMD_SET_MESSAGE_INTERVAL, MAVLINK_MSG_ID_REQUEST_DATA_STREAM } from './commandIds'
import type { DecodedMessage } from './decode'
import type { MavRouter, LinkState } from './router'

/** The six streamable telemetry messages this layer requests/decodes (HEARTBEAT is always broadcast by the FC regardless of stream requests, so it isn't in this set — it's still decoded passively, see `applyHeartbeat`). */
export type TelemetryMsg = 'ATTITUDE' | 'SYS_STATUS' | 'GPS_RAW_INT' | 'RC_CHANNELS' | 'SERVO_OUTPUT_RAW' | 'RAW_IMU'

const TELEMETRY_MSGS: readonly TelemetryMsg[] = ['ATTITUDE', 'SYS_STATUS', 'GPS_RAW_INT', 'RC_CHANNELS', 'SERVO_OUTPUT_RAW', 'RAW_IMU']

const RAD_TO_DEG = 180 / Math.PI
const STANDARD_GRAVITY_MSS = 9.80665
/** ArduPilot's RAW_IMU acc unit (milli-g) -> m/s². */
const MILLI_G_TO_MSS = STANDARD_GRAVITY_MSS / 1000
/** ArduPilot's RAW_IMU gyro unit (mrad/s) -> deg/s. */
const MRAD_S_TO_DEG_S = RAD_TO_DEG / 1000
const MAV_MODE_FLAG_SAFETY_ARMED = 0x80
const UINT16_MAX = 0xffff
const UINT8_MAX = 0xff

const MAV_RESULT_UNSUPPORTED = 3
const MAV_RESULT_FAILED = 4

/** Interval (µs) that means "disable this message" for `MAV_CMD_SET_MESSAGE_INTERVAL`, and the `stopStreams` counterpart of `requestStreams`' per-message rate. */
const STOP_INTERVAL_US = -1

/** Notify subscribers at most this often (~10Hz), per the task brief. */
const THROTTLE_MS = 100

const DEFAULT_RATE_HZ = 10

/**
 * ArduPilot's `MAV_DATA_STREAM_*` groupings (GCS_Common.cpp's stream-rate
 * table) that `REQUEST_DATA_STREAM`'s fallback path addresses by — see the
 * module doc for why this is a many-messages-per-group, not 1:1, mapping.
 */
const MAV_DATA_STREAM_RAW_SENSORS = 1
const MAV_DATA_STREAM_EXTENDED_STATUS = 2
const MAV_DATA_STREAM_RC_CHANNELS = 3
const MAV_DATA_STREAM_EXTRA1 = 10

const STREAM_GROUP_FOR_MSG: Record<TelemetryMsg, number> = {
  ATTITUDE: MAV_DATA_STREAM_EXTRA1,
  SYS_STATUS: MAV_DATA_STREAM_EXTENDED_STATUS,
  GPS_RAW_INT: MAV_DATA_STREAM_EXTENDED_STATUS,
  RC_CHANNELS: MAV_DATA_STREAM_RC_CHANNELS,
  SERVO_OUTPUT_RAW: MAV_DATA_STREAM_RC_CHANNELS,
  RAW_IMU: MAV_DATA_STREAM_RAW_SENSORS,
}

export interface TelemetryState {
  attitude?: { rollDeg: number; pitchDeg: number; yawDeg: number; ts: number }
  power?: { voltage?: number; current?: number; batteryRemaining?: number; ts: number }
  gps?: { fixType: number; satellites: number; hdop?: number; ts: number }
  rc?: { channels: number[]; rssi?: number; ts: number }
  servo?: { outputs: number[]; ts: number }
  heartbeat?: { armed: boolean; customMode: number; baseMode: number; systemStatus: number; ts: number }
  imu?: { accX: number; accY: number; accZ: number; gyroX: number; gyroY: number; gyroZ: number; ts: number }
  /** SYS_STATUS.onboard_control_sensors_present/_enabled/_health — raw `MAV_SYS_STATUS_SENSOR` bitmasks (see module doc). */
  sensors?: { present: number; enabled: number; health: number; ts: number }
}

export interface TelemetryOpts {
  /** Injectable in place of the real `sendCommand` (command.ts), for tests. */
  sendCommandFn?: (
    router: MavRouter,
    target: { sysid: number; compid: number },
    cmd: Parameters<typeof sendCommand>[2],
    opts?: SendCommandOpts,
  ) => Promise<CommandAck>
  /** Clock for every state block's `ts` and for the subscribe-throttle gate. Default `Date.now`. Never call `Date.now()` directly elsewhere in this file — always `this.now()`, so this stays actually injectable (see module doc). */
  now?: () => number
}

/** Looks up `name`'s msgid via the `defs` adapter (never a hardcoded literal) — throws if this build's dialect registry somehow lacks it, which would be a packaging bug, not a runtime condition callers should handle. */
function requireMsgId(name: string): number {
  const id = defs.msgIdForName(name)
  if (id === undefined) {
    throw new Error(`Telemetry: '${name}' has no msgid in defs' message registry`)
  }
  return id
}

export class Telemetry {
  private readonly sendCommandFn: NonNullable<TelemetryOpts['sendCommandFn']>
  private readonly now: () => number

  private readonly msgIds: Record<TelemetryMsg, number>
  private readonly heartbeatMsgId: number

  private readonly unsubscribeRouter: () => void
  private readonly unsubscribeLinkState: () => void

  private state: TelemetryState = {}
  private readonly subscribers = new Set<(s: Readonly<TelemetryState>) => void>()

  /** Set once `router.linkState` is `'lost'`/`'idle'` — see module doc's disconnect-freeze behavior. Initialized from the router's *current* state so constructing a `Telemetry` against an already-disconnected router starts frozen too, not just on the next transition. */
  private frozen: boolean

  private lastEmit = -Infinity
  private pendingEmit = false
  private pendingTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly router: MavRouter,
    private readonly target: { sysid: number; compid: number },
    opts: TelemetryOpts = {},
  ) {
    this.sendCommandFn = opts.sendCommandFn ?? sendCommand
    this.now = opts.now ?? Date.now

    this.msgIds = {
      ATTITUDE: requireMsgId('ATTITUDE'),
      SYS_STATUS: requireMsgId('SYS_STATUS'),
      GPS_RAW_INT: requireMsgId('GPS_RAW_INT'),
      RC_CHANNELS: requireMsgId('RC_CHANNELS'),
      SERVO_OUTPUT_RAW: requireMsgId('SERVO_OUTPUT_RAW'),
      RAW_IMU: requireMsgId('RAW_IMU'),
    }
    this.heartbeatMsgId = requireMsgId('HEARTBEAT')

    this.frozen = router.linkState === 'lost' || router.linkState === 'idle'

    this.unsubscribeRouter = router.subscribe(
      { sysid: target.sysid, compid: target.compid },
      (msg) => this.handleMessage(msg),
    )
    this.unsubscribeLinkState = router.onLinkState((s) => this.handleLinkState(s))
  }

  /** Requests the six telemetry messages at `msgRates[msg] ?? 10`Hz each (see module doc for the primary/fallback protocol). Resolves once every message has either been accepted or fallen back. */
  async requestStreams(msgRates?: Partial<Record<TelemetryMsg, number>>): Promise<void> {
    const fallbackGroupsSent = new Set<number>()
    await Promise.all(
      TELEMETRY_MSGS.map(async (msgName) => {
        const rateHz = msgRates?.[msgName] ?? DEFAULT_RATE_HZ
        const intervalUs = Math.round(1_000_000 / rateHz)
        const needsFallback = await this.trySetMessageInterval(this.msgIds[msgName], intervalUs)
        if (needsFallback) {
          await this.sendFallbackStream(msgName, rateHz, 1, fallbackGroupsSent)
        }
      }),
    )
  }

  /** Disables all six telemetry messages (`interval_us = -1`), falling back to `REQUEST_DATA_STREAM(start_stop=0)` per the same policy as `requestStreams`. Call before disconnecting. */
  async stopStreams(): Promise<void> {
    const fallbackGroupsSent = new Set<number>()
    await Promise.all(
      TELEMETRY_MSGS.map(async (msgName) => {
        const needsFallback = await this.trySetMessageInterval(this.msgIds[msgName], STOP_INTERVAL_US)
        if (needsFallback) {
          await this.sendFallbackStream(msgName, 0, 0, fallbackGroupsSent)
        }
      }),
    )
  }

  getState(): Readonly<TelemetryState> {
    return this.state
  }

  /** Throttled to ~10Hz (see module doc); the trailing edge always fires so the latest state is never dropped even under a steady flood of faster updates. */
  subscribe(cb: (s: Readonly<TelemetryState>) => void): () => void {
    this.subscribers.add(cb)
    return () => {
      this.subscribers.delete(cb)
    }
  }

  /** Unsubscribes from the router (both the message and link-state subscriptions) and drops all telemetry subscribers. Idempotent-ish: safe to call once. */
  dispose(): void {
    this.unsubscribeRouter()
    this.unsubscribeLinkState()
    if (this.pendingTimer !== undefined) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = undefined
    }
    this.subscribers.clear()
  }

  // --- internals ---------------------------------------------------------

  private handleLinkState(state: LinkState): void {
    this.frozen = state === 'lost' || state === 'idle'
  }

  private handleMessage(msg: DecodedMessage): void {
    if (this.frozen) return // disconnected: keep the last-known snapshot, don't apply anything

    switch (msg.msgid) {
      case this.msgIds.ATTITUDE:
        this.applyAttitude(msg.fields)
        break
      case this.msgIds.SYS_STATUS:
        this.applySysStatus(msg.fields)
        break
      case this.msgIds.GPS_RAW_INT:
        this.applyGps(msg.fields)
        break
      case this.msgIds.RC_CHANNELS:
        this.applyRc(msg.fields)
        break
      case this.msgIds.SERVO_OUTPUT_RAW:
        this.applyServo(msg.fields)
        break
      case this.msgIds.RAW_IMU:
        this.applyRawImu(msg.fields)
        break
      case this.heartbeatMsgId:
        this.applyHeartbeat(msg.fields)
        break
      default:
        return // not a message this layer cares about
    }
    this.scheduleNotify()
  }

  private applyAttitude(fields: DecodedMessage['fields']): void {
    this.state = {
      ...this.state,
      attitude: {
        rollDeg: Number(fields.roll) * RAD_TO_DEG,
        pitchDeg: Number(fields.pitch) * RAD_TO_DEG,
        yawDeg: Number(fields.yaw) * RAD_TO_DEG,
        ts: this.now(),
      },
    }
  }

  private applySysStatus(fields: DecodedMessage['fields']): void {
    const voltageRaw = Number(fields.voltage_battery)
    const currentRaw = Number(fields.current_battery)
    const remainingRaw = Number(fields.battery_remaining)
    this.state = {
      ...this.state,
      power: {
        voltage: voltageRaw === UINT16_MAX ? undefined : voltageRaw / 1000,
        current: currentRaw === -1 ? undefined : currentRaw / 100,
        batteryRemaining: remainingRaw === -1 ? undefined : remainingRaw,
        ts: this.now(),
      },
      sensors: {
        present: Number(fields.onboard_control_sensors_present),
        enabled: Number(fields.onboard_control_sensors_enabled),
        health: Number(fields.onboard_control_sensors_health),
        ts: this.now(),
      },
    }
  }

  private applyGps(fields: DecodedMessage['fields']): void {
    const ephRaw = Number(fields.eph)
    this.state = {
      ...this.state,
      gps: {
        fixType: Number(fields.fix_type),
        satellites: Number(fields.satellites_visible),
        hdop: ephRaw === UINT16_MAX ? undefined : ephRaw / 100,
        ts: this.now(),
      },
    }
  }

  private applyRc(fields: DecodedMessage['fields']): void {
    const channels: number[] = []
    for (let i = 1; i <= 18; i++) channels.push(Number(fields[`chan${i}_raw`]))
    const rssiRaw = Number(fields.rssi)
    this.state = {
      ...this.state,
      rc: {
        channels,
        rssi: rssiRaw === UINT8_MAX ? undefined : rssiRaw,
        ts: this.now(),
      },
    }
  }

  private applyServo(fields: DecodedMessage['fields']): void {
    const outputs: number[] = []
    for (let i = 1; i <= 16; i++) outputs.push(Number(fields[`servo${i}_raw`]))
    this.state = { ...this.state, servo: { outputs, ts: this.now() } }
  }

  private applyRawImu(fields: DecodedMessage['fields']): void {
    this.state = {
      ...this.state,
      imu: {
        accX: Number(fields.xacc) * MILLI_G_TO_MSS,
        accY: Number(fields.yacc) * MILLI_G_TO_MSS,
        accZ: Number(fields.zacc) * MILLI_G_TO_MSS,
        gyroX: Number(fields.xgyro) * MRAD_S_TO_DEG_S,
        gyroY: Number(fields.ygyro) * MRAD_S_TO_DEG_S,
        gyroZ: Number(fields.zgyro) * MRAD_S_TO_DEG_S,
        ts: this.now(),
      },
    }
  }

  private applyHeartbeat(fields: DecodedMessage['fields']): void {
    const baseMode = Number(fields.base_mode)
    this.state = {
      ...this.state,
      heartbeat: {
        armed: (baseMode & MAV_MODE_FLAG_SAFETY_ARMED) !== 0,
        customMode: Number(fields.custom_mode),
        baseMode,
        systemStatus: Number(fields.system_status),
        ts: this.now(),
      },
    }
  }

  /** Leading-edge-immediate, trailing-edge-guaranteed throttle: the first update in a quiet period notifies right away; further updates within `THROTTLE_MS` are coalesced into a single trailing notification carrying whatever the latest state is by the time it fires. */
  private scheduleNotify(): void {
    const nowTs = this.now()
    const elapsed = nowTs - this.lastEmit
    if (elapsed >= THROTTLE_MS) {
      this.lastEmit = nowTs
      this.pendingEmit = false
      this.emitToSubscribers()
      return
    }

    this.pendingEmit = true
    if (this.pendingTimer === undefined) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = undefined
        if (this.pendingEmit) {
          this.pendingEmit = false
          this.lastEmit = this.now()
          this.emitToSubscribers()
        }
      }, THROTTLE_MS - elapsed)
    }
  }

  private emitToSubscribers(): void {
    for (const cb of this.subscribers) {
      try {
        cb(this.state)
      } catch (err) {
        console.error('Telemetry: subscriber callback threw', err)
      }
    }
  }

  /** Sends `MAV_CMD_SET_MESSAGE_INTERVAL` for `msgid`/`intervalUs`. Returns whether the legacy `REQUEST_DATA_STREAM` fallback is needed: true if the ACK was `UNSUPPORTED`/`FAILED`, or if `sendCommandFn` rejected at all (most commonly `CommandTimeoutError` — an old firmware that doesn't recognize command 511 usually never ACKs it, rather than answering UNSUPPORTED). */
  private async trySetMessageInterval(msgid: number, intervalUs: number): Promise<boolean> {
    try {
      const ack = await this.sendCommandFn(this.router, this.target, {
        command: MAV_CMD_SET_MESSAGE_INTERVAL,
        param1: msgid,
        param2: intervalUs,
      })
      return ack.result === MAV_RESULT_UNSUPPORTED || ack.result === MAV_RESULT_FAILED
    } catch {
      return true
    }
  }

  /** Sends legacy `REQUEST_DATA_STREAM` for `msgName`'s stream group, deduped against `sentGroups` (see module doc: this is one request per *group*, not per message). */
  private async sendFallbackStream(
    msgName: TelemetryMsg,
    rateHz: number,
    startStop: 0 | 1,
    sentGroups: Set<number>,
  ): Promise<void> {
    const streamId = STREAM_GROUP_FOR_MSG[msgName]
    if (sentGroups.has(streamId)) return
    sentGroups.add(streamId)

    const payload = encodePayload(defs, MAVLINK_MSG_ID_REQUEST_DATA_STREAM, {
      target_system: this.target.sysid,
      target_component: this.target.compid,
      req_stream_id: streamId,
      req_message_rate: startStop === 1 ? rateHz : 0,
      start_stop: startStop,
    })
    await this.router.send({ msgid: MAVLINK_MSG_ID_REQUEST_DATA_STREAM, payload })
  }
}
