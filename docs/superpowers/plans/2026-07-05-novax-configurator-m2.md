# novaX Configurator M2 Implementation Plan (rev2, revised per Codex + ArduPilot source review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On top of the already-merged M1 protocol stack, deliver five M2 feature surfaces: real-time telemetry stream + Dashboard, Setup (frame/ESC/battery/failsafe), sensor calibration (accelerometer six-position + compass, with a review gate before writes), motor test (six-layer safety interlock + a stop that truly reaches the flight controller), and an assembly guide drawer.

**Context:** M1 has been merged into main (69 commits, 352 tests, verified on real-hardware SITL). Reusable: `src/core/transport`, `src/core/mavlink` (FrameParser/MavRouter/sendCommand/ParamStore/encode-decode/defs), the connection store, the parameter table page, the firmware page. Spec sources: `docs/design/novaX-Configurator.dc.html` (the single source of visual truth) + three screen-spec explorations + Codex's line-by-line protocol review of the local ArduPilot source (`flight_controller/firmware/ardupilot`) (2026-07-05, session `019f20fc`).

**Architecture:** A new telemetry core layer `telemetry.ts` (stream requests + typed subscriptions); calibration/motor commands go through the existing `sendCommand`; **accelerometer calibration is driven by the flight controller sending `ACCELCAL_VEHICLE_POS` (42429) back to the GCS**, requiring an inbound command subscription; **compass apply goes through `DO_ACCEPT_MAG_CAL` (42425) so the flight controller atomically writes the full set of compass params**, rather than hand-writing `COMPASS_OFS_*`; parameter-class writes (Setup, undo) go through `ParamStore.set` with readback. Features only depend on core's public interfaces.

**Tech Stack:** Same as M1, no new runtime dependencies.

## Global Constraints (carried over from M1 + Codex revisions, followed by default in every task)

- Browser runtime must not use Node-exclusive APIs; parameter writes use ParamStore.set with readback confirmation, never bypassed
- **The dangerous-command allowlist must be expanded** (Task 5.1): the existing `DANGEROUS_COMMANDS` only contains 241/245/246/400/209, missing **42424 (DO_START_MAG_CAL) / 42425 (DO_ACCEPT_MAG_CAL) / 42426 (DO_CANCEL_MAG_CAL) / 42429 (ACCELCAL_VEHICLE_POS)** — the premise that calibration/motor commands use retries=0 depends on this expansion
- **Calibration and motor testing are the highest-risk surfaces in the whole project**: any parameter modification must be explicitly disclosed + reversible + logged in the session log. Compass results must be reviewed before being written — never silent. **Starting compass calibration implicitly writes `COMPASS_LEARN=0` — this must be clearly disclosed in both the UI and the log** (it is not a "zero writes" operation)
- **Motor emergency-stop must truly reach the flight controller**: internally, ArduCopter's motor test soft-arms and keeps outputting for `timeout_sec`. We adopt a **short-timeout renewal model** — each test command is given a 0.5–1s timeout, renewed while the UI is active; `stop()` makes a best-effort send of a percent=0/timeout=0 stop command; an ACK timeout is treated as "may have already taken effect." A UI state machine alone is not sufficient to guarantee the motors actually stop.
- Motor `throttle_type=0` is percent (`1=PWM`; the design assumption once had this reversed); motor param1 is a **1-based motor sequence number (test order)**, not the SERVO output channel
- UI copy goes through i18next (en fully populated; zh/ko/ja keys complete); visuals follow the design mockup, tokens reused from M1 Task 3.0
- Disconnection is a normal state: the telemetry stream stops on disconnect and re-requests on reconnect; calibration/motor test on disconnect → safe state + honest notice
- npm test / tsc / lint / build all green; conventional commits; MockTransport-driven TDD

