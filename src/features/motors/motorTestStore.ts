/**
 * Owns the single `MotorSafety` (Task 9.1) instance that governs whether
 * real motors spin, plus everything that instance needs from the outside
 * world: which `session`/`motorCount` to send flight-controller commands
 * against, and each motor's current slider percent (for `onRenew`).
 *
 * A module-scope zustand store (mirrors `store/connection.ts`) rather than
 * page-local React state, because the six kill-switch listeners live on
 * `MotorTestPage` while the global safety banners (`App.tsx`) are a
 * *sibling* in the tree, not a descendant — both need to read the same live
 * safety state, and `App.tsx` must be able to show/hide its banners even
 * when `MotorTestPage` itself isn't mounted (e.g. mid-unmount, or if a
 * future page ever needs to peek at it).
 *
 * `createMotorTestStore()` is a factory (same reason `connection.ts` is
 * one): tests get a fully isolated instance — with an injectable clock —
 * instead of fighting over the app's singleton (`useMotorTestStore` below).
 *
 * Task 9.1's `MotorSafety` is pure logic with no timers of its own — this
 * store is "the page" that module's doc talks about: `MotorTestPage` drives
 * `tick()` on a ~200ms interval (see that file); `onStop`/`onRenew` are
 * wired here to the real FC commands (`motorTest.ts`, Task 9.2):
 *
 *  - `onStop` -> best-effort `stopAllMotors(session, motorCount)` (never
 *    throws, always resolves — see that function's own doc) if a session is
 *    currently known; a stop while already disconnected has nothing to send
 *    to, which is fine — `MotorSafety.stop()` still transitions state and
 *    the six kill switches all still "fire" in the sense that mattered.
 *    Also resets `percents` back to empty — design: "sliders release to
 *    zero on any safety event" — since `MotorSafety` itself has no notion of
 *    per-motor throttle values, only this store does.
 *  - `onRenew` -> for every active motor, `runMotorTest` with that motor's
 *    current slider percent and a short timeout, matching the renewal model
 *    `motorSafety.ts`'s own doc describes. Nothing is sent the instant a
 *    slider moves — only the next renew tick actually talks to the FC,
 *    deliberately, so a single dropped tick never means a burst of stale
 *    commands.
 *
 * **Adversarial-review fix: stale-feeder invalidation is centralized here,
 * not left to callers.** `runSequence` (the "Sequence M1->Mn" test) is a
 * repeating `setInterval` that outlives a single event -- it can still be
 * ticking when a kill switch fires. A reviewer reproduced a real autonomous
 * spin: start the sequence test, fire a non-unmount kill switch (e.g.
 * Escape) mid-sequence, then re-arm — the *same* interval, never cancelled,
 * eventually fires again after state has legitimately recovered to 'ready',
 * calling what looks like an ordinary percent-set with a nonzero value. Two
 * central invariants close this off, both enforced *here*, independent of
 * whatever component happens to be driving percents:
 *
 *  1. The sequence-test timer is **owned by this store**, not by
 *     `MotorSliders` — `runSequence`/`cancelSequence` below are the only
 *     thing that ever touches it, and `onStop` (which fires for *every* path
 *     into 'locked': the six kill switches, an idle auto-lock/auto-stop, or
 *     `MotorSafety`'s own stall detector — all of them funnel through
 *     `MotorSafety.stop()` -> this same callback) unconditionally cancels
 *     it. A stale interval literally cannot exist across a stop, because
 *     the stop *is* what clears it.
 *  2. `applyPercent` (the guarded core both `setMotorPercent` and
 *     `runSequence`'s own stepping go through) refuses to mutate `percents`
 *     or call `MotorSafety.setSpinning` unless `safety.state` is currently
 *     'ready' or 'testing' *at the moment of the call* — belt-and-suspenders
 *     underneath (1): even if some future feeder is added and forgets to
 *     register itself for cancellation, it still cannot repopulate
 *     `percents` while locked/counting, which is what used to let a stale
 *     write survive into the *next* legitimate percent-set (that one sweeps
 *     the *whole* `percents` map into `activeMotors`, not just the motor it
 *     touched).
 */
import { create } from 'zustand'
import { MotorSafety, type SafetyState } from './motorSafety'
import { MOTOR_TEST_MAX_PERCENT, runMotorTest, stopAllMotors } from './motorTest'
import type { MavSession } from '../../core/mavlink/session'

