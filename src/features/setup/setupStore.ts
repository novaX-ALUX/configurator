/**
 * Setup page's staged-write store (Task 7.2). Every Setup field's `onChange`
 * optimistically updates its own display AND stages a pending change here.
 * The staging/write machinery itself — Staged Changes map, sequential Apply
 * with readback, per-param `DiffRowStatus`, disconnect invalidation — is
 * `features/staged`'s `createStagedSlice` (issue #33 extracted it from this
 * file so the Tuning page and RC calibration can reuse it); this store
 * composes that slice with the two Setup-specific pieces below.
 *
 * `stageFrame` stages BOTH `FRAME_CLASS` and `FRAME_TYPE` from a single
 * frame tile pick — never `stage()` for either individually, that's the
 * exact bug the design mock had.
 *
 * `fsTouched`/`frameEscTouched` are for Task 10's Setup Guide: it needs to
 * detect "did the user actually look at and decide frame/ESC/failsafes"
 * rather than the design mock's own placeholder (`done: s.connected`, which
 * is always true once connected and proves nothing was configured). Set the
 * moment a field in that group is staged — not gated on a confirmed write —
 * because the Guide's job is to nudge the user to *visit and decide*, not to
 * double as a write-confirmation indicator (that's what `writeStatus` is
 * for). Never cleared once set: leaving Setup or losing the link doesn't
 * erase the fact that the user already reviewed that section this session —
 * which is also why `clearForDisconnect` (from the slice) leaves them alone.
 */
import { create } from 'zustand'
import { createStagedSlice, stagePatch, type StagedState } from '../staged/stagedStore'
import { BATT_FS_LOW_FIELD, ESC_PROTOCOL_FIELD, FRAME_FIELD, FS_GCS_FIELD, FS_THROTTLE_FIELD } from './paramEnums'

/** Frame/ESC params (Task 10 guide step 2) — sourced from `paramEnums.ts` rather than re-listing the literal strings, so this stays in sync if that table ever changes. */
const FRAME_ESC_PARAMS = new Set<string>([...FRAME_FIELD.params, ESC_PROTOCOL_FIELD.param])
/** Failsafe params (Task 10 guide step 5). */
const FS_PARAMS = new Set<string>([FS_THROTTLE_FIELD.param, BATT_FS_LOW_FIELD.param, FS_GCS_FIELD.param])

function touchedPatch(param: string): Partial<Pick<SetupState, 'fsTouched' | 'frameEscTouched'>> {
  const patch: Partial<Pick<SetupState, 'fsTouched' | 'frameEscTouched'>> = {}
  if (FRAME_ESC_PARAMS.has(param)) patch.frameEscTouched = true
  if (FS_PARAMS.has(param)) patch.fsTouched = true
  return patch
}

export interface SetupState extends StagedState {
  fsTouched: boolean
  frameEscTouched: boolean
  /** Stages BOTH `FRAME_CLASS` and `FRAME_TYPE` from a single frame tile pick. */
  stageFrame: (frameClass: number, frameType: number, label: string) => void
}

export const useSetupStore = create<SetupState>((set, get) => ({
  ...createStagedSlice(set, get),
  fsTouched: false,
  frameEscTouched: false,

  // Both staging overrides merge `stagePatch` with their Setup-specific flag
  // in ONE set() — a subscriber must never observe pending updated while the
  // touched flags lag behind (issue #33 review finding).
  stage(param, value, label) {
    set((s) => ({ ...stagePatch(s, [{ param, value, label }]), ...touchedPatch(param) }))
  },

  stageFrame(frameClass, frameType, label) {
    set((s) => ({
      ...stagePatch(s, [
        { param: 'FRAME_CLASS', value: frameClass, label },
        { param: 'FRAME_TYPE', value: frameType, label },
      ]),
      frameEscTouched: true,
    }))
  },
}))
