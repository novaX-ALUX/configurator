# novaX Configurator Design Document

Date: 2026-07-02
Status: Pending user review
Research basis: MicoConfigurator reverse-engineering research + two rounds of Codex review (architecture 2026-07-02, MAVLink stack selection 2026-07-02, session `019f20fc-c0a4-7772-afae-3f4683a6674f`)

## 1. Background and Goals

novaX needs a purely browser-based flight controller configuration tool benchmarked against [MicoConfigurator](https://micoair.com/configurator/): the browser connects directly to a USB flight controller via Web Serial and speaks MAVLink, with no installation and no drivers required (for the normal update path), covering the entire build workflow (flash firmware → frame/ESC setup → calibration → motor test → parameters).

**Product positioning**: a general-purpose ArduPilot configurator + novaX enhancements. Connection, parameters, calibration, and motor test are available for any ArduPilot flight controller; enhancements such as the online firmware list and software-triggered DFU entry are unlocked only for novaX board IDs (6200–6209).

**Explicit non-goals (deferred past the first phase)**: map-based mission planning, log download/analysis, real-time charts, RTK injection, PX4 support, Betaflight (MSP) support, 3D airframe attitude display, hardware shopping-guide page.

## 2. Relationship to Existing Repositories

- `flight_controller`: the single source of truth for firmware. Its `scripts/release.sh` needs to be extended to generate `manifest.json` and publish it alongside GitHub Releases (see §7).
- `marketing/parts-catalog`: reference only, continues to be maintained independently. Its `/update` page's flashing engine (`serial-px4.ts`/`dfu.ts`/`apj.ts`/`intel-hex.ts` and the safety state machine in `update.astro`) serves as the reference implementation and source of real-hardware experience for this project's firmware module; this project **rewrites** it rather than extracting a shared package.
- This repository (`GC/`): the standalone novaX Configurator repository.

## 3. First-Phase Feature Scope

8 pages + build wizard:

1. **Connect** (global top bar): serial port selection, connection status, flight controller identification (board type/firmware version/board ID)
2. **Dashboard**: 2D attitude indicator, arm status, flight mode, voltage/current, GPS, RC channels, motor output
3. **Setup**: frame type (with diagram), ESC protocol, battery monitor, failsafe (RC/battery/GCS); form fields display the corresponding ArduPilot parameter names
4. **Sensor Calibration**: accelerometer six-position calibration, compass calibration (progress feedback, interruption recovery)
5. **Motor Test**: layout diagram linked to frame type, per-motor testing, auto-mapping wizard (safety gating, see §7)
6. **Parameters**: full parameter search/filter/grouping, diff preview, batch write with read-back confirmation
7. **Firmware Update**: two modes — "normal update" (driverless serial) and "DFU recovery"; online list (novaX boards) + local file drag-and-drop (any board)
8. **MAVLink Console**: message stream, STATUSTEXT highlighting, filtering

**Setup Guide**: parameter initialization → frame → motors → calibration → failsafe, with step-by-step parameter-level completion detection; can be skipped.

## 4. Technology Stack

- React 18 + Vite + TypeScript, Zustand for state management, Tailwind CSS
- i18next, launching with four languages: English/Chinese/Korean/Japanese (UI must tolerate roughly 30% text expansion)
- PWA (vite-plugin-pwa), light theme per the design mockup (2026-07-04 design mockup finalized, docs/design/novaX-Configurator.dc.html is authoritative)
- Desktop browsers (Chrome/Edge, due to Web Serial constraints); design baseline of 1280px, degrading down to 1024px
- Deployment: GitHub Pages, automatic builds via GitHub Actions

## 5. Architecture Layers

```
src/core/transport/    Connection abstraction: Transport interface
                       ├─ SerialTransport (Web Serial, production)
                       └─ WebSocketTransport (dev/CI connection to SITL bridge)
src/core/mavlink/      defs.ts     mavlink-mappings adapter layer (isolates the LGPL dependency)
                       frame.ts    MAVLink2 frame parsing/encoding (Uint8Array/DataView, no Buffer)
                       router.ts   Dispatch by (sysid, compid, msgid); heartbeat/component registry
                       command.ts  promise/retry/timeout for COMMAND_LONG + ACK
                       params.ts   Parameter protocol state machine
                       ftp.ts      (phase 2, serves log download)
src/core/firmware/     PX4 serial bootloader flashing, WebUSB STM32 DFU, apj/hex parsing, board_id verification
src/features/          dashboard / setup / motors / calibration / params / console / firmware / guide
src/workers/           Heavy computation (reserved for phase-2 log parsing)
```

Each layer can be tested independently; features depend only on core's public interfaces.

## 6. MAVLink Stack (Codex Review Conclusion)

**Selection**: the message-definition layer uses **`mavlink-mappings@1.0.20-20240131-0`** (precisely pinned, the `minimal + common + ardupilotmega` subset, imported only directly from the dialect submodules, isolated within the future `src/core/mavlink/defs.ts` adapter layer; LGPL license status PENDING-HUMAN sign-off); the frame layer/session layer is hand-written (decided in the 2026-07-02 spike, see decisions 1/2 in `docs/notes/decisions-m1.md` for details). The official **mavgen-generated TypeScript** was evaluated on 2026-07-02 and **REJECTED**: the generated message classes hard-depend on `node-mavlink` (whose source depends on Node's `stream`/`crypto`/`Buffer`, which do not run in the browser runtime), and even if this dependency were installed it would still be metadata-only with no pack/unpack. The exclusion stands: `node-mavlink` itself remains excluded as a runtime dependency and serves only as a reference implementation.

**Frame layer implementation notes** (hand-written, first version including tests estimated at 3–6 weeks):

- MAVLink2 header is 10 bytes, msgid is 24-bit LE; CRC excludes the magic byte and appends CRC_EXTRA
- Signed frames add 13 extra bytes (total overhead 25 = header 10 + CRC 2 + signature 13); when signing is not supported, frames with the signed incompat flag are dropped
- The sender trims trailing zeros from the payload, the receiver pads with zeros per the definition; the first byte must not be trimmed
- seq wraps around 0–255; packet-loss statistics are grouped by source component
- Routing: sysid/compid identify the sender; the destination is determined by `target_system/target_component` within the payload
- COMMAND_LONG retransmission is correlated via `COMMAND_ACK.command/result/progress`; dangerous commands (calibration/reboot/parameter write) go through a whitelist + UI interlock rather than blindly retransmitting

**Parameter protocol** (standard protocol for the first phase; FTP param download is phase 2):

1. `PARAM_REQUEST_LIST` performs a full pull, building the table by `param_count/param_index`, tolerating out-of-order/duplicate entries
2. After a quiet window, missing gaps are backfilled with `PARAM_REQUEST_READ(param_index)`, with a limited number of retry rounds
3. Writing a parameter via `PARAM_SET` must wait for a `PARAM_VALUE` read-back confirmation; critical parameters get an additional `PARAM_REQUEST_READ` verification
4. The cache does not claim strong consistency

## 7. Firmware Update Pipeline

- **manifest**: `flight_controller/scripts/release.sh` generates `manifest.json`, published together with the GitHub Release. Fields: `boardName, boardId, mcuFamily, vehicle, version, gitHash, files[{kind(apj|with_bl_hex), url, sha256, size}], method, softwareDfuAllowed, dfuRecoveryAllowed`.
- **Retrieval**: both manifest.json and the firmware binary files are mirrored into this site's `public/firmware/`, served same-origin by GitHub Pages (the 2026-07-02 spike confirmed that `release-assets.githubusercontent.com` does not send `Access-Control-Allow-Origin` for any release asset — including `.apj`/`.hex`/`manifest.json` — so a direct browser `fetch()` is not viable; WebUSB/PX4 serial flashing also needs the firmware bytes in an in-memory `ArrayBuffer`, so the original fallback statement of "firmware files still point to Releases" does not hold. See `docs/notes/releases-cors-spike.md` and decisions 4/5 in `docs/notes/decisions-m1.md` for details). Sync mechanism: `scripts/sync-firmware.sh` (adjacent work to Task 1.2) uses the gh CLI to pull assets from `flight_controller` Releases into `public/firmware/`.
- **Hard gate against flashing the wrong board**: the board_id returned by bootloader identify must equal the board_id inside the `.apj` before erasing is allowed; `AUTOPILOT_VERSION` is for display only (novaX's own AF-F4_T10 firmware has proven this message cannot be relied upon). sha256 verification is completed after download and before erase.
- **Normal update**: MAVLink reboot-to-bootloader → PX4 serial bootloader protocol (GET_DEVICE must query INFO_BL_REV before erasing — a pitfall verified on real hardware in parts-catalog) → flash → CRC → reboot.
- **DFU recovery**: WebUSB connects to STM32 ROM DFU (0483:DF11) and flashes the full `_with_bl.hex` image; Windows prompts for Zadig/WinUSB.
- **Software-triggered DFU entry**: enabled only for F4-series novaX boards (H7 software-triggered DFU entry has a silicon-level bricking issue, and remains disabled pending board-by-board real-hardware verification).

## 8. Safety Interlocks

- Motor test: explicit "propellers removed" confirmation → arm countdown → auto-stop on timeout during test → immediate stop on page blur/disconnect
- Parameter writes: all confirmed via read-back; diff preview before batch writes; unsaved changes are prominently flagged
- Calibration: explicit state machine, with a recovery path for interruption/disconnection
- Any automatic parameter modification must be explicitly disclosed and reversible (a lesson from the MicoConfigurator compass incident)
- Disconnection is a normal occurrence (firmware-flash reboot, cable unplugged): each page defines its disconnection behavior and reconnection recovery

## 9. Testing Strategy

- Protocol layer: unit tests using recorded real-hardware frames as fixtures (frame/router/params)
- Integration: ArduPilot SITL + WebSocket↔TCP bridge, running the real protocol end-to-end in both development and CI (made possible by the transport abstraction)
- Real-hardware matrix: AF-F4 nano prioritized (the only family with the full workflow already verified); Chrome/Edge × Windows (Zadig)/Linux (udev)/macOS permissions documented item by item
- Destructive firmware-flashing paths are verified only on real hardware; CI does not simulate them

## 10. Milestones

- **M1**: repository skeleton, transport + mavlink core (frame/router/command/params), firmware page (normal update + DFU), parameters table; manifest generation on the `flight_controller` side
- **M2**: sensor calibration, motor test + auto-mapping, setup page, Dashboard, console, setup guide, completion of four-language copy

## 11. Risk List

1. H7/F7 software-triggered DFU entry bricking (silicon-level) — remains disabled, to be enabled after board-by-board real-hardware verification
2. ~~GitHub Releases browser CORS not verified~~ — **verified via the 2026-07-02 spike and RESOLVED**: direct asset-byte connection is not viable; the strategy is locked to mirroring into `public/firmware/` (see §7, `docs/notes/releases-cors-spike.md`, decisions 4/5 in `docs/notes/decisions-m1.md`)
3. MAVLink FTP has high complexity — moved out of the first phase entirely
4. AP-RTK dual uses CAN, and browsers have no native CAN support — its web-based update is not committed to
5. Data-source drift (inconsistent specs across catalog/README/hwdef) — the firmware source of truth is unified as the flight_controller manifest; product-spec drift will be corrected separately and does not block this project
6. ~~mavgen TypeScript generator maturity~~ — **verified via the 2026-07-02 spike and RESOLVED**: mavgen-generated classes hard-depend on `node-mavlink` (Node stream/Buffer), REJECTED; `mavlink-mappings@1.0.20-20240131-0` is pinned as the selected version (see §6). Residual risks: LGPL license sign-off pending human decision, message coverage 272/325 (missing loweheiser/cubepilot/csAirLink vendor dialects) — see decisions 1/3/7 in `docs/notes/decisions-m1.md` for details