/** Short per-motor-test timeout for renewal commands — comfortably inside `motorSafety.ts`'s own `stallStopMs` default and its documented 0.5-1s renewal window. */
const RENEW_TIMEOUT_S = 0.6

/** Sequence-test throttle and per-motor dwell — design mock's own "Sequence M1→M4 @ 12%". Owned here (not `MotorSliders`) so a stop can cancel it centrally; see module doc. */
const SEQUENCE_PERCENT = 12
const SEQUENCE_STEP_MS = 900

export interface MotorTestState {
  state: SafetyState
  propsConfirmed: boolean
  /** Milliseconds left in the 'counting' unlock countdown; 0 outside that state. */
  countdown: number
  /** Milliseconds left before an idle 'ready' auto-locks; 0 outside that state. */
  idleLeft: number
  /** Milliseconds left before an idle 'testing' auto-stops; 0 outside that state. */
  stopLeft: number
  /** motorSeq (1-based) -> current slider percent (0..`MOTOR_TEST_MAX_PERCENT`). A missing entry means 0. Reset to `{}` on every stop. */
  percents: Record<number, number>
  /** True while `runSequence`'s own interval is active. `MotorSliders` reads this instead of owning any timer of its own — see module doc's adversarial-review fix. */
  sequenceRunning: boolean
  /**
   * Set the first time any motor is actually driven above 0% this session
   * (via either the manual sliders or the sequence test) — Task 10.1's Setup
   * Guide reads this as "was motor order/direction actually verified".
   * Monotonic, like `setupStore.ts`'s `frameEscTouched`/`fsTouched`: a
   * `stop()` clears `percents` back to `{}` (sliders release to zero), but
   * does NOT clear this flag — the fact that the user spun a motor earlier
   * this session doesn't become untrue just because the safety engine
   * re-locked afterward.
   */
  motorsTested: boolean

  /**
   * Single-owner setter: only `MotorTestPage` calls this, once per render
   * whenever `session`/`motorCount` change (session identity, or the
   * selected frame's motor count) — read by `onStop`/`onRenew` at call time,
   * never captured once. Safe today because there is exactly one caller and
   * `MotorTestPage`'s own `phase !== 'connected'` guard forces a stop before
   * any session-identity change is observable mid-test; a second concurrent
   * caller (a future page also driving motor tests) would need an explicit
   * ownership story, not just calling this from two places.
   */
  setSessionInfo: (session: MavSession | null, motorCount: number) => void
  confirmProps: (v: boolean) => void
  enable: () => void
  /** Sets one motor's slider percent (clamped to `[0, MOTOR_TEST_MAX_PERCENT]`), drives `noteActivity`/`setSpinning`, and re-syncs reactive state. The FC command itself is sent by `onRenew` on the next tick, not here. A no-op (does not touch `percents`) unless `state` is currently 'ready'/'testing' — see module doc. */
  setMotorPercent: (motorSeq: number, percent: number) => void
  /**
   * Starts the "Sequence M1->Mn @ 12%" test: steps through every motor
   * 1..`motorCount`, `SEQUENCE_STEP_MS` apart, via the same guarded
   * `applyPercent` core `setMotorPercent` uses. A no-op if already running,
   * or if `state` isn't currently 'ready'/'testing'. The interval this
   * starts is owned by the store (not the caller) specifically so `onStop`
   * can cancel it unconditionally — see module doc.
   */
  runSequence: (motorCount: number) => void
  /** The page's ~200ms driver. */
  tick: () => void
  /** Every one of the six kill switches, the STOP ALL/LOCK OUTPUTS buttons, and the disconnect-during-testing guard all call this. Idempotent from 'locked' (mirrors `MotorSafety.stop`). Also cancels any in-flight `runSequence` (via the shared `onStop` path — see module doc). */
  stop: (reason: string) => void
}

