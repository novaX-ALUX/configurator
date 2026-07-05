/**
 * Motor-test command module: sends `MAV_CMD_DO_MOTOR_TEST` (209) to spin a
 * single motor for a bench/pre-flight test, and best-effort stop commands.
 * This is the "send the real command" half of Task 9.1's short-timeout
 * renewal model (`motorSafety.ts`) — that state machine decides *when* to
 * (re)send and stop; this module only encodes/decodes the wire protocol.
 *
 * ## Protocol notes (verified against source)
 * (`flight_controller/firmware/ardupilot` vendored tree; XML paths below are
 * relative to that tree's `modules/mavlink/message_definitions/v1.0/`)
 *
 * 1. **Param layout** — `common.xml:1383-1392` (`MAV_CMD_DO_MOTOR_TEST` entry)
 *    and the handler `GCS_MAVLINK_Copter::handle_MAV_CMD_DO_MOTOR_TEST`
 *    (`ArduCopter/GCS_Mavlink.cpp:997-1011`), whose own comment block
 *    (`GCS_Mavlink.cpp:999-1004`) reads:
 *    ```
 *    // param1 : motor sequence number (a number from 1 to max number of motors on the vehicle)
 *    // param2 : throttle type (0=throttle percentage, 1=PWM, 2=pilot throttle channel pass-through. See MOTOR_TEST_THROTTLE_TYPE enum)
 *    // param3 : throttle (range depends upon param2)
 *    // param4 : timeout (in seconds)
 *    // param5 : num_motors (in sequence)
 *    // param6 : motor test order
 *    ```
 *    So: `param1`=motorSeq, `param2`=throttle_type, `param3`=throttle_value,
 *    `param4`=timeout_sec, `param5`=motor_count, `param6`=test_order.
 *
 * 2. **throttle_type=0 is PERCENT (the brief's original "1=percent" assumption
 *    was wrong).** `common.xml:3116-3121`, the `MOTOR_TEST_THROTTLE_TYPE`
 *    enum: `MOTOR_TEST_THROTTLE_PERCENT=0` ("Throttle as a percentage (0 ~
 *    100)"), `MOTOR_TEST_THROTTLE_PWM=1`. Confirmed FC-side by
 *    `ArduCopter/motor_test.cpp:60-69` (`case MOTOR_TEST_THROTTLE_PERCENT:`
 *    converts `motor_test_throttle_value` as a 0-100 percentage into a PWM
 *    range) vs. `:71-73` (`case MOTOR_TEST_THROTTLE_PWM:` uses the value as a
 *    raw PWM). `runMotorTest` below always sends `param2=0`.
 *
 * 3. **`param1` is a 1-based TEST-ORDER sequence number, not a servo output
 *    channel.** Per the dialect comment above ("motor sequence number...from
 *    1 to max number of motors") and `common.xml:1385` ("Motor instance
 *    number. (from 1 to max number of motors on the vehicle)"). FC-side,
 *    `motor_test_seq` (`ArduCopter/motor_test.cpp:13,183`) is handed straight
 *    to `AP_MotorsMulticopter::output_test_seq(motor_test_seq, pwm)`
 *    (`motor_test.cpp:87`) — ArduCopter's own frame-specific motor mapping
 *    (test order -> actual output channel) happens inside that call, entirely
 *    FC-side; this module never computes or assumes a channel number. Named
 *    `motorSeq` throughout (not `channel`/`instance`) to keep that distinction
 *    visible at every call site.
 *
 * 4. **`param6` (test order) is read out of the packet in the handler's
 *    comment but never actually passed on.** `handle_MAV_CMD_DO_MOTOR_TEST`
 *    (`GCS_Mavlink.cpp:1005-1010`) calls `mavlink_motor_test_start` with only
 *    five arguments — `motor_seq`(param1), `throttle_type`(param2),
 *    `throttle_value`(param3), `timeout_sec`(param4), `motor_count`(param5,
 *    via `packet.x`) — `packet.y`/param6 (test order) is never read by this
 *    call. `mavlink_motor_test_start`'s own signature
 *    (`ArduCopter/motor_test.cpp:141-142`) has no test-order parameter at
 *    all. So in Copter, `param6` is effectively ignored; this module still
 *    sends it as `0` (`MOTOR_TEST_ORDER_DEFAULT`, `common.xml:3105-3107`) for
 *    protocol completeness, but callers should not expect it to do anything.
 *
 * 5. **The FC keeps outputting for `timeout_sec` then stops on its own.**
 *    `mavlink_motor_test_start` (`motor_test.cpp:141-194`) stores
 *    `motor_test_timeout_ms = MIN(timeout_sec, MOTOR_TEST_TIMEOUT_SEC)*1000`
 *    (`:180`) and returns immediately (`MAV_RESULT_ACCEPTED`, `:193`) —
 *    acceptance is synchronous and does not wait out the timeout. The
 *    periodic `motor_test_output()` (`:19-92`, run from the main loop) then
 *    checks elapsed time each tick (`:29-30`) and calls `motor_test_stop()`
 *    once `timeout_sec` has elapsed (single-motor case, `motor_count<=1`,
 *    `:46-48`) — the FC, not this module or the UI, is what actually
 *    guarantees the motor stops if nothing renews it. This is exactly why
 *    `motorSafety.ts`'s renewal model exists (see that module's doc) and why
 *    `runMotorTest` below defaults `timeoutS` short.
 *
 * 6. **`timeout_sec=0` stops (effectively) immediately.** With
 *    `motor_test_timeout_ms=0`, the very next `motor_test_output()` tick sees
 *    `(now - motor_test_start_ms) >= 0` (`:30`) and — for the single-motor
 *    case — calls `motor_test_stop()` (`:46-48`) on that same tick, i.e.
 *    within one main-loop iteration, not a synchronous in-command effect.
 *    `motor_test_stop()` itself (`:197-228`) disarms the motors (`:210`) and
 *    clears `ap.motor_test` (`:207`). `stopMotorTest`/`stopAllMotors` below
 *    rely on this: they send `throttle_value=0`, `timeout_sec=0`.
 *
 * 7. **`motor_count=0` behaves as 1.** `mavlink_motor_test_start`:
 *    `if (motor_count == 0) motor_count = 1;` (`motor_test.cpp:144-146`),
 *    matching `common.xml:1389`'s own doc ("0=1 motor, 1=1 motor, 2=2
 *    motors..."). This module always sends `param5=0` (single motor, the only
 *    mode it drives) rather than `1`, matching the dialect's documented
 *    default.
 *
 * `MAV_CMD_DO_MOTOR_TEST` is already in `command.ts`'s `DANGEROUS_COMMANDS`
 * (Task 5.1) — `sendCommand` forces `retries=0` for it regardless of what's
 * passed here; nothing in this module needs to (or may) override that.
 */
