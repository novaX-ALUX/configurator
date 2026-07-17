# DroneCAN ESC-over-MAVLink Research — 2026-07

Evidence pack for GitHub issue [#48](https://github.com/novaX-ALUX/configurator/issues/48) (`novaX-ALUX/configurator`,
"ESC support for the in-house CAN (DroneCAN) ESC line") — a work-circle grill input, not a spec. Answers five
sub-questions about how a GCS configures DroneCAN ESC nodes through an ArduPilot flight controller over MAVLink,
each checked against the source that owns the fact.

**Local vendored ArduPilot checkout used for all source citations**: `../flight_controller/firmware/ardupilot`
(relative to this repo's root), branch `main`, commit `92b0cd788ec29406f26c6f9c31d5ceedbd1cc538`, `ArduCopter/version.h`
reports `FW_MAJOR 4 / FW_MINOR 6 / FW_PATCH 3` (`FIRMWARE_VERSION_TYPE_DEV`) — i.e. Copter 4.6.3-dev. No exact tag is
checked out (`git describe --tags` returns nothing on this checkout), so file/line citations below are pinned to that
commit SHA, not a release tag. All web sources accessed 2026-07-17.

---

## Executive summary

A bench-side Web Serial GCS (one physical serial link speaking MAVLink2, no native CAN adapter) **can** do
everything Mission Planner's DroneCAN GUI does today, because Mission Planner's own modern connection path
(`ConnectionTypes.MAVLinkCAN1`, see §2) is *itself* nothing but a plain MAVLink serial session: it repeats
`MAV_CMD_CAN_FORWARD` once a second and exchanges `CAN_FRAME`/`CANFD_FRAME`/`CAN_FILTER_MODIFY` messages over the
same link already carrying HEARTBEAT/PARAM/etc. There is no separate transport, no raw byte-level SLCAN handshake,
and no requirement for a second COM port in this mode. Concretely, over that one serial link a GCS can:

- **Enable DroneCAN ESC output** by writing five ordinary MAVLink parameters (`CAN_P1_DRIVER`, `CAN_D1_PROTOCOL`,
  `CAN_D1_UC_ESC_BM`, `CAN_D1_UC_ESC_OF`, plus `SERVOx_FUNCTION`) — no CAN transport needed at all for this part,
  it's the existing PARAM_SET/PARAM_VALUE machinery (§1).
- **Discover DroneCAN nodes and read/write their DroneCAN parameters** — this *does* need the CAN-forward
  machinery, and it works over serial (§2).
- **Push a DroneCAN ESC firmware update** — architecturally identical to node discovery/param access (same
  `CAN_FRAME` relay carrying `uavcan.protocol.file.*` service calls), but with a throughput/latency cost worth
  sizing before committing to it (§3): a 1 MB firmware image is roughly 4,000 file-read round trips and, over
  classic (non-FD) CAN, on the order of 100k+ individual `CAN_FRAME` MAVLink messages end to end.
- **Run `MAV_CMD_DO_MOTOR_TEST` against a DroneCAN ESC and get the same spin as a PWM ESC** — confirmed in source,
  not inferred: `output_test_seq()` writes into the same generic `SRV_Channels` output array that
  `AP_DroneCAN::SRV_push_servos()` reads every loop to build `uavcan_equipment_esc_RawCommand` (§4).

The one thing that is **not** transparent: ArduPilot's wiki-documented "DroneCAN GUI" instructions (§2) still lead
with the *older* SLCAN-over-dedicated-serial-port route, which explicitly **breaks MAVLink on that port for the
duration** ("After enabling SLCAN, you will no longer be able to connect via MAVLINK" — Mission Planner's own UI
copy). That older route is irrelevant to us only because Mission Planner's current `ConfigDroneCAN.cs` also offers
the CAN-forward-over-MAVLink route as a first-class, non-exclusive option — confirmed directly in MP source, not
inferred from docs (§2). Our implementation should target the CAN-forward route only and never assume the SLCAN
route.

Sub-question 5 (`mavlink-mappings` dialect coverage) is a clean yes: `CAN_FRAME` (386), `CANFD_FRAME` (387),
`CAN_FILTER_MODIFY` (388), and `MAV_CMD_CAN_FORWARD` (32000) are all defined in `common.js`, not `ardupilotmega.js`,
and all four are present in `common.REGISTRY`/`common.COMMANDS` at the pinned version (§5).

---

## 1. Enabling DroneCAN ESC output in ArduPilot

Verified directly against the vendored source's `AP_Param::GroupInfo` tables, which is where the on-wire parameter
name (as reported over MAVLink `PARAM_VALUE`) is assembled from nested `AP_GROUPINFO`/`AP_SUBGROUPINFO` prefixes.

**Full parameter chain, confirmed by reading the group-prefix nesting, not guessed:**

| Param (on the wire) | Source | Meaning |
|---|---|---|
| `CAN_P1_DRIVER` | `libraries/AP_CANManager/AP_CANIfaceParams.cpp:23-29` — group prefix `P1_` set in `libraries/AP_CANManager/AP_CANManager.cpp:65` (`AP_SUBGROUPINFO(_interfaces[0], "P1_", ...)`), param name `DRIVER` | Binds physical CAN interface 1 to a virtual driver slot. `@Values: 0:Disabled,1:First driver,2:Second driver,3:Third driver`. `AP_PARAM_FLAG_ENABLE` — this is the "enable" param for the interface. `@RebootRequired: True`. |
| `CAN_D1_PROTOCOL` | `libraries/AP_CANManager/AP_CANManager_CANDriver_Params.cpp:27-34` — group prefix `D1_` at `AP_CANManager.cpp:82` (`AP_SUBGROUPINFO(_drv_param[0], "D1_", ...)`), param `PROTOCOL` | Selects which protocol driver runs on virtual driver 1. `@Values: 0:Disabled,1:DroneCAN,4:PiccoloCAN,6:EFI_NWPMU,7:USD1,8:KDECAN,10:Scripting,11:Benewake,12:Scripting2,13:TOFSenseP,14:RadarCAN`. Default is `DroneCAN` (`float(AP_CAN::Protocol::DroneCAN)`). `@RebootRequired: True`. |
| `CAN_D1_UC_ESC_BM` | `libraries/AP_CANManager/AP_CANManager_CANDriver_Params.cpp:37-40` (`AP_SUBGROUPPTR(_uavcan, "UC_", ...)` → `AP_DroneCAN`) + `libraries/AP_DroneCAN/AP_DroneCAN.cpp:113-118` (`AP_GROUPINFO("ESC_BM", ...)`) | Bitmask, one bit per output channel (bit 0 = output 1 … bit 31 = output 32), selecting which `SRV_Channel` outputs are sent as DroneCAN `esc.RawCommand` instead of/in addition to PWM. |
| `CAN_D1_UC_ESC_OF` | `AP_DroneCAN.cpp:143-148` (`AP_GROUPINFO("ESC_OF", ...)`) | "Offset for ESC numbering in DroneCAN ESC RawCommand messages... If your ESCs are on servo functions 5 to 8 and you set this parameter to 4 then the ESC RawCommand will be sent with the first 4 slots filled." Range 0-18. Packing optimization, not a functional requirement. |
| `CAN_D1_UC_NODE` | `AP_DroneCAN.cpp:97-103` (`AP_GROUPINFO("NODE", ...)`) | The flight controller's own DroneCAN node ID on this bus (default `AP_DRONECAN_DEFAULT_NODE`), separate from any ESC's node ID. |
| `SERVOx_FUNCTION` | outside `AP_CANManager`/`AP_DroneCAN` — `SRV_Channels` | Must be set to `Motor1`..`Motor12` (or another function) for that output index to have `SRV_Channels::channel_function(i) >= SRV_Channel::k_none`, which is the precondition `AP_DroneCAN::SRV_push_servos()` checks before that channel's bit in `CAN_D1_UC_ESC_BM` can do anything (`AP_DroneCAN.cpp:923-967`, walked in full in §4). |

There is **no `CAN_Dx_UC_ESC_BM` vs. successor-name ambiguity in this checkout** — the question's premise
("`CAN_Dx_UC_ESC_BM` or successor `CAN_Dx_UC_ESC_OF`") turned out to be two different, co-existing parameters
(bitmask + packing offset), not a renamed/superseded pair. Both are present simultaneously at param indices 3 and 7
respectively in `AP_DroneCAN::var_info[]`.

**Second source, the wiki** (`https://ardupilot.org/copter/docs/common-uavcan-setup-advanced.html`, fetched
2026-07-17): confirms the same parameter identities and adds the `SERVOx_FUNCTION` interaction in the GCS's own
words: *"When using DroneCAN ESCs/Servos, you can set the `SERVOx_FUNCTION` for those, but still use those outputs
on the autopilot for GPIOs using the `SERVO_GPIO_MASK` parameter. The autopilot outputs will become GPIOs and the
corresponding `SERVOx_FUNCTION` will be sent out DroneCAN."* — i.e. the FC's own physical pin is decoupled from the
CAN transmission; `SERVOx_FUNCTION` + `CAN_Dx_UC_ESC_BM` bit together determine what goes out over CAN, independent
of whether the underlying physical pin is even wired up.

**A second ESC protocol path exists and matters for scoping**: `AP_DroneCAN.cpp:869-923` shows a parallel
`SRV_send_esc_hobbywing()` path (Hobbywing's own `com.hobbywing.esc.RawCommand`, DSDL type, not the standard
`uavcan.equipment.esc.RawCommand`), gated by `AP_DRONECAN_HOBBYWING_ESC_SUPPORT` and an `OPTION` bitmask bit
(`7:HobbyWingESC`, `AP_DroneCAN.cpp:128-133`). This confirms DroneCAN ESC support in ArduPilot is not one universal
message type — vendor-specific DSDL variants exist and are selected by a separate option flag. Worth confirming
which DSDL type the in-house ESC firmware actually implements before assuming standard
`uavcan.equipment.esc.RawCommand`.

---

## 2. Node discovery + node parameter read/write from the GCS side

### The mechanism, verified in both directions (FC side and Mission Planner side)

**FC side — the relay is generic MAVLink message routing, transport-agnostic by construction.** In
`libraries/GCS_MAVLink/GCS_Common.cpp`, `CAN_FRAME`/`CANFD_FRAME` (`:4458-4461`) and `CAN_FILTER_MODIFY`
(`:4465-4467`) are handled in the ordinary incoming-message `switch (msg.msgid)` alongside every other MAVLink
message type, and `MAV_CMD_CAN_FORWARD` (`:5429-5430`) is handled in the ordinary command dispatch. Nothing in this
switch checks or cares which `GCS_MAVLINK` channel/backend the message arrived on — serial, USB, UDP, whatever
implements the channel. The handlers:

- `GCS_MAVLINK::handle_can_forward()` (`GCS_Common.cpp:4080-4083`) → `AP::can().handle_can_forward(chan, packet, msg)`.
- `AP_CANManager::handle_can_forward()` (`libraries/AP_CANManager/AP_CANManager.cpp:439-479`): `param1` selects the
  CAN bus (1-based, `-1` in `param1` == "stop forwarding" sentinel). Registers a frame callback on that bus via
  `hal.can[bus]->register_frame_callback(...)`, records the requesting `chan`/`sysid`/`compid`, and stamps
  `last_callback_enable_ms`. **The client (GCS) is expected to re-send `MAV_CMD_CAN_FORWARD` periodically — the
  callback self-disables 5 seconds after the last request** (`AP_CANManager.cpp:672-682`, checked every 100 frames
  in `can_frame_callback()`). This is exactly why Mission Planner's `StartMavlinkCAN()` loop re-issues the command
  once a second (see below).
- Outbound direction: `AP_CANManager::can_frame_callback()` (`AP_CANManager.cpp:665-712`) receives every CAN frame
  off the registered bus and re-emits it to the GCS as `CAN_FRAME` or `CANFD_FRAME` (`mavlink_msg_can_frame_send`/
  `mavlink_msg_canfd_frame_send`), gated by an optional filter-ID allowlist (`CAN_FILTER_MODIFY`,
  `AP_CANManager.cpp:575-660`, add/remove/replace semantics on a sorted `uint16_t` ID list) and by
  `HAVE_PAYLOAD_SPACE` (i.e. it silently drops frames if the outbound MAVLink channel has no buffer space — a
  real-world constraint on a slow serial link, see §3 for sizing).
- Inbound direction: `AP_CANManager::handle_can_frame()` (`AP_CANManager.cpp:486-543`) decodes an incoming
  `CAN_FRAME`/`CANFD_FRAME` from the GCS, buffers it (`frame_buffer`, sized 20 frames — comment: *"20 is good for
  firmware upload"*, `:494`, an explicit acknowledgment that this path is designed with CAN firmware transfer in
  mind), and `process_frame_buffer()` (`:549-573`) drains it onto the real CAN bus via `hal.can[bus]->send(...)`.

**Mission Planner side — confirmed against `ExtLibs`/`GCSViews` source at commit `a2fcd74d`
(`github.com/ArduPilot/MissionPlanner`, `master`, fetched 2026-07-17), not inferred from docs.** In
`GCSViews/ConfigurationView/ConfigDroneCAN.cs`:

- `ConnectionTypes` enum (`:68-75`): `SLCAN, MAVLinkCAN1, MAVLinkCAN2, MCastCan1, MCastCan2` — **MAVLink CAN
  forwarding is a first-class, named connection mode alongside SLCAN**, not a fallback or an inference.
- `StartMavlinkCAN(byte bus = 1)` (`:88-198`): spawns a background task that calls
  `MainV2.comPort.doCommand(..., MAVLink.MAV_CMD.CAN_FORWARD, bus, 0, 0, 0, 0, 0, 0, false)` once a second forever
  while the DroneCAN screen is open (`:99-116`) — directly matching the FC's 5-second self-disable window. It then
  wires an internal `DroneCAN.DroneCAN` protocol-stack object (MP's own C# DroneCAN implementation) to a virtual
  SLCAN-framed "port": every real CAN frame the internal stack wants to send is translated to a MAVLink
  `CAN_FRAME`/`CANFD_FRAME` and sent with `MainV2.comPort.sendPacket(...)` (`:158-178`), and every incoming
  `CAN_FRAME`/`CANFD_FRAME` from the FC is decoded and fed back into the same internal stack as an SLCAN ASCII line
  (`SubscribeToPacketType(MAVLink.MAVLINK_MSG_ID.CAN_FRAME, ...)`, `:169-197`). In other words: **Mission Planner's
  own DroneCAN protocol engine is transport-agnostic internally (it speaks SLCAN ASCII framing to itself) and this
  code is purely an adapter translating that internal framing to/from MAVLink `CAN_FRAME` messages** — a strong
  architectural precedent for a from-scratch TypeScript implementation to do the same (implement DroneCAN transfer
  semantics against an abstract frame in/frame out interface, then adapt that interface to MAVLink `CAN_FRAME` over
  Web Serial).
- Node discovery and parameter access ride on the same relay, using the ordinary DroneCAN/UAVCAN application-layer
  services — nothing MAVLink-specific about them once the frame relay exists. In `ExtLibs/DroneCAN/DroneCAN.cs`:
  discovery via `uavcan.protocol.NodeStatus` broadcasts (`:321-372`, populates `NodeList`) followed by
  `uavcan.protocol.GetNodeInfo` request/response (`:339`, `:374-380`, populates `NodeInfo`); parameter read/write via
  `uavcan.protocol.param.GetSet` (`:534-...`, `GetParameters(byte node)`) and persistence via
  `uavcan.protocol.param.ExecuteOpcode` (`SAVE`/`ERASE` opcodes, `:432-507`).

### The older SLCAN route — still present, explicitly exclusive with MAVLink

The wiki's dedicated DroneCAN GUI page (`https://ardupilot.org/copter/docs/common-uavcan-gui.html`, fetched
2026-07-17) still leads with: *"Before the autopilot can be connected, SLCAN mode must be operational. See [SLCAN
Access on F4/F7/H7 based Autopilots]..."* — i.e. the primary user-facing wiki instructions for the DroneCAN GUI are
still written around the older route, not the `MAVLinkCAN1` mode found in MP source above. The SLCAN setup pages
(`common-slcan-f7h7.html`, fetched 2026-07-17) specify: set `CAN_SLCAN_CPORT` (=1 or 2, selects which physical CAN
bus is routed to SLCAN — parameter confirmed locally at `libraries/AP_CANManager/AP_SLCANIface.cpp:38-44`, `@Param:
CPORT`, `"CAN Interface ID to be routed to SLCAN, 0 means no routing"`), then set the highest-numbered
`SERIALx_PROTOCOL = 22` and reboot — this **repurposes an entire UART/USB-CDC endpoint as a dedicated SLCAN byte
stream**, not a MAVLink message. The wiki explicitly flags the interaction with normal telemetry: *"SLCAN access
via COM port is disabled when armed to lower CPU load. Use SLCAN via MAVLink instead"* (a nod to the newer route)
and *"in firmware 4.5 and later, most autopilots that present two COM ports will both be for normal MAVLink
connections."* Mission Planner's own UI copy is unambiguous about the tradeoff:
`GCSViews/ConfigurationView/ConfigDroneCAN.Designer.cs`: *"After enabling SLCAN, you will no longer be able to
connect via MAVLINK. You must..."* (`label1.Text`, found via `gh search code` against
`ArduPilot/MissionPlanner`, fetched 2026-07-17) — SLCAN-over-serial and MAVLink telemetry are mutually exclusive on
that port; also confirmed by `startslcan()` in `ConfigDroneCAN.cs:204-230`, which reads/writes `CAN_SLCAN_CPORT`
*over an existing MAVLink connection first*, forces a reboot, and only afterward expects the user to reconnect to
the (now SLCAN-only) port directly — a mode switch, not a tunnel.

