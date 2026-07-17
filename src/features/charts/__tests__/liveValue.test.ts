import { describe, expect, it } from 'vitest'
import type { TelemetryState } from '../../../core/mavlink/telemetry'
import { liveSeriesValue } from '../liveValue'
import { SERIES_CATALOG } from '../seriesCatalog'

/** A snapshot with every Block present — same construction idea as seriesCatalog.test.ts's full snapshot. */
function fullSnapshot(): TelemetryState {
  return {
    attitude: { rollDeg: 1.5, pitchDeg: -2.5, yawDeg: 180, ts: 1000 },
    power: { voltage: 12.6, current: 3.4, batteryRemaining: 80, ts: 1000 },
    gps: { fixType: 3, satellites: 9, hdop: 1.2, ts: 1000 },
    rc: { channels: Array.from({ length: 18 }, (_, i) => 1000 + i), rssi: 200, ts: 1000 },
    servo: { outputs: Array.from({ length: 16 }, (_, i) => 1100 + i), ts: 1000 },
  }
}

describe('liveSeriesValue', () => {
  it('resolves every catalog Series id against a full snapshot', () => {
    const state = fullSnapshot()
    for (const def of SERIES_CATALOG) {
      expect(liveSeriesValue(state, def.id), def.id).not.toBeNull()
    }
    // Spot-check the mapping is by field, not coincidence:
    expect(liveSeriesValue(state, 'attitude.roll')).toBe(1.5)
    expect(liveSeriesValue(state, 'attitude.pitch')).toBe(-2.5)
    expect(liveSeriesValue(state, 'power.voltage')).toBe(12.6)
    expect(liveSeriesValue(state, 'power.batteryRemaining')).toBe(80)
    expect(liveSeriesValue(state, 'gps.satellites')).toBe(9)
    expect(liveSeriesValue(state, 'gps.hdop')).toBe(1.2)
    expect(liveSeriesValue(state, 'rc.ch1')).toBe(1000)
    expect(liveSeriesValue(state, 'rc.ch18')).toBe(1017)
    expect(liveSeriesValue(state, 'rc.rssi')).toBe(200)
    expect(liveSeriesValue(state, 'servo.out1')).toBe(1100)
    expect(liveSeriesValue(state, 'servo.out16')).toBe(1115)
  })

  it('returns null for every Series when there is no snapshot yet', () => {
    for (const def of SERIES_CATALOG) {
      expect(liveSeriesValue(null, def.id), def.id).toBeNull()
      expect(liveSeriesValue({}, def.id), def.id).toBeNull()
    }
  })

  it('returns null for optional fields the vehicle did not report, without touching the rest of the Block', () => {
    const state: TelemetryState = {
      power: { voltage: 12.6, ts: 1000 },
      gps: { fixType: 3, satellites: 9, ts: 1000 },
      rc: { channels: [1500, 1501], ts: 1000 }, // only 2 channels reported
    }
    expect(liveSeriesValue(state, 'power.voltage')).toBe(12.6)
    expect(liveSeriesValue(state, 'power.current')).toBeNull()
    expect(liveSeriesValue(state, 'power.batteryRemaining')).toBeNull()
    expect(liveSeriesValue(state, 'gps.hdop')).toBeNull()
    expect(liveSeriesValue(state, 'rc.rssi')).toBeNull()
    expect(liveSeriesValue(state, 'rc.ch2')).toBe(1501)
    expect(liveSeriesValue(state, 'rc.ch3')).toBeNull()
    expect(liveSeriesValue(state, 'servo.out1')).toBeNull()
  })

  it('a value of 0 is a real value, not absence', () => {
    const state: TelemetryState = {
      attitude: { rollDeg: 0, pitchDeg: 0, yawDeg: 0, ts: 1000 },
      rc: { channels: [0], rssi: 0, ts: 1000 },
    }
    expect(liveSeriesValue(state, 'attitude.roll')).toBe(0)
    expect(liveSeriesValue(state, 'rc.ch1')).toBe(0)
    expect(liveSeriesValue(state, 'rc.rssi')).toBe(0)
  })
})
