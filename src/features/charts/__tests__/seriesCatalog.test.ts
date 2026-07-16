import { describe, expect, it } from 'vitest'
import { HistoryBuffer, Recorder } from '../../../core/mavlink/recorder'
import type { Telemetry, TelemetryState } from '../../../core/mavlink/telemetry'
import { SERIES_CATALOG, UNIT_GROUP_ORDER } from '../seriesCatalog'

/** Every Block present, every optional field set — the snapshot from which the Recorder appends its full Series set. */
const FULL_SNAPSHOT: TelemetryState = {
  attitude: { rollDeg: 1, pitchDeg: 2, yawDeg: 3, ts: 100 },
  power: { voltage: 12.6, current: 4.2, batteryRemaining: 88, ts: 100 },
  gps: { fixType: 3, satellites: 11, hdop: 0.9, ts: 100 },
  rc: { channels: Array.from({ length: 18 }, (_, i) => 1500 + i), rssi: 200, ts: 100 },
  servo: { outputs: Array.from({ length: 16 }, (_, i) => 1100 + i), ts: 100 },
  heartbeat: { armed: false, customMode: 0, baseMode: 0, systemStatus: 4, ts: 100 },
}

/** Series ids the Recorder actually records, in its own append order — the ground truth the catalog must match. */
function recordedSeriesIds(): string[] {
  const buffer = new HistoryBuffer()
  let notify: ((s: Readonly<TelemetryState>) => void) | undefined
  const telemetry = {
    subscribe: (cb: (s: Readonly<TelemetryState>) => void) => {
      notify = cb
      return () => {}
    },
  } as unknown as Telemetry
  new Recorder(telemetry, buffer)
  notify!(FULL_SNAPSHOT)
  return buffer.seriesIds()
}

describe('SERIES_CATALOG', () => {
  it('lists exactly the Series the Recorder records, in the same order — fix_type is absent', () => {
    expect(SERIES_CATALOG.map((s) => s.id)).toEqual(recordedSeriesIds())
    expect(SERIES_CATALOG.some((s) => s.id.includes('fixType'))).toBe(false)
  })

  it('partitions all 43 Series into the six Unit Groups (rssi and hdop are dimensionless -> count)', () => {
    expect(SERIES_CATALOG).toHaveLength(43)
    const byGroup = new Map<string, string[]>()
    for (const s of SERIES_CATALOG) {
      byGroup.set(s.unitGroup, [...(byGroup.get(s.unitGroup) ?? []), s.id])
    }
    expect([...byGroup.keys()].sort()).toEqual([...UNIT_GROUP_ORDER].sort())
    expect(byGroup.get('deg')).toEqual(['attitude.roll', 'attitude.pitch', 'attitude.yaw'])
    expect(byGroup.get('V')).toEqual(['power.voltage'])
    expect(byGroup.get('A')).toEqual(['power.current'])
    expect(byGroup.get('pct')).toEqual(['power.batteryRemaining'])
    expect(byGroup.get('count')).toEqual(['gps.satellites', 'gps.hdop', 'rc.rssi'])
    expect(byGroup.get('us')).toHaveLength(34) // rc.ch1-18 + servo.out1-16
  })

  it('groups every Series under its own Block', () => {
    for (const s of SERIES_CATALOG) {
      expect(s.id.startsWith(`${s.block}.`)).toBe(true)
    }
  })
})
