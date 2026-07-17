# Discovery: the org ships two parallel web firmware-update stacks (2026-07-17)

While closing #28, a look at `novaX-ALUX/parts-catalog` (the Astro + Sveltia CMS
parts site) revealed it contains a **complete, actively maintained second web
firmware updater** — unknown to this repo's gap docs, roadmap, and ADR-0002.
Recorded here so the two stacks stop evolving mutually blind. All facts below
read from the parts-catalog repo via the GitHub API on 2026-07-17.

## What parts-catalog has

- **`src/pages/update.astro`** (~35 KB): a "Firmware Update" tool with two
  modes — "⚡ Firmware Update · normal" and "🛠 DFU Recovery · blank/bricked".
  Functionally isomorphic to this repo's Firmware page.
- **Its own protocol stack** in `src/scripts/update/`: `serial-px4.ts` (~17 KB,
  PX4 serial bootloader protocol), `dfu.ts` (~17 KB, WebUSB DFU),
  `apj.ts`, `intel-hex.ts`. Independent implementations of the same protocols
  as this repo's core/firmware engine.
- **Its own same-origin firmware mirror**: 74 files under `public/firmware/`
  (.apj, `_with_bl.hex`, per-board json), same MIRROR idea as this repo's
  M1 Decision 4 but a separate copy with a separate format. Catalog entries
  live in CMS content collections (fc/gnss/esc/motor/camera) with
  `firmware[]` entries carrying version/kind/method/webPath/sha256/size/date.
- **Wider verified coverage than ours**: page comments state the full web flow
  (serial OTA + software DFU + DFU flash) is hardware-verified for F4, F7
  (AF-F7 Mini, 2026-07-09), and H7 — including **AF-H7E buttonless software
  DFU via a `param4=99` magic and bootloader self-heal**. A `WEB_UPDATE_FAMILIES`
  gate plus a per-board MCU-family chip guard (F4/F7/H7 from CMS specs).
- **Firmware signing tooling** in `tools/`: `af_f4_t10_fwsig.py`, `keys/`,
  plus Python flash utilities (`flash_dfu.py`, `serial_update.py`).
- Actively maintained: recent commits update the catalog for the v1.x
  flight_controller releases (labelled a "웹 업데이터" — web updater — catalog).

## Why this matters (problem list)

1. **Protocol code drifts in two places.** PX4-serial and DFU implementations
   exist in both repos and evolve independently. Lessons paid for on one side
   don't reach the other: #28's power-loss findings (and #47's guidance copy)
   land only here; the `param4=99` software-DFU and bootloader-self-heal
   knowledge lives only in parts-catalog commit lore.
2. **Two firmware mirrors of the same releases.** Same flight_controller
   artifacts mirrored twice (74 files there, our `public/firmware/` here),
   two metadata formats (CMS entries vs `manifest.json`), synced by hand.
3. **Safety posture is unequal.** This repo: bootloader board_id == .apj
   board_id hard gate, SHA-256 verification, defined cancellation points.
   The catalog updater's visible gate is an MCU-family filter (finer detail
   unreviewed). Which protections a user gets depends on which site they
   happen to enter from.
4. **Mutual invisibility.** Our gap docs benchmark Mico and axPlanner but
   never counted the sibling repo; parts-catalog likewise references no
   configurator. ADR-0002's product boundary never contemplated an in-org
   sibling shipping the same bench-side capability.

## Status: recorded, not decided

This is a **product-boundary question** on the scale of ADR-0002's
"configurator vs GCS" call: who owns firmware updating? Options at least —
absorb (catalog links out to the configurator), coexist with a single shared
protocol/mirror source, or scoped split (catalog = quick per-product update,
configurator = full bench tool). Needs its own grill; the outcome is likely
an ADR here plus changes there. Deliberately **not** decided in this note.

Parked alongside, for the same future session:

- The RSR-instrumentation proposal for flight_controller (reset-cause
  register embedded in the BL USB serial string — #28's closing comment has
  the full design). Whether/where to file it is part of the same
  cross-repo conversation.
- parts-catalog has none of the agent-workflow scaffolding (no issue
  tracker use, no CLAUDE.md/docs/agents, Korean-format commits) — if the
  boundary decision produces work there, its process needs bootstrapping
  first (`/setup-matt-pocock-skills`).
