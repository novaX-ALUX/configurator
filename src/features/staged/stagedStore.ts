/**
 * Staged-write store factory (issue #33), extracted from `features/setup`'s
 * `setupStore` so the Tuning page and the Calibration page's RC-calibration
 * apply surface (issue #32) can each run their own Review Gate without
 * copying Setup code. `createStagedSlice` returns the whole staged-write
 * state machine — Staged Changes map, sequential Apply with readback,
 * per-param write statuses, disconnect invalidation — as a slice a page
 * store spreads into its own `create()` call, so pages that need extra
 * state alongside it (Setup's touched flags) keep everything in one hook.
 *
 * Staging dedupes by construction: `pending` is a `Map` keyed by ArduPilot
 * parameter name, so the latest edit to the same param always wins, exactly
 * like `features/params/ParamsPage`'s own `stage()`. Nothing is written to
 * the flight controller until `writeAll` runs; `writeStatus`,
 * `writeErrorStatus` and `withoutKey` are all imported from
 * `features/params/paramUtils` rather than re-declared (that module hosts
 * them precisely so every staged-write surface shares one copy) — same
 * `DiffRowStatus` write-outcome states
 * (writing/ok/mismatch/timeout/busy/precision/error), so the write flow is
 * the same "stage -> sequential set() with readback -> per-row status"
 * state machine as the parameter table, just triggered from a sticky
 * `StagedReviewBar` instead of a review dialog.
 */
import { ParamStoreDisposedError, type ParamStore } from '../../core/mavlink/params'
import { type DiffRowStatus, withoutKey, writeErrorStatus } from '../params/paramUtils'

/** How long a successful write's 'ok' status stays visible before the chip clears — same value/rationale as `features/params/ParamsPage`'s `WRITE_OK_DISPLAY_MS`. */
const WRITE_OK_DISPLAY_MS = 2000

/** One Staged Change (CONTEXT.md): a pending parameter edit awaiting Apply. */
export interface StagedChange {
  value: number
  /** Human label for the sticky bar's chip tooltip (e.g. the frame tile's name, or the enum option's display text) — display only, never written anywhere. */
  label: string
}

/** One staging action's input: which param, the new value, its display label. */
export interface StagedEntry {
  param: string
  value: number
  label: string
}

/**
 * The state patch one staging action produces: every entry lands in
 * `pending` (dedupe: a `Map` keyed by param name, latest wins) and has any
 * stale write status cleared. Exported — not just used by `stage` below — so
 * a page store composing extra state alongside the slice (Setup's touched
 * flags) can merge staging and its own patch into ONE atomic `set()` call
 * instead of two back-to-back updates a subscriber could observe between.
 */
export function stagePatch(s: Pick<StagedState, 'pending' | 'writeStatus'>, entries: readonly StagedEntry[]): Pick<StagedState, 'pending' | 'writeStatus'> {
  const pending = new Map(s.pending)
  let writeStatus = s.writeStatus
  for (const { param, value, label } of entries) {
    pending.set(param, { value, label })
    writeStatus = withoutKey(writeStatus, param)
  }
  return { pending, writeStatus }
}

export interface StagedState {
  pending: Map<string, StagedChange>
  writeStatus: Map<string, DiffRowStatus>
  writing: boolean
  /**
   * Bumped by `clearForDisconnect` so an in-flight `writeAll` recognizes it's
   * stale (its ParamStore is gone / a new session started) and stops issuing
   * further writes or state updates instead of re-populating a just-cleared
   * `pending`/`writeStatus` — the same hazard `ParamsPage.handleWriteAll`
   * guards against with its own `prevParamStoreRef` comparison.
   */
  generation: number

  /** Stages one param's edit (dedupe: replaces any prior pending value for the same param). Multi-param or composed staging goes through `stagePatch` inside the page store's own `set()`. */
  stage: (param: string, value: number, label: string) => void
  discard: (param: string) => void
  /** Clears every pending edit and any write status — fields fall back to displaying `ParamStore`'s own cached value, which is the real "revert". */
  revertAll: () => void
  /** Sequential `ParamStore.set()` per pending param, with per-param status (writing/ok/mismatch/timeout/busy/precision/error). Failed params stay in `pending`/`writeStatus`; succeeded ones show 'ok' briefly then clear from both. */
  writeAll: (paramStore: ParamStore) => Promise<void>
  /** Disconnect handling: clears pending/writeStatus/writing and invalidates any in-flight `writeAll`. Page-specific extra state (e.g. Setup's touched flags) is deliberately untouched — pages handle their own. */
  clearForDisconnect: () => void
}

/**
 * Builds the staged-write slice against a store's own `set`/`get`. Typed
 * against `StagedState` (not the page store's full state) so any store whose
 * state extends `StagedState` can pass its `set`/`get` straight through —
 * zustand's `Partial` updates make the narrower writes safe.
 */
export function createStagedSlice(
  set: (partial: Partial<StagedState> | ((s: StagedState) => Partial<StagedState>)) => void,
  get: () => StagedState,
): StagedState {
  return {
    pending: new Map(),
    writeStatus: new Map(),
    writing: false,
    generation: 0,

    stage(param, value, label) {
      set((s) => stagePatch(s, [{ param, value, label }]))
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
  }
}
