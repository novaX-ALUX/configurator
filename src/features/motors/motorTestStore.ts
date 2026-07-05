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
 */
import { create } from 'zustand'
import { MotorSafety, type SafetyState } from './motorSafety'
import { MOTOR_TEST_MAX_PERCENT, runMotorTest, stopAllMotors } from './motorTest'
import type { MavSession } from '../../core/mavlink/session'

/** Short per-motor-test timeout for renewal commands — comfortably inside `motorSafety.ts`'s own `stallStopMs` default and its documented 0.5-1s renewal window. */
const RENEW_TIMEOUT_S = 0.6

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
  /** Sets one motor's slider percent (clamped to `[0, MOTOR_TEST_MAX_PERCENT]`), drives `noteActivity`/`setSpinning`, and re-syncs reactive state. The FC command itself is sent by `onRenew` on the next tick, not here. */
  setMotorPercent: (motorSeq: number, percent: number) => void
  /** The page's ~200ms driver. */
  tick: () => void
  /** Every one of the six kill switches, the STOP ALL/LOCK OUTPUTS buttons, and the disconnect-during-testing guard all call this. Idempotent from 'locked' (mirrors `MotorSafety.stop`). */
  stop: (reason: string) => void
}

/** Factory so tests get an isolated store with an injectable clock — mirrors `createConnectionStore`. `useMotorTestStore` below is just this with the real clock. */
export function createMotorTestStore(now: () => number = () => Date.now()) {
  let sessionRef: MavSession | null = null
  let motorCountRef = 0

  return create<MotorTestState>((set, get) => {
    const safety = new MotorSafety({
      now,
      onStop: () => {
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
        const clamped = Math.min(MOTOR_TEST_MAX_PERCENT, Math.max(0, percent))
        set((s) => ({ percents: { ...s.percents, [motorSeq]: clamped } }))
        safety.noteActivity()
        const active = Object.entries(get().percents)
          .filter(([, v]) => v > 0)
          .map(([seq]) => Number(seq))
        safety.setSpinning(active.length > 0, active)
        set(readSafety())
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
