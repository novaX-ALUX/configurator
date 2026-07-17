# novaX Configurator

Browser-based setup tool for ArduPilot flight controllers: configure, calibrate, test, and flash over Web Serial / WebUSB. One bounded context.

## Language

### Connection

**Session**:
The bundle of live per-connection objects, created fresh on every connect and destroyed on disconnect. Nothing inside a Session survives a disconnect. **One Session = one vehicle** — target sysid/compid is resolved once, inside the Session's link layer; feature code never contains a sysid literal (ADR-0002).
_Avoid_: connection object, link context

### Product Boundary (ADR-0002)

**Bench-side**:
Any operation on a vehicle that is not in a flyable state (props off, on the desk). The configurator's entire scope. Commands are allowed bench-side, but only as Named Operations.
_Avoid_: "pure configurator" (deprecated — motor test was never "pure")

**Flight-side**:
Any operation on an aircraft in a flyable state (arm/disarm, mode change, mission execution, field telemetry). Scope of the committed-but-deferred GCS milestone; the flight-command type does not exist in the core layer until that milestone's safety ADR creates it.

**Named Operation**:
A typed core-layer operation (e.g. `startMotorTest`, `acceptMagCal`) that declares its own safety pattern — gate, confirmation, stop path. The only way commands reach the vehicle; no generic command channel exists.
_Avoid_: sendCommand, raw command, passthrough command

### Navigation

**Home**:
The landing page and journey splitter: first-run users find the Setup Guide, returning users find Connect, rescue users find the path to Firmware. Not part of any Nav Group.
_Avoid_: welcome page, start page, getting started

**Nav Group**:
One of three fixed sections of the navigation — **Configure**, **Monitor**, **Maintain** — divided by page nature, matching the layered connection policy (Monitor pages work offline, Configure pages need a connected board, Maintain contains the offline-capable rescue tools).

**Configure (group)**:
The curated write-path pages (Setup, Calibration, Motors, Tuning), ordered by the guide journey.
_Avoid_: Setup group (collides with the Setup page), setup-path

**Monitor (group)**:
The read-only pages (Dashboard, Charts). Fully usable offline.

**Maintain (group)**:
The low-frequency rescue and debug surfaces (Full Parameters, Firmware, Console), ordered by frequency of use.
_Avoid_: Advanced (describes a user rank, not the group's purpose)

**Escape Hatch**:
The full raw parameter table, positioned as the fallback to the curated Configure pages — same data, lower altitude. Its nav label must say so ("Full Parameters"), not pose as a sibling.
_Avoid_: Parameters (as a bare nav label)

### Parameters

**Review Gate**:
The rule that no parameter value ever reaches the vehicle as a side effect of input. Edits accumulate as **Staged Changes**; only an explicit user Apply writes them, and every write is read back. There is no direct-write path, including sliders. Applies to flight-controller parameters and Node Parameters alike; for a Node Parameter, Apply also includes persistence on the Node.
_Avoid_: live-bind, direct write, real-time write

**Staged Change**:
One pending parameter edit (scope + name + new value) awaiting Apply — the scope is the flight controller or one Node. Later edits to the same scope and name replace the earlier Staged Change.
_Avoid_: dirty value, pending write

### DroneCAN

**Node**:
A device on the vehicle's CAN bus with its own DroneCAN node ID, discovered and configured through the flight controller. In-house ESCs are Nodes; the term deliberately does not presume ESC — future CAN peripherals are Nodes too.
_Avoid_: device, peripheral, CAN device, ESC node (as the generic term)

**Node Parameter**:
A parameter that lives on a Node. Its identity is node ID + name — two Nodes can carry the same name. Writes go through the same Review Gate as flight-controller parameters.
_Avoid_: CAN parameter, ESC setting, remote parameter

### Telemetry

**Telemetry Snapshot**:
The single, unit-converted picture of the vehicle's live state (attitude, power, GPS, RC, servo outputs, heartbeat). Every field is already in the unit a UI would display; raw wire values never appear in it.
_Avoid_: raw telemetry, message payload

**Block**:
One independently-updating section of the Telemetry Snapshot (attitude, power, GPS, RC, servo, heartbeat), each stamped with its own receive time.

### Telemetry Charts

**Series**:
One chartable numeric telemetry variable (e.g. roll, voltage, RC channel 3).
_Avoid_: variable, signal, channel (reserved for RC/servo channels)

**Sample**:
A timestamped value of one Series, recorded from a real message arrival. Samples are never fabricated by resampling or interpolation.
_Avoid_: data point, tick

**Recorder**:
The session-lifetime collector that turns Block updates into Samples in the History Buffer. It lives and dies with the Session; its output does not.

**History Buffer**:
The rolling store of recent Samples for all Series. It retains the most recent chart window, survives disconnect (frozen), and is cleared only when the next connect begins.
_Avoid_: chart data, sample cache

**Unit Group**:
The set of selected Series sharing one physical unit (degrees, volts, amps, percent, microseconds, count), rendered together on one subplot with a true-scale axis. Series in different Unit Groups are never drawn on the same axis.
_Avoid_: chart group, axis group
