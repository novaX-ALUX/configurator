import { describe, expect, it } from 'vitest'
import type { Param } from '../../../core/mavlink/params'
import {
  deriveGroup,
  fetchProgressPercent,
  filterParams,
  paginate,
  paramTypeLabel,
  topGroups,
  totalPages,
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
})

describe('topGroups', () => {
  it('counts params per group, sorted by count desc then alphabetically, capped to max', () => {
    const params = [
      param({ name: 'ATC_A' }),
      param({ name: 'ATC_B' }),
      param({ name: 'ATC_C' }),
      param({ name: 'BATT_A' }),
      param({ name: 'BATT_B' }),
      param({ name: 'COMPASS_A' }),
    ]
    expect(topGroups(params, 2)).toEqual([
      { group: 'ATC', count: 3 },
      { group: 'BATT', count: 2 },
    ])
  })

  it('breaks ties alphabetically for a stable order', () => {
    const params = [param({ name: 'BETA_X' }), param({ name: 'ALPHA_X' })]
    expect(topGroups(params)).toEqual([
      { group: 'ALPHA', count: 1 },
      { group: 'BETA', count: 1 },
    ])
  })
})

describe('filterParams', () => {
  const params = [
    param({ name: 'ATC_RAT_PIT_P' }),
    param({ name: 'ATC_RAT_YAW_P' }),
    param({ name: 'BATT_CAPACITY' }),
  ]

  it('matches name substrings case-insensitively', () => {
    expect(filterParams(params, 'rat_pit', null).map((p) => p.name)).toEqual(['ATC_RAT_PIT_P'])
    expect(filterParams(params, 'BATT', null).map((p) => p.name)).toEqual(['BATT_CAPACITY'])
  })

  it('filters by exact group when one is given', () => {
    expect(filterParams(params, '', 'ATC').map((p) => p.name)).toEqual(['ATC_RAT_PIT_P', 'ATC_RAT_YAW_P'])
  })

  it('ANDs the search query and the group filter', () => {
    expect(filterParams(params, 'yaw', 'ATC').map((p) => p.name)).toEqual(['ATC_RAT_YAW_P'])
    expect(filterParams(params, 'yaw', 'BATT')).toEqual([])
  })

  it('returns everything for an empty query and a null group', () => {
    expect(filterParams(params, '', null)).toHaveLength(3)
  })
})

describe('paginate / totalPages', () => {
  const items = Array.from({ length: 250 }, (_, i) => i)

  it('slices a 100-item window per page', () => {
    expect(paginate(items, 1, 100)).toEqual(items.slice(0, 100))
    expect(paginate(items, 2, 100)).toEqual(items.slice(100, 200))
    expect(paginate(items, 3, 100)).toEqual(items.slice(200, 250))
  })

  it('computes total pages, rounding up', () => {
    expect(totalPages(250, 100)).toBe(3)
    expect(totalPages(100, 100)).toBe(1)
    expect(totalPages(0, 100)).toBe(1)
  })

  it('clamps an out-of-range page instead of throwing or returning empty', () => {
    expect(paginate(items, 99, 100)).toEqual(items.slice(200, 250))
    expect(paginate(items, 0, 100)).toEqual(items.slice(0, 100))
  })
})
