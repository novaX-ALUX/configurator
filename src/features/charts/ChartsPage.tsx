import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { RETENTION_MS, type Sample } from '../../core/mavlink/recorder'
import { useTelemetry } from '../dashboard/useTelemetry'
import { ChartSubplot } from './ChartSubplot'
import { useChartSelectionStore } from './chartSelectionStore'
import { BLOCK_ORDER, SERIES_CATALOG, UNIT_GROUP_ORDER } from './seriesCatalog'

/**
 * A frozen copy of the display at the moment Pause was clicked (issue #5).
 * Copies, not references: the History Buffer mutates its arrays in place
 * (append/evict), and recording deliberately continues while paused — the
 * frozen view must survive both, even past the 60s retention window.
 * Selection changes while paused show a Series only if it was captured here;
 * one selected during the pause renders empty until Resume.
 */
interface PausedView {
  windowEndMs: number
  samplesById: Map<string, readonly Sample[]>
}

/**
 * Telemetry Charts page. The user picks Series (grouped by Block, all 43
 * from the catalog); the selection — persisted by `chartSelectionStore` —
 * is partitioned into Unit Groups, one true-scale subplot per group present,
 * stacked in `UNIT_GROUP_ORDER`. All subplots pin their rolling window to
 * the page-wide newest Sample so they share one time axis.
 *
 * Reads the History Buffer directly (it is not reactive — see
 * `ConnectionState.history`), using `useTelemetry`'s throttled re-renders as
 * the redraw trigger, so the charts advance at the data's real arrival rate
 * and freeze the moment the session ends. History recorded before this page
 * mounts is picked up on first render, and the connect placeholder only
 * appears when there is truly nothing to show: not connected AND no recorded
 * history. An empty *selection* is a different state: the picker stays, the
 * subplot area shows a hint.
 *
 * Pause is display-local `useState` — deliberately not persisted and not in
 * a store: a page switch, reload, or new session (see the render-phase reset
 * below) always starts live, per the spec's "pausing is never a dead end".
 */
export function ChartsPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const session = useConnectionStore((s) => s.session)
  const history = useConnectionStore((s) => s.history)
  const selectedIds = useChartSelectionStore((s) => s.selectedIds)
  const toggleSeries = useChartSelectionStore((s) => s.toggleSeries)

  const [pausedView, setPausedView] = useState<PausedView | null>(null)
  // "Adjusting state when a prop changes" (same pattern as useTelemetry): a
  // new session identity — reconnect — snaps the display back to live, so a
  // pause can never show a previous session's frozen data as if current.
  const [prevSession, setPrevSession] = useState(session)
  if (session !== prevSession) {
    setPrevSession(session)
    setPausedView(null)
  }

  // Redraw trigger only — the snapshot itself isn't read; the Recorder has
  // already turned it into Samples by the time this notification fires.
  useTelemetry(session)

  // A Series id only appears once something was appended for it, so key
  // presence is "has history" (the newest Sample is never evicted).
  const hasHistory = history.seriesIds().length > 0

  if (phase !== 'connected' && !hasHistory) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        <div className="flex h-[74px] w-[74px] items-center justify-center rounded-[22px] border border-nvx-border bg-white text-nvx-faint shadow-card">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 4.5v15h15" />
            <path d="M7.5 14.5l3.4-4 3 2.5 4.6-6" />
          </svg>
        </div>
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('charts.notConnectedTitle')}</div>
        <div className="max-w-[420px] text-center text-[13px] leading-relaxed text-nvx-muted">{t('charts.notConnectedBody')}</div>
        <button
          type="button"
          disabled={phase !== 'disconnected'}
          onClick={() => void connect(baud)}
          className="rounded-[10px] bg-nvx-primary px-[22px] py-2.5 text-[13px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('charts.connectCta')}
        </button>
      </div>
    )
  }

  const selectedDefs = SERIES_CATALOG.filter((def) => selectedIds.includes(def.id))
  const groups = UNIT_GROUP_ORDER.map((unitGroup) => ({
    unitGroup,
    defs: selectedDefs.filter((def) => def.unitGroup === unitGroup),
  })).filter((g) => g.defs.length > 0)

  // One buffer read per selected Series per render, shared by the window-end
  // scan below and the ChartHost props.
  const samplesById = new Map(selectedDefs.map((def) => [def.id, history.getSamples(def.id)]))

  // The shared rolling window's trailing edge: the newest Sample across every
  // selected Series (Blocks tick at different times — a per-subplot newest
  // would let the subplots' time axes drift apart).
  let windowEndMs = 0
  for (const samples of samplesById.values()) {
    if (samples.length > 0) windowEndMs = Math.max(windowEndMs, samples[samples.length - 1].ts)
  }

  // What the subplots actually show: the live buffer, or the frozen copy.
  const displaySamples = (id: string): readonly Sample[] =>
    pausedView !== null ? (pausedView.samplesById.get(id) ?? []) : (samplesById.get(id) ?? [])
  const displayWindowEndMs = pausedView !== null ? pausedView.windowEndMs : windowEndMs

  const togglePause = () => {
    setPausedView(
      pausedView !== null
        ? null
        : {
            windowEndMs,
            samplesById: new Map(selectedDefs.map((def) => [def.id, [...(samplesById.get(def.id) ?? [])]])),
          },
    )
  }

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <div className="mb-3.5 flex items-baseline justify-between">
        <span className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.charts')}</span>
        <button
          type="button"
          onClick={togglePause}
          className={`rounded-[10px] border px-3.5 py-1.5 text-[12px] font-bold ${
            pausedView !== null
              ? 'border-nvx-warningBorder bg-nvx-warningSoft text-nvx-warningText'
              : 'border-nvx-border bg-white text-nvx-muted hover:border-nvx-borderStrong'
          }`}
        >
          {t(pausedView !== null ? 'charts.resume' : 'charts.pause')}
        </button>
      </div>

      <div className="mb-4 rounded-xl border border-nvx-border bg-white p-4 shadow-card">
        <div className="mb-3 text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('charts.pickerTitle')}</div>
        {BLOCK_ORDER.map((block) => (
          <div key={block} className="mb-2.5 flex flex-wrap items-baseline gap-1.5 last:mb-0">
            <span className="w-[72px] shrink-0 text-[11px] font-bold text-nvx-muted">{t(`charts.blocks.${block}`)}</span>
            {SERIES_CATALOG.filter((def) => def.block === block).map((def) => {
              const selected = selectedIds.includes(def.id)
              return (
                <label
                  key={def.id}
                  className={`cursor-pointer select-none rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                    selected
                      ? 'border-nvx-primary bg-nvx-primarySoft text-nvx-primarySoftText'
                      : 'border-nvx-border bg-white text-nvx-muted hover:border-nvx-borderStrong'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={selected}
                    onChange={() => toggleSeries(def.id)}
                  />
                  {t(def.labelKey, def.labelParams)}
                </label>
              )
            })}
          </div>
        ))}
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-nvx-border bg-white px-5 py-10 text-center shadow-card">
          <div className="font-heading text-[15px] font-bold text-nvx-text">{t('charts.emptyTitle')}</div>
          <div className="mt-1.5 text-[13px] text-nvx-muted">{t('charts.emptyBody')}</div>
        </div>
      ) : (
        groups.map(({ unitGroup, defs }) => (
          <ChartSubplot
            key={unitGroup}
            unitGroup={unitGroup}
            series={defs.map((def) => ({ def, samples: displaySamples(def.id) }))}
            windowEndMs={displayWindowEndMs}
            windowSec={RETENTION_MS / 1000}
          />
        ))
      )}
    </div>
  )
}
