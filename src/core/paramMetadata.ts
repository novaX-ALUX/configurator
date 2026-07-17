/**
 * Additive parameter documentation (display name, description, and — for
 * later tickets — units/range/enum values/reboot-required) generated at
 * build time by `tools/generate-param-metadata.mjs` from the pinned
 * ArduPilot submodule (PRD #12 §1.1) and fetched same-origin, lazily, after
 * connect — same static-asset pattern as `core/firmware/manifest.ts`
 * (`docs/notes/decisions-m1.md` decisions 4/5): never a cross-origin fetch,
 * never bundled into the app's main JS chunk.
 *
 * This module is purely additive. Nothing here is ever a hard dependency —
 * a fetch failure, an unsupported firmware version, or a param with no
 * metadata match all degrade to `undefined`/`ParamRow`'s existing raw-name
 * rendering, never an error state (PRD §1.4).
 */

export interface ParamMetaEntry {
  displayName: string
  description: string
  units?: string
  /** Advisory only — see PRD §2.3, not enforced by this ticket's UI at all. */
  range?: [number, number]
  increment?: number
  values?: { value: number; label: string }[]
  rebootRequired?: boolean
}

/**
 * One bundled ArduCopter major.minor branch's metadata, as generated —
 * keyed by literal param name, or by a `{idx}`-templated pattern for
 * indexed/replicated params (e.g. `"RC{idx}_MIN"`, PRD §1.3). The generator
 * does the pattern *detection* (which families collapse); this module only
 * ever compiles an already-decided template string into a regex.
 */
export type ParamMetaFile = Record<string, ParamMetaEntry>

interface ParamMetaPattern {
  regex: RegExp
  entry: ParamMetaEntry
}

/** The exact-name/pattern lookup tables `lookupParamMeta` reads — built once per fetched `ParamMetaFile` by `buildParamMetaTable`. */
export interface ParamMetaTable {
  exact: ReadonlyMap<string, ParamMetaEntry>
  patterns: readonly ParamMetaPattern[]
}

/** Escapes every regex-special character in a literal template segment. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `"RC{idx}_MIN"` -> `/^RC\d+_MIN$/`. Placeholder names (`idx`, `idx2`, ...) don't matter, only that each `{...}` marks a numeric index segment. */
function templateToRegex(template: string): RegExp {
  const segments = template.split(/\{[^}]+\}/).map(escapeRegExp)
  return new RegExp(`^${segments.join('\\d+')}$`)
}

/**
 * Splits a fetched `ParamMetaFile` into an exact-name `Map` and an ordered
 * list of compiled `{ regex, entry }` patterns (PRD §1.3) — done once per
 * fetch, not per lookup.
 */
export function buildParamMetaTable(file: ParamMetaFile): ParamMetaTable {
  const exact = new Map<string, ParamMetaEntry>()
  const patterns: ParamMetaPattern[] = []
  for (const [key, entry] of Object.entries(file)) {
    if (key.includes('{')) {
      patterns.push({ regex: templateToRegex(key), entry })
    } else {
      exact.set(key, entry)
    }
  }
  return { exact, patterns }
}

/** Exact match first, then the first matching pattern (generator's key order, preserved), else `undefined` — never throws, a lookup miss is an expected, common case (ArduPilot metadata coverage isn't 100%, PRD §1.4). */
export function lookupParamMeta(table: ParamMetaTable, name: string): ParamMetaEntry | undefined {
  const exact = table.exact.get(name)
  if (exact) return exact
  for (const pattern of table.patterns) {
    if (pattern.regex.test(name)) return pattern.entry
  }
  return undefined
}

/** `"4.6.3"`, `"4.6.3-beta"`, `"4.6"` all -> `"4.6"`. Falls back to the input unchanged if it doesn't start with `major.minor` (defensive — `fwVersion` is decoded elsewhere and already constrained, see `store/connection.ts`). */
function majorMinorOf(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version)
  return m ? `${m[1]}.${m[2]}` : version
}

function compareMajorMinor(a: string, b: string): number {
  const [aMajor, aMinor] = a.split('.').map(Number)
  const [bMajor, bMinor] = b.split('.').map(Number)
  return aMajor - bMajor || aMinor - bMinor
}

/**
 * Pure version-selection function (PRD §1.2), independently testable
 * without a live fetch: given the bundled major.minor versions and the
 * connected vehicle's `fwVersion` (`undefined` if the AUTOPILOT_VERSION
 * banner never arrived), picks which bundled file to use.
 *
 * 1. Exact major.minor match -> that version.
 * 2. No exact match, `fwVersion` known -> the closest *lower* bundled
 *    version (ArduPilot params are added over time, rarely removed within a
 *    couple of majors); if none is lower (`fwVersion` is older than every
 *    bundled branch — not one of the three cases the PRD names, but still
 *    must resolve to something), the closest higher one.
 * 3. `fwVersion` undefined -> the newest bundled version.
 *
 * `available` must be non-empty (the generator always produces at least one
 * bundled file); throws otherwise rather than silently returning a bogus
 * version string.
 */
