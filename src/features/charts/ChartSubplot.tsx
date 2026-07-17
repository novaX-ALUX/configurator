import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Sample } from '../../core/mavlink/recorder'
import { ChartHost, type CursorReadout } from './ChartHost'
import { formatValue } from './formatValue'
import type { SeriesDef, UnitGroupId } from './seriesCatalog'
import { formatTime } from '../../utils/time'

/**
 * One Unit Group subplot card: unit header, legend, and the chart host.
 *
 * The legend doubles as the hover readout (issue #5): it shows each Series'
 * latest value normally, and switches to the values under the crosshair —
 * plus the hovered timestamp in the header — while the cursor is over the
 * plot. Values come from whatever Samples the page hands down, so a paused
 * display freezes the legend along with the traces for free. A `null` value
 * (recorded gap, or nothing at the cursor) reads as '—', never as 0.
 *
 * The card is a `flex-1` column (issue #50, UI audit CH4): the page's flex
 * stack divides the viewport's leftover height equally among the subplots
 * and each card passes its share down to the chart area, which the host
 * fills. The chart area's min-height is the floor below which the page
 * scrolls instead of squishing the plots further.
 */

/**
 * Trace colors, assigned by position within a subplot (nvx design tokens
 * first, then more distinguishable hues). A subplot rarely holds more than a
 * handful of Series; the µs group can technically hold all 34 RC+servo
 * Series, where colors repeat — accepted, that view is unreadable regardless
 * of palette size.
 */
const PALETTE = [
  '#2B5CE6', '#1E9E6A', '#D97706', '#DC2626', '#7C3AED',
  '#0891B2', '#DB2777', '#65A30D', '#475569', '#B45309',
] as const

/** `HH:MM:SS.mmm` — Samples arrive at up to 10Hz, so the readout needs the sub-second precision the shared `formatTime` (HH:MM:SS) doesn't carry. */
function formatReadoutTime(tsMs: number): string {
  return `${formatTime(tsMs)}.${String(new Date(tsMs).getMilliseconds()).padStart(3, '0')}`
}

export interface ChartSubplotProps {
  unitGroup: UnitGroupId
  /** The subplot's Series in catalog order, each with the Samples to display (live or paused — this component doesn't know which). */
  series: { def: SeriesDef; samples: readonly Sample[] }[]
  windowEndMs: number
  windowSec: number
}

export function ChartSubplot({ unitGroup, series, windowEndMs, windowSec }: ChartSubplotProps) {
  const { t } = useTranslation()
  const [readout, setReadout] = useState<CursorReadout | null>(null)

  return (
    <div data-testid={`subplot-${unitGroup}`} className="mb-4 flex flex-1 flex-col rounded-xl border border-nvx-border bg-white p-4 shadow-card last:mb-0">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-mono text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t(`charts.units.${unitGroup}`)}</span>
        {readout !== null && <span className="font-mono text-[10.5px] text-nvx-faint">{formatReadoutTime(readout.tsMs)}</span>}
      </div>
      <div className="mb-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {series.map(({ def, samples }, i) => {
          const latest = samples.length > 0 ? samples[samples.length - 1].value : null
          const entry = readout !== null ? readout.series[i] : null
          const value = readout !== null ? (entry?.value ?? null) : latest
          // A mixed-Block subplot resolves each Series to its own nearest
          // Sample — when that differs from the crosshair time in the header,
          // the row shows the value's true timestamp instead of implying it.
          const ownTime = entry !== null && entry.tsMs !== null && readout !== null && entry.tsMs !== readout.tsMs
          return (
            <span key={def.id} className="flex items-baseline gap-1.5 text-[11px]">
              <span className="h-[3px] w-3.5 self-center rounded-full" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
              <span className="font-semibold text-nvx-muted">{t(def.labelKey, def.labelParams)}</span>
              <span className="font-mono text-nvx-text">{formatValue(value, unitGroup)}</span>
              {ownTime && <span className="font-mono text-[10px] text-nvx-faint">{formatReadoutTime(entry.tsMs as number)}</span>}
            </span>
          )
        })}
      </div>
      <ChartHost
        // Remount on any change to the subplot's composition — ChartHost
        // fixes its series definitions for the life of the instance.
        key={series.map(({ def }) => def.id).join()}
        series={series.map(({ def, samples }, i) => ({
          label: t(def.labelKey, def.labelParams),
          color: PALETTE[i % PALETTE.length],
          timestampsMs: samples.map((s) => s.ts),
          values: samples.map((s) => s.value),
        }))}
        windowEndMs={windowEndMs}
        windowSec={windowSec}
        onCursor={setReadout}
      />
    </div>
  )
}