**M2 downgrades/deferrals** (Codex recommendation): the auto-mapping wizard **defaults to a downgraded "test motors one by one + user manually identifies" flow** — M2 does not auto-write SERVOx_FUNCTION; Dashboard 3D attitude and complex battery-percentage logic are cut (prefer displaying `battery_remaining`; if unknown, show voltage without percentage); multiple compasses use a fan-out data structure + report table, no elaborate visualization; pdef parameter metadata is deferred (Setup uses hardcoded enums); the console is out of scope for this M2 round (originally listed under M2 in the spec, explicitly excluded this round).

---

## Phase 5 — Telemetry Stream Core Layer + Session Pipeline

### Task 5.1: Expand the dangerous-command allowlist + command id constants

**Files:** Modify: `src/core/mavlink/command.ts` (DANGEROUS_COMMANDS); Create: `src/core/mavlink/commandIds.ts` (named constants); Test: update command.test.ts

- Add 42424/42425/42426/42429 to DANGEROUS_COMMANDS; add a new named-constants file (DO_START_MAG_CAL/DO_ACCEPT_MAG_CAL/DO_CANCEL_MAG_CAL/ACCELCAL_VEHICLE_POS/DO_MOTOR_TEST/SET_MESSAGE_INTERVAL/REQUEST_DATA_STREAM/PREFLIGHT_CALIBRATION/REQUEST_MESSAGE…) for later tasks to reference
- Test: each newly added id with `retries>0` throws CommandUsageError; single-send verification
- Commit

### Task 5.2: Telemetry stream request + typed subscription `telemetry.ts`

**Files:** Create: `src/core/mavlink/telemetry.ts`;Test: `__tests__/telemetry.test.ts`

**Interfaces(Produces):**
```ts
interface TelemetryState {                    // latest values, unit-converted, fields nullable
  attitude?: { rollDeg: number; pitchDeg: number; yawDeg: number; ts: number }   // ATTITUDE rad→deg
  power?: { voltage?: number; current?: number; batteryRemaining?: number; ts: number } // mV→V, cA→A, -1→undefined
  gps?: { fixType: number; satellites: number; hdop?: number; ts: number }        // eph==UINT16_MAX→undefined
  rc?: { channels: number[]; rssi?: number; ts: number }
  servo?: { outputs: number[]; ts: number }
  heartbeat?: { armed: boolean; customMode: number; baseMode: number; systemStatus: number; ts: number }
}
class Telemetry {
  constructor(router: MavRouter, target: { sysid: number; compid: number },
    opts?: { sendCommandFn?: ...; now?: () => number })
  requestStreams(msgRates?: Partial<Record<TelemetryMsg, number>>): Promise<void> // SET_MESSAGE_INTERVAL(511) per msg
  stopStreams(): Promise<void>                 // interval_us=-1 per msg;call before disconnect
  getState(): Readonly<TelemetryState>
  subscribe(cb: (s: Readonly<TelemetryState>) => void): () => void  // throttled ~10Hz
  dispose(): void
}
```
- **All units/sentinel values are converted here** (Codex): ATTITUDE rad→deg; SYS_STATUS voltage mV→V, current cA→A, battery_remaining=-1→undefined; GPS eph=UINT16_MAX→undefined
- `requestStreams` uses SET_MESSAGE_INTERVAL(511) one message at a time (ATTITUDE/SYS_STATUS/GPS_RAW_INT/RC_CHANNELS/SERVO_OUTPUT_RAW); on ACK rejection/old-firmware fallback, use REQUEST_DATA_STREAM(66) by stream group (**not an exact per-message equivalent, noted in comments**); stopStreams uses interval_us=-1
- Subscription notifications are throttled (inject `now`, not hard-bound to Date.now); on disconnect (router linkState lost/idle) freeze the snapshot; dispose unsubscribes
- TDD: feed each message frame → getState converts correctly; 511 command encoding; fallback path; throttling; freeze on disconnect; dispose has no leaks
- Commit

### Task 5.3: fixture expansion

**Files:** Modify: `scripts/gen-fixtures.py`;committed fixture output

