/**
 * Extended Tuning card composition (issues #35/#36, tickets 1–2 of PRD
 * #32): which ArduPilot parameters each card shows, mirroring Mission
 * Planner's Extended Tuning groups so community tutorials map one-to-one
 * (PRD user story #1). Only the *names* live here — every range, step,
 * unit and display name comes from the bundled parameter metadata at
 * render time (PRD: zero hardcoded ranges in UI code). `advancedParams`
 * carries the Show Advanced surface (PRD story #6): hidden until toggled,
 * appended after the basic params of the same section, bringing the six
 * groups to the full Mico-parity ~100-parameter block.
 */
export interface TuningSection {
  /** Optional axis/subgroup heading inside a card (Roll / Throttle Accel / ...). */
  labelKey?: string
  params: readonly string[]
  /** Shown only while Show Advanced is on, after `params`. A section with an empty `params` is entirely advanced — its heading hides with it. */
  advancedParams?: readonly string[]
}

export interface TuningCardDef {
  key: 'rate' | 'stabilize' | 'althold' | 'loiter' | 'wpnav' | 'filters'
  titleKey: string
  sections: readonly TuningSection[]
}

export const TUNING_CARDS: readonly TuningCardDef[] = [
  {
    key: 'rate',
    titleKey: 'tuning.rate.title',
    sections: [
      {
        labelKey: 'tuning.axis.roll',
        params: ['ATC_RAT_RLL_P', 'ATC_RAT_RLL_I', 'ATC_RAT_RLL_D'],
        advancedParams: ['ATC_RAT_RLL_IMAX', 'ATC_RAT_RLL_FF', 'ATC_RAT_RLL_ILMI', 'ATC_RAT_RLL_SMAX', 'ATC_RAT_RLL_PDMX'],
      },
      {
        labelKey: 'tuning.axis.pitch',
        params: ['ATC_RAT_PIT_P', 'ATC_RAT_PIT_I', 'ATC_RAT_PIT_D'],
        advancedParams: ['ATC_RAT_PIT_IMAX', 'ATC_RAT_PIT_FF', 'ATC_RAT_PIT_ILMI', 'ATC_RAT_PIT_SMAX', 'ATC_RAT_PIT_PDMX'],
      },
      {
        labelKey: 'tuning.axis.yaw',
        params: ['ATC_RAT_YAW_P', 'ATC_RAT_YAW_I', 'ATC_RAT_YAW_D'],
        advancedParams: ['ATC_RAT_YAW_IMAX', 'ATC_RAT_YAW_FF', 'ATC_RAT_YAW_ILMI', 'ATC_RAT_YAW_SMAX', 'ATC_RAT_YAW_PDMX'],
      },
    ],
  },
  {
    key: 'stabilize',
    titleKey: 'tuning.stabilize.title',
    sections: [
      {
        params: ['ATC_ANG_RLL_P', 'ATC_ANG_PIT_P', 'ATC_ANG_YAW_P'],
        advancedParams: ['ATC_INPUT_TC', 'ATC_SLEW_YAW', 'ANGLE_MAX', 'ATC_ANG_LIM_TC'],
      },
      {
        labelKey: 'tuning.stabilize.limits',
        params: [],
        advancedParams: ['ATC_ACCEL_R_MAX', 'ATC_ACCEL_P_MAX', 'ATC_ACCEL_Y_MAX', 'ATC_RATE_R_MAX', 'ATC_RATE_P_MAX', 'ATC_RATE_Y_MAX'],
      },
    ],
  },
  {
    key: 'althold',
    titleKey: 'tuning.althold.title',
    sections: [
      { params: ['PSC_POSZ_P'] },
      {
        labelKey: 'tuning.althold.velz',
        params: ['PSC_VELZ_P'],
        advancedParams: ['PSC_VELZ_I', 'PSC_VELZ_D', 'PSC_VELZ_IMAX', 'PSC_VELZ_FF', 'PSC_VELZ_FLTD', 'PSC_VELZ_FLTE'],
      },
      {
        labelKey: 'tuning.althold.accz',
        params: ['PSC_ACCZ_P', 'PSC_ACCZ_I', 'PSC_ACCZ_D'],
        advancedParams: ['PSC_ACCZ_IMAX', 'PSC_ACCZ_FLTD', 'PSC_ACCZ_FLTE', 'PSC_ACCZ_FLTT'],
      },
      {
        labelKey: 'tuning.althold.pilot',
        params: [],
        advancedParams: ['PILOT_SPEED_UP', 'PILOT_SPEED_DN', 'PILOT_ACCEL_Z', 'PILOT_TKOFF_ALT'],
      },
    ],
  },
  {
    key: 'loiter',
    titleKey: 'tuning.loiter.title',
    sections: [
      {
        params: ['LOIT_SPEED'],
        advancedParams: ['LOIT_ACC_MAX', 'LOIT_ANG_MAX', 'LOIT_BRK_ACCEL', 'LOIT_BRK_DELAY', 'LOIT_BRK_JERK'],
      },
      { labelKey: 'tuning.loiter.posxy', params: ['PSC_POSXY_P'] },
      {
        labelKey: 'tuning.loiter.velxy',
        params: ['PSC_VELXY_P', 'PSC_VELXY_I'],
        advancedParams: ['PSC_VELXY_D', 'PSC_VELXY_IMAX', 'PSC_VELXY_FF', 'PSC_VELXY_FLTD', 'PSC_VELXY_FLTE'],
      },
      {
        labelKey: 'tuning.loiter.shaping',
        params: [],
        advancedParams: ['PSC_JERK_XY', 'PSC_ACC_XY_FILT', 'PSC_ANGLE_MAX'],
      },
    ],
  },
  {
    key: 'wpnav',
    titleKey: 'tuning.wpnav.title',
    sections: [
      {
        params: ['WPNAV_SPEED', 'WPNAV_RADIUS', 'WPNAV_SPEED_UP', 'WPNAV_SPEED_DN'],
        advancedParams: ['WPNAV_ACCEL', 'WPNAV_ACCEL_Z', 'WPNAV_JERK'],
      },
    ],
  },
  {
    key: 'filters',
    titleKey: 'tuning.filters.title',
    sections: [
      { params: ['INS_GYRO_FILTER', 'INS_ACCEL_FILTER'] },
      {
        labelKey: 'tuning.axis.roll',
        params: ['ATC_RAT_RLL_FLTD', 'ATC_RAT_RLL_FLTT'],
        advancedParams: ['ATC_RAT_RLL_FLTE', 'ATC_RAT_RLL_NTF', 'ATC_RAT_RLL_NEF'],
      },
      {
        labelKey: 'tuning.axis.pitch',
        params: ['ATC_RAT_PIT_FLTD', 'ATC_RAT_PIT_FLTT'],
        advancedParams: ['ATC_RAT_PIT_FLTE', 'ATC_RAT_PIT_NTF', 'ATC_RAT_PIT_NEF'],
      },
      {
        labelKey: 'tuning.axis.yaw',
        params: ['ATC_RAT_YAW_FLTE', 'ATC_RAT_YAW_FLTT'],
        advancedParams: ['ATC_RAT_YAW_FLTD', 'ATC_RAT_YAW_NTF', 'ATC_RAT_YAW_NEF'],
      },
    ],
  },
]

/** Transmitter tuning knob params (PRD #32 story 10, ADR-0002: bench-side configuration only — in-flight use happens on the radio). `TUNE` is enum-valued (metadata `values`); the min/max pair is free-numeric (no documented range). */
export const TUNE_PARAM = 'TUNE'
export const TUNE_RANGE_PARAMS = ['TUNE_MIN', 'TUNE_MAX'] as const

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
