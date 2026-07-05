/**
 * Compass (magnetometer) calibration protocol — the review-gate module this
 * project's #1 lesson-learned exists for (a competitor GCS silently
 * corrupted users' compass configs). Nothing in this file ever hand-writes
 * `COMPASS_OFS_*`/`COMPASS_DIA_*`/etc: the FC itself does that atomically,
 * only in reaction to an explicit `MAV_CMD_DO_ACCEPT_MAG_CAL` the *caller*
 * decides to send, after being shown a before/after diff.
 *
 * ## Protocol, verified against ArduPilot source
 * (`libraries/AP_Compass/AP_Compass_Calibration.cpp`, `libraries/GCS_MAVLink/
 * GCS_Common.cpp`, `libraries/GCS_MAVLink/GCS_Param.cpp`, `libraries/AP_Compass/
 * AP_Compass.cpp`, `ArduCopter/GCS_Mavlink.cpp`, `modules/mavlink/message_
 * definitions/v1.0/{ardupilotmega,common}.xml`, `Tools/autotest/
 * vehicle_test_suite.py` — all in the vendored `flight_controller/firmware/
 * ardupilot` tree)
 *
 * 1. **`MAV_CMD_DO_START_MAG_CAL` (42424) param layout** — confirmed from
 *    both the dialect XML (`ardupilotmega.xml:153-161`) and the handler
 *    (`AP_Compass_Calibration.cpp:381-411`, `Compass::handle_mag_cal_command`):
 *    `param1`=magnetometer bitmask (0=all), `param2`=retry-on-failure,
 *    `param3`=**autosave** (0=require `DO_ACCEPT_MAG_CAL`, 1=skip the review
 *    gate entirely), `param4`=delay seconds, `param5`=autoreboot. `start()`
 *    below always sends `param3=0` (autosave off — this *is* the review
 *    gate) and `param5=0` (never silently reboot the FC). `param3` is
 *    **position 3**, not 5 — do not confuse this with `MAV_CMD_
 *    PREFLIGHT_CALIBRATION`'s unrelated `param5` convention (see
 *    `accelCal.ts`'s module doc) — the two commands share no param layout.
 *
 * 2. **`COMPASS_LEARN=0` is an implicit write, not a no-op.** `Compass::
 *    _start_calibration` (`AP_Compass_Calibration.cpp:48-111`) calls
 *    `_learn.set_and_save(0)` unconditionally near its end
 *    (`AP_Compass_Calibration.cpp:108`, comment: "disable compass learning
 *    both for calibration and after completion") — every successful
 *    `start()` call causes this real, persisted param write on the FC,
 *    entirely outside the `DO_ACCEPT_MAG_CAL` review gate. `start()` below
 *    fires `onLearnDisclosure` *before* sending anything, so a caller that
 *    wires it up can never miss this — see that method's own doc for why a
 *    no-payload callback (not a return value, not a message string) was
 *    chosen.
 *
 * 3. **After a report, nothing is written yet — and once it is, the echo's
 *    timing is unpredictable relative to the ACK.** `send_mag_cal_report`
 *    (`AP_Compass_Calibration.cpp:283-332`) streams `MAG_CAL_REPORT`
 *    continuously post-completion, independent of `_accept_calibration`;
 *    the params are genuinely untouched until `DO_ACCEPT_MAG_CAL` arrives —
 *    confirmed by the autotest itself, which explicitly re-checks params are
 *    still zero right after receiving the SUCCESS report and *before*
 *    sending accept (`Tools/autotest/vehicle_test_suite.py:9965-9967`,
 *    `check_zero_mag_parameters`). Once `_accept_calibration`
 *    (`AP_Compass_Calibration.cpp:187-223`) does write, it does so via
 *    direct `set_and_save_*()` C++ calls (never through `handle_param_set`,
 *    `GCS_MAVLink/GCS_Param.cpp:263-316` — that path only echoes a
 *    `PARAM_VALUE` for a GCS-originated `PARAM_SET`, not this one). Each of
 *    those calls `AP_Param::save()`, which *queues* the write onto
 *    `save_queue` (`AP_Param/AP_Param.cpp:118,1255-1283`) rather than saving
 *    inline; a separate IO-thread handler, `save_io_handler`
 *    (`AP_Param.cpp:1289-1293`), drains that queue and calls
 *    `save_sync(force_save, send_to_gcs=true)`, which *does* broadcast a
 *    `PARAM_VALUE` via `send_parameter()` (`AP_Param.cpp:1144-1250,
 *    2630-2662`). So an echo **does** eventually arrive — just
 *    asynchronously, off the main thread, decoupled from the COMMAND_ACK
 *    `DO_ACCEPT_MAG_CAL` resolves on, with no defined ordering/timing
 *    relative to it. The autotest sidesteps this uncertainty by actively
 *    re-querying with `get_parameter`/`verify_parameter_values` after
 *    `DO_ACCEPT_MAG_CAL` (`vehicle_test_suite.py:9968-9979`) rather than
 *    racing the async echo. `accept()` below does the same: it calls
 *    `paramStore.fetchAll()` after the ACK instead of trying to correlate an
 *    IO-thread-queued broadcast whose arrival order isn't guaranteed.
 *
 * 4. **`MAV_CMD_DO_ACCEPT_MAG_CAL` (42425) writes the full set atomically.**
 *    `Compass::_accept_calibration` (`AP_Compass_Calibration.cpp:187-223`)
 *    writes, per compass: offsets (`set_and_save_offsets`, always),
 *    diagonals+off-diagonals (`set_and_save_diagonals`/
 *    `set_and_save_offdiagonals`, gated on `AP_COMPASS_DIAGONALS_ENABLED` —
 *    compiled into essentially every real GCS-facing build), scale factor
 *    (`set_and_save_scale_factor`, always), and orientation
 *    (`set_and_save_orientation`, **conditionally** — only if
 *    `cal_report.check_orientation && external && COMPASS_AUTO_ROT>=2`,
 *    none of which this GCS-side module can observe). `buildReview()` below
 *    discloses a `COMPASS_ORIENT*` diff row whenever it's cached, but a
 *    caller should not be surprised if a post-accept readback shows it
 *    unchanged — that is the source's own conditional gate, not a bug here.
 *
 * 5. **`MAV_CMD_DO_CANCEL_MAG_CAL` (42426)**: `param1`=bitmask, 0=all
 *    (`ardupilotmega.xml:173-181`, `AP_Compass_Calibration.cpp:432-448`).
 *
 * 6. **Param names, per compass_id.** `Compass`'s `AP_Param` group is
 *    registered under prefix `"COMPASS_"` (`ArduCopter/Parameters.cpp:476`,
 *    `GOBJECT(compass, "COMPASS_", Compass)`); the per-field short names are
 *    `OFS`/`OFS2`/`OFS3`, `DIA`/`DIA2`/`DIA3`, `ODI`/`ODI2`/`ODI3`
 *    (`AP_Compass.cpp:104,222,281` / `:401,440,480` / `:420,459,499`),
 *    `SCALE`/`SCALE2`/`SCALE3` (`:592,600,609`), `ORIENT`/`ORIENT2`/
 *    `ORIENT3` (`:185,350,373`) — i.e. `compass_id` 0 has no numeric suffix,
 *    1 and 2 append `2`/`3` (not `1`). `compassParamSuffix()` below encodes
 *    exactly this.
 *
 * 7. **`MAG_CAL_PROGRESS`(191)/`MAG_CAL_REPORT`(192) are on the EXTRA3
 *    stream** (`ArduCopter/GCS_Mavlink.cpp:542-566`,
 *    `STREAM_EXTRA3_msgs[]` includes `MSG_MAG_CAL_REPORT`/
 *    `MSG_MAG_CAL_PROGRESS` under `#if COMPASS_CAL_ENABLED`) — a stream
 *    group `telemetry.ts` never requests (its five dashboard messages are
 *    EXTRA1/EXTENDED_STATUS/RC_CHANNELS only). `start()` below therefore
 *    requests both intervals itself via `MAV_CMD_SET_MESSAGE_INTERVAL`
 *    before sending `DO_START_MAG_CAL`, and `stopStreams()` disables them
 *    (`interval_us=-1`) — mirroring `telemetry.ts`'s primary path, but
 *    without its `REQUEST_DATA_STREAM` legacy fallback: `DO_START_MAG_CAL`/
 *    `DO_ACCEPT_MAG_CAL` are themselves fairly modern commands, so requiring
 *    `SET_MESSAGE_INTERVAL` support too is a deliberate simplification, not
 *    an oversight — flagged here for easy reconsideration if an old-firmware
 *    target turns out to need it.
 *
 * 8. **Field names** — confirmed against `ardupilotmega.xml:1529-1540`
 *    (`MAG_CAL_PROGRESS`: `compass_id`, `cal_mask`, `cal_status`, `attempt`,
 *    `completion_pct`, `completion_mask` (`uint8_t[10]`), `direction_x/y/z`)
 *    and `common.xml:5630-5651` (`MAG_CAL_REPORT`: `compass_id`, `cal_mask`,
 *    `cal_status`, `autosaved`, `fitness`, `ofs_x/y/z`, `diag_x/y/z`,
 *    `offdiag_x/y/z`, `orientation_confidence`, `old_orientation`,
 *    `new_orientation`, `scale_factor`) — this project's own `frames-m2`
 *    fixture (compass_id 0 and 1 of each) decodes cleanly against exactly
 *    these names. `MAG_CAL_STATUS` enum values (`common.xml:4191-4200`) are
 *    exported below rather than redefined ad hoc by callers.
 */
