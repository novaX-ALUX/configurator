/**
 * Initial-tune calculator (issue #35) — a verbatim port of Mission Planner's
 * built-in "Initial Parameter Setup" tab (`ConfigInitialParams.cs`,
 * `calc_values()`), the implementation the ArduPilot wiki blesses. Every
 * formula, constant, floor and cap here is cited line-by-line in
 * docs/notes/initial-tune-formulas.md (issue #34); outputs the official
 * sources do not define are omitted, never invented (PRD #32). Change the
 * note first, then this file.
 *
 * Rounding convention: S2 is C# `Math.Round` (banker's rounding, half to
 * even); this port uses JS `Math.round` (half up). The difference is only
 * reachable at exact midpoints, which real prop diameters do not hit (note
 * "Implementation notes"). `roundTo100` is S2's `RoundTo(value, -2)`: half-up
 * to the nearest 100, ported directly.
 */

export type Chemistry = 'lipo' | 'lipohv' | 'liion'

export interface InitialTuneInput {
  /** Propeller diameter in inches, > 0 (S2 L133 rejects <= 0). */
  prop: number
  /** Battery cell count, >= 1 (S2 L141–145). */
  cells: number
  chemistry: Chemistry
}

/** Chemistry → per-cell voltage pair, S2 L251–268 (note "Inputs" table). */
export const CHEMISTRY_CELL_VOLTS: Record<Chemistry, { cellMax: number; cellMin: number }> = {
  lipo: { cellMax: 4.2, cellMin: 3.3 },
  lipohv: { cellMax: 4.35, cellMin: 3.3 },
  liion: { cellMax: 4.1, cellMin: 2.8 },
}

/** S2's `RoundTo(value, -2)` (L74–86): add 50, truncate to 100 — half-up to the nearest 100. */
function roundTo100(value: number): number {
  const shifted = value + 50
  return shifted - (shifted % 100)
}

/** Suggested starting parameters, keyed by Copter 4.x parameter name (S2 `calc_values()` L89–121). */
export function computeInitialTune({ prop, cells, chemistry }: InitialTuneInput): Record<string, number> {
  if (!Number.isFinite(prop) || prop <= 0) throw new RangeError(`prop diameter must be a finite number > 0, got ${prop}`)
  if (!Number.isFinite(cells) || cells < 1) throw new RangeError(`battery cell count must be a finite number >= 1, got ${cells}`)
  const { cellMax, cellMin } = CHEMISTRY_CELL_VOLTS[chemistry]

  const accelYMax = Math.max(8000, roundTo100(-900 * prop + 36000)) // S2 L91
  const accelPMax = Math.max(10000, roundTo100(-2.613267 * prop ** 3 + 343.39216 * prop ** 2 - 15083.7121 * prop + 235771)) // S2 L95
  const gyroFilter = Math.max(20, Math.round(289.22 * prop ** -0.838)) // S2 L98
  const ratFlt = Math.max(10, gyroFilter / 2) // S2 L100–108 — unrounded on purpose, x.5 Hz is real

  return {
    ATC_ACCEL_Y_MAX: accelYMax,
    ACRO_YAW_P: (0.5 * accelYMax) / 4500, // S2 L93
    ATC_ACCEL_P_MAX: accelPMax,
    ATC_ACCEL_R_MAX: accelPMax, // S2 L96
    INS_GYRO_FILTER: gyroFilter,
    ATC_RAT_PIT_FLTD: ratFlt,
    ATC_RAT_PIT_FLTE: 0, // S2 L101
    ATC_RAT_PIT_FLTT: ratFlt,
    ATC_RAT_RLL_FLTD: ratFlt,
    ATC_RAT_RLL_FLTE: 0, // S2 L104
    ATC_RAT_RLL_FLTT: ratFlt,
    ATC_RAT_YAW_FLTD: 0, // S2 L106
    ATC_RAT_YAW_FLTE: 2, // S2 L107
    ATC_RAT_YAW_FLTT: ratFlt,
    ATC_THR_MIX_MAN: 0.1, // S2 L110
    INS_ACCEL_FILTER: 10, // S2 L111
    MOT_THST_EXPO: Math.min(Math.round((0.15686 * Math.log(prop) + 0.23693) * 100) / 100, 0.8), // S2 L112
    MOT_THST_HOVER: 0.2, // S2 L113
    BATT_ARM_VOLT: (cells - 1) * 0.1 + (cellMin + 0.3) * cells, // S2 L115
    BATT_CRT_VOLT: (cellMin + 0.2) * cells, // S2 L116
    BATT_LOW_VOLT: (cellMin + 0.3) * cells, // S2 L117
    MOT_BAT_VOLT_MAX: cellMax * cells, // S2 L118
    MOT_BAT_VOLT_MIN: cellMin * cells, // S2 L119
  }
}
