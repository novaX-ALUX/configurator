import { useTranslation } from 'react-i18next'
import type { TelemetryState } from '../../core/mavlink/telemetry'
import { OfflineChip } from '../../layout/OfflineChip'
import { pctFromUs } from './dashboardUtils'

/** Task brief: "8 channel bars + raw PWM" — RC_CHANNELS carries up to 18, this shows CH1-8. */
const RC_CHANNEL_COUNT = 8

interface RcChannelsCardProps {
  rc?: TelemetryState['rc']
  /** UI G5 (issue #10): renders an explicit "Offline" chip instead of pretending the "no telemetry yet" fallback below is live data. */
  offline?: boolean
}

export function RcChannelsCard({ rc, offline = false }: RcChannelsCardProps) {
  const { t } = useTranslation()

  return (
    <div className="mt-4 rounded-xl border border-nvx-border bg-white p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('dashboard.rc.title')}</span>
        <OfflineChip active={offline} label={t('dashboard.offline')} />
      </div>
      {!rc ? (
        <p className="text-[12px] text-nvx-faint">{t('dashboard.rc.noData')}</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-8 gap-y-2.5">
          {Array.from({ length: RC_CHANNEL_COUNT }, (_, i) => {
            const raw = rc.channels[i] ?? 0
            const pct = pctFromUs(raw)
            return (
              <div key={i} className="grid grid-cols-[74px_1fr_42px] items-center gap-2.5">
                <span className="font-mono text-[10.5px] text-nvx-subtle">{t('dashboard.rc.channel', { n: i + 1 })}</span>
                <div className="h-[7px] overflow-hidden rounded bg-nvx-field">
                  <div className="h-full rounded bg-nvx-primary" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-right font-mono text-[11.5px] text-nvx-text">{raw}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