**Also present but distinct**: `ExtLibs/UAVCANFlasher/Program.cs` (found via `gh search code`) reads/writes
`CAN_SLCAN_TIMOUT`/`CAN_SLCAN_SERNUM` — this is a separate, older standalone flashing tool in the MP codebase, an
additional confirmation that the SLCAN route is legacy-but-still-shipped, layered under the newer `MAVLinkCAN1`
path rather than replaced by it.

### Answer to the viability question

**Yes, the MAVLink CAN-forward route (`MAV_CMD_CAN_FORWARD` + `CAN_FRAME`/`CANFD_FRAME` + `CAN_FILTER_MODIFY`) is
viable over a plain serial MAVLink link** — it is not a theoretical reading of the MAVLink spec, it is the exact
mechanism Mission Planner's current DroneCAN screen already uses by default (`but_slcanmavlink_Click` →
`StartMavlinkCAN(1)`), requiring nothing beyond what a Web Serial GCS already has: one open MAVLink channel. The
only meaningfully different constraint versus Mission Planner's own environment is throughput/latency, addressed
quantitatively in §3.

---

## 3. DroneCAN ESC firmware update over CAN via the FC

### The FC is not a file server; the GCS is

Grepped the full vendored tree for `BeginFirmwareUpdate` and `uavcan.protocol.file`: **`AP_DroneCAN` (the flight
controller's own DroneCAN driver) implements neither the client nor server side of `uavcan.protocol.file.*`.**
Those calls only appear in `Tools/AP_Periph/can.cpp` and `Tools/AP_Bootloader/can.cpp` — i.e. in the code that runs
*on a DroneCAN peripheral being updated* (client role: receives `BeginFirmwareUpdateRequest`, then issues
`file.Read` requests against whichever `source_node_id` was named in that request —
`Tools/AP_Bootloader/can.cpp:394-403`, `Tools/AP_Periph/can.cpp` equivalent). **The flight controller's own DroneCAN
stack has no code path for acting as the file server.** That role is filled entirely by the GCS.

Confirmed directly in Mission Planner source (`ExtLibs/DroneCAN/DroneCAN.cs`, commit `a2fcd74d`):
`SetupFileServer()` (`:610-660`) installs a handler that answers incoming `uavcan.protocol.file.Read_req` messages
addressed to MP's own node ID (`SourceNode`) by reading chunks out of the local firmware file and replying with
`uavcan_protocol_file_Read_res`. `Update(byte nodeid, ...)` (`:1096-...`) sends
`uavcan_protocol_file_BeginFirmwareUpdate_req` with `source_node_id = SourceNode` (`:1158`) — i.e. **Mission Planner
tells the ESC "fetch your firmware from me"**, then answers the resulting stream of `Read` requests itself. Every
one of those DroneCAN service calls — the `BeginFirmwareUpdate_req`, every `Read_req`/`Read_res` pair — is just
another DroneCAN transfer, and when MP is in `MAVLinkCAN1` mode (§2) every one of those transfers is carried as
ordinary `CAN_FRAME`/`CANFD_FRAME` MAVLink messages over the same serial link. **Firmware update is not a
structurally different mechanism from node discovery/param access — it's the same relay, carrying a different
DroneCAN service.**

### Bandwidth/feasibility sizing (source: DroneCAN DSDL, not MAVLink)

`uavcan.protocol.file.Read` (`.../dronecan/dsdl_specs/uavcan/protocol/file/48.Read.uavcan`, local pip-installed
`dronecan` package DSDL specs, read directly): request carries a 40-bit offset + path; **response payload is
`uint8[<=256] data`** — i.e. up to 256 bytes of firmware per `Read` round trip, and the client must issue
successive `Read` calls at increasing offsets until a short (or empty) response signals EOF (comment in the DSDL
file itself: *"if the client needs to fetch the entire file, it should repeatedly call this service while
increasing the offset, until incomplete data is returned"*). `uavcan.protocol.file.BeginFirmwareUpdate`
(`40.BeginFirmwareUpdate.uavcan`) confirms the "slave fetches from source_node_id" semantics quoted above directly
from the spec text.

A 256-byte DroneCAN transfer is not a single CAN frame — classic CAN 2.0B has an 8-byte payload per frame (DroneCAN
reserves the last byte for a tail-byte transfer-framing field, so ~7 usable bytes/frame), meaning a single 256-byte
`Read` response is itself split into on the order of ~37 CAN frames by the DroneCAN transport layer, each of which
crosses the GCS↔FC link as its own individual `CAN_FRAME` MAVLink message (16-byte payload, ~26-30 bytes on the
wire with MAVLink2 framing/checksum). **For a rough order-of-magnitude figure**: a 1 MB ESC firmware image at 256
bytes/chunk is ~4,100 `Read` round trips; at ~37 CAN frames per 256-byte response (classic CAN) that is on the
order of 150,000 individual `CAN_FRAME` messages end to end (request frames excluded), each subject to the FC's own
`frame_buffer` depth of 20 (`AP_CANManager.cpp:494`, explicitly sized "for firmware upload" but still a small
buffer) and to `HAVE_PAYLOAD_SPACE` backpressure on the outbound leg. **This is a real cost, not a hard blocker** —
Mission Planner does this today over the same relay — but it is meaningfully slower than updating the FC's own
firmware (single large file transfer, no per-256-byte round trip), and CAN-FD support (if the in-house ESCs and FC
both support it — see `OPTION` bit `2:EnableCanfd` in `AP_DroneCAN.cpp:128-133`) would substantially reduce the
per-chunk frame count since CAN-FD payloads are up to 64 bytes rather than 8.

**Could not verify from source**: an actual measured firmware-update duration over a serial MAVLink link at any
specific baud rate — this would need a bench test with a real DroneCAN ESC, not something derivable from source
alone. Flagged as an open question.

---

## 4. Motor test over DroneCAN

**Confirmed transparent by tracing the full call chain in source — not inferred from behavior.**

1. `ArduCopter/GCS_Mavlink.cpp:785-786`: `MAV_CMD_DO_MOTOR_TEST` → `handle_MAV_CMD_DO_MOTOR_TEST(packet)`
   (`GCS_Mavlink.cpp:997`).
2. `ArduCopter/motor_test.cpp:141-...`: `Copter::mavlink_motor_test_start(...)` — runs
   `mavlink_motor_control_check()` first (`motor_test.cpp:96-134`), which gates on: board initialised, arming/RC
   checks, landed, **`hal.util->safety_switch_state() != SAFETY_DISARMED`** (i.e. the hardware safety switch must be
   off — the exact same gate `AP_DroneCAN::SRV_push_servos()` independently checks before arming its own ESC output
   mask, see step 5), and E-stop not active.
3. Per-loop output: `Copter::motor_test_output()` (`motor_test.cpp:19-...`) computes a PWM value and calls
   `motors->output_test_seq(motor_test_seq, pwm)` (`:87`).
4. `AP_Motors::output_test_seq()` (`libraries/AP_Motors/AP_Motors_Class.cpp:299-302`) dispatches to the frame-class
   virtual `_output_test_seq()`; for a multirotor, `AP_MotorsMatrix::_output_test_seq()`
   (`libraries/AP_Motors/AP_MotorsMatrix.cpp:465-474`) calls `rc_write(i, pwm)` for the matching motor.
5. **`AP_Motors::rc_write()` (`AP_Motors_Class.cpp:105-113`) writes into the generic `SRV_Channels` output array**
   (`SRV_Channels::set_output_pwm(function, pwm)` or `set_output_scaled(...)`) — this is the exact same call motor
   test uses as normal flight-control mixer output; there is no separate "test mode" output path. `AP_DroneCAN`
   never sees a distinction between "real" motor output and motor-test output — both arrive as ordinary
   `SRV_Channel` state.
6. `AP_DroneCAN::SRV_push_servos()` (`libraries/AP_DroneCAN/AP_DroneCAN.cpp:923-967`) runs every DroneCAN loop
   iteration, independent of what wrote to `SRV_Channels`: for each of `DRONECAN_SRV_NUMBER` channels with an
   assigned function (`SRV_Channels::channel_function(i) >= SRV_Channel::k_none`), reads
   `SRV_Channels::srv_channel(i)->get_output_pwm()` (`:928`), and computes `esc_armed_mask = _esc_bm &
   non_zero_channels` (`:944`) gated again by `hal.util->safety_switch_state()` (`:945-953`) before calling
   `SRV_send_esc()` (`:824-866`), which packs the values into `uavcan_equipment_esc_RawCommand` and broadcasts it.

**Conclusion**: `MAV_CMD_DO_MOTOR_TEST` output is fully DroneCAN-transparent for any channel whose `SERVOx_FUNCTION`
is a motor function and whose bit is set in `CAN_Dx_UC_ESC_BM` — confirmed by call-chain tracing through five
files, not by documentation claim. The community sentiment already gathered in this repo's own
`docs/notes/mico-research-2026-07.md` (Allister Schreiber, ArduPilot Discourse, 2026-03-17: *"impressed... by the
motor test and auto-mapping"*) is about PWM ESCs specifically, and does not itself confirm DroneCAN transparency —
this section supersedes that as the actual verified answer for DroneCAN.

---

## 5. Dialect coverage: `mavlink-mappings@1.0.20-20240131-0`

Checked directly against the installed package at
`node_modules/mavlink-mappings/dist/lib/{common,ardupilotmega}.js`, matching this repo's pinned version
(`docs/notes/decisions-m1.md`, Decision 1).

| Symbol | Defined in | MSG_ID / value | In `REGISTRY`/`COMMANDS`? |
|---|---|---|---|
| `CanFrame` (`CAN_FRAME`) | `common.js:13061` | 386 | Yes — `common.js:21245`, `386: CanFrame` |
| `CanfdFrame` (`CANFD_FRAME`) | `common.js:13160` | 387 | Yes — `common.js:21249`, `387: CanfdFrame` |
| `CanFilterModify` (`CAN_FILTER_MODIFY`) | `common.js:13190` | 388 | Yes — `common.js:21250`, `388: CanFilterModify` |
| `MavCmd.CAN_FORWARD` | `common.js:3387` | 32000 | Yes — `CanForwardCommand` class at `common.js:21037-21054`, registered in `common.js:21264...21424` (`COMMANDS[MavCmd.CAN_FORWARD] = CanForwardCommand`) |

All four are defined **in `common.js`, not `ardupilotmega.js`** (grepped `ardupilotmega.js` for `386`/`387`/`388`/
`CAN_FORWARD`/`CanFrame` — no hits) — consistent with these being `common.xml`-native MAVLink messages/commands, not
ArduPilot-specific extensions. Per Decision 1's documented REGISTRY-merge rule (`{ ...minimal.REGISTRY,
...common.REGISTRY, ...ardupilotmega.REGISTRY }`, each dialect's `REGISTRY` only containing messages *it itself*
defines), this repo's `defs.ts` adapter (`src/core/mavlink/defs.ts`) will pick these four up correctly from
`common.REGISTRY`/`common.COMMANDS` as long as the existing merge is followed — no special-casing needed, and no
gap exists at the pinned version. `CanFrame.MAGIC_NUMBER` (CRC_EXTRA) is `132`, `CanfdFrame.MAGIC_NUMBER` is `4`,
`CanFilterModify.MAGIC_NUMBER` is `8` — all present as static fields, matching the pattern this repo's `defs.ts`
already relies on for every other message (per Decision 1).

---

## Concerns / open questions

1. **Which DSDL ESC message does the in-house ESC firmware actually speak?** Standard
   `uavcan.equipment.esc.RawCommand`, or a vendor-specific variant like ArduPilot's own Hobbywing special-case
   (`AP_DroneCAN.cpp:869-923`, gated by an `OPTION` bit, not the default path)? This determines whether "DroneCAN
   ESC support" in the configurator can assume the standard message or needs firmware-specific handling — same kind
   of check issue #48 itself flags for the parameter set ("Needs the same firmware-source-verified treatment as
   paramEnums' existing fields").
2. **No measured bandwidth/duration numbers for a real DroneCAN firmware update over a serial MAVLink link.** §3's
   ~150,000-frame estimate for a 1 MB image is derived from DSDL chunk size and classic-CAN frame-fragmentation math,
   not a bench measurement. A real test (with a real or simulated DroneCAN ESC) would materially firm up whether
   this is "slow but fine" or "impractically slow" at whatever baud rate the in-house boards' serial link runs.
   CAN-FD availability (both FC and ESC side) would change this by roughly 8x per-chunk frame count.
3. **The wiki's primary DroneCAN GUI instructions (`common-uavcan-gui.html`) are stale relative to Mission Planner's
   actual current source** — they describe the SLCAN-over-dedicated-port route as the setup precondition and do not
   mention the `MAVLinkCAN1`/`CanForward` mode found directly in `ConfigDroneCAN.cs`. Anyone reading only the wiki
   (as opposed to MP source, as this note did) would reasonably conclude the CAN-forward-over-serial route doesn't
   exist or isn't the primary path. Worth flagging to whoever runs the eventual grill so nobody re-derives the SLCAN
   route as "the" way DroneCAN GUI works.
4. **`CAN_FILTER_MODIFY` semantics were read but not exercised.** The add/remove/replace list semantics
   (`AP_CANManager.cpp:575-660`) look straightforward, but no test of what happens with zero filters vs. an empty
   `CAN_FILTER_REPLACE` was done — `handle_can_filter_modify()`'s comment suggests an unfiltered forward session
   (no filter ever sent) simply relays everything, which matches Mission Planner's `StartMavlinkCAN()` (no
   `CAN_FILTER_MODIFY` call visible in the excerpt read) — worth confirming by testing, not just reading, before
   relying on "send nothing, get everything" as a design assumption.
5. **No local test of the actual round-trip latency behavior on a slow/lossy Web Serial link** — `HAVE_PAYLOAD_SPACE`
   silently drops outbound `CAN_FRAME`s when the MAVLink channel's TX buffer is full (`AP_CANManager.cpp:685-712`);
   how that interacts with a synchronous request/response DroneCAN service call (e.g. a dropped `Read_res` frame)
   and whatever retry/timeout behavior the calling code implements is unverified from source alone — this is a
   "build it and see" question, not a documentation question.
6. **Firmware-server node ID collision risk unexamined.** Mission Planner uses its own `SourceNode` as the DroneCAN
   node ID it presents when acting as file server (`DroneCAN.cs:1158`) — whatever a from-scratch implementation
   picks for its own node ID needs to avoid colliding with `CAN_Dx_UC_NODE` (the FC's own node ID) or any live ESC
   node ID on the bus; not investigated here (would need to check `AP_DroneCAN`'s DNA/dynamic-node-allocation
   conflict handling, referenced only in passing via the `OPTION` bits `0:ClearDNADatabase,1:IgnoreDNANodeConflicts`
   at `AP_DroneCAN.cpp:128-133`).

---

## Addendum 2026-07-18: the in-house ESC's DSDL surface (open question 1 — answered)

The in-house ESC firmware repo (`novaX-ALUX/f280049c_foc`, `src/comms/dronecan_ids.h`, read 2026-07-18) settles
what the ESC node speaks: a **fully standard DroneCAN v0 surface** — `uavcan.equipment.esc.RawCommand` (DTID 1030)
and `esc.Status` (1034), `NodeStatus` (341), `dynamic_node_id.Allocation` (1), plus services
`GetNodeInfo` (1), `param.GetSet` (11), and `file.BeginFirmwareUpdate` (40) with a `file.Read` (48) *client*
(260-byte response reassembly, `MODE_SOFTWARE_UPDATE`). The stack is hand-rolled (no libcanard — C28x
`CHAR_BIT==16` breaks its DSDL packing), golden-frame-validated against pydronecan, and shares its wire contract
with the legacy `esc_drv8300` firmware.

Consequences for this note: §4's motor-test transparency and §2's discovery/param findings apply to the in-house
ESCs without a custom-DSDL contingency, and §3's GCS-as-file-server firmware-update mechanism has both ends
already implemented. The remaining open questions above are the operational ones (update timing, backpressure,
filter edges, file-server node-ID collision).
