/**
 * MAVLink1/2 frame layer: byte-stream -> `MavFrame[]` (parsing, with
 * resync on garbage/corruption) and `{ msgid, payload }` -> bytes
 * (encoding). Field-level (de)serialization is out of scope here — see
 * `decode.ts` for turning a frame's raw payload into named field values.
 * `MavFrame.payload` is the **raw, wire-truncated** payload exactly as
 * received; zero-extension to the message's full declared length happens
 * in `decode.ts`, not here.
 *
 * `FrameParser`/`encodeFrame` only depend on `crcExtraForMsgId` (a subset
 * of `GeneratedDefs` from `defs.ts`) — this file never imports
 * `mavlink-mappings` itself (docs/notes/decisions-m1.md decisions 2/8).
 */
import { crcCalculate } from './crc'

export interface MavFrame {
  version: 1 | 2
  sysid: number
  compid: number
  msgid: number
  seq: number
  /** Raw, wire-truncated payload (see module doc — not zero-extended here). */
  payload: Uint8Array
  incompatFlags: number
  signed: boolean
}

/** The subset of `GeneratedDefs` (defs.ts) the frame layer needs. */
export interface CrcExtraLookup {
  crcExtraForMsgId(msgid: number): number | undefined
}

const MAGIC_V2 = 0xfd
const MAGIC_V1 = 0xfe
const HEADER_LEN_V2 = 10
const HEADER_LEN_V1 = 6
const CRC_LEN = 2
const SIGNATURE_LEN = 13
const MAVLINK_IFLAG_SIGNED = 0x01

/**
 * Concatenates `a` (previously-retained bytes, already owned by this
 * module) with `b` (the caller's just-pushed chunk), always returning a
 * buffer this module owns exclusively. The empty-`a` fast path still
 * copies `b` (via `.slice()`) rather than returning it directly: a
 * fixed-buffer read loop (`port.read(sharedBuf)`) commonly reuses/overwrites
 * `sharedBuf` immediately after `push()` returns, and if a partial frame is
 * retained by reference into that buffer, the next read silently corrupts
 * it. Copying here is the one place that ownership boundary is crossed, so
 * every other subarray/slice derived from the result is safe to retain.
 */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice()
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * Streaming MAVLink1/2 parser. Feed it bytes as they arrive (in any
 * fragmentation) via `push()`; it returns whichever complete frames became
 * available and buffers the rest internally for the next call.
 *
 * Resync policy: any frame candidate that turns out to be malformed (bad
 * CRC, unresolvable msgid, or a MAVLink2 incompat flag bit other than
 * "signed") is discarded by advancing exactly one byte past its magic byte
 * and rescanning for the next magic byte — this guarantees a genuine frame
 * immediately following garbage/corruption is never lost. `stats.dropped`
 * counts every rejected sync candidate (a magic byte that turned out not to
 * start a valid frame), not raw discarded bytes — a multi-byte garbage run
 * between two good frames is scanned byte-by-byte but only increments
 * `dropped` once it lands on something that looks like a frame candidate
 * (a 0xFD/0xFE byte) and that candidate then fails validation.
 * `crcErrors`/`badMsgId` are the specific-reason subsets of that same total.
 */
export class FrameParser {
  private buf: Uint8Array = new Uint8Array(0)
  readonly stats = { received: 0, crcErrors: 0, badMsgId: 0, dropped: 0 }

  constructor(private readonly defs: CrcExtraLookup) {}

