/**
 * Setup page's staged-write store (Task 7.2). Every Setup field's `onChange`
 * optimistically updates its own display AND stages a pending change here,
 * keyed by ArduPilot parameter name — a `Map` dedupes by construction, so
 * the latest edit to the same param always wins, exactly like
 * `features/params/ParamsPage`'s own `stage()`. Nothing is written to the
 * flight controller until `writeAll` runs; `writeStatus`, `writeErrorStatus`
 * and `withoutKey` are all imported from `features/params/paramUtils` rather
 * than re-declared (that module now hosts them precisely so both features
 * share one copy) — same `DiffRowStatus` five write-outcome states
 * (writing/ok/mismatch/timeout/busy/precision/error), so the write flow is
 * the same "stage ->
 * sequential set() with readback -> per-row status" state machine as the
 * parameter table, just triggered from a sticky bar instead of a review
 * dialog — this page's design mock has no separate diff drawer for Setup,
 * the sticky bar's chips + status *are* the review surface.
 *
 * `fsTouched`/`frameEscTouched` are for Task 10's Setup Guide: it needs to
 * detect "did the user actually look at and decide frame/ESC/failsafes"
 * rather than the design mock's own placeholder (`done: s.connected`, which
 * is always true once connected and proves nothing was configured). Set the
 * moment a field in that group is staged — not gated on a confirmed write —
 * because the Guide's job is to nudge the user to *visit and decide*, not to
 * double as a write-confirmation indicator (that's what `writeStatus` is
 * for). Never cleared once set: leaving Setup or losing the link doesn't
 * erase the fact that the user already reviewed that section this session.
 */
import { create } from 'zustand'
import { ParamStoreDisposedError, type ParamStore } from '../../core/mavlink/params'
import { type DiffRowStatus, withoutKey, writeErrorStatus } from '../params/paramUtils'
import { BATT_FS_LOW_FIELD, ESC_PROTOCOL_FIELD, FRAME_FIELD, FS_GCS_FIELD, FS_THROTTLE_FIELD } from './paramEnums'

/** How long a successful write's 'ok' status stays visible before the chip clears — same value/rationale as `features/params/ParamsPage`'s `WRITE_OK_DISPLAY_MS`. */
const WRITE_OK_DISPLAY_MS = 2000

/** Frame/ESC params (Task 10 guide step 2) — sourced from `paramEnums.ts` rather than re-listing the literal strings, so this stays in sync if that table ever changes. */
const FRAME_ESC_PARAMS = new Set<string>([...FRAME_FIELD.params, ESC_PROTOCOL_FIELD.param])
/** Failsafe params (Task 10 guide step 5). */
const FS_PARAMS = new Set<string>([FS_THROTTLE_FIELD.param, BATT_FS_LOW_FIELD.param, FS_GCS_FIELD.param])

export interface PendingChange {
  value: number
  /** Human label for the sticky bar's chip tooltip (e.g. the frame tile's name, or the enum option's display text) — display only, never written anywhere. */
  label: string
}

function touchedPatch(param: string): Partial<Pick<SetupState, 'fsTouched' | 'frameEscTouched'>> {
  const patch: Partial<Pick<SetupState, 'fsTouched' | 'frameEscTouched'>> = {}
  if (FRAME_ESC_PARAMS.has(param)) patch.frameEscTouched = true
  if (FS_PARAMS.has(param)) patch.fsTouched = true
  return patch
}

export interface SetupState {
  pending: Map<string, PendingChange>
  writeStatus: Map<string, DiffRowStatus>
  writing: boolean
  fsTouched: boolean
  frameEscTouched: boolean
  /**
   * Bumped by `clearForDisconnect` so an in-flight `writeAll` recognizes it's
   * stale (its ParamStore is gone / a new session started) and stops issuing
   * further writes or state updates instead of re-populating a just-cleared
   * `pending`/`writeStatus` — the same hazard `ParamsPage.handleWriteAll`
   * guards against with its own `prevParamStoreRef` comparison.
   */
  generation: number

