/**
 * Issue #24 (bare Messages table, PRD §6/§11.3): pure formatting/sort
 * helpers, no React. Locks in the raw-honest value-formatting table exactly
 * (no toFixed rounding, no enum labels, bigint via toString(), arrays
 * comma-space joined untruncated) and the alphabetical-by-name sort order.
 */
import { describe, expect, it } from 'vitest'
import type { DecodedMessage } from '../../../core/mavlink/decode'
import type { MessageAggregate } from '../../../core/mavlink/inspector'
import { formatFieldValue, sortAggregatesByName } from '../inspectorUtils'

describe('formatFieldValue', () => {
  it('formats a number with String() — full double precision, never toFixed', () => {
    expect(formatFieldValue(42)).toBe('42')
    expect(formatFieldValue(-3)).toBe('-3')
    expect(formatFieldValue(0.10000000149011612)).toBe('0.10000000149011612')
    expect(formatFieldValue(0)).toBe('0')
  })

  it('formats a bigint via toString(), not through Number()', () => {
    expect(formatFieldValue(9007199254740993n)).toBe('9007199254740993') // > 2^53, would lose precision through Number()
  })

  it('formats a plain string as-is', () => {
    expect(formatFieldValue('EKF3 IMU0 is using GPS')).toBe('EKF3 IMU0 is using GPS')
    expect(formatFieldValue('')).toBe('')
  })

  it('wraps a string with leading/trailing whitespace in curly quotes, to disambiguate it from the trimmed form', () => {
    expect(formatFieldValue('foo ')).toBe('“foo ”')
    expect(formatFieldValue(' foo')).toBe('“ foo”')
    expect(formatFieldValue('foo')).toBe('foo')
  })

  it('joins a number[] comma-space, untruncated, each element formatted per its own scalar rule', () => {
    expect(formatFieldValue([1000, 1500, 2000])).toBe('1000, 1500, 2000')
    expect(formatFieldValue([])).toBe('')
  })

  it('joins a bigint[] comma-space via toString() per element', () => {
    expect(formatFieldValue([1n, 9007199254740993n])).toBe('1, 9007199254740993')
  })
})

function aggregate(name: string, msgid: number): MessageAggregate {
  const latest: DecodedMessage = { msgid, name, fields: {} }
  return { msgid, name, count: 1, lastSeen: 0, recentTimestamps: [], latest }
}

describe('sortAggregatesByName', () => {
  it('sorts alphabetically by name regardless of insertion (msgid) order', () => {
    const input = [aggregate('SYS_STATUS', 1), aggregate('ATTITUDE', 30), aggregate('HEARTBEAT', 0)]
    expect(sortAggregatesByName(input).map((a) => a.name)).toEqual(['ATTITUDE', 'HEARTBEAT', 'SYS_STATUS'])
  })

  it('does not mutate the input array', () => {
    const input = [aggregate('B', 2), aggregate('A', 1)]
    const copy = [...input]
    sortAggregatesByName(input)
    expect(input).toEqual(copy)
  })
})
