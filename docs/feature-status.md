# Feature Status and Gap Analysis vs. MicoConfigurator

This document records the features novaX Configurator has completed, and the features not yet implemented compared with the direct competitor product [MicoConfigurator](https://micoair.com/configurator/) (a browser-based ArduPilot/PX4 configurator). Used for roadmap scheduling.

> **Status premise**: All "completed" items below have been implemented and verified via unit tests + ArduPilot SITL, but **have not yet been verified on real hardware or deployed to production**. MicoConfigurator is a shipped, released product.
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
- Per-motor test + sequence test (`DO_MOTOR_TEST`, throttle_type=percent, 30% hard cap)
- Propeller-removal confirmation gate + arming countdown + **six-layer emergency stop** (window blur / tab hidden / Esc key / leaving the page / revoking prop-removal confirmation / STOP button — each one actually sends a stop command to the flight controller) + two idle timeouts + stall detection
- Global red/amber safety banner
- Frame layout diagram (synced with the Setup frame selection) + **manual identification workflow** (test each motor + confirm, without auto-modifying `SERVOx_FUNCTION`)

### Parameter Table
- Full pull (gap-filling), search / prefix grouping, staged edits, diff drawer, batch write with per-row read-back verification, failed writes stay highlighted red, unsaved-changes exit warning

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

1. **Map + Mission Planning** — Live map, waypoints, takeoff/land, survey grid missions + camera trigger, cruise/climb speed, terrain elevation (opentopodata), offline tile caching, follow-me/tracking. Entire page missing.
2. **Logs** — Browse/download/delete SD card dataflash logs (`.BIN`/`.ulg`) via MAVLink FTP, with in-browser analysis: multi-chart plotting, FFT, GPS track, health checks, CSV export, drag-and-drop of local logs. Entire page missing.
3. **Live Charts** — Real-time telemetry plotting ("live log viewer"). The telemetry stream layer already exists but isn't wired to any charts.
4. **RTK** — RTCM injection, base station serial connection, satellite status, forwarding to the flight controller.
5. **Hardware** — Vendor product catalog/shopping guide (we plan to link out to a parts catalog; the page itself is not built).

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

**Dashboard:**
- **3D Attitude Visualization** (Mico uses three.js; we only have 2D)

**Console:**
- **Interactive MAVLink console / command input** (we only have a read-only STATUSTEXT panel)

**Firmware Page:**
- **PX4 firmware support**
- **Multi-vehicle-type selection** (Copter / Plane / Rover / Sub / Heli / Tracker) + **stable/beta/latest channels** — we only target our own Copter boards and mirror our own firmware; we cannot download arbitrary ArduPilot vehicle-type firmware

### C. Cross-page / Overall Gaps

- **PX4 support** (Mico supports ArduPilot + PX4; we only support ArduPilot)
- **Automatic motor mapping with automatic parameter changes** (we've downgraded this to manual identification)
- **PWA / offline install** (Mico is a PWA; cut from M1)

---

## III. Suggested Priority for Closing Gaps

Ordered by "the competitor's most visible gap + what best leverages our existing infrastructure":

1. **Live Charts** — The telemetry stream layer already exists, so wiring up charts is the fastest win, and it's also a point of praise for Mico in the community.
2. **Log download + analysis** — Requires MAVLink FTP (already scheduled for phase 2 in M1) + dataflash parsing; high value.
3. **PID tuning + flight modes + RC mapping** — Rounds out the Settings page, moving from "can configure" to "can tune."
4. **Map mission planning / RTK / PX4 / 3D attitude** — Prioritize further based on demand.

---

## IV. Our Differentiating Advantages over Mico (Already Implemented)

- **Driver-free serial firmware update** (Mico's DFU path requires installing WinUSB via Zadig on Windows)
- **Pre-write review gate for calibration + read-back confirmation throughout parameter writes** (informed by the lesson of a competitor that once silently corrupted users' compass configurations)
- **Six-layer emergency stop for motor testing + stop commands that actually reach the flight controller** (not just a UI state machine)
