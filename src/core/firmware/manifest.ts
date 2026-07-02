/**
 * Configurator-side consumer contract for the firmware manifest emitted by
 * flight_controller's `scripts/gen_manifest.py` (schemaVersion 1).
 *
 * URL policy (docs/notes/decisions-m1.md decisions 4/5, LOCKED): the manifest
 * and every firmware file it lists are mirrored same-origin under
 * `${BASE_URL}firmware/`. This module never fetches bytes from
 * github.com/.../releases/download/... — `files[].url` in the parsed
 * manifest is kept only for provenance and MUST NOT be used to fetch bytes;
 * use `firmwareFileUrl()` instead.
 */

export type FirmwareFileKind = 'apj' | 'other' | 'with_bl_hex'

export interface FirmwareFile {
  kind: FirmwareFileKind
  name: string
  /** Upstream GitHub Releases URL, for provenance only. Never fetch this directly (see module doc). */
  url: string
  sha256: string
  size: number
}

export interface BoardFirmware {
  boardName: string
  apjBoardId: number
  hwdefBoardId: number
  mcuFamily: string
  vehicle: string
  version: string
  gitHash: string
  method: string
  softwareDfuAllowed: boolean
  dfuRecoveryAllowed: boolean
  files: FirmwareFile[]
}

export interface FirmwareManifest {
  schemaVersion: 1
  tag: string
  generatedFrom: string
  boards: BoardFirmware[]
}

export type ManifestErrorReason = 'network' | 'http' | 'schema'

export class ManifestError extends Error {
  readonly reason: ManifestErrorReason

  constructor(reason: ManifestErrorReason, message: string) {
    super(message)
    this.name = 'ManifestError'
    this.reason = reason
  }
}

function schemaFail(path: string, detail: string): never {
  throw new ManifestError('schema', `manifest${path}: ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') schemaFail(path, `expected string, got ${typeof value}`)
  return value
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number') schemaFail(path, `expected number, got ${typeof value}`)
  return value
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') schemaFail(path, `expected boolean, got ${typeof value}`)
  return value
}

const FILE_KINDS: readonly FirmwareFileKind[] = ['apj', 'other', 'with_bl_hex']

function parseFile(value: unknown, path: string): FirmwareFile {
  if (!isRecord(value)) schemaFail(path, 'expected object')
  const kind = expectString(value.kind, `${path}.kind`)
  if (!FILE_KINDS.includes(kind as FirmwareFileKind)) {
    schemaFail(`${path}.kind`, `expected one of ${FILE_KINDS.join('|')}, got ${JSON.stringify(kind)}`)
  }
  return {
    kind: kind as FirmwareFileKind,
    name: expectString(value.name, `${path}.name`),
    url: expectString(value.url, `${path}.url`),
    sha256: expectString(value.sha256, `${path}.sha256`),
    size: expectNumber(value.size, `${path}.size`),
  }
}

function parseBoard(value: unknown, path: string): BoardFirmware {
  if (!isRecord(value)) schemaFail(path, 'expected object')
  const filesRaw = value.files
  if (!Array.isArray(filesRaw)) schemaFail(`${path}.files`, 'expected array')
  return {
    boardName: expectString(value.boardName, `${path}.boardName`),
    apjBoardId: expectNumber(value.apjBoardId, `${path}.apjBoardId`),
    hwdefBoardId: expectNumber(value.hwdefBoardId, `${path}.hwdefBoardId`),
    mcuFamily: expectString(value.mcuFamily, `${path}.mcuFamily`),
    vehicle: expectString(value.vehicle, `${path}.vehicle`),
    version: expectString(value.version, `${path}.version`),
    gitHash: expectString(value.gitHash, `${path}.gitHash`),
    method: expectString(value.method, `${path}.method`),
    softwareDfuAllowed: expectBoolean(value.softwareDfuAllowed, `${path}.softwareDfuAllowed`),
    dfuRecoveryAllowed: expectBoolean(value.dfuRecoveryAllowed, `${path}.dfuRecoveryAllowed`),
    files: filesRaw.map((f, i) => parseFile(f, `${path}.files[${i}]`)),
  }
}

/** Structural validation of an arbitrary JSON value into a `FirmwareManifest`, hand-rolled (no schema library). */
export function parseManifest(json: unknown): FirmwareManifest {
  if (!isRecord(json)) schemaFail('', 'expected an object')
  const schemaVersion = json.schemaVersion
  if (schemaVersion !== 1) schemaFail('.schemaVersion', `expected 1, got ${JSON.stringify(schemaVersion)}`)
  const boardsRaw = json.boards
  if (!Array.isArray(boardsRaw)) schemaFail('.boards', 'expected array')
  return {
    schemaVersion: 1,
    tag: expectString(json.tag, '.tag'),
    generatedFrom: expectString(json.generatedFrom, '.generatedFrom'),
    boards: boardsRaw.map((b, i) => parseBoard(b, `.boards[${i}]`)),
  }
}

/**
 * Fetches the manifest from this site's own same-origin mirror
 * (`${BASE_URL}firmware/manifest.json`, decisions-m1.md decision 5). Never
 * a GitHub URL. `reason` on a thrown `ManifestError` distinguishes network
 * failure, non-2xx HTTP status, and schema violations so the UI can offer a
 * local-file fallback.
 */
export async function fetchManifest(fetchFn: typeof fetch = fetch): Promise<FirmwareManifest> {
  const url = `${import.meta.env.BASE_URL}firmware/manifest.json`

  let response: Response
  try {
    response = await fetchFn(url, { cache: 'no-cache' })
  } catch (err) {
    throw new ManifestError('network', `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) {
    throw new ManifestError('http', `GET ${url} returned HTTP ${response.status}`)
  }

  let json: unknown
  try {
    json = await response.json()
  } catch (err) {
    throw new ManifestError('schema', `GET ${url} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  return parseManifest(json)
}

/** Boards whose bootloader-reported apjBoardId exactly matches (no fuzzy matching). */
export function matchBoards(manifest: FirmwareManifest, bootloaderBoardId: number): BoardFirmware[] {
  return manifest.boards.filter((board) => board.apjBoardId === bootloaderBoardId)
}

/** Same-origin mirror path for a firmware file's bytes. Never `file.url` (see module doc). */
export function firmwareFileUrl(file: FirmwareFile): string {
  return `${import.meta.env.BASE_URL}firmware/${file.name}`
}
