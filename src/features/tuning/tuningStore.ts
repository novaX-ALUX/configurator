import { create } from 'zustand'
import { createStagedSlice, stagePatch, type StagedEntry, type StagedState } from '../staged/stagedStore'

/**
 * Tuning page staged-write store (issue #35): the shared `createStagedSlice`
 * Review Gate (ADR-0003 — sliders and the calculator stage, only Apply
 * writes) plus `stageMany`, the calculator's entry point: all confirmed
 * suggestion rows land in `pending` through ONE `set()` call via
 * `stagePatch`, never a per-row `stage()` loop a subscriber could observe
 * between (the same atomicity rule `setupStore.stageFrame` follows).
 */
export interface TuningState extends StagedState {
  stageMany: (entries: readonly StagedEntry[]) => void
}

export const useTuningStore = create<TuningState>((set, get) => ({
  ...createStagedSlice(set, get),
  stageMany(entries) {
    if (entries.length === 0) return
    set((s) => stagePatch(s, entries))
  },
}))
