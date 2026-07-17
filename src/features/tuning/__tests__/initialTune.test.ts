import { describe, expect, it } from 'vitest'
import { computeInitialTune, type InitialTuneInput } from '../initialTune'

/**
 * Table-driven golden vectors transcribed verbatim from
 * docs/notes/initial-tune-formulas.md (issue #34) — "Golden test vectors",
 * computed by executing Mission Planner's S2 `calc_values()` formulas. Do
 * not edit expected values here without editing the research note; the
 * note, not this file, is the formula authority (PRD #32: official
 * formulas only, outputs the sources do not define are omitted).
 */

/** Constants for every golden case (note L139–141). */
const CONSTANTS = {
  ATC_RAT_PIT_FLTE: 0,
  ATC_RAT_RLL_FLTE: 0,
  ATC_RAT_YAW_FLTD: 0,
  ATC_RAT_YAW_FLTE: 2,
  ATC_THR_MIX_MAN: 0.1,
  INS_ACCEL_FILTER: 10,
  MOT_THST_HOVER: 0.2,
}

interface GoldenCase {
  title: string
  input: InitialTuneInput
  accelYMax: number
  acroYawP: number
  accelPRMax: number
  gyroFilter: number
  /** ATC_RAT_{PIT,RLL}_FLTD/FLTT and ATC_RAT_YAW_FLTT — one shared value per the note's row. */
  ratFlt: number
  thstExpo: number
  battArm: number
  battCrt: number
  battLow: number
  voltMax: number
  voltMin: number
}

const GOLDEN: GoldenCase[] = [
  { title: '5" 4S LiPo', input: { prop: 5, cells: 4, chemistry: 'lipo' }, accelYMax: 31500, acroYawP: 3.5, accelPRMax: 168600, gyroFilter: 75, ratFlt: 37.5, thstExpo: 0.49, battArm: 14.7, battCrt: 14.0, battLow: 14.4, voltMax: 16.8, voltMin: 13.2 },
  { title: '9" 4S LiPo (MP defaults)', input: { prop: 9, cells: 4, chemistry: 'lipo' }, accelYMax: 27900, acroYawP: 3.1, accelPRMax: 125900, gyroFilter: 46, ratFlt: 23, thstExpo: 0.58, battArm: 14.7, battCrt: 14.0, battLow: 14.4, voltMax: 16.8, voltMin: 13.2 },
  { title: '10" 6S LiPo', input: { prop: 10, cells: 6, chemistry: 'lipo' }, accelYMax: 27000, acroYawP: 3.0, accelPRMax: 116700, gyroFilter: 42, ratFlt: 21, thstExpo: 0.6, battArm: 22.1, battCrt: 21.0, battLow: 21.6, voltMax: 25.2, voltMin: 19.8 },
  { title: '13" 6S Li-ion', input: { prop: 13, cells: 6, chemistry: 'liion' }, accelYMax: 24300, acroYawP: 2.7, accelPRMax: 92000, gyroFilter: 34, ratFlt: 17, thstExpo: 0.64, battArm: 19.1, battCrt: 18.0, battLow: 18.6, voltMax: 24.6, voltMin: 16.8 },
  { title: '20" 12S LiPo', input: { prop: 20, cells: 12, chemistry: 'lipo' }, accelYMax: 18000, acroYawP: 2.0, accelPRMax: 50500, gyroFilter: 23, ratFlt: 11.5, thstExpo: 0.71, battArm: 44.3, battCrt: 42.0, battLow: 43.2, voltMax: 50.4, voltMin: 39.6 },
  { title: '30" 12S LiPo', input: { prop: 30, cells: 12, chemistry: 'lipo' }, accelYMax: 9000, acroYawP: 1.0, accelPRMax: 21800, gyroFilter: 20, ratFlt: 10, thstExpo: 0.77, battArm: 44.3, battCrt: 42.0, battLow: 43.2, voltMax: 50.4, voltMin: 39.6 },
]

