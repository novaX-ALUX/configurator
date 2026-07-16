import { useTranslation } from 'react-i18next'
import type { TelemetryState } from '../../core/mavlink/telemetry'
import { OfflineChip } from '../../layout/OfflineChip'
import { gpsFixTier, type GpsFixTier } from './dashboardUtils'

interface GpsCardProps {
  gps?: TelemetryState['gps']
  /** UI G5 (issue #10): takes the same header slot as the fix badge below — `gps` is always undefined while offline, so the two never compete. */
  offline?: boolean
}

const FIX_BADGE_CLASSES: Record<GpsFixTier, string> = {
  none: 'bg-nvx-dangerSoft text-nvx-dangerHover',
  '2d': 'bg-nvx-warningSoft text-nvx-warningText',
  '3d': 'bg-nvx-successSoft text-nvx-successText',
}

export function GpsCard({ gps, offline = false }: GpsCardProps) {
  const { t } = useTranslation()
  const tier = gps ? gpsFixTier(gps.fixType) : 'none'

  return (
    <div className="flex flex-col rounded-xl border border-nvx-border bg-white p-4 shadow-card">
      <div className="flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('dashboard.gps.title')}</span>
        {gps && <span className={`ml-auto rounded-full px-2.5 py-1 text-[11px] font-extrabold ${FIX_BADGE_CLASSES[tier]}`}>{t(`dashboard.gps.fix.${tier}`)}</span>}
        <OfflineChip active={offline} label={t('dashboard.offline')} className="ml-auto" />
      </div>
      {gps ? (
        <div className="mt-2.5 flex items-baseline gap-3">
          <span className="font-mono text-[27px] font-semibold text-nvx-text">
            {gps.satellites}
            <span className="text-[13px] text-nvx-faint"> {t('dashboard.gps.sats')}</span>
          </span>
          <span className="font-mono text-[12px] text-nvx-muted">{t('dashboard.gps.hdop', { value: gps.hdop !== undefined ? gps.hdop.toFixed(1) : '—' })}</span>
        </div>
      ) : (
        <div className="mt-2.5 text-[12px] text-nvx-faint">{t('dashboard.gps.noFix')}</div>
      )}
    </div>
  )
}
