/**
 * Accelerometer 6-position calibration protocol, driven by **inbound**
 * `COMMAND_LONG` (msgid 76) `command == MAV_CMD_ACCELCAL_VEHICLE_POS`
 * (42429) messages the FC sends — this is the opposite direction from
 * `sendCommand`'s usual outbound-command/inbound-ACK model, so this file
 * does not reuse `sendCommand` to *receive* those; it subscribes on the
 * router directly and decodes `param1` itself.
 *
 * ## Protocol, verified against ArduPilot source
 * (`libraries/AP_AccelCal/AP_AccelCal.cpp`, `libraries/GCS_MAVLink/GCS_Common.cpp`
 * in the vendored `flight_controller/firmware/ardupilot` tree)
 *
 * 1. **Start.** GCS sends `COMMAND_LONG` `command=MAV_CMD_PREFLIGHT_CALIBRATION`
 *    (241), `param5=1`. `GCS_MAVLINK::handle_command_long` always converts a
 *    `COMMAND_LONG` to `COMMAND_INT` before dispatch (`param5` -> `.x`,
 *    `GCS_Common.cpp` `convert_COMMAND_LONG_to_COMMAND_INT`), and
 *    `_handle_command_preflight_calibration` checks `packet.x == 1` to call
 *    `AP::ins().get_acal()->start(this)` (`GCS_Common.cpp:4716-4726`). A
 *    normal `COMMAND_ACK` follows (`handle_command_long` always sends one,
 *    `GCS_Common.cpp:5189`), `MAV_RESULT_ACCEPTED` on success.
 *
 * 2. **FC prompts a face.** While `AP_AccelCal` is
 *    `ACCEL_CAL_WAITING_FOR_ORIENTATION`, `AP_AccelCal::update()` sends
 *    `_gcs->send_accelcal_vehicle_position(step)` about once a second
 *    (`AP_AccelCal.cpp:112-117`), which is `GCS_MAVLINK::send_accelcal_vehicle_position`
 *    — a `COMMAND_LONG` with `command=MAV_CMD_ACCELCAL_VEHICLE_POS`,
 *    `param1=step` (`GCS_Common.cpp:3332-3344`). Step values 1..6 map
 *    level/left/right/nosedown/noseup/back per the switch in
 *    `AP_AccelCal.cpp:85-102` (which only *uses* the enum); the values
 *    themselves are defined in
 *    `modules/mavlink/message_definitions/v1.0/ardupilotmega.xml:14-19`
 *    (`ACCELCAL_VEHICLE_POS_LEVEL`=1 .. `_BACK`=6) — this is an **inbound**
 *    COMMAND_LONG, not an ACK, and this module drives `onFacePrompt`
 *    straight off it.
 *
 * 3. **Capture confirm (the "advance" mechanism) — verified, NOT the old
 *    ACK-snoop path.** The GCS confirms "vehicle is posed, capture now" by
 *    sending the *same* command back: `COMMAND_LONG`/`COMMAND_INT`
 *    `command=MAV_CMD_ACCELCAL_VEHICLE_POS`, `param1` = the step it was just
 *    told to pose for. `GCS_MAVLINK::handle_command_accelcal_vehicle_pos`
 *    (`GCS_Common.cpp:4997-5006`) forwards `packet.param1` to
 *    `AP_AccelCal::gcs_vehicle_position(float position)`
 *    (`AP_AccelCal.cpp:395-405`), which only starts sample collection if
 *    `position` matches the FC's current expected step
 *    (`is_equal((float)_step, position)`) — a mismatched/stale confirm is
 *    silently rejected (`MAV_RESULT_FAILED`), it does not misfire the wrong
 *    face. Because this arrives as a plain `COMMAND_LONG`,
 *    `handle_command_long` ACKs it exactly like any other command
 *    (`GCS_Common.cpp:5189`), so `captureFace()` reuses the existing
 *    `sendCommand` outbound/ACK machinery for this specific step. This is
 *    deliberately **not** the legacy path `AP_AccelCal::handle_command_ack`
 *    documents (`AP_AccelCal.cpp:366-393`) as unsafe — that one moved the
 *    cal forward on *any* `COMMAND_ACK` with `result==MAV_RESULT_TEMPORARILY_REJECTED`
 *    regardless of source or command, which the source's own comment says
 *    is fragile on a shared MAVLink network. `MAV_CMD_ACCELCAL_VEHICLE_POS`
 *    is already in `DANGEROUS_COMMANDS` (`command.ts`), so `sendCommand`
 *    forces a single attempt (no blind retransmit of a position confirm).
 *
 * 4. **Success/failure.** Once every registered calibrator finishes and
 *    saves, `AP_AccelCal::success()`/`fail()` run and clear `_started`
 *    (`AP_AccelCal.cpp:213-250`); `update()`'s "not started, but have a
 *    last result" branch then repeats `send_accelcal_vehicle_position(
 *    ACCELCAL_VEHICLE_POS_SUCCESS)` / `..._FAILED` (`AP_AccelCal.cpp:166-183`)
 *    — the **same** inbound `COMMAND_LONG` 42429 channel as face prompts,
 *    just with `param1` set to the sentinel `16777215` (success) or
 *    `16777216` (failure) instead of a step 1-6 — `ACCELCAL_VEHICLE_POS_SUCCESS`/
 *    `_FAILED`, defined in the MAVLink dialect source
 *    `modules/mavlink/message_definitions/v1.0/ardupilotmega.xml:20-21`
 *    (not `AP_AccelCal.cpp` — that file only *uses* the enum, it doesn't
 *    define it), confirmed against this project's own `frames-m2` fixtures. `STATUSTEXT` carries
 *    the human-readable "Calibration successful"/"Calibration FAILED"
 *    (`AP_AccelCal.cpp:215`, `:241`) at `MAV_SEVERITY_CRITICAL` — the app
 *    already has a general STATUSTEXT feed (`src/store/connection.ts`,
 *    `StatusPanel`), so per the task brief ("STATUSTEXT for display/fallback only") this
 *    module does not duplicate that feed; `onComplete`'s `message` is
 *    reserved for that existing display path and is always `undefined` from
 *    here — 42429 carries no text field to source one from.
 *
 * 5. **No real cancel.** The only call site of `AP_AccelCal::cancel()` in
 *    the whole tree is `AP_InertialSensor::acal_update()`
 *    (`AP_InertialSensor.cpp:2342-2355`), gated on
 *    `hal.util->get_soft_armed()` — i.e. cancellation only happens if the
 *    vehicle is armed mid-calibration, an internal safety reaction, never a
 *    MAVLink command a GCS sends. No `handle_command_*` in
 *    `GCS_Common.cpp` reaches `cancel()`. So `abandon()` below is honest
 *    about **not** claiming the FC stopped: it only tears down this
 *    module's own reaction to further inbound signals (and resets
 *    `status`) — if the FC is still mid-sequence server-side, it keeps
 *    running/eventually times out or gets soft-armed-cancelled on its own,
 *    unaffected by `abandon()`.
 *
 * ## Save boundary (not "nothing written on disconnect")
 * `AP_AccelCal`'s success path calls each client's `_acal_save_calibrations()`
 * itself (`AP_AccelCal.cpp:153-158`, `AP_InertialSensor.cpp`'s
 * `_acal_save_calibrations` writes `INS_ACC*`) entirely FC-side, with no
 * MAVLink round trip the GCS could observe or gate — there is nothing here
 * to review before it happens. A disconnect near the end of the sequence
 * means the GCS genuinely does not know whether that save already
 * committed; `status` in that case should read as incomplete/unknown, and
 * callers must tell the user to reconnect, check `INS_ACC*`, and redo the
 * whole 6-face sequence if in doubt — never "nothing was written".
 */