import { sendCommand } from './command'
import {
  MAV_CMD_DO_ACCEPT_MAG_CAL,
  MAV_CMD_DO_CANCEL_MAG_CAL,
  MAV_CMD_DO_START_MAG_CAL,
  MAV_CMD_SET_MESSAGE_INTERVAL,
} from './commandIds'
import type { ParamStore } from './params'
import type { MavSession } from './session'

const MAG_CAL_PROGRESS_MSGID = 191
const MAG_CAL_REPORT_MSGID = 192

const MAV_RESULT_ACCEPTED = 0

/** Interval (µs) that disables a message via `MAV_CMD_SET_MESSAGE_INTERVAL` — same sentinel `telemetry.ts` uses. */
const STOP_INTERVAL_US = -1

/** Default rate (Hz) `start()` requests for both `MAG_CAL_PROGRESS`/`MAG_CAL_REPORT`, overridable via `MagCalibrationOpts.streamRateHz`. */
const DEFAULT_STREAM_RATE_HZ = 4

/** `MAG_CAL_STATUS` enum values (`common.xml:4191-4200`) — exported so callers compare `calStatus` against these instead of redefining them. */
export const MAG_CAL_NOT_STARTED = 0
export const MAG_CAL_WAITING_TO_START = 1
export const MAG_CAL_RUNNING_STEP_ONE = 2
export const MAG_CAL_RUNNING_STEP_TWO = 3
export const MAG_CAL_SUCCESS = 4
export const MAG_CAL_FAILED = 5
export const MAG_CAL_BAD_ORIENTATION = 6
export const MAG_CAL_BAD_RADIUS = 7

