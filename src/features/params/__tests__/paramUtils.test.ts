import { describe, expect, it } from 'vitest'
import type { Param } from '../../../core/mavlink/params'
import type { ParamMetaEntry } from '../../../core/paramMetadata'
import {
  batchNeedsReboot,
  deriveGroup,
  fetchProgressPercent,
  filterParams,
  groupParams,
  isEnumValue,
  isNotDefault,
  paramTypeLabel,
  rangeUnitsCaption,
  wouldLosePrecision,
} from '../paramUtils'

function param(overrides: Partial<Param> = {}): Param {
  return { name: 'THR_MIN', value: 0, type: 9, index: 0, ...overrides }
}

describe('paramTypeLabel', () => {
  it('labels the known MAV_PARAM_TYPE values', () => {
    expect(paramTypeLabel(6)).toBe('INT32')
    expect(paramTypeLabel(9)).toBe('REAL32')
    expect(paramTypeLabel(10)).toBe('REAL64')
  })

  it('falls back to a TYPE_n label for an unknown type', () => {
    expect(paramTypeLabel(99)).toBe('TYPE_99')
  })
})

describe('wouldLosePrecision', () => {
  it('rejects an integer-type value too large for exact float32 representation', () => {
    expect(wouldLosePrecision(6, 16777217)).toBe(true) // 2^24 + 1
  })

  it('accepts an integer-type value within float32-exact range', () => {
    expect(wouldLosePrecision(6, 115200)).toBe(false)
  })

  it('never flags a REAL32/REAL64 value, however precise', () => {
    expect(wouldLosePrecision(9, 0.123456789)).toBe(false)
    expect(wouldLosePrecision(10, 16777217)).toBe(false)
  })
})

describe('fetchProgressPercent', () => {
  it('is undefined while total is unknown (before the stream names param_count)', () => {
    expect(fetchProgressPercent(0, undefined)).toBeUndefined()
  })

  it('rounds got/total to an integer percent', () => {
    expect(fetchProgressPercent(1, 3)).toBe(33)
    expect(fetchProgressPercent(638, 1277)).toBe(50)
    expect(fetchProgressPercent(0, 1277)).toBe(0)
    expect(fetchProgressPercent(1277, 1277)).toBe(100)
  })

  it('clamps to 100 rather than overshooting on a stray arrival past total', () => {
    expect(fetchProgressPercent(1278, 1277)).toBe(100)
  })

  it('is undefined for a nonsensical zero/negative total rather than dividing by zero', () => {
    expect(fetchProgressPercent(0, 0)).toBeUndefined()
  })
})

describe('deriveGroup', () => {
  it('takes the first underscore-delimited segment', () => {
    expect(deriveGroup('ATC_RAT_PIT_P')).toBe('ATC')
    expect(deriveGroup('COMPASS_OFS_X')).toBe('COMPASS')
  })

  it('falls back to the whole name when there is no underscore', () => {
    expect(deriveGroup('SINGLETON')).toBe('SINGLETON')
  })

  it('falls back to the whole name for a leading underscore, instead of an empty-string group', () => {
    expect(deriveGroup('_FOO_BAR')).toBe('_FOO_BAR')
  })

  it('folds a numbered instance prefix into its base family (issue #22)', () => {
    expect(deriveGroup('BATT2_CAPACITY')).toBe('BATT')
    expect(deriveGroup('BATT9_MONITOR')).toBe('BATT')
    expect(deriveGroup('BARO1_GND_PRESS')).toBe('BARO')
    expect(deriveGroup('CAM1_TYPE')).toBe('CAM')
    expect(deriveGroup('FILT8_TYPE')).toBe('FILT')
    expect(deriveGroup('GPS2_TYPE')).toBe('GPS')
    expect(deriveGroup('SERVO16_FUNCTION')).toBe('SERVO')
  })

  it('folds a numbered whole-name fallback too (FLTMODE1 has no underscore)', () => {
    expect(deriveGroup('FLTMODE1')).toBe('FLTMODE')
    expect(deriveGroup('FLTMODE6')).toBe('FLTMODE')
  })

  it('keeps EK2/EK3 apart — the digit names a distinct EKF implementation, not an instance', () => {
    expect(deriveGroup('EK2_ENABLE')).toBe('EK2')
    expect(deriveGroup('EK3_SRC1_POSXY')).toBe('EK3')
  })

  it('never strips down to an empty group name', () => {
    expect(deriveGroup('123')).toBe('123')
  })
})

