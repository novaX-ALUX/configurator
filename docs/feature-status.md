# Feature Status and Gap Analysis vs. MicoConfigurator

This document records the features novaX Configurator has completed, and the features not yet implemented compared with the direct competitor product [MicoConfigurator](https://micoair.com/configurator/) (a browser-based ArduPilot/PX4 configurator). Used for roadmap scheduling.

> **Revised 2026-07-16**: Live Charts marked done (v0.3.0–v0.5.0, issues #1/#3/#4/#5); corrections from `docs/notes/mico-research-2026-07.md` applied (Console, terrain, follow-me, AI Assistant); flight-side items re-labeled per ADR-0002 (bench/flight boundary).
>
> **Status premise**: All "completed" items below have been implemented and verified via unit tests + ArduPilot SITL; Telemetry Charts is additionally hardware-verified (AF-H7_nano, 2026-07-16). The rest **have not yet been verified on real hardware or deployed to production**. MicoConfigurator is a shipped, released product.
>
> **Scope premise**: This tool only supports ArduPilot (MAVLink). It does not support PX4, nor Betaflight (MSP) — the latter isn't supported by either side, so it doesn't count as a gap against Mico.

Benchmark: MicoConfigurator's 11 sidebar pages = Dashboard / Settings / Sensors / Parameters / Console / Map / Logs / Charts / Firmware / Hardware / RTK, plus the setup wizard and PX4 support.

---

## I. Completed (All)

### Connection (global top bar)
- Web Serial port selection, baud rate, connect/disconnect, link status (idle/connecting/connected/lost)
- Flight controller identification (board type / firmware version / board ID, display only, not used as a gate)
- Disconnect/unplug toast + consistent empty states across pages

### Dashboard
- 2D artificial horizon (roll/pitch + heading tape)
- Arm status, flight mode (custom_mode decoding), pre-arm messages
- Voltage/current/battery level (prefers `battery_remaining`; if unknown, shows voltage only — does not fake a percentage from a fixed voltage range)
- GPS (fix-type color coding / satellite count / HDOP), RC 8-channel bars + raw PWM, motor output bars

### Settings (Setup) — 4 blocks completed
- Frame: `FRAME_CLASS` + `FRAME_TYPE` (illustrated tiles: quad/hex/octo)
- ESC protocol: `MOT_PWM_TYPE` (PWM / OneShot125 / DShot150/300/600)
- Battery monitor: `BATT_MONITOR`, `BATT_CAPACITY`, `BATT_LOW_VOLT`
- Failsafe: RC (`FS_THR_ENABLE`), low battery (`BATT_FS_LOW_ACT`), GCS (`FS_GCS_ENABLE`)
- All follow the "stage → review → write with read-back confirmation" pattern; failsafe options removed in AP4.0+ are flagged as legacy

### Sensor Calibration
- Accelerometer 6-position calibration (driven by the flight controller's inbound `ACCELCAL_VEHICLE_POS`, not the legacy ACK path)
- Compass calibration + **before/after diff review gate prior to write** (`autosave=0` → review → `DO_ACCEPT_MAG_CAL` lets the flight controller write atomically; offsets are never written by hand; the implicit `COMPASS_LEARN=0` write is disclosed honestly)
- Multi-compass fan-out (by `compass_id`)
- `AHRS_ORIENTATION` read-only display
- Honest messaging + undo when interrupted by a disconnect

### Motor Test
- Per-motor test + sequence test (`DO_MOTOR_TEST`, throttle_type=percent, full 0–100% range, hands-off spin duration settable 1–30 s)
- Propeller-removal confirmation gate + arming countdown + **six-layer emergency stop** (window blur / tab hidden / Esc key / leaving the page / revoking prop-removal confirmation / STOP button — each one actually sends a stop command to the flight controller) + two idle timeouts + stall detection
- Global red/amber safety banner
- Frame layout diagram (synced with the Setup frame selection) + **manual identification workflow** (test each motor + confirm, without auto-modifying `SERVOx_FUNCTION`)

### Parameter Table
- Full pull (gap-filling), search / prefix grouping, staged edits, diff drawer, batch write with per-row read-back verification, failed writes stay highlighted red, unsaved-changes exit warning

### Telemetry Charts (Live)
- Rolling 60 s window over the History Buffer, all 43 Series selectable, Unit Group subplots (true-scale axis per physical unit), pause/resume, hover crosshair readout, per-subplot legend, persisted selection (v0.3.0–v0.5.0, hardware-verified)
- Deliberate non-goals (domain rule "Samples are never fabricated"): no chart-side resampling, no shared-axis single plot — see ADR-0001 and the UI/UX problem list

### Firmware Update
- Online list (novaX boards, same-origin mirror) + local `.apj`/`.hex` drag-and-drop
- Normal update (PX4 serial bootloader, **driver-free**) + DFU brick recovery (WebUSB STM32) + software-triggered DFU entry (F4 only)
- Hard gate before erase: bootloader board_id == `.apj` board_id + SHA-256 verification; cancellation points are clearly defined, with disconnect guidance

### Console (partial)
- STATUSTEXT message stream (color-coded by severity) + link statistics (frame count / CRC errors / packet loss)

### Setup Wizard
- Right-side drawer, 5-step read-only checklist (Connection → Frame & ESC → Calibration → Motors → Failsafe), never modifies parameters

### Under the Hood (Mico has this too, but it's not user-visible)
- In-house browser-side MAVLink2 stack, telemetry stream requests (`SET_MESSAGE_INTERVAL` + `REQUEST_DATA_STREAM` fallback), 4-language i18n (en/zh/ko/ja), firmware manifest generation and on-site mirroring

---

## II. Not Yet Completed vs. MicoConfigurator (All)

### A. Entire Pages Missing

1. **Map + Mission Planning** *(flight-side — GCS milestone per ADR-0002, not on the configurator roadmap)* — Live map, waypoints, takeoff/land, survey grid missions + camera trigger, cruise/climb speed, offline tile caching. Two 2026-07-16 corrections: Mico's **terrain elevation is a disclosed non-functional stub** in their shipped web build (their own UI copy admits it — not a working feature to match), and their **"follow-me" is likely just ArduPilot's `FOLLOW` mode name localized in a mode picker**, not a companion-tracking capability.
2. **Logs** — Browse/download/delete SD card dataflash logs (`.BIN`/`.ulg`) with in-browser analysis: multi-chart plotting, FFT, GPS track, health checks, CSV export, drag-and-drop of local logs. Entire page missing. **Correction**: download does *not* require MAVLink FTP — axPlanner ships it over plain `LOG_REQUEST_LIST`/`LOG_REQUEST_DATA` (see `feature-status-vs-axplanner.md` §I #5).
3. **RTK** *(flight-side — GCS milestone per ADR-0002)* — RTCM injection, base station serial connection, satellite status, forwarding to the flight controller.
4. **Hardware** — Vendor product catalog/shopping guide (we plan to link out to a parts catalog; the page itself is not built).

### B. Pages Built, but Sub-features Still Missing

**Settings (Setup):**
- **PID Tuning** (entire block, ~106 related parameters in Mico) — the biggest gap
- **Flight Mode Configuration** (flight modes ↔ flight mode channels)
- **RC Channel Mapping / channel mapping**
- **EKF Source Selection** (PosXY / PosZ / VelXY / VelZ / Yaw)
- **Serial Port Function Configuration** (`SERIALx_PROTOCOL`, etc.)
- **ESC Passthrough** (BLHeli passthrough), **motor direction reversal** (DShot reverse), **bidirectional DShot** configuration
- **Battery Calibration Coefficients** (`BATT_VOLT_MULT` / `BATT_AMP_PERVLT`) — only monitor/capacity/low-voltage are done, voltage-divider and current calibration are not
- **Critical Low Battery** (`BATT_CRT_VOLT` + critical failsafe action) — only "low" is done, "critical" is not
- Miscellaneous items such as **crash detection, failsafe options, min/max output, disarmed output**

**Sensor Calibration:**
- **Airspeed Calibration** (entire block, for fixed-wing)
- **Automatic compass declination** configuration, full **compass priority/ordering** configuration (multi-compass data exists, but there's no priority UI)
- **Sensor hardware inventory** (Mico's "HW ID" tab: all detected sensors + device identifiers; found in 2026-07 research, previously untracked)
- **Live sensor readouts on the calibration page** (Mico shows accel/gyro waveforms + sensor model before you calibrate — also listed as UI problem C1)

**Dashboard:**
- **3D Attitude Visualization** (Mico uses three.js; we only have 2D)

**Console:**
- **Gap is broader than previously recorded** (2026-07 correction): Mico's Console is a full MAVLink message-type monitor — per-type rate (Hz) and count table, expandable rows with raw decoded field values — plus an 8-level syslog-style severity bar. We only have a read-only STATUSTEXT panel. The safe parts of this gap are covered by the MAVLink Inspector item (§III #2).
- **Interactive command input** (Mico's TerminalTab) — **blocked by ADR-0002**: a free-form command channel bypasses the named-operation safety model. Not a gap to close before the GCS milestone's safety ADR.

**Firmware Page:**
- **PX4 firmware support**
- **Multi-vehicle-type selection** (Copter / Plane / Rover / Sub / Heli / Tracker) + **stable/beta/latest channels** — we only target our own Copter boards and mirror our own firmware; we cannot download arbitrary ArduPilot vehicle-type firmware

### C. Cross-page / Overall Gaps

- **PX4 support** (Mico supports ArduPilot + PX4; we only support ArduPilot)
- **Automatic motor mapping with automatic parameter changes** (we've downgraded this to manual identification)
- **PWA / offline install** (Mico is a PWA; cut from M1) — **deliberately deferred by ADR-0002**: PWA/offline investment bets on browser-native GCS before the GCS-milestone platform spike (browser+PWA vs Tauri) has run. Not to be picked up as a standalone gap.

---

## III. Suggested Priority for Closing Gaps

Revised 2026-07-16; matches `feature-status-vs-axplanner.md` §V (the two docs now share one order):

1. **Param metadata + `.param` import/export** — ~~both competitors have it, smallest investment~~ **implemented 2026-07-16/17** (v0.9.0–v0.12.0: metadata pipeline + display names/descriptions, collapsible groups replacing pagination, enum dropdowns, `.param` I/O through the diff-review gate, reboot-required Named Operation; Not-Default filter (#15) ships with a disclosed SITL-defaults caveat).
2. **MAVLink Inspector** — decode stack ready; also covers the safe part of the Console gap (message-type/rate table, field inspector, severity levels).
3. **PID tuning + flight mode config + RC calibration** — rounds out Settings, moving from "can configure" to "can tune." Mico's initial-tune calculator (prop size / cells / battery type) is the UX reference.
4. **Log download via `LOG_REQUEST_*`** — do not wait for MAVLink FTP; download and `.BIN` parsing may ship as two milestones, but never leave downloaded bytes unparsed indefinitely.

Outside this order: **ESC 4-Way** = its own project (ADR-0002 rule 4); **flight action panel / Mission / RTK** = GCS milestone (ADR-0002); **AI Assistant** = tracked, not scheduled (§V); **PX4 / 3D attitude / Hardware catalog** = on demand.

---

## IV. Our Differentiating Advantages over Mico (Already Implemented)

- **Driver-free serial firmware update** (Mico's DFU path requires installing WinUSB via Zadig on Windows)
- **Pre-write review gate for calibration + read-back confirmation throughout parameter writes** — the referenced competitor incident is now cited: Mico's compass-corruption reports on ArduPilot Discourse, 2026-03 ("it just screw up my internal and external compass… compass id changed"), plus an ArduPilot core developer's critique that Mico lacks traceability of changes. Both documented complaints land exactly on our safety posture — it is a marketable differentiator, not just engineering taste (see `docs/notes/mico-research-2026-07.md` §3).
- **Six-layer emergency stop for motor testing + stop commands that actually reach the flight controller** (not just a UI state machine)
- **Unit Group subplots in Charts** (true-scale axis per physical unit; Mico draws all series on one shared axis) and **no fabricated samples** (Mico resamples chart-side and discloses it in a hint)

---

## V. Tracked, Not Scheduled

### Mico's AI Assistant (found 2026-07, previously untracked)

A Settings tab that sends current parameters + recent MAVLink messages + STATUSTEXT to an AI backend and returns categorized findings/suggestions with severity and a safety disclaimer. Deliberately **not** on the gap list:

- It requires an online backend — we are a static-hosted, zero-backend app; this is an architecture/ops/privacy commitment, not a page.
- Mico itself does not market it (absent from all marketing copy and community discussion) — no evidence it wins anything.
- It sits in tension with our review-gate positioning: an AI nudging param changes is the easiest way to route users around deliberate confirmation flows.

Re-evaluate when real users create a support burden that param/STATUSTEXT self-diagnosis would measurably reduce.
