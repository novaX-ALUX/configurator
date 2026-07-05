import { useTranslation } from 'react-i18next'
import type { TelemetryState } from '../../core/mavlink/telemetry'
import { arduCopterModeName } from './dashboardUtils'

interface VehicleCardProps {
  heartbeat?: TelemetryState['heartbeat']
  /** Pre-formatted display string (e.g. "Class 1") — DashboardPage resolves this from the cached FRAME_CLASS param, if any; omitted entirely when unknown rather than guessing. */
  frame?: string
  /** Latest "PreArm: ..." STATUSTEXT, if any — real data already captured by the connection store, not a fabricated "all checks passed" claim. */
  prearmText?: string
}

/**
 * VEHICLE card: armed pill + flight-mode chip (both from HEARTBEAT — see
 * `dashboardUtils.arduCopterModeName` for the custom_mode decode table),
 * plus optional frame/pre-arm lines passed in from whatever real data
 * DashboardPage already has cached (never derived from a guess).
 */
export function VehicleCard({ heartbeat, frame, prearmText }: VehicleCardProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col rounded-xl border border-nvx-border bg-white p-4 shadow-card">
      <div className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('dashboard.vehicle.title')}</div>
      <div className="mt-3 flex items-center gap-2.5">
        {heartbeat === undefined ? (
          <span className="rounded-full bg-nvx-field px-3.5 py-2 text-[13px] font-extrabold uppercase tracking-wide text-nvx-faint">
            {t('dashboard.vehicle.noHeartbeat')}
          </span>
        ) : heartbeat.armed ? (
          <span className="inline-flex items-center gap-2 rounded-full bg-nvx-dangerSoft px-3.5 py-2 text-[13px] font-extrabold uppercase tracking-wide text-nvx-dangerHover">
            <span className="h-2 w-2 rounded-full bg-nvx-danger" />
            {t('dashboard.vehicle.armed')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-full bg-nvx-successSoft px-3.5 py-2 text-[13px] font-extrabold uppercase tracking-wide text-nvx-successText">
            <span className="h-2 w-2 rounded-full bg-nvx-success" />
            {t('dashboard.vehicle.disarmed')}
          </span>
        )}
        {heartbeat && (
          <span className="rounded-full bg-nvx-primarySoft px-3 py-2 font-mono text-[12.5px] font-semibold text-nvx-primarySoftText">
            {arduCopterModeName(heartbeat.customMode)}
          </span>
        )}
      </div>
      {(prearmText || frame) && (
        <div className="mt-auto flex flex-col gap-1.5 pt-3 text-[12.5px]">
          {prearmText && <div className="font-semibold text-nvx-warningText">{prearmText}</div>}
          {frame && (
            <div className="flex text-nvx-subtle">
              <span>{t('dashboard.vehicle.frame')}</span>
              <span className="ml-auto font-mono text-nvx-text">{frame}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
