import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { RETENTION_MS } from '../../core/mavlink/recorder'
import { useTelemetry } from '../dashboard/useTelemetry'
import { ChartHost } from './ChartHost'

/**
 * The degrees Unit Group of this tracer bullet (issue #3): the three attitude
 * Series, hardwired until the Series picker ticket lands. The Recorder
 * appends all three from one attitude Block update, so their Sample arrays
 * are index-aligned and share receive timestamps — roll's timestamps serve as
 * the subplot's shared X values. Colors are nvx design tokens (primary /
 * success / warning).
 */
const ATTITUDE_SERIES = [
  { id: 'attitude.roll', labelKey: 'charts.attitude.roll', color: '#2B5CE6' },
  { id: 'attitude.pitch', labelKey: 'charts.attitude.pitch', color: '#1E9E6A' },
  { id: 'attitude.yaw', labelKey: 'charts.attitude.yaw', color: '#D97706' },
] as const

/**
 * Telemetry Charts page. Reads the History Buffer directly (it is not
 * reactive — see `ConnectionState.history`), using `useTelemetry`'s throttled
 * re-renders as the redraw trigger, so the chart advances at the data's real
 * arrival rate and freezes the moment the session ends. History recorded
 * before this page mounts is picked up on first render, and the placeholder
 * only appears when there is truly nothing to show: not connected AND no
 * recorded history.
 */
export function ChartsPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const session = useConnectionStore((s) => s.session)
  const history = useConnectionStore((s) => s.history)

  // Redraw trigger only — the snapshot itself isn't read; the Recorder has
  // already turned it into Samples by the time this notification fires.
  useTelemetry(session)

  const timestampsMs = history.getSamples(ATTITUDE_SERIES[0].id).map((s) => s.ts)
  const hasHistory = timestampsMs.length > 0

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

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <div className="mb-3.5 flex items-baseline">
        <span className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.charts')}</span>
      </div>
      <div className="rounded-xl border border-nvx-border bg-white p-4 shadow-card">
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('charts.attitude.title')}</span>
          <span className="font-mono text-[10.5px] text-nvx-faint">{t('charts.attitude.unit')}</span>
        </div>
        <ChartHost
          timestampsMs={timestampsMs}
          series={ATTITUDE_SERIES.map((def) => ({
            label: t(def.labelKey),
            color: def.color,
            values: history.getSamples(def.id).map((s) => s.value),
          }))}
          windowSec={RETENTION_MS / 1000}
        />
      </div>
    </div>
  )
}
