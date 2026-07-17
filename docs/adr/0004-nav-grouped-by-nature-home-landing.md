# Nav grouped by nature, Home as landing page

The journey audit (`docs/notes/journey-audit-2026-07-17.md`, J1–J5/V1–V5) found the
pain is between pages, not inside them: nine flat nav entries ordered by accretion
history, Firmware as the first screen, and two parameter surfaces posing as unlabeled
siblings. We decided on an IA restructure, explicitly rejecting a from-scratch
redesign: a new **Home** landing page (guide + Connect + rescue bypass), and three nav
groups — **Configure** (Setup, Calibration, Motors, Tuning — guide-journey order),
**Monitor** (Dashboard, Charts), **Maintain** (Full Parameters, Firmware, Console —
frequency order). The group boundary deliberately mirrors the layered connection
policy (G5), so the structure itself answers "what is usable right now" and no
nav-level connection indicator is added for now.

## Trade-offs recorded

- **Firmware demoted from nav position 1 to the Maintain group.** J5 credited the
  brick-rescue journey partly to Firmware being first; we trade that for a first-run
  landing that is a product, not a flashing tool. Rescue discoverability now rests on
  group semantics ("Maintain") and Home's rescue bypass rather than position.
- **The group is named Configure, not Setup**, solely to avoid colliding with the
  Setup page inside it.
- **The raw parameter table is repositioned as the Escape Hatch**: moved into
  Maintain and relabeled "Full Parameters"; no in-page redirect banner — escape-hatch
  users should not be nagged back.
- **The Setup Guide drawer stays** alongside Home (same guideSteps store): Home owns
  arrival and orientation, the drawer owns mid-journey progress checks from other
  pages. Guide *content* upgrades (tuning step, board-derived done flags) were
  deliberately left out of this decision.
