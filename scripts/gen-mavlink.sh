#!/usr/bin/env bash
# gen-mavlink.sh
#
# Verifies the MAVLink message-definitions provider for this project.
#
# Background (see docs/notes/mavgen-spike.md for the full spike writeup):
#   mavgen's official `--lang=TypeScript` output hard-imports `node-mavlink`
#   (a Node stream/Buffer-bound package) into every generated message class,
#   so there is nothing to "generate into src/core/mavlink/generated/" that
#   would be usable in a browser bundle. The winning provider is the
#   `mavlink-mappings` npm package (the same pure data layer node-mavlink
#   itself depends on): it ships prebuilt per-dialect modules with static
#   MSG_ID / MAGIC_NUMBER (CRC_EXTRA) / FIELDS (name, offset, size, type,
#   extension flag) on each message class, no Node built-ins, importable
#   straight from node_modules.
#
# So this script does not run a code generator. It (idempotently) verifies
# that the pinned version is installed correctly and that importing it the
# *right* way (direct dialect submodule path, not the package root barrel)
# stays free of Node-only builtins, which is the one footgun this package has.
#
# Usage: scripts/gen-mavlink.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PINNED_VERSION="1.0.20-20240131-0"
PKG_DIR="node_modules/mavlink-mappings"

echo "==> Checking package.json pins mavlink-mappings@${PINNED_VERSION} exactly"
DECLARED_VERSION="$(node -p "require('./package.json').dependencies['mavlink-mappings'] || ''")"
if [ "$DECLARED_VERSION" != "$PINNED_VERSION" ]; then
  echo "ERROR: package.json declares mavlink-mappings@${DECLARED_VERSION:-<missing>}, expected exact pin ${PINNED_VERSION}." >&2
  echo "       Run: npm install --save-exact mavlink-mappings@${PINNED_VERSION}" >&2
  exit 1
fi

echo "==> Checking node_modules/mavlink-mappings is installed"
if [ ! -d "$PKG_DIR" ]; then
  echo "mavlink-mappings not installed yet, running npm install..."
  npm install
fi

INSTALLED_VERSION="$(node -p "require('./${PKG_DIR}/package.json').version")"
if [ "$INSTALLED_VERSION" != "$PINNED_VERSION" ]; then
  echo "ERROR: node_modules has mavlink-mappings@${INSTALLED_VERSION}, expected ${PINNED_VERSION}." >&2
  echo "       Run: npm install --save-exact mavlink-mappings@${PINNED_VERSION}" >&2
  exit 1
fi
echo "    OK: mavlink-mappings@${INSTALLED_VERSION}"

echo "==> Smoke-checking the ardupilotmega dialect (minimal + common + ardupilotmega)"
node --input-type=module <<'NODE'
import * as minimal from './node_modules/mavlink-mappings/dist/lib/minimal.js'
import * as common from './node_modules/mavlink-mappings/dist/lib/common.js'
import * as ardupilotmega from './node_modules/mavlink-mappings/dist/lib/ardupilotmega.js'

const registry = { ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY }
const count = Object.keys(registry).length
// minimal(1) + common(207) + ardupilotmega(64) = 272 as of the pinned version.
// Note: this is narrower than upstream ardupilotmega.xml's full <include> chain
// (which also pulls in uAvionix/icarous/loweheiser/cubepilot/csAirLink/standard,
// ~325 messages via mavgen) -- see docs/notes/mavgen-spike.md "known gap".
if (count < 250) {
  throw new Error(`expected >=250 merged message ids for ardupilotmega dialect, got ${count}`)
}

const heartbeat = registry[0]
if (!heartbeat || heartbeat.MSG_NAME !== 'HEARTBEAT' || typeof heartbeat.MAGIC_NUMBER !== 'number') {
  throw new Error('HEARTBEAT (msgid 0) did not resolve to a class with a numeric MAGIC_NUMBER (CRC_EXTRA)')
}
if (!Array.isArray(heartbeat.FIELDS) || heartbeat.FIELDS.length === 0 || typeof heartbeat.FIELDS[0].offset !== 'number') {
  throw new Error('HEARTBEAT.FIELDS did not resolve to an offset-annotated field table')
}

console.log(`    OK: ${count} message ids resolvable, HEARTBEAT CRC_EXTRA=${heartbeat.MAGIC_NUMBER}, ${heartbeat.FIELDS.length} fields with byte offsets`)
NODE

echo "==> Checking no source file imports the 'mavlink-mappings' package root (barrel import)"
echo "    (the barrel re-exports mavlink-mappings-gen, which drags xml2js/stream/timers Node builtins into a browser bundle)"
if grep -rn --include='*.ts' --include='*.tsx' -E "from ['\"]mavlink-mappings['\"]" src 2>/dev/null; then
  echo "ERROR: found a barrel import above. Import from a dialect submodule instead, e.g.:" >&2
  echo "         import * as ardupilotmega from 'mavlink-mappings/dist/lib/ardupilotmega'" >&2
  exit 1
fi
echo "    OK: no barrel imports found under src/"

echo "==> All checks passed."
