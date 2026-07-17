/**
 * Issue #24 (MessageAggregateStore tap point, PRD §11.2): connection store
 * integration tests through the same external seams `recording.test.ts` uses
 * for `history` — injected port picker + `MockTransport` for frames in, the
 * store's `inspector` (`MessageAggregateStore`) for aggregates out.
 * `MessageAggregateStore` internals (record/evict/hz) are unit-tested
 * directly in `src/core/mavlink/__tests__/inspector.test.ts`; this file only
 * proves the wiring: a decoded frame reaches exactly one aggregate, the
 * aggregate map freezes across a disconnect and clears on the next connect,
 * and a signed frame (dropped by the router before decode) never reaches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../core/transport/mock'
import { defs } from '../../core/mavlink/defs'
import { encodeFrame } from '../../core/mavlink/frame'
import { encodePayload } from '../../core/mavlink/encode'
import { Telemetry } from '../../core/mavlink/telemetry'
import { createConnectionStore, type PortPicker } from '../connection'

const HEARTBEAT_MSGID = 0
const ATTITUDE_MSGID = 30

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, 1, 1)
}

function heartbeatFrame(seq = 0): Uint8Array {
  return frame(
    HEARTBEAT_MSGID,
    { type: 2, autopilot: 3, base_mode: 81, custom_mode: 0, system_status: 4, mavlink_version: 3 },
    seq,
  )
}

function attitudeFrame(opts: { roll?: number; pitch?: number; yaw?: number }, seq = 0): Uint8Array {
  return frame(ATTITUDE_MSGID, { roll: opts.roll ?? 0, pitch: opts.pitch ?? 0, yaw: opts.yaw ?? 0 }, seq)
}

/**
 * Real HEARTBEAT+signature bytes, incompat flag bit 0 set — same
 * construction as `router.test.ts`'s own `signedHeartbeatFrame`. The router
 * drops a signed frame before it is ever decoded (`router.ts`'s
 * `handleFrame`), so this proves the Inspector tap really sits post-decode,
 * pre-fan-out, not a separate parse.
 */