export function matchFirmwareVersion(available: readonly string[], fwVersion: string | undefined): string {
  if (available.length === 0) throw new Error('matchFirmwareVersion: no bundled metadata versions available')
  const sorted = [...available].sort(compareMajorMinor)

  if (fwVersion === undefined) return sorted[sorted.length - 1]

  const wanted = majorMinorOf(fwVersion)
  if (sorted.includes(wanted)) return wanted

  const lower = sorted.filter((v) => compareMajorMinor(v, wanted) < 0)
  if (lower.length > 0) return lower[lower.length - 1]

  return sorted[0] // fwVersion older than every bundled branch: closest available is the oldest we have
}

export type MetadataVersionBanner =
  | { kind: 'exact' }
  | { kind: 'mismatch'; bundled: string; fwVersion: string }
  | { kind: 'unknown-fw'; bundled: string }

/**
 * Which banner (if any) to show for a `bundled` version picked by
 * `matchFirmwareVersion` against the vehicle's actual `fwVersion` — derived
 * by comparison rather than threaded through as a second return value from
 * `matchFirmwareVersion`, so the two stay independently testable pure
 * functions (PRD §1.2's three cases: exact / closest-lower / newest-unknown,
 * each get their own banner copy at the call site).
 */
export function metadataVersionBanner(bundled: string, fwVersion: string | undefined): MetadataVersionBanner {
  if (fwVersion === undefined) return { kind: 'unknown-fw', bundled }
  if (majorMinorOf(fwVersion) === bundled) return { kind: 'exact' }
  return { kind: 'mismatch', bundled, fwVersion }
}

/**
 * Bundled major.minor branches actually shipped under
 * `public/param-metadata/`. Ticket 1 (issue #13) bundles exactly one
 * (whichever the SITL / AF-H7_nano fixture reports — currently ArduCopter
 * 4.6). Hardcoded rather than fetched/derived from a directory listing:
 * static hosting can't list a directory, and generating a second small
 * index file for a one-element list is speculative until a later ticket's
 * `generate-param-metadata.mjs` run actually adds a second bundled branch —
 * at which point this array (and the generator's own output) both grow
 * together, by hand, same as `public/firmware/manifest.json`'s board list.
 */
export const AVAILABLE_METADATA_VERSIONS: readonly string[] = ['4.6']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Structural validation of a fetched param-metadata JSON blob before it's
 * trusted as a `ParamMetaFile` — same "validate fetched JSON, don't just
 * assert its type" precedent `core/firmware/manifest.ts`'s `parseManifest`
 * sets. Proportionate to this shape: every entry needs at minimum a
 * `displayName`/`description` string (the two fields this ticket actually
 * renders); `ParamMetaEntry`'s other fields are optional in the type and
 * left unchecked here rather than duplicating the generator's own
 * field-shape guarantees — a malformed *optional* field on one entry
 * shouldn't fail the whole fetch.
 */
function parseParamMetaFile(json: unknown): ParamMetaFile {
  if (!isRecord(json)) throw new Error('param metadata: expected a JSON object at the top level')
  for (const [name, entry] of Object.entries(json)) {
    if (!isRecord(entry)) throw new Error(`param metadata: entry "${name}" is not an object`)
    if (typeof entry.displayName !== 'string') throw new Error(`param metadata: entry "${name}" is missing a string displayName`)
    if (typeof entry.description !== 'string') throw new Error(`param metadata: entry "${name}" is missing a string description`)
  }
  return json as ParamMetaFile
}

const metaCache = new Map<string, Promise<ParamMetaTable>>()

/**
 * Same-origin fetch of one bundled `{version}.json` (`public/param-metadata/`,
 * never cross-origin — see module doc), parsed into a `ParamMetaTable`.
 * Results are cached in-memory per version for the module's lifetime (PRD
 * §1.5): the data is immutable per version, so there's never a reason to
 * refetch or invalidate it, including across a disconnect/reconnect.
 */
