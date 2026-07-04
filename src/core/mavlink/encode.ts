/**
 * Inverse of `decode.ts`: turns named field values into a full-length
 * payload buffer, using the same field table `GeneratedDefs` (`defs.ts`)
 * provides for the given msgid. Mirrors `decode.ts`'s type table exactly —
 * `baseType`/`fullPayloadLength` are imported from there rather than
 * duplicated, so the two directions can't drift apart.
 *
 * Fields omitted from `fields` are left at their zero-value default (0 for
 * numeric/BigInt fields, empty/all-NUL for `char[]`) — the same value
 * `decodePayload` would produce for a wire-truncated payload. This module
 * always returns the **full** (base + extension) length; `encodeFrame`
 * (`frame.ts`) is responsible for the wire-level trailing-zero truncation.
 */
import type { GeneratedDefs } from './defs'
import { baseType, fullPayloadLength, type BaseType } from './decode'

export type EncodableFieldValue = number | bigint | string

/**
 * Thrown by `encodePayload` for any input it refuses to encode: an unknown
 * msgid, or (most commonly) a typo'd field name — `fieldName` is set only
 * for the latter. A typo'd key would otherwise be silently ignored (the
 * real field stays at its zero default) rather than surfacing as an error,
 * which is worse than a thrown exception for a wire-protocol encoder.
 */
export class EncodeError extends Error {
  constructor(
    message: string,
    public readonly msgid: number,
    public readonly fieldName?: string,
  ) {
    super(message)
    this.name = 'EncodeError'
  }
}

function writeScalar(view: DataView, offset: number, type: BaseType, value: number | bigint): void {
  switch (type) {
    case 'uint8_t': view.setUint8(offset, Number(value)); return
    case 'int8_t': view.setInt8(offset, Number(value)); return
    case 'uint16_t': view.setUint16(offset, Number(value), true); return
    case 'int16_t': view.setInt16(offset, Number(value), true); return
    case 'uint32_t': view.setUint32(offset, Number(value), true); return
    case 'int32_t': view.setInt32(offset, Number(value), true); return
    case 'uint64_t': view.setBigUint64(offset, BigInt(value), true); return
    case 'int64_t': view.setBigInt64(offset, BigInt(value), true); return
    case 'float': view.setFloat32(offset, Number(value), true); return
    case 'double': view.setFloat64(offset, Number(value), true); return
    case 'char': throw new Error('encodePayload: char is encoded as a string, not a scalar')
  }
}

/** Writes `value` into `payload` at `offset`; the rest of the `length`-byte field is left at 0 (NUL padding), matching decodePayload's trim-at-first-NUL read. */
function writeCharArray(payload: Uint8Array, offset: number, length: number, value: string): void {
  if (value.length > length) {
    throw new Error(`encodePayload: char[] value "${value}" (${value.length} chars) exceeds declared length ${length}`)
  }
  for (let i = 0; i < value.length; i++) {
    payload[offset + i] = value.charCodeAt(i)
  }
}

/**
 * Encodes `fields` (named field -> value) into a full-length payload for
 * `msgid`, per `defs`'s field table. Unlisted fields default to zero.
 * Array-typed MAVLink fields (`float[]` etc.) aren't supported yet — no
 * current consumer (command.ts, the upcoming param protocol) needs them;
 * `fieldsForMsgId` entries with `length > 0` that aren't `char[]` are
 * simply left at their zero default if omitted, same as any other field.
 */
export function encodePayload(defs: GeneratedDefs, msgid: number, fields: Record<string, EncodableFieldValue>): Uint8Array {
  const fieldDefs = defs.fieldsForMsgId(msgid)
  if (!fieldDefs) {
    throw new EncodeError(`encodePayload: unknown msgid ${msgid} (no field table in defs)`, msgid)
  }

  const validNames = new Set(fieldDefs.map((f) => f.name))
  for (const key of Object.keys(fields)) {
    if (!validNames.has(key)) {
      const messageName = defs.messageName(msgid)
      throw new EncodeError(
        `encodePayload: unrecognized field '${key}' for msgid ${msgid}${messageName ? ` (${messageName})` : ''} — check for a typo`,
        msgid,
        key,
      )
    }
  }

  const payload = new Uint8Array(fullPayloadLength(fieldDefs))
  const view = new DataView(payload.buffer)

  for (const f of fieldDefs) {
    if (!(f.name in fields)) continue // left at zero-value default
    const value = fields[f.name]
    const type = baseType(f.type)

    if (type === 'char') {
      if (typeof value !== 'string') {
        throw new Error(`encodePayload: field '${f.name}' is char[] but got ${typeof value}`)
      }
      writeCharArray(payload, f.offset, f.length, value)
    } else if (f.length > 0) {
      throw new Error(`encodePayload: field '${f.name}' is a numeric array field, which encodePayload does not support`)
    } else {
      if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new Error(`encodePayload: field '${f.name}' is scalar but got ${typeof value}`)
      }
      writeScalar(view, f.offset, type, value)
    }
  }

  return payload
}