export interface MagCalProgress {
  compassId: number
  calMask: number
  calStatus: number
  attempt: number
  completionPct: number
  /** 10-element bitmask array, one bit per sphere section (`uint8_t[10]`, `ardupilotmega.xml:1536`). */
  completionMask: number[]
  direction: { x: number; y: number; z: number }
}

export interface MagCalReport {
  compassId: number
  calMask: number
  calStatus: number
  /** `0`=requires `DO_ACCEPT_MAG_CAL`, `1`=already saved to parameters (`common.xml:5635`). */
  autosaved: boolean
  fitness: number
  ofsX: number
  ofsY: number
  ofsZ: number
  diagX: number
  diagY: number
  diagZ: number
  offdiagX: number
  offdiagY: number
  offdiagZ: number
  orientationConfidence: number
  oldOrientation: number
  newOrientation: number
  scaleFactor: number
}

export interface CompassDiff {
  /** Full ArduPilot param name, e.g. `COMPASS_OFS_X` (compass 0) / `COMPASS_OFS2_X` (compass 1). */
  param: string
  /** `ParamStore`'s currently-cached value, or `undefined` if never fetched/seen. */
  current: number | undefined
  /** The value `MAG_CAL_REPORT` carries — what `accept()` is expected to make the FC write. */
  new: number
}