import { sendCommand } from './command'
import { MAV_CMD_ACCELCAL_VEHICLE_POS, MAV_CMD_PREFLIGHT_CALIBRATION } from './commandIds'
import type { MavSession } from './session'

const COMMAND_LONG_MSGID = 76
const MAV_RESULT_ACCEPTED = 0

/** `ACCELCAL_VEHICLE_POS_*` step values, in prompt order — defined in `modules/mavlink/message_definitions/v1.0/ardupilotmega.xml:14-19` (not `AP_AccelCal.cpp`, which only uses them, see module doc). */
export type AccelFace = 'level' | 'left' | 'right' | 'nosedown' | 'noseup' | 'back'

const FACE_FOR_STEP: Readonly<Record<number, AccelFace>> = {
  1: 'level',
  2: 'left',
  3: 'right',
  4: 'nosedown',
  5: 'noseup',
  6: 'back',
}

/** `ACCELCAL_VEHICLE_POS_SUCCESS`/`_FAILED` sentinels — confirmed against this project's `frames-m2` fixtures. */
const ACCELCAL_VEHICLE_POS_SUCCESS = 16777215
const ACCELCAL_VEHICLE_POS_FAILED = 16777216

/**
 * - `idle`: not started (or `abandon()`ed since).
 * - `running`: a face prompt is outstanding — waiting for the user to pose
 *   the vehicle and call `captureFace()`. Mirrors the FC's own
 *   `ACCEL_CAL_WAITING_FOR_ORIENTATION`.
 * - `busy`: a `captureFace()`/`start()` confirm is in flight, or (once
 *   accepted) the FC is collecting that face's sample — mirrors
 *   `ACCEL_CAL_COLLECTING_SAMPLE` — until the next inbound 42429 (next face,
 *   success, or failure) arrives.
 * - `done` / `failed`: terminal, set by an inbound success/failure 42429.
 */
