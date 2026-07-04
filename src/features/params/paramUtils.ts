/**
 * Pure, DOM-free helpers backing `ParamsPage`'s search/group filter, paging,
 * and type-badge/precision-guard logic — split out from the component so
 * they're unit-testable without React or a `ParamStore`.
 *
 * `PARAM_TYPE_LABELS` is a local, hardcoded MAV_PARAM_TYPE (1-10) label
 * table rather than an import of `mavlink-mappings`' own `MavParamType`
 * enum: `defs.ts`'s module doc (and the `no-restricted-imports` ESLint rule)
 * make `mavlink-mappings` importable from exactly one file in this project
 * (docs/notes/decisions-m1.md decisions 2/8). `isIntegerParamType` instead
 * reuses `params.ts`'s own exported `INTEGER_PARAM_TYPES` rather than
 * re-declaring the same set here, so there's exactly one place that decides
 * which MAV_PARAM_TYPEs are integers.
 */
import { INTEGER_PARAM_TYPES, type Param } from '../../core/mavlink/params'

/** MAV_PARAM_TYPE 1-10, display labels only (see module doc for why this isn't imported from mavlink-mappings). */
export const PARAM_TYPE_LABELS: Record<number, string> = {
  1: 'UINT8',
  2: 'INT8',
  3: 'UINT16',
  4: 'INT16',
  5: 'UINT32',
  6: 'INT32',
  7: 'UINT64',
  8: 'INT64',
  9: 'REAL32',
  10: 'REAL64',
}

export function paramTypeLabel(type: number): string {
  return PARAM_TYPE_LABELS[type] ?? `TYPE_${type}`
}

export function isIntegerParamType(type: number): boolean {
  return INTEGER_PARAM_TYPES.has(type)
}

/** Same rule `ParamStore.set` enforces (`ParamPrecisionLossError`) — checked client-side too, before ever staging an edit, so the diff drawer never queues a write the store is guaranteed to reject. */
export function wouldLosePrecision(type: number, value: number): boolean {
  return isIntegerParamType(type) && Math.fround(value) !== value
}

const PAGE_SIZE = 100

export function paramPageSize(): number {
  return PAGE_SIZE
}

/** First `_`-segment of a parameter name (e.g. `ATC_RAT_PIT_P` -> `ATC`); the whole name if there's no `_` at all. */
export function deriveGroup(name: string): string {
  const idx = name.indexOf('_')
  return idx === -1 ? name : name.slice(0, idx)
}

export interface GroupChip {
  group: string
  count: number
}

/** Groups by `deriveGroup`, sorted by count desc (ties broken alphabetically for a stable order), capped to `max`. Does not include an "All" entry — callers add that themselves alongside the total count. */
export function topGroups(params: readonly Param[], max = 12): GroupChip[] {
  const counts = new Map<string, number>()
  for (const p of params) {
    const g = deriveGroup(p.name)
    counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group))
    .slice(0, max)
}

/** Case-insensitive substring match on `name`, ANDed with an optional exact group filter (`null` = no group filter, i.e. "All"). */
export function filterParams(params: readonly Param[], query: string, group: string | null): Param[] {
  const q = query.trim().toLowerCase()
  return params.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q)) return false
    if (group !== null && deriveGroup(p.name) !== group) return false
    return true
  })
}

/** 1-indexed page window; `page` is clamped into `[1, ceil(items.length/pageSize)]` (never throws on an out-of-range page). */
export function paginate<T>(items: readonly T[], page: number, pageSize: number = PAGE_SIZE): T[] {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const clamped = Math.min(Math.max(1, page), totalPages)
  const start = (clamped - 1) * pageSize
  return items.slice(start, start + pageSize)
}

export function totalPages(itemCount: number, pageSize: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(itemCount / pageSize))
}
