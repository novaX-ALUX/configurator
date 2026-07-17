# Bench/flight is the product boundary: configurator now, GCS as a committed later milestone

novaX Configurator needed a settled answer to "pure configurator, or future GCS
replacing axPlanner?" before new interfaces weld in assumptions that are hard
to reverse. Evidence weighed: MicoConfigurator markets itself purely as a
setup tool (its SEO keywords name only sensor calibration / PID tuning / motor
setup) while quietly shipping a real Mission/RTK layer — the market leader
sequences its *marketing*, not its architecture. axPlanner (the in-house
Flutter GCS) is half-finished, has no users, and carries documented safety
bugs (`FS_THR_ENABLE` enum mismatch writes 2 = Continue-in-Auto when the user
selects RTL).

**Decision:** the product boundary is **bench vs flight**, not a feature list.
The test for any feature: *does it operate an aircraft in a flyable state?*
Bench-side (props off, vehicle on the desk) is configurator scope — including
operations that send commands, gated per-operation. Flight-side (arm, mode
change, mission execution, field telemetry) is the scope of a **committed but
deferred GCS milestone**. This is sequencing of engineering investment, with
binding boundary rules effective now; violations are grounds to reject a
change in review.

## Rules in force from this ADR

1. **Command taxonomy.** The core layer exposes only named, typed operations
   (`startMotorTest`, `acceptMagCal`, …), each declaring its own safety
   pattern (gate, confirmation, stop path). No generic "send any
   COMMAND_LONG" channel is ever exposed to feature code. The flight-command
   class (arm/disarm/mode/takeoff/RTL) **does not exist as a type** — it is
   created only by a dedicated safety ADR when the GCS milestone starts.
   Corollary: an interactive console with command input (a Mico feature) is
   blocked by this ADR, not a gap to close.
2. **Platform escape hatch, cheapest form.** The configurator milestone runs
   in the browser. Because a field GCS hits hard browser ceilings (no raw
   UDP/TCP for WiFi telemetry, no Web Serial on Android, offline launch needs
   the PWA that M1 cut), a Tauri/Electron move must stay possible:
   - transport stays behind the Session interface — no new code may assume
     "link == Web Serial";
   - core layers must not depend on browser-only distribution (same-origin
     hosting, URL-based delivery); page-level uses (firmware mirror) are fine;
   - no PWA/offline-map investment now — that bets on browser-native GCS
     before the platform is chosen.
   **Trigger:** the first ticket of the GCS milestone is a platform spike
   (browser+PWA vs Tauri) decided against real field requirements.
3. **One Session = one vehicle** (now in `CONTEXT.md`). Target sysid/compid
   is resolved once, inside the Session's link layer; feature code never
   contains a sysid literal (axPlanner's MAVFTP hardcoding 1/1 across the
   feature layer is the anti-pattern). Multi-vehicle is excluded from the
   committed endgame; if it ever arrives, its shape is N Sessions, not
   sysid parameters on every interface.
4. **ESC 4-Way passthrough is bench-side and in scope** — strategic for the
   in-house ESC line, scheduled as its own project outside the roadmap order
   of `feature-status-vs-axplanner.md` §V. Prerequisites: the §IV lessons
   (never truncate `SERIAL_CONTROL` msgid 126; route flash addresses through
   one encode function with ADDRESS_SHIFT).
5. **axPlanner is archived.** It has no users, so no safety-fix pass is
   owed. Zero further investment; its only role is a read-only reference
   (lessons already extracted into `feature-status-vs-axplanner.md` §IV);
   its GCS responsibilities pass to this product's GCS milestone.

## Considered Options

- **Pure configurator, GCS never** — rejected: novaX is a hardware company;
  the customer loop is setup → tune → fly → analyze, and the back half needs
  a GCS. axPlanner's existence proves the org already believes this.
- **Parallel investment (configurator + GCS now)** — rejected: no users yet,
  one team; parallel fronts ship neither well. Mico shows the configurator
  posture alone wins community credit.
- **"Configurator, maybe GCS someday" (non-committal)** — rejected: it makes
  every boundary rule contestable as dead flexibility. Committing the endgame
  is what legitimizes the (cheap) seams kept open.
- **Decide the desktop platform now** — rejected as premature: no field
  users to learn from; the hatch rules keep the decision reversible at the
  moment it becomes real.

## Consequences

- "Pure configurator" leaves the vocabulary: this is a **bench tool** (motor
  test was never "pure"), and the bench/flight test replaces feature-list
  debates for every future boundary call.
- The gap docs are re-labeled accordingly: flight action panel, mission
  planning, and RTK move behind the GCS milestone; console command input is
  marked blocked; ESC 4-Way becomes its own project.
- Review gains three concrete rejection grounds: a generic command channel, a
  sysid literal in feature code, a core-layer browser-distribution
  assumption.
- The GCS milestone inherits a clean start: a platform spike first, a safety
  ADR for flight commands second.
