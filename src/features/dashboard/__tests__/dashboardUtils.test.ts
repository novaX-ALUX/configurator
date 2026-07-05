import { describe, expect, it } from 'vitest'
import { arduCopterModeName, formatSignedDeg, gpsFixTier, normalizeHeadingDeg, pctFromUs } from '../dashboardUtils'

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