/** Factory so tests get an isolated store with an injectable clock — mirrors `createConnectionStore`. `useMotorTestStore` below is just this with the real clock. */
export function createMotorTestStore(now: () => number = () => Date.now()) {
  let sessionRef: MavSession | null = null
  let motorCountRef = 0
  /** The sequence-test's own interval handle — owned here, not by any component, so `onStop` can cancel it unconditionally. See module doc. */
  let seqTimerRef: ReturnType<typeof setInterval> | null = null

  return create<MotorTestState>((set, get) => {
    /**
     * Cancels any in-flight `runSequence` interval. Called from `onStop`
     * (every path into 'locked', see module doc) so a stale feeder can never
     * survive a stop — this is the primary fix, not a fallback.
     */
    function cancelSequence(): void {
      if (seqTimerRef !== null) {
        clearInterval(seqTimerRef)
        seqTimerRef = null
      }
      set({ sequenceRunning: false })
    }

    /**
     * The single guarded core both `setMotorPercent` and `runSequence`'s own
     * stepping go through. Refuses to touch `percents` or call
     * `MotorSafety.setSpinning` unless `state` is currently 'ready'/'testing'
     * — see module doc's adversarial-review fix for why this check, by
     * itself, is necessary but not sufficient (the sequence timer must also
     * actually be cancelled by `onStop`, since this guard alone can't stop a
     * stale call that happens to land *after* a legitimate re-arm).
     */
    function applyPercent(motorSeq: number, percent: number): void {
      if (safety.state !== 'ready' && safety.state !== 'testing') return
      const clamped = Math.min(MOTOR_TEST_MAX_PERCENT, Math.max(0, percent))
      set((s) => ({ percents: { ...s.percents, [motorSeq]: clamped }, ...(clamped > 0 ? { motorsTested: true } : {}) }))
      safety.noteActivity()
      const active = Object.entries(get().percents)
        .filter(([, v]) => v > 0)
        .map(([seq]) => Number(seq))
      safety.setSpinning(active.length > 0, active)
      set(readSafety())
    }

    const safety = new MotorSafety({
      now,
      onStop: () => {
        // Cancel the sequence feeder FIRST, before anything else -- this is
        // the one callback every path into 'locked' funnels through (the six
        // kill switches, an idle auto-lock/auto-stop, `MotorSafety`'s own
        // stall detector), so it's the single central place a stale timer
        // can be guaranteed dead, not left to whatever component happened to
        // start it.
        cancelSequence()
        if (sessionRef) void stopAllMotors(sessionRef, motorCountRef)
        set({ ...readSafety(), percents: {} })
      },
      onRenew: (activeMotors) => {
        if (!sessionRef) return
        const percents = get().percents
        for (const motorSeq of activeMotors) {
          // Best-effort: a single renew not getting ACKed (packet loss, a
          // slow board, ...) is not fatal -- the next tick renews again
          // `renewMs` later, and if the gaps really do pile up,
          // `MotorSafety`'s own stall detector stops for real (see
          // `motorSafety.ts`'s `stallStopMs` doc). Nothing here should turn
          // one dropped renew into an unhandled rejection.
          runMotorTest(sessionRef, { motorSeq, throttlePercent: percents[motorSeq] ?? 0, timeoutS: RENEW_TIMEOUT_S }).catch(() => {})
        }
      },
    })

    function readSafety(): Pick<MotorTestState, 'state' | 'propsConfirmed' | 'countdown' | 'idleLeft' | 'stopLeft'> {
      return {
        state: safety.state,
        propsConfirmed: safety.propsConfirmed,
        countdown: safety.countdown,
        idleLeft: safety.idleLeft,
        stopLeft: safety.stopLeft,
      }
    }

    return {
      state: 'locked',
      propsConfirmed: false,
      countdown: 0,
      idleLeft: 0,
      stopLeft: 0,
      percents: {},
      sequenceRunning: false,
      motorsTested: false,

      setSessionInfo(session, motorCount) {
        sessionRef = session
        motorCountRef = motorCount
      },

      confirmProps(v) {
        safety.confirmProps(v)
        set(readSafety())
      },

      enable() {
        safety.enable()
        set(readSafety())
      },

      setMotorPercent(motorSeq, percent) {
        applyPercent(motorSeq, percent)
      },

      runSequence(motorCount) {
        if (seqTimerRef !== null) return // already running
        if (motorCount < 1) return
        if (safety.state !== 'ready' && safety.state !== 'testing') return

        set({ sequenceRunning: true })
        let motor = 1
        applyPercent(motor, SEQUENCE_PERCENT)
        seqTimerRef = setInterval(() => {
          applyPercent(motor, 0)
          motor++
          if (motor > motorCount) {
            cancelSequence()
            return
          }
          applyPercent(motor, SEQUENCE_PERCENT)
        }, SEQUENCE_STEP_MS)
      },

      tick() {
        safety.tick()
        set(readSafety())
      },

      stop(reason) {
        safety.stop(reason)
        set(readSafety())
      },
    }
  })
}

/** The app-wide singleton. */
export const useMotorTestStore = createMotorTestStore()
