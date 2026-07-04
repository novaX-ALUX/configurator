/**
 * ArduPilot `.apj` parser + a WebCrypto sha256 verify helper.
 *
 * An `.apj` is JSON: `{ board_id, image_size, image, ... }`, where `image` is
 * base64(zlib(raw app binary)). `board_id` is read straight off the parsed
 * JSON, before the (async) decompression step, matching
 * `flight_controller/scripts/gen_manifest.py`'s own note that "board_id
 * lives outside the base64+zlib `image` blob" — decompression failing never
 * hides which board this file was for.
 *
 * Rewrite of `marketing/parts-catalog/src/scripts/update/apj.ts`, adapted to
 * take the file's raw `ArrayBuffer` (this project fetches firmware bytes via
 * `arrayBuffer()`, see `manifest.ts`) rather than pre-decoded text, and to
 * make `boardId` a required field: `Px4Flasher.flash()`'s board-ID guard is
 * unconditional in this rewrite (see px4bl.ts), so a `.apj` with no/invalid
 * `board_id` is a parse error here rather than a flash-time "skip the
 * guard" fallback.
 */

export interface ParsedApj {
  boardId: number
  /** Decompressed application image bytes. */
  image: Uint8Array
  /** `image.length` (the actual decompressed size, not the JSON's self-reported `image_size`). */
  imageSize: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reads a `ReadableStream<Uint8Array>` to completion and concatenates its chunks. (Deliberately not `new Response(stream).arrayBuffer()`: jsdom's `Blob` has no `.stream()`, and this avoids depending on the Fetch API for what is otherwise a pure-stream operation.) */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** ArduPilot compresses `image` with zlib (RFC 1950, magic 0x78); gzip (magic 0x1f 0x8b) is also accepted for fidelity with the reference parser. Picked by magic byte, not a fixed format. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const format = data[0] === 0x1f && data[1] === 0x8b ? 'gzip' : 'deflate'
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
  // Cast needed: lib.dom's DecompressionStream/CompressionStream types don't line up cleanly
  // with TypeScript 5.7+'s generic `Uint8Array<TArrayBuffer>` — a known lib.dom typing
  // friction (pipeThrough's inferred pair type vs GenericTransformStream's `BufferSource`
  // writable side), not a real type-safety issue: both sides are plain `Uint8Array` at runtime.
  return readAll(input.pipeThrough(new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>))
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function parseApj(buf: ArrayBuffer): Promise<ParsedApj> {
  const text = new TextDecoder().decode(buf)

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new Error(`.apj parse error: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  if (!isRecord(json)) throw new Error('.apj format error: expected a JSON object')

  const boardId = json.board_id
  if (typeof boardId !== 'number') throw new Error('.apj format error: missing or non-numeric board_id field')

  const imageField = json.image
  if (typeof imageField !== 'string') throw new Error('.apj format error: missing image field')

  const compressed = base64Decode(imageField)
  const image = await inflate(compressed)
  if (image.length === 0) {
    // A blank image erasing a chip and then "verifying" empty is exactly the class of
    // accident the flashers' guards exist to prevent — reject it here, before it ever
    // reaches a flasher, rather than relying on every flasher to separately notice.
    throw new Error('.apj format error: image decompressed to 0 bytes')
  }

  return { boardId, image, imageSize: image.length }
}

/** Lowercase-hex sha256 of `bytes` via WebCrypto, compared case-insensitively against `expectedHex`. Used by the update page (task 3.4) after downloading a firmware file and before handing it to a flasher. */
export async function verifyImageSha256(bytes: Uint8Array, expectedHex: string): Promise<boolean> {
  // Cast needed for the same lib.dom `Uint8Array<TArrayBuffer>` generic friction as `inflate()`.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return hex === expectedHex.toLowerCase()
}
