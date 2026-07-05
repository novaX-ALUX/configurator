import { useTranslation } from 'react-i18next'
import { ACCEL_FACE_ORDER, type AccelCalState } from './useAccelCalibration'
import type { AccelFace } from '../../core/mavlink/accelCal'

/** Board-icon rotation per face -- same degrees as the design file's own `faceRots` (`docs/design/novaX-Configurator.dc.html`), which shares this exact face order. */
const FACE_ROTATION_DEG: Record<AccelFace, number> = {
  level: 0,
  left: 90,
  right: -90,
  nosedown: 60,
  noseup: -60,
  back: 180,
}

interface AccelCardProps {
  accel: AccelCalState
  /** Gates the idle/restart CTA -- starting a calibration (or restarting after an interrupt) needs a live session. */
  connected: boolean
}

export function AccelCard({ accel, connected }: AccelCardProps) {
  const { t } = useTranslation()
  const { status, currentFace, stepIndex, doneFaces, busy, interrupted, error, start, captureFace, abandon } = accel

  return (
    <div className="rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-1.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('calibration.accel.sectionTitle')}</span>
        {status === 'done' && !interrupted && (
          <span className="ml-auto rounded-full bg-nvx-successSoft px-2.5 py-1 text-[11px] font-extrabold text-nvx-successText">
            {t('calibration.accel.calibratedBadge')}
          </span>
        )}
      </div>

      {interrupted ? (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-nvx-dangerBorder bg-nvx-dangerSoft px-3.5 py-2.5 text-nvx-dangerHover">
          <p className="text-[12.5px] font-semibold leading-relaxed">{t('calibration.accel.interrupted')}</p>
          <button
            type="button"
            disabled={!connected}
            onClick={abandon}
            className="ml-auto flex-none rounded-lg border border-nvx-dangerBorder px-3 py-[7px] text-[11.5px] font-bold text-nvx-dangerHover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('calibration.accel.restartCta')}
          </button>
        </div>
      ) : status === 'idle' || status === 'done' || status === 'failed' ? (
        <>
          {status === 'failed' && error && <p className="mb-2 text-[12px] font-semibold text-nvx-danger">{t('calibration.accel.failed')}</p>}
          <p className="my-2.5 text-[12.5px] leading-relaxed text-nvx-muted">{t('calibration.accel.idleBody')}</p>
          <div className="my-2.5 flex items-center gap-2 rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-2.5 py-2 text-[11.5px] text-nvx-warningText">
            {t('calibration.accel.tableWarning')}
          </div>
          <button
            type="button"
            disabled={!connected}
            onClick={start}
            className="rounded-[9px] bg-nvx-primary px-[18px] py-2.5 text-[12.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('calibration.accel.startCta')}
          </button>
        </>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-4">
            <div className="flex h-[130px] w-[130px] flex-none items-center justify-center rounded-2xl bg-nvx-field">
              <div
                className="relative h-[52px] w-[74px] rounded-lg border-2 border-nvx-text bg-white shadow-card transition-transform duration-300"
                style={{ transform: `rotate(${currentFace ? FACE_ROTATION_DEG[currentFace] : 0}deg)` }}
              >
                <span className="absolute left-1/2 top-[-7px] h-[5px] w-3.5 -translate-x-1/2 rounded-sm bg-nvx-primary" />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[11px] text-nvx-faint">{t('calibration.accel.faceLabel', { n: stepIndex })}</div>
              <div className="my-0.5 font-heading text-[20px] font-bold text-nvx-text">
                {currentFace ? t(`calibration.accel.faces.${currentFace}`) : ''}
              </div>
              <div className="text-[12.5px] text-nvx-muted">
                {currentFace && t(`calibration.accel.hints.${currentFace}`)} {t('calibration.accel.hintSuffix')}
              </div>
              <div className="mt-2.5 flex gap-1.5">
                {ACCEL_FACE_ORDER.map((face, i) => (
                  <span
                    key={face}
                    className={`h-1.5 flex-1 rounded-[3px] ${i < doneFaces ? 'bg-nvx-success' : i === stepIndex - 1 ? 'bg-nvx-primary' : 'bg-nvx-border'}`}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3.5 flex items-center gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={captureFace}
              className="rounded-[9px] bg-nvx-primary px-[18px] py-2.5 text-[12.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? t('calibration.accel.capturing') : t('calibration.accel.captureCta')}
            </button>
            <button
              type="button"
              onClick={abandon}
              className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2.5 text-[12.5px] font-semibold text-nvx-text hover:bg-nvx-field"
            >
              {t('calibration.accel.cancelCta')}
            </button>
          </div>
          {error && <p className="mt-2 text-[11.5px] font-semibold text-nvx-danger">{error}</p>}
        </>
      )}
    </div>
  )
}
