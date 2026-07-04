import { describe, expect, it } from 'vitest'
import { defs } from '../defs'
import { encodeFrame, FrameParser, type MavFrame } from '../frame'

const HEARTBEAT_MSGID = 0
const ATTITUDE_MSGID = 30

function heartbeatPayload(): Uint8Array {
  // custom_mode(u32)=0, type=6, autopilot=8, base_mode=0, system_status=0, mavlink_version=3
  return Uint8Array.from([0, 0, 0, 0, 6, 8, 0, 0, 3])
}

describe('encodeFrame', () => {
  it('encodes a MAVLink2 frame matching a known pymavlink HEARTBEAT capture byte-for-byte', () => {
    // fd 09 00 00 00 01 01 00 00 00 | 00 00 00 00 06 08 00 00 03 | 6b e3
    const expected = Uint8Array.from(
      Buffer.from('fd0900000001010000000000000006080000036be3', 'hex'),
    )
    const frame = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 0, 1, 1)
    expect(Buffer.from(frame).toString('hex')).toBe(Buffer.from(expected).toString('hex'))
  })

  it('truncates trailing zero bytes but never below 1 byte', () => {
    const allZero = new Uint8Array(9) // HEARTBEAT-sized, all zero
    const frame = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: allZero }, 0, 1, 1)
    expect(frame[1]).toBe(1) // len byte: truncated to 1, not 0
    expect(frame.length).toBe(10 + 1 + 2) // header + 1-byte payload + crc
  })

  it('does not truncate a payload with no trailing zeros', () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const frame = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload }, 0, 1, 1)
    expect(frame[1]).toBe(9)
  })

  it('throws for an unknown msgid (no CRC_EXTRA available)', () => {
    expect(() => encodeFrame(defs, { msgid: 0xfffff, payload: heartbeatPayload() }, 0, 1, 1)).toThrow()
  })

  it('always emits incompat/compat flags 0 and MAVLink2 magic', () => {
    const frame = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 7, 42, 99)
    expect(frame[0]).toBe(0xfd)
    expect(frame[2]).toBe(0) // incompat flags
    expect(frame[3]).toBe(0) // compat flags
    expect(frame[4]).toBe(7) // seq
    expect(frame[5]).toBe(42) // sysid
    expect(frame[6]).toBe(99) // compid
  })
})