describe('groupParams', () => {
  it('buckets every param by deriveGroup, alphabetically sorted, with no cap', () => {
    const params = [
      param({ name: 'COMPASS_A' }),
      param({ name: 'ATC_A' }),
      param({ name: 'ATC_B' }),
      param({ name: 'BATT_A' }),
    ]
    expect(groupParams(params).map((g) => [g.group, g.items.map((p) => p.name)])).toEqual([
      ['ATC', ['ATC_A', 'ATC_B']],
      ['BATT', ['BATT_A']],
      ['COMPASS', ['COMPASS_A']],
    ])
  })

  it('includes every group present, however many — no top-N cap (PA2 deleted the chip row/GROUP_CHIP_MAX)', () => {
    const params = Array.from({ length: 30 }, (_, i) => param({ name: `G${i}A_X` }))
    expect(groupParams(params)).toHaveLength(30)
  })

  it('merges numbered instances into the base family bucket (issue #22)', () => {
    const params = [param({ name: 'BATT_MONITOR' }), param({ name: 'BATT2_MONITOR' }), param({ name: 'FLTMODE1' }), param({ name: 'FLTMODE_CH' })]
    expect(groupParams(params).map((g) => [g.group, g.items.map((p) => p.name)])).toEqual([
      ['BATT', ['BATT_MONITOR', 'BATT2_MONITOR']],
      ['FLTMODE', ['FLTMODE1', 'FLTMODE_CH']],
    ])
  })

  it('returns nothing for an empty input, e.g. a search with zero matches', () => {
    expect(groupParams([])).toEqual([])
  })
})

describe('filterParams', () => {
  const params = [
    param({ name: 'ATC_RAT_PIT_P' }),
    param({ name: 'ATC_RAT_YAW_P' }),
    param({ name: 'BATT_CAPACITY' }),
  ]

  it('matches name substrings case-insensitively', () => {
    expect(filterParams(params, 'rat_pit').map((p) => p.name)).toEqual(['ATC_RAT_PIT_P'])
    expect(filterParams(params, 'BATT').map((p) => p.name)).toEqual(['BATT_CAPACITY'])
  })

  it('returns everything unchanged for an empty query', () => {
    expect(filterParams(params, '')).toHaveLength(3)
  })

  it('also matches the metadata display name, case-insensitively, when a lookup is given', () => {
    const meta = new Map<string, ParamMetaEntry>([['BATT_CAPACITY', { displayName: 'Battery capacity', description: 'x' }]])
    const lookup = (name: string) => meta.get(name)
    expect(filterParams(params, 'capacity', lookup).map((p) => p.name)).toEqual(['BATT_CAPACITY'])
  })

  it('never matches the description, only the display name', () => {
    const meta = new Map<string, ParamMetaEntry>([['BATT_CAPACITY', { displayName: 'Battery capacity', description: 'mAh rating for the fuel gauge' }]])
    const lookup = (name: string) => meta.get(name)
    expect(filterParams(params, 'fuel gauge', lookup)).toEqual([])
  })

  it('falls back to name-only matching when no lookup is given (metadata never loaded)', () => {
    expect(filterParams(params, 'capacity').map((p) => p.name)).toEqual(['BATT_CAPACITY'])
  })

  // PRD #12 §2.4 (issue #15): "Not Default" is a third predicate alongside
  // query/display-name search, not a separate filter pipeline — a row must
  // pass both to appear.
  describe('notDefaultOnly (issue #15)', () => {
    const withDefaults = [
      param({ name: 'ATC_RAT_PIT_P', value: 0.5 }), // differs from its bundled default (0.15) below
      param({ name: 'ATC_RAT_YAW_P', value: 0.18 }), // matches its bundled default
      param({ name: 'BATT_CAPACITY', value: 999 }), // no bundled default at all
    ]
    const defaultsByName: Record<string, number> = { ATC_RAT_PIT_P: 0.15, ATC_RAT_YAW_P: 0.18 }
    const lookupDefault = (name: string) => defaultsByName[name]

    it('keeps only rows whose live value differs from its bundled default', () => {
      expect(filterParams(withDefaults, '', undefined, true, lookupDefault).map((p) => p.name)).toEqual(['ATC_RAT_PIT_P'])
    })

    it('excludes a param with no bundled default from the positive set — never guessed', () => {
      const result = filterParams(withDefaults, '', undefined, true, lookupDefault)
      expect(result.map((p) => p.name)).not.toContain('BATT_CAPACITY')
    })

    it('combines with a non-empty search query — a row must match both predicates', () => {
      const result = filterParams(withDefaults, 'atc', undefined, true, lookupDefault)
      expect(result.map((p) => p.name)).toEqual(['ATC_RAT_PIT_P'])
    })

    it('is a no-op (matches filterParams(params, query)) when notDefaultOnly is false or omitted', () => {
      expect(filterParams(withDefaults, '', undefined, false, lookupDefault)).toHaveLength(3)
      expect(filterParams(withDefaults, '')).toHaveLength(3)
    })

    it('returns nothing when notDefaultOnly is set but no lookupDefault is given (defaults never loaded)', () => {
      expect(filterParams(withDefaults, '', undefined, true)).toEqual([])
    })
  })
})

