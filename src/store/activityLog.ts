/**
 * Session Activity log — the design file's TopBar "Session activity" dropdown
 * (`docs/design/novaX-Configurator.dc.html`, ~lines 99-116: "SESSION
 * ACTIVITY … Parameter writes, calibrations and firmware flashes will appear
 * here"), a running record of operations this GCS performed against the
 * board, distinct from the STATUSTEXT feed (`store/connection.ts`,
 * `StatusPanel`) which only ever shows text the board itself sent.
 *
 * Task 8.3 is this store's first consumer: `MagCalibration.start()`'s
 * `onLearnDisclosure` fires because `COMPASS_LEARN=0` is a real, implicit
 * write the FC makes outside the offsets review gate (see `magCal.ts`'s own
 * module doc) — that must not be silent, so the calibration feature logs it
 * here in addition to showing it inline. The TopBar dropdown that would
 * render this log is out of scope for Task 8.3 (no other M2 write path feeds
 * it yet, so a dedicated UI would have nothing else to show); later tasks
 * that perform writes (parameters, motor test, firmware) can push into this
 * same store once that dropdown lands.
 */
import { create } from 'zustand'

export interface ActivityLogEntry {
  ts: number
  text: string
}

/** Ring-buffer cap, same rationale/value as `connection.ts`'s `STATUSTEXT_CAP`. */
const ACTIVITY_LOG_CAP = 200

interface ActivityLogState {
  entries: ActivityLogEntry[]
  log: (text: string) => void
  clear: () => void
}

export const useActivityLog = create<ActivityLogState>((set) => ({
  entries: [],
  log: (text) =>
    set((s) => {
      const next = [...s.entries, { ts: Date.now(), text }]
      if (next.length > ACTIVITY_LOG_CAP) next.splice(0, next.length - ACTIVITY_LOG_CAP)
      return { entries: next }
    }),
  clear: () => set({ entries: [] }),
}))
