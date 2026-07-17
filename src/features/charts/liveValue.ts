import type { TelemetryState } from '../../core/mavlink/telemetry'

/**
 * Resolves a catalog Series id to its current value in the Telemetry
 * Snapshot (issue #49): the picker's live readout is display-only and comes
 * straight from the Snapshot — already unit-converted per its promise —
 * never from Samples or the History Buffer.
 *
 * The Recorder (`recorder.ts`) walks the same id ↔ field correspondence
 * structurally when it appends; this is the by-id lookup of that mapping,
 * and the liveValue test cross-checks it against the full catalog so the
 * two cannot drift apart. `null` means "not reported (yet)" — a 0 is a
 * real value.
 */

const CHANNEL_ID = /^(rc\.ch|servo\.out)(\d+)$/

const FIXED_FIELDS: Record<string, (s: TelemetryState) => number | undefined> = {
  'attitude.roll': (s) => s.attitude?.rollDeg,
  'attitude.pitch': (s) => s.attitude?.pitchDeg,
  'attitude.yaw': (s) => s.attitude?.yawDeg,
  'power.voltage': (s) => s.power?.voltage,
  'power.current': (s) => s.power?.current,
  'power.batteryRemaining': (s) => s.power?.batteryRemaining,
  'gps.satellites': (s) => s.gps?.satellites,
  'gps.hdop': (s) => s.gps?.hdop,
  'rc.rssi': (s) => s.rc?.rssi,
}

export function liveSeriesValue(state: TelemetryState | null, id: string): number | null {
  if (state === null) return null
  const indexed = CHANNEL_ID.exec(id)
  if (indexed !== null) {
    const list = indexed[1] === 'rc.ch' ? state.rc?.channels : state.servo?.outputs
    return list?.[Number(indexed[2]) - 1] ?? null
  }
  return FIXED_FIELDS[id]?.(state) ?? null
}