describe('FrameParser: round trip', () => {
  it('parses a single encodeFrame()-produced HEARTBEAT frame back losslessly', () => {
    const encoded = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 5, 1, 1)
    const parser = new FrameParser(defs)
    const frames = parser.push(encoded)

    expect(frames).toHaveLength(1)
    const frame = frames[0]
    expect(frame.version).toBe(2)
    expect(frame.msgid).toBe(HEARTBEAT_MSGID)
    expect(frame.seq).toBe(5)
    expect(frame.sysid).toBe(1)
    expect(frame.compid).toBe(1)
    expect(frame.incompatFlags).toBe(0)
    expect(frame.signed).toBe(false)
    // payload comes back raw/truncated, not zero-extended (frame layer doesn't pad).
    expect(Array.from(frame.payload)).toEqual([0, 0, 0, 0, 6, 8, 0, 0, 3])
    expect(parser.stats).toEqual({ received: 1, crcErrors: 0, badMsgId: 0, dropped: 0 })
  })

  it('does not truncate the first payload byte even when it is zero', () => {
    // ATTITUDE's first field (time_boot_ms) = 0, rest nonzero -> payload must
    // keep its full leading zero(s); only *trailing* zeros are truncatable,
    // so make the last field (yawspeed, offset 24) nonzero to prevent any
    // truncation from happening at all.
    const payload = new Uint8Array(28) // ATTITUDE payload length
    const view = new DataView(payload.buffer)
    view.setUint32(0, 0, true) // time_boot_ms = 0 (leading, must survive)
    view.setFloat32(24, 1.5, true) // yawspeed (last field), nonzero
    const encoded = encodeFrame(defs, { msgid: ATTITUDE_MSGID, payload }, 0, 1, 1)
    const parser = new FrameParser(defs)
    const [frame] = parser.push(encoded)
    expect(frame.payload.length).toBe(28)
    expect(frame.payload[0]).toBe(0)
    expect(frame.payload[1]).toBe(0)
    expect(frame.payload[2]).toBe(0)
    expect(frame.payload[3]).toBe(0)
  })

  it('parses multiple frames delivered in a single push()', () => {
    const encoded1 = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 0, 1, 1)
    const encoded2 = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 1, 1, 1)
    const combined = new Uint8Array(encoded1.length + encoded2.length)
    combined.set(encoded1, 0)
    combined.set(encoded2, encoded1.length)

    const parser = new FrameParser(defs)
    const frames = parser.push(combined)
    expect(frames).toHaveLength(2)
    expect(frames.map((f) => f.seq)).toEqual([0, 1])
  })

  it('parses a frame split across multiple push() calls (fragmented header and payload)', () => {
    const encoded = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 3, 1, 1)
    const parser = new FrameParser(defs)

    const first = parser.push(encoded.subarray(0, 5)) // partial header
    expect(first).toHaveLength(0)
    const second = parser.push(encoded.subarray(5, 12)) // rest of header + partial payload
    expect(second).toHaveLength(0)
    const third = parser.push(encoded.subarray(12)) // rest of payload + crc
    expect(third).toHaveLength(1)
    expect(third[0].seq).toBe(3)
  })

  it('does not corrupt a retained partial frame when the caller reuses/overwrites its read buffer after push() returns', () => {
    // Regression test: a fixed-buffer read loop (e.g. `port.read(sharedBuf)`)
    // hands push() a *view* onto a buffer it intends to immediately reuse for
    // the next read. If FrameParser retains that exact memory (rather than a
    // copy) across calls, the caller's next read silently corrupts the
    // buffered partial frame. Reproduces the reviewer's exact scenario: a
    // 5-byte partial header delivered from a shared, subsequently-overwritten
    // buffer, followed by the remainder from an unrelated buffer.
    const encoded = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 3, 1, 1)
    const parser = new FrameParser(defs)

    const shared = new Uint8Array(5)
    shared.set(encoded.subarray(0, 5))
    const first = parser.push(shared) // FrameParser must not retain `shared` itself
    expect(first).toHaveLength(0)

    shared.fill(0xee) // caller reuses/overwrites its read buffer, as a real read loop would

    const rest = parser.push(encoded.subarray(5)) // delivered from an unrelated buffer
    expect(rest).toHaveLength(1)
    expect(rest[0].seq).toBe(3)
    expect(Array.from(rest[0].payload)).toEqual([0, 0, 0, 0, 6, 8, 0, 0, 3])
  })
})

