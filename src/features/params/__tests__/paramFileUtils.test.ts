import { describe, expect, it, vi } from 'vitest'
import type { Param } from '../../../core/mavlink/params'
import { downloadParamFile, parseParamFile, planImport, serializeParamFile } from '../paramFileUtils'

function param(overrides: Partial<Param> = {}): Param {
  return { name: 'THR_MIN', value: 0, type: 9, index: 0, ...overrides }
}

describe('parseParamFile', () => {
  it('parses Mission Planner comma CSV', () => {
    const result = parseParamFile('THR_MIN,0.1\nTHR_MAX,900')
    expect(result).toEqual({
      kind: 'ok',
      entries: [
        { name: 'THR_MIN', value: 0.1 },
        { name: 'THR_MAX', value: 900 },
      ],
    })
  })

  it('parses the MAVProxy whitespace-padded dialect', () => {
    const result = parseParamFile('THR_MIN    0.1\nTHR_MAX\t900')
    expect(result).toEqual({
      kind: 'ok',
      entries: [
        { name: 'THR_MIN', value: 0.1 },
        { name: 'THR_MAX', value: 900 },
      ],
    })
  })

  it('accepts a mix of both dialects in the same file', () => {
    const result = parseParamFile('THR_MIN,0.1\nTHR_MAX 900')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.entries).toEqual([
      { name: 'THR_MIN', value: 0.1 },
      { name: 'THR_MAX', value: 900 },
    ])
  })

  it('skips comment and blank lines', () => {
    const result = parseParamFile('# a comment\n\nTHR_MIN,0.1\n   \n# another comment\nTHR_MAX,900\n')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.entries).toEqual([
      { name: 'THR_MIN', value: 0.1 },
      { name: 'THR_MAX', value: 900 },
    ])
  })

  it('tolerates leading whitespace before a # comment', () => {
    const result = parseParamFile('  # indented comment\nTHR_MIN,0.1')
    expect(result.kind).toBe('ok')
  })

  it('rejects the whole file on one malformed line, not just that line', () => {
    const result = parseParamFile('THR_MIN,0.1\nthis is not a param line\nTHR_MAX,900')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.message).toMatch(/line 2/)
  })

  it('rejects a line whose value is not a number', () => {
    const result = parseParamFile('THR_MIN,not-a-number')
    expect(result.kind).toBe('error')
  })

  it('rejects a whitespace-dialect line with more than two fields', () => {
    const result = parseParamFile('THR_MIN 0.1 extra')
    expect(result.kind).toBe('error')
  })

  it('an empty file parses to zero entries, not an error', () => {
    expect(parseParamFile('')).toEqual({ kind: 'ok', entries: [] })
  })
})

describe('serializeParamFile', () => {
  it('emits a provenance comment line followed by NAME,value rows sorted by name', () => {
    const params = [param({ name: 'THR_MAX', value: 900, type: 6 }), param({ name: 'THR_MIN', value: 0.1, type: 9 })]
    const text = serializeParamFile(params, { board: 'AF-H7_nano', fw: '4.6.3', now: new Date('2026-07-16T12:00:00.000Z') })
    const lines = text.split('\n')
    expect(lines[0]).toBe('# novaX Configurator export — AF-H7_nano 4.6.3 — 2026-07-16T12:00:00.000Z')
    expect(lines[1]).toBe('THR_MAX,900') // alphabetically before THR_MIN
    expect(lines[2]).toBe('THR_MIN,0.1')
  })

  it('falls back to "unknown board"/"unknown fw" when identity is missing', () => {
    const text = serializeParamFile([], { board: undefined, fw: undefined, now: new Date('2026-07-16T12:00:00.000Z') })
    expect(text.split('\n')[0]).toBe('# novaX Configurator export — unknown board unknown fw — 2026-07-16T12:00:00.000Z')
  })

  it('emits an integer-typed value with no decimal point', () => {
    const text = serializeParamFile([param({ name: 'SERVO1_MIN', value: 1100, type: 3 })], { board: undefined, fw: undefined })
    expect(text).toContain('SERVO1_MIN,1100\n')
  })

  it('round-trips: export then re-parse yields the identical (name, value) set', () => {
    const params = [
      param({ name: 'THR_MIN', value: 0.1, type: 9 }),
      param({ name: 'COMPASS_OFS_X', value: -12.345678, type: 9 }), // a value where naive rounding would lose data
      param({ name: 'SERVO1_MIN', value: 1100, type: 3 }),
      param({ name: 'BRD_SERIAL_NUM', value: 16777215, type: 6 }), // near the float32-exact integer boundary
    ]
    const text = serializeParamFile(params, { board: 'AF-H7_nano', fw: '4.6.3' })
    const parsed = parseParamFile(text)
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') throw new Error('unreachable')
    const roundTripped = new Map(parsed.entries.map((e) => [e.name, e.value]))
    for (const p of params) {
      expect(roundTripped.get(p.name)).toBe(p.value)
    }
    expect(roundTripped.size).toBe(params.length)
  })
})

