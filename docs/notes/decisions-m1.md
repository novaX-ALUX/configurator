# Task 0.4: M1 Decision-Lock Record (Hard Gate)

Date: 2026-07-02
Status: LOCKED (except the LGPL item, which is PENDING-HUMAN)

**This document is a hard constraint on all interfaces in Phase 1 and beyond. Subsequent tasks (1.1/1.2 manifest
contract, 2.2 frame layer, 3.3 firmware engine, ...) must be consistent with this document; if an interface conflicts
with this document, change this document first (following the "How to overturn" process below) — do not silently
work around it in the implementation.**

Basis:
- Task 0.2 spike — `docs/notes/mavgen-spike.md`
- Task 0.3 spike — `docs/notes/releases-cors-spike.md`
- Design doc §6/§7/§11 — `docs/superpowers/specs/2026-07-02-novax-configurator-design.md`

---

## Decision 1: Message-definition provider = `mavlink-mappings@1.0.20-20240131-0` (exact pin)

**Decision**: Adopt the npm package `mavlink-mappings`, exact version `1.0.20-20240131-0` (no `^`),
**only allowing** direct imports from each dialect's submodule:

```ts
import * as minimal from 'mavlink-mappings/dist/lib/minimal'
import * as common from 'mavlink-mappings/dist/lib/common'
import * as ardupilotmega from 'mavlink-mappings/dist/lib/ardupilotmega'
```

**Forbidden**: importing from the package root (`import { ardupilotmega } from 'mavlink-mappings'`) — the barrel
pulls in `mavlink-mappings-gen` (`xml2js`/`sax`), Vite would need to externalize Node built-in modules, and the
measured bundle size balloons (117.96 kB gzip vs 72.73 kB gzip).

How CRC_EXTRA is obtained: each message class's static `MAGIC_NUMBER`. How the field table is obtained: each
message class's static `FIELDS` (`MavLinkPacketField[]`, containing precomputed byte offset, size, array length,
and extension flag). The `REGISTRY` of each of the three dialects must be manually merged
(`{ ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY }`) — each `REGISTRY` only contains the
messages **defined by that XML itself**, not the ones expanded via `<include>`.

**Evidence**: `docs/notes/mavgen-spike.md` §"2. Fallback: mavlink-mappings (adopted)" and its four verification
results (a)(b)(c)(d); the official mavgen `--lang=TypeScript` has already been rejected in the same spike's
§"1. mavgen TypeScript (rejected)" due to a hard dependency on `node-mavlink` (Node `stream.Transform`/`Buffer`).