/** `{ paramName: preAcceptValue }`, built from a `CompassDiff[]`'s `current` values (see `snapshotFromDiffs`) — what `undo()` restores. */
export type CompassParamSnapshot = Record<string, number | undefined>

export interface MagCalibrationOpts {
  /** Injectable in place of the real `sendCommand` (`command.ts`), for tests. */
  sendCommandFn?: typeof sendCommand
  /** `timeoutMs` passed to `sendCommand` for start/accept/cancel. Default: `sendCommand`'s own default (1500ms) — unlike accel cal, these handlers ACK immediately rather than running the calibration synchronously first, so no larger override is needed. */
  commandTimeoutMs?: number
  /** Rate (Hz) requested for both `MAG_CAL_PROGRESS`/`MAG_CAL_REPORT` streams. Default `DEFAULT_STREAM_RATE_HZ` (4). */
  streamRateHz?: number
}

/** Rejected by `undo()` if one or more `ParamStore.set` calls failed — `failed` lists exactly which params are still holding their post-accept value, so a caller can retry just those. */
export class MagCalUndoError extends Error {
  constructor(public readonly failed: ReadonlyArray<{ param: string; error: unknown }>) {
    super(
      `MagCalibration.undo: failed to restore ${failed.length} param(s): ${failed.map((f) => f.param).join(', ')}`,
    )
    this.name = 'MagCalUndoError'
  }
}

/**
 * Thrown by `accept()` specifically when the `DO_ACCEPT_MAG_CAL` ACK itself
 * is non-accepted — i.e. nothing was written, safe to retry (module doc
 * point 3/`accept()`'s own doc). A distinct type (not a plain `Error` with a
 * matchable message) so callers like `useCompassCalibration.ts`'s
 * `classifyAcceptFailure` can distinguish this from the *other* accept
 * failure mode (the post-ACK `paramStore.fetchAll()` confirm call failing)
 * by `instanceof`, not by regexing `.message` — a message string is
 * incidental copy, not a contract a caller should parse.
 */
export class MagCalAcceptRejectedError extends Error {
  constructor(public readonly result: number) {
    super(`MagCalibration.accept: DO_ACCEPT_MAG_CAL rejected (result=${result})`)
    this.name = 'MagCalAcceptRejectedError'
  }
}

/** `compass_id` 0 has no numeric suffix; 1 and 2 append `2`/`3` — see module doc point 6. */
function compassParamSuffix(compassId: number): string {
  return compassId === 0 ? '' : String(compassId + 1)
}

/** Turns a `CompassDiff[]` (as returned by `buildReview`) into the `{param: current}` snapshot `undo()` expects — the pre-accept values worth restoring. */
export function snapshotFromDiffs(diffs: readonly CompassDiff[]): CompassParamSnapshot {
  const snapshot: CompassParamSnapshot = {}
  for (const d of diffs) snapshot[d.param] = d.current
  return snapshot
}

export class MagCalibration {
  private readonly sendCommandFn: NonNullable<MagCalibrationOpts['sendCommandFn']>
  private readonly commandTimeoutMs: number | undefined
  private readonly streamRateHz: number

  private readonly unsubscribeProgress: () => void
  private readonly unsubscribeReport: () => void

  private readonly progressByCompass = new Map<number, MagCalProgress>()
  private readonly reportByCompass = new Map<number, MagCalReport>()

  private readonly progressListeners = new Set<(p: MagCalProgress) => void>()
  private readonly reportListeners = new Set<(r: MagCalReport) => void>()
  private readonly learnDisclosureListeners = new Set<() => void>()

  constructor(
    private readonly session: MavSession,
    private readonly paramStore: ParamStore,
    opts: MagCalibrationOpts = {},
  ) {
    this.sendCommandFn = opts.sendCommandFn ?? sendCommand
    this.commandTimeoutMs = opts.commandTimeoutMs
    this.streamRateHz = opts.streamRateHz ?? DEFAULT_STREAM_RATE_HZ

    const { router, target } = session
    this.unsubscribeProgress = router.subscribe(
      { msgid: MAG_CAL_PROGRESS_MSGID, sysid: target.sysid, compid: target.compid },
      (msg) => this.handleProgress(msg.fields),
    )
    this.unsubscribeReport = router.subscribe(
      { msgid: MAG_CAL_REPORT_MSGID, sysid: target.sysid, compid: target.compid },
      (msg) => this.handleReport(msg.fields),
    )
  }

