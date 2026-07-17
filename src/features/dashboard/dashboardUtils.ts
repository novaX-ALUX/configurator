/**
 * Small pure helpers shared by the Dashboard cards — split out from the
 * rendering components so the ArduCopter mode table, PWM normalization, and
 * GPS fix classification can be unit-tested without mounting React (same
 * split as ParamsPage/paramUtils.ts).
 */

/**
 * ArduCopter's `mode.h` `Number` enum — the common, documented modes a GCS
 * would realistically see. Anything else renders as `MODE {n}` rather than
 * guessing (task brief's own fallback rule).
 */
const ARDUCOPTER_MODES: Record<number, string> = {
  0: 'STABILIZE',
  1: 'ACRO',
  2: 'ALT_HOLD',
  3: 'AUTO',
  4: 'GUIDED',
  5: 'LOITER',
  6: 'RTL',
  7: 'CIRCLE',
  9: 'LAND',
  11: 'DRIFT',
  13: 'SPORT',
  14: 'FLIP',
  15: 'AUTOTUNE',
  16: 'POSHOLD',
  17: 'BRAKE',
  18: 'THROW',
  19: 'AVOID_ADSB',
  20: 'GUIDED_NOGPS',
  21: 'SMART_RTL',
  22: 'FLOWHOLD',
  23: 'FOLLOW',
  24: 'ZIGZAG',
  25: 'SYSTEMID',
  26: 'AUTOROTATE',
  27: 'AUTO_RTL',
  28: 'TURTLE',
}

export function arduCopterModeName(customMode: number): string {
  return ARDUCOPTER_MODES[customMode] ?? `MODE ${customMode}`
}

/** ArduPilot always prefixes pre-arm-check STATUSTEXT with this literal (case varies by firmware version). Shared by DashboardPage (VehicleCard's `prearmText`) and the global telemetry strip (issue #11) — both derive PreArm state from the same real captured messages, never a fabricated "all checks passed" claim. */
export const PREARM_PREFIX = /^PreArm:/i

/**
 * SERVO_OUTPUT_RAW / RC_CHANNELS both use the 1000-2000µs convention —
 * normalizes to a 0-100 display percent. A channel at or below 1000µs (or a
 * never-populated 0) clamps to 0, which is also this app's "idle" test
 * (MotorOutputsCard grays a bar out at pct <= 0).
 */
export function pctFromUs(raw: number): number {
  return Math.max(0, Math.min(100, Math.round((raw - 1000) / 10)))
}

export type GpsFixTier = 'none' | '2d' | '3d'

/** GPS_RAW_INT.fix_type per the task brief: 0/1 = no fix, 2 = 2D, 3+ = 3D (this also covers DGPS/RTK float/fixed, all "3D-or-better"). */
export function gpsFixTier(fixType: number): GpsFixTier {
  if (fixType >= 3) return '3d'
  if (fixType === 2) return '2d'
  return 'none'
}

/**
 * Conservative implausibility floor for a reported pack voltage, in volts (issue #9).
 *
 * SYS_STATUS's `battery_remaining` % can come from a source (e.g. an ESC's own estimate)
 * that's independent of `voltage_battery`, so a board running on USB/bench power can report
 * a healthy-looking percent next to a voltage far too low to be a real pack — the observed
 * case was 0.02 V next to "80% remaining", both rendered as healthy.
 *
 * 3.0 V is the conventional LiPo/Li-ion low-voltage cutoff — the point below which a single
 * cell is considered over-discharged even after sag under load. Any real 1S-6S pack in normal
 * use reports at or above this, so this floor never flags a genuine pack; it only catches
 * near-zero/no-battery readings. (A 1S pack abused well past its cutoff, e.g. left to self-
 * discharge to 2.5 V, could still trip this — but that's abnormal use of a damaged cell, not
 * the "plausible pack in normal use" case the issue asks this to leave alone.) A literal 0 V
 * is excluded (kept as a distinct "unpopulated" case, not the spurious-low-reading case this
 * guards against) — this matches the interval in the issue's acceptance criteria.
 */