function signedHeartbeatFrame(seq: number, sysid: number, compid: number): Uint8Array {
  const crcExtra = defs.crcExtraForMsgId(HEARTBEAT_MSGID)!
  const payload = new Uint8Array(9)
  const view = new DataView(payload.buffer)
  view.setUint32(0, 0, true) // custom_mode
  payload[4] = 2 // type
  payload[5] = 3 // autopilot
  payload[6] = 81 // base_mode
  payload[7] = 4 // system_status
  payload[8] = 3 // mavlink_version
  const header = Uint8Array.from([
    0xfd, payload.length, 0x01 /* signed */, 0, seq, sysid, compid,
    HEARTBEAT_MSGID & 0xff, (HEARTBEAT_MSGID >> 8) & 0xff, (HEARTBEAT_MSGID >> 16) & 0xff,
  ])
  const crcRegion = new Uint8Array(header.length - 1 + payload.length)
  crcRegion.set(header.subarray(1), 0)
  crcRegion.set(payload, header.length - 1)
  let crc = 0xffff
  const step = (data: number, acc: number): number => {
    let tmp = (data ^ (acc & 0xff)) & 0xff
    tmp = (tmp ^ (tmp << 4)) & 0xff
    return ((acc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
  }
  for (const b of crcRegion) crc = step(b, crc)
  crc = step(crcExtra, crc)

  const signature = new Uint8Array(13)
  const bytes = new Uint8Array(header.length + payload.length + 2 + signature.length)
  bytes.set(header, 0)
  bytes.set(payload, header.length)
  bytes[header.length + payload.length] = crc & 0xff
  bytes[header.length + payload.length + 1] = (crc >> 8) & 0xff
  bytes.set(signature, header.length + payload.length + 2)
  return bytes
}

/** Lets pending reader.read()/microtask chains from the router's pump settle without relying on real timers — same pattern as recording.test.ts. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function connected(): Promise<{ store: ReturnType<typeof createConnectionStore>; transport: MockTransport }> {
  const transport = new MockTransport()
  const store = createConnectionStore(async () => ({ transport, portInfo: {} }))
  await store.getState().connect(115200)
  transport.feed(heartbeatFrame())
  await flush()
  expect(store.getState().phase).toBe('connected')
  return { store, transport }
}

describe('message aggregate store (tap point wiring)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('a decoded frame produces exactly one aggregate entry with the right count/name/fields', async () => {
    const { store, transport } = await connected()

    transport.feed(attitudeFrame({ roll: 0.5, pitch: -0.25, yaw: 1.0 }, 1))
    await flush()

    const inspector = store.getState().inspector
    // The connecting HEARTBEAT itself lands too — the tap has no msgid
    // filter (PRD §2), so it sees every message type from the target.
    expect(inspector.all().map((a) => a.name).sort()).toEqual(['ATTITUDE', 'HEARTBEAT'])

    const attitude = inspector.get(ATTITUDE_MSGID)
    expect(attitude?.count).toBe(1)
    expect(attitude?.latest.fields.roll).toBeCloseTo(0.5, 5)
    expect(attitude?.latest.fields.pitch).toBeCloseTo(-0.25, 5)
    expect(attitude?.latest.fields.yaw).toBeCloseTo(1.0, 5)

    transport.feed(attitudeFrame({ roll: 0.6 }, 2))
    await flush()
    expect(inspector.get(ATTITUDE_MSGID)?.count).toBe(2)
    expect(inspector.get(ATTITUDE_MSGID)?.latest.fields.roll).toBeCloseTo(0.6, 5)
  })

  it('freezes across a disconnect but leaves the data readable', async () => {
    vi.spyOn(Telemetry.prototype, 'stopStreams').mockResolvedValue(undefined)
    const { store, transport } = await connected()

    transport.feed(attitudeFrame({ roll: 0.1 }, 1))
    await flush()
    expect(store.getState().inspector.get(ATTITUDE_MSGID)?.count).toBe(1)

    await store.getState().disconnect()

    expect(store.getState().phase).toBe('disconnected')
    const frozen = store.getState().inspector.get(ATTITUDE_MSGID)
    expect(frozen?.count).toBe(1)
    expect(frozen?.latest.fields.roll).toBeCloseTo(0.1, 5)
  })

  it('is cleared the moment the next connect reaches \'connected\'', async () => {
    vi.spyOn(Telemetry.prototype, 'stopStreams').mockResolvedValue(undefined)
    const transports = [new MockTransport(), new MockTransport()]
    let calls = 0
    const picker: PortPicker = async () => ({ transport: transports[calls++], portInfo: {} })
    const store = createConnectionStore(picker)

    await store.getState().connect(115200)
    transports[0].feed(heartbeatFrame())
    await flush()
    transports[0].feed(attitudeFrame({ roll: 0.1 }, 1))
    await flush()
    expect(store.getState().inspector.get(ATTITUDE_MSGID)?.count).toBe(1)

    await store.getState().disconnect()
    expect(store.getState().inspector.get(ATTITUDE_MSGID)?.count).toBe(1) // survives the disconnect...

    await store.getState().connect(115200)
    transports[1].feed(heartbeatFrame())
    await flush()

    // ...and is cleared before any new record beyond the very HEARTBEAT that
    // established this new connection — the stale ATTITUDE entry is gone.
    const inspector = store.getState().inspector
    expect(inspector.get(ATTITUDE_MSGID)).toBeUndefined()
    expect(inspector.all().map((a) => a.name)).toEqual(['HEARTBEAT'])
    expect(inspector.get(HEARTBEAT_MSGID)?.count).toBe(1)

    transports[1].feed(attitudeFrame({ roll: 0.2 }, 1))
    await flush()
    const roll = inspector.get(ATTITUDE_MSGID)
    expect(roll?.count).toBe(1) // only the new session's record
    expect(roll?.latest.fields.roll).toBeCloseTo(0.2, 5)
  })

  it('never records a signed frame — the router drops it before decode', async () => {
    const { store, transport } = await connected()
    const before = store.getState().inspector.get(HEARTBEAT_MSGID)?.count

    transport.feed(signedHeartbeatFrame(1, 1, 1))
    await flush()

    expect(store.getState().inspector.get(HEARTBEAT_MSGID)?.count).toBe(before) // unchanged
    expect(store.getState().inspector.all()).toHaveLength(1) // no new entry either

    // Confirm the router did receive and drop it, so this isn't just "the
    // frame never arrived" — it arrived, and was dropped pre-decode.
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.getState().linkStats?.signedDropped).toBe(1)
  })
})
