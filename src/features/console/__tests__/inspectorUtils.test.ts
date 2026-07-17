/**
 * Issue #24/#25/#26 (Console page, PRD §6/§8/§9/§11.3): pure formatting/sort/
 * severity/clipboard helpers, no React. Locks in the raw-honest value-
 * formatting table exactly (no toFixed rounding, no enum labels, bigint via
 * toString(), arrays comma-space joined untruncated), the alphabetical-by-
 * name sort order, §8's 3-group severity boundary, and §9's exact "Copy
 * table"/"Copy fields" clipboard formats plus `copyToClipboard`'s
 * never-throws contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecodedMessage } from '../../../core/mavlink/decode'
import type { MessageAggregate } from '../../../core/mavlink/inspector'
import { formatTime } from '../../../utils/time'
import {
  copyToClipboard,
  formatFieldsText,
  formatFieldValue,
  formatMessagesTableTSV,
  MAV_SEVERITY_NAMES,
  severityGroup,
  sortAggregatesByName,
} from '../inspectorUtils'

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

describe('severityGroup', () => {
  it('groups 0-3 as errors, 4-5 as warnings, 6-7 as info (PRD §8 boundary)', () => {
    expect(severityGroup(0)).toBe('errors')
    expect(severityGroup(3)).toBe('errors')
    expect(severityGroup(4)).toBe('warnings')
    expect(severityGroup(5)).toBe('warnings')
    expect(severityGroup(6)).toBe('info')
    expect(severityGroup(7)).toBe('info')
  })
})

describe('MAV_SEVERITY_NAMES', () => {
  it('has a short badge for all 8 MAV_SEVERITY values', () => {
    expect(Object.keys(MAV_SEVERITY_NAMES)).toHaveLength(8)
    expect(MAV_SEVERITY_NAMES[3]).toBe('ERR')
    expect(MAV_SEVERITY_NAMES[6]).toBe('INFO')
  })
})

/** `n` arrival timestamps, all within the last 1000ms of `now`, so `hzFromWindow` reports exactly `n`. */
function tsWindow(n: number, now: number): number[] {
  return Array.from({ length: n }, (_, i) => now - i * 50)
}

function aggregateAt(name: string, msgid: number, count: number, lastSeen: number, recentTimestamps: number[]): MessageAggregate {
  return { msgid, name, count, lastSeen, recentTimestamps, latest: { msgid, name, fields: {} } }
}

describe('formatMessagesTableTSV', () => {
  it('formats the exact header + one TSV row per aggregate, in the given order, Hz to 1 decimal, Last seen via formatTime (PRD §9)', () => {
    const now = 60_000
    const rows: MessageAggregate[] = [
      aggregateAt('ATTITUDE', 30, 15420, now, tsWindow(10, now)), // 10 arrivals in-window -> 10.0 Hz
      aggregateAt('HEARTBEAT', 0, 842, now, tsWindow(1, now)), // 1 arrival -> 1.0 Hz
      aggregateAt('SYS_STATUS', 1, 168, now - 500, tsWindow(2, now)), // 2 arrivals -> 2.0 Hz
    ]

    const result = formatMessagesTableTSV(rows, now)

    expect(result).toBe(
      [
        'Type\tHz\tCount\tLast seen',
        `ATTITUDE\t10.0\t15420\t${formatTime(now)}`,
        `HEARTBEAT\t1.0\t842\t${formatTime(now)}`,
        `SYS_STATUS\t2.0\t168\t${formatTime(now - 500)}`,
      ].join('\n'),
    )
  })

  it('emits only the header for an empty table (no trailing newline)', () => {
    expect(formatMessagesTableTSV([], 0)).toBe('Type\tHz\tCount\tLast seen')
  })

  it('excludes arrivals aged out of the 1s window from the Hz column', () => {
    const now = 10_000
    const rows: MessageAggregate[] = [aggregateAt('COMMAND_ACK', 77, 1, 5000, [5000])] // last arrival 5s stale
    expect(formatMessagesTableTSV(rows, now)).toBe(`Type\tHz\tCount\tLast seen\nCOMMAND_ACK\t0.0\t1\t${formatTime(5000)}`)
  })
})

describe('formatFieldsText', () => {
  it('formats "{name} (msgid {msgid})" then one "field: value" line per field in render order, trailing newline (PRD §9 fixture)', () => {
    const msg: DecodedMessage = {
      msgid: 30,
      name: 'ATTITUDE',
      fields: {
        time_boot_ms: 123456,
        roll: 0.0123456789,
        pitch: -0.045,
        yaw: 1.5708,
        rollspeed: 0.001,
        pitchspeed: 0.002,
        yawspeed: 0,
      },
    }

    expect(formatFieldsText(msg)).toBe(
      'ATTITUDE (msgid 30)\n' +
        'time_boot_ms: 123456\n' +
        'roll: 0.0123456789\n' +
        'pitch: -0.045\n' +
        'yaw: 1.5708\n' +
        'rollspeed: 0.001\n' +
        'pitchspeed: 0.002\n' +
        'yawspeed: 0\n',
    )
  })

  it('uses the same formatFieldValue rules for bigint, array, and whitespace-string fields as the on-screen rendering', () => {
    const msg: DecodedMessage = {
      msgid: 65,
      name: 'RC_CHANNELS',
      fields: {
        time_usec: 9007199254740993n,
        chan: [1000, 1500, 2000],
        note: 'foo ',
      },
    }

    expect(formatFieldsText(msg)).toBe('RC_CHANNELS (msgid 65)\ntime_usec: 9007199254740993\nchan: 1000, 1500, 2000\nnote: “foo ”\n')
  })

  it('renders just the header line + trailing newline for a message with no fields', () => {
    expect(formatFieldsText({ msgid: 0, name: 'HEARTBEAT', fields: {} })).toBe('HEARTBEAT (msgid 0)\n')
  })
})

describe('copyToClipboard', () => {
  const originalClipboard = navigator.clipboard

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
  })

  it('resolves true and passes the exact text through to navigator.clipboard.writeText on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await expect(copyToClipboard('hello\tworld')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello\tworld')
  })

  it('resolves false instead of throwing when the Clipboard API rejects (denied permission)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await expect(copyToClipboard('x')).resolves.toBe(false)
  })

  it('resolves false instead of throwing when the Clipboard API is unavailable (e.g. insecure context)', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })

    await expect(copyToClipboard('x')).resolves.toBe(false)
  })
})
