#!/usr/bin/env node
/**
 * generate-firmware-manifest.mjs — build public/firmware/ (manifest.json +
 * firmware assets) directly from novaX-ALUX/flight_controller's GitHub
 * Releases, which are tagged per board (`<board>-v<semver>`, e.g.
 * `AF-H7_nano-v1.2.3`) and carry no manifest.json of their own.
 *
 * Replaces scripts/sync-firmware.sh's single-tag model for CI use: upstream
 * moved to per-board release tags (2026-07), so the manifest is assembled
 * here, configurator-side, from the newest release of every board.
 *
 * Same-origin mirror policy per docs/notes/decisions-m1.md decisions 4/5
 * (LOCKED): the browser never fetches release assets cross-origin; this
 * script runs at deploy/build time and populates the mirror the app serves.
 *
 * Copter-only per docs/feature-status.md scope premise: assets suffixed for
 * other vehicles (e.g. `-Plane`) are skipped.
 *
 * Field policy (matches src/core/firmware/__tests__/fixtures/manifest.json
 * and docs/feature-status.md §I Firmware):
 *   - mcuFamily: parsed from the board name (F4/F7/H7)
 *   - softwareDfuAllowed: F4 only (software-triggered DFU entry is F4-only)
 *   - dfuRecoveryAllowed: true for all boards (WebUSB STM32 DFU rescue)
 *   - apjBoardId / hwdefBoardId: read from the .apj's own board_id field
 *   - gitHash: the .apj's git_identity when present, else "unknown"
 *
 * Requires: gh CLI authenticated with read access to the (public) upstream
 * repo. In GitHub Actions, `GH_TOKEN: ${{ github.token }}` suffices.
 *
 * Usage: node tools/generate-firmware-manifest.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const UPSTREAM_REPO = 'novaX-ALUX/flight_controller'
const TAG_PATTERN = /^(?<board>AF-[A-Za-z0-9_]+)-v(?<version>\d+\.\d+\.\d+)$/
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST_DIR = join(REPO_ROOT, 'public', 'firmware')

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileKind(name) {
  if (name.endsWith('.apj')) return 'apj'
  if (name.endsWith('_with_bl.hex')) return 'with_bl_hex'
  return 'other'
}

function mcuFamily(boardName) {
  const m = boardName.match(/(F4|F7|H7)/)
  if (!m) throw new Error(`cannot derive MCU family from board name ${boardName}`)
  return m[1]
}

// Newest release per board: `gh release list` returns newest-first, so the
// first tag seen for a board wins.
const releases = JSON.parse(gh('release', 'list', '--repo', UPSTREAM_REPO, '--limit', '100', '--json', 'tagName'))
const latestByBoard = new Map()
for (const { tagName } of releases) {
  const m = tagName.match(TAG_PATTERN)
  if (!m) continue // legacy tags (v0.2.9, "AF-F7 Mini v0.2.4") predate the per-board scheme
  if (!latestByBoard.has(m.groups.board)) latestByBoard.set(m.groups.board, { tag: tagName, version: m.groups.version })
}
if (latestByBoard.size === 0) throw new Error('no per-board release tags found upstream')

const staging = mkdtempSync(join(tmpdir(), 'fw-manifest-'))
const boards = []
try {
  for (const [boardName, { tag, version }] of [...latestByBoard.entries()].sort()) {
    const assets = JSON.parse(gh('release', 'view', tag, '--repo', UPSTREAM_REPO, '--json', 'assets'))
      .assets.filter((a) => !/-(Plane|Rover|Sub|Heli|Tracker)[._-]/i.test(a.name))
    if (!assets.some((a) => a.name.endsWith('.apj'))) {
      console.warn(`skip ${tag}: no Copter .apj asset`)
      continue
    }
    const dir = join(staging, boardName)
    mkdirSync(dir)
    gh('release', 'download', tag, '--repo', UPSTREAM_REPO, '--dir', dir, ...assets.flatMap((a) => ['-p', a.name]))

    const apjName = assets.find((a) => a.name.endsWith('.apj')).name
    const apj = JSON.parse(readFileSync(join(dir, apjName), 'utf8'))
    if (typeof apj.board_id !== 'number') throw new Error(`${apjName}: missing numeric board_id`)
    // Sanity: the .apj must actually decompress (same integrity bar sync-firmware.sh set with sha256).
    inflateSync(Buffer.from(apj.image, 'base64'))

    boards.push({
      boardName,
      apjBoardId: apj.board_id,
      hwdefBoardId: apj.board_id,
      mcuFamily: mcuFamily(boardName),
      vehicle: 'copter',
      version,
      gitHash: typeof apj.git_identity === 'string' ? apj.git_identity : 'unknown',
      method: 'ardupilot',
      softwareDfuAllowed: mcuFamily(boardName) === 'F4',
      dfuRecoveryAllowed: true,
      files: assets.map((a) => ({
        kind: fileKind(a.name),
        name: a.name,
        url: a.url ?? `https://github.com/${UPSTREAM_REPO}/releases/download/${tag}/${a.name}`,
        sha256: sha256(join(dir, a.name)),
        size: statSync(join(dir, a.name)).size,
      })),
    })
    console.log(`ok ${boardName} ${version} (${assets.length} files)`)
  }

  const manifest = {
    schemaVersion: 1,
    tag: `per-board-latest@${new Date().toISOString().slice(0, 10)}`,
    generatedFrom: 'releases',
    boards,
  }

  mkdirSync(DEST_DIR, { recursive: true })
  for (const entry of readdirSync(DEST_DIR)) {
    if (entry !== '.gitkeep') rmSync(join(DEST_DIR, entry), { recursive: true })
  }
  for (const boardName of [...latestByBoard.keys()]) {
    const dir = join(staging, boardName)
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) copyFileSync(join(dir, name), join(DEST_DIR, name))
  }
  writeFileSync(join(DEST_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`wrote manifest.json with ${boards.length} board(s) into public/firmware/`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
