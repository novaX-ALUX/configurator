/**
 * The Calibration page's own Review Gate store (issue #38) — a bare
 * `createStagedSlice` instance, exactly the second consumer issue #33
 * extracted the factory for. RC-calibration results and reverse toggles
 * stage here; the page's `StagedReviewBar` is the review surface and
 * `writeAll` (sequential `ParamStore.set` with readback) is the only write
 * path. Per-page by convention (PRD #32): no cross-page staged store.
 */
import { create } from 'zustand'
import { createStagedSlice, type StagedState } from '../staged/stagedStore'

export const useRcCalStagedStore = create<StagedState>()((set, get) => createStagedSlice(set, get))
