# Task 0.2 spike: MAVLink message-definitions provider for the browser

Decides which tool supplies, for browser use: per-message field tables
(name/offset/size/type), CRC_EXTRA per msgid, and enums for the
`ardupilotmega` dialect (transitively: minimal + common + ardupilotmega).
Consumed later by a hand-written `FrameParser`
(`defs.crcExtraForMsgId(msgid)` + a byte-offset field table) and decoder —
not by a vendored serializer.

**Recommendation: `mavlink-mappings` npm package, pinned exact, imported
from per-dialect submodule paths (never the package root).**
mavgen's official `--lang=TypeScript` is real but generates data classes
that hard-import `node-mavlink`, which is Node stream/Buffer-bound and
already rejected as a runtime dependency. `mavlink-mappings` is the pure
data layer `node-mavlink` itself is built on, ships prebuilt per-dialect
`.js`/`.d.ts` with static `MSG_ID` / `MAGIC_NUMBER` (CRC_EXTRA) / `FIELDS`
(byte offsets) on every message class, and has zero Node built-ins in the
files we actually need to import.

## What was tried

### 1. mavgen TypeScript (rejected)

```
git clone --depth 1 https://github.com/mavlink/mavlink.git
cd mavlink && git submodule update --init --depth 1 pymavlink
python3 -m venv venv && source venv/bin/activate && pip install lxml
PYTHONPATH=pymavlink python3 pymavlink/tools/mavgen.py \
  --lang=TypeScript --wire-protocol=2.0 \
  -o ../out-mavgen-ts message_definitions/v1.0/ardupilotmega.xml
```

