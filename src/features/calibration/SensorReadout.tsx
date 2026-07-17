import { useTranslation } from 'react-i18next'
import type { TelemetryState } from '../../core/mavlink/telemetry'

const AXES = ['X', 'Y', 'Z'] as const

interface ReadoutGroupProps {
  label: string
  /** Axis values in X/Y/Z order; `undefined` renders the em-dash placeholder (same convention as the Dashboard cards). */
  values: [number | undefined, number | undefined, number | undefined]
  decimals: number
}

function ReadoutGroup({ label, values, decimals }: ReadoutGroupProps) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-[11px] font-bold text-nvx-muted">{label}</span>
      {AXES.map((axis, i) => (
        <span key={axis} className="font-mono text-[13px] text-nvx-text">
          <span className="mr-1 text-[10.5px] text-nvx-faint">{axis}</span>
          {values[i] !== undefined ? values[i].toFixed(decimals) : '—'}
        </span>
      ))}
    </div>
  )
}

interface SensorReadoutProps {
  imu: TelemetryState['imu'] | undefined
}

/**
 * Issue #53 (UI audit C1): read-only live accel/gyro readout above the
 * calibration cards, so the user can confirm "sensor alive, noise sane"
 * before touching anything. Pure display over the Telemetry Snapshot's
 * `imu` block (RAW_IMU) — it never interacts with the calibration state
 * machines below it. With no data yet (or after a disconnect froze the
 * snapshot without an `imu` block ever arriving) every axis shows an
 * em-dash, never a fabricated zero.
 */
export function SensorReadout({ imu }: SensorReadoutProps) {
  const { t } = useTranslation()

  return (
    <div className="mb-4 rounded-xl border border-nvx-border bg-white px-[18px] py-3 shadow-card">
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('calibration.sensors.sectionTitle')}</span>
        <ReadoutGroup label={t('calibration.sensors.accelLabel')} values={[imu?.accX, imu?.accY, imu?.accZ]} decimals={2} />
        <ReadoutGroup label={t('calibration.sensors.gyroLabel')} values={[imu?.gyroX, imu?.gyroY, imu?.gyroZ]} decimals={1} />
      </div>
      <p className="mt-1 text-[11.5px] text-nvx-faint">{t('calibration.sensors.hint')}</p>
    </div>
  )
}
