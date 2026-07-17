import { describe, expect, it } from 'vitest'
import { buildGuideSteps, type GuideStepInputs } from '../guideSteps'

function inputs(overrides: Partial<GuideStepInputs> = {}): GuideStepInputs {
  return {
    connected: false,
    paramCount: 0,
    frameLabel: null,
    escLabel: null,
    frameEscTouched: false,
    accelDone: false,
    compassApplied: false,
    motorsTested: false,
    fsTouched: false,
    initialTuneStaged: false,
    ...overrides,
  }
}

describe('buildGuideSteps', () => {
  it('returns exactly the 6 steps in order, with their routing target pages', () => {
    const steps = buildGuideSteps(inputs())
    expect(steps.map((s) => s.id)).toEqual(['connect', 'frameEsc', 'calibrate', 'motorTest', 'failsafes', 'initialTune'])
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6])
    expect(steps.map((s) => s.page)).toEqual(['dashboard', 'setup', 'calibration', 'motors', 'setup', 'tuning'])
  })

  it('all 6 steps start not-done when every input is false/empty', () => {
    const steps = buildGuideSteps(inputs())
    expect(steps.every((s) => !s.done)).toBe(true)
  })

  describe('step 1 — connect & fetch parameters', () => {
    it('done iff connected, regardless of paramCount', () => {
      expect(buildGuideSteps(inputs({ connected: true, paramCount: 0 }))[0].done).toBe(true)
      expect(buildGuideSteps(inputs({ connected: false, paramCount: 900 }))[0].done).toBe(false)
    })

    it('description reflects the pending/connected split and carries the param count', () => {
      const pending = buildGuideSteps(inputs({ connected: false }))[0]
      expect(pending.descKey).toBe('guide.steps.connect.descPending')

      const connected = buildGuideSteps(inputs({ connected: true, paramCount: 743 }))[0]
      expect(connected.descKey).toBe('guide.steps.connect.desc')
      expect(connected.descOptions).toEqual({ count: 743 })
    })
  })

  describe('step 2 — frame & ESC protocol', () => {
    it('done is driven by setupStore.frameEscTouched, NOT by connected (the design mock\'s own placeholder bug)', () => {
      // Connected but never touched Setup's frame/ESC fields -- must be false.
      expect(buildGuideSteps(inputs({ connected: true, frameEscTouched: false }))[1].done).toBe(false)
      // Touched (staged a frame/ESC field) even while since-disconnected -- must stay true.
      expect(buildGuideSteps(inputs({ connected: false, frameEscTouched: true }))[1].done).toBe(true)
    })

    it('shows the read frame/ESC labels once both are known, else a pending message', () => {
      const pending = buildGuideSteps(inputs({ frameLabel: null, escLabel: 'DShot300' }))[1]
      expect(pending.descKey).toBe('guide.steps.frameEsc.descPending')

      const known = buildGuideSteps(inputs({ frameLabel: 'Quad X', escLabel: 'DShot300' }))[1]
      expect(known.descKey).toBe('guide.steps.frameEsc.desc')
      expect(known.descOptions).toEqual({ frame: 'Quad X', esc: 'DShot300' })
    })

    it('routes to the setup page', () => {
      expect(buildGuideSteps(inputs())[1].page).toBe('setup')
    })
  })

  describe('step 3 — calibrate sensors', () => {
    it('done only when BOTH accelDone AND compassApplied', () => {
      expect(buildGuideSteps(inputs({ accelDone: true, compassApplied: false }))[2].done).toBe(false)
      expect(buildGuideSteps(inputs({ accelDone: false, compassApplied: true }))[2].done).toBe(false)
      expect(buildGuideSteps(inputs({ accelDone: true, compassApplied: true }))[2].done).toBe(true)
    })

    it('description has 3 distinct states: neither done, accel-only, both done', () => {
      expect(buildGuideSteps(inputs({ accelDone: false, compassApplied: false }))[2].descKey).toBe('guide.steps.calibrate.descTodo')
      expect(buildGuideSteps(inputs({ accelDone: true, compassApplied: false }))[2].descKey).toBe('guide.steps.calibrate.descAccelOnly')
      expect(buildGuideSteps(inputs({ accelDone: true, compassApplied: true }))[2].descKey).toBe('guide.steps.calibrate.descDone')
    })

    it('routes to the calibration page', () => {
      expect(buildGuideSteps(inputs())[2].page).toBe('calibration')
    })
  })

  describe('step 4 — test motor order & direction', () => {
    it('done iff motorsTested', () => {
      expect(buildGuideSteps(inputs({ motorsTested: false }))[3].done).toBe(false)
      expect(buildGuideSteps(inputs({ motorsTested: true }))[3].done).toBe(true)
    })

    it('routes to the motors page', () => {
      expect(buildGuideSteps(inputs())[3].page).toBe('motors')
    })
  })

  describe('step 5 — failsafes', () => {
    it('done iff setupStore.fsTouched', () => {
      expect(buildGuideSteps(inputs({ fsTouched: false }))[4].done).toBe(false)
      expect(buildGuideSteps(inputs({ fsTouched: true }))[4].done).toBe(true)
    })

    it('routes to the setup page', () => {
      expect(buildGuideSteps(inputs())[4].page).toBe('setup')
    })
  })

  describe('step 6 — initial tune', () => {
    it('done iff tuningStore.initialTuneStaged', () => {
      expect(buildGuideSteps(inputs({ initialTuneStaged: false }))[5].done).toBe(false)
      expect(buildGuideSteps(inputs({ initialTuneStaged: true }))[5].done).toBe(true)
    })

    it('description reflects the todo/done split', () => {
      expect(buildGuideSteps(inputs({ initialTuneStaged: false }))[5].descKey).toBe('guide.steps.initialTune.descTodo')
      expect(buildGuideSteps(inputs({ initialTuneStaged: true }))[5].descKey).toBe('guide.steps.initialTune.descDone')
    })

    it('routes to the tuning page', () => {
      expect(buildGuideSteps(inputs())[5].page).toBe('tuning')
    })
  })

  it('progress: counts only steps whose done flag is true', () => {
    const steps = buildGuideSteps(inputs({ connected: true, frameEscTouched: true, accelDone: true, compassApplied: false, motorsTested: false, fsTouched: true }))
    const doneCount = steps.filter((s) => s.done).length
    expect(doneCount).toBe(3) // connect, frameEsc, failsafes -- not calibrate (compass still pending) or motorTest
  })
})
