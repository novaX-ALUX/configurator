import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TelemetryState } from '../../core/mavlink/telemetry'
import { formatValue } from './formatValue'
import { liveSeriesValue } from './liveValue'
import { BLOCK_ORDER, SERIES_CATALOG, type BlockId } from './seriesCatalog'

/**
 * The Series picker (issue #49, UI audit CH1): one collapsible group per
 * Block, replacing the flat 43-chip wall. Each selected Series shows its
 * current Telemetry Snapshot value beside the checkbox — display only, the
 * Snapshot is already unit-converted and the Recorder/History Buffer are
 * untouched by this readout.
 *
 * Expand/collapse is component state only, per the ParamsPage precedent
 * (re-expanding a group is a single click, unlike the selection, which stays
 * in the persisted `chartSelectionStore`) — so collapsing a group never
 * touches what is selected. Groups holding a selected Series open expanded
 * (they are what the user is working with); the rest start collapsed, which
 * is what keeps the RC/servo walls off the screen. The header's n/total
 * count keeps a collapsed group's selection visible.
 *
 * The readout stays live while the charts are paused — Pause freezes the
 * display of Samples, and this is not Samples; it is the same
 * always-current Snapshot the Dashboard shows.
 */

export interface SeriesPickerProps {
  selectedIds: readonly string[]
  toggleSeries: (id: string) => void
  /** Disables the checkboxes — nothing to select into yet (see ChartsPage). */
  awaitingConnection: boolean
  /** Current Telemetry Snapshot, or null when there is no session. */
  telemetry: Readonly<TelemetryState> | null
}

export function SeriesPicker({ selectedIds, toggleSeries, awaitingConnection, telemetry }: SeriesPickerProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<ReadonlySet<BlockId>>(
    () => new Set(BLOCK_ORDER.filter((block) => SERIES_CATALOG.some((def) => def.block === block && selectedIds.includes(def.id)))),
  )

  const toggleGroup = (block: BlockId) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(block)) next.add(block)
      return next
    })
  }

  return (
    <div data-testid="series-picker" className="mb-4 overflow-hidden rounded-xl border border-nvx-border bg-white shadow-card">
      <div className="flex items-baseline justify-between px-4 pb-2.5 pt-3.5">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('charts.pickerTitle')}</span>
        {awaitingConnection && <span className="text-[11px] font-semibold text-nvx-faint">{t('charts.awaitingConnection')}</span>}
      </div>
      {BLOCK_ORDER.map((block) => {
        const defs = SERIES_CATALOG.filter((def) => def.block === block)
        const selectedCount = defs.filter((def) => selectedIds.includes(def.id)).length
        const isExpanded = expanded.has(block)
        return (
          <div key={block} className="border-t border-nvx-border">
            <button
              type="button"
              onClick={() => toggleGroup(block)}
              aria-expanded={isExpanded}
              className="flex w-full items-center gap-1.5 px-4 py-[7px] text-left text-[11px] font-bold text-nvx-muted hover:bg-nvx-field"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`flex-none transition-transform duration-150 ease-out motion-reduce:transition-none ${isExpanded ? 'rotate-90' : ''}`}
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
              {t(`charts.blocks.${block}`)}{' '}
              <span className="font-normal text-nvx-faint">
                ({selectedCount}/{defs.length})
              </span>
            </button>
            {isExpanded && (
              <div className="grid grid-cols-2 gap-x-5 gap-y-1 px-4 pb-3 pt-1 sm:grid-cols-3 xl:grid-cols-4">
                {defs.map((def) => {
                  const selected = selectedIds.includes(def.id)
                  const live = selected ? liveSeriesValue(telemetry, def.id) : null
                  return (
                    <div key={def.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                      <label
                        className={`flex min-w-0 select-none items-center gap-1.5 font-semibold ${
                          awaitingConnection
                            ? 'cursor-not-allowed text-nvx-disabled'
                            : selected
                              ? 'cursor-pointer text-nvx-text'
                              : 'cursor-pointer text-nvx-muted'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={awaitingConnection}
                          onChange={() => toggleSeries(def.id)}
                        />
                        {t(def.labelKey, def.labelParams)}
                      </label>
                      {/* Live readout for selected Series only; outside the
                          label so the ~10Hz value stays out of the checkbox's
                          accessible name. No unit suffix on '—' or on the
                          dimensionless group ("7 count" reads broken). */}
                      {selected && (
                        <span className="shrink-0 font-mono text-nvx-text">
                          {formatValue(live, def.unitGroup)}
                          {live !== null && def.unitGroup !== 'count' && (
                            <span className="text-nvx-faint"> {t(`charts.units.${def.unitGroup}`)}</span>
                          )}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
