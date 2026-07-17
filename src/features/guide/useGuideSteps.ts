import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParamStore } from '../../core/mavlink/params'
import { useConnectionStore } from '../../store/connection'
import { useSetupStore } from '../setup/setupStore'
import { ESC_PROTOCOL_FIELD, FRAME_FIELD } from '../setup/paramEnums'
import { useCalibrationProgress } from '../calibration/calibrationProgress'
import { useMotorTestStore } from '../motors/motorTestStore'
import { useTuningStore } from '../tuning/tuningStore'
import { buildGuideSteps, type GuideStep } from './guideSteps'

export const TOTAL_STEPS = 6

/** Resolves the board's current frame tile (Setup's `FRAME_CLASS`/`FRAME_TYPE`, Task 7.1) to a translated label, or `null` if not read yet — same lookup `MotorTestPage.tsx`'s `resolveFrameOption` does, just display-only here (never written). */
function frameLabel(paramStore: ParamStore | null, t: (k: string) => string): string | null {
  const frameClass = paramStore?.get('FRAME_CLASS')?.value
  const frameType = paramStore?.get('FRAME_TYPE')?.value
  const option = FRAME_FIELD.options.find((o) => o.frameClass === frameClass && o.frameType === frameType)
  return option ? t(option.labelKey) : null
}

/** Same idea for the ESC protocol (`MOT_PWM_TYPE`). */
function escLabel(paramStore: ParamStore | null, t: (k: string) => string): string | null {
  const value = paramStore?.get(ESC_PROTOCOL_FIELD.param)?.value
  const option = ESC_PROTOCOL_FIELD.options.find((o) => o.value === value)
  return option ? t(option.labelKey) : null
}

/**
 * The one live-derivation seam for the guide's 6 steps: gathers every store
 * flag `buildGuideSteps` needs (`useConnectionStore`, `useSetupStore`,
 * `useCalibrationProgress`, `useMotorTestStore`, `useTuningStore`), resolves the two
 * board-derived labels via `t()`, and re-renders on late-arriving
 * PARAM_VALUEs. Extracted from `SetupGuideDrawer.tsx` for IA T2 (issue #44)
 * so the Home page renders the exact same step states as the drawer —
 * both call this, neither owns a private copy of the derivation.
 */
export function useGuideSteps(): GuideStep[] {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const paramStore = useConnectionStore((s) => s.paramStore)

  const frameEscTouched = useSetupStore((s) => s.frameEscTouched)
  const fsTouched = useSetupStore((s) => s.fsTouched)
  const accelDone = useCalibrationProgress((s) => s.accelDone)
  const compassApplied = useCalibrationProgress((s) => s.compassApplied)
  const rcCalApplied = useCalibrationProgress((s) => s.rcCalApplied)
  const motorsTested = useMotorTestStore((s) => s.motorsTested)
  const initialTuneStaged = useTuningStore((s) => s.initialTuneStaged)

  // `paramStore.get()` isn't itself reactive to values arriving after this
  // component has already rendered (a passively-received PARAM_VALUE, or a
  // fetchAll() triggered from Setup/Motor Test while the guide is open) --
  // same onChange + version-bump idiom SetupPage.tsx/MotorTestPage.tsx use.
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (!paramStore) return
    return paramStore.onChange(() => setVersion((v) => v + 1))
  }, [paramStore])

  return buildGuideSteps({
    connected: phase === 'connected',
    paramCount: paramStore?.all.size ?? 0,
    frameLabel: frameLabel(paramStore, t),
    escLabel: escLabel(paramStore, t),
    frameEscTouched,
    accelDone,
    compassApplied,
    rcCalApplied,
    motorsTested,
    fsTouched,
    initialTuneStaged,
  })
}