`--lang=TypeScript` is a real, working flag (`pymavlink/generator/mavgen_typescript.py`,
listed in `mavgen.py`'s `supportedLanguages`). Note: the CLI entrypoint
moved — running `pymavlink/generator/mavgen.py` directly raises
`DeprecationWarning: Executable was moved to pymavlink.tools.mavgen`; use
`pymavlink/tools/mavgen.py`. Also: the generator has a minor bug — it never
creates the output directory itself (only `<output>/enums`), so the target
dir must be pre-`mkdir -p`'d or the first run fails with `FileNotFoundError`.

Generation succeeded: 325 message types across 9 XML files (ardupilotmega +
common + uAvionix + icarous + loweheiser + cubepilot + csAirLink + standard +
minimal), 548 files, 2.3 MB.

**Criteria:**

- **(a) Zero Node-only deps — FAIL.** Every generated message file and the
  registry file open with:
  ```ts
  import {MAVLinkMessage} from 'node-mavlink';
  import {readInt64LE, readUInt64LE} from 'node-mavlink';
  ```
  `node-mavlink`'s own core (`dist/lib/mavlink.js`) does
  `const stream_1 = require("stream")` and its packet splitter/parser
  literally `extends stream_1.Transform`, plus pervasive `Buffer.alloc` /
  `Buffer.from` / `Buffer.concat` — none of which exist in a browser without
  a bundler polyfill shim. This matches (and confirms) the prior rejection
  of `node-mavlink` as a runtime dependency. Since mavgen's TS classes
  literally cannot exist without `node-mavlink extends MAVLinkMessage`, this
  path is dead regardless of any other criterion.
- **(b) Serialization API shape / CRC_EXTRA accessibility — weak.** Generated
  classes carry `_message_id`, `_message_name`, `_crc_extra` (instance
  fields, e.g. `Heartbeat._crc_extra = 50`) and `_message_fields:
  [string, string, boolean][]` (name, type, isExtension) **in wire order**
  — but **no byte offsets** (would have to be derived by summing type sizes
  yourself) and **zero pack/unpack/serialize methods anywhere** in the
  output (verified: `grep -c "public.*("` on a sample class is 0; the only
  "pack" hits across the whole tree are English words like "packet" in doc
  comments). The generated code is schema-only and is designed to be a
  companion to `node-mavlink`'s own hand-written encoder, not a
  self-sufficient artifact.
- **(c) Size — moot**, given (a), but for the record: 2.3 MB / 548 files for
  the full dialect, one file per message/enum.
- **(d) TS strict-mode — FAIL as shipped.** `tsc --noEmit --strict` on a
  generated file with no `node-mavlink` installed:
  ```
  messages/heartbeat.ts(1,30): error TS2307: Cannot find module 'node-mavlink' or its corresponding type declarations.
  ```
  It would typecheck if `node-mavlink` were added as a dependency, but that
  reintroduces the Node-stream problem this spike exists to avoid.

Verdict: **unusable** for a browser-only frame parser. Not a maintenance or
polish problem — the generator's design assumes a Node runtime companion
library.

### 2. Fallback: `mavlink-mappings` (adopted)

The brief said to lock `mavlink-mappings@1.0.20`. That exact semver string
doesn't exist on npm — the package uses date-suffixed versions
(`1.0.20-20240131-0`, `1.0.21-20250824-1`, `1.0.22-20260311` is `latest`).
Pinned the last `1.0.20.x` release: **`mavlink-mappings@1.0.20-20240131-0`**,
exact (no `^`), added to `package.json` `dependencies`:

```
npm install --save-exact mavlink-mappings@1.0.20-20240131-0
```

Where it comes from: `node-mavlink@2.3.0`'s own `package.json` depends on
`"mavlink-mappings": "^1.0.21-20250824-1"` — i.e. `mavlink-mappings` is the
pure data layer, and `node-mavlink` bolts a Node `stream.Transform` +
`Buffer` wire-format engine on top of it. We take the data layer and write
our own Web-native (`Uint8Array`/`DataView`) codec in `FrameParser`.

**Criteria:**

- **(a) Zero Node-only deps in the code we import — PASS, with one footgun.**
  `mavlink-mappings`'s package root (`import { ardupilotmega } from
  'mavlink-mappings'`) re-exports `mavlink-mappings-gen`
  (`export * from 'mavlink-mappings-gen'` in `dist/index.js`), which pulls
  in `xml2js`/`sax` (the package's *own* offline XML-download/codegen
  tooling) — Vite externalizes `events`/`timers`/`stream` for these with
  warnings, and they are not safe in a browser without polyfills.
  **Importing the dialect submodule directly** —
  `import * as ardupilotmega from 'mavlink-mappings/dist/lib/ardupilotmega'`
  — bypasses `mavlink-mappings-gen` entirely: verified zero Node-builtin
  externalization warnings and a clean, small dependency graph (11 modules).
  **Rule for all future code: always import
  `mavlink-mappings/dist/lib/<dialect>`, never bare `mavlink-mappings`.**
  `scripts/gen-mavlink.sh` greps `src/` for the barrel import and fails if
  found.
- **(b) Serialization API shape / CRC_EXTRA accessibility — PASS, and better
  than mavgen's own TS output.** Each message is a class extending
  `MavLinkData` with:
  ```ts
  static MSG_ID: number
  static MSG_NAME: string
  static PAYLOAD_LENGTH: number
  static MAGIC_NUMBER: number       // this is CRC_EXTRA
  static FIELDS: MavLinkPacketField[]
  ```
  and `MavLinkPacketField` (from `mavlink-mappings/dist/lib/mavlink`) is
  `{ source, name, type, length, offset, extension, size, units }` — **byte
  offset is precomputed and included**, along with per-element `size` and
  array `length` for `char[]`/numeric-array fields, and an `extension`
  flag for MAVLink v2 extension fields appended after the base payload.
  Example, confirmed at runtime (`node_modules/mavlink-mappings/dist/lib/minimal.js`):
  ```js
  Heartbeat.MAGIC_NUMBER = 50;
  Heartbeat.FIELDS = [
    new MavLinkPacketField('custom_mode', 'customMode', 0, false, 4, 'uint32_t', ''),
    new MavLinkPacketField('type', 'type', 4, false, 1, 'uint8_t', ''),
    ...
  ];
  ```
  Each dialect module exports a flat `REGISTRY: { [msgid: number]:
  MavLinkDataConstructor }`. **Important gotcha**: a dialect module's
  `REGISTRY` only contains messages *defined in that XML file*, not its
  `<include>`s — e.g. `ardupilotmega.REGISTRY` has 64 entries, not 272.
  `common.REGISTRY` has 207, `minimal.REGISTRY` has 1 (`HEARTBEAT`). The
  consumer must merge them:
  ```ts
  const registry = { ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY }
  const crcExtra = registry[msgid].MAGIC_NUMBER
  const fields = registry[msgid].FIELDS // offset-annotated, wire order
  ```
  There are **no pack/unpack methods** here either — same as mavgen's
  output, this is metadata-only by design. `FrameParser`/decoder must be
  hand-written against `FIELDS`, which was always the plan per the task
  brief.
  **Known gap**: `mavlink-mappings`'s `ardupilotmega` module (64 msgs) is
  narrower than upstream `mavlink/mavlink`'s current `ardupilotmega.xml`,
  which also `<include>`s `uAvionix.xml`, `icarous.xml`, `loweheiser.xml`,
  `cubepilot.xml`, `csAirLink.xml`, `standard.xml` (325 msgs total via
  mavgen). `mavlink-mappings` ships `uavionix` and `icarous` as separate
  importable dialects (not merged into `ardupilotmega`), but has **no**
  `loweheiser`/`cubepilot`/`csAirLink` module at all, even in the latest
  `1.0.22-20260311`. If the project ever needs CubePilot-specific or
  csAirLink/loweheiser messages, this package will not have them — flag
  this explicitly in Task 0.4 (选型锁定记录) rather than discovering it later.
  minimal+common+ardupilotmega together (272 msgs) covers the standard
  ArduPilot flight-controller telemetry/param/mission/camera/gimbal/EFI
  surface, which is almost certainly sufficient for this configurator.
- **(c) Generated size / tree-shaking — measured with a real Vite build.**
  Isolated test project: `npm init`, install `vite@6` + `typescript@5` +
  the pinned `mavlink-mappings`, four entry points built with
  `vite build`, minified with esbuild, gzip size from Vite's own report:

  | Entry | Import style | Minified | Gzip | Notes |
  |---|---|---|---|---|
  | `entry-full.ts` | `import { ardupilotmega } from 'mavlink-mappings'` (barrel) | 582.69 kB | 117.96 kB | pulls in `xml2js`/`sax`, Node builtins externalized with warnings — **avoid** |
  | `entry-ardu-direct.ts` | `import * as ardupilotmega from 'mavlink-mappings/dist/lib/ardupilotmega'` | 398.37 kB | 72.73 kB | clean, no warnings — **use this pattern** |
  | `entry-ardu-single-class.ts` | `import { Heartbeat } from '.../ardupilotmega'` | 398.30 kB | 72.70 kB | ~same as above |
  | `entry-narrow.ts` | `import { Heartbeat } from '.../minimal'` | 8.25 kB | 2.91 kB | minimal dialect only, for scale reference |

  Tree-shaking a single class out of `ardupilotmega` (398.30 kB) vs. the
  whole namespace (398.37 kB) saves **70 bytes** — i.e. essentially none.
  Every message class in a dialect file is captured by that file's
  `REGISTRY` object literal, so Rollup/esbuild can't drop unused classes;
  the practical unit of adoption is the whole dialect file
  (minimal+common+ardupilotmega ≈ 400 kB minified / ~73 kB gzip), not
  per-message imports. This is an acceptable one-time cost for a
  configurator app and is much smaller than mavgen's raw 2.3 MB TS source
  tree (which isn't a fair comparison — that's uncompiled/unminified source
  — but there's nothing to minify it *into* on the mavgen path anyway,
  since it doesn't run standalone).

  npm install footprint: `node_modules/mavlink-mappings` itself is 2.8 MB,
  but because `mavlink-mappings-gen`, `ts-node`, `xml2js`, `sax`, `saxes`
  are listed under `mavlink-mappings`' package.json `dependencies` (not
  `devDependencies`) even though they're only used by the package's own
  `npm run regenerate` publish-time script, `npm install` pulls them into
  the project's `node_modules` too (23 extra packages). This does **not**
  affect the Vite bundle (confirmed above — direct submodule imports never
  touch them), but it does show up in `npm audit`: 3 moderate
  prototype-pollution advisories against `xml2js@<0.5.0`, transitively
  required by `mavlink-mappings-gen`. Worth a one-line callout in Task 0.4
  since it'll appear in any dependency audit, even though it's inert at
  runtime.
- **(d) TS strict-mode — PASS.** Reproduced the project's actual
  `tsconfig.json` settings (`strict`, `target: ES2022`, `module: ESNext`,
  `moduleResolution: Bundler`) against a sample file exercising the exact
  shape the frame layer needs (merge registries, look up `MAGIC_NUMBER` and
  `FIELDS` by msgid, construct a message instance):
  ```
  tsc --noEmit --strict --target es2020 --module esnext --moduleResolution bundler strict-check.ts
  ```
  → zero errors. (One real error surfaced and was fixed during the
  spike: `ardupilotmega.Heartbeat` doesn't exist — `Heartbeat` lives in
  `minimal.ts` and dialect modules don't `export *` each other, they only
  import the specific named types/enums they reference. This is the same
  "merge the registries" gotcha as (b), just caught by the type checker
  too.)

## Recommendation

Use **`mavlink-mappings@1.0.20-20240131-0`** (exact pin), imported only via
direct dialect submodule paths:

```ts
import * as minimal from 'mavlink-mappings/dist/lib/minimal'
import * as common from 'mavlink-mappings/dist/lib/common'
import * as ardupilotmega from 'mavlink-mappings/dist/lib/ardupilotmega'
import type { MavLinkPacketField, MavLinkPacketRegistry } from 'mavlink-mappings/dist/lib/mavlink'

const registry: MavLinkPacketRegistry = {
  ...minimal.REGISTRY,
  ...common.REGISTRY,
  ...ardupilotmega.REGISTRY,
}

function crcExtraForMsgId(msgid: number): number {
  const ctor = registry[msgid]
  if (!ctor) throw new Error(`unknown msgid ${msgid}`)
  return ctor.MAGIC_NUMBER
}

function fieldsForMsgId(msgid: number): MavLinkPacketField[] {
  return registry[msgid].FIELDS // offset-annotated, wire order, extension-flagged
}
```

This is the API shape `FrameParser`/decoder (Task 2.2) should build against.
No serializer/deserializer exists in either candidate — `mavlink-mappings`
gives us the schema (field tables + CRC_EXTRA + enums), we write the
`Uint8Array`/`DataView` pack/unpack ourselves, which was the plan from the
start.

**Rejected**: mavgen `--lang=TypeScript` — real generator, but its output
hard-depends on `node-mavlink` (Node `stream.Transform` + `Buffer`), which
is already excluded as a runtime dependency, and even with that dependency
added it's schema-only (no offsets, no pack/unpack) — strictly worse than
`mavlink-mappings` on every criterion that matters here.

## Concerns to carry into Task 0.4 (选型锁定记录)

1. **Coverage gap**: `mavlink-mappings`'s `ardupilotmega` module (64 msgs)
   + `common` (207) + `minimal` (1) = 272 messages, vs. 325 in upstream
   `mavlink/mavlink`'s live `ardupilotmega.xml` (which also includes
   `loweheiser.xml`/`cubepilot.xml`/`csAirLink.xml`/`standard.xml`, none of
   which `mavlink-mappings` ships as any importable module, pinned or
   latest). If a target board needs CubePilot/csAirLink/Loweheiser vendor
   messages, this package cannot supply them and a custom generation step
   would be needed later.
2. **`npm audit` noise**: pulls `xml2js`/`sax`/`ts-node`/`mavlink-mappings-gen`
   into `node_modules` (dev-only, inert at runtime) because they're
   mis-declared as runtime `dependencies` upstream — 3 moderate advisories
   will show up in scans; document as a known false-positive rather than
   chasing an upgrade that changes the pinned version.
3. **Import discipline is load-bearing**: the barrel import
   (`from 'mavlink-mappings'`) silently balloons the bundle by ~200 kB
   minified and drags in Node builtins Vite has to externalize. This is
   enforced today only by `scripts/gen-mavlink.sh`'s grep check — worth
   an ESLint `no-restricted-imports` rule once real source lands in
   `src/core/mavlink/`.

## Repo artifacts from this spike

- `scripts/gen-mavlink.sh` — idempotent verification script (not a code
  generator; there is nothing to generate for the npm path). Checks the
  exact pin in `package.json` matches what's installed, smoke-tests that
  `minimal + common + ardupilotmega` registries resolve msgid → CRC_EXTRA
  + offset-annotated field table, and greps `src/` for forbidden barrel
  imports. Run: `./scripts/gen-mavlink.sh`.
- `package.json` — added `"mavlink-mappings": "1.0.20-20240131-0"` to
  `dependencies` (exact pin, no caret) so Task 1.x/2.x can build on it
  directly. `npm run build` and `npm run lint` both verified clean after
  the addition (nothing references it yet, so this is purely additive).
- No files were added under `src/core/mavlink/generated/` — deliberately.
  The winning provider has no generation step; the "generated" artifact is
  simply `node_modules/mavlink-mappings/dist/lib/*`, imported directly.
- All exploratory clones/builds (mavlink/mavlink + pymavlink submodule,
  the mavgen TS output, the isolated Vite bundle-size test project) were
  done in scratch space outside the repo and are not committed.
