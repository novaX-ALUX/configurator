import { describe, expect, it } from 'vitest'
import { deriveStatusStrip, linkLossTier } from '../telemetryStripUtils'
import type { TelemetryState } from '../../core/mavlink/telemetry'
import type { StatusTextEntry } from '../../store/connection'
import type { MavRouterStats } from '../../core/mavlink/router'

const STATS: MavRouterStats = { framesIn: 0, framesOut: 0, decodeErrors: 0, signedDropped: 0, crcErrors: 0, badMsgId: 0, dropped: 0 }

function heartbeat(armed: boolean, customMode = 0): TelemetryState['heartbeat'] {
  return { armed, customMode, baseMode: armed ? 0x80 : 0, systemStatus: 4, ts: 0 }
}

describe('deriveStatusStrip', () => {
  it('renders everything unknown when no telemetry/statustext/linkStats exist yet', () => {
    const strip = deriveStatusStrip(null, [], null)
    expect(strip).toEqual({
      armed: undefined,
      modeLabel: undefined,
      prearm: undefined,
      voltage: undefined,
      current: undefined,
      gpsFix: undefined,
      gpsSatellites: undefined,
      linkLossPct: undefined,
    })
  })

  it('armed: prearm reads Ready regardless of any earlier PreArm complaints (a successful arm proves every check passed)', () => {
    const statustext: StatusTextEntry[] = [{ severity: 4, text: 'PreArm: Compass not calibrated', ts: 0 }]
    const strip = deriveStatusStrip({ heartbeat: heartbeat(true, 5) }, statustext, null)
    expect(strip.armed).toBe(true)
    expect(strip.modeLabel).toBe('LOITER')
    expect(strip.prearm).toEqual({ status: 'ready', count: 0 })
  })

  it('disarmed with no PreArm STATUSTEXT ever seen: reads unknown, not Ready (issue #19 — absence of PreArm messages is not evidence of readiness)', () => {
    const strip = deriveStatusStrip({ heartbeat: heartbeat(false) }, [], null)
    expect(strip.prearm).toEqual({ status: 'unknown', count: 0 })
  })

  it('disarmed with distinct PreArm failures: counts distinct message text, ignoring repeats and non-PreArm lines', () => {
    const statustext: StatusTextEntry[] = [
      { severity: 4, text: 'PreArm: Compass not calibrated', ts: 0 },
      { severity: 6, text: 'GPS 1: detected as u-blox', ts: 1 },
      { severity: 4, text: 'PreArm: Compass not calibrated', ts: 2 }, // repeat of the same check
      { severity: 4, text: 'PreArm: Waiting for GPS HDOP', ts: 3 },
      { severity: 4, text: 'prearm: case-insensitive prefix match', ts: 4 },
    ]
    const strip = deriveStatusStrip({ heartbeat: heartbeat(false) }, statustext, null)
    expect(strip.prearm).toEqual({ status: 'notReady', count: 3 })
  })

  it('re-disarming after a successful arm, with no new PreArm failure logged, reads unknown again — not a stale Ready (issue #19: a session-wide Ready must not survive on silence alone)', () => {
    const armed = deriveStatusStrip({ heartbeat: heartbeat(true, 5) }, [], null)
    expect(armed.prearm).toEqual({ status: 'ready', count: 0 })

    const disarmedAgain = deriveStatusStrip({ heartbeat: heartbeat(false, 5) }, [], null)
    expect(disarmedAgain.prearm).toEqual({ status: 'unknown', count: 0 })
  })

  it('no heartbeat yet: arm/mode/prearm are all unknown even if PreArm STATUSTEXT already arrived', () => {
    const statustext: StatusTextEntry[] = [{ severity: 4, text: 'PreArm: Compass not calibrated', ts: 0 }]
    const strip = deriveStatusStrip({}, statustext, null)
    expect(strip.armed).toBeUndefined()
    expect(strip.modeLabel).toBeUndefined()
    expect(strip.prearm).toBeUndefined()
  })

  it('power/gps blocks map straight through, honoring their own undefined sentinels', () => {
    const strip = deriveStatusStrip(
      { power: { voltage: 12.4, current: undefined, batteryRemaining: undefined, ts: 0 }, gps: { fixType: 3, satellites: 11, ts: 0 } },
      [],
      null,
    )
    expect(strip.voltage).toBe(12.4)
    expect(strip.current).toBeUndefined()
    expect(strip.gpsFix).toBe('3d')
    expect(strip.gpsSatellites).toBe(11)
  })

  it('link loss: 0% when no frames dropped yet', () => {
    const strip = deriveStatusStrip(null, [], { ...STATS, framesIn: 500, dropped: 0 })
    expect(strip.linkLossPct).toBe(0)
  })

  it('link loss: percent of dropped candidate frames over the session total', () => {
    const strip = deriveStatusStrip(null, [], { ...STATS, framesIn: 95, dropped: 5 })
    expect(strip.linkLossPct).toBe(5)
  })

  it('link loss: undefined before any linkStats snapshot exists (not the same as 0% loss)', () => {
    const strip = deriveStatusStrip(null, [], null)
    expect(strip.linkLossPct).toBeUndefined()
  })
})

describe('linkLossTier', () => {
  it('exactly 0% is good (no dropped frames)', () => {
    expect(linkLossTier(0)).toBe('good')
  })

  it('above 0% and up to 2% is degraded', () => {
    expect(linkLossTier(0.1)).toBe('degraded')
    expect(linkLossTier(2)).toBe('degraded')
  })

  it('above 2% is bad', () => {
    expect(linkLossTier(2.1)).toBe('bad')
    expect(linkLossTier(50)).toBe('bad')
  })
})