  /** Latest `MAG_CAL_PROGRESS` seen per `compass_id` (fan-out for multi-compass — see module doc). */
  get latestProgress(): ReadonlyMap<number, MagCalProgress> {
    return this.progressByCompass
  }

  /** Latest `MAG_CAL_REPORT` seen per `compass_id`. */
  get latestReport(): ReadonlyMap<number, MagCalReport> {
    return this.reportByCompass
  }

  /**
   * Requests `MAG_CAL_PROGRESS`(191)/`MAG_CAL_REPORT`(192) at `streamRateHz`
   * (module doc point 7), fires `onLearnDisclosure` (module doc point 2),
   * then sends `MAV_CMD_DO_START_MAG_CAL` with `param3` (autosave) forced to
   * `0` — the review gate this whole module exists for — and `param5`
   * (autoreboot) forced to `0`. Rejects if the ACK isn't
   * `MAV_RESULT_ACCEPTED`.
   */
  async start(): Promise<void> {
    for (const cb of this.learnDisclosureListeners) cb()

    await this.setMessageInterval(MAG_CAL_PROGRESS_MSGID, this.streamIntervalUs())
    await this.setMessageInterval(MAG_CAL_REPORT_MSGID, this.streamIntervalUs())

    const ack = await this.sendCommandFn(
      this.session.router,
      this.session.target,
      {
        command: MAV_CMD_DO_START_MAG_CAL,
        param1: 0, // magnetometer bitmask, 0 = all
        param2: 0, // retry on failure: off
        param3: 0, // autosave: OFF -- forces the review gate (module doc point 1)
        param4: 0, // delay
        param5: 0, // autoreboot: OFF -- never silently reboot the FC
      },
      { timeoutMs: this.commandTimeoutMs },
    )
    if (ack.result !== MAV_RESULT_ACCEPTED) {
      throw new Error(`MagCalibration.start: DO_START_MAG_CAL rejected (result=${ack.result})`)
    }
  }

  /** Sends `MAV_CMD_DO_CANCEL_MAG_CAL` (all compasses). Rejects if the ACK isn't `MAV_RESULT_ACCEPTED`. */
  async cancel(): Promise<void> {
    const ack = await this.sendCommandFn(
      this.session.router,
      this.session.target,
      { command: MAV_CMD_DO_CANCEL_MAG_CAL, param1: 0 },
      { timeoutMs: this.commandTimeoutMs },
    )
    if (ack.result !== MAV_RESULT_ACCEPTED) {
      throw new Error(`MagCalibration.cancel: DO_CANCEL_MAG_CAL rejected (result=${ack.result})`)
    }
  }

  /** Registers a callback for every inbound `MAG_CAL_PROGRESS`. Returns an unsubscribe function. */
  onProgress(cb: (p: MagCalProgress) => void): () => void {
    this.progressListeners.add(cb)
    return () => {
      this.progressListeners.delete(cb)
    }
  }

  /** Registers a callback for every inbound `MAG_CAL_REPORT`. Params are NOT changed yet when this fires (module doc point 3). Returns an unsubscribe function. */
  onReport(cb: (r: MagCalReport) => void): () => void {
    this.reportListeners.add(cb)
    return () => {
      this.reportListeners.delete(cb)
    }
  }

  /**
   * Registers a callback fired once per `start()` call, synchronously
   * before anything is sent, signaling that `COMPASS_LEARN` is about to be
   * implicitly set to 0 (module doc point 2). Deliberately a no-payload
   * event, not a message string: this module has no i18n of its own, so the
   * user-facing copy belongs to the caller's UI layer (`CompassCard`), which
   * renders its own localized copy every time this fires rather than
   * displaying this layer's English text raw. A callback (mirroring this
   * codebase's established `onXxx` event idiom — `accelCal.ts`'s
   * `onFacePrompt`/`onComplete`, `params.ts`'s `onChange`,
   * `router.ts`'s `onLinkState`) rather than a `start()` return value, so a
   * caller can wire up logging/UI disclosure once and have it fire for
   * every `start()`, not just the first. Returns an unsubscribe function.
   */
  onLearnDisclosure(cb: () => void): () => void {
    this.learnDisclosureListeners.add(cb)
    return () => {
      this.learnDisclosureListeners.delete(cb)
    }
  }

