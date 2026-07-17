/**
 * Extended Tuning card composition (issue #35, ticket 1 of PRD #32): which
 * ArduPilot parameters each card shows, mirroring Mission Planner's
 * Extended Tuning groups so community tutorials map one-to-one (PRD user
 * story #1). Only the *names* live here — every range, step, unit and
 * display name comes from the bundled parameter metadata at render time
 * (PRD: zero hardcoded ranges in UI code). Ticket 2 (issue #32) adds the
 * AltHold/Loiter/WPNav cards and the Show Advanced toggle.
 */
export interface TuningSection {
  /** Optional axis heading inside a card (Roll / Pitch / Yaw). */
  labelKey?: string
  params: readonly string[]
}

export interface TuningCardDef {
  key: 'rate' | 'stabilize' | 'filters'
  titleKey: string
  sections: readonly TuningSection[]
}

export const TUNING_CARDS: readonly TuningCardDef[] = [
  {
    key: 'rate',
    titleKey: 'tuning.rate.title',
    sections: [
      { labelKey: 'tuning.axis.roll', params: ['ATC_RAT_RLL_P', 'ATC_RAT_RLL_I', 'ATC_RAT_RLL_D'] },
      { labelKey: 'tuning.axis.pitch', params: ['ATC_RAT_PIT_P', 'ATC_RAT_PIT_I', 'ATC_RAT_PIT_D'] },
      { labelKey: 'tuning.axis.yaw', params: ['ATC_RAT_YAW_P', 'ATC_RAT_YAW_I', 'ATC_RAT_YAW_D'] },
    ],
  },
  {
    key: 'stabilize',
    titleKey: 'tuning.stabilize.title',
    sections: [{ params: ['ATC_ANG_RLL_P', 'ATC_ANG_PIT_P', 'ATC_ANG_YAW_P'] }],
  },
  {
    key: 'filters',
    titleKey: 'tuning.filters.title',
    sections: [
      { params: ['INS_GYRO_FILTER', 'INS_ACCEL_FILTER'] },
      { labelKey: 'tuning.axis.roll', params: ['ATC_RAT_RLL_FLTD', 'ATC_RAT_RLL_FLTT'] },
      { labelKey: 'tuning.axis.pitch', params: ['ATC_RAT_PIT_FLTD', 'ATC_RAT_PIT_FLTT'] },
      { labelKey: 'tuning.axis.yaw', params: ['ATC_RAT_YAW_FLTE', 'ATC_RAT_YAW_FLTT'] },
    ],
  },
]

/**
 * Strips float32 read-back noise for display and for staged calculator
 * values (a board `0.135` decodes as `0.1350000023841858`): 6 significant
 * digits covers every tuning parameter's meaningful precision while staying
 * inside float32's ~7-digit limit, so the cleaned value quantizes to the
 * same float32 on the wire.
 */
export function cleanParamValue(value: number): number {
  return Number(value.toPrecision(6))
}

/**
 * Slider step when metadata carries a range but no `increment`: the largest
 * power of ten giving at least ~100 positions across the range (e.g.
 * `ATC_ANG_RLL_P`'s 3–12 → 0.01, `INS_GYRO_FILTER`'s 0–256 → 1). Derived,
 * not hardcoded per-param — the metadata stays the only per-param authority.
 */
export function sliderStep(range: readonly [number, number], increment: number | undefined): number {
  if (increment !== undefined && increment > 0) return increment
  const span = range[1] - range[0]
  if (span <= 0) return 1
  return 10 ** Math.floor(Math.log10(span / 100))
}
