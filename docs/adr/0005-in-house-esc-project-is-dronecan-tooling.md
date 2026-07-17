# In-house ESC project is DroneCAN tooling; 4-Way passthrough demoted

ADR-0002 rule 4 scheduled "ESC 4-Way passthrough" as the strategic project for
the in-house ESC line. That premise is dead: the in-house line is entirely
CAN-protocol (DroneCAN) — issue #48, maintainer note 2026-07-17 — and 4-Way is
a BLHeli/AM32 serial-passthrough mechanism for PWM/DShot ESCs that does not
apply to CAN nodes (the §IV lessons rule 4 cites are 4-Way-specific). The
evidence pack `docs/notes/dronecan-gcs-research-2026-07.md` (with 2026-07-18
addendum) established, source-verified: MAVLink CAN forwarding
(`MAV_CMD_CAN_FORWARD` + `CAN_FRAME` relay) is Mission Planner's own current
DroneCAN connection mode over one plain MAVLink serial session — fully viable
from Web Serial; motor test is DroneCAN-transparent by call-chain trace; the
`CAN_P1_*`/`CAN_D1_*` parameter chain is pinned against Copter 4.6.3-dev;
`mavlink-mappings@1.0.20` defines all four CAN messages in `common`; and the
in-house ESC firmware (`novaX-ALUX/f280049c_foc`) implements the standard
DroneCAN v0 surface end to end (RawCommand/Status/GetSet/firmware-update
client) — no custom-DSDL contingency needed.

**Decision:** the strategic in-house-ESC project is **DroneCAN tooling** in
the configurator. 4-Way passthrough is demoted to an unscheduled backlog idea
serving third-party BLHeli/AM32 users, picked up only on real user demand.
This supersedes ADR-0002 rule 4; all other ADR-0002 rules stand unchanged.

## Rules in force from this ADR

1. **Committed scope.** (a) FC-side enable surface (`CAN_P1_DRIVER`,
   `CAN_D1_PROTOCOL`, ESC bitmask/offset, `SERVOx_FUNCTION` interplay);
   (b) Node discovery; (c) Node Parameter read/write; (d) motor test over
   DroneCAN (verification and copy — transparency is already source-proven).
   (e) ESC firmware update over CAN is committed but **gated**: no tickets
   until a bench spike answers the research note's open questions 2 (update
   duration over serial CAN forwarding) and 6 (file-server node-ID collision).
2. **The frame relay is a core-internal transport detail.** The DroneCAN
   stack lives in the core layer; the CAN-forward keepalive and
   `CAN_FRAME`/`CANFD_FRAME` exchange are its private transport, the way
   MAVLink serialization is private to the Session. ADR-0002 rule 1 is
   extended: **no generic frame channel is ever exposed to feature code** —
   feature code sees only named, typed operations (`discoverNodes`,
   `readNodeParams`, …). Precedent: Mission Planner's own DroneCAN engine is
   transport-agnostic internally; its MAVLink adapter is an outer shell.
3. **Node Parameters go through the same Review Gate.** A Staged Change
   gains a scope — the flight controller or one Node (identity: node ID +
   name). Apply on a Node = write → `param.GetSet` readback → persistence
   (`ExecuteOpcode SAVE`) as built-in steps. No second write ritual, no
   direct-write path.
4. **UI shape.** Setup's ESC protocol field gains a DroneCAN option that
   reveals a CAN configuration card (Review Gate as usual). A new **CAN
   Nodes** page joins the Maintain group (discovery list + per-Node
   parameter table — escape-hatch nature, like Full Parameters). A curated
   in-house-ESC card in Configure is future work, outside this circle.
5. **Phasing.** P1: Setup enable surface + motor-test verification (pure
   PARAM machinery, zero DroneCAN stack, independently shippable). P2: core
   DroneCAN stack + CAN Nodes page (research-note open questions 4 — filter
   semantics — and 5 — backpressure/drop behavior — resolved by test during
   this phase). P3: the firmware-update spike, then firmware-update tickets.
   Each phase is independently releasable.

## Considered Options

- **Keep 4-Way scheduled alongside DroneCAN tooling** — rejected: nobody
  intends to build both now; a scheduled project without intent is roadmap
  fiction.
- **Kill 4-Way entirely** — rejected: it burns the bridge to Mico-parity for
  third-party DShot users, at zero savings over backlogging it.
- **Expose the frame relay as a Named Operation** (feature code gets frame
  handles) — rejected: that is the generic channel ADR-0002 rule 1 bans,
  renamed.
- **A separate lighter gate (or direct write) for Node Parameters** —
  rejected: two write rituals for one mental model, and the glossary's
  Review Gate wording is unconditional.
- **CAN Nodes page in Configure** — rejected for now: a raw per-node
  parameter table is escape-hatch nature; Configure is the curated
  write-path (ADR-0004's grouping principle).

## Consequences

- ADR-0002 rule 4 is annotated as superseded; the §IV 4-Way lessons stay
  recorded there for the backlog item, owned by no scheduled work.
- `CONTEXT.md` gains **Node** and **Node Parameter**; **Staged Change** is
  widened with a scope; the Review Gate explicitly covers both parameter
  kinds.
- Review gains a concrete rejection ground: feature code touching CAN
  frames or the forward keepalive directly.
- The firmware-update story ships last and only with bench numbers behind
  it; if the spike says "impractically slow", the fallback discussion
  (CAN-FD, or an out-of-band update path on the ESC) happens then, with
  data in hand.