  /**
   * Builds the before/after diff `report` implies: `COMPASS_OFS[n]_X/Y/Z`
   * always (the minimum set), plus `DIA`/`ODI`/`SCALE`/`ORIENT` rows only
   * when `paramStore` already has a cached value for that name (module doc
   * point 4 — some of these may not exist on every build/compass). `current`
   * comes from `paramStore.get`; nothing is written here. Pass the returned
   * array through `snapshotFromDiffs` to get the pre-accept snapshot
   * `undo()` expects.
   */
  async buildReview(report: MagCalReport): Promise<CompassDiff[]> {
    const suffix = compassParamSuffix(report.compassId)
    const diffs: CompassDiff[] = []

    const required: Array<[string, number]> = [
      [`COMPASS_OFS${suffix}_X`, report.ofsX],
      [`COMPASS_OFS${suffix}_Y`, report.ofsY],
      [`COMPASS_OFS${suffix}_Z`, report.ofsZ],
    ]
    for (const [param, value] of required) {
      diffs.push({ param, current: this.paramStore.get(param)?.value, new: value })
    }

    const optional: Array<[string, number]> = [
      [`COMPASS_DIA${suffix}_X`, report.diagX],
      [`COMPASS_DIA${suffix}_Y`, report.diagY],
      [`COMPASS_DIA${suffix}_Z`, report.diagZ],
      [`COMPASS_ODI${suffix}_X`, report.offdiagX],
      [`COMPASS_ODI${suffix}_Y`, report.offdiagY],
      [`COMPASS_ODI${suffix}_Z`, report.offdiagZ],
      [`COMPASS_SCALE${suffix}`, report.scaleFactor],
      [`COMPASS_ORIENT${suffix}`, report.newOrientation],
    ]
    for (const [param, value] of optional) {
      const cached = this.paramStore.get(param)
      if (cached === undefined) continue
      diffs.push({ param, current: cached.value, new: value })
    }

    return diffs
  }

  /**
   * Sends `MAV_CMD_DO_ACCEPT_MAG_CAL` (all compasses) — the FC then writes
   * the full mag param set atomically (module doc point 4), never through
   * this module. After a `MAV_RESULT_ACCEPTED` ACK, calls
   * `paramStore.fetchAll()` to confirm: the FC's own `PARAM_VALUE` echo for
   * this write is real but queued asynchronously on its IO thread, with no
   * defined timing relative to the `COMMAND_ACK` (module doc point 3) — so
   * racing that echo (or trusting the pre-accept cache) can't reliably
   * confirm anything; actively re-requesting the table can. A rejection
   * from the `fetchAll()` call means the FC-side write already happened but
   * this layer couldn't confirm it; a rejection from the ACK itself throws
   * the typed `MagCalAcceptRejectedError` and means nothing was written.
   * Callers distinguishing the two should catch and check `instanceof
   * MagCalAcceptRejectedError`, not regex the rejection's `.message`.
   */
  async accept(): Promise<void> {
    const ack = await this.sendCommandFn(
      this.session.router,
      this.session.target,
      { command: MAV_CMD_DO_ACCEPT_MAG_CAL, param1: 0 },
      { timeoutMs: this.commandTimeoutMs },
    )
    if (ack.result !== MAV_RESULT_ACCEPTED) {
      throw new MagCalAcceptRejectedError(ack.result)
    }
    await this.paramStore.fetchAll()
  }

