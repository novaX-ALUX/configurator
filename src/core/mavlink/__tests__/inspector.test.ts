/**
 * Issue #24 (MessageAggregateStore, PRD §3/§11.1): direct unit tests against
 * the store and its pure `hzFromWindow` derivation, using fixture
 * `DecodedMessage` objects and an explicit `ts`/`now` per call (no router, no
 * transport, no wall clock) — the store-integration wiring through
 * `connection.ts` is a separate file (`src/store/__tests__/inspector.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import type { DecodedMessage } from '../decode'
import { HZ_WINDOW_MS, MessageAggregateStore, hzFromWindow } from '../inspector'

const HEARTBEAT_MSGID = 0
const ATTITUDE_MSGID = 30

function heartbeat(fields: Partial<DecodedMessage['fields']> = {}): DecodedMessage {
  return { msgid: HEARTBEAT_MSGID, name: 'HEARTBEAT', fields: { type: 2, autopilot: 3, ...fields } }
}

function attitude(fields: Partial<DecodedMessage['fields']> = {}): DecodedMessage {
  return { msgid: ATTITUDE_MSGID, name: 'ATTITUDE', fields: { roll: 0, pitch: 0, yaw: 0, ...fields } }
}

describe('MessageAggregateStore', () => {
  it('creates a new entry on first sight of a msgid', () => {
    const store = new MessageAggregateStore()
    const msg = heartbeat()
    store.record(msg, 1000)

    const entry = store.get(HEARTBEAT_MSGID)
    expect(entry?.msgid).toBe(HEARTBEAT_MSGID)
    expect(entry?.name).toBe('HEARTBEAT')
    expect(entry?.count).toBe(1)
    expect(entry?.lastSeen).toBe(1000)
    expect(entry?.recentTimestamps).toEqual([1000])
    expect(entry?.latest).toBe(msg) // reference swap, not a clone
  })

  it('increments count and overwrites latest (by reference) on repeats', () => {
    const store = new MessageAggregateStore()
    const first = attitude({ roll: 0.1 })
    const second = attitude({ roll: 0.2 })
    store.record(first, 1000)
    store.record(second, 1100)

    const entry = store.get(ATTITUDE_MSGID)
    expect(entry?.count).toBe(2)
    expect(entry?.lastSeen).toBe(1100)
    expect(entry?.latest).toBe(second) // reference swap, not a clone
  })

  it('evicts recentTimestamps entries older than now - HZ_WINDOW_MS as new ones arrive', () => {
    const store = new MessageAggregateStore()
    store.record(heartbeat(), 0)
    store.record(heartbeat(), 400)
    store.record(heartbeat(), 900)
    expect(store.get(HEARTBEAT_MSGID)?.recentTimestamps).toEqual([0, 400, 900])

    // This arrival's window is [500, 1500) — 0 and 400 fall outside it and are evicted.
    store.record(heartbeat(), 1500)
    expect(store.get(HEARTBEAT_MSGID)?.recentTimestamps).toEqual([900, 1500])
  })

  it('clear() empties all() but the store is reusable — a subsequent record() still works', () => {
    const store = new MessageAggregateStore()
    store.record(heartbeat(), 1000)
    expect(store.all()).toHaveLength(1)

    store.clear()
    expect(store.all()).toHaveLength(0)
    expect(store.get(HEARTBEAT_MSGID)).toBeUndefined()

    store.record(heartbeat(), 2000)
    const entry = store.get(HEARTBEAT_MSGID)
    expect(entry?.count).toBe(1) // a fresh entry, not a continuation of the cleared one
    expect(entry?.lastSeen).toBe(2000)
  })

  it('two distinct msgids never interfere with each other\'s count/recentTimestamps', () => {
    const store = new MessageAggregateStore()
    store.record(heartbeat(), 1000)
    store.record(attitude(), 1000)
    store.record(heartbeat(), 1100)

    expect(store.get(HEARTBEAT_MSGID)?.count).toBe(2)
    expect(store.get(ATTITUDE_MSGID)?.count).toBe(1)
    expect(store.get(HEARTBEAT_MSGID)?.recentTimestamps).toEqual([1000, 1100])
    expect(store.get(ATTITUDE_MSGID)?.recentTimestamps).toEqual([1000])
    expect(store.all().map((a) => a.name).sort()).toEqual(['ATTITUDE', 'HEARTBEAT'])
  })
})

describe('hzFromWindow', () => {
  it('0 arrivals -> 0', () => {
    expect(hzFromWindow([], 1000)).toBe(0)
  })

  it.each([
    { timestamps: [1000, 1200, 1400, 1600, 1800], now: 2000, expected: 5, desc: 'N arrivals inside the window -> N' },
    { timestamps: [0, 100, 200], now: 2000, expected: 0, desc: 'all arrivals aged past the window are excluded' },
    {
      timestamps: [0, 500, 1500, 1999],
      now: 2000,
      expected: 2,
      desc: 'only arrivals >= now - HZ_WINDOW_MS count; older ones are excluded',
    },
    { timestamps: [1000], now: 1000, expected: 1, desc: 'an arrival exactly at now counts' },
  ])('$desc', ({ timestamps, now, expected }) => {
    expect(hzFromWindow(timestamps, now)).toBe(expected)
  })

  it('uses a 1000ms window (HZ_WINDOW_MS)', () => {
    expect(HZ_WINDOW_MS).toBe(1000)
  })
})
