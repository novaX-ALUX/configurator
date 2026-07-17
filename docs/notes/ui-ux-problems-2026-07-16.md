# UI/UX Named-Problem List — 2026-07-16 side-by-side audit

Source evidence: `.scratch/ui-audit/` (ours, 10 shots, dev v0.5.0) vs `.scratch/ui-audit/mico/`
(MicoConfigurator v0.9.33, 16 shots) — **same AF-H7_nano board connected to both, same day,
English UI**. Screenshots are untracked scratch material; this document is the durable record.
Grill session decisions are marked ✅ (settled 2026-07-16).

Priorities: **P1** = first UI ticket batch · **P2** = rides along with a scheduled feature
ticket or the density pass · **P3** = recorded, not scheduled.

## Fact correction that reframed this audit

**Mico is not a "dark cockpit."** In first-hand screenshots its everyday shell is light,
card-based, with a left icon rail — the same basic identity as ours. Only the PFD widget is
dark, and dark mode is one option of its `theme: system` support. The real deltas are
**information density** and **always-present global state**, not color mood. (The earlier
"dark-PFD cockpit" impression came from the PWA manifest's `#0A0A0F` theme color.)

## Global

| ID | P | Problem | Evidence |
|----|---|---------|----------|
| G1 | P1 | Sidebar is icon-only, no text labels — new users hover-guess every page. Mico: icon + label. | ours any page vs `mico/01` |
| G2 | P1 | ✅ No global telemetry status strip. Off the Dashboard, arm state / PreArm failures / voltage are invisible — a safety-first tool that hides safety state on the pages where you write params or calibrate. **Decision: add a connected-state top strip with exactly six bench-relevant items: arm state, flight mode, PreArm chip (Ready / Not Ready + failure count, click → PreArm messages), battery voltage (+current), GPS fix, link health. Explicitly excluded: alt/heading/climb (flight-side, ADR-0002), bottom CPU/temp bar.** Mico's "Not Ready ⑤" chip is the model. | `mico/10` top strip vs ours |
| G3 | P2 | Vertical whitespace: at 1258 px every page's content sits in the top half; bottom half is blank. Handle per-page in the density pass; Charts case is CH4. | all our shots |
| G4 | P2 | ✅ No dark mode. **Decision: tokenize colors into CSS variables now (while G2/G5 touch global styles) to stop the compounding refactor cost; ship the actual dark theme (follow `prefers-color-scheme`, no manual toggle) only after roadmap items §III 1–4.** No community evidence dark mode is a complaint driver — it does not outrank real gaps. | `mico/*` (light!), manifest |
| G5 | P1 | ✅ Empty states hide the product. Full-page "connect first" placeholders mean a first-run user never sees what the tool can do. **Decision — layered policy: read-only telemetry pages (Dashboard, Charts) render their full layout with "Offline" markers when disconnected — Charts shows the frozen History Buffer (already the domain promise); write-capable pages (Setup, Calibration, Motors, Params) keep full-page placeholders (their safety model presumes a connection); Firmware keeps its current state (DFU rescue works disconnected).** | `mico/01` (offline chips) |

## Dashboard (`04-dashboard.jpg` vs `mico/01`, `mico/10`)

| ID | P | Problem |
|----|---|---------|
| D1 | P1 | Power card renders "0.02 V" **and** an "80% remaining" green bar side by side as if both were healthy — on USB bench power the two are contradictory, yet both render as normal. Honesty-rule hole: cross-check plausibility; when voltage is below a credible flight-battery floor, degrade the display and hint "USB power?". |
| D2 | P2 | No sensors-health grid. Mico's six tiles (IMU / Compass / Baro / GPS / OptFlow / Rangefinder; red = needs calibration, green = OK, gray = absent) answer "what does this vehicle still need?" at a glance and double as navigation. Our calibration state hides inside PreArm text. |
| D3 | P3 | GPS card is mostly interior whitespace; loose layout. |

## Charts (`05-charts.jpg` vs `mico/02`, `mico/16`) — ✅ settled: adopt 4, defend 2

Adopt (CH1–CH4):

| ID | P | Problem |
|----|---|---------|
| CH1 | P2 | Series picker is a flat wall of 43 chips (RC CH1–18 and OUT1–16 as full rows) — already at its usability ceiling and every future Series class makes it worse. Redo as Mico-style grouped tree with checkboxes and **live value next to each selected Series**. |
| CH2 | P2 | Fixed 60 s window is too coarse for oscillation inspection. Add 5/10/30/60 s window selection (History Buffer's "retains the most recent chart window" definition already accommodates it). |
| CH3 | P2 | No CSV export. Exporting real Samples has zero conflict with the honesty rule; ~day-scale cost. |
| CH4 | P2 | Charts don't fill the viewport: three ~250 px subplots over a half-blank page (G3's worst case). Fill available height. |

Deliberate non-goals (record so nobody "closes" them as gaps):

- **No chart-side resampling** (Mico's 20/50/100 Hz). Domain rule: Samples are never fabricated (ADR-0001). Mico itself needs an in-UI disclaimer ("Chart sample rate only, not data source rate") — we don't build things that need disclaimers.
- **No manual add/remove panels / single shared-axis plot.** Mico draws deg and volts on one axis; Unit Group subplots are our *correction* of that defect, not a missing feature. Layout control needs are served by CH1 + CH2.

## Parameters (`02a`, `02b` vs `mico/14`, `mico/15`)

| ID | P | Problem |
|----|---|---------|
| PA1 | P1 | Pull-in-progress state is misleading: shows "1 of 1 shown" while 1,276 params are still inbound — no progress indication. Show "X / 1277 pulled" with a progress bar. Small standalone fix; do not wait for the metadata ticket. |
| PA2 | P2 | Pagination ("Page 1 of 13") breaks scanning vs Mico's collapsible groups + scroll. **Fold into the param-metadata ticket** (roadmap §III #1) — the page changes shape once metadata (names, descriptions, enum dropdowns, default markers, Not-Default filter) lands; don't restyle twice. |

(No metadata / no `.param` I/O are roadmap items, not re-listed here.)

## Calibration (`07` vs `mico/13`)

| ID | P | Problem |
|----|---|---------|
| C1 | P2 | No live sensor readout before calibrating. Mico shows accel/gyro waveforms, live values, and the sensor model chip (ICM42688) — the user confirms "sensor alive, noise sane" before touching anything. Our telemetry layer makes this cheap. |
| C2 | P3 | `AHRS_ORIENTATION 0` renders the raw number; show the enum label ("None"). |

## Firmware (`01`)

| ID | P | Problem |
|----|---|---------|
| F1 | P1 | With no firmware selected the action button renders "Update — to —" (bare em-dash placeholders) — looks broken. Proper disabled-state copy: "Select firmware to update". |

## Clean pages

**Motor Test (`08`) and Setup Guide drawer (`09`)** — no named problems; current high-water mark.
Setup (`06`) gaps (4 frame tiles vs Mico's class×type matrix) are feature gaps tracked in
`feature-status.md`, not UI problems.

## First ticket batch (P1)

G1 sidebar labels · G2 status strip · G5 empty-state layering · D1 power plausibility ·
PA1 pull progress · F1 firmware button copy. Candidates for `/prototype` where seeing is
required: G2 (strip layout), G5 (Dashboard offline state), CH1 (picker).
