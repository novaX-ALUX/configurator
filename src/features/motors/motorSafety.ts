/**
 * Motor-test safety-interlock engine — pure logic, no DOM, no timers of its
 * own. The single most safety-critical module in the project: it governs
 * whether real motors spin. `now`/`onStop`/`onRenew` are all injected so the
 * whole state machine is deterministic under a fake clock in tests; the page
 * (Task 9.3) is the only thing that reads a real clock (`Date.now()`) and
 * drives everything here (`tick()` on a ~200ms interval, plus the six
 * kill-switch event sources calling `stop(reason)` directly: window blur,
 * `visibilitychange` hidden, Escape, leaving the motor page, revoking the
 * "props removed" checkbox via `confirmProps(false)`, and the STOP button).
 *
 * State machine: 'locked' -> 'counting' -> 'ready' <-> 'testing' ->
 * (any stop) -> 'locked'. `enable()` only starts the countdown from
 * 'locked' when `propsConfirmed` is true; the countdown (`countdownMs`, the
 * design mock's 3s "unlock" delay) then lands on 'ready' (outputs enabled,
 * nothing spinning yet). `setSpinning(true, activeMotors)` moves 'ready' ->
 * 'testing' when a motor slider is actually being held; `setSpinning(false)`
 * moves back.
 *
 * ArduCopter's DO_MOTOR_TEST internally soft-arms and keeps outputting until
 * its own `timeout_sec` — a UI-only state machine is not enough to guarantee
 * a motor stops, so the real design is a **short-timeout renewal model**:
 * every motor-test command the page sends carries a short (0.5-1s) timeout,
 * and while 'testing' this engine fires `onRenew(activeMotors)` every
 * `renewMs` so the page re-sends before that timeout lapses (Task 9.2/9.3).
 * If the page ever stops calling `tick()` (tab frozen, crash, ...) the
 * flight controller's own timeout is what actually stops the motor — this
 * renewal signal is the UI's side of keeping that window short, not a
 * substitute for it.
 *
 * Two independent idle-based automatic stops, both driven by `tick()`
 * computing elapsed time against `lastAct` (last `noteActivity()`/
 * `setSpinning()` call) rather than counting ticks — this makes the exact
 * >= boundary deterministic regardless of how often the page happens to call
 * `tick()`:
 *  - 'testing' (a motor actually spinning) idle for `spinIdleMs` (default
 *    5s; settable 1-30s at runtime via `setSpinIdleMs` — issue #59's spin
 *    duration) -> `stop('auto-stop')`. Renewal (`onRenew`) alone does NOT
 *    count as activity — only `noteActivity()`/`setSpinning()` do — so a
 *    slider held with no further input genuinely stops once the window
 *    elapses even though its command keeps getting renewed underneath.
 *  - 'ready' (armed, outputs enabled, nothing spinning) idle for
 *    `idleLockMs` (default 30s) -> `stop('auto-lock')`.
 *
 * `stop(reason)` is idempotent from 'locked' (no re-fire of `onStop`) so the
 * six kill switches can all call it unconditionally without needing to
 * check state first. It does not touch `propsConfirmed` — an auto-stop or a
 * kill-switch stop does not force the user to re-check the "props removed"
 * box before arming again; only an explicit `confirmProps(false)` does that.
 * (Deliberate: re-arming after any stop still requires the full `enable()`
 * countdown — re-ticking the props checkbox is a separate, independent
 * confirmation the design does not ask for again on every stop.)
 *
 * **Stalled-tick detection (adversarial-review fix):** a real FC command
 * timeout (0.5-1s, motorTest.ts's `runMotorTest`) is a *safe-fail* — the
 * motor physically stops if it isn't renewed in time. But if the JS thread
 * itself stalls (GC pause, tab backgrounding, debugger breakpoint, ...) for
 * longer than that FC timeout yet still under `spinIdleMs`, a naive
 * `tick()` would see `idle = now - lastAct` still short (the user's last
 * real input may well be recent) and blindly fire `onRenew` again on the
 * next call — silently re-arming a motor that already physically stopped,
 * without the user's continued presence ever being reconfirmed (the thread
 * froze; the user did not keep holding anything). `tick()` therefore checks
 * `now - lastRenew` against `stallStopMs` *before* deciding to renew:
 * `lastRenew` only advances on a successful renew (every `renewMs`), so a
 * gap that blows past several renew cycles is unambiguous evidence of a
 * stalled tick loop, not normal jitter — and in that case it stops instead
 * of renewing. See `stallStopMs` below for the threshold.
 */

