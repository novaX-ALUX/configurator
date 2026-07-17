import { useTranslation } from 'react-i18next'
import type { TelemetryState } from '../../core/mavlink/telemetry'
import { OfflineChip } from '../../layout/OfflineChip'
import { useNavigationStore } from '../../store/navigation'
import { SENSOR_TILES, sensorTileStatus, type SensorTileStatus } from './dashboardUtils'

interface SensorsCardProps {
  sensors?: TelemetryState['sensors']
  /** UI G5 (issue #10): renders an explicit "Offline" chip alongside the (necessarily stale) tile colors below. */
  offline?: boolean
}

const STATUS_CLASSES: Record<SensorTileStatus, string> = {
  ok: 'bg-nvx-successSoft text-nvx-successText',
  attention: 'bg-nvx-dangerSoft text-nvx-dangerHover',
  disabled: 'bg-nvx-field text-nvx-faint',
  absent: 'bg-nvx-field text-nvx-faint',
}

/**
 * SENSORS card (issue #52, UI audit D2): six tiles — IMU / Compass / Baro /
 * GPS / OptFlow / Rangefinder — answering "what does this vehicle still
 * need?" at a glance. Green = OK, red = needs calibration/attention, gray =
 * absent (visibly gray, never hidden). Status derives from the Telemetry
 * Snapshot's `sensors` block (SYS_STATUS bitmasks — see
 * `dashboardUtils.sensorTileStatus` for the exact source fields); before the
 * first SYS_STATUS arrives every tile shows a gray em-dash, never a guess.
 *
 * The calibratable tiles (IMU, Compass) double as navigation to the
 * Calibration page. Read-only otherwise — the grid never commands anything.
 *
 * Deliberately NOT consulted: `calibrationProgress`'s `accelDone`/
 * `compassApplied` flags — those are monotonic "wizard finished this
 * session" markers, not health, and the SYS_STATUS health bits already turn
 * healthy once a calibration takes effect; blending the two sources could
 * only make the tiles contradict the vehicle's own report.
 */
export function SensorsCard({ sensors, offline = false }: SensorsCardProps) {
  const { t } = useTranslation()
  const setActivePage = useNavigationStore((s) => s.setActivePage)

  return (
    <div className="mt-4 rounded-xl border border-nvx-border bg-white p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('dashboard.sensors.title')}</span>
        <OfflineChip active={offline} label={t('dashboard.offline')} />
      </div>
      <div className="grid grid-cols-6 gap-2.5">
        {SENSOR_TILES.map((tile) => {
          const status = sensors ? sensorTileStatus(sensors, tile.mask) : undefined
          const tileClass = `flex flex-col items-center gap-1 rounded-lg px-2 py-3 ${STATUS_CLASSES[status ?? 'absent']}`
          const content = (
            <>
              <span className="text-[12.5px] font-extrabold">{t(`dashboard.sensors.${tile.key}`)}</span>
              <span className="text-[10.5px] font-semibold">{status ? t(`dashboard.sensors.status.${status}`) : '—'}</span>
            </>
          )
          return tile.calibratable ? (
            <button
              key={tile.key}
              type="button"
              onClick={() => setActivePage('calibration')}
              title={t('dashboard.sensors.openCalibration')}
              className={`${tileClass} transition-[filter] duration-200 ease-out hover:brightness-95 motion-reduce:transition-none`}
            >
              {content}
            </button>
          ) : (
            <div key={tile.key} className={tileClass}>
              {content}
            </div>
          )
        })}
      </div>
    </div>
  )
}
