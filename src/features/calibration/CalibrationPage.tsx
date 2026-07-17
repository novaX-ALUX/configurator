import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { useAccelCalibration } from './useAccelCalibration'
import { useCompassCalibration } from './useCompassCalibration'
import { AccelCard } from './AccelCard'
import { CompassCard } from './CompassCard'
import { OrientationNote } from './OrientationNote'

/**
 * Sensor Calibration page (Task 8.3) -- wires Task 8.1's `AccelCalibration`
 * and Task 8.2's `MagCalibration` behind the anti-silent-write review gate:
 * the compass card never writes a single `COMPASS_*` parameter before the
 * user reviews the before/after diff and clicks through (`CompassCard`,
 * `useCompassCalibration`). See `docs/design/novaX-Configurator.dc.html`'s
 * Calibration screen for the visual source of truth.
 *
 * The empty state below only gates on `phase`, same as Dashboard/Setup
 * -- *except* it also checks each card's own `interrupted` latch first: if a
 * calibration was cut short by the link dropping, the page must
 * keep showing that card's interrupt banner (task brief's link-state
 * cross-reference) rather than falling back to "needs a connected board",
 * even once `phase` has fully unwound to `'disconnected'`.
 */
export function CalibrationPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const session = useConnectionStore((s) => s.session)
  const paramStore = useConnectionStore((s) => s.paramStore)

  const accel = useAccelCalibration(session, phase)
  const compass = useCompassCalibration(session, paramStore, phase)

  const connected = phase === 'connected'
  // Only the true "nothing has happened yet" case falls back to the generic
  // empty state -- any other status (running/busy/done/failed/review/
  // accepting/applied/unconfirmed) must keep the connected layout mounted so
  // its card can keep showing its own honest state (including each card's
  // own `interrupted` banner) even once `phase` has fully unwound to
  // 'disconnected'. Gating this on `interrupted` alone (an earlier version
  // of this check) missed the window between clicking "Write offsets to
  // board" and accept()'s own ACK arriving: a link drop there left `status`
  // at 'accepting' (not 'running'/'review', the only two `interrupted`
  // latches on), so the whole page would fall back to "needs a connected
  // board" and hide the compass card right as it was about to reveal
  // whether the write actually landed -- the single most safety-critical
  // moment this feature has.
  const showEmptyState = !connected && accel.status === 'idle' && compass.status === 'idle'

  if (showEmptyState) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        <div className="flex h-[74px] w-[74px] items-center justify-center rounded-[22px] border border-nvx-border bg-white text-nvx-faint shadow-card">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <circle cx="12" cy="12" r="7" />
            <path d="M12 2.75v3M12 18.25v3M2.75 12h3M18.25 12h3" />
            <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
          </svg>
        </div>
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('calibration.notConnectedTitle')}</div>
        <div className="max-w-[400px] text-center text-[13px] leading-relaxed text-nvx-muted">{t('calibration.notConnectedBody')}</div>
        <button
          type="button"
          disabled={phase !== 'disconnected'}
          onClick={() => void connect(baud)}
          className="rounded-[10px] bg-nvx-primary px-[22px] py-2.5 text-[13px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('calibration.connectCta')}
        </button>
      </div>
    )
  }

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <div className="mb-1 flex items-baseline">
        <span className="font-heading text-[19px] font-bold text-nvx-text">{t('calibration.title')}</span>
        <span className="ml-auto text-[12px] text-nvx-faint">{t('calibration.titleNote')}</span>
      </div>
      <p className="mb-4 text-[12.5px] text-nvx-subtle">{t('calibration.subtitle')}</p>

      <div className="grid grid-cols-2 items-start gap-4">
        <AccelCard accel={accel} connected={connected} />
        <CompassCard compass={compass} connected={connected} />
      </div>

      <OrientationNote paramStore={paramStore} />

      <div className="mt-3.5 flex items-center gap-1.5 text-[11.5px] text-nvx-faint">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="8.25" />
          <path d="M8.5 12.3l2.4 2.4 4.6-5" />
        </svg>
        {t('calibration.principle')}
      </div>
    </div>
  )
}