export type AccelCalStatus = 'idle' | 'running' | 'busy' | 'done' | 'failed'

/**
 * Default `timeoutMs` passed to `sendCommand` for `start()`/`captureFace()`
 * — well above `sendCommand`'s own 1500ms default. Real firmware runs
 * `calibrate_gyros()` synchronously inside the `PREFLIGHT_CALIBRATION`
 * handler *before* it ACKs (`GCS_Common.cpp:4716-4726`, see module doc
 * point 1), which can take longer than 1500ms — a plain default-timeout
 * `sendCommand` could reject client-side (`CommandTimeoutError`) while the
 * FC is actually still proceeding toward `MAV_RESULT_ACCEPTED`. Both
 * commands are in `DANGEROUS_COMMANDS`, so retries stay forced to 0
 * regardless — only the single attempt's timeout window changes.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 5000

export interface AccelCalibrationOpts {
  /** Injectable in place of the real `sendCommand` (`command.ts`), for tests. */
  sendCommandFn?: typeof sendCommand
  /** `timeoutMs` passed to `sendCommand` for `start()`/`captureFace()`. Default `DEFAULT_COMMAND_TIMEOUT_MS` (5000) — see that constant's doc for why the 1500ms `sendCommand` default isn't safe here. */
  commandTimeoutMs?: number
}

/** Thrown by `captureFace()` when called with no outstanding face prompt (nothing to confirm yet). */
export class AccelCalUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccelCalUsageError'
  }
}

export class AccelCalibration {
  private readonly sendCommandFn: NonNullable<AccelCalibrationOpts['sendCommandFn']>
  private readonly commandTimeoutMs: number
  private readonly unsubscribe: () => void

  private readonly facePromptListeners = new Set<(face: AccelFace) => void>()
  private readonly completeListeners = new Set<(ok: boolean, message?: string) => void>()

  private _status: AccelCalStatus = 'idle'
  private currentStep: number | undefined

  constructor(
    private readonly session: MavSession,
    opts: AccelCalibrationOpts = {},
  ) {
    this.sendCommandFn = opts.sendCommandFn ?? sendCommand
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS

    this.unsubscribe = session.router.subscribe(
      { msgid: COMMAND_LONG_MSGID, sysid: session.target.sysid, compid: session.target.compid },
      (msg) => {
        if (Number(msg.fields.command) !== MAV_CMD_ACCELCAL_VEHICLE_POS) return
        this.handleVehiclePos(Number(msg.fields.param1))
      },
    )
  }

  get status(): AccelCalStatus {
    return this._status
  }

  /** Sends `MAV_CMD_PREFLIGHT_CALIBRATION` with `param5=1` (-> `COMMAND_INT.x==1` FC-side) to enter the 6-position accel cal, waiting up to `commandTimeoutMs` (constructor opt, default `DEFAULT_COMMAND_TIMEOUT_MS`) for its ACK. Rejects (status -> `failed`) on a non-accepted/timed-out ACK — this is this call's own outcome, separate from the inbound-42429-driven `onComplete`. */
  async start(): Promise<void> {
    this._status = 'busy'
    try {
      const ack = await this.sendCommandFn(
        this.session.router,
        this.session.target,
        { command: MAV_CMD_PREFLIGHT_CALIBRATION, param5: 1 },
        { timeoutMs: this.commandTimeoutMs },
      )
      if (ack.result !== MAV_RESULT_ACCEPTED) {
        if (this._status === 'busy') this._status = 'failed'
        throw new Error(`AccelCalibration.start: PREFLIGHT_CALIBRATION rejected (result=${ack.result})`)
      }
      if (this._status === 'busy') this._status = 'running'
    } catch (err) {
      // Only clobber status if it's still what *this* call left it in —
      // a concurrent inbound 42429 (or an abandon()) may have already
      // moved it on to 'done'/'failed'/'idle' while this await was
      // pending, and that must win, not get stomped back to 'failed'.
      if (this._status === 'busy') this._status = 'failed'
      throw err
    }
  }

