import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { RETENTION_MS, type Sample } from '../../core/mavlink/recorder'
import { useTelemetry } from '../dashboard/useTelemetry'
import { OfflineChip } from '../../layout/OfflineChip'
import { ChartSubplot } from './ChartSubplot'
import { buildSamplesCsv, csvFilename, downloadCsv } from './exportCsv'
import { SeriesPicker } from './SeriesPicker'
import { useChartSelectionStore } from './chartSelectionStore'
import { SERIES_CATALOG, UNIT_GROUP_ORDER } from './seriesCatalog'

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
 * and freeze the moment the session ends.
 *
 * UI G5 (issue #10): this always renders its full layout, offline or not —
 * `CONTEXT.md`'s History Buffer promise ("survives disconnect frozen") means
 * the picker + subplots must stay visible so a previous session's Samples
 * stay inspectable. History recorded before this page mounts is picked up on
 * first render. Three cases fall out of the same render path: connected
 * (live), offline with recorded history (frozen — subplots show the last
 * Samples, an "Offline — frozen" chip marks it), and offline with nothing
 * recorded yet (the picker renders with its checkboxes disabled — nothing to
 * select into — and the subplot area is simply empty, same as the existing
 * "no Series selected" case). An empty *selection* is a separate state from
 * "no history": the picker stays enabled, the subplot area shows a hint.
 *
 * Pause is display-local `useState` — deliberately not persisted and not in
 * a store: a page switch, reload, or new session (see the render-phase reset
 * below) always starts live, per the spec's "pausing is never a dead end".
 *
 * The time window (issue #50, UI audit CH2) is a view, never a filter: the
 * selector only changes the x-axis span handed to the subplots; the History
 * Buffer keeps retaining the longest option (`RETENTION_MS`) and the Samples
 * handed down are identical at every setting, so switching windows can never
 * drop or fabricate a Sample. Like Pause it is display-local `useState` —
 * the Series selection stays the one piece of Charts state the spec
 * persists (see `chartSelectionStore`).
 */

/** Selectable x-axis spans; the longest IS the buffer's retention window, so every option is fully backed by retained Samples. */
const WINDOW_OPTIONS_SEC = [5, 10, 30, RETENTION_MS / 1000] as const

export function ChartsPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const session = useConnectionStore((s) => s.session)
  const history = useConnectionStore((s) => s.history)
  const selectedIds = useChartSelectionStore((s) => s.selectedIds)
  const toggleSeries = useChartSelectionStore((s) => s.toggleSeries)

  const [pausedView, setPausedView] = useState<PausedView | null>(null)
  const [windowSec, setWindowSec] = useState<number>(RETENTION_MS / 1000)
  // "Adjusting state when a prop changes" (same pattern as useTelemetry): a
  // new session identity — reconnect — snaps the display back to live, so a
  // pause can never show a previous session's frozen data as if current.
  const [prevSession, setPrevSession] = useState(session)
  if (session !== prevSession) {
    setPrevSession(session)
    setPausedView(null)
  }

  // Doubles as the redraw trigger (the Recorder has already turned the
  // snapshot into Samples by the time this notification fires) and as the
  // picker's live readout source (issue #49) — display only, never Samples.
  const telemetry = useTelemetry(session)

  // A Series id only appears once something was appended for it, so key
  // presence is "has history" (the newest Sample is never evicted).
  const hasHistory = history.seriesIds().length > 0
  const offline = phase !== 'connected'
  // Nothing to select into yet — the picker still renders (per the layered
  // empty-state policy), but toggling a Series while there's no Recorder
  // attached and no prior Samples wouldn't do anything until a connect.
  const awaitingConnection = offline && !hasHistory

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

  // CSV export (issue #51, CH3): always reads the History Buffer — the
  // ticket's source of truth — live or frozen, deliberately not the paused
  // display copy. Read-only: the buffer arrays go into the CSV builder
  // untouched. Selected Series that never received a Sample contribute no
  // column, so the file holds only real Samples.
  const exportable = selectedDefs.some((def) => (samplesById.get(def.id) ?? []).length > 0)
  const exportCsv = () => {
    const columns = selectedDefs
      .map((def) => ({
        label: t(def.labelKey, def.labelParams),
        unit: t(`charts.units.${def.unitGroup}`),
        samples: samplesById.get(def.id) ?? [],
      }))
      .filter((c) => c.samples.length > 0)
    downloadCsv(csvFilename(windowEndMs), buildSamplesCsv(columns))
  }

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
    <div className="flex min-h-full flex-col px-5 pb-6 pt-[18px]">
      <div className="mb-3.5 flex items-baseline justify-between">
        <span className="flex items-center gap-2.5">
          <span className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.charts')}</span>
          <OfflineChip active={offline} label={t(hasHistory ? 'charts.offlineFrozen' : 'charts.offline')} />
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            disabled={!exportable}
            className="rounded-[10px] border border-nvx-border bg-white px-3.5 py-1.5 text-[12px] font-bold text-nvx-muted hover:border-nvx-borderStrong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('charts.exportCsv')}
          </button>
          <span role="group" aria-label={t('charts.windowLabel')} className="flex gap-1">
            {WINDOW_OPTIONS_SEC.map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => setWindowSec(sec)}
                aria-pressed={sec === windowSec}
                className={`rounded-[10px] border px-2.5 py-1.5 font-mono text-[11.5px] font-bold ${
                  sec === windowSec
                    ? 'border-nvx-primary bg-nvx-primarySoft text-nvx-primarySoftText'
                    : 'border-nvx-border bg-white text-nvx-muted hover:border-nvx-borderStrong'
                }`}
              >
                {t('charts.windowSeconds', { s: sec })}
              </button>
            ))}
          </span>
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
        </span>
      </div>

      <SeriesPicker
        selectedIds={selectedIds}
        toggleSeries={toggleSeries}
        awaitingConnection={awaitingConnection}
        telemetry={telemetry}
      />

      {groups.length === 0 ? (
        // `flex-1` so the hint fills the space the subplots would (CH4's "no
        // page-level dead space" applies to the empty selection too).
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-nvx-border bg-white px-5 py-10 text-center shadow-card">
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
            windowSec={windowSec}
          />
        ))
      )}
    </div>
  )
}
