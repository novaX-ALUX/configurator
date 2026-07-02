import { describe, expect, it } from 'vitest'
import { defs } from '../defs'
import type { MavFrame } from '../frame'
import { decodePayload } from '../decode'

const HEARTBEAT_MSGID = 0
const PARAM_VALUE_MSGID = 22
const STATUSTEXT_MSGID = 253
const SYSTEM_TIME_MSGID = 2
const TIMESYNC_MSGID = 111
const GIMBAL_ATTITUDE_STATUS_MSGID = 285

function frameOf(msgid: number, payload: Uint8Array, overrides: Partial<MavFrame> = {}): MavFrame {
  return {
    version: 2,
    sysid: 1,
    compid: 1,
    msgid,
    seq: 0,
    payload,
    incompatFlags: 0,
    signed: false,
    ...overrides,
  }
}

describe('decodePayload: scalar fields', () => {
  it('decodes HEARTBEAT, including the mavlink_version pseudo-type as a plain uint8', () => {
    // custom_mode=0x01020304, type=6, autopilot=8, base_mode=0, system_status=4, mavlink_version=3
    const payload = Uint8Array.from([0x04, 0x03, 0x02, 0x01, 6, 8, 0, 4, 3])
    const decoded = decodePayload(defs, frameOf(HEARTBEAT_MSGID, payload))

    expect(decoded.msgid).toBe(HEARTBEAT_MSGID)
    expect(decoded.name).toBe('HEARTBEAT')
    expect(decoded.fields).toEqual({
      custom_mode: 0x01020304,
      type: 6,
      autopilot: 8,
      base_mode: 0,
      system_status: 4,
      mavlink_version: 3,
    })
  })
})

describe('decodePayload: char[] fields', () => {
  it('trims param_id at the first NUL and decodes it as a string', () => {
    const payload = new Uint8Array(25) // PARAM_VALUE full length
    const view = new DataView(payload.buffer)
    view.setFloat32(0, 0.5, true) // param_value
    view.setUint16(4, 10, true) // param_count
    view.setUint16(6, 2, true) // param_index
    const id = 'THR_MIN'
    for (let i = 0; i < id.length; i++) payload[8 + i] = id.charCodeAt(i)
    // remaining param_id bytes stay 0 (NUL padding)
    payload[24] = 9 // param_type

    const decoded = decodePayload(defs, frameOf(PARAM_VALUE_MSGID, payload))
    expect(decoded.fields.param_id).toBe('THR_MIN')
    expect(decoded.fields.param_type).toBe(9)
    expect(decoded.fields.param_count).toBe(10)
    expect(decoded.fields.param_index).toBe(2)
  })

  it('decodes a full 16-char param_id with no trailing NUL at all (array exactly full)', () => {
    const payload = new Uint8Array(25)
    const id = 'AHRS_EKF_TYPE_XX' // exactly 16 chars
    expect(id.length).toBe(16)
    for (let i = 0; i < id.length; i++) payload[8 + i] = id.charCodeAt(i)
    const decoded = decodePayload(defs, frameOf(PARAM_VALUE_MSGID, payload))
    expect(decoded.fields.param_id).toBe(id)
  })
})

describe('decodePayload: zero-extension of truncated wire payloads', () => {
  it('zero-extends a wire-truncated STATUSTEXT payload so extension fields (id, chunk_seq) decode as 0', () => {
    // Only severity + "hi" sent (3 bytes on the wire); id/chunk_seq extension
    // fields were never transmitted (trailing zeros truncated at encode time).
    const wirePayload = Uint8Array.from([6, 'h'.charCodeAt(0), 'i'.charCodeAt(0)])
    const decoded = decodePayload(defs, frameOf(STATUSTEXT_MSGID, wirePayload))

    expect(decoded.fields.severity).toBe(6)
    expect(decoded.fields.text).toBe('hi')
    expect(decoded.fields.id).toBe(0)
    expect(decoded.fields.chunk_seq).toBe(0)
  })
})

describe('decodePayload: 64-bit fields decode as BigInt', () => {
  it('decodes SYSTEM_TIME.time_unix_usec (uint64_t) as a BigInt', () => {
    const payload = new Uint8Array(12)
    const view = new DataView(payload.buffer)
    view.setBigUint64(0, 1717171717171717n, true)
    view.setUint32(8, 12345, true)
    const decoded = decodePayload(defs, frameOf(SYSTEM_TIME_MSGID, payload))
    expect(decoded.fields.time_unix_usec).toBe(1717171717171717n)
    expect(decoded.fields.time_boot_ms).toBe(12345)
  })

  it('decodes TIMESYNC int64_t fields, including negative values, as BigInt', () => {
    const payload = new Uint8Array(18)
    const view = new DataView(payload.buffer)
    view.setBigInt64(0, -42n, true) // tc1
    view.setBigInt64(8, 999999999999n, true) // ts1
    const decoded = decodePayload(defs, frameOf(TIMESYNC_MSGID, payload))
    expect(decoded.fields.tc1).toBe(-42n)
    expect(decoded.fields.ts1).toBe(999999999999n)
  })
})

describe('decodePayload: numeric array fields', () => {
  it('decodes GIMBAL_DEVICE_ATTITUDE_STATUS.q (float[4]) as a number array', () => {
    const payload = new Uint8Array(40) // base (non-extension) length
    const view = new DataView(payload.buffer)
    view.setFloat32(4, 0.1, true)
    view.setFloat32(8, 0.2, true)
    view.setFloat32(12, 0.3, true)
    view.setFloat32(16, 0.4, true)
    const decoded = decodePayload(defs, frameOf(GIMBAL_ATTITUDE_STATUS_MSGID, payload))
    const q = decoded.fields.q as number[]
    expect(q).toHaveLength(4)
    expect(q[0]).toBeCloseTo(0.1, 5)
    expect(q[1]).toBeCloseTo(0.2, 5)
    expect(q[2]).toBeCloseTo(0.3, 5)
    expect(q[3]).toBeCloseTo(0.4, 5)
  })
})

describe('decodePayload: unknown msgid', () => {
  it('throws when defs has no field table for the frame\'s msgid', () => {
    expect(() => decodePayload(defs, frameOf(0xabcdef, new Uint8Array(0)))).toThrow()
  })
})
