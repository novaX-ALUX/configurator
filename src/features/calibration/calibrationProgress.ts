import { create } from 'zustand'

/**
 * Session-scoped "has the user actually finished this calibration at least
 * once" latches. `useAccelCalibration`/`useCompassCalibration` hold their own
 * live `status` as page-local React state -- only ever instantiated while
 * `CalibrationPage` is mounted (see those hooks' own module docs) -- but
 * Task 10.1's Setup Guide drawer is mounted globally (`App.tsx`, a sibling of
 * every page) and needs to know "was this done at some point this session"
 * even when `CalibrationPage` isn't currently on screen.
 *
 * Mirrors `features/setup/setupStore.ts`'s own `frameEscTouched`/`fsTouched`:
 * plain monotonic booleans, set once and never cleared -- a link drop or
 * leaving the Calibration page doesn't erase the fact that accel/compass/RC
 * were already done earlier this session. `markAccelDone`/`markCompassApplied`
 * are called from the two calibration hooks the instant their own status
 * reaches `'done'`/`'applied'`; `markRcCalApplied` (issue #46) is called by
 * `rcCalStagedStore`'s `writeAll` once an RC-cal Apply has verified every
 * staged RC param on the board. Nothing here ever reads or writes a
 * parameter itself.
 */
export interface CalibrationProgressState {
  accelDone: boolean
  compassApplied: boolean
  rcCalApplied: boolean
  markAccelDone: () => void
  markCompassApplied: () => void
  markRcCalApplied: () => void
}

export const useCalibrationProgress = create<CalibrationProgressState>((set) => ({
  accelDone: false,
  compassApplied: false,
  rcCalApplied: false,
  markAccelDone: () => set({ accelDone: true }),
  markCompassApplied: () => set({ compassApplied: true }),
  markRcCalApplied: () => set({ rcCalApplied: true }),
}))