export type SafetyState = 'locked' | 'counting' | 'ready' | 'testing'

export interface MotorSafetyOptions {
  now: () => number
  /** Fired exactly once per active->locked transition; the page sends the real flight-controller stop command from here (Task 9.2's `stopMotorTest`). */
  onStop: (reason: string) => void
  /** Fired every `renewMs` while 'testing'; the page re-sends short-timeout motor-test commands for these motors so the flight controller's own `timeout_sec` never lapses while the user is still holding them active. */
  onRenew: (activeMotors: readonly number[]) => void
  /** 'locked' -> 'ready' unlock delay. Default 3000ms. */
  countdownMs?: number
  /** 'ready' (armed, idle) auto-lock timeout. Default 30000ms. */
  idleLockMs?: number
  /** 'testing' (spinning, idle) auto-stop timeout. Default 5000ms. */
  spinIdleMs?: number
  /** onRenew cadence while 'testing'. Default 400ms. */
  renewMs?: number
  /**
   * While 'testing', a gap since the last successful renew this long is
   * treated as a stalled tick loop (not normal jitter) — `tick()` stops
   * instead of renewing. Default `max(renewMs * 3, FC_COMMAND_MAX_TIMEOUT_MS)`:
   * three missed renew cycles is well past ordinary scheduling jitter, and
   * never less than the worst-case real FC command timeout
   * (`motorTest.ts`'s `runMotorTest` uses a 0.5-1s timeoutS per the design
   * doc — 1000ms here is that upper bound) — any gap at least that long
   * means the FC's own command has plausibly already lapsed and the motor
   * physically stopped, so renewing now would be resuming as if nothing
   * happened instead of honestly re-confirming the user is still present.
   */
  stallStopMs?: number
}

const DEFAULT_COUNTDOWN_MS = 3000
const DEFAULT_IDLE_LOCK_MS = 30000
const DEFAULT_SPIN_IDLE_MS = 5000
const DEFAULT_RENEW_MS = 400
/** Upper bound of the 0.5-1s short-timeout range `motorTest.ts`'s `runMotorTest` uses for a real DO_MOTOR_TEST command (design doc §8) — see `stallStopMs`. */
const FC_COMMAND_MAX_TIMEOUT_MS = 1000

export class MotorSafety {
  private readonly now: () => number
  private readonly onStopCb: (reason: string) => void
  private readonly onRenewCb: (activeMotors: readonly number[]) => void
  private readonly countdownMs: number
  private readonly idleLockMs: number
  private spinIdleMs: number
  private readonly renewMs: number
  private readonly stallStopMs: number

  private _state: SafetyState = 'locked'
  private _propsConfirmed = false
  private _countdown = 0
  private _idleLeft = 0
  private _stopLeft = 0

  /** `now()` at the instant `enable()` started the countdown. */
  private countdownStart = 0
  /** `now()` at the last `noteActivity()`/`setSpinning()` call — the shared basis both idle-based auto-stops measure elapsed time against. */
  private lastAct = 0
  /** `now()` at the last `onRenew` fire (or at 'testing' entry). */
  private lastRenew = 0
  private activeMotors: readonly number[] = []

  constructor(opts: MotorSafetyOptions) {
    this.now = opts.now
    this.onStopCb = opts.onStop
    this.onRenewCb = opts.onRenew
    this.countdownMs = opts.countdownMs ?? DEFAULT_COUNTDOWN_MS
    this.idleLockMs = opts.idleLockMs ?? DEFAULT_IDLE_LOCK_MS
    this.spinIdleMs = opts.spinIdleMs ?? DEFAULT_SPIN_IDLE_MS
    this.renewMs = opts.renewMs ?? DEFAULT_RENEW_MS
    this.stallStopMs = opts.stallStopMs ?? Math.max(this.renewMs * 3, FC_COMMAND_MAX_TIMEOUT_MS)
  }

  get state(): SafetyState {
    return this._state
  }

  get countdown(): number {
    return this._countdown
  }

  get idleLeft(): number {
    return this._idleLeft
  }

  get stopLeft(): number {
    return this._stopLeft
  }

  get propsConfirmed(): boolean {
    return this._propsConfirmed
  }

  /**
   * Sets the 'testing' auto-stop window (issue #59's settable spin duration
   * — how long a hands-off spin runs before `stop('auto-stop')`). Takes
   * effect immediately: the next `tick()` measures the same `lastAct`-based
   * idle against the new window, so shrinking it below the already-elapsed
   * idle stops on that tick. Only this one window changes — the countdown,
   * ready-idle auto-lock, renewal cadence, and stall detection all keep
   * their own authority (a longer spin never extends any of them). Callers
   * own range/validity clamping (`motorTestStore.ts` clamps to 1-30s).
   */
  setSpinIdleMs(ms: number): void {
    this.spinIdleMs = ms
  }

