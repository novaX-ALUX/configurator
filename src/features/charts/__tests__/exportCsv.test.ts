import { describe, expect, it } from 'vitest'
import { buildSamplesCsv, csvFilename } from '../exportCsv'

describe('buildSamplesCsv', () => {
  it('header names each Series with its unit; rows are the union of real receive timestamps, ascending, as time_iso + time_ms', () => {
    const csv = buildSamplesCsv([
      { label: 'Roll', unit: 'deg', samples: [{ ts: 1000, value: 10 }, { ts: 1100, value: 11 }] },
      { label: 'Voltage', unit: 'V', samples: [{ ts: 1050, value: 12.61 }] },
    ])

    expect(csv.split('\r\n')).toEqual([
      'time_iso,time_ms,Roll (deg),Voltage (V)',
      '1970-01-01T00:00:01.000Z,1000,10,',
      '1970-01-01T00:00:01.050Z,1050,,12.61',
      '1970-01-01T00:00:01.100Z,1100,11,',
      '',
    ])
  })

  it('never fabricates: a Series absent at a timestamp is an empty cell, a recorded null gap is an empty cell — neither is ever 0, and no timestamp appears that no Sample carries', () => {
    const csv = buildSamplesCsv([
      { label: 'Yaw', unit: 'deg', samples: [{ ts: 1000, value: 90 }, { ts: 1100, value: null }, { ts: 1200, value: 92 }] },
      { label: 'CH3', unit: 'µs', samples: [{ ts: 1050, value: 1500 }] },
    ])
    const rows = csv.trimEnd().split('\r\n').slice(1)

    // exactly the four real timestamps, nothing resampled in between
    expect(rows.map((r) => r.split(',')[1])).toEqual(['1000', '1050', '1100', '1200'])
    // the null gap row: both value cells empty (yaw's gap, ch3 absent)
    expect(rows[2]).toBe('1970-01-01T00:00:01.100Z,1100,,')
    expect(csv).not.toMatch(/,0\r\n/)
  })

  it('values are written exactly as recorded, not display-rounded', () => {
    const csv = buildSamplesCsv([{ label: 'Roll', unit: 'deg', samples: [{ ts: 1000, value: 12.345678 }] }])
    expect(csv).toContain(',12.345678')
  })

  it('Series sharing one Block share rows: equal timestamps collapse to one row', () => {
    const csv = buildSamplesCsv([
      { label: 'Roll', unit: 'deg', samples: [{ ts: 1000, value: 10 }] },
      { label: 'Pitch', unit: 'deg', samples: [{ ts: 1000, value: -5 }] },
    ])
    expect(csv.trimEnd().split('\r\n')).toEqual(['time_iso,time_ms,Roll (deg),Pitch (deg)', '1970-01-01T00:00:01.000Z,1000,10,-5'])
  })

  it('escapes header cells containing commas or quotes (RFC 4180)', () => {
    const csv = buildSamplesCsv([{ label: 'Roll, "raw"', unit: 'deg', samples: [{ ts: 1000, value: 1 }] }])
    expect(csv.split('\r\n')[0]).toBe('time_iso,time_ms,"Roll, ""raw"" (deg)"')
  })
})

describe('csvFilename', () => {
  it('derives from the newest exported timestamp (UTC), so a frozen post-disconnect export names the data time', () => {
    expect(csvFilename(Date.UTC(2026, 6, 18, 10, 30, 0, 123))).toBe('novax-samples-2026-07-18T10-30-00Z.csv')
  })
})