  /**
   * Restores `prevValues` (typically `snapshotFromDiffs()`'s output from the
   * `buildReview()` call made before `accept()`) via `paramStore.set` — a
   * deliberate hand-write, since this is the "restore known-good" path, not
   * the FC-driven accept path. Entries whose `current` was `undefined`
   * (never cached) are skipped — there is nothing known-good to restore
   * them to. Attempts every entry even if some fail, then throws
   * `MagCalUndoError` listing exactly which ones didn't make it, so a
   * caller can retry just those instead of not knowing which subset of the
   * snapshot actually got restored.
   */
  async undo(prevValues: CompassParamSnapshot): Promise<void> {
    const entries = Object.entries(prevValues).filter(
      (e): e is [string, number] => e[1] !== undefined,
    )
    const results = await Promise.allSettled(entries.map(([param, value]) => this.paramStore.set(param, value)))

    const failed: Array<{ param: string; error: unknown }> = []
    results.forEach((r, i) => {
      if (r.status === 'rejected') failed.push({ param: entries[i][0], error: r.reason })
    })
    if (failed.length > 0) throw new MagCalUndoError(failed)
  }

  /** Disables `MAG_CAL_PROGRESS`/`MAG_CAL_REPORT` (`interval_us=-1`). Call when leaving the calibration UI. */
  async stopStreams(): Promise<void> {
    await this.setMessageInterval(MAG_CAL_PROGRESS_MSGID, STOP_INTERVAL_US)
    await this.setMessageInterval(MAG_CAL_REPORT_MSGID, STOP_INTERVAL_US)
  }

  /** Unsubscribes from the router and drops all listeners. Safe to call once. */
  dispose(): void {
    this.unsubscribeProgress()
    this.unsubscribeReport()
    this.progressListeners.clear()
    this.reportListeners.clear()
    this.learnDisclosureListeners.clear()
  }

  // --- internals ---------------------------------------------------------

  private streamIntervalUs(): number {
    return Math.round(1_000_000 / this.streamRateHz)
  }

  /**
   * Sends `MAV_CMD_SET_MESSAGE_INTERVAL` for `msgid`/`intervalUs`, best
   * effort: a rejected/timed-out ACK is swallowed rather than thrown,
   * because `MAG_CAL_PROGRESS`/`MAG_CAL_REPORT` are EXTRA3-stream telemetry
   * (module doc point 7) — losing them means the UI won't see live
   * progress/report frames, not that the calibration itself (driven by
   * `DO_START_MAG_CAL`, sent separately) should be blocked.
   */
  private async setMessageInterval(msgid: number, intervalUs: number): Promise<void> {
    try {
      await this.sendCommandFn(
        this.session.router,
        this.session.target,
        { command: MAV_CMD_SET_MESSAGE_INTERVAL, param1: msgid, param2: intervalUs },
        { timeoutMs: this.commandTimeoutMs },
      )
    } catch {
      // best-effort -- see doc above
    }
  }

  private handleProgress(fields: Record<string, unknown>): void {
    const p: MagCalProgress = {
      compassId: Number(fields.compass_id),
      calMask: Number(fields.cal_mask),
      calStatus: Number(fields.cal_status),
      attempt: Number(fields.attempt),
      completionPct: Number(fields.completion_pct),
      completionMask: (fields.completion_mask as number[]).map(Number),
      direction: {
        x: Number(fields.direction_x),
        y: Number(fields.direction_y),
        z: Number(fields.direction_z),
      },
    }
    this.progressByCompass.set(p.compassId, p)
    for (const cb of this.progressListeners) cb(p)
  }

  private handleReport(fields: Record<string, unknown>): void {
    const r: MagCalReport = {
      compassId: Number(fields.compass_id),
      calMask: Number(fields.cal_mask),
      calStatus: Number(fields.cal_status),
      autosaved: Number(fields.autosaved) !== 0,
      fitness: Number(fields.fitness),
      ofsX: Number(fields.ofs_x),
      ofsY: Number(fields.ofs_y),
      ofsZ: Number(fields.ofs_z),
      diagX: Number(fields.diag_x),
      diagY: Number(fields.diag_y),
      diagZ: Number(fields.diag_z),
      offdiagX: Number(fields.offdiag_x),
      offdiagY: Number(fields.offdiag_y),
      offdiagZ: Number(fields.offdiag_z),
      orientationConfidence: Number(fields.orientation_confidence),
      oldOrientation: Number(fields.old_orientation),
      newOrientation: Number(fields.new_orientation),
      scaleFactor: Number(fields.scale_factor),
    }
    this.reportByCompass.set(r.compassId, r)
    for (const cb of this.reportListeners) cb(r)
  }
}
