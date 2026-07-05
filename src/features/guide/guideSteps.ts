import type { PageId } from '../../store/navigation'

/**
 * Pure derivation for the Setup Guide drawer's 5 steps (Task 10.1) -- no
 * React, no i18n, per the same "pure data + types" split
 * `features/setup/paramEnums.ts` uses. `SetupGuideDrawer.tsx` is the only
 * caller: it reads the live store flags, resolves the two board-derived
 * labels (frame/ESC) via `t()`, and passes everything in here as one flat
 * `GuideStepInputs`. Every `done` flag below is a plain read of state some
 * other feature already owns (`setupStore`'s `frameEscTouched`/`fsTouched`,
 * `useCalibrationProgress`'s `accelDone`/`compassApplied`,
 * `motorTestStore`'s `motorsTested`, `useConnectionStore`'s `phase`) --
 * nothing here ever calls a setter, stages a param, or sends a command,
 * which is the whole point of a "read-only" guide.
 *
 * Step order and `page` targets are exactly the task brief's ①-⑤: connect ->
 * frame/ESC -> calibrate -> motor test -> failsafes. Note step ② and ⑤ both
 * route to `'setup'` (frame/ESC and failsafes are both fields on the same
 * Setup page) -- not a typo, matches the design mock's own `go` targets.
 */
export type GuideStepId = 'connect' | 'frameEsc' | 'calibrate' | 'motorTest' | 'failsafes'

export interface GuideStepInputs {
  /** `useConnectionStore().phase === 'connected'`. */
  connected: boolean
  /** `paramStore.all.size` -- 0 before any fetch, or when `paramStore` is `null`. */
  paramCount: number
  /** Translated frame label (e.g. "Quad X"), or `null` if `FRAME_CLASS`/`FRAME_TYPE` haven't been read from the board yet. */
  frameLabel: string | null
  /** Translated ESC protocol label (e.g. "DShot300"), or `null` if `MOT_PWM_TYPE` hasn't been read yet. */
  escLabel: string | null
  /** `setupStore.frameEscTouched`. */
  frameEscTouched: boolean
  /** `useCalibrationProgress.accelDone`. */
  accelDone: boolean
  /** `useCalibrationProgress.compassApplied`. */
  compassApplied: boolean
  /** `motorTestStore.motorsTested`. */
  motorsTested: boolean
  /** `setupStore.fsTouched`. */
  fsTouched: boolean
}

export interface GuideStep {
  id: GuideStepId
  /** 1-based step number shown in the numbered circle. */
  n: number
  titleKey: string
  descKey: string
  descOptions: Record<string, string | number>
  done: boolean
  page: PageId
}

export function buildGuideSteps(inputs: GuideStepInputs): GuideStep[] {
  return [
    {
      id: 'connect',
      n: 1,
      titleKey: 'guide.steps.connect.title',
      page: 'dashboard',
      done: inputs.connected,
      descKey: inputs.connected ? 'guide.steps.connect.desc' : 'guide.steps.connect.descPending',
      descOptions: { count: inputs.paramCount },
    },
    {
      id: 'frameEsc',
      n: 2,
      titleKey: 'guide.steps.frameEsc.title',
      page: 'setup',
      done: inputs.frameEscTouched,
      descKey: inputs.frameLabel && inputs.escLabel ? 'guide.steps.frameEsc.desc' : 'guide.steps.frameEsc.descPending',
      descOptions: { frame: inputs.frameLabel ?? '', esc: inputs.escLabel ?? '' },
    },
    {
      id: 'calibrate',
      n: 3,
      titleKey: 'guide.steps.calibrate.title',
      page: 'calibration',
      done: inputs.accelDone && inputs.compassApplied,
      descKey: !inputs.accelDone
        ? 'guide.steps.calibrate.descTodo'
        : inputs.compassApplied
          ? 'guide.steps.calibrate.descDone'
          : 'guide.steps.calibrate.descAccelOnly',
      descOptions: {},
    },
    {
      id: 'motorTest',
      n: 4,
      titleKey: 'guide.steps.motorTest.title',
      page: 'motors',
      done: inputs.motorsTested,
      descKey: inputs.motorsTested ? 'guide.steps.motorTest.descDone' : 'guide.steps.motorTest.descTodo',
      descOptions: {},
    },
    {
      id: 'failsafes',
      n: 5,
      titleKey: 'guide.steps.failsafes.title',
      page: 'setup',
      done: inputs.fsTouched,
      descKey: 'guide.steps.failsafes.desc',
      descOptions: {},
    },
  ]
}
