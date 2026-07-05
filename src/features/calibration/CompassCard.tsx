import { useTranslation } from 'react-i18next'
import type { CompassCalState } from './useCompassCalibration'
import { CompassReviewTable } from './CompassReviewTable'
import type { CompassDiff } from '../../core/mavlink/magCal'

/** `completion_pct` (0-100) -> conic-gradient sweep in degrees. */
function ringDeg(pct: number): string {
  return `${Math.max(0, Math.min(100, pct)) * 3.6}deg`
}

/** `COMPASS_OFS{,2,3}_X/Y/Z = x / y / z` summary line for the applied/unconfirmed state -- same fields the design mock's "applied" block shows. */
function offsetSummary(diffs: CompassDiff[]): string {
  const x = diffs.find((d) => d.param.includes('OFS') && d.param.endsWith('X'))?.new
  const y = diffs.find((d) => d.param.includes('OFS') && d.param.endsWith('Y'))?.new
  const z = diffs.find((d) => d.param.includes('OFS') && d.param.endsWith('Z'))?.new
  return [x, y, z].map((v) => (v === undefined ? '—' : Number.isInteger(v) ? v : v.toFixed(3))).join(' / ')
}

interface CompassCardProps {
  compass: CompassCalState
  connected: boolean
}

export function CompassCard({ compass, connected }: CompassCardProps) {
  const { t } = useTranslation()
  const { status, progress, reports, diffs, disclosure, acceptError, undoError, error, interrupted, start, cancel, accept, undo } = compass

  const sortedProgress = [...progress.entries()].sort(([a], [b]) => a - b)
  const sortedDiffs = [...diffs.entries()].sort(([a], [b]) => a - b)

  return (
    <div className="rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-1.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('calibration.compass.sectionTitle')}</span>
        {(status === 'applied' || status === 'unconfirmed') && (
          <span className="ml-auto rounded-full bg-nvx-successSoft px-2.5 py-1 text-[11px] font-extrabold text-nvx-successText">
            {t('calibration.compass.appliedBadge')}
          </span>
        )}
      </div>

      {interrupted ? (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-nvx-dangerBorder bg-nvx-dangerSoft px-3.5 py-2.5 text-nvx-dangerHover">
          <p className="text-[12.5px] font-semibold leading-relaxed">{t('calibration.compass.interrupted')}</p>
          <button
            type="button"
            disabled={!connected}
            onClick={cancel}
            className="ml-auto flex-none rounded-lg border border-nvx-dangerBorder px-3 py-[7px] text-[11.5px] font-bold text-nvx-dangerHover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('calibration.compass.restartCta')}
          </button>
        </div>
      ) : status === 'idle' || status === 'failed' ? (
        <>
          {status === 'failed' && <p className="mb-2 text-[12px] font-semibold text-nvx-danger">{t('calibration.compass.failed')}</p>}
          {error && <p className="mb-2 text-[11.5px] text-nvx-danger">{error}</p>}
          <p className="my-2.5 text-[12.5px] leading-relaxed text-nvx-muted">{t('calibration.compass.idleBody')}</p>
          <button
            type="button"
            disabled={!connected}
            onClick={start}
            className="rounded-[9px] bg-nvx-primary px-[18px] py-2.5 text-[12.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('calibration.compass.startCta')}
          </button>
        </>
      ) : status === 'running' ? (
        <>
          {disclosure && <p className="mb-2.5 rounded-lg bg-nvx-primarySoft px-2.5 py-2 text-[11.5px] text-nvx-primarySoftText">{disclosure}</p>}
          {sortedProgress.length === 0 ? (
            <p className="text-[12.5px] text-nvx-muted">{t('calibration.compass.samplingTitle')}</p>
          ) : (
            sortedProgress.map(([compassId, p]) => (
              <div key={compassId} className="mt-3 flex items-center gap-4">
                <div
                  className="relative h-[110px] w-[110px] flex-none rounded-full"
                  style={{ background: `conic-gradient(#2B5CE6 ${ringDeg(p.completionPct)}, #EFF2F6 0)` }}
                >
                  <div className="absolute inset-2.5 flex flex-col items-center justify-center rounded-full bg-white">
                    <span className="font-mono text-[20px] font-semibold">{Math.round(p.completionPct)}%</span>
                    <span className="text-[10px] text-nvx-faint">{t('calibration.compass.samplingPct')}</span>
                  </div>
                </div>
                <div className="flex-1">
                  <div className="text-[13px] font-bold">{t('calibration.compass.compassLabel', { id: compassId })}</div>
                  <div className="mb-0.5 text-[13px] font-bold">{t('calibration.compass.samplingTitle')}</div>
                  <div className="text-[12px] leading-snug text-nvx-muted">{t('calibration.compass.samplingBody')}</div>
                </div>
              </div>
            ))
          )}
          <button
            type="button"
            onClick={cancel}
            className="mt-3.5 rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2.5 text-[12.5px] font-semibold text-nvx-text hover:bg-nvx-field"
          >
            {t('calibration.compass.cancelCta')}
          </button>
        </>
      ) : status === 'review' || status === 'accepting' ? (
        <>
          <p className="mb-2.5 text-[11.5px] text-nvx-subtle">{t('calibration.compass.reviewNote')}</p>
          {acceptError?.kind === 'ack-rejected' && (
            <p className="mb-2.5 text-[11.5px] font-semibold text-nvx-danger">{t('calibration.compass.ackRejected')}</p>
          )}
          {sortedDiffs.map(([compassId, rowDiffs]) => (
            <CompassReviewTable key={compassId} compassId={compassId} diffs={rowDiffs} fitness={reports.get(compassId)?.fitness ?? 0} />
          ))}
          <div className="flex gap-2.5">
            <button
              type="button"
              disabled={status === 'accepting'}
              onClick={accept}
              className="rounded-[9px] bg-nvx-primary px-[18px] py-2.5 text-[12.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('calibration.compass.writeCta')}
            </button>
            <button
              type="button"
              disabled={status === 'accepting'}
              onClick={cancel}
              className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2.5 text-[12.5px] font-semibold text-nvx-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('calibration.compass.discardCta')}
            </button>
          </div>
        </>
      ) : (
        // 'applied' | 'unconfirmed'
        <>
          <p className="my-2.5 text-[12.5px] leading-relaxed text-nvx-muted">
            {status === 'unconfirmed' ? t('calibration.compass.confirmFailed') : t('calibration.compass.appliedBody')}
          </p>
          {sortedDiffs.map(([compassId, rowDiffs]) => (
            <div key={compassId} className="mb-2 rounded-lg bg-nvx-field px-3 py-2 font-mono text-[12px] text-nvx-text">
              {t('calibration.compass.compassLabel', { id: compassId })}: COMPASS_OFS X/Y/Z = {offsetSummary(rowDiffs)}
            </div>
          ))}
          {undoError && <p className="mb-2 text-[11.5px] font-semibold text-nvx-danger">{t('calibration.compass.undoError', { message: undoError })}</p>}
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={undo}
              className="rounded-[9px] border border-nvx-borderStrong bg-white px-4 py-2.5 text-[12.5px] font-bold text-nvx-text hover:bg-nvx-field"
            >
              {t('calibration.compass.undoCta')}
            </button>
            <button
              type="button"
              disabled={!connected}
              onClick={start}
              className="rounded-[9px] px-3.5 py-2.5 text-[12.5px] font-semibold text-nvx-subtle hover:bg-nvx-field disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('calibration.compass.recalibrateCta')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
