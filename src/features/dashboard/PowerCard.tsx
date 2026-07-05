import { useTranslation } from 'react-i18next'
import type { TelemetryState } from '../../core/mavlink/telemetry'

interface PowerCardProps {
  power?: TelemetryState['power']
}

/** Real percent-based color tiers (not a guessed voltage range — see the card's own doc below). */
type BatteryTier = 'success' | 'warning' | 'danger'

function batteryTier(pct: number): BatteryTier {
  if (pct <= 20) return 'danger'
  if (pct <= 40) return 'warning'
  return 'success'
}

const BAR_CLASSES: Record<BatteryTier, string> = {
  success: 'bg-nvx-success',
  warning: 'bg-nvx-warning',
  danger: 'bg-nvx-danger',
}

/**
 * POWER card. Per the task brief's own correction: prefers SYS_STATUS's
 * `battery_remaining` for the percentage bar; if the board never sends it
 * (`undefined` — a real MAVLink sentinel per telemetry.ts, not "still
 * loading"), this shows voltage/current only and never fabricates a percent
 * from a guessed cell-count/voltage range (a 4S 13.2-16.8V assumption would
 * be wrong for any other cell count and is nowhere in the actual telemetry).
 */
export function PowerCard({ power }: PowerCardProps) {
  const { t } = useTranslation()
  const pct = power?.batteryRemaining

  return (
    <div className="flex flex-col rounded-xl border border-nvx-border bg-white p-4 shadow-card">
      <div className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('dashboard.power.title')}</div>
      <div className="mt-2.5 flex items-baseline gap-3">
        <span className="font-mono text-[27px] font-semibold text-nvx-text">
          {power?.voltage !== undefined ? power.voltage.toFixed(2) : '—'}
          <span className="text-[13px] text-nvx-faint"> V</span>
        </span>
        {power?.current !== undefined && <span className="font-mono text-[14px] text-nvx-muted">{power.current.toFixed(1)} A</span>}
      </div>
      {pct !== undefined ? (
        <>
          <div className="mt-2.5 h-2 overflow-hidden rounded bg-nvx-field">
            <div className={`h-full rounded ${BAR_CLASSES[batteryTier(pct)]}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-auto pt-2 font-mono text-[11px] text-nvx-faint">{t('dashboard.power.remaining', { pct })}</div>
        </>
      ) : (
        <div className="mt-auto pt-2 text-[11px] text-nvx-faint">{t('dashboard.power.noRemaining')}</div>
      )}
    </div>
  )
}
