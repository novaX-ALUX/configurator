#!/usr/bin/env bash
# sync-firmware.sh — mirror firmware/manifest.json + assets from
# flight_controller's GitHub Releases into public/firmware/.
#
# Background (docs/notes/decisions-m1.md decision 4, LOCKED): the browser
# cannot fetch() GitHub Releases assets directly (no CORS headers, see
# docs/notes/releases-cors-spike.md), so the configurator serves its own
# same-origin mirror. This script is how that mirror gets populated: it
# downloads manifest.json for a given tag plus every file it lists into a
# staging directory, verifies each file's sha256 against the manifest there,
# and only on full success replaces public/firmware/'s contents. A bad tag,
# network failure, or sha256 mismatch leaves the existing mirror untouched
# and exits nonzero, rather than either publishing a mismatched mirror or
# destroying a working one.
#
# Requires: gh CLI, authenticated (`gh auth login`) with read access to the
# public novaX-ALUX/flight_controller repo (works today — the repo is public).
#
# Usage:
#   scripts/sync-firmware.sh <tag>
#     scripts/sync-firmware.sh v0.2.3

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_REPO="novaX-ALUX/flight_controller"
DEST_DIR="${REPO_ROOT}/public/firmware"

TAG="${1:?Usage: scripts/sync-firmware.sh <tag>  (e.g. v0.2.3)}"

command -v gh >/dev/null 2>&1 || { echo "error: gh CLI not found (https://cli.github.com)" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node not found" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "error: sha256sum not found" >&2; exit 1; }

# Insurance against a future DEST_DIR derivation edit accidentally pointing
# the destructive replace step below at the wrong directory.
[[ "${DEST_DIR}" == */public/firmware ]] || { echo "error: refusing to touch DEST_DIR=${DEST_DIR} (must end in public/firmware)" >&2; exit 1; }

STAGING="$(mktemp -d "${REPO_ROOT}/.sync-firmware-staging.XXXXXX")"
trap 'rm -rf "${STAGING}"' EXIT

echo "==> Fetching manifest.json for ${TAG} from ${UPSTREAM_REPO} (staging: ${STAGING})"
gh release download "${TAG}" -R "${UPSTREAM_REPO}" -p 'manifest.json' -D "${STAGING}"

MANIFEST="${STAGING}/manifest.json"
[[ -s "${MANIFEST}" ]] || { echo "error: manifest.json missing or empty after download" >&2; exit 1; }

# One "name<TAB>sha256<TAB>size" row per file across all boards. Uses node
# (already a hard dependency of this project) instead of adding a jq
# dependency just for this script.
FILE_ROWS="$(node -e '
  const fs = require("fs")
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  if (manifest.schemaVersion !== 1) {
    console.error("error: unexpected schemaVersion " + manifest.schemaVersion)
    process.exit(1)
  }
  for (const board of manifest.boards) {
    for (const file of board.files) {
      console.log([file.name, file.sha256, file.size].join("\t"))
    }
  }
' "${MANIFEST}")"

[[ -n "${FILE_ROWS}" ]] || { echo "error: manifest.json lists no files" >&2; exit 1; }

ASSET_PATTERNS=()
while IFS=$'\t' read -r name _sha256 _size; do
  ASSET_PATTERNS+=("-p" "${name}")
done <<< "${FILE_ROWS}"

echo "==> Downloading $(( ${#ASSET_PATTERNS[@]} / 2 )) firmware asset(s) into staging"
gh release download "${TAG}" -R "${UPSTREAM_REPO}" -D "${STAGING}" "${ASSET_PATTERNS[@]}"

echo "==> Verifying sha256 against manifest.json (staging, existing mirror untouched so far)"
FAILED=0
COUNT=0
TOTAL_BYTES=0
while IFS=$'\t' read -r name sha256 size; do
  path="${STAGING}/${name}"
  if [[ ! -f "${path}" ]]; then
    echo "  MISSING: ${name}" >&2
    FAILED=1
    continue
  fi
  actual="$(sha256sum "${path}" | cut -d' ' -f1)"
  if [[ "${actual}" != "${sha256}" ]]; then
    echo "  MISMATCH: ${name} (expected ${sha256}, got ${actual})" >&2
    FAILED=1
    continue
  fi
  COUNT=$((COUNT + 1))
  TOTAL_BYTES=$((TOTAL_BYTES + size))
  echo "  OK: ${name} (${size} bytes)"
done <<< "${FILE_ROWS}"

if [[ "${FAILED}" -ne 0 ]]; then
  echo "==> FAILED: sha256 verification failed for one or more files; ${DEST_DIR} was NOT touched (existing mirror, if any, is left intact)." >&2
  exit 1
fi

echo "==> Verification passed; replacing ${DEST_DIR} with the staged, verified set"
[[ "${DEST_DIR}" == */public/firmware ]] || { echo "error: refusing to touch DEST_DIR=${DEST_DIR} (must end in public/firmware)" >&2; exit 1; }
mkdir -p "${DEST_DIR}"
find "${DEST_DIR}" -mindepth 1 ! -name '.gitkeep' -exec rm -rf {} +
cp "${STAGING}"/* "${DEST_DIR}/"

echo "==> OK: ${TAG} mirrored — ${COUNT} file(s), $((TOTAL_BYTES / 1024)) KiB total, manifest.json + assets written to ${DEST_DIR}"
