import { useTranslation } from 'react-i18next'
import type { ParamStore } from '../../core/mavlink/params'

const AHRS_ORIENTATION_PARAM = 'AHRS_ORIENTATION'

interface OrientationNoteProps {
  paramStore: ParamStore | null
}

/**
 * Fills a gap the design mock leaves open (task brief): the calibration
 * screen never surfaces `AHRS_ORIENTATION`, even though a wrong board
 * orientation silently invalidates both the accel and compass results above
 * it. Read-only, no auto-fix -- just makes the current value visible so a
 * miswired build gets caught before the user spends 90 seconds on faces that
 * were never going to be right.
 */
export function OrientationNote({ paramStore }: OrientationNoteProps) {
  const { t } = useTranslation()
  const value = paramStore?.get(AHRS_ORIENTATION_PARAM)?.value

  return (
    <div className="mt-4 flex items-center gap-2 text-[11.5px] text-nvx-subtle">
      <span className="font-mono font-semibold text-nvx-faint">{t('calibration.orientation.label')}</span>
      <span className="font-mono">{value !== undefined ? value : t('calibration.orientation.unknown')}</span>
    </div>
  )
}