**Impact on subsequent tasks**:
- Task 2.2 (frame layer) must write `FrameParser` based on the shape of `crcExtraForMsgId(msgid)` /
  `fieldsForMsgId(msgid)`, and must not assume the existence of pack/unpack methods (neither candidate has them —
  it's a metadata-only design, and serialization must be hand-written).
- Task 1.1/1.2 (manifest contract) does not directly depend on this decision, but if the manifest references a
  message name/msgid, it should validate legality through the same registry.

**Status**: LOCKED

**How to overturn**: If CubePilot/csAirLink/Loweheiser messages are needed later (see the coverage gap in
Decision 7), or `mavlink-mappings` stops being maintained / develops an unacceptable bug, re-run an equivalent
spike (bundle size + strict TS + CRC_EXTRA reachability), compare against official mavgen or a hand-written XML
parser, update this section, and notify the Task 2.2 owner.

---

## Decision 2: Isolation requirement — `mavlink-mappings` may only be imported in `src/core/mavlink/defs.ts`

**Decision**: Across the entire repo, only one file is allowed to `import ... from 'mavlink-mappings/dist/lib/*'`
— `src/core/mavlink/defs.ts`. This file is an adapter, exposing externally:

```ts
interface GeneratedDefs {
  crcExtraForMsgId(msgid: number): number
  fieldsForMsgId(msgid: number): MavLinkPacketField[]
  messageName(msgid: number): string
  // ...
}
```

All other code (frame.ts, router.ts, params.ts, features/*) only consumes the `GeneratedDefs` adapter interface,
and does not directly import `mavlink-mappings`.

**Rationale**: Two reasons: (1) Replaceability — if Decision 1 is overturned in the future (see Decision 1's
"How to overturn"), swapping the underlying provider only requires rewriting this one file; (2) LGPL isolation —
locking the only LGPL dependency into a single file reduces the legal surface area, and also gives the question of
"whether LGPL code should be kept in the bundle" (Decision 3) a clear replacement point.

**Evidence**: The API shape given in the "Recommendation" section of `docs/notes/mavgen-spike.md`
(`crcExtraForMsgId`/`fieldsForMsgId`) is already the prototype of this adapter interface.

**Impact on subsequent tasks**:
- Task 2.2 (frame layer): `FrameParser`/`router.ts`/`command.ts`/`params.ts` must uniformly
  `import type { GeneratedDefs } from '../mavlink/defs'`, and must not touch `mavlink-mappings` directly.
- When Task 2.2 is delivered, it must also deliver the ESLint rule from Decision 8, turning this isolation
  requirement from a "convention" into a "CI-enforced" rule.

**Status**: LOCKED

**How to overturn**: If the adapter interface itself proves insufficient (for example, needing to expose enum
definitions, unit information, or other fields not covered by `GeneratedDefs`), extend the `GeneratedDefs`
interface itself, rather than opening a new import point outside of `defs.ts`.

---

## Decision 3: LGPL license status — PENDING HUMAN SIGN-OFF

**Decision**: `mavlink-mappings`'s `package.json` declares `"license": "LGPL"`. During the M1 development phase,
it **may be used** (this does not block development). But before any **public release** (GitHub Pages going live,
sharing links externally), a human must choose one of two options:

- (a) Sign off on accepting the LGPL, and add a new licenses page on the website listing this dependency and its
  license terms, along with how to obtain the source code; or
- (b) Trigger the fallback: drop `mavlink-mappings` and switch to a hand-written generator that produces
  equivalent message-definition data from the official MAVLink XML (MIT-licensed) (i.e., return to the
  "do-it-yourself" version of the mavgen route rejected in Decision 1, but producing metadata-only data rather
  than mavgen's Node-bound code).

**Evidence**: `docs/notes/mavgen-spike.md`, "Concerns to carry into Task 0.4" item 1 — explains in detail the gray
area of how LGPL "dynamic linking" is determined in a bundle scenario, and two uncertain but worth-weighing
mitigating factors (data rather than algorithmic logic; the package source was not modified). The spike explicitly
states that "the go/no-go call belongs to Task 0.4 and the human, not to the spike".

**Impact on subsequent tasks**:
- Task 3.3 (firmware engine) and all milestones aimed at public release must, before shipping, check whether this
  item has already changed from PENDING to LOCKED(a) or LOCKED(b).
- If fallback (b) is taken, the adapter file path from Decisions 1/2 remains unchanged — only the internal
  implementation of `defs.ts` is swapped out, which is exactly the purpose of Decision 2's isolation design.

**Status**: **PENDING-HUMAN** (owner = human, not something the spike/controller can decide on its own)

**How to overturn**: "Overturning" does not apply here — this is an open item that must be explicitly closed by a
human, not a technical decision that can be automatically superseded by a later spike. See (a)/(b) above for how
to close it.

---

## Decision 4: Firmware distribution strategy = MIRROR

**Decision**: Firmware binaries and `manifest.json` are always **mirrored** into the GC site's own
`public/firmware/`, served same-origin by GitHub Pages (`${BASE}firmware/...`). Directly `fetch()`ing GitHub
Releases asset bytes from the browser is no longer under consideration (that approach has been rejected by the
CORS evidence).

**Sync mechanism** (contract locked; the script itself is not built as part of this task): `scripts/sync-firmware.sh`,
using the `gh` CLI, pulls assets by tag from `novaX-ALUX/flight_controller`'s GitHub Releases and writes them into
this repo's `public/firmware/`. This script belongs to work adjacent to Task 1.2; here we only lock in the
contract that "such a script exists, goes through the `gh` CLI, and targets `public/firmware/`" — it is not
implemented in this task.

**Evidence**: `docs/notes/releases-cors-spike.md` — Hop 2 (`release-assets.githubusercontent.com`), across two
independent public repos and three file types (`.apj`/`.hex`/`.txt`), was confirmed in all cases to have **no**
`Access-Control-Allow-Origin` response header, and the browser's `fetch()` fails with
`TypeError: Failed to fetch`. The spike's "Correction to the existing design assumption" section further notes
that the design doc §7's original statement that "firmware files still point to Releases" does not hold, because
WebUSB DFU / PX4 serial bootloader flashing both require reading the firmware into an in-memory `ArrayBuffer`, not
a native browser download to disk — a direct `fetch()` is not viable, and an `<a href>` download does not meet
the requirement either.

**Impact on subsequent tasks**:
- Task 1.1/1.2 (manifest contract): the `files[].url` in the manifest must be a same-origin path relative to
  `public/firmware/`, and must not be a cross-origin URL like `github.com/.../releases/download/...`.
- Task 3.3 (firmware engine): `fetchFirmwareBytes()` only calls `fetch()` on same-origin URLs, with no
  cross-origin fallback logic whatsoever (see Decision 5's error-handling rules).
- Some later task (unnumbered, around Task 1.2) needs to decide the retention policy for `public/firmware/` (all
  historical versions vs. only the latest N) — this document does not make that decision, and only flags it as an
  outstanding issue.

**Status**: LOCKED

**How to overturn**: If GitHub adds a CORS header to `release-assets.githubusercontent.com` in the future (an
infrastructure change outside this project's control), or if the `raw.githubusercontent.com` route is adopted
instead (the approach mentioned in the spike's "Not recommended, but noted as theoretically available" section,
of committing the files directly into the git tree), an equivalent CORS-header verification must be redone, this
section updated, and the Task 1.1/1.2/3.3 owner notified.

---

## Decision 5: `fetchManifest` URL rule = same-origin relative path

**Decision**:

```ts
async function fetchManifest(boardId: string): Promise<Manifest> {
  const res = await fetch(`firmware/${boardId}/manifest.json`) // relative path, resolved based on Vite BASE_URL
  if (!res.ok) throw new ManifestFetchError(res.status)
  return res.json()
}
```

`api.github.com` is **only** allowed to be used for **notification-only** metadata queries like "is a new version
available" (it does indeed carry `Access-Control-Allow-Origin: *`), and is **never** allowed to be used to fetch
firmware bytes or `manifest.json` itself — that path has already been rejected by the evidence in Decision 4. On
a 404 (mirror sync not yet complete), give the user a clear "firmware temporarily unavailable, please try again
later" message, and do **not** fall back cross-origin to `github.com/.../releases/download/...` (a CORS failure
shows up in the browser's fetch API as an undifferentiated `TypeError`, which would disguise a diagnosable "not
synced" problem as an undiagnosable network error).

**Evidence**: The draft contract for `fetchManifest()`/`fetchFirmwareBytes()` in the "Recommendation" section of
`docs/notes/releases-cors-spike.md`, and the "Error/fallback path" paragraph immediately following it.

**Impact on subsequent tasks**:
- Task 1.2 (manifest contract implementation) implements this function signature directly.
- Task 3.3 (firmware engine) reuses the same "same-origin, no fallback" rule to implement
  `fetchFirmwareBytes(url)`.

**Status**: LOCKED

**How to overturn**: Bound to Decision 4; the overturn method is the same.

---

## Decision 6: defs-layer bundle budget = ≤ 80 kB gzip

**Decision**: `src/core/mavlink/defs.ts` (including its one permitted `mavlink-mappings` dependency) has an
overall gzip size budget of **≤ 80 kB**. The measured gzip size for direct submodule imports of the three
dialects (minimal + common + ardupilotmega) is about **73 kB**, leaving some headroom.

**Evidence**: The measured Vite build table in `docs/notes/mavgen-spike.md` section (c) —
`entry-ardu-direct.ts` 398.37 kB minified / **72.73 kB gzip**; the control group's barrel import is 117.96 kB
gzip (over budget, another reason barrel imports are forbidden, echoing Decision 1).

**Impact on subsequent tasks**:
- When Task 2.2 is delivered, a bundle-size check should be added to CI (or at least the measured value reported
  in the PR description), to prevent a future `mavlink-mappings` version upgrade or added dialect from silently
  exceeding the budget.

**Status**: LOCKED

**How to overturn**: If product requirements change (for example, needing to introduce more dialects, see
Decision 7), the budget may be raised, but the new budget value and the reason for the change must be explicitly
recorded in this document — it is not enough to just change the number in the CI config.

---

## Decision 7: Message coverage gap (272/325) — a known limitation acceptable for M1

**Decision**: `mavlink-mappings`'s `minimal + common + ardupilotmega` totals 272 messages, fewer than the
upstream `mavlink/mavlink`'s current `ardupilotmega.xml` (expanded via `<include>`), which has 325 — the gap
consists of the three vendor dialects `loweheiser`/`cubepilot`/`csAirLink` (which `mavlink-mappings` does not
provide at all, including its latest version). M1's scope is a purely generic ArduPilot configurator that does
not commit to these three vendors' proprietary messages, so **this gap is accepted**.

**Evidence**: `docs/notes/mavgen-spike.md` section (b) and "Concerns" item 2 — message counts listed per dialect
(`ardupilotmega.REGISTRY` 64, `common.REGISTRY` 207, `minimal.REGISTRY` 1), plus the list of missing dialects.

**Impact on subsequent tasks**:
- If future support is needed for a board using CubePilot/csAirLink/Loweheiser vendor messages, Decision 1's
  "How to overturn" process must be re-triggered (writing a custom generator or finding an alternative provider),
  rather than hacking in a local workaround in Task 2.2/3.3.

**Status**: LOCKED (recorded as a "known limitation", non-blocking)

**How to overturn**: Re-evaluate when a concrete board requirement needing these vendor messages arises.

---

## Decision 8: ESLint enforcement — a TODO carried over to Task 2.2

**Decision**: Add a new ESLint rule, `no-restricted-imports`, forbidding the import of `mavlink-mappings`
(including any of its subpaths) in any file other than `src/core/mavlink/defs.ts`. Currently this constraint is
only backed by the grep check in `scripts/gen-mavlink.sh`; it is not a CI-enforced lint rule, and it gives no
immediate feedback in the editor.

**Evidence**: `docs/notes/mavgen-spike.md`, "Concerns" item 4 — "Import discipline is load-bearing".

**Impact on subsequent tasks**:
- When Task 2.2 (frame layer) lands `src/core/mavlink/defs.ts`, it must simultaneously add this ESLint rule to
  the project's lint config, as part of that task's acceptance criteria, rather than leaving it for a later task.

**Status**: LOCKED (a mandatory TODO item for Task 2.2, not optional)

**How to overturn**: Not applicable — this is the enforcement mechanism for Decision 2 (the isolation
requirement); as long as Decision 2 holds, this item holds.

---

## Appendix: Open items not among the numbered decisions above, but worth recording alongside this document

- **The retention policy for `public/firmware/` is undecided** (all historical versions vs. only the latest N) —
  raised but not resolved in `docs/notes/releases-cors-spike.md`, "Concerns" item 3; left for Task 1.1/1.2 or
  later.
- **`npm audit` noise**: `mavlink-mappings` mis-places `xml2js`/`sax`/`ts-node`/`mavlink-mappings-gen` into
  `dependencies` (they should be `devDependencies`), so `npm install` pulls in 3 moderate-severity `xml2js`
  prototype-pollution warnings. These packages do not participate in the runtime bundle at all under the
  direct-submodule-import path (already verified by measured Vite results, see the Decision 1 evidence), so this
  is recorded as a known false positive, with no further upgrade action taken.
