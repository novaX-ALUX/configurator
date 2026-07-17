/**
 * Pure, React-free helpers backing the Console page (issue #26 Ticket 3,
 * carrying forward issue #24/#25's Messages-table formatting/sort) — value
 * formatting, sort order, Status-stream severity grouping, and clipboard
 * export (PRD §9), split out from the components so they're unit-testable
 * without React (colocated derivation-split convention,
 * `paramUtils.ts`/`seriesCatalog.ts` precedent).
 */
import type { DecodedFieldValue, DecodedMessage } from '../../core/mavlink/decode'
import { hzFromWindow, type MessageAggregate } from '../../core/mavlink/inspector'
import { formatTime } from '../../utils/time'

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

/**
 * "Copy table" (PRD §9) — tab-separated, header row `Type\tHz\tCount\tLast
 * seen` then one row per aggregate, in the given order (the caller passes
 * `sortAggregatesByName`'s output, so this matches the visible table order
 * at click time, live or frozen). `Hz` uses the same `hzFromWindow`
 * derivation and `.toFixed(1)` the on-screen column uses; `Last seen` uses
 * the same `formatTime` util `StatusStream` also imports. No trailing
 * newline (unlike `formatFieldsText`, which explicitly wants one) — this is
 * a bare header + rows, matching the fenced example in the PRD.
 */
export function formatMessagesTableTSV(rows: readonly MessageAggregate[], now: number): string {
  const lines = rows.map((row) => {
    const hz = hzFromWindow(row.recentTimestamps, now)
    return `${row.name}\t${hz.toFixed(1)}\t${row.count}\t${formatTime(row.lastSeen)}`
  })
  return ['Type\tHz\tCount\tLast seen', ...lines].join('\n')
}

/**
 * "Copy fields" (PRD §9) — first line `{name} (msgid {msgid})`, then one
 * `{field_name}: {formatted_value}` line per field in the same order the
 * table expansion renders them (`Object.entries` insertion order), using the
 * exact same `formatFieldValue` rules as the on-screen rendering. Trailing
 * newline after the last field, per the PRD's fenced example.
 */
export function formatFieldsText(msg: DecodedMessage): string {
  const lines = [`${msg.name} (msgid ${msg.msgid})`]
  for (const [field, value] of Object.entries(msg.fields)) {
    lines.push(`${field}: ${formatFieldValue(value)}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Wraps `navigator.clipboard.writeText` (PRD §9) so a denied/unavailable
 * Clipboard API (e.g. an insecure context, or a browser that never grants
 * the permission) never throws into the render tree — it resolves `false`
 * instead, letting the caller show a disabled/error affordance. This is a
 * nice-to-have export, not a safety-relevant path, so "fail silently and let
 * the user retry" is an acceptable posture.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
