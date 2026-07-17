/**
 * Pure, React-free helpers backing the Console page (issue #25 Ticket 2,
 * carrying forward issue #24 Ticket 1's Messages-table formatting/sort) —
 * value formatting, sort order, and Status-stream severity grouping, split
 * out from the components so they're unit-testable without React (colocated
 * derivation-split convention, `paramUtils.ts`/`seriesCatalog.ts`
 * precedent).
 */
import type { DecodedFieldValue } from '../../core/mavlink/decode'
import type { MessageAggregate } from '../../core/mavlink/inspector'

function formatScalar(value: number | bigint): string {
  return typeof value === 'bigint' ? value.toString() : String(value)
}

/**
 * Raw-honest value formatting (PRD §6, settled decision — no enum labels,
 * no fabricated precision/units):
 * - `number` -> `String(value)`, full double precision, never `.toFixed()`'d
 *   (rounding is itself a unit-shaped judgment call this layer doesn't make).
 * - `bigint` -> `value.toString()`, never coerced through `Number()`
 *   (silent precision loss above 2^53).
 * - `string` (already-trimmed `char[]`) -> as-is; wrapped in curly quotes
 *   only if it has leading/trailing whitespace, disambiguating `"foo "`
 *   from `"foo"`.
 * - array -> comma-space joined, each element formatted per its own scalar
 *   rule above, untruncated.
 */
export function formatFieldValue(value: DecodedFieldValue): string {
  if (typeof value === 'string') {
    return /^\s|\s$/.test(value) ? `“${value}”` : value
  }
  if (Array.isArray(value)) {
    return value.map(formatScalar).join(', ')
  }
  return formatScalar(value)
}

/** Alphabetical by name, stable regardless of live Hz/count changes (PRD §3) — sorting is a presentation concern the UI layer applies, not something the store bakes in. */
export function sortAggregatesByName(aggregates: readonly MessageAggregate[]): MessageAggregate[] {
  return [...aggregates].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * PRD §8's settled 3-group severity boundary — the ONE boundary reused for
 * both Status-stream row color and the filter chips (retires `StatusPanel`'s
 * old 4-tier `severityTier`, which used a different boundary for color than
 * this ticket's filter uses, a "filtered out Info but the row still looks
 * info-adjacent" confusion this collapses to one scheme).
 */
export type SeverityGroup = 'errors' | 'warnings' | 'info'

export function severityGroup(severity: number): SeverityGroup {
  if (severity <= 3) return 'errors' // EMERGENCY(0) ALERT(1) CRITICAL(2) ERROR(3)
  if (severity <= 5) return 'warnings' // WARNING(4) NOTICE(5)
  return 'info' // INFO(6) DEBUG(7)
}

/**
 * Short per-row severity badge (PRD §8): a local, hardcoded, 8-entry
 * MAV_SEVERITY table — the same "small, well-known enum kept out of
 * `mavlink-mappings`" precedent `paramUtils.ts`'s `PARAM_TYPE_LABELS` sets.
 * One specific, already-consumed enum (every STATUSTEXT already carries a
 * `severity`), not a generic enum-label mechanism (§6 explicitly rejects
 * building one of those).
 */
export const MAV_SEVERITY_NAMES: Record<number, string> = {
  0: 'EMER',
  1: 'ALERT',
  2: 'CRIT',
  3: 'ERR',
  4: 'WARN',
  5: 'NOTICE',
  6: 'INFO',
  7: 'DEBUG',
}