describe('isNotDefault', () => {
  it('false when the value equals the bundled default', () => {
    expect(isNotDefault(0.3, 0.3)).toBe(false)
  })

  it('true when the value differs from the bundled default', () => {
    expect(isNotDefault(0.5, 0.3)).toBe(true)
  })

  it('false when there is no bundled default at all — never guessed (PRD #12 §2.4)', () => {
    expect(isNotDefault(0.5, undefined)).toBe(false)
  })

  it('is float32-tolerant at the fround boundary: a float64 literal and its float32 wire-rounded neighbor compare equal', () => {
    // 0.1 has no exact float32 representation; a value that round-tripped
    // through the wire as float32 comes back as the nearest float32 neighbor
    // of 0.1, not the float64 literal 0.1 itself. A strict `!==` would
    // false-flag this as "changed" even though neither side was ever
    // actually touched.
    const wireRoundedValue = Math.fround(0.1)
    expect(wireRoundedValue).not.toBe(0.1) // the boundary this test exists to cover
    expect(isNotDefault(wireRoundedValue, 0.1)).toBe(false)
  })

  it('still detects a real difference smaller than float64 noise but larger than float32 precision', () => {
    expect(isNotDefault(0.30001, 0.3)).toBe(true)
  })
})

describe('isEnumValue', () => {
  const enumMeta: ParamMetaEntry = {
    displayName: 'Auto rotate',
    description: 'x',
    values: [
      { value: 0, label: 'Disabled' },
      { value: 1, label: 'Enabled' },
    ],
  }

  it('is true when the value is one of meta.values\' listed options', () => {
    expect(isEnumValue(enumMeta, 0)).toBe(true)
    expect(isEnumValue(enumMeta, 1)).toBe(true)
  })

  it('is false for an out-of-spec value not in the list — never hides the real value behind a dropdown', () => {
    expect(isEnumValue(enumMeta, 2)).toBe(false)
  })

  it('is false when there is no metadata, or metadata has no values (a plain scalar param)', () => {
    expect(isEnumValue(undefined, 0)).toBe(false)
    expect(isEnumValue({ displayName: 'x', description: 'y' }, 0)).toBe(false)
  })
})

describe('rangeUnitsCaption', () => {
  it('combines range and units when both are present', () => {
    expect(rangeUnitsCaption({ displayName: 'x', description: 'y', range: [0, 100], units: '%' })).toBe('0–100 %')
  })

  it('renders range alone when there are no units', () => {
    expect(rangeUnitsCaption({ displayName: 'x', description: 'y', range: [0, 100] })).toBe('0–100')
  })

  it('renders units alone when there is no range', () => {
    expect(rangeUnitsCaption({ displayName: 'x', description: 'y', units: 'deg' })).toBe('deg')
  })

  it('is undefined when there is neither, or no metadata at all', () => {
    expect(rangeUnitsCaption({ displayName: 'x', description: 'y' })).toBeUndefined()
    expect(rangeUnitsCaption(undefined)).toBeUndefined()
  })
})

describe('batchNeedsReboot', () => {
  const table: Record<string, ParamMetaEntry> = {
    RC_OPTIONS: { displayName: 'x', description: 'y', rebootRequired: true },
    THR_MIN: { displayName: 'x', description: 'y' },
  }
  const lookup = (name: string): ParamMetaEntry | undefined => table[name]

  it('true when any written name has rebootRequired', () => {
    expect(batchNeedsReboot(['THR_MIN', 'RC_OPTIONS'], lookup)).toBe(true)
  })

  it('false when no written name has rebootRequired', () => {
    expect(batchNeedsReboot(['THR_MIN'], lookup)).toBe(false)
  })

  it('false for an empty batch', () => {
    expect(batchNeedsReboot([], lookup)).toBe(false)
  })

  it('false when metadata never loaded (no lookupMeta given) -- additive-fallback, not a guess', () => {
    expect(batchNeedsReboot(['RC_OPTIONS'])).toBe(false)
  })

  it('false for a name with no metadata match', () => {
    expect(batchNeedsReboot(['UNKNOWN_PARAM'], lookup)).toBe(false)
  })
})