import { sendCommand, CommandTimeoutError, type CommandAck } from '../../core/mavlink/command'
import { MAV_CMD_DO_MOTOR_TEST } from '../../core/mavlink/commandIds'
import type { MavSession } from '../../core/mavlink/session'

/** `MOTOR_TEST_THROTTLE_TYPE` enum value for percent (`common.xml:3118`) — see module doc point 2. NOT 1 (that's PWM). */
const MOTOR_TEST_THROTTLE_PERCENT = 0

/** `MOTOR_TEST_ORDER_DEFAULT` (`common.xml:3105-3107`) — sent for completeness even though Copter's handler never reads it (module doc point 4). */
const MOTOR_TEST_ORDER_DEFAULT = 0

/** `motor_count=0` behaves as "1 motor" FC-side (module doc point 7) — this module only ever drives a single motor per command. */
const SINGLE_MOTOR_COUNT = 0

/**
 * Hard cap on `throttlePercent`, enforced by `runMotorTest` regardless of
 * caller input — defense-in-depth against a UI slider bug or a direct caller
 * exceeding the intended bench-test range, even though the UI slider (Task
 * 9.3) is already meant to cap at this value.
 */
export const MOTOR_TEST_MAX_PERCENT = 30

/**
 * Default `timeoutS` for `runMotorTest` — short on purpose (module doc point
 * 5): this is the window the FC keeps a motor spinning before stopping it on
 * its own, and `motorSafety.ts`'s renewal model (`onRenew`, every `renewMs`
 * ~400ms) depends on it staying well under a second so a stalled renew loop
 * fails safe quickly.
 */
const DEFAULT_TIMEOUT_S = 1.0

/**
 * Padding added on top of `timeoutS*1000` for the `sendCommand` ACK-wait
 * timeout, so a real (fast, synchronous-accept per module doc point 5) ACK
 * is never raced against — and, more importantly, is never cut short by — a
 * `sendCommand` timeout window sized only for the FC's own output duration.
 * The ACK-wait window and the motor's output window are logically
 * independent, but sizing the former off the latter (with headroom) keeps a
 * caller's larger custom `timeoutS` from silently under-sizing the ACK wait.
 */
const ACK_TIMEOUT_PADDING_MS = 500

/** `sendCommand`'s own default (1500ms) is used for stop commands' ACK wait unless overridden — stop's `timeout_sec` param is always 0, so there's no motor-output duration to pad against. */
const STOP_ACK_TIMEOUT_MS = undefined

export interface RunMotorTestParams {
  /** 1-based motor TEST-ORDER sequence number (not a servo output channel) — see module doc point 3. */
  motorSeq: number
  /** Throttle percentage, 0-100 as given; hard-clamped to `[0, MOTOR_TEST_MAX_PERCENT]` before sending. */
  throttlePercent: number
  /** Seconds the FC keeps outputting before stopping on its own (module doc point 5). Default `DEFAULT_TIMEOUT_S` (1.0) — keep short to support the renewal model. */
  timeoutS?: number
}