function expectedMap(c: GoldenCase): Record<string, number> {
  return {
    ATC_ACCEL_Y_MAX: c.accelYMax,
    ACRO_YAW_P: c.acroYawP,
    ATC_ACCEL_P_MAX: c.accelPRMax,
    ATC_ACCEL_R_MAX: c.accelPRMax,
    INS_GYRO_FILTER: c.gyroFilter,
    ATC_RAT_PIT_FLTD: c.ratFlt,
    ATC_RAT_PIT_FLTT: c.ratFlt,
    ATC_RAT_RLL_FLTD: c.ratFlt,
    ATC_RAT_RLL_FLTT: c.ratFlt,
    ATC_RAT_YAW_FLTT: c.ratFlt,
    MOT_THST_EXPO: c.thstExpo,
    BATT_ARM_VOLT: c.battArm,
    BATT_CRT_VOLT: c.battCrt,
    BATT_LOW_VOLT: c.battLow,
    MOT_BAT_VOLT_MAX: c.voltMax,
    MOT_BAT_VOLT_MIN: c.voltMin,
    ...CONSTANTS,
  }
}

describe('computeInitialTune — golden vectors from the #34 research note', () => {
  it.each(GOLDEN)('$title', (c) => {
    const out = computeInitialTune(c.input)
    const expected = expectedMap(c)
    expect(Object.keys(out).sort()).toEqual(Object.keys(expected).sort())
    for (const [param, value] of Object.entries(expected)) {
      // Voltage outputs carry binary-float residue from `(cells − 1)·0.1`
      // etc.; the note's table is printed to 0.1 V. Everything else is exact.
      expect(out[param], param).toBeCloseTo(value, 9)
    }
  })
})

describe('computeInitialTune — documented floors and cap (note L155–156)', () => {
  // Derived by executing the S2 formulas at prop = 40 (not a cited vector):
  // Y_MAX polynomial hits 0 → floor 8000; gyro fit gives 13 → floor 20; the
  // FLT outputs sit on their 10 Hz floor; expo rounds to 0.82 → capped 0.80.
  it('40" prop lands on the 8000 / 20 / 10 floors and the 0.80 expo cap', () => {
    const out = computeInitialTune({ prop: 40, cells: 12, chemistry: 'lipo' })
    expect(out.ATC_ACCEL_Y_MAX).toBe(8000)
    expect(out.INS_GYRO_FILTER).toBe(20)
    expect(out.ATC_RAT_PIT_FLTD).toBe(10)
    expect(out.ATC_RAT_YAW_FLTT).toBe(10)
    expect(out.MOT_THST_EXPO).toBe(0.8)
  })
})

describe('computeInitialTune — input domain (S2 L133–145)', () => {
  it.each([
    { title: 'prop 0', input: { prop: 0, cells: 4, chemistry: 'lipo' } as InitialTuneInput },
    { title: 'negative prop', input: { prop: -5, cells: 4, chemistry: 'lipo' } as InitialTuneInput },
    { title: 'cells 0', input: { prop: 9, cells: 0, chemistry: 'lipo' } as InitialTuneInput },
    { title: 'non-finite prop', input: { prop: Number.NaN, cells: 4, chemistry: 'lipo' } as InitialTuneInput },
    { title: 'non-finite cells', input: { prop: 9, cells: Number.POSITIVE_INFINITY, chemistry: 'lipo' } as InitialTuneInput },
  ])('rejects $title', ({ input }) => {
    expect(() => computeInitialTune(input)).toThrow(RangeError)
  })

  it('accepts the LiPoHV chemistry (cellMax 4.35 / cellMin 3.3)', () => {
    const out = computeInitialTune({ prop: 9, cells: 4, chemistry: 'lipohv' })
    expect(out.MOT_BAT_VOLT_MAX).toBeCloseTo(17.4, 9)
    expect(out.MOT_BAT_VOLT_MIN).toBeCloseTo(13.2, 9)
    expect(out.BATT_ARM_VOLT).toBeCloseTo(14.7, 9)
  })
})