  /**
   * Ownership contract: `bytes` is only read during this call. `push()`
   * never retains a reference to the caller's array (any bytes it needs to
   * buffer for the next call are copied first, see `concat()`) — the
   * caller is free to mutate or reuse `bytes` (e.g. a fixed-buffer read
   * loop) immediately after `push()` returns.
   */
  push(bytes: Uint8Array): MavFrame[] {
    this.buf = concat(this.buf, bytes)
    const out: MavFrame[] = []

    for (;;) {
      const magicIndex = this.findMagic()
      if (magicIndex === -1) {
        this.buf = new Uint8Array(0)
        break
      }
      if (magicIndex > 0) {
        this.buf = this.buf.subarray(magicIndex)
      }

      const version: 1 | 2 = this.buf[0] === MAGIC_V2 ? 2 : 1
      const headerLen = version === 2 ? HEADER_LEN_V2 : HEADER_LEN_V1
      if (this.buf.length < headerLen) break // wait for more data

      const len = this.buf[1]
      let incompatFlags = 0
      let seq: number
      let sysid: number
      let compid: number
      let msgid: number
      if (version === 2) {
        incompatFlags = this.buf[2]
        // compatFlags = this.buf[3] -- not surfaced on MavFrame (no consumer need yet)
        seq = this.buf[4]
        sysid = this.buf[5]
        compid = this.buf[6]
        msgid = this.buf[7] | (this.buf[8] << 8) | (this.buf[9] << 16)
      } else {
        seq = this.buf[2]
        sysid = this.buf[3]
        compid = this.buf[4]
        msgid = this.buf[5]
      }

      // MAVLink2: any incompat flag bit other than "signed" means this
      // receiver must not process the frame at all (spec requirement).
      if (version === 2 && (incompatFlags & ~MAVLINK_IFLAG_SIGNED) !== 0) {
        this.discardOneByte()
        continue
      }

      const crcExtra = this.defs.crcExtraForMsgId(msgid)
      if (crcExtra === undefined) {
        this.stats.badMsgId++
        this.discardOneByte()
        continue
      }

      const signed = version === 2 && (incompatFlags & MAVLINK_IFLAG_SIGNED) !== 0
      const total = headerLen + len + CRC_LEN + (signed ? SIGNATURE_LEN : 0)
      if (this.buf.length < total) break // wait for more data

      const crcRegionEnd = headerLen + len
      const computedCrc = crcCalculate(this.buf, 1, crcRegionEnd, crcExtra)
      const receivedCrc = this.buf[crcRegionEnd] | (this.buf[crcRegionEnd + 1] << 8)
      if (computedCrc !== receivedCrc) {
        this.stats.crcErrors++
        this.discardOneByte()
        continue
      }

      const payload = this.buf.slice(headerLen, crcRegionEnd)
      out.push({ version, sysid, compid, msgid, seq, payload, incompatFlags, signed })
      this.stats.received++
      this.buf = this.buf.subarray(total)
    }

    return out
  }

  private findMagic(): number {
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i] === MAGIC_V2 || this.buf[i] === MAGIC_V1) return i
    }
    return -1
  }

  private discardOneByte(): void {
    this.stats.dropped++
    this.buf = this.buf.subarray(1)
  }
}

/**
 * Encodes `msg` as a MAVLink2 frame: always magic 0xFD, incompat/compat
 * flags 0 (unsigned), trailing-zero payload truncation (never below 1
 * byte). `seq`/`sysid`/`compid` are caller-provided (Task 2.3's router
 * owns sequencing).
 */
export function encodeFrame(
  defs: CrcExtraLookup,
  msg: { msgid: number; payload: Uint8Array },
  seq: number,
  sysid: number,
  compid: number,
): Uint8Array {
  const crcExtra = defs.crcExtraForMsgId(msg.msgid)
  if (crcExtra === undefined) {
    throw new Error(`encodeFrame: unknown msgid ${msg.msgid} (no CRC_EXTRA in defs)`)
  }

  let len = msg.payload.length
  while (len > 1 && msg.payload[len - 1] === 0) len--
  const payload = msg.payload.subarray(0, len)

  const header = new Uint8Array(HEADER_LEN_V2)
  header[0] = MAGIC_V2
  header[1] = len
  header[2] = 0 // incompat flags
  header[3] = 0 // compat flags
  header[4] = seq & 0xff
  header[5] = sysid & 0xff
  header[6] = compid & 0xff
  header[7] = msg.msgid & 0xff
  header[8] = (msg.msgid >> 8) & 0xff
  header[9] = (msg.msgid >> 16) & 0xff

  const frame = new Uint8Array(HEADER_LEN_V2 + len + CRC_LEN)
  frame.set(header, 0)
  frame.set(payload, HEADER_LEN_V2)

  const crc = crcCalculate(frame, 1, HEADER_LEN_V2 + len, crcExtra)
  frame[frame.length - 2] = crc & 0xff
  frame[frame.length - 1] = (crc >> 8) & 0xff

  return frame
}
