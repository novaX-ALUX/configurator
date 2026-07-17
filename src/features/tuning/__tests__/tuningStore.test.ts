import { beforeEach, describe, expect, it } from 'vitest'
import { useTuningStore } from '../tuningStore'

beforeEach(() => {
  useTuningStore.setState({ pending: new Map(), writeStatus: new Map(), writing: false, initialTuneStaged: false })
})

describe('useTuningStore.initialTuneStaged (guide step 6 done-flag, issue #41)', () => {
  it('starts false and latches true when stageMany stages calculator suggestions', () => {
    expect(useTuningStore.getState().initialTuneStaged).toBe(false)
    useTuningStore.getState().stageMany([{ param: 'MOT_THST_EXPO', value: 0.55, label: 'MOT_THST_EXPO' }])
    expect(useTuningStore.getState().initialTuneStaged).toBe(true)
  })

  it('does not latch on an empty entries array (nothing was actually staged)', () => {
    useTuningStore.getState().stageMany([])
    expect(useTuningStore.getState().initialTuneStaged).toBe(false)
  })

  it('is never cleared once set — survives revertAll and clearForDisconnect, same as setupStore touched flags', () => {
    useTuningStore.getState().stageMany([{ param: 'MOT_THST_EXPO', value: 0.55, label: 'MOT_THST_EXPO' }])
    useTuningStore.getState().revertAll()
    expect(useTuningStore.getState().initialTuneStaged).toBe(true)
    useTuningStore.getState().clearForDisconnect()
    expect(useTuningStore.getState().initialTuneStaged).toBe(true)
  })

  it('single-param stage() (a manual slider edit) does NOT latch — the flag means "the calculator was run", not "any tuning edit happened"', () => {
    useTuningStore.getState().stage('ATC_ANG_RLL_P', 5.5, 'ATC_ANG_RLL_P')
    expect(useTuningStore.getState().initialTuneStaged).toBe(false)
  })
})
