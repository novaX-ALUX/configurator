/**
 * Pure, React-free helpers backing the bare Messages table (Console/
 * Inspector, issue #24 Ticket 1) — value formatting and sort order, split
 * out from the component so they're unit-testable without React (colocated
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