  /** Registers a callback for each inbound face prompt (in FC-sent order). Returns an unsubscribe function. */
  onFacePrompt(cb: (face: AccelFace) => void): () => void {
    this.facePromptListeners.add(cb)
    return () => {
      this.facePromptListeners.delete(cb)
    }
  }

  /** Registers a callback fired once on the inbound success/failure 42429. Returns an unsubscribe function. `message` is always `undefined` — see module doc's STATUSTEXT note. */
  onComplete(cb: (ok: boolean, message?: string) => void): () => void {
    this.completeListeners.add(cb)
    return () => {
      this.completeListeners.delete(cb)
    }
  }

  /**
   * Confirms "vehicle is posed for the current face, capture now" — sends
   * `MAV_CMD_ACCELCAL_VEHICLE_POS` with `param1` set to the step the FC is
   * currently waiting on (see module doc, point 3). Throws
   * `AccelCalUsageError` synchronously if there is no outstanding prompt.
   * On a non-accepted/timed-out ACK, reverts `status` back to `running`
   * (the FC-side step didn't advance) and rethrows/surfaces the rejection.
   */
  async captureFace(): Promise<void> {
    if (this._status !== 'running' || this.currentStep === undefined) {
      throw new AccelCalUsageError('AccelCalibration.captureFace: no outstanding face prompt to confirm')
    }
    const step = this.currentStep
    this._status = 'busy'
    try {
      const ack = await this.sendCommandFn(
        this.session.router,
        this.session.target,
        { command: MAV_CMD_ACCELCAL_VEHICLE_POS, param1: step },
        { timeoutMs: this.commandTimeoutMs },
      )
      if (ack.result !== MAV_RESULT_ACCEPTED) {
        // Guarded the same way as the catch block below: only revert if
        // status is still 'busy' from this call — a concurrent inbound
        // 42429 may have already moved it on while this await was pending.
        if (this._status === 'busy') this._status = 'running'
        throw new Error(`AccelCalibration.captureFace: position confirm rejected (result=${ack.result})`)
      }
      // Stays 'busy': the FC is now collecting this face's sample. The next
      // inbound 42429 (next face prompt, success, or failure) resolves it.
    } catch (err) {
      if (this._status === 'busy') this._status = 'running'
      throw err
    }
  }

  /**
   * Gives up on this calibration from the UI's side only: resets `status`
   * to `idle` and stops reacting to further inbound 42429s until the next
   * `start()`. Does **not** send anything to the FC — per the module doc,
   * there is no MAVLink command that actually cancels an in-progress accel
   * cal, so this must not (and does not) claim the FC-side sequence has
   * stopped. If the FC is still mid-sequence it keeps running server-side,
   * unaffected by this call.
   */
  async abandon(): Promise<void> {
    this._status = 'idle'
    this.currentStep = undefined
  }

  /** Unsubscribes from the router and drops all listeners. Safe to call once. */
  dispose(): void {
    this.unsubscribe()
    this.facePromptListeners.clear()
    this.completeListeners.clear()
  }

  private handleVehiclePos(param1: number): void {
    // Ignore stray/late signals once idle (post-abandon) or terminal
    // (done/failed) -- see abandon()'s doc: the FC may keep broadcasting
    // after the UI has stopped watching. Processing while 'busy' (which
    // includes start()'s own busy window, before its ACK has arrived) is
    // safe: handle_command_long ACKs PREFLIGHT_CALIBRATION synchronously,
    // *before* AP_AccelCal::update() ever gets a chance to broadcast a
    // 42429 face prompt (module doc point 1), so a real FC never sends one
    // ahead of that ACK -- there's no order to get wrong here.
    if (this._status !== 'running' && this._status !== 'busy') return

    if (param1 === ACCELCAL_VEHICLE_POS_SUCCESS) {
      this._status = 'done'
      this.currentStep = undefined
      for (const cb of this.completeListeners) cb(true)
      return
    }
    if (param1 === ACCELCAL_VEHICLE_POS_FAILED) {
      this._status = 'failed'
      this.currentStep = undefined
      for (const cb of this.completeListeners) cb(false)
      return
    }

    const face = FACE_FOR_STEP[param1]
    if (face === undefined) return // not a recognized step/sentinel -- ignore

    this.currentStep = param1
    this._status = 'running'
    for (const cb of this.facePromptListeners) cb(face)
  }
}