describe('FrameParser: resync and error accounting', () => {
  it('drops a frame with an unknown msgid, counts badMsgId+dropped, and still parses the next good frame', () => {
    // encodeFrame refuses unknown msgids (it needs a CRC_EXTRA to compute the
    // CRC), so hand-craft a frame whose header claims a msgid that defs.ts
    // cannot resolve (some huge value outside any dialect), with a
    // plausible-looking but irrelevant CRC.
    const unresolvableMsgid = 0xabcdef
    const header = Uint8Array.from([
      0xfd, 1, 0, 0, 0, 1, 1,
      unresolvableMsgid & 0xff, (unresolvableMsgid >> 8) & 0xff, (unresolvableMsgid >> 16) & 0xff,
    ])
    const badFrame = new Uint8Array([...header, 0x42, 0x00, 0x00]) // 1-byte payload + fake crc
    const goodFrame = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 9, 1, 1)

    const combined = new Uint8Array(badFrame.length + goodFrame.length)
    combined.set(badFrame, 0)
    combined.set(goodFrame, badFrame.length)

    const parser = new FrameParser(defs)
    const frames = parser.push(combined)

    expect(frames).toHaveLength(1)
    expect(frames[0].seq).toBe(9)
    expect(parser.stats.badMsgId).toBe(1)
    expect(parser.stats.dropped).toBe(1)
    expect(parser.stats.received).toBe(1)
  })

  it('drops a frame with a bad CRC, counts crcErrors+dropped, and still parses the next good frame', () => {
    const encoded = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 0, 1, 1)
    const corrupted = Uint8Array.from(encoded)
    corrupted[corrupted.length - 1] ^= 0xff // flip a CRC byte
    const goodFrame = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 4, 1, 1)

    const combined = new Uint8Array(corrupted.length + goodFrame.length)
    combined.set(corrupted, 0)
    combined.set(goodFrame, corrupted.length)

    const parser = new FrameParser(defs)
    const frames = parser.push(combined)

    expect(frames).toHaveLength(1)
    expect(frames[0].seq).toBe(4)
    expect(parser.stats.crcErrors).toBe(1)
    expect(parser.stats.dropped).toBe(1)
  })

  it('scans past injected garbage bytes (no coincidental magic byte) between frames without losing the following good frame', () => {
    const garbage = Uint8Array.from([0x11, 0x22, 0x33, 0x00, 0x44, 0x99]) // neither 0xfd nor 0xfe appears
    const encoded = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 2, 1, 1)

    const combined = new Uint8Array(garbage.length + encoded.length)
    combined.set(garbage, 0)
    combined.set(encoded, garbage.length)

    const parser = new FrameParser(defs)
    const frames = parser.push(combined)

    expect(frames).toHaveLength(1)
    expect(frames[0].seq).toBe(2)
  })

  it('resyncs past a garbage run that coincidentally contains a 0xFD byte (a false frame-start candidate), recovering the following good frame', () => {
    // Named risk 2(c): garbage isn't guaranteed to avoid the magic byte
    // value. findMagic() will land on the embedded 0xFD, treat it as a
    // frame candidate, and read the following garbage/frame bytes as if
    // they were a real header — here that reads as a disallowed incompat
    // flag bit, so it's rejected before CRC is even checked. Whatever the
    // specific rejection reason, the parser must resync past *that* byte
    // too rather than getting stuck or skipping the genuine frame after it.
    const garbage = Uint8Array.from([0x11, 0xfd, 0x22, 0x33]) // 0xfd at index 1 is not a real frame start
    const encoded = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 13, 1, 1)

    const combined = new Uint8Array(garbage.length + encoded.length)
    combined.set(garbage, 0)
    combined.set(encoded, garbage.length)

    const parser = new FrameParser(defs)
    const frames = parser.push(combined)

    expect(frames).toHaveLength(1)
    expect(frames[0].seq).toBe(13)
    expect(parser.stats.dropped).toBeGreaterThanOrEqual(1)
  })

  it('buffers (does not discard) a frame whose claimed length exceeds the bytes delivered so far, then completes it once the rest arrives', () => {
    // magic + len=9 (HEARTBEAT-sized) + a valid-looking header, but the
    // push is cut off mid-payload. A truncated frame is indistinguishable
    // from "more bytes are coming" until proven otherwise (this is also how
    // pymavlink's own reference parser behaves) -- FrameParser must not
    // guess and discard it, only genuinely-invalid candidates get resynced.
    const encoded = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 6, 1, 1)
    const parser = new FrameParser(defs)

    const partial = parser.push(encoded.subarray(0, encoded.length - 3)) // missing last 3 bytes (CRC + a payload byte)
    expect(partial).toHaveLength(0)
    expect(parser.stats.dropped).toBe(0)

    const rest = parser.push(encoded.subarray(encoded.length - 3))
    expect(rest).toHaveLength(1)
    expect(rest[0].seq).toBe(6)
  })

  it('resyncs past a well-formed-looking but bogus header (plausible length, garbage content) to the following good frame', () => {
    // A complete, correctly-sized MAVLink2 header + 1-byte payload + CRC,
    // but the CRC bytes are arbitrary (not computed) so it must fail the
    // CRC check -- exercising the byte-at-a-time resync path with a
    // hand-crafted header rather than a corrupted encodeFrame() output.
    const fakeHeader = Uint8Array.from([0xfd, 1, 0, 0, 0, 1, 1, 0, 0, 0]) // len=1, HEARTBEAT msgid
    const fakeFrame = Uint8Array.from([...fakeHeader, 0x42, 0xde, 0xad]) // 1 payload byte + bogus crc
    const encoded = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 6, 1, 1)
    const combined = new Uint8Array(fakeFrame.length + encoded.length)
    combined.set(fakeFrame, 0)
    combined.set(encoded, fakeFrame.length)

    const parser = new FrameParser(defs)
    const frames = parser.push(combined)
    expect(frames).toHaveLength(1)
    expect(frames[0].seq).toBe(6)
    expect(parser.stats.crcErrors).toBeGreaterThanOrEqual(1)
  })
})

