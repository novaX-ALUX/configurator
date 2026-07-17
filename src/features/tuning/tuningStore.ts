import { create } from 'zustand'
import { createStagedSlice, stagePatch, type StagedEntry, type StagedState } from '../staged/stagedStore'

/**
 * Tuning page staged-write store (issue #35): the shared `createStagedSlice`
 * Review Gate (ADR-0003 — sliders and the calculator stage, only Apply
 * writes) plus `stageMany`, the calculator's entry point: all confirmed
 * suggestion rows land in `pending` through ONE `set()` call via
 * `stagePatch`, never a per-row `stage()` loop a subscriber could observe
 * between (the same atomicity rule `setupStore.stageFrame` follows).
 *
 * `initialTuneStaged` is the Setup Guide's step-⑥ done-flag (issue #41):
 * latched the moment the calculator stages its suggestions (`stageMany`),
 * NOT by a manual slider `stage()` — the guide step nudges "run the
 * calculator", and one hand-tweaked slider isn't an initial tune. Same
 * session-scoped monotonic convention as `setupStore`'s `fsTouched`/
 * `frameEscTouched`: set once, never cleared (not by `revertAll` or
 * `clearForDisconnect` — losing the link doesn't erase the fact the user
 * already ran the calculator this session), and the guide only ever reads it.
 */
export interface TuningState extends StagedState {
  initialTuneStaged: boolean
  stageMany: (entries: readonly StagedEntry[]) => void
}

export const useTuningStore = create<TuningState>((set, get) => ({
  ...createStagedSlice(set, get),
  initialTuneStaged: false,
  stageMany(entries) {
    if (entries.length === 0) return
    // One set() for both the staged rows and the flag — a subscriber must
    // never observe pending updated while initialTuneStaged lags behind.
    set((s) => ({ ...stagePatch(s, entries), initialTuneStaged: true }))
  },
}))
