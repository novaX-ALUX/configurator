import { useTranslation } from 'react-i18next'
import type { CompassDiff } from '../../core/mavlink/magCal'

/**
 * Soft UI-only banding for the fitness badge -- distinct from the FC's own
 * pass/fail verdict (`MagCalReport.calStatus`, already handled upstream: a
 * `MAG_CAL_FAILED`/`_BAD_ORIENTATION`/`_BAD_RADIUS` report never reaches this
 * table at all, see `useCompassCalibration`'s running->review/failed effect).
 * This only flags a *technically-passing-but-mediocre* fit so the user can
 * choose to redo it anyway. Half of ArduPilot's own `COMPASS_CAL_FITNESS`
 * default (16, the value the FC itself uses to fail a calibration) is used
 * as the "good" ceiling -- comfortably under the FC's own threshold, not a
 * value from any source doc.
 */
const GOOD_FITNESS_MAX = 8

function formatDiffValue(value: number | undefined): string {
  if (value === undefined) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(3)
}

interface CompassReviewTableProps {
  compassId: number
  diffs: CompassDiff[]
  fitness: number
}

/**
 * Before/after diff table for one compass -- the anti-silent-write gate this
 * project exists for. Nothing here has been written yet (`buildReview`'s own
 * doc): `current` is whatever `ParamStore` already had cached, `new` is what
 * `accept()` is expected to make the FC write once the user clicks through.
 */
export function CompassReviewTable({ compassId, diffs, fitness }: CompassReviewTableProps) {
  const { t } = useTranslation()
  const fitnessGood = fitness <= GOOD_FITNESS_MAX

  return (
    <div className="mb-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11.5px] font-bold text-nvx-subtle">{t('calibration.compass.compassLabel', { id: compassId })}</span>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ${
            fitnessGood ? 'bg-nvx-successSoft text-nvx-successText' : 'bg-nvx-warningSoft text-nvx-warningText'
          }`}
        >
          {t(fitnessGood ? 'calibration.compass.fitnessGood' : 'calibration.compass.fitnessWarn', { value: fitness.toFixed(1) })}
        </span>
      </div>
      {!fitnessGood && (
        <p className="mb-2 text-[11.5px] text-nvx-warningText">{t('calibration.compass.fitnessWarnBody', { id: compassId })}</p>
      )}
      <div className="overflow-hidden rounded-[10px] border border-nvx-border">
        <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-2 bg-nvx-field px-3 py-[7px] text-[10px] font-extrabold tracking-[.1em] text-nvx-faint">
          <span>{t('calibration.compass.columnParam')}</span>
          <span>{t('calibration.compass.columnOnBoard')}</span>
          <span>{t('calibration.compass.columnNew')}</span>
        </div>
        {diffs.map((row) => (
          <div key={row.param} className="grid grid-cols-[1.4fr_1fr_1fr] gap-2 border-t border-nvx-border px-3 py-[7px] font-mono text-[12px]">
            <span className="text-nvx-muted">{row.param}</span>
            <span className="text-nvx-faint">{formatDiffValue(row.current)}</span>
            <span className="font-semibold text-nvx-text">{formatDiffValue(row.new)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