describe('FrameParser: MAVLink2 signing', () => {
  function buildSignedFrame(): { bytes: Uint8Array; crcExtra: number } {
    const crcExtra = defs.crcExtraForMsgId(HEARTBEAT_MSGID)!
    const payload = heartbeatPayload()
    const header = Uint8Array.from([
      0xfd, payload.length, 0x01 /* signed */, 0, 0, 1, 1,
      HEARTBEAT_MSGID & 0xff, (HEARTBEAT_MSGID >> 8) & 0xff, (HEARTBEAT_MSGID >> 16) & 0xff,
    ])
    const crcRegion = new Uint8Array(header.length - 1 + payload.length)
    crcRegion.set(header.subarray(1), 0)
    crcRegion.set(payload, header.length - 1)
    // Reuse crcCalculate indirectly via a round trip through encodeFrame's
    // sibling crc.ts would create a cyclic test dependency; compute inline
    // instead using the same algorithm frame.ts/crc.ts implement.
    let crc = 0xffff
    const step = (data: number, acc: number): number => {
      let tmp = (data ^ (acc & 0xff)) & 0xff
      tmp = (tmp ^ (tmp << 4)) & 0xff
      return ((acc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
    }
    for (const b of crcRegion) crc = step(b, crc)
    crc = step(crcExtra, crc)

    const signature = new Uint8Array(13) // link_id + timestamp(6) + signature(6), unvalidated
    const bytes = new Uint8Array(header.length + payload.length + 2 + signature.length)
    bytes.set(header, 0)
    bytes.set(payload, header.length)
    bytes[header.length + payload.length] = crc & 0xff
    bytes[header.length + payload.length + 1] = (crc >> 8) & 0xff
    bytes.set(signature, header.length + payload.length + 2)
    return { bytes, crcExtra }
  }

  it('parses a signed frame (consuming the 13-byte signature), marks signed: true, and lets the caller decide to drop it', () => {
    const { bytes } = buildSignedFrame()
    const goodFrame = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 8, 1, 1)
    const combined = new Uint8Array(bytes.length + goodFrame.length)
    combined.set(bytes, 0)
    combined.set(goodFrame, bytes.length)

    const parser = new FrameParser(defs)
    const frames = parser.push(combined)

    expect(frames).toHaveLength(2)
    expect(frames[0].signed).toBe(true)
    expect(frames[0].incompatFlags & 0x01).toBe(0x01)
    expect(frames[1].seq).toBe(8) // the following unsigned frame parsed correctly too
    expect(parser.stats.received).toBe(2)
  })

  it('discards a frame with an unknown (non-signing) incompat flag bit set and resyncs', () => {
    const payload = heartbeatPayload()
    const header = Uint8Array.from([
      0xfd, payload.length, 0x02 /* unknown flag bit */, 0, 0, 1, 1,
      HEARTBEAT_MSGID & 0xff, (HEARTBEAT_MSGID >> 8) & 0xff, (HEARTBEAT_MSGID >> 16) & 0xff,
    ])
    const bogus = new Uint8Array(header.length + payload.length + 2)
    bogus.set(header, 0)
    bogus.set(payload, header.length)
    // CRC bytes left as zero (irrelevant; frame must be rejected before CRC check).

    const goodFrame = encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() }, 11, 1, 1)
    const combined = new Uint8Array(bogus.length + goodFrame.length)
    combined.set(bogus, 0)
    combined.set(goodFrame, bogus.length)

    const parser = new FrameParser(defs)
    const frames = parser.push(combined)

    expect(frames).toHaveLength(1)
    expect(frames[0].seq).toBe(11)
    expect(parser.stats.dropped).toBe(1)
  })
})

describe('FrameParser: MAVLink1 compatibility', () => {
  it('parses a MAVLink1 frame (6-byte header, 8-bit msgid, no incompat/compat flags)', () => {
    // fe 09 05 01 01 00 00 00 00 00 06 08 00 00 03 | a2 ad (captured via pymavlink v1.0 dialect)
    const bytes = Uint8Array.from(Buffer.from('fe0905010100000000000608000003a2ad', 'hex'))
    const parser = new FrameParser(defs)
    const frames = parser.push(bytes)

    expect(frames).toHaveLength(1)
    const frame: MavFrame = frames[0]
    expect(frame.version).toBe(1)
    expect(frame.msgid).toBe(HEARTBEAT_MSGID)
    expect(frame.seq).toBe(5)
    expect(frame.sysid).toBe(1)
    expect(frame.compid).toBe(1)
    expect(frame.incompatFlags).toBe(0)
    expect(frame.signed).toBe(false)
    expect(Array.from(frame.payload)).toEqual([0, 0, 0, 0, 6, 8, 0, 0, 3])
  })
})
