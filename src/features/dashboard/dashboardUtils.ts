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

/** `+12.3°` / `-4.5°` — sign always shown explicitly (matches the design file's own rollTxt/pitchTxt convention). */
export function formatSignedDeg(deg: number): string {
  return `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`
}

/** ATTITUDE.yaw converts to degrees in [-180, 180] (telemetry.ts's own RAD_TO_DEG conversion) — the heading tape reads a compass heading, so this normalizes to [0, 360). */
export function normalizeHeadingDeg(yawDeg: number): number {
  return ((yawDeg % 360) + 360) % 360
}
