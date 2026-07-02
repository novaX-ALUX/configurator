import { describe, expect, it } from 'vitest'
import { CRC_INIT, crcAccumulate, crcCalculate } from '../crc'

describe('crcAccumulate', () => {
  it('matches the reference MAVLink CRC-16/MCRF4XX step function', () => {
    // Reference values from the MAVLink C `crc_accumulate()` implementation
    // (checksum.h), starting from CRC_INIT_VALUE = 0xffff, accumulating a
    // single 0x00 byte.
    expect(crcAccumulate(0x00, CRC_INIT)).toBe(0x0f87)
  })
})

describe('crcCalculate', () => {
  it('reproduces the CRC of a known MAVLink2 HEARTBEAT frame from pymavlink', () => {
    // fd 09 00 00 00 01 01 00 00 00 | 00 00 00 00 06 08 00 00 03 | 6b e3
    // magic  len iF cF seq sys cmp  msgid(3)      payload(9)      crc(2,LE)
    // Captured via pymavlink (mavlink2.MAVLink.heartbeat_encode), srcSystem=1,
    // srcComponent=1, seq=0, HEARTBEAT crc_extra=50.
    const bytes = Uint8Array.from(
      Buffer.from('fd0900000001010000000000000006080000036be3', 'hex'),
    )
    // CRC is computed over len..payload (i.e. bytes[1..19)), magic excluded,
    // plus the CRC_EXTRA byte (50 for HEARTBEAT) folded in afterwards.
    const crc = crcCalculate(bytes, 1, 19, 50)
    const expected = bytes[19] | (bytes[20] << 8)
    expect(crc).toBe(expected)
    expect(crc).toBe(0xe36b)
  })

  it('reproduces the CRC of a known MAVLink1 HEARTBEAT frame from pymavlink', () => {
    // fe 09 05 01 01 00 00 00 00 00 06 08 00 00 03 | a2 ad
    const bytes = Uint8Array.from(
      Buffer.from('fe0905010100000000000608000003a2ad', 'hex'),
    )
    const crc = crcCalculate(bytes, 1, 15, 50)
    const expected = bytes[15] | (bytes[16] << 8)
    expect(crc).toBe(expected)
  })
})