describe('planImport', () => {
  it('stages a real change for a known param', () => {
    const current = new Map([['THR_MIN', param({ name: 'THR_MIN', value: 0, type: 9 })]])
    const plan = planImport([{ name: 'THR_MIN', value: 0.5 }], current)
    expect(plan).toEqual({ toStage: [{ name: 'THR_MIN', value: 0.5 }], skippedUnknown: 0, skippedPrecision: 0, skippedUnchanged: 0 })
  })

  it('skips a name the connected FC does not have, counted as unknown', () => {
    const plan = planImport([{ name: 'NOT_A_REAL_PARAM', value: 1 }], new Map())
    expect(plan).toEqual({ toStage: [], skippedUnknown: 1, skippedPrecision: 0, skippedUnchanged: 0 })
  })

  it('skips a value equal to the current cached value (float32-tolerant), counted as unchanged', () => {
    const current = new Map([['THR_MIN', param({ name: 'THR_MIN', value: 0.1, type: 9 })]])
    // Math.fround(0.1) === Math.fround(0.1000000001) at float32 precision.
    const plan = planImport([{ name: 'THR_MIN', value: 0.1000000001 }], current)
    expect(plan).toEqual({ toStage: [], skippedUnknown: 0, skippedPrecision: 0, skippedUnchanged: 1 })
  })

  it('skips a precision-losing value for an integer type, counted as precision', () => {
    const current = new Map([['BRD_SERIAL_NUM', param({ name: 'BRD_SERIAL_NUM', value: 0, type: 6 })]])
    const plan = planImport([{ name: 'BRD_SERIAL_NUM', value: 16777217 }], current) // 2^24 + 1
    expect(plan).toEqual({ toStage: [], skippedUnknown: 0, skippedPrecision: 1, skippedUnchanged: 0 })
  })

  it('classifies a mixed batch independently, one line at a time', () => {
    const current = new Map([
      ['KNOWN_CHANGED', param({ name: 'KNOWN_CHANGED', value: 0, type: 9 })],
      ['KNOWN_SAME', param({ name: 'KNOWN_SAME', value: 5, type: 9 })],
      ['KNOWN_PRECISION', param({ name: 'KNOWN_PRECISION', value: 0, type: 6 })],
    ])
    const plan = planImport(
      [
        { name: 'KNOWN_CHANGED', value: 1 },
        { name: 'KNOWN_SAME', value: 5 },
        { name: 'KNOWN_PRECISION', value: 16777217 },
        { name: 'UNKNOWN_PARAM', value: 1 },
      ],
      current,
    )
    expect(plan.toStage).toEqual([{ name: 'KNOWN_CHANGED', value: 1 }])
    expect(plan.skippedUnchanged).toBe(1)
    expect(plan.skippedPrecision).toBe(1)
    expect(plan.skippedUnknown).toBe(1)
  })
})

describe('downloadParamFile', () => {
  it('creates an object URL, clicks a synthetic download anchor, then revokes it', () => {
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    downloadParamFile('novax-params.param', '# hello\nTHR_MIN,0\n')

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')

    clickSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})
