/**
 * Turns a parsed `MavFrame`'s raw (wire-truncated) payload into named field
 * values, using the field table `GeneratedDefs` (`defs.ts`) provides for
 * the frame's msgid.
 *
 * Zero-extension happens here, not in the frame layer: MAVLink2 senders may
 * truncate trailing zero bytes off a payload (`frame.ts`'s `encodeFrame`
 * does exactly this), so a received payload can be shorter than the
 * message's full declared length. Before extracting any field we pad the
 * payload out to that full length (base fields + extension fields) with
 * zero bytes, matching how a truncated trailing field is defined to read
 * (0 / empty string) per the MAVLink2 spec.
 */
import type { GeneratedDefs, MavFieldDef } from './defs'
import type { MavFrame } from './frame'

export type DecodedFieldValue = number | bigint | string | number[] | bigint[]

export interface DecodedMessage {
  msgid: number
  name: string
  fields: Record<string, DecodedFieldValue>
}

/** MAVLink C type names, longest/most-specific first (`uint8_t_mavlink_version` must match `uint8_t`, not fail). */
const KNOWN_BASE_TYPES = [
  'uint64_t', 'int64_t', 'uint32_t', 'int32_t', 'uint16_t', 'int16_t', 'uint8_t', 'int8_t', 'double', 'float', 'char',
] as const
type BaseType = (typeof KNOWN_BASE_TYPES)[number]

function baseType(type: string): BaseType {
  const withoutArray = type.endsWith('[]') ? type.slice(0, -2) : type
  const match = KNOWN_BASE_TYPES.find((t) => withoutArray.startsWith(t))
  if (!match) throw new Error(`decodePayload: unsupported field type '${type}'`)
  return match
}

function readScalar(view: DataView, offset: number, type: BaseType): number | bigint {
  switch (type) {
    case 'uint8_t': return view.getUint8(offset)
    case 'int8_t': return view.getInt8(offset)
    case 'uint16_t': return view.getUint16(offset, true)
    case 'int16_t': return view.getInt16(offset, true)
    case 'uint32_t': return view.getUint32(offset, true)
    case 'int32_t': return view.getInt32(offset, true)
    case 'uint64_t': return view.getBigUint64(offset, true)
    case 'int64_t': return view.getBigInt64(offset, true)
    case 'float': return view.getFloat32(offset, true)
    case 'double': return view.getFloat64(offset, true)
    case 'char': throw new Error('readScalar: char is decoded as a string, not a scalar')
  }
}

/** Decodes a `char[]` field, trimmed at the first NUL byte (or the full array if there is none). */
function readCharArray(payload: Uint8Array, offset: number, length: number): string {
  const bytes = payload.subarray(offset, offset + length)
  const nul = bytes.indexOf(0)
  const trimmed = nul === -1 ? bytes : bytes.subarray(0, nul)
  return String.fromCharCode(...trimmed)
}

/** Full struct length (base fields + extensions) implied by the field table's own offsets/sizes. */
function fullPayloadLength(fields: MavFieldDef[]): number {
  let max = 0
  for (const f of fields) {
    const bytes = f.length > 0 ? f.size * f.length : f.size
    max = Math.max(max, f.offset + bytes)
  }
  return max
}

export function decodePayload(defs: GeneratedDefs, frame: MavFrame): DecodedMessage {
  const fields = defs.fieldsForMsgId(frame.msgid)
  if (!fields) {
    throw new Error(`decodePayload: unknown msgid ${frame.msgid} (no field table in defs)`)
  }
  const name = defs.messageName(frame.msgid) ?? `UNKNOWN_${frame.msgid}`

  const fullLength = fullPayloadLength(fields)
  const padded = new Uint8Array(fullLength)
  padded.set(frame.payload.subarray(0, Math.min(frame.payload.length, fullLength)))
  const view = new DataView(padded.buffer)

  const out: Record<string, DecodedFieldValue> = {}
  for (const f of fields) {
    const type = baseType(f.type)
    if (type === 'char') {
      out[f.name] = readCharArray(padded, f.offset, f.length)
    } else if (f.length > 0) {
      const values: (number | bigint)[] = []
      for (let i = 0; i < f.length; i++) {
        values.push(readScalar(view, f.offset + i * f.size, type))
      }
      out[f.name] = values as number[] | bigint[]
    } else {
      out[f.name] = readScalar(view, f.offset, type)
    }
  }

  return { msgid: frame.msgid, name, fields: out }
}