export interface MotorTestOpts {
  /** Injectable in place of the real `sendCommand` (`command.ts`), for tests. */
  sendCommandFn?: typeof sendCommand
  /** Overrides the `sendCommand` ACK-wait `timeoutMs`. `runMotorTest` otherwise derives it from `timeoutS` (see `ACK_TIMEOUT_PADDING_MS`); `stopMotorTest`/`stopAllMotors` otherwise use `sendCommand`'s own default. */
  commandTimeoutMs?: number
}

function clampPercent(v: number): number {
  return Math.min(MOTOR_TEST_MAX_PERCENT, Math.max(0, v))
}

/**
 * Sends `MAV_CMD_DO_MOTOR_TEST` to spin one motor at `throttlePercent`
 * (percent, hard-clamped to `[0, MOTOR_TEST_MAX_PERCENT]`) for up to
 * `timeoutS` seconds (default short, see `DEFAULT_TIMEOUT_S`) before the FC
 * stops it on its own. `retries` stay forced to 0 (`DANGEROUS_COMMANDS`).
 * Resolves with the `CommandAck` for any final result (including a rejected
 * one) — same contract as `sendCommand` itself; only a timeout rejects.
 */
export function runMotorTest(
  session: MavSession,
  params: RunMotorTestParams,
  opts: MotorTestOpts = {},
): Promise<CommandAck> {
  const sendCommandFn = opts.sendCommandFn ?? sendCommand
  const timeoutS = params.timeoutS ?? DEFAULT_TIMEOUT_S
  const commandTimeoutMs = opts.commandTimeoutMs ?? Math.round(timeoutS * 1000) + ACK_TIMEOUT_PADDING_MS

  return sendCommandFn(
    session.router,
    session.target,
    {
      command: MAV_CMD_DO_MOTOR_TEST,
      param1: params.motorSeq,
      param2: MOTOR_TEST_THROTTLE_PERCENT,
      param3: clampPercent(params.throttlePercent),
      param4: timeoutS,
      param5: SINGLE_MOTOR_COUNT,
      param6: MOTOR_TEST_ORDER_DEFAULT,
    },
    { timeoutMs: commandTimeoutMs },
  )
}

/**
 * Best-effort stop for one motor: sends `MAV_CMD_DO_MOTOR_TEST` with
 * `throttle_value=0`, `timeout_sec=0` (module doc point 6 — the FC stops on
 * its very next tick). `motorSeq` defaults to 1 when omitted (matching the
 * brief's original two-arg `stopMotorTest(session)` shape); for a target
 * unknown to the caller, use `stopAllMotors` instead.
 *
 * An ACK **timeout** resolves with `undefined` rather than rejecting — this
 * is the safety-relevant behavior: a stop's ACK not arriving does not mean
 * the FC didn't act (module doc point 6 says the stop is near-immediate and
 * server-driven, independent of the ACK round trip), and the safety layer
 * (`motorSafety.ts`) must never be blocked from completing a stop sequence
 * by an unconfirmable ACK. Any other rejection (a genuine caller/programming
 * error, e.g. `CommandUsageError`) still propagates.
 */
export async function stopMotorTest(
  session: MavSession,
  motorSeq = 1,
  opts: MotorTestOpts = {},
): Promise<CommandAck | undefined> {
  const sendCommandFn = opts.sendCommandFn ?? sendCommand
  try {
    return await sendCommandFn(
      session.router,
      session.target,
      {
        command: MAV_CMD_DO_MOTOR_TEST,
        param1: motorSeq,
        param2: MOTOR_TEST_THROTTLE_PERCENT,
        param3: 0,
        param4: 0,
        param5: SINGLE_MOTOR_COUNT,
        param6: MOTOR_TEST_ORDER_DEFAULT,
      },
      { timeoutMs: opts.commandTimeoutMs ?? STOP_ACK_TIMEOUT_MS },
    )
  } catch (err) {
    if (err instanceof CommandTimeoutError) return undefined // may have taken effect -- see doc above
    throw err
  }
}

/**
 * Stops every motor 1..`motorCount` (1-based, module doc point 3) by looping
 * `stopMotorTest` — `MAV_CMD_DO_MOTOR_TEST` is inherently per-motor (no
 * "all motors" sentinel in the protocol), so "stop all" is this GCS-side
 * loop, not a single command. Sequential (not concurrent): `sendCommand`'s
 * own doc notes `COMMAND_ACK` carries no nonce, so concurrent same-command
 * calls against the same target can have their ACKs cross-resolve — for a
 * safety-critical "stop everything" path, avoiding that ambiguity is worth
 * more than the small time saved by parallelizing. Never throws: each
 * `stopMotorTest` call is already best-effort (timeouts resolve `undefined`).
 */
export async function stopAllMotors(
  session: MavSession,
  motorCount: number,
  opts: MotorTestOpts = {},
): Promise<void> {
  for (let seq = 1; seq <= motorCount; seq++) {
    await stopMotorTest(session, seq, opts)
  }
}
