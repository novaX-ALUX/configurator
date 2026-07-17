import type { Sample } from '../../core/mavlink/recorder'
import { downloadTextFile } from '../../utils/download'

/**
 * CSV export of recorded Samples (issue #51, UI audit CH3). Pure string
 * building — the caller (ChartsPage) resolves labels/units through i18n and
 * hands over the History Buffer's arrays untouched; nothing here reads or
 * mutates the buffer, satisfying the ticket's read-only requirement.
 *
 * Shape: wide format, one column per Series, rows keyed by the union of the
 * real receive timestamps (`time_iso` is the same instant re-formatted for
 * humans, `time_ms` is the exact recorded epoch value). An empty cell means
 * "this Series has no Sample at this timestamp" — Blocks tick at different
 * times — or "the Sample is a recorded null gap". No resampling, no
 * interpolation, no zeros: only what the Recorder appended appears.
 */

export interface CsvColumn {
  /** Translated Series label, e.g. "Roll" — combined with `unit` into the column header. */
  label: string
  /** Translated Unit Group label, e.g. "deg". */
  unit: string
  samples: readonly Sample[]
}

/** Quotes a field per RFC 4180 when it contains a comma, quote, or newline — only headers ever need it (values are numbers), but the check is cheap and locale labels are not under this module's control. */
function csvField(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildSamplesCsv(columns: readonly CsvColumn[]): string {
  const tsSet = new Set<number>()
  for (const col of columns) for (const s of col.samples) tsSet.add(s.ts)
  const timestamps = [...tsSet].sort((a, b) => a - b)

  const lines = [['time_iso', 'time_ms', ...columns.map((c) => csvField(`${c.label} (${c.unit})`))].join(',')]
  // One cursor per column: a Series' Samples are already ts-ascending (the
  // Recorder appends in arrival order with per-Block ts dedupe), so each is
  // consumed in one forward pass over the merged timestamps.
  const cursors = columns.map(() => 0)
  for (const ts of timestamps) {
    const cells = [new Date(ts).toISOString(), String(ts)]
    columns.forEach((col, i) => {
      const next = col.samples[cursors[i]]
      if (next !== undefined && next.ts === ts) {
        cursors[i]++
        cells.push(next.value === null ? '' : String(next.value))
      } else {
        cells.push('')
      }
    })
    lines.push(cells.join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

/** Named after the newest exported Sample (UTC, second precision) rather than the export click — deterministic, and a frozen post-disconnect export says when its data is from. */
export function csvFilename(newestTs: number): string {
  return `novax-samples-${new Date(newestTs).toISOString().slice(0, 19).replace(/:/g, '-')}Z.csv`
}

/** Plain client-side download via the shared Blob/anchor-click pattern (`utils/download.ts`). The BOM prefix is for Excel, which otherwise misreads UTF-8 headers (three of our four locales are non-ASCII). */
export function downloadCsv(filename: string, csv: string): void {
  downloadTextFile(filename, '\uFEFF' + csv, 'text/csv;charset=utf-8')
}
