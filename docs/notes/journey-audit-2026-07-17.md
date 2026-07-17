# Journey audit — is "彻底重新设计 UI/UX" warranted? (2026-07-17)

Purpose: turn the hypothesis "操作路径很乱,层级也不明确" (raised right after the
roadmap-#3 circle closed) into concrete, falsifiable findings, so the
redesign-vs-restructure call can be grilled on evidence. Companion to the
page-by-page audit `ui-ux-problems-2026-07-16.md`, which deliberately did NOT
cover cross-page journeys — this note does.

Method: (A) code-derived journey analysis — nav model, Setup Guide step
graph, page gating; (B) live-site visual walk (deployed v0.20.0, disconnected
states of all nine pages + the Setup Guide drawer, 1203×1021 viewport). Both
done; connected flows remain unwalked (see Blind spots).

The three journeys used as probes:

1. **First-run setup**: new user, fresh board → flyable-configured vehicle
2. **Tuning iteration**: fly → land+plug → adjust → unplug → fly
3. **Brick rescue**: board stuck in bootloader → reflashed

## Findings

### J1 — The nav order tells no story (this is the "层级不明确")

Nine flat entries in `NAV_PAGES` order: firmware, parameters, dashboard,
charts, setup, tuning, calibration, motors, console. Three natures are
interleaved rather than grouped:

- **Configure (write-path)**: parameters(2), setup(5), tuning(6),
  calibration(7), motors(8)
- **Monitor (read-only)**: dashboard(3), charts(4)
- **Maintain/rescue**: firmware(1), console(9)

A first-run user reading top-to-bottom meets the two most expert-facing
surfaces first — firmware flashing and the raw 1277-param table — before any
curated page. The pages the product's own guide routes through sit at
positions 5–8. No grouping, separator, or ordering communicates "start
here", "this is the escape hatch", or "this is read-only".

### J2 — The product's own journey disagrees with its nav

The Setup Guide's five steps (its own definition of the first-run journey)
are: ① connect → ② frame/ESC (Setup) → ③ calibrate (Calibration) → ④ motor
test (Motors) → ⑤ failsafes (Setup again). Mapped to nav positions that's
5 → 7 → 8 → 5 — a zig-zag with a backtrack, across a nav ordered by
accretion history rather than by journey.

Two aggravations:

- **The guide never learned about Tuning.** Roadmap #3's whole pitch was
  "can configure → can tune", but the guided journey still ends at
  failsafes; Tuning (and the initial-tune calculator — the natural next
  step after motor test) is not a guide step. The circle updated the nav
  but not the journey.
- Guide `done` flags are session-scoped (documented in `guideSteps.ts`),
  so the journey's progress resets on reload and survives a board swap —
  a known staleness gap, acceptable for a nudge, wrong for a journey spine.

### J3 — Two parameter surfaces, no altitude signposting

`parameters` (raw table + review drawer) and `setup`/`tuning` (curated
cards over the same ParamStore) are different altitudes of the same thing,
presented as unlabeled siblings — with the raw one listed *earlier* (2 vs
5/6). Nothing tells the target user "the curated pages are the normal
path; the table is the escape hatch". This is the likeliest single source
of the "操作路径乱" feeling for setup tasks.

### J4 — Connection gating is per-page policy, invisible in the nav

By the G5 layered policy (2026-07-16 audit): monitor pages render offline
layouts with Offline markers; write pages show full-page "connect first"
placeholders; Firmware works disconnected (DFU rescue). Sound policy — but
the flat nav renders all nine entries identically whether or not a vehicle
is connected, so "which of these is usable right now" is discoverable only
by clicking through. (Visual walk to confirm severity.)

### J5 — Journey 3 (brick rescue) is actually good — evidence against a full redesign

Firmware page works disconnected, has a dedicated DFU/bootloader rescue
path (v0.17.0 flash-from-bootloader), and sits first in the nav where a
panicking user looks first. In-page flows shipped recently (review gate,
calibration wizards, motor-test safety, flash session) were each
grill-designed and are individually coherent. The mess is *between* pages,
not *inside* them.

## Visual walk results (deployed v0.20.0, disconnected)

- **V1 — Landing page is Firmware (J1 confirmed, severity high).** A
  first-run user's very first screen is "Normal update / DFU rescue /
  Loading the firmware list…" — a flashing tool, not a product. The
  First-flight Setup Guide — the actual journey spine — is a small
  bottom-left sidebar entry, visually the least prominent control on the
  screen.
- **V2 — The guide drawer itself is good.** "First-flight Setup Guide,
  0/5" with per-step status lines and Open-page buttons; honest read-only
  footnote. The problem is placement (peripheral) and content (stops at
  failsafes — J2's missing tuning step confirmed on the live site).
- **V3 — Stale copy hides today's features.** The Calibration placeholder
  says "Accelerometer and compass calibration run live…" and guide step ③
  says "Accelerometer 6-face, then compass" — RC calibration (#38, shipped
  in v0.17.6/7) is invisible in both. Small fix, real journey damage: a
  user looking for RC cal has no scent trail.
- **V4 — G5 policy verified as implemented**: Dashboard/Charts/Console
  render full offline layouts with OFFLINE chips; the four write pages
  show per-page "needs a connected board" placeholders, each with a
  Connect CTA and page-specific copy (Motors' "good moment to take the
  props off" is the standard the others should match). J4's severity is
  therefore **moderate**, not high — every dead-end offers the next
  action; what's missing is only nav-level affordance.
- **V5 — Density (G3) confirmed at journey level.** At 1203×1021 every
  page except Console is a content island in a mostly blank canvas;
  Charts' collapsed chart area + blank bottom (CH4) is the worst case.
  This is polish-pass material, not redesign evidence.

## Verdict (post-walk; input for the grill)

The evidence so far supports **IA restructure, not from-scratch redesign**:

- Nav regrouped by nature (e.g. Setup-path: setup/calibration/motors/tuning
  · Monitor: dashboard/charts · Advanced/Maintain: parameters/firmware/
  console), ordered by journey within groups
- Setup Guide refreshed: add the tuning step (calculator after motor test),
  consider board-derived done flags (guideSteps.ts's own future-fix note)
- Parameters repositioned/labeled as the escape hatch
- Per-page redesigns NOT warranted — recent circles' in-page flows are
  validated; repainting them re-pays their verification cost for no journey
  gain

The visual walk did not contradict J5 — pages are individually coherent
(V4), the pain is arrival and orientation (V1) plus between-page structure
(J1–J3). Quick wins independent of the grill: V3's stale copy (calibration
placeholder + guide step ③), and promoting the guide's visual prominence.

## Blind spots

- **Connected flows unwalked**: the app's only transport is Web Serial —
  the WebSocket transport exists in core (SITL bridge) but is not wired
  into the UI, so no journey past "Connect" can be walked without hardware.
  Side finding: a dev-only SITL/demo connection mode would unblock journey
  audits, demos, and first-run marketing; transport-behind-Session (ADR-0002
  rule 2) means the seam already allows it. Candidate ticket, needs its own
  decision.
- Journeys were walked in English at one desktop viewport; zh/ko/ja and
  narrow viewports unassessed.
