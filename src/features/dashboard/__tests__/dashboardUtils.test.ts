import { describe, expect, it } from 'vitest'
import {
  arduCopterModeName,
  formatSignedDeg,
  gpsFixTier,
  isVoltageImplausible,
  normalizeHeadingDeg,
  pctFromUs,
  SENSOR_TILES,
  sensorTileStatus,
} from '../dashboardUtils'

describe('arduCopterModeName', () => {
  it('decodes the common ArduCopter modes', () => {
    expect(arduCopterModeName(0)).toBe('STABILIZE')
    expect(arduCopterModeName(5)).toBe('LOITER')
    expect(arduCopterModeName(6)).toBe('RTL')
    expect(arduCopterModeName(16)).toBe('POSHOLD')
  })

  it('falls back to "MODE {n}" for an unrecognized custom_mode', () => {
    expect(arduCopterModeName(999)).toBe('MODE 999')
  })
})

describe('pctFromUs', () => {
  it('maps 1000-2000us to 0-100', () => {
    expect(pctFromUs(1000)).toBe(0)
    expect(pctFromUs(1500)).toBe(50)
    expect(pctFromUs(2000)).toBe(100)
  })

  it('clamps below 1000 (and 0, i.e. never populated) to 0', () => {
    expect(pctFromUs(0)).toBe(0)
    expect(pctFromUs(900)).toBe(0)
  })

  it('clamps above 2000 to 100', () => {
    expect(pctFromUs(2200)).toBe(100)
  })
})

describe('gpsFixTier', () => {
  it('no fix for 0/1', () => {
    expect(gpsFixTier(0)).toBe('none')
    expect(gpsFixTier(1)).toBe('none')
  })

  it('2d for fix_type 2', () => {
    expect(gpsFixTier(2)).toBe('2d')
  })

  it('3d for fix_type 3 and above (DGPS/RTK included)', () => {
    expect(gpsFixTier(3)).toBe('3d')
    expect(gpsFixTier(6)).toBe('3d')
  })
})

describe('isVoltageImplausible', () => {
  it('flags a near-zero voltage, e.g. an unconnected sense pin on USB/bench power', () => {
    expect(isVoltageImplausible(0.02)).toBe(true)
  })

  it('does not flag a real 1S pack even deeply sagged under load', () => {
    expect(isVoltageImplausible(3.0)).toBe(false)
    expect(isVoltageImplausible(3.2)).toBe(false)
  })

  it('does not flag a real 6S pack', () => {
    expect(isVoltageImplausible(22.2)).toBe(false)
  })

  it('does not flag a literal 0 V (a distinct "unpopulated" case, not a spurious low reading)', () => {
    expect(isVoltageImplausible(0)).toBe(false)
  })
})

describe('formatSignedDeg', () => {
  it('shows an explicit + sign for zero/positive, - for negative', () => {
    expect(formatSignedDeg(12.34)).toBe('+12.3°')
    expect(formatSignedDeg(0)).toBe('+0.0°')
    expect(formatSignedDeg(-4.5)).toBe('-4.5°')
  })
})

describe('normalizeHeadingDeg', () => {
  it('leaves an already-positive heading as-is', () => {
    expect(normalizeHeadingDeg(90)).toBe(90)
  })

  it('wraps a negative yaw into 0-360', () => {
    expect(normalizeHeadingDeg(-90)).toBe(270)
    expect(normalizeHeadingDeg(-1)).toBe(359)
  })
})

describe('SENSOR_TILES', () => {
  it('covers the six audit-D2 tiles in display order, with only IMU and Compass calibratable', () => {
    expect(SENSOR_TILES.map((t) => t.key)).toEqual(['imu', 'compass', 'baro', 'gps', 'optflow', 'rangefinder'])
    expect(SENSOR_TILES.filter((t) => t.calibratable).map((t) => t.key)).toEqual(['imu', 'compass'])
  })
})

describe('sensorTileStatus', () => {
  const COMPASS = 0x04
  const IMU = 0x01 | 0x02

  it('absent when the present bit is clear', () => {
    expect(sensorTileStatus({ present: 0, enabled: 0, health: 0 }, COMPASS)).toBe('absent')
  })

  it('disabled when present but not enabled (e.g. COMPASS_USE=0) — unused on purpose, but never claimed missing', () => {
    expect(sensorTileStatus({ present: COMPASS, enabled: 0, health: 0 }, COMPASS)).toBe('disabled')
  })

  it('ok when present, enabled, and healthy', () => {
    expect(sensorTileStatus({ present: COMPASS, enabled: COMPASS, health: COMPASS }, COMPASS)).toBe('ok')
  })

  it('attention when present and enabled but unhealthy', () => {
    expect(sensorTileStatus({ present: COMPASS, enabled: COMPASS, health: 0 }, COMPASS)).toBe('attention')
  })

  it('IMU (gyro|accel): attention if either active bit is unhealthy', () => {
    expect(sensorTileStatus({ present: IMU, enabled: IMU, health: 0x01 }, IMU)).toBe('attention')
  })

  it('IMU (gyro|accel): ok when only the gyro is active and healthy — inactive bits inside the mask are not held against it', () => {
    expect(sensorTileStatus({ present: 0x01, enabled: 0x01, health: 0x01 }, IMU)).toBe('ok')
  })
})
