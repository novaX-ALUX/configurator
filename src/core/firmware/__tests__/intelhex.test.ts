import { describe, expect, it } from 'vitest'
import { parseIntelHex } from '../intelhex'

/** Builds one Intel HEX data record (type 00) with a correct checksum. */
function dataRecord(addr: number, bytes: number[]): string {
  const len = bytes.length
  const fields = [len, (addr >> 8) & 0xff, addr & 0xff, 0x00, ...bytes]
  let sum = 0
  for (const b of fields) sum = (sum + b) & 0xff
  const checksum = (0x100 - sum) & 0xff
  return ':' + [...fields, checksum].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function extLinearAddrRecord(upper16: number): string {
  const fields = [0x02, 0x00, 0x00, 0x04, (upper16 >> 8) & 0xff, upper16 & 0xff]
  let sum = 0
  for (const b of fields) sum = (sum + b) & 0xff
  const checksum = (0x100 - sum) & 0xff
  return ':' + [...fields, checksum].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

const EOF_RECORD = ':00000001FF'

describe('parseIntelHex', () => {
  it('parses a single data record', () => {
    const text = [dataRecord(0x0000, [0xde, 0xad, 0xbe, 0xef]), EOF_RECORD].join('\n')
    const hex = parseIntelHex(text)
    expect(hex.segments).toHaveLength(1)
    expect(hex.segments[0].addr).toBe(0)
    expect(hex.segments[0].data).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    expect(hex.minAddress).toBe(0)
    expect(hex.maxAddress).toBe(4)
    expect(hex.totalBytes).toBe(4)
  })

  it('merges contiguous data records into one segment', () => {
    const text = [
      dataRecord(0x0000, [1, 2]),
      dataRecord(0x0002, [3, 4]),
      EOF_RECORD,
    ].join('\n')
    const hex = parseIntelHex(text)
    expect(hex.segments).toHaveLength(1)
    expect(hex.segments[0].data).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('keeps non-contiguous records as separate, sorted segments', () => {
    const text = [
      dataRecord(0x0010, [9, 9]), // written out of order
      dataRecord(0x0000, [1, 2]),
      EOF_RECORD,
    ].join('\n')
    const hex = parseIntelHex(text)
    expect(hex.segments).toHaveLength(2)
    expect(hex.segments[0].addr).toBe(0x0000)
    expect(hex.segments[1].addr).toBe(0x0010)
    expect(hex.minAddress).toBe(0x0000)
    expect(hex.maxAddress).toBe(0x0012)
  })

  it('applies a type 04 (extended linear address) record to subsequent data records', () => {
    const text = [
      extLinearAddrRecord(0x0800), // upper bits -> base 0x08000000
      dataRecord(0x0000, [1, 2, 3, 4]),
      EOF_RECORD,
    ].join('\n')
    const hex = parseIntelHex(text)
    expect(hex.segments[0].addr).toBe(0x08000000)
  })

  it('ignores a type 05 (start linear address) record — it is not a flash address', () => {
    const startLinearAddrRecord = ':0400000508000001EE' // start addr 0x08000001, correct checksum
    const text = [
      dataRecord(0x0000, [1, 2]),
      startLinearAddrRecord,
      EOF_RECORD,
    ].join('\n')
    const hex = parseIntelHex(text)
    expect(hex.segments).toHaveLength(1)
    expect(hex.segments[0].addr).toBe(0)
    expect(hex.totalBytes).toBe(2)
  })

  it('stops parsing at a type 01 (EOF) record', () => {
    const text = [
      dataRecord(0x0000, [1, 2]),
      EOF_RECORD,
      dataRecord(0x0100, [9, 9]), // after EOF — must be ignored
    ].join('\n')
    const hex = parseIntelHex(text)
    expect(hex.segments).toHaveLength(1)
    expect(hex.totalBytes).toBe(2)
  })

  it('throws on a checksum error', () => {
    const bad = dataRecord(0x0000, [1, 2]).slice(0, -2) + 'FF' // corrupt the checksum byte
    expect(() => parseIntelHex([bad, EOF_RECORD].join('\n'))).toThrow(/checksum/i)
  })

  it('throws when there are no data records', () => {
    expect(() => parseIntelHex(EOF_RECORD)).toThrow(/no data records/i)
  })
})
