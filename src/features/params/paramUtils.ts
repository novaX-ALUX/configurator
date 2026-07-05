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
 *
 * `DiffRowStatus`/`writeErrorStatus`/`fetchErrorMessage`/`withoutKey` (Task
 * 7.2) also live here, not just in `ParamsPage`: `features/setup`'s
 * `setupStore`/`SetupPage`/`SetupDirtyBar` stage-and-write against the same
 * `ParamStore` with the exact same five write outcomes and the exact same
 * `fetchAll()` failure modes, so this is the one place both features import
 * that mapping from, rather than each carrying its own copy that could
 * silently drift apart.
 */
import type { TFunction } from 'i18next'
import {
  INTEGER_PARAM_TYPES,
  ParamCountDriftError,
  ParamFetchError,
  ParamFetchNoResponseError,
  ParamPrecisionLossError,
  ParamWriteBusyError,
  ParamWriteMismatchError,
  ParamWriteTimeoutError,
  type Param,
} from '../../core/mavlink/params'

/** Every outcome a staged `ParamStore.set()` can settle to, shared by `features/params`' `DiffDrawer` and `features/setup`'s `SetupDirtyBar`. */
export type DiffRowStatus =
  | { kind: 'writing' }
  | { kind: 'ok' }
  | { kind: 'mismatch'; requested: number; actual: number }
  | { kind: 'timeout' }
  | { kind: 'busy' }
  | { kind: 'precision' }
  | { kind: 'error'; message: string }

/** Maps a rejected `ParamStore.set()` to the `DiffRowStatus` a row should show. */
export function writeErrorStatus(err: unknown): DiffRowStatus {
  if (err instanceof ParamWriteMismatchError) return { kind: 'mismatch', requested: err.requested, actual: err.actual }
  if (err instanceof ParamWriteTimeoutError) return { kind: 'timeout' }
  if (err instanceof ParamWriteBusyError) return { kind: 'busy' }
  if (err instanceof ParamPrecisionLossError) return { kind: 'precision' }
  return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
}

/** Renders a `DiffRowStatus` as the same user-facing sentence in every consumer (`params.*` i18n keys — the wording doesn't differ between the parameter table and the Setup page, both describe the same `ParamStore.set()` outcome). */
export function diffStatusMessage(status: DiffRowStatus, t: TFunction): string {
  switch (status.kind) {
    case 'writing':
      return t('params.writing')
    case 'ok':
      return t('params.statusOk')
    case 'mismatch':
      return t('params.statusMismatch', { requested: status.requested, actual: status.actual })
    case 'timeout':
      return t('params.statusTimeout')
    case 'busy':
      return t('params.statusBusy')
    case 'precision':
      return t('params.statusPrecision')
    case 'error':
      return t('params.statusError', { message: status.message })
  }
}

/** Maps a rejected `ParamStore.fetchAll()` to a user-facing message — same failure modes regardless of which page triggered the fetch. */
export function fetchErrorMessage(err: unknown, t: TFunction): string {
  if (err instanceof ParamFetchNoResponseError) return t('params.errorNoResponse')
  if (err instanceof ParamFetchError) return t('params.errorMissing', { count: err.missing.length })
  if (err instanceof ParamCountDriftError) return t('params.errorDrift')
  return t('params.errorGeneric', { message: err instanceof Error ? err.message : String(err) })
}

/** Removes `key` from a `Map`, returning the same reference untouched if it was already absent (cheap no-op for React/Zustand setters). */
export function withoutKey<K, V>(map: Map<K, V>, key: K): Map<K, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

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

/**
 * First `_`-segment of a parameter name (e.g. `ATC_RAT_PIT_P` -> `ATC`); the
 * whole name if there's no `_` at all, or if `_` is the very first character
 * (a leading underscore, e.g. `_FOO_BAR`) — an empty-string group would
 * render as a nameless "_ (N)" chip, so that case falls back to the same
 * "no delimiter" behavior as a name with no underscore at all.
 */
export function deriveGroup(name: string): string {
  const idx = name.indexOf('_')
  return idx <= 0 ? name : name.slice(0, idx)
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
