import { describe, expect, it } from 'vitest'
import {
  BATT_FS_LOW_FIELD,
  BATT_MONITOR_FIELD,
  ESC_PROTOCOL_FIELD,
  FRAME_FIELD,
  FS_GCS_FIELD,
  FS_THROTTLE_FIELD,
  SETUP_FIELDS,
  type EnumFieldMeta,
} from '../paramEnums'

const LABEL_KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/

function values(field: EnumFieldMeta): number[] {
  return field.options.map((o) => o.value)
}

function labelKeys(field: EnumFieldMeta): string[] {
  return field.options.map((o) => o.labelKey)
}

describe('FRAME_FIELD', () => {
  it('stages both FRAME_CLASS and FRAME_TYPE, not just FRAME_TYPE', () => {
    // This is the exact bug the task brief called out: the design mock's
    // tile onClick only staged FRAME_TYPE.
    expect(FRAME_FIELD.params).toEqual(['FRAME_CLASS', 'FRAME_TYPE'])
  })

  it('gives each tile the correct ArduPilot FRAME_CLASS/FRAME_TYPE pair', () => {
    const byLabel = Object.fromEntries(
      FRAME_FIELD.options.map((o) => [o.labelKey, { frameClass: o.frameClass, frameType: o.frameType }])
    )
    expect(byLabel['setup.frame.options.quadX']).toEqual({ frameClass: 1, frameType: 1 })
    expect(byLabel['setup.frame.options.quadPlus']).toEqual({ frameClass: 1, frameType: 0 })
    expect(byLabel['setup.frame.options.hexX']).toEqual({ frameClass: 2, frameType: 1 })
    expect(byLabel['setup.frame.options.octoX']).toEqual({ frameClass: 3, frameType: 1 })
  })

  it('never assigns two tiles the same FRAME_CLASS/FRAME_TYPE pair', () => {
    const pairs = FRAME_FIELD.options.map((o) => `${o.frameClass}:${o.frameType}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('gives every tile a motor layout with at least one position and every coordinate in range', () => {
    for (const tile of FRAME_FIELD.options) {
      expect(tile.motors.length).toBeGreaterThan(0)
      for (const m of tile.motors) {
        expect(m.x).toBeGreaterThanOrEqual(0)
        expect(m.x).toBeLessThanOrEqual(100)
        expect(m.y).toBeGreaterThanOrEqual(0)
        expect(m.y).toBeLessThanOrEqual(100)
      }
    }
  })

  it('gives QUAD frames 4 motors, HEX 6, OCTO 8', () => {
    const byLabel = Object.fromEntries(FRAME_FIELD.options.map((o) => [o.labelKey, o.motors.length]))
    expect(byLabel['setup.frame.options.quadX']).toBe(4)
    expect(byLabel['setup.frame.options.quadPlus']).toBe(4)
    expect(byLabel['setup.frame.options.hexX']).toBe(6)
    expect(byLabel['setup.frame.options.octoX']).toBe(8)
  })
})

describe('ESC_PROTOCOL_FIELD (MOT_PWM_TYPE)', () => {
  it('uses the real ArduPilot MOT_PWM_TYPE integers, not the design mock\'s off-by-one DShot values', () => {
    // libraries/AP_Motors/AP_MotorsMulticopter.cpp @Values (stable
    // Copter-3.6.0 through master): 0:Normal,1:OneShot,2:OneShot125,
    // 3:Brushed,4:DShot150,5:DShot300,6:DShot600,7:DShot1200. The design
    // mock/brief had DShot300=6 and DShot600=7 (those are actually
    // DShot600 and DShot1200) — corrected here.
    const byLabel = Object.fromEntries(ESC_PROTOCOL_FIELD.options.map((o) => [o.labelKey, o.value]))
    expect(byLabel['setup.esc.options.pwm']).toBe(0)
    expect(byLabel['setup.esc.options.oneShot125']).toBe(2)
    expect(byLabel['setup.esc.options.dshot150']).toBe(4)
    expect(byLabel['setup.esc.options.dshot300']).toBe(5)
    expect(byLabel['setup.esc.options.dshot600']).toBe(6)
  })
})

describe('BATT_MONITOR_FIELD', () => {
  it('uses the documented BATT_MONITOR integers', () => {
    const byLabel = Object.fromEntries(BATT_MONITOR_FIELD.options.map((o) => [o.labelKey, o.value]))
    expect(byLabel['setup.battery.monitor.options.analogVoltageCurrent']).toBe(4)
    expect(byLabel['setup.battery.monitor.options.analogVoltageOnly']).toBe(3)
    expect(byLabel['setup.battery.monitor.options.disabled']).toBe(0)
  })
})

describe('FS_THROTTLE_FIELD (FS_THR_ENABLE)', () => {
  it('uses the documented FS_THR_ENABLE integers', () => {
    const byLabel = Object.fromEntries(FS_THROTTLE_FIELD.options.map((o) => [o.labelKey, o.value]))
    expect(byLabel['setup.failsafes.throttle.options.rtl']).toBe(1)
    expect(byLabel['setup.failsafes.throttle.options.continueAuto']).toBe(2)
    expect(byLabel['setup.failsafes.throttle.options.land']).toBe(3)
    expect(byLabel['setup.failsafes.throttle.options.disabled']).toBe(0)
  })

  it('flags only "Continue in Auto" (removed in ArduPilot 4.0+) as legacy -- not the other three, current options', () => {
    const legacyLabels = FS_THROTTLE_FIELD.options.filter((o) => o.legacy).map((o) => o.labelKey)
    expect(legacyLabels).toEqual(['setup.failsafes.throttle.options.continueAuto'])
  })
})

describe('BATT_FS_LOW_FIELD (BATT_FS_LOW_ACT)', () => {
  it('uses the real ArduPilot BATT_FS_LOW_ACT integer for "SmartRTL, else Land"', () => {
    // libraries/AP_BattMonitor/AP_BattMonitor_Params.cpp @Values{Copter}
    // (stable Copter-4.3.0 through master): 0:None,1:Land,2:RTL,
    // 3:SmartRTL or RTL,4:SmartRTL or Land. The design mock/brief labeled
    // value 3 "SmartRTL, else Land" — that's actually value 4; value 3 is
    // "SmartRTL or RTL". Corrected here.
    const byLabel = Object.fromEntries(BATT_FS_LOW_FIELD.options.map((o) => [o.labelKey, o.value]))
    expect(byLabel['setup.failsafes.battLow.options.land']).toBe(1)
    expect(byLabel['setup.failsafes.battLow.options.rtl']).toBe(2)
    expect(byLabel['setup.failsafes.battLow.options.smartRtlElseLand']).toBe(4)
    expect(byLabel['setup.failsafes.battLow.options.none']).toBe(0)
  })

  it('never uses value 3 (that integer means "SmartRTL or RTL" on the real firmware, not "SmartRTL, else Land")', () => {
    expect(values(BATT_FS_LOW_FIELD)).not.toContain(3)
  })

  it('never flags any option as legacy -- value 2 here is "RTL", a current, valid option, unlike the other two failsafe fields\' value 2 (calibration review finding)', () => {
    expect(BATT_FS_LOW_FIELD.options.some((o) => o.legacy)).toBe(false)
  })
})

describe('FS_GCS_FIELD (FS_GCS_ENABLE)', () => {
  it('uses the documented FS_GCS_ENABLE integers', () => {
    const byLabel = Object.fromEntries(FS_GCS_FIELD.options.map((o) => [o.labelKey, o.value]))
    expect(byLabel['setup.failsafes.gcs.options.rtl']).toBe(1)
    expect(byLabel['setup.failsafes.gcs.options.continueAuto']).toBe(2)
    expect(byLabel['setup.failsafes.gcs.options.disabled']).toBe(0)
  })

  it('flags only "Continue in Auto" (removed in ArduPilot 4.0+) as legacy', () => {
    const legacyLabels = FS_GCS_FIELD.options.filter((o) => o.legacy).map((o) => o.labelKey)
    expect(legacyLabels).toEqual(['setup.failsafes.gcs.options.continueAuto'])
  })
})

describe('data integrity across every enum field', () => {
  const enumFields = SETUP_FIELDS.filter(
    (f): f is EnumFieldMeta => f.controlType === 'enum-dropdown' || f.controlType === 'enum-chips'
  )

  it('never repeats a value within one field\'s own option list', () => {
    for (const field of enumFields) {
      const vs = values(field)
      expect(new Set(vs).size, `${field.id} has a duplicate value`).toBe(vs.length)
    }
  })

  it('never repeats a labelKey within one field\'s own option list', () => {
    for (const field of enumFields) {
      const ks = labelKeys(field)
      expect(new Set(ks).size, `${field.id} has a duplicate labelKey`).toBe(ks.length)
    }
  })

  it('gives every option a well-formed, non-empty labelKey', () => {
    for (const field of enumFields) {
      for (const opt of field.options) {
        expect(opt.labelKey).toMatch(LABEL_KEY_RE)
      }
    }
    for (const tile of FRAME_FIELD.options) {
      expect(tile.labelKey).toMatch(LABEL_KEY_RE)
    }
  })

  it('never reuses a labelKey across two different fields', () => {
    const allKeys = [
      ...FRAME_FIELD.options.map((o) => o.labelKey),
      ...enumFields.flatMap((f) => labelKeys(f)),
    ]
    expect(new Set(allKeys).size).toBe(allKeys.length)
  })

  it('every enum option value is a non-negative integer', () => {
    for (const field of enumFields) {
      for (const opt of field.options) {
        expect(Number.isInteger(opt.value)).toBe(true)
        expect(opt.value).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('SETUP_FIELDS', () => {
  it('includes exactly the 8 fields the Setup screen spec calls for, each with its ArduPilot param name(s)', () => {
    const paramsByField = SETUP_FIELDS.map((f) =>
      f.controlType === 'enum-tiles' ? f.params.join('+') : f.param
    )
    expect(paramsByField).toEqual([
      'FRAME_CLASS+FRAME_TYPE',
      'MOT_PWM_TYPE',
      'BATT_MONITOR',
      'BATT_CAPACITY',
      'BATT_LOW_VOLT',
      'FS_THR_ENABLE',
      'BATT_FS_LOW_ACT',
      'FS_GCS_ENABLE',
    ])
  })
})
