/**
 * The Calibration page's own Review Gate store (issue #38) — a
 * `createStagedSlice` instance, exactly the second consumer issue #33
 * extracted the factory for. RC-calibration results and reverse toggles
 * stage here; the page's `StagedReviewBar` is the review surface and
 * `writeAll` (sequential `ParamStore.set` with readback) is the only write
 * path. Per-page by convention (PRD #32): no cross-page staged store.
 *
 * `writeAll` is wrapped (issue #46) to latch `useCalibrationProgress`'s
 * `rcCalApplied` for the Setup Guide's step 3 — from inside the feature's
 * own store, the same placement `tuningStore.stageMany` uses for
 * `initialTuneStaged`. It latches only when every status left by this run
 * is a readback-verified 'ok': a partial or fully-failed Apply keeps the
 * step honest, and a disconnect mid-write (generation bump cleared
 * `writeStatus`) leaves the empty map unlatched.
 */
import { create } from 'zustand'
import { createStagedSlice, type StagedState } from '../staged/stagedStore'
import { useCalibrationProgress } from './calibrationProgress'

export const useRcCalStagedStore = create<StagedState>()((set, get) => {
  const slice = createStagedSlice(set, get)
  return {
    ...slice,
    async writeAll(paramStore) {
      await slice.writeAll(paramStore)
      const statuses = [...get().writeStatus.values()]
      if (statuses.length > 0 && statuses.every((s) => s.kind === 'ok')) useCalibrationProgress.getState().markRcCalApplied()
    },
  }
})
