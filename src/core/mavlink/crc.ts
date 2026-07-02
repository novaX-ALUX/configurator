/**
 * MAVLink's checksum: CRC-16/MCRF4XX (a.k.a. "X.25"), as specified by the
 * reference C implementation (`checksum.h`). Initial value `0xffff`, no
 * final XOR/reflection beyond what the step function itself does.
 *
 * A frame's CRC covers the header *excluding the magic byte* through the
 * end of the (wire, i.e. possibly trailing-zero-truncated) payload, with
 * one extra byte — the message's CRC_EXTRA, derived from its field layout
 * (see `defs.ts`) — folded in afterwards. This lets a receiver detect
 * payloads decoded against the wrong dialect/field-table even when the
 * bytes themselves are otherwise well-formed.
 */

export const CRC_INIT = 0xffff

/** One step of the CRC-16/MCRF4XX algorithm. */
export function crcAccumulate(data: number, crcAccum: number): number {
  let tmp = (data ^ (crcAccum & 0xff)) & 0xff
  tmp = (tmp ^ (tmp << 4)) & 0xff
  return ((crcAccum >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
}

/**
 * CRC over `bytes[start, end)`, optionally folding in a trailing
 * `crcExtra` byte (the MAVLink CRC_EXTRA step every frame CRC needs).
 */
export function crcCalculate(bytes: Uint8Array, start = 0, end = bytes.length, crcExtra?: number): number {
  let crc = CRC_INIT
  for (let i = start; i < end; i++) crc = crcAccumulate(bytes[i], crc)
  if (crcExtra !== undefined) crc = crcAccumulate(crcExtra, crc)
  return crc
}
