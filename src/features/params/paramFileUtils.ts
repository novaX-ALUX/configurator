/**
 * `.param` file parsing/serialization and import staging-plan logic (PRD #12
 * §3, issue #16). Pure, DOM-free functions only — the one DOM-touching piece
 * (`downloadParamFile`, the Blob/anchor-click dance) is isolated at the
 * bottom so the parsing/planning logic above it stays trivially unit
 * testable, matching this file's siblings (`paramUtils.ts`).
 *
 * **Import never writes.** `planImport` only classifies each parsed line
 * into "stage" or one of three skip reasons — it never calls
 * `ParamStore.set`. `ParamsPage` is the only caller, and it feeds
 * `plan.toStage` through the exact same `stage()` function a manual row edit
 * already uses, so imported changes go through the same `DiffDrawer` review
 * gate as everything else (PRD §3: the product's non-negotiable safety
 * differentiator — see that file's module doc).
 */
import { wouldLosePrecision } from './paramUtils'
import type { Param } from '../../core/mavlink/params'

export interface ParamFileEntry {
  name: string
  value: number
}

export type ParamFileParseResult = { kind: 'ok'; entries: ParamFileEntry[] } | { kind: 'error'; message: string }

/**
 * Parses Mission Planner `NAME,value` CSV and MAVProxy's whitespace-padded
 * `.parm` dialect (PRD §3.1). `#`-prefixed and blank lines are skipped
 * (also how `serializeParamFile` emits its own provenance line, so a
 * round-trip re-parse ignores it for free). Comma is tried first when a line
 * contains one — it's the more specific shape, so a name/value pair that
 * happens to contain whitespace around the comma is still read correctly.
 *
 * Any other non-blank, non-comment line — neither dialect's shape, or a
 * value that isn't a finite number — rejects the **whole file** with one
 * top-level error before anything is staged (PRD §3.1: a malformed file is a
 * strong signal of the wrong file entirely; partially staging garbage from
 * it would be worse than refusing outright).
 */
export function parseParamFile(text: string): ParamFileParseResult {
  const entries: ParamFileEntry[] = []
  const lines = text.split(/\r\n|\r|\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    let name: string
    let valueText: string
    if (trimmed.includes(',')) {
      const commaIdx = trimmed.indexOf(',')
      name = trimmed.slice(0, commaIdx).trim()
      valueText = trimmed.slice(commaIdx + 1).trim()
    } else {
      const fields = trimmed.split(/\s+/)
      if (fields.length !== 2) {
        return { kind: 'error', message: `Malformed line ${i + 1}: "${line}" — expected "NAME,value" or "NAME value"` }
      }
      ;[name, valueText] = fields
    }

    if (name === '' || valueText === '') {
      return { kind: 'error', message: `Malformed line ${i + 1}: "${line}" — expected "NAME,value" or "NAME value"` }
    }
    const value = Number(valueText)
    if (!Number.isFinite(value)) {
      return { kind: 'error', message: `Malformed line ${i + 1}: "${line}" — "${valueText}" is not a number` }
    }
    entries.push({ name, value })
  }

  return { kind: 'ok', entries }
}

/**
 * Serializes the live table to Mission Planner-compatible `NAME,value` CSV,
 * sorted alphabetically by name (deterministic output — same reasoning as
 * `groupParams`' own sort). Integer-typed values are always exactly
 * integral already (the write path's `wouldLosePrecision` guard forbids
 * anything else from ever reaching the cache), so `String(value)` alone
 * satisfies both PRD bullets — "integers with no decimal point" and "floats
 * via `String(value)`" reduce to the same call; no separate integer
 * formatting path is needed.
 */
export function serializeParamFile(params: readonly Param[], provenance: { board: string | undefined; fw: string | undefined; now?: Date }): string {
  const timestamp = (provenance.now ?? new Date()).toISOString()
  const header = `# novaX Configurator export — ${provenance.board ?? 'unknown board'} ${provenance.fw ?? 'unknown fw'} — ${timestamp}`
  const sorted = [...params].sort((a, b) => a.name.localeCompare(b.name))
  const lines = sorted.map((p) => `${p.name},${String(p.value)}`)
  return [header, ...lines].join('\n') + '\n'
}

export interface ImportPlan {
  toStage: ParamFileEntry[]
  skippedUnknown: number
  skippedPrecision: number
  skippedUnchanged: number
}

/**
 * Classifies each parsed line against the live cache (PRD §3.3-§3.4):
 *
 * - Not in `current` (unknown to the connected FC) -> skipped, counted.
 * - Known, but `wouldLosePrecision` for its cached type -> skipped, counted
 *   (same guard `ParamRow` applies to manual entry — a bulk import can't
 *   interactively re-prompt per line the way a text input's blur handler
 *   can).
 * - Known, value equals the cached value (float32-tolerant, matching the
 *   comparison `set()`'s own echo check and the default-marker comparison
 *   both already use) -> skipped silently (a no-op, not a problem).
 * - Otherwise -> staged, in `toStage`, for the caller to run through
 *   `stage()` exactly like a manual edit.
 *
 * Pure and DOM-free: this never calls `ParamStore.set` or `stage()` itself —
 * see module doc.
 */
export function planImport(entries: readonly ParamFileEntry[], current: ReadonlyMap<string, Param>): ImportPlan {
  const plan: ImportPlan = { toStage: [], skippedUnknown: 0, skippedPrecision: 0, skippedUnchanged: 0 }
  for (const entry of entries) {
    const cached = current.get(entry.name)
    if (!cached) {
      plan.skippedUnknown++
    } else if (wouldLosePrecision(cached.type, entry.value)) {
      plan.skippedPrecision++
    } else if (Math.fround(entry.value) === Math.fround(cached.value)) {
      plan.skippedUnchanged++
    } else {
      plan.toStage.push(entry)
    }
  }
  return plan
}

/**
 * Triggers a browser "Save As" for `content` as a same-origin, no-network
 * download — the standard Blob + object-URL + synthetic-anchor-click
 * pattern (no library: this is a few lines, not worth a dependency per
 * CLAUDE.md §8). `URL.revokeObjectURL` runs synchronously right after the
 * click dispatch; browsers keep the object URL alive long enough to service
 * the navigation it just triggered, so this doesn't race the download.
 */
export function downloadParamFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
