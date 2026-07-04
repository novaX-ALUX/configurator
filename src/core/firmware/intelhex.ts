/**
 * Intel HEX parser -> absolute-addressed, merged binary segments. Used by
 * the DFU engine (`dfu.ts`) to flash a `*_with_bl.hex` (bootloader + app)
 * image to absolute flash addresses.
 *
 * Record types handled: 00 (data), 01 (EOF, stops parsing), 02/04 (segment /
 * linear extended address, shifts the upper address bits for subsequent 00
 * records), 03/05 (start segment/linear address — CPU reset-vector hints,
 * not a flash address; intentionally ignored, matching the reference
 * `marketing/parts-catalog` parser this rewrites). Every record's checksum
 * is validated; a mismatch throws rather than silently flashing corrupt
 * data — this feeds a destructive DFU write.
 */

export interface HexSegment {
  addr: number
  data: Uint8Array
}

export interface ParsedHex {
  /** Merged, sorted, gap-free runs (adjacent data records with no address gap are combined into one run). */
  segments: HexSegment[]
  minAddress: number
  /** Exclusive end of the highest segment. */
  maxAddress: number
  totalBytes: number
}

function hexByte(line: string, offset: number): number {
  return parseInt(line.substr(offset, 2), 16)
}

export function parseIntelHex(text: string): ParsedHex {
  const raw: HexSegment[] = []
  let upper = 0 // upper 16 bits of the address, set by a type 02/04 record; 0 until one appears

  const lines = text.split(/\r?\n/)
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo].trim()
    if (!line || line[0] !== ':') continue

    const len = hexByte(line, 1)
    const offset = (hexByte(line, 3) << 8) | hexByte(line, 5)
    const type = hexByte(line, 7)

    let sum = 0
    for (let i = 1; i < 9 + len * 2; i += 2) sum = (sum + hexByte(line, i)) & 0xff
    if (((sum + hexByte(line, 9 + len * 2)) & 0xff) !== 0) {
      throw new Error(`Intel HEX checksum error at line ${lineNo + 1}`)
    }

    if (type === 0x00) {
      const data = new Uint8Array(len)
      for (let i = 0; i < len; i++) data[i] = hexByte(line, 9 + i * 2)
      raw.push({ addr: (upper + offset) >>> 0, data })
    } else if (type === 0x01) {
      break // EOF — anything after is not part of the image
    } else if (type === 0x04) {
      upper = ((hexByte(line, 9) << 8) | hexByte(line, 11)) * 0x10000
    } else if (type === 0x02) {
      upper = ((hexByte(line, 9) << 8) | hexByte(line, 11)) * 16
    }
    // 0x03 / 0x05 (start segment/linear address) intentionally ignored — not a flash address.
  }

  if (raw.length === 0) throw new Error('No data records found in HEX file')

  raw.sort((a, b) => a.addr - b.addr)
  const segments: HexSegment[] = []
  for (const seg of raw) {
    const last = segments[segments.length - 1]
    if (last && seg.addr === last.addr + last.data.length) {
      const merged = new Uint8Array(last.data.length + seg.data.length)
      merged.set(last.data, 0)
      merged.set(seg.data, last.data.length)
      last.data = merged
    } else {
      segments.push({ addr: seg.addr, data: new Uint8Array(seg.data) })
    }
  }

  const minAddress = segments[0].addr
  const lastSeg = segments[segments.length - 1]
  const maxAddress = lastSeg.addr + lastSeg.data.length
  const totalBytes = segments.reduce((n, s) => n + s.data.length, 0)

  return { segments, minAddress, maxAddress, totalBytes }
}
