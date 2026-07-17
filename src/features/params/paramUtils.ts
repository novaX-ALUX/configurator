/**
 * Pure, DOM-free helpers backing `ParamsPage`'s search/group-section filter,
 * enum/range-caption widget logic, and type-badge/precision-guard logic —
 * split out from the component so they're unit-testable without React or a
 * `ParamStore`.
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
import type { ParamMetaEntry } from '../../core/paramMetadata'

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

/**
 * Rounds a `fetchAll()` pull's `(got, total)` to an integer 0-100 percent for
 * the progress bar's fill, or `undefined` while `total` isn't known yet
 * (before the first `PARAM_VALUE` names the stream's `param_count`) — the
 * caller falls back to an indeterminate display in that case. Clamped to 100
 * so a stray duplicate arrival past `total` (harmless overwrite per
 * `ParamStore`'s module doc) can never render an over-full bar.
 */
export function fetchProgressPercent(got: number, total: number | undefined): number | undefined {
  if (total === undefined || total <= 0) return undefined
  return Math.min(100, Math.round((got / total) * 100))
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

/**
 * First `_`-segment of a parameter name (e.g. `ATC_RAT_PIT_P` -> `ATC`); the
 * whole name if there's no `_` at all, or if `_` is the very first character
 * (a leading underscore, e.g. `_FOO_BAR`) — an empty-string group would
 * render as a nameless "_ (N)" section, so that case falls back to the same
 * "no delimiter" behavior as a name with no underscore at all.
 */
export function deriveGroup(name: string): string {
  const idx = name.indexOf('_')
  return idx <= 0 ? name : name.slice(0, idx)
}

export interface ParamGroup {
  group: string
  items: Param[]
}

/**
 * Every `deriveGroup()` group present in `params`, alphabetically sorted
 * (matches the Mico reference's alphabetical group list) — unlike the
 * deleted `topGroups`/`GROUP_CHIP_MAX`, nothing is capped or ranked by
 * count. Collapsible sections + scroll replace the chip row as the page's
 * navigation, so there's no longer a reason to hide any group (PRD #12
 * §2.5). A group with zero matching params simply never appears here —
 * callers pass an already-`filterParams`-filtered array to get "hide
 * zero-match groups on search" for free, with no extra logic.
 */
export function groupParams(params: readonly Param[]): ParamGroup[] {
  const byGroup = new Map<string, Param[]>()
  for (const p of params) {
    const g = deriveGroup(p.name)
    const items = byGroup.get(g)
    if (items) items.push(p)
    else byGroup.set(g, [p])
  }
  return [...byGroup.entries()].map(([group, items]) => ({ group, items })).sort((a, b) => a.group.localeCompare(b.group))
}

/**
 * Case-insensitive substring match on `param.name` OR (when `lookupMeta` is
 * given) the matched `ParamMetaEntry.displayName` — never the description,
 * which would surface too many unrelated hits (PRD #12 §2.5). An empty
 * query returns every param unchanged. `lookupMeta` is `undefined` when
 * metadata never loaded, in which case search silently falls back to
 * name-only matching (same fallback principle as everywhere else metadata
 * is additive, PRD §1.4).
 *
 * `notDefaultOnly`/`lookupDefault` (PRD #12 §2.4, issue #15) is a third,
 * independent predicate over the same already-filtered set — a row must
 * pass the search AND (when the toggle is on) differ from its bundled
 * default (`isNotDefault`, below). `lookupDefault` is `undefined` when
 * defaults data never loaded, in which case turning the toggle on returns
 * nothing rather than guessing (same additive-fallback principle as
 * `lookupMeta`).
 */
export function filterParams(
  params: readonly Param[],
  query: string,
  lookupMeta?: (name: string) => ParamMetaEntry | undefined,
  notDefaultOnly?: boolean,
  lookupDefault?: (name: string) => number | undefined,
): Param[] {
  const q = query.trim().toLowerCase()
  return params.filter((p) => {
    if (notDefaultOnly && !isNotDefault(p.value, lookupDefault?.(p.name))) return false
    if (!q) return true
    if (p.name.toLowerCase().includes(q)) return true
    const displayName = lookupMeta?.(p.name)?.displayName
    return displayName !== undefined && displayName.toLowerCase().includes(q)
  })
}

/**
 * True when `meta.values` (an enum's listed options) is present AND `value`
 * is one of them — the only condition under which `ParamRow` renders a
 * `<select>` instead of the plain number input. An out-of-spec value (staged
 * or live) must never be hidden behind a dropdown that can't represent it
 * (PRD §1.4/§2.2).
 */
export function isEnumValue(meta: ParamMetaEntry | undefined, value: number): boolean {
  return meta?.values?.some((v) => v.value === value) ?? false
}

/**
 * True if any name in `writtenNames` (a just-succeeded write batch) has
 * `ParamMetaEntry.rebootRequired` set — the sole condition `ParamsPage` uses
 * to show the post-write "Reboot required" banner (PRD #12 Ticket 5).
 * `lookupMeta` is `undefined` when metadata never loaded, in which case this
 * always returns `false` (same additive-fallback principle as
 * `filterParams`: no metadata means no reboot-required signal, not a
 * guess).
 */
export function batchNeedsReboot(writtenNames: readonly string[], lookupMeta?: (name: string) => ParamMetaEntry | undefined): boolean {
  if (!lookupMeta) return false
  return writtenNames.some((name) => lookupMeta(name)?.rebootRequired === true)
}

/**
 * Advisory range/units caption text (e.g. "0–100 %"), or `undefined` if
 * metadata has neither — never rendered as an HTML `min`/`max` or used to
 * block staging (PRD §2.3: ArduPilot's documented range is a suggestion in
 * the source comment, not a firmware-enforced constraint).
 */
export function rangeUnitsCaption(meta: ParamMetaEntry | undefined): string | undefined {
  if (!meta) return undefined
  const range = meta.range ? `${meta.range[0]}–${meta.range[1]}` : undefined
  if (range && meta.units) return `${range} ${meta.units}`
  return range ?? meta.units
}

/**
 * True only when a bundled SITL default exists for this param AND `value`
 * differs from it (PRD #12 §2.4, issue #15) — the sole condition under which
 * `ParamRow` shows the "Default: {n}" caption + warning-tone highlight, and
 * the positive-set predicate the `Not Default` toggle filters on.
 *
 * `undefined` `defaultValue` (no bundled default for this param name) always
 * returns `false` — a row with no default data is never flagged as
 * "changed," it's simply unknown (never guessed).
 *
 * The comparison is float32-tolerant (`Math.fround` both sides): the live
 * value arrived over MAVLink as a wire float32, and the bundled default was
 * read out of a `.parm` text file as a float64 literal — two representations
 * of "the same number" that a strict `!==` would false-flag as different
 * purely from precision noise neither side actually has (e.g. `0.1`'s
 * nearest float32 neighbor vs. the float64 literal `0.1`).
 */
export function isNotDefault(value: number, defaultValue: number | undefined): boolean {
  if (defaultValue === undefined) return false
  return Math.fround(value) !== Math.fround(defaultValue)
}