export function fetchParamMetadata(version: string, fetchFn: typeof fetch = fetch): Promise<ParamMetaTable> {
  const cached = metaCache.get(version)
  if (cached) return cached

  const promise = (async () => {
    const url = `${import.meta.env.BASE_URL}param-metadata/${version}.json`
    const response = await fetchFn(url, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`)
    const json = parseParamMetaFile(await response.json())
    return buildParamMetaTable(json)
  })()
  // Cache the in-flight promise, not just the settled result, so concurrent
  // callers (e.g. two pages both reading the same connected Session) share
  // one fetch — but a *rejected* fetch must not poison the cache forever
  // (a later reconnect on a flakier link should get to try again).
  promise.catch(() => metaCache.delete(version))
  metaCache.set(version, promise)
  return promise
}

/** `loadParamMetadata`'s result — also the shape `ParamsPage` holds in state, named once so the two don't drift into two independently-shaped inline object types. */
export interface LoadedParamMetadata {
  table: ParamMetaTable
  banner: MetadataVersionBanner
}

/**
 * Convenience wrapper combining version selection + banner + fetch — the
 * one call `ParamsPage` needs after connect. Rejects if the fetch fails
 * (asset missing, network error, bad JSON); the caller is expected to catch
 * that and degrade to today's raw rendering (PRD §1.4's "additive, never a
 * hard dependency" rule lives at the call site, not in here).
 */
export async function loadParamMetadata(
  fwVersion: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<LoadedParamMetadata> {
  const version = matchFirmwareVersion(AVAILABLE_METADATA_VERSIONS, fwVersion)
  const banner = metadataVersionBanner(version, fwVersion)
  const table = await fetchParamMetadata(version, fetchFn)
  return { table, banner }
}

/**
 * One bundled ArduCopter major.minor branch's SITL default values (PRD #12
 * §2.4, issue #15) — generated by the same `tools/generate-param-metadata.mjs`
 * run, from `Tools/autotest/default_params/copter.parm` in the pinned
 * submodule, into a second static file `{version}.defaults.json`. Keyed by
 * literal param name only: unlike `ParamMetaFile`, there is no pattern-entry
 * concept here (the SITL defaults file lists literal names, not templated
 * families). A param absent from this record has no known default — that's
 * meaningfully different from "the default is 0" (never guessed, PRD §2.4).
 */
export type ParamDefaultsFile = Record<string, number>

/**
 * Structural validation of a fetched param-defaults JSON blob, same
 * "validate fetched JSON" precedent as `parseParamMetaFile` above — every
 * value must be a `number`, nothing more (this file carries no display/enum
 * data, just the bundled default value per param name).
 */
function parseParamDefaultsFile(json: unknown): ParamDefaultsFile {
  if (!isRecord(json)) throw new Error('param defaults: expected a JSON object at the top level')
  for (const [name, value] of Object.entries(json)) {
    if (typeof value !== 'number') throw new Error(`param defaults: entry "${name}" is not a number`)
  }
  return json as ParamDefaultsFile
}

const defaultsCache = new Map<string, Promise<ParamDefaultsFile>>()

/**
 * Same-origin fetch of one bundled `{version}.defaults.json`, parsed into a
 * plain `ParamDefaultsFile` record — mirrors `fetchParamMetadata`'s fetch/
 * cache/never-poison-on-rejection shape exactly, but against a separate
 * cache: the two files are independent fetches (a defaults-file 404 must
 * never take down the display-name/description metadata that already
 * loaded, and vice versa — both are purely additive, PRD §1.4's principle
 * extended to this second asset).
 */
export function fetchParamDefaults(version: string, fetchFn: typeof fetch = fetch): Promise<ParamDefaultsFile> {
  const cached = defaultsCache.get(version)
  if (cached) return cached

  const promise = (async () => {
    const url = `${import.meta.env.BASE_URL}param-metadata/${version}.defaults.json`
    const response = await fetchFn(url, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`)
    return parseParamDefaultsFile(await response.json())
  })()
  promise.catch(() => defaultsCache.delete(version))
  defaultsCache.set(version, promise)
  return promise
}

/**
 * Convenience wrapper mirroring `loadParamMetadata`: resolves the same
 * bundled version `matchFirmwareVersion` would pick for the metadata file
 * (same `AVAILABLE_METADATA_VERSIONS` list — defaults are bundled per the
 * same major.minor branches), then fetches it. Deliberately independent of
 * `loadParamMetadata`/its banner: a fetch failure here degrades to "no
 * default data for any param" (no caption anywhere, excluded from the
 * Not-Default filter) without affecting whether display names/descriptions
 * loaded.
 */
export async function loadParamDefaults(fwVersion: string | undefined, fetchFn: typeof fetch = fetch): Promise<ParamDefaultsFile> {
  const version = matchFirmwareVersion(AVAILABLE_METADATA_VERSIONS, fwVersion)
  return fetchParamDefaults(version, fetchFn)
}
