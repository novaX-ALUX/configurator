import type { PageId } from '../../store/navigation'

/**
 * Pure derivation for the Setup Guide's 6 steps (Task 10.1) -- no
 * React, no i18n, per the same "pure data + types" split
 * `features/setup/paramEnums.ts` uses. `SetupGuideDrawer.tsx` is the only
 * caller: it reads the live store flags, resolves the two board-derived
 * labels (frame/ESC) via `t()`, and passes everything in here as one flat
 * `GuideStepInputs`. Every `done` flag below is a plain read of state some
 * other feature already owns (`setupStore`'s `frameEscTouched`/`fsTouched`,
 * `useCalibrationProgress`'s `accelDone`/`compassApplied`,
 * `motorTestStore`'s `motorsTested`, `useConnectionStore`'s `phase`,
 * `tuningStore`'s `initialTuneStaged`) -- nothing here ever calls a setter,
 * stages a param, or sends a command, which is the whole point of a
 * "read-only" guide.
 *
 * Step order and `page` targets are the task brief's ①-⑤ (connect ->
 * frame/ESC -> calibrate -> motor test -> failsafes) plus issue #41's ⑥
 * initial tune, appended last per ArduPilot's initial-parameters guidance
 * (the starting tune is the final pre-maiden step, after all bench setup).
 * Note step ② and ⑤ both route to `'setup'` (frame/ESC and failsafes are
 * both fields on the same Setup page) -- not a typo, matches the design
 * mock's own `go` targets.
 *
 * **Known limitation: 5 of 6 `done` flags are session-scoped, not
 * board-derived.** `frameEscTouched`/`fsTouched` (Task 7.2), `accelDone`/
 * `compassApplied` (`calibrationProgress.ts`), and `motorsTested`
 * (`motorTestStore.ts`) are all plain booleans latched by *this session's*
 * UI actions and never reset on disconnect/reconnect -- inherited from Task
 * 7.2's own precedent (that module's doc explicitly chose this over a
 * board read). Only step ①'s `paramCount` and step ②'s frame/ESC *labels*
 * (not its `done` flag) are actual live reads of the connected board. A
 * board swap mid-session (disconnect one flight controller, connect a
 * different one without reloading the page) will still show steps ②-④ as
 * done from the *previous* board -- the guide's read-only promise stays
 * true (nothing is written), but this is a known staleness gap, not
 * "detected from the board" in the literal sense. A future fix would need
 * genuine board-side detection (e.g. reading `INS_ACCOFFS_*`/
 * `COMPASS_OFS_*` non-default, or clearing these flags on a new `session`
 * identity) -- out of scope for Task 10.1.
 */
export type GuideStepId = 'connect' | 'frameEsc' | 'calibrate' | 'motorTest' | 'failsafes' | 'initialTune'

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
  /** `tuningStore.initialTuneStaged`. */
  initialTuneStaged: boolean
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
    {
      id: 'initialTune',
      n: 6,
      titleKey: 'guide.steps.initialTune.title',
      page: 'tuning',
      done: inputs.initialTuneStaged,
      descKey: inputs.initialTuneStaged ? 'guide.steps.initialTune.descDone' : 'guide.steps.initialTune.descTodo',
      descOptions: {},
    },
  ]
}
