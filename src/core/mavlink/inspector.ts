/**
 * MessageAggregateStore (Console/Inspector, issue #24, PRD §2-3): a
 * store-lifetime, per-msgid aggregate of every decoded MAVLink message from
 * the session's resolved target — count, a 1s rolling arrival-timestamp
 * window (Hz is derived from it at read time, never stored precomputed),
 * last-seen, and the most recently decoded message (reference swap, never
 * accumulated). No message history is kept; this is aggregate-only by
 * design (CONTEXT.md-adjacent decision, PRD §0 decision 2).
 *
 * Fed by a direct `MavRouter.subscribe()` tap added in `connection.ts`
 * alongside the existing STATUSTEXT subscription (PRD §2) — this file
 * imports only `DecodedMessage` (`decode.ts`), never `defs.ts` or
 * `mavlink-mappings` (ADR-0001's confinement, reused).
 *
 * Lifecycle precedent: mirrors `HistoryBuffer` (`recorder.ts`) exactly —
 * store-lifetime, frozen (never cleared) on disconnect, cleared only when
 * the next connect reaches 'connected'. See `connection.ts`'s wiring.
 */
import type { DecodedMessage } from './decode'

/** Rolling window length backing the Hz derivation (PRD §0 decision 2: "1-second-window rolling Hz"). */
export const HZ_WINDOW_MS = 1000

export interface MessageAggregate {
  msgid: number
  name: string
  count: number
  lastSeen: number
  /** Arrival timestamps within the last `HZ_WINDOW_MS`, oldest first — Hz is derived from this at read time (`hzFromWindow`), never stored as a precomputed number. */
  recentTimestamps: number[]
  /** Full decoded fields of the most recently received message of this type. Overwritten in place (reference swap) — never accumulated, since `DecodedMessage` objects are never mutated after `decodePayload` produces them. */
  latest: DecodedMessage
}

/**
 * Number of `recentTimestamps` entries within `HZ_WINDOW_MS` of `now`,
 * divided by the window in seconds. `now` is a parameter (not `Date.now()`)
 * so this is callable from a fixed-clock test and from a UI tick alike —
 * deriving at read time (rather than storing a precomputed Hz) lets a type
 * that's gone quiet decay towards 0 as real time passes with no new
 * arrivals, instead of freezing at its last computed value forever.
 */
export function hzFromWindow(recentTimestamps: readonly number[], now: number): number {
  const cutoff = now - HZ_WINDOW_MS
  let n = 0
  for (let i = recentTimestamps.length - 1; i >= 0 && recentTimestamps[i] >= cutoff; i--) n++
  return n / (HZ_WINDOW_MS / 1000)
}

export class MessageAggregateStore {
  private readonly aggregates = new Map<number, MessageAggregate>()

  /** Keyed by numeric `msgid` (the router's native identity), not by name — see PRD §3. */
  record(msg: DecodedMessage, ts: number): void {
    let entry = this.aggregates.get(msg.msgid)
    if (entry === undefined) {
      entry = { msgid: msg.msgid, name: msg.name, count: 0, lastSeen: ts, recentTimestamps: [], latest: msg }
      this.aggregates.set(msg.msgid, entry)
    }
    entry.count++
    entry.lastSeen = ts
    entry.latest = msg

    // Arrives in order per key, so only a prefix is ever stale — same
    // eviction shape as `HistoryBuffer.evictBefore`, just a plain
    // `number[]` scoped to this one msgid instead of every Series.
    entry.recentTimestamps.push(ts)
    const cutoff = ts - HZ_WINDOW_MS
    let drop = 0
    while (drop < entry.recentTimestamps.length && entry.recentTimestamps[drop] < cutoff) drop++
    if (drop > 0) entry.recentTimestamps.splice(0, drop)
  }

  get(msgid: number): MessageAggregate | undefined {
    return this.aggregates.get(msgid)
  }

  /** Every message type seen this session, in first-seen (insertion) order — sorting is a presentation concern the UI layer applies (PRD §3), not something the store bakes in. */
  all(): readonly MessageAggregate[] {
    return [...this.aggregates.values()]
  }

  clear(): void {
    this.aggregates.clear()
  }
}
