# Feature Gap Analysis vs. axPlanner

This document compares novaX Configurator against [axPlanner](https://github.com/novaX-ALUX/axPlanner) (the in-house Flutter/Dart desktop GCS for axFC, v1.0.3), the same way `feature-status.md` compares against MicoConfigurator. Used for roadmap scheduling.

> **Method premise**: This comparison is based on **source-code analysis of both sides** (axPlanner commit as of 2026-07-08, ~80k lines of Dart), not on axPlanner's docs or screen list. Every axPlanner feature was classified as *real implementation*, *partial*, or *placeholder UI* by reading the actual code. Our side was cross-checked against `feature-status.md` and matches it almost 1:1.
>
> **Key finding**: axPlanner nominally has ~30 screens, but roughly a third are placeholder UIs with no backend wiring (mock data, no-op buttons). Only the "real" tier below counts as a gap for us.
>
> **Revised 2026-07-16**: Live charts done on our side (v0.3.0–v0.5.0, hardware-verified); §V re-ordered and boundary labels applied per ADR-0002 (bench/flight boundary). **axPlanner disposition settled by that ADR: archived, zero further investment, no users** — this document and the archived repo are its remaining value.

---

## I. Real Gaps — axPlanner has a working implementation, we have nothing

Ordered by roadmap value for us:

| # | Feature | axPlanner implementation (source evidence) | Notes for us |
|---|---------|--------------------------------------------|--------------|
| 1 | **Live telemetry charts** | Real: fl_chart, 100 ms sampling, 60 s rolling window, selectable variables, persisted selection (`telemetry_chart.dart`) | **Done on our side** (v0.3.0–v0.5.0, hardware-verified) — and without their resampling model (see ADR-0001). No longer a gap. |
| 2 | **Flight action commands** | Real: arm/disarm (400), mode change, servo (183) / relay (181), set home (179), reboot (246), baro/gyro preflight cal (241) (`actions_screen.dart`, `quick_actions.dart`) | **Flight-side — blocked by ADR-0002**: the flight-command class does not exist in our core layer until the GCS milestone's safety ADR creates it. Their `FS_THR_ENABLE` enum bug (§III) is the cautionary tale. |
| 3 | **PID tuning** | Real (Copter only): `ATC_ANG_*` / `ATC_RAT_*` / `PSC_*` / `WPNAV_*` sliders live-bound to the parameter store (`software_config_screen.dart`). Plane/Heli/Rover tuning screens exist but are unreachable dead code. | Our biggest Settings gap vs both competitors. |
| 4 | **Parameter metadata + `.param` files** | Real: ArduPilot XML metadata (display name / description / range / enum labels / units), `.param` save/load, two-file diff with reboot-required heuristic (`parameter_metadata.dart`, `param_comparison.dart`). "Compare to defaults" is a placeholder. | Our param table shows raw names and values only. Small investment, large value. |
| 5 | **DataFlash log download** | Real: `LOG_REQUEST_LIST` / `LOG_REQUEST_DATA` 90-byte chunked download with progress + `LOG_ERASE` (`logs_screen.dart:182-319`). **No `.BIN` parser anywhere** — raw bytes only. Their "Log Analysis" tab charts synthetic sine waves. | `LOG_REQUEST_*` is far simpler than MAVLink FTP. They shipped download without FTP — corrects our `feature-status.md` assumption that logs depend on FTP (M1 phase 2). |
| 6 | **MAVLink Inspector** | Real: decodes every message via generated registry, 5000-message rolling buffer, per-type Hz via 1 s timer, CSV export, separate OS window (`mavlink_inspector_provider.dart`) | Our decode stack exists; this is cheap and high-value for debugging. |
| 7 | **RC calibration + flight-mode config** | Real but incomplete: RC cal writes `RCn_MIN`/`RCn_MAX` only (no TRIM, no reverse, no pre-load of current values); `FLTMODE1..6` hardcoded Copter-only map | Both missing on our side; also listed in the Mico gap analysis. |
| 8 | **Serial-port / servo-output config** | Real: `SERIAL0..6` protocol (44 options) + baud with encoded/raw decoding; 16 channels × `SERVOn_FUNCTION` (~80 functions) / MIN / MAX / TRIM / REVERSED. Same mature read-params → edit → write-back pattern across rangefinder / airspeed / optical-flow / sprayer / SmartRTL panels. | Our setup framework (stage → review → write with read-back) can host these directly. |
| 9 | **Mission planning** | Real core: waypoint editor with 15 MAV_CMD types, standard mission upload/download handshake (`MISSION_REQUEST_LIST` → `MISSION_COUNT` → `MISSION_ITEM_INT` loop → `MISSION_ACK`), lawnmower survey-grid generator (genuine geometry), QGC WPL 110 `.waypoints` file I/O, local geofence/rally drawing. **Fence/rally are never uploaded to the FC** (no `MAV_MISSION_TYPE_FENCE`/`RALLY` anywhere). KML import/export, terrain profile (terrain.ardupilot.org), and the map context menu ("Fly to Here" etc.) are fully written but never mounted — unreachable dead code. | Entire page missing on our side; largest engineering item. |
| 10 | **ESC 4-Way ecosystem** | The most mature code in their repo: 4-Way bootloader protocol over `SERIAL_CONTROL` (device=10), AM32 + SiLabs parameter tables with grouped/conditional display, EEPROM read (48 B) with cross-ESC mismatch detection, firmware flashing (Intel HEX, paged erase, 256 B chunked write, per-family address math) (`esc_settings_panel.dart`, `fourway_protocol.dart`) | Strategic differentiator for the in-house ESC product line. Technically feasible in-browser (we already have Web Serial + MAVLink). See §IV lessons before building. |
| 11 | **Voice alerts** | Real: 2 s telemetry threshold polling (battery %, GPS fix/HDOP, arm transitions, fence, vibration), per-key 30 s cooldowns, native TTS via MethodChannel, 4-language templates (`warning_manager.dart`, `speech_service.dart`). One no-op stub: `_dismissWarningByKey` never clears the stale GPS-lost warning. | Browser has Web Speech API — low cost. |
| 12 | **MAVFTP** | Real (implemented in the feature layer, absent from their core): correct opcode table (0–15, 128/129), paginated `listDirectory` with NAK/EOF handling, 239-byte chunked download/upload with progress, delete. Weaknesses: target sys/comp hardcoded 1/1, no burst-read, no rename/mkdir. | M2 scope; log download does not depend on it (see #5). |
| 13 | **Multi-vehicle telemetry + hardware self-test** | Multi-vehicle: real per-sysid demux over a single link, 30 s stale cleanup — monitoring only. Self-test: 14 real threshold checks against live telemetry (incl. closed-loop motor test listening for `ESC_TELEMETRY_1_TO_4` RPM) + `.param` file vs board diff (`test_screen.dart`) | Lower priority but genuinely implemented. |
| 14 | **tlog recording** | Backend real (MissionPlanner-compatible format: 8-byte µs timestamp + raw packet), but the `RecordingIndicator` widget is never instantiated — feature unreachable in their UI | Format reference if we ever record telemetry logs. |

## II. Phantom Gaps — axPlanner "has" these, but they are placeholder UIs

Do **not** count these as gaps. They are competitive intelligence: the directions axPlanner wants to go but has not built.

- **Video stream** — fake 2 s connect timer, hardcoded 1920×1080/30fps info, no decoder of any kind (self-documented placeholder).
- **FFT analysis** — no FFT computation, no windowing; hardcoded Gaussian peaks at "typical" frequencies with `Random(42)`.
- **tlog replay** — polished UI, but source comment admits "Generate simulated data since we can't parse actual tlog yet"; exports are SnackBars.
- **Log analysis tab** — synthetic sine-wave demo data only.
- **Photo georeferencing** — fake image/GPS data, no EXIF, no file I/O.
- **Joystick** — no HID/gamepad input read; `_sendRcOverride()` is a no-op, `RC_CHANNELS_OVERRIDE` never sent.
- **Antenna tracker** — no MAVLink command ever sent; connect flips a local boolean.
- **Bluetooth** — self-documented stub with `Future.delayed` fake scan; orphaned.
- **MAVLink signing** — generates a local key but never sends `SETUP_SIGNING`; verify fabricates a matching remote state.
- **MAVLink mirror** — no socket ever opened; forwarding stats are random numbers on a 1 s timer.
- **NMEA output** — correct sentence math, but GPS source is a random walk and there is no real serial/TCP output.
- **Offline map download** — fake progress timer, no HTTP fetch, no filesystem write.
- **Proximity** — fixed-seed synthetic obstacle field; no `DISTANCE_SENSOR`/`OBSTACLE_DISTANCE` parsing.
- **OpenDroneID** — all data hardcoded; no `OPEN_DRONE_ID_*` messages.
- **DroneCAN param/firmware tabs** — buttons show "in preparation" SnackBars (node discovery / restart / bus config **are** real).
- **Warning-rule builder screen** — `_checkTriggers()` is an explicit no-op (the separate automatic voice-warning system is real, see §I #11).

## III. Our Advantages (confirmed in both codebases)

- **Write safety**: every param write is read-back verified with float32 precision-loss guard; mag cal uses `autosave=0` + pre-write diff review. axPlanner writes without review and has real bugs: **`FS_THR_ENABLE` enum mismatch** (selecting "RTL" writes 2 = Continue-in-Auto), the `BATT_MONITOR` dropdown is never written, and its embedded setup panels show hardcoded defaults instead of pre-reading current FC values.
- **Motor test safety**: our 6 kill switches + idle timeouts + stalled-tick detection + 30% hard cap vs. their single "props removed" checkbox with a 50 ms command resend loop while ticked.
- **Flashing reliability**: both sides have a real bootloader protocol, but we add SHA-256 image verification + board_id hard gate + WebUSB DFU brick recovery — driver-free and install-free.
- **Code honesty & tests**: no mock data or TODO debt in our source; unit tests + SITL integration tests. Their test suite is 5 files with stale imports, alongside the large placeholder surface documented in §II.

## IV. Lessons to Absorb (bugs they already paid for)

1. **Never apply MAVLink v2 trailing-zero truncation to `SERIAL_CONTROL` (msgid 126)** — the 4-Way CRC low byte gets trimmed and the receiver's residual buffer corrupts CRC checks. Their parser special-cases this msgid. Mandatory when we build ESC passthrough.
2. **128 KB-flash ESCs need ADDRESS_SHIFT=2** — route all flash/EEPROM addresses through a single encode function (EEPROM 0x1F800→0x7E00, app 0x1000→0x400); SiLabs parts use shift=0.
3. **Log download and log parsing can ship as two separate milestones** — but don't leave downloaded `.BIN` bytes unparsed indefinitely like they did.
4. **Config panels must pre-read current FC values before editing** — their embedded panels showing hardcoded defaults is the anti-pattern; our stage → review → write flow already avoids it.

## V. Roadmap Order (revised 2026-07-16; feature-status.md §III now mirrors this)

1. **Parameter metadata + `.param` import/export** — smallest investment, both competitors have it, directly upgrades the params page (also the most visible UI gap in the side-by-side audit)
2. **MAVLink Inspector** — decode stack ready, debugging staple; covers the safe part of the Console gap
3. **PID tuning + flight modes + RC calibration** — "can configure" → "can tune"
4. **Log download via `LOG_REQUEST_*`** — do **not** wait for FTP; download and `.BIN` parsing may split into two milestones, but no unparsed-bytes limbo (§IV lesson 3)

Off the ordered list:
- ~~Live charts~~ — **done** (was #1).
- **ESC 4-Way** — bench-side, in scope, **its own project** outside this order (ADR-0002 rule 4); §IV lessons 1–2 are prerequisites.
- **Flight action command panel** / **Mission planning** — flight-side, **GCS milestone** (ADR-0002); not schedulable from this list.
