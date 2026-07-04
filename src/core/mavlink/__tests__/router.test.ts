import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../transport/mock'
import { defs } from '../defs'
import type { GeneratedDefs } from '../defs'
import { encodeFrame, FrameParser, type MavFrame } from '../frame'
import type { DecodedMessage } from '../decode'
import { MavRouter } from '../router'

const HEARTBEAT_MSGID = 0
const ATTITUDE_MSGID = 30

function heartbeatPayload(opts?: { type?: number; autopilot?: number; baseMode?: number; customMode?: number; systemStatus?: number }): Uint8Array {
  const buf = new Uint8Array(9)
  const view = new DataView(buf.buffer)
  view.setUint32(0, opts?.customMode ?? 0, true)
  buf[4] = opts?.type ?? 6
  buf[5] = opts?.autopilot ?? 8
  buf[6] = opts?.baseMode ?? 81
  buf[7] = opts?.systemStatus ?? 4
  buf[8] = 3 // mavlink_version
  return buf
}

function attitudePayload(): Uint8Array {
  return new Uint8Array(28)
}

/** Builds a raw MAVLink2 byte frame straight from `encodeFrame`, for feeding into a MockTransport. */
function heartbeatFrame(seq: number, sysid: number, compid: number, opts?: Parameters<typeof heartbeatPayload>[0]): Uint8Array {
  return encodeFrame(defs, { msgid: HEARTBEAT_MSGID, payload: heartbeatPayload(opts) }, seq, sysid, compid)
}

