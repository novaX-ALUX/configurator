/**
 * The chartable Series set (issue #4): one entry per numeric Telemetry
 * Snapshot field, in the Recorder's append order — ids are the Recorder's
 * ids, and the catalog test cross-checks the two against a full snapshot so
 * they cannot drift apart. `gps.fixType` is deliberately absent (an enum,
 * not a continuous quantity — same exclusion the Recorder makes).
 *
 * Unit Groups are the six the spec fixes (degrees / V / A / % / µs / count).
 * Two placements are judgment calls the spec leaves open, flagged here:
 * - `rc.rssi` is the wire value 0–254 in "device-dependent units" (the
 *   Telemetry layer passes it through unconverted), so calling it a percent
 *   would mislabel it — it goes in the dimensionless group instead.
 * - `gps.hdop` is a dimensionless dilution ratio — same group.
 * That leaves 'count' as the general dimensionless group (satellites, hdop,
 * rssi) and '%' holding exactly batteryRemaining.
 */

export type BlockId = 'attitude' | 'power' | 'gps' | 'rc' | 'servo'
export type UnitGroupId = 'deg' | 'V' | 'A' | 'pct' | 'us' | 'count'

export interface SeriesDef {
  /** History Buffer Series id — matches what the Recorder appends. */
  id: string
  block: BlockId
  unitGroup: UnitGroupId
  /** i18n key for the picker/legend label; interpolated with `labelParams`. */
  labelKey: string
  labelParams?: { n: number }
}

/** Subplot stacking order — one subplot per Unit Group present in the selection. */
export const UNIT_GROUP_ORDER: readonly UnitGroupId[] = ['deg', 'V', 'A', 'pct', 'us', 'count']

/** Picker section order — mirrors the Dashboard's card order. */
export const BLOCK_ORDER: readonly BlockId[] = ['attitude', 'power', 'gps', 'rc', 'servo']

const rcChannels: SeriesDef[] = Array.from({ length: 18 }, (_, i) => ({
  id: `rc.ch${i + 1}`,
  block: 'rc',
  unitGroup: 'us',
  labelKey: 'charts.series.ch',
  labelParams: { n: i + 1 },
}))

const servoOutputs: SeriesDef[] = Array.from({ length: 16 }, (_, i) => ({
  id: `servo.out${i + 1}`,
  block: 'servo',
  unitGroup: 'us',
  labelKey: 'charts.series.out',
  labelParams: { n: i + 1 },
}))

export const SERIES_CATALOG: readonly SeriesDef[] = [
  { id: 'attitude.roll', block: 'attitude', unitGroup: 'deg', labelKey: 'charts.series.roll' },
  { id: 'attitude.pitch', block: 'attitude', unitGroup: 'deg', labelKey: 'charts.series.pitch' },
  { id: 'attitude.yaw', block: 'attitude', unitGroup: 'deg', labelKey: 'charts.series.yaw' },
  { id: 'power.voltage', block: 'power', unitGroup: 'V', labelKey: 'charts.series.voltage' },
  { id: 'power.current', block: 'power', unitGroup: 'A', labelKey: 'charts.series.current' },
  { id: 'power.batteryRemaining', block: 'power', unitGroup: 'pct', labelKey: 'charts.series.batteryRemaining' },
  { id: 'gps.satellites', block: 'gps', unitGroup: 'count', labelKey: 'charts.series.satellites' },
  { id: 'gps.hdop', block: 'gps', unitGroup: 'count', labelKey: 'charts.series.hdop' },
  ...rcChannels,
  { id: 'rc.rssi', block: 'rc', unitGroup: 'count', labelKey: 'charts.series.rssi' },
  ...servoOutputs,
]