- pymavlink additions: ATTITUDE/SYS_STATUS/GPS_RAW_INT/RC_CHANNELS/SERVO_OUTPUT_RAW/HEARTBEAT (armed+disarmed), **inbound COMMAND_LONG cmd=42429 (ACCELCAL_VEHICLE_POS, each face + success/failure)**, **MAG_CAL_PROGRESS(191)/MAG_CAL_REPORT(192)**, **COMMAND_ACK for DO_MOTOR_TEST**; `frames.expected.json` carries authoritative decoded values
- Commit

### Task 5.4: Expose a controlled MavSession from the connection store

**Files:** Modify: `src/store/connection.ts`;Create: `src/core/mavlink/session.ts` (thin wrapper)

- Current state: the connection store only exposes `paramStore`. M2's calibration/motor/telemetry classes all need router+target. Expose a controlled `MavSession { router, target, paramStore, telemetry }` (or equivalent getter), with a lifecycle bound to the connection (per M1's single-router fact: reconnect rebuilds the entire session)
- Test: connect → session available; disconnect → session cleared + each member disposed; reconnect → rebuilt
- Commit

## Phase 6 — Dashboard

### Task 6.1: Telemetry lifecycle wiring

**Files:** Modify: `src/store/connection.ts` (on connect build Telemetry+requestStreams, on disconnect stopStreams+dispose);Create: `src/features/dashboard/useTelemetry.ts`

- Parallel to the ParamStore lifecycle; rebuilt on reconnect; hook provides a throttled snapshot
- Test: connect → request; disconnect → stop; reconnect → rebuild (MockTransport)
- Commit

### Task 6.2: Dashboard page

**Files:** Create: `src/features/dashboard/{DashboardPage.tsx, AttitudeIndicator.tsx, PowerCard.tsx, GpsCard.tsx, RcChannelsCard.tsx, MotorOutputsCard.tsx, VehicleCard.tsx}`

- Per the design mockup: 2D artificial horizon + heading tape; VEHICLE (armed/flight mode/pre-arm/frame); POWER (**prefer battery_remaining; if absent, show voltage without percentage** — do not default to 4S 13.2–16.8); GPS (fix/sats/hdop, fix_type drives the color scale); MOTOR OUTPUTS (normalized SERVO bars); RC (8 channels + raw PWM)
- Flight mode: HEARTBEAT.custom_mode → ArduCopter mode name (built-in table)
- Empty state on disconnect; read-only
- Test: each card renders from a given snapshot; fix_type/armed branches; unknown-battery branch; empty state
- Commit

## Phase 7 — Setup Page

### Task 7.1: Parameter enum metadata `paramEnums.ts`

**Files:** Create: `src/features/setup/paramEnums.ts`;Test

- Hardcoded enums: FRAME_CLASS/FRAME_TYPE, MOT_PWM_TYPE, BATT_MONITOR, BATT_CAPACITY (num), BATT_LOW_VOLT (num), FS_THR_ENABLE, BATT_FS_LOW_ACT, FS_GCS_ENABLE
- **Clicking a frame tile must stage both FRAME_CLASS and FRAME_TYPE together** (the design mockup listing only FRAME_TYPE is a defect: Quad=1/Hex=2/Octo=3)
- Commit

### Task 7.2: setupDirty staging store + Setup page

**Files:** Create: `src/features/setup/{SetupPage.tsx, FrameSelector.tsx, EscProtocol.tsx, BatteryMonitor.tsx, Failsafes.tsx, SetupDirtyBar.tsx, setupStore.ts}`