/** Real HEARTBEAT+signature bytes, incompat flag bit 0 set — same construction as frame.test.ts's signing suite. */
function signedHeartbeatFrame(seq: number, sysid: number, compid: number): Uint8Array {
  const crcExtra = defs.crcExtraForMsgId(HEARTBEAT_MSGID)!
  const payload = heartbeatPayload()
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

async function openAndStart(router: MavRouter, transport: MockTransport): Promise<void> {
  await transport.open()
  router.start()
}

/** Lets the pump's pending `reader.read()` microtasks settle without relying on real timers. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('MavRouter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('construction / source IDs', () => {
    it('defaults source sysid/compid to 255/190 when opts omitted', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await transport.open()

      await router.send({ msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() })

      const parser = new FrameParser(defs)
      const [frame] = parser.push(transport.sent[0])
      expect(frame.sysid).toBe(255)
      expect(frame.compid).toBe(190)
    })

    it('uses configured sysid/compid when provided', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, { sysid: 42, compid: 99 })
      await transport.open()

      await router.send({ msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() })

      const parser = new FrameParser(defs)
      const [frame] = parser.push(transport.sent[0])
      expect(frame.sysid).toBe(42)
      expect(frame.compid).toBe(99)
    })
  })

  describe('send()', () => {
    it('auto-increments seq starting at 0 and wraps from 255 back to 0', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await transport.open()

      for (let i = 0; i < 257; i++) {
        await router.send({ msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() })
      }

      const parser = new FrameParser(defs)
      const seqs = transport.sent.map((bytes) => parser.push(bytes)[0].seq)
      expect(seqs[0]).toBe(0)
      expect(seqs[255]).toBe(255)
      expect(seqs[256]).toBe(0)
    })

    it('rejects if the transport is not open (propagated from transport.write)', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await expect(router.send({ msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() })).rejects.toThrow()
    })
  })

  describe('subscribe()', () => {
    it('delivers decoded message + raw frame to a wildcard subscriber', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      const received: Array<[DecodedMessage, MavFrame]> = []
      router.subscribe({}, (msg, frame) => received.push([msg, frame]))

      transport.feed(heartbeatFrame(0, 1, 1))
      await flush()

      expect(received).toHaveLength(1)
      expect(received[0][0].name).toBe('HEARTBEAT')
      expect(received[0][1].sysid).toBe(1)
    })

    it('filters combine with AND — omitted fields are wildcards', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      const onlyAttitude: DecodedMessage[] = []
      router.subscribe({ msgid: ATTITUDE_MSGID }, (msg) => onlyAttitude.push(msg))

      const sysid1Compid1: DecodedMessage[] = []
      router.subscribe({ sysid: 1, compid: 1 }, (msg) => sysid1Compid1.push(msg))

      transport.feed(heartbeatFrame(0, 1, 1))
      transport.feed(encodeFrame(defs, { msgid: ATTITUDE_MSGID, payload: attitudePayload() }, 1, 1, 1))
      transport.feed(heartbeatFrame(2, 2, 2))
      await flush()

      expect(onlyAttitude).toHaveLength(1)
      expect(onlyAttitude[0].name).toBe('ATTITUDE')
      expect(sysid1Compid1).toHaveLength(2) // HEARTBEAT + ATTITUDE from sysid 1/compid 1, not the sysid-2 heartbeat
    })

    it('unsubscribe stops further delivery to that callback only', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      const a: DecodedMessage[] = []
      const b: DecodedMessage[] = []
      const unsubA = router.subscribe({}, (msg) => a.push(msg))
      router.subscribe({}, (msg) => b.push(msg))

      transport.feed(heartbeatFrame(0, 1, 1))
      await flush()
      unsubA()
      transport.feed(heartbeatFrame(1, 1, 1))
      await flush()

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(2)
    })

    it('does not deliver signed frames to subscribers, but counts them as signedDropped', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      const received: DecodedMessage[] = []
      router.subscribe({}, (msg) => received.push(msg))

      transport.feed(signedHeartbeatFrame(0, 1, 1))
      transport.feed(heartbeatFrame(1, 1, 1))
      await flush()

      expect(received).toHaveLength(1) // only the unsigned one
      expect(router.stats.signedDropped).toBe(1)
    })

    it('a decode error for one frame is counted and skipped, without killing the pump for later frames', async () => {
      const transport = new MockTransport()
      // A defs double whose HEARTBEAT field table contains an unsupported type,
      // forcing decodePayload() to throw, while crcExtraForMsgId still resolves
      // normally so FrameParser accepts the frame as well-formed.
      const brokenDefs: GeneratedDefs = {
        ...defs,
        fieldsForMsgId(msgid) {
          if (msgid === HEARTBEAT_MSGID) {
            return [{ name: 'bogus', type: 'not_a_real_type', offset: 0, size: 1, length: 0, extension: false }]
          }
          return defs.fieldsForMsgId(msgid)
        },
      }
      const router = new MavRouter(transport, brokenDefs, {})
      await openAndStart(router, transport)

      const received: DecodedMessage[] = []
      router.subscribe({}, (msg) => received.push(msg))

      transport.feed(heartbeatFrame(0, 1, 1))
      transport.feed(encodeFrame(defs, { msgid: ATTITUDE_MSGID, payload: attitudePayload() }, 1, 1, 1))
      await flush()

      expect(received).toHaveLength(1)
      expect(received[0].name).toBe('ATTITUDE')
      expect(router.stats.decodeErrors).toBe(1)
    })
  })

  describe('getComponents()', () => {
    it('registers a component from a HEARTBEAT, using the injected clock for lastSeen', async () => {
      const clock = vi.fn(() => 1000)
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, { now: clock })
      await openAndStart(router, transport)

      transport.feed(heartbeatFrame(0, 1, 1, { type: 6, autopilot: 8, baseMode: 81, customMode: 5, systemStatus: 4 }))
      await flush()

      const components = router.getComponents()
      const info = components.get('1:1')
      expect(info).toEqual({
        sysid: 1,
        compid: 1,
        type: 6,
        autopilot: 8,
        baseMode: 81,
        customMode: 5,
        systemStatus: 4,
        lastSeen: 1000,
      })
    })

    it('tracks multiple components independently, keyed by sysid:compid', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      transport.feed(heartbeatFrame(0, 1, 1))
      transport.feed(heartbeatFrame(1, 2, 1))
      await flush()

      const components = router.getComponents()
      expect(components.size).toBe(2)
      expect(components.has('1:1')).toBe(true)
      expect(components.has('2:1')).toBe(true)
    })

    it('returns a read-only snapshot: mutating the returned map does not affect the router', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      transport.feed(heartbeatFrame(0, 1, 1))
      await flush()

      const snapshot = router.getComponents() as Map<string, unknown>
      snapshot.delete('1:1')

      expect(router.getComponents().has('1:1')).toBe(true)
    })
  })

  describe('linkState', () => {
    it('starts idle before start() is called', () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      expect(router.linkState).toBe('idle')
    })

    it('moves to connecting once start() is called, before any HEARTBEAT arrives', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await transport.open()
      router.start()
      expect(router.linkState).toBe('connecting')
    })

    it('moves to connected on the first HEARTBEAT', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      transport.feed(heartbeatFrame(0, 1, 1))
      await flush()

      expect(router.linkState).toBe('connected')
    })

    it('moves to lost after the heartbeat timeout elapses with no further HEARTBEAT', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, { heartbeatTimeoutMs: 3000 })
      await openAndStart(router, transport)

      transport.feed(heartbeatFrame(0, 1, 1))
      await flush()
      expect(router.linkState).toBe('connected')

      await vi.advanceTimersByTimeAsync(3000)
      expect(router.linkState).toBe('lost')
    })

    it('respects a configured heartbeatTimeoutMs distinct from the default (not hardcoded 3000)', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, { heartbeatTimeoutMs: 500 })
      await openAndStart(router, transport)

      transport.feed(heartbeatFrame(0, 1, 1))
      await flush()
      expect(router.linkState).toBe('connected')

      await vi.advanceTimersByTimeAsync(499)
      expect(router.linkState).toBe('connected') // not yet

      await vi.advanceTimersByTimeAsync(1)
      expect(router.linkState).toBe('lost')
    })

    it('returns to connected once another HEARTBEAT arrives after being lost', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, { heartbeatTimeoutMs: 3000 })
      await openAndStart(router, transport)

      transport.feed(heartbeatFrame(0, 1, 1))
      await flush()
      await vi.advanceTimersByTimeAsync(3000)
      expect(router.linkState).toBe('lost')

      transport.feed(heartbeatFrame(1, 1, 1))
      await flush()
      expect(router.linkState).toBe('connected')
    })

    it('goes idle when the transport disconnects, and the pump stops (no further subscriber callbacks)', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      const received: DecodedMessage[] = []
      router.subscribe({}, (msg) => received.push(msg))

      transport.feed(heartbeatFrame(0, 1, 1))
      await flush()
      expect(router.linkState).toBe('connected')

      transport.simulateDisconnect('unplugged')
      await flush()

      expect(router.linkState).toBe('idle')
      expect(received).toHaveLength(1) // only the pre-disconnect heartbeat
    })

    it('stays idle even if a HEARTBEAT was already buffered in the stream right as disconnect fired (no resurrection, no late callback)', async () => {
      // Regression: feed() enqueues onto the stream, and a disconnect right
      // after (no await in between) still lets that already-queued chunk
      // resolve a pending reader.read() *after* onDisconnect has already
      // fired synchronously — the pump must not act on it.
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      const received: DecodedMessage[] = []
      router.subscribe({}, (msg) => received.push(msg))

      transport.feed(heartbeatFrame(0, 1, 1)) // enqueued, not yet read by the pump
      transport.simulateDisconnect('unplugged') // fires onDisconnect before the pump ever reads the above frame
      await flush()

      expect(router.linkState).toBe('idle')
      expect(received).toHaveLength(0)
    })
  })

  describe('callback isolation', () => {
    it('a throwing subscriber callback does not kill the pump for other subscribers or later frames', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      router.subscribe({}, () => {
        throw new Error('boom from a buggy subscriber')
      })
      const survivor: DecodedMessage[] = []
      router.subscribe({}, (msg) => survivor.push(msg))

      transport.feed(heartbeatFrame(0, 1, 1))
      transport.feed(heartbeatFrame(1, 1, 1))
      await flush()

      expect(survivor).toHaveLength(2)
    })

    it('a throwing onLinkState callback does not kill the pump for later HEARTBEATs', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      router.onLinkState(() => {
        throw new Error('boom from a buggy linkState listener')
      })

      transport.feed(heartbeatFrame(0, 1, 1))
      await flush()

      expect(router.linkState).toBe('connected')
      expect(router.getComponents().has('1:1')).toBe(true)
    })
  })

  describe('onLinkState()', () => {
    it('notifies subscribers of every transition, and unsubscribe stops further notifications', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, { heartbeatTimeoutMs: 3000 })
      const states: string[] = []
      const unsub = router.onLinkState((s) => states.push(s))

      await transport.open()
      router.start() // idle -> connecting
      transport.feed(heartbeatFrame(0, 1, 1))
      await flush() // connecting -> connected
      await vi.advanceTimersByTimeAsync(3000) // connected -> lost

      unsub()
      transport.feed(heartbeatFrame(1, 1, 1))
      await flush() // would be lost -> connected, but unsubscribed

      expect(states).toEqual(['connecting', 'connected', 'lost'])
    })
  })

  describe('lifecycle: start()', () => {
    it('throws if start() is called before the transport is open', () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      expect(() => router.start()).toThrow()
    })

    it('throws if start() is called twice', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await transport.open()
      router.start()
      expect(() => router.start()).toThrow()
    })
  })

  describe('stats', () => {
    it('surfaces framesIn/framesOut/decodeErrors/signedDropped plus FrameParser crcErrors/badMsgId/dropped', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      transport.feed(heartbeatFrame(0, 1, 1))
      await router.send({ msgid: HEARTBEAT_MSGID, payload: heartbeatPayload() })
      await flush()

      expect(router.stats).toEqual({
        framesIn: 1,
        framesOut: 1,
        decodeErrors: 0,
        signedDropped: 0,
        crcErrors: 0,
        badMsgId: 0,
        dropped: 0,
      })
    })
  })

  describe('integration: real pymavlink fixture', () => {
    const frameBytes = new Uint8Array(
      readFileSync(join(process.cwd(), 'src/core/mavlink/__tests__/fixtures/frames.bin')),
    )

    it('decodes every fixture frame to subscribers and populates the component registry from its HEARTBEATs', async () => {
      const transport = new MockTransport()
      const router = new MavRouter(transport, defs, {})
      await openAndStart(router, transport)

      const names: string[] = []
      router.subscribe({}, (msg) => names.push(msg.name))

      transport.feed(frameBytes)
      await flush()

      expect(names).toEqual(['HEARTBEAT', 'ATTITUDE', 'PARAM_VALUE', 'STATUSTEXT', 'STATUSTEXT', 'COMMAND_ACK', 'HEARTBEAT'])

      const components = router.getComponents()
      expect(components.size).toBe(2)
      expect(components.get('1:1')).toBeDefined()
      expect(components.get('2:2')).toBeDefined()
      expect(router.linkState).toBe('connected')
    })
  })
})
