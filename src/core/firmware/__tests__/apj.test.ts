import { describe, expect, it } from 'vitest'
import { parseApj, verifyImageSha256 } from '../apj'

async function deflate(bytes: Uint8Array, format: 'deflate' | 'gzip' = 'deflate'): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  // Cast needed: lib.dom's CompressionStream type doesn't line up cleanly with TypeScript
  // 5.7+'s generic `Uint8Array<TArrayBuffer>` (same known friction as apj.ts's `inflate()`).
  const reader = input.pipeThrough(new CompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader()
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

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

async function buildApj(
  overrides: Record<string, unknown> = {},
  imageBytes = new Uint8Array([1, 2, 3, 4, 5]),
  format: 'deflate' | 'gzip' = 'deflate',
): Promise<ArrayBuffer> {
  const compressed = await deflate(imageBytes, format)
  const json = {
    board_id: 6203,
    image_size: imageBytes.length,
    image: base64Encode(compressed),
    ...overrides,
  }
  return new TextEncoder().encode(JSON.stringify(json)).buffer
}

describe('parseApj', () => {
  it('reads board_id and decompresses a zlib-deflate image', async () => {
    const imageBytes = new Uint8Array([10, 20, 30, 40, 50, 60])
    const buf = await buildApj({}, imageBytes)

    const parsed = await parseApj(buf)

    expect(parsed.boardId).toBe(6203)
    expect(parsed.image).toEqual(imageBytes)
    expect(parsed.imageSize).toBe(imageBytes.length)
  })

  it('also decompresses a gzip-magic image (fidelity with the reference parser)', async () => {
    const imageBytes = new Uint8Array([7, 8, 9])
    const buf = await buildApj({}, imageBytes, 'gzip')

    const parsed = await parseApj(buf)

    expect(parsed.image).toEqual(imageBytes)
  })

  it('throws on invalid JSON', async () => {
    const buf = new TextEncoder().encode('{ not json').buffer
    await expect(parseApj(buf)).rejects.toThrow(/invalid JSON/i)
  })

  it('throws when board_id is missing', async () => {
    const buf = await buildApj({ board_id: undefined })
    await expect(parseApj(buf)).rejects.toThrow(/board_id/i)
  })

  it('throws when board_id is not a number', async () => {
    const buf = await buildApj({ board_id: '6203' })
    await expect(parseApj(buf)).rejects.toThrow(/board_id/i)
  })

  it('throws when the image field is missing', async () => {
    const buf = await buildApj({ image: undefined })
    await expect(parseApj(buf)).rejects.toThrow(/image/i)
  })

  it('throws when the image decompresses to 0 bytes', async () => {
    const buf = await buildApj({}, new Uint8Array(0))
    await expect(parseApj(buf)).rejects.toThrow(/0 bytes/i)
  })
})

describe('verifyImageSha256', () => {
  it('matches a known sha256 digest, case-insensitively', async () => {
    const bytes = new TextEncoder().encode('hello world')
    // sha256("hello world"), computed independently via Python's hashlib for this test.
    const expected = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    await expect(verifyImageSha256(bytes, expected)).resolves.toBe(true)
    await expect(verifyImageSha256(bytes, expected.toUpperCase())).resolves.toBe(true)
  })

  it('returns false for a mismatched digest', async () => {
    const bytes = new TextEncoder().encode('hello world')
    await expect(verifyImageSha256(bytes, '0'.repeat(64))).resolves.toBe(false)
  })
})
