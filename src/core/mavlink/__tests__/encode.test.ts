import { describe, expect, it } from 'vitest'
import { defs } from '../defs'
import { decodePayload } from '../decode'
import { encodePayload } from '../encode'
import type { MavFrame } from '../frame'

const HEARTBEAT_MSGID = 0
const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77
const SYSTEM_TIME_MSGID = 2
const TIMESYNC_MSGID = 111
const PARAM_VALUE_MSGID = 22

function frameOf(msgid: number, payload: Uint8Array): MavFrame {
  return { version: 2, sysid: 1, compid: 1, msgid, seq: 0, payload, incompatFlags: 0, signed: false }
}

describe('encodePayload: scalar fields, round-tripped through decodePayload', () => {
  it('encodes HEARTBEAT (uint8/uint16/uint32 scalars) and decodes back to the same field values', () => {
    const payload = encodePayload(defs, HEARTBEAT_MSGID, {
      custom_mode: 0x01020304,
      type: 6,
      autopilot: 8,
      base_mode: 81,
      system_status: 4,
      mavlink_version: 3,
    })
    const decoded = decodePayload(defs, frameOf(HEARTBEAT_MSGID, payload))
    expect(decoded.fields).toEqual({
      custom_mode: 0x01020304,
      type: 6,
      autopilot: 8,
      base_mode: 81,
      system_status: 4,
      mavlink_version: 3,
    })
  })

  it('encodes COMMAND_LONG (float params, uint16 command, uint8 target/confirmation) and round-trips', () => {
    const payload = encodePayload(defs, COMMAND_LONG_MSGID, {
      target_system: 1,
      target_component: 1,
      command: 400,
      confirmation: 2,
      param1: 1,
      param2: 0,
      param3: 0,
      param4: 0,
      param5: 0,
      param6: 0,
      param7: 0,
    })
    const decoded = decodePayload(defs, frameOf(COMMAND_LONG_MSGID, payload))
    expect(decoded.fields.target_system).toBe(1)
    expect(decoded.fields.target_component).toBe(1)
    expect(decoded.fields.command).toBe(400)
    expect(decoded.fields.confirmation).toBe(2)
    expect(decoded.fields.param1).toBeCloseTo(1, 5)
  })

  it('encodes int64_t/uint64_t fields as BigInt and round-trips (TIMESYNC, SYSTEM_TIME)', () => {
    const timesyncPayload = encodePayload(defs, TIMESYNC_MSGID, { tc1: -42n, ts1: 999999999999n })
    const decodedTimesync = decodePayload(defs, frameOf(TIMESYNC_MSGID, timesyncPayload))
    expect(decodedTimesync.fields.tc1).toBe(-42n)
    expect(decodedTimesync.fields.ts1).toBe(999999999999n)

    const systemTimePayload = encodePayload(defs, SYSTEM_TIME_MSGID, {
      time_unix_usec: 1717171717171717n,
      time_boot_ms: 12345,
    })
    const decodedSystemTime = decodePayload(defs, frameOf(SYSTEM_TIME_MSGID, systemTimePayload))
    expect(decodedSystemTime.fields.time_unix_usec).toBe(1717171717171717n)
    expect(decodedSystemTime.fields.time_boot_ms).toBe(12345)
  })
})

describe('encodePayload: char[] fields', () => {
  it('encodes a param_id shorter than the declared length, NUL-padding the rest', () => {
    const payload = encodePayload(defs, PARAM_VALUE_MSGID, {
      param_id: 'THR_MIN',
      param_value: 0.5,
      param_type: 9,
      param_count: 10,
      param_index: 2,
    })
    const decoded = decodePayload(defs, frameOf(PARAM_VALUE_MSGID, payload))
    expect(decoded.fields.param_id).toBe('THR_MIN')
    expect(decoded.fields.param_value).toBeCloseTo(0.5, 5)
    expect(decoded.fields.param_type).toBe(9)
  })

  it('encodes a param_id exactly filling the declared length (no NUL at all)', () => {
    const id = 'AHRS_EKF_TYPE_XX' // exactly 16 chars
    const payload = encodePayload(defs, PARAM_VALUE_MSGID, { param_id: id })
    const decoded = decodePayload(defs, frameOf(PARAM_VALUE_MSGID, payload))
    expect(decoded.fields.param_id).toBe(id)
  })

  it('throws when a char[] value exceeds the declared length', () => {
    expect(() => encodePayload(defs, PARAM_VALUE_MSGID, { param_id: 'THIS_NAME_IS_WAY_TOO_LONG_FOR_16' })).toThrow()
  })
})

describe('encodePayload: omitted fields default to zero (matching decode.ts zero-extension)', () => {
  it('leaves unspecified fields at 0 / empty string', () => {
    const payload = encodePayload(defs, COMMAND_ACK_MSGID, { command: 400, result: 0 })
    const decoded = decodePayload(defs, frameOf(COMMAND_ACK_MSGID, payload))
    expect(decoded.fields.command).toBe(400)
    expect(decoded.fields.result).toBe(0)
    expect(decoded.fields.progress).toBe(0)
    expect(decoded.fields.result_param2).toBe(0)
    expect(decoded.fields.target_system).toBe(0)
    expect(decoded.fields.target_component).toBe(0)
  })

  it('produces the full (base + extension) length even with all fields omitted', () => {
    const payload = encodePayload(defs, COMMAND_ACK_MSGID, {})
    expect(payload.length).toBe(10) // command(2)+result(1)+progress(1)+result_param2(4)+target_system(1)+target_component(1)
  })
})

describe('encodePayload: unknown msgid', () => {
  it('throws when defs has no field table for the given msgid', () => {
    expect(() => encodePayload(defs, 0xabcdef, {})).toThrow()
  })
})