- setupStore: fields initialized from ParamStore's current values; control onChange optimistically updates + stages (deduplicated by param); sticky pending bar with `PARAM → value` chips
- "Write to board": ParamStore.set with readback one by one, three states (reusing the write UX from Task 3.2), failures stay marked red; "Revert": restore ParamStore's last known value (not a hardcoded constant)
- Touching FS*/BATT_FS* sets fsTouched (for the guide); frame/ESC once explicitly written sets the corresponding touched flag (for the guide's step2 real detection)
- On disconnect: pending cleared + notice
- Test: staging/dedup/mixed writes/revert restores real value/disconnect clears/touched flags
- Commit

## Phase 8 — Sensor Calibration

### Task 8.1: Accelerometer calibration protocol `accelCal.ts` (driven by inbound commands)

**Files:** Create: `src/core/mavlink/accelCal.ts`;Test (MockTransport + scripted inbound 42429)

**Must verify before implementing** (Codex emphasis — the implementer should first read `libraries/AP_AccelCal/AP_AccelCal.cpp` within the task): the flight controller periodically sends **COMMAND_LONG cmd=42429 (ACCELCAL_VEHICLE_POS)** to the GCS, with param1 encoding the current face and success/failure. The frontend **drives the UI off the inbound 42429**, with STATUSTEXT used only for display/fallback. The exact capture-confirm reply mechanism must be verified against the source.

**Produces:**
```ts
class AccelCalibration {
  constructor(session, opts?)
  start(): Promise<void>                        // PREFLIGHT_CALIBRATION param5=1 (converted to COMMAND_INT.x==1)
  onFacePrompt(cb: (face: AccelFace) => void): () => void   // subscribes to inbound 42429, maps face via param1
  captureFace(): Promise<void>                  // advances via the source-confirmed reply mechanism (not the legacy ACK path — the source comments call it unsafe)
  abandon(): Promise<void>                       // ⚠ there is no external MAVLink cancel; this is "abandon UI + disconnect state", it does not claim the flight controller has cancelled
  readonly status: 'idle'|'running'|'busy'|'done'|'failed'
  onComplete(cb: (ok: boolean, message?: string) => void): () => void  // 42429 success/failure or STATUSTEXT
  dispose(): void
}
```
- Face sequence level→left→right→nosedown→noseup→back; **calibration boundary note**: after the last face succeeds, ArduPilot itself calls `_acal_save_calibrations()` to write INS_ACC*, so the browser has no auditable intermediate parameters — hence the review gate only applies to compass. **But the disconnect notice must not say "nothing written"**: a disconnect in the final stage may already have saved, so the notice should instead say "calibration incomplete/result unknown, please verify after reconnecting and redo from face 1"
- abandon's semantics are honest (no true cancel command exists)
- Commit

### Task 8.2: Compass calibration protocol `magCal.ts` (accept-command write)

**Files:** Create: `src/core/mavlink/magCal.ts`;Test

**Must verify before implementing**: `libraries/AP_Compass/AP_Compass_Calibration.cpp` — start saves `COMPASS_LEARN=0` (an implicit param write); once a report arrives, the flight controller **does not modify parameters**; the accept command has the flight controller atomically write offsets/diagonals/offdiagonals/scale (possibly including orientation).

**Produces:**
```ts
class MagCalibration {
  constructor(session, paramStore, opts?)
  start(): Promise<void>   // requests message interval for MAG_CAL_PROGRESS(191)+MAG_CAL_REPORT(192) itself (EXTRA3, not the Dashboard stream);
                           // DO_START_MAG_CAL autosave=0 (does not auto-save, awaits review); notifies the user that COMPASS_LEARN will be set to 0
  cancel(): Promise<void>  // DO_CANCEL_MAG_CAL(42426)
  onProgress(cb: (p: { compassId: number; completionPct: number; calStatus: number; attempt: number; direction: ... }) => void): () => void  // fields per ardupilotmega.xml, not "samples"
  onReport(cb: (r: MagCalReport) => void): () => void   // fitness, ofs/diag/offdiag/scale, compass_id, cal_status;one per compass_id
  buildReview(report: MagCalReport): Promise<CompassDiff[]>  // compares against ParamStore's current values, shows the compass params that will change (offsets and whatever else the report carries)
  accept(): Promise<void>  // DO_ACCEPT_MAG_CAL(42425) — flight controller atomic write;on success, reads back new values from ParamStore to confirm
  undo(prevValues: CompassParamSnapshot): Promise<void>  // writes back via ParamStore.set using the snapshot taken before accept
  stopStreams(): Promise<void>  // set the 191/192 interval to -1 when finished
  dispose(): void
}
```
- **Core of the review gate**: report → not auto-written (autosave=0) → buildReview compares against current values → UI shows before/after → user confirms → accept (flight controller writes) → readback confirms → logged (before values persist). undo writes back the pre-accept snapshot.
- **COMPASS_LEARN=0 implicit write**: disclosed explicitly at start + logged (honest, not "zero writes")
- Multiple compasses: progress/report carry compass_id, fan out to one data structure + one review row per compass (basic support)
- Fitness below threshold: report carries fitness/cal_status, UI shows a "poor fitness" warning
- Commit

### Task 8.3: Calibration page UI

**Files:** Create: `src/features/calibration/{CalibrationPage.tsx, AccelCard.tsx, CompassCard.tsx, CompassReviewTable.tsx, OrientationNote.tsx}`

- Per the design mockup: accelerometer card (six faces/rotation illustration/per-face progress segments/capture/abandon), compass card (progress ring/completion_pct/cancel), compass review state (before/after diff table + Write(=accept)/Discard), written state (undo/recalibrate), interruption banner (honest copy, see 8.1)
- **Filling design-mockup gaps**: show the current AHRS_ORIENTATION (read-only); disclose the COMPASS_LEARN=0 change at start; one ring/row per compass for multiple compasses
- Persistent review-principle bar
- Test: accelerometer face advance (scripted inbound 42429)/honest disconnect notice; compass progress→report→review→accept→readback→undo; COMPASS_LEARN disclosure; low-fitness warning; orientation display; multiple compasses
- Commit

## Phase 9 — Motor Test + Safety Interlock

### Task 9.1: Safety interlock engine `motorSafety.ts` (pure logic, extremely high coverage)

**Files:** Create: `src/features/motors/motorSafety.ts`;Test (inject clock + events, require full branch coverage)

**Produces:**
```ts
type SafetyState = 'locked'|'counting'|'ready'|'testing'
class MotorSafety {
  constructor(opts: { now; onStop: (reason: string) => void; onRenew: (activeMotors) => void; countdownMs?; idleLockMs?; spinIdleMs?; renewMs? })
  propsConfirmed: boolean
  confirmProps(v: boolean): void      // revoking confirmation while not locked → stop('Prop confirmation revoked')
  enable(): void                       // requires propsConfirmed;locked→counting(3s)→ready
  tick(): void                         // spinning 5s with no input→stop; armed 30s idle→stop;**while testing, triggers onRenew per renewMs to renew the flight-controller command**
  noteActivity(): void
  setSpinning(any: boolean, activeMotors): void   // ready⇄testing
  stop(reason: string): void           // reset→locked→onStop(reason) (the page sends a flight-controller stop command based on this)
  readonly state; readonly countdown; readonly idleLeft; readonly stopLeft
}
```
- Six emergency stops + two timeouts each individually tested (fast-forward to the 5s/30s boundary); prop-removal gate; countdown; **new onRenew**: fires periodically while testing, the page resends short-timeout test commands to active motors based on this (the UI side of the short-timeout renewal model)
- 100% branch coverage + each kill-switch independently tested
- Commit

### Task 9.2: Motor test command `motorTest.ts`

**Files:** Create: `src/features/motors/motorTest.ts`;Test (MockTransport)

**Produces:** `runMotorTest(session, { motorSeq, throttlePercent, timeoutS }): Promise<CommandAck>`
- **DO_MOTOR_TEST(209): throttle_type=0 (percent, corrected)**;param1 = **1-based motor sequence number (test order, not the SERVO channel)**, name and docs make this explicit; throttlePercent hard-capped at 30; **timeoutS defaults to 0.5–1s (short-timeout renewal)**
- `stopMotorTest(session)`: best-effort sends percent=0, timeout=0 stop; ACK timeout is treated as "may have already taken effect" (does not throw)
- 209 is already in DANGEROUS_COMMANDS (retries=0); the cap is enforced again here as well
- Test: command encoding (throttle_type=0, motorSeq, cap clamping, short timeout); stop encoding; ACK timeout does not throw
- Commit

### Task 9.3: Global safety banner + motor test page

**Files:** Create: `src/features/motors/{MotorTestPage.tsx, MotorLayout.tsx, SafetyGate.tsx, MotorSliders.tsx, ManualMapGuide.tsx}`;Modify: `src/App.tsx` (global red/amber banner, auto-stop countdown row, driven by safety state)

- Per the design mockup: three-step safety progress bar, frame layout diagram (linked to Setup's frame), prop-removal gate card, per-motor sliders (0–30% cap, disabled unless ready/testing), sequence test, global banner (MOTOR TEST ACTIVE / MOTOR OUTPUTS ENABLED + auto-stop countdown + STOP/LOCK)
- **Emergency-stop wiring**: window blur, visibilitychange hidden, Escape, leaving the page (nav), revoking prop-removal confirmation, STOP button → MotorSafety.stop → **the page sends stopMotorTest to the flight controller based on onStop**; 200ms tick; onRenew → resend short-timeout commands to active motors
- **Auto-mapping downgrade (Codex)**: M2 implements `ManualMapGuide` — test motors one by one + guide the user to verify/manually identify the order on the layout diagram, **does not auto-write SERVOx_FUNCTION**. If auto param-writing is needed later, open a separate task (requires real hardware).
- Test: safety-gate gating, slider cap, sequence, all six emergency-stop paths (jsdom events) + each stop sends a flight-controller stop command, renewal resend, banner state, manual-identification guide
- Commit

## Phase 10 — Assembly Guide Drawer

### Task 10.1: Setup Guide drawer

**Files:** Create: `src/features/guide/{SetupGuideDrawer.tsx, guideSteps.ts}`;Modify: `src/layout/Sidebar.tsx`, `src/App.tsx`

- Right-side slide-in drawer (scrim to close), 5 read-only detection steps: ① connect & pull params ② frame & ESC ③ calibration (accelDone&&compassApplied) ④ motor test ⑤ failsafe; progress bar N/5; "Open page" routing (not enforced linearly); Skip/×/scrim to close
- Completion detection: ② uses setupStore's frame/ESC touched flags (correcting the design mockup's `connected` placeholder); ⑤ fsTouched. Entirely read-only, the guide never modifies params (footer statement)
- Test: each step's derivation, routing, closing
- Commit

## Phase 11 — M2 Acceptance

- [ ] `npm test` all green;`tsc`/`lint`/`build` clean
- [ ] `SITL=1 npm test`: after requesting the telemetry stream, ATTITUDE/SYS_STATUS arrive; Setup write-readback; **compass start→report (params unchanged)→accept (params changed)→undo** (ArduPilot autotest already has this flow to cross-check against); motor test command ACK (verify throttle_type/motorSeq encoding and ACK while disarmed, without actually spinning the props)
- [ ] Real-hardware AF-F4 nano new checklist: Dashboard real-time telemetry, Setup param writes, accelerometer six-position (driven by inbound 42429), compass review gate + COMPASS_LEARN disclosure, **motor test's six emergency stops individually tested + prop removal + verify stop truly reaches the flight controller + renewal**, assembly guide
- [ ] Final full-branch review (strongest model), focused on motor emergency-stop truly reaching the flight controller + compass accept boundary + accelerometer inbound-driven flow
- [ ] superpowers:verification-before-completion recheck

## Follow-up (not in this plan)

Logs/maps/charts/RTK/PX4/Betaflight, 3D attitude, pdef metadata, auto-mapping auto param-write (requires real hardware), full console, self-hosted fonts, LGPL public-release sign-off (manual).