const IMPLAUSIBLE_VOLTAGE_FLOOR_V = 3.0

export function isVoltageImplausible(voltage: number): boolean {
  return voltage > 0 && voltage < IMPLAUSIBLE_VOLTAGE_FLOOR_V
}

/**
 * Sensors-health grid (issue #52, UI audit D2) — bit values from the MAVLink
 * `MAV_SYS_STATUS_SENSOR` enum, matched against the raw
 * `SYS_STATUS.onboard_control_sensors_present/_enabled/_health` bitmasks the
 * Telemetry Snapshot's `sensors` block passes through (telemetry.ts).
 */
const SENSOR_3D_GYRO = 0x01
const SENSOR_3D_ACCEL = 0x02
const SENSOR_3D_MAG = 0x04
const SENSOR_ABSOLUTE_PRESSURE = 0x08
const SENSOR_GPS = 0x20
const SENSOR_OPTICAL_FLOW = 0x40
/** ArduPilot reports rangefinder health under this bit (GCS_Common's SYS_STATUS mapping). */
const SENSOR_LASER_POSITION = 0x100

export type SensorTileKey = 'imu' | 'compass' | 'baro' | 'gps' | 'optflow' | 'rangefinder'

export interface SensorTile {
  key: SensorTileKey
  /** The `MAV_SYS_STATUS_SENSOR` bit(s) this tile summarizes. */
  mask: number
  /** True for the sensors the Calibration page can actually calibrate (accel/gyro, compass) — these tiles double as navigation there. */
  calibratable: boolean
}

/** The six tiles of the audit's D2 grid, in display order. */
export const SENSOR_TILES: readonly SensorTile[] = [
  { key: 'imu', mask: SENSOR_3D_GYRO | SENSOR_3D_ACCEL, calibratable: true },
  { key: 'compass', mask: SENSOR_3D_MAG, calibratable: true },
  { key: 'baro', mask: SENSOR_ABSOLUTE_PRESSURE, calibratable: false },
  { key: 'gps', mask: SENSOR_GPS, calibratable: false },
  { key: 'optflow', mask: SENSOR_OPTICAL_FLOW, calibratable: false },
  { key: 'rangefinder', mask: SENSOR_LASER_POSITION, calibratable: false },
]

export type SensorTileStatus = 'ok' | 'attention' | 'disabled' | 'absent'

/**
 * Standard GCS reading of the SYS_STATUS sensor bitmasks (what Mission
 * Planner's HUD sensor lights do): a sensor only demands attention when it is
 * present AND enabled AND unhealthy. Present-but-disabled (e.g. a compass
 * with COMPASS_USE=0) is `'disabled'` — rendered in the same gray as
 * `'absent'` (deliberately unused is not a problem to fix), but labeled
 * distinctly so the tile never claims hardware is missing when it's merely
 * turned off. For a multi-bit mask (IMU = gyro|accel), only the bits that are
 * actually present+enabled must be healthy.
 */
export function sensorTileStatus(sensors: { present: number; enabled: number; health: number }, mask: number): SensorTileStatus {
  const present = sensors.present & mask
  if (present === 0) return 'absent'
  const active = present & sensors.enabled
  if (active === 0) return 'disabled'
  return (sensors.health & active) === active ? 'ok' : 'attention'
}

/** `+12.3°` / `-4.5°` — sign always shown explicitly (matches the design file's own rollTxt/pitchTxt convention). */
export function formatSignedDeg(deg: number): string {
  return `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`
}

/** ATTITUDE.yaw converts to degrees in [-180, 180] (telemetry.ts's own RAD_TO_DEG conversion) — the heading tape reads a compass heading, so this normalizes to [0, 360). */
export function normalizeHeadingDeg(yawDeg: number): number {
  return ((yawDeg % 360) + 360) % 360
}