  /** Stages one param's edit (dedupe: replaces any prior pending value for the same param). */
  stage: (param: string, value: number, label: string) => void
  /** Stages BOTH `FRAME_CLASS` and `FRAME_TYPE` from a single frame tile pick — never call `stage()` for either individually, that's the exact bug the design mock had. */
  stageFrame: (frameClass: number, frameType: number, label: string) => void
  discard: (param: string) => void
  /** Clears every pending edit and any write status — fields fall back to displaying `ParamStore`'s own cached value, which is the real "revert". */
  revertAll: () => void
  /** Sequential `ParamStore.set()` per pending param, with per-param status (writing/ok/mismatch/timeout/busy/precision/error). Failed params stay in `pending`/`writeStatus`; succeeded ones show 'ok' briefly then clear from both. */
  writeAll: (paramStore: ParamStore) => Promise<void>
  /** Disconnect handling: clears pending/writeStatus/writing and invalidates any in-flight `writeAll`. Touched flags are deliberately left alone (see module doc). */
  clearForDisconnect: () => void
}

export const useSetupStore = create<SetupState>((set, get) => ({
  pending: new Map(),
  writeStatus: new Map(),
  writing: false,
  fsTouched: false,
  frameEscTouched: false,
  generation: 0,

  stage(param, value, label) {
    set((s) => ({
      pending: new Map(s.pending).set(param, { value, label }),
      writeStatus: withoutKey(s.writeStatus, param),
      ...touchedPatch(param),
    }))
  },

  stageFrame(frameClass, frameType, label) {
    set((s) => {
      const pending = new Map(s.pending)
      pending.set('FRAME_CLASS', { value: frameClass, label })
      pending.set('FRAME_TYPE', { value: frameType, label })
      return {
        pending,
        writeStatus: withoutKey(withoutKey(s.writeStatus, 'FRAME_CLASS'), 'FRAME_TYPE'),
        frameEscTouched: true,
      }
    })
  },

  discard(param) {
    set((s) => ({ pending: withoutKey(s.pending, param), writeStatus: withoutKey(s.writeStatus, param) }))
  },

  revertAll() {
    set({ pending: new Map(), writeStatus: new Map() })
  },

  async writeAll(paramStore) {
    const gen = get().generation
    set({ writing: true })
    for (const [name, change] of [...get().pending.entries()]) {
      if (get().generation !== gen) return // stale generation: disconnect/new session already cleared everything
      set((s) => ({ writeStatus: new Map(s.writeStatus).set(name, { kind: 'writing' }) }))
      try {
        await paramStore.set(name, change.value)
        if (get().generation !== gen) return
        // Show a transient 'ok' rather than clearing instantly — mirrors
        // ParamsPage's own "Written and verified" moment.
        set((s) => ({ writeStatus: new Map(s.writeStatus).set(name, { kind: 'ok' }) }))
        setTimeout(() => {
          if (get().generation !== gen) return
          // Skip the clear if this name's status is no longer 'ok' — the
          // user re-staged (stage() clears writeStatus) or discarded it in
          // the meantime, and clearing `pending` here would silently wipe
          // out that newer edit.
          if (get().writeStatus.get(name)?.kind !== 'ok') return
          set((s) => ({ pending: withoutKey(s.pending, name), writeStatus: withoutKey(s.writeStatus, name) }))
        }, WRITE_OK_DISPLAY_MS)
      } catch (err) {
        if (get().generation !== gen) return
        if (err instanceof ParamStoreDisposedError) return // disposed mid-flight — stop rather than keep calling a dead store
        set((s) => ({ writeStatus: new Map(s.writeStatus).set(name, writeErrorStatus(err)) }))
      }
    }
    if (get().generation === gen) set({ writing: false })
  },

  clearForDisconnect() {
    set((s) => ({ pending: new Map(), writeStatus: new Map(), writing: false, generation: s.generation + 1 }))
  },
}))