  /** Sets the "props removed" checkbox. Unchecking it (`v === false`) while anything is armed/spinning is one of the six hard kill switches. */
  confirmProps(v: boolean): void {
    this._propsConfirmed = v
    if (!v && this._state !== 'locked') this.stop('Prop confirmation revoked')
  }

  /** Starts the unlock countdown. No-op unless `propsConfirmed` and currently 'locked' — in particular, calling this again while already counting/ready/testing does not restart or otherwise disturb the countdown. */
  enable(): void {
    if (!this._propsConfirmed || this._state !== 'locked') return
    this._state = 'counting'
    this.countdownStart = this.now()
    this._countdown = this.countdownMs
  }

  /**
   * The periodic driver — the page calls this on a ~200ms interval. Advances
   * the countdown, checks both idle-based auto-stops, and fires renewals
   * while 'testing'. Pure function of `now()` and the recorded timestamps,
   * so 'locked'/'counting'/'ready' are safe to drive with a single call
   * after a large fake-clock jump in tests. 'testing' is the deliberate
   * exception: by design (see `stallStopMs`), a single big gap since the
   * last successful renew there is indistinguishable from — and treated as
   * — a stalled tick loop, so tests covering 'testing' at more than a few
   * hundred ms need periodic calls (mirroring the page's real cadence), not
   * one jump.
   */
  tick(): void {
    const t = this.now()

    if (this._state === 'counting') {
      const remaining = this.countdownMs - (t - this.countdownStart)
      if (remaining <= 0) {
        this._state = 'ready'
        this._countdown = 0
        this.lastAct = t
        this._idleLeft = this.idleLockMs
        this._stopLeft = 0
      } else {
        this._countdown = remaining
      }
      return
    }

    if (this._state === 'ready') {
      const idle = t - this.lastAct
      if (idle >= this.idleLockMs) {
        this.stop('auto-lock')
        return
      }
      this._idleLeft = this.idleLockMs - idle
      return
    }

    if (this._state === 'testing') {
      const idle = t - this.lastAct
      if (idle >= this.spinIdleMs) {
        this.stop('auto-stop')
        return
      }
      this._stopLeft = this.spinIdleMs - idle
      const sinceRenew = t - this.lastRenew
      if (sinceRenew >= this.stallStopMs) {
        // The tick loop itself stalled past a real FC command's own
        // timeout — the motor has plausibly already safe-failed stopped.
        // Do NOT renew (that would silently re-arm it); stop for real.
        this.stop('auto-stop: tick stall detected, outputs may have lapsed')
        return
      }
      if (sinceRenew >= this.renewMs) {
        this.lastRenew = t
        this.onRenewCb(this.activeMotors)
      }
      return
    }

    // 'locked': nothing to advance.
  }

  /** Refreshes the idle clock both auto-stops measure against — called by the page on real user input (pointer/keyboard activity on the motor-test controls). */
  noteActivity(): void {
    this.lastAct = this.now()
  }

  /** 'ready' <-> 'testing'. Only acts when it's actually a valid transition (or an update while already in the target state); a no-op from 'locked'/'counting', and a no-op calling `setSpinning(false)` while already 'ready'. */
  setSpinning(any: boolean, activeMotors: readonly number[] = []): void {
    const t = this.now()
    if (any) {
      if (this._state === 'ready') {
        this._state = 'testing'
        this.activeMotors = activeMotors
        this.lastAct = t
        this.lastRenew = t
        this._idleLeft = 0
        this._stopLeft = this.spinIdleMs
      } else if (this._state === 'testing') {
        this.activeMotors = activeMotors
        this.lastAct = t
      }
    } else if (this._state === 'testing') {
      this._state = 'ready'
      this.activeMotors = []
      this.lastAct = t
      this._stopLeft = 0
      this._idleLeft = this.idleLockMs
    }
  }

  /** Clears everything and locks, firing `onStop(reason)` exactly once — a no-op (does not re-fire) if already 'locked', so every kill switch can call this unconditionally. Does not touch `propsConfirmed`. */
  stop(reason: string): void {
    if (this._state === 'locked') return
    this._state = 'locked'
    this._countdown = 0
    this._idleLeft = 0
    this._stopLeft = 0
    this.activeMotors = []
    this.onStopCb(reason)
  }
}
