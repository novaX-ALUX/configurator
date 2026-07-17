/**
 * Wire-seam tests for the RC-calibration session state machine (issue #38,
 * PRD #32 "Testing Decisions"): MockTransport + real MavRouter + real
 * Telemetry, driven by injecting RC_CHANNELS/HEARTBEAT frames. The two
 * non-negotiable safety assertions live here:
 *  - zero frames leave the wire at any point during calibration (the module
 *    never writes a parameter, never sends a command, never touches the
 *    router at all), and
 *  - an armed heartbeat mid-calibration aborts instantly and discards every
 *    detected value, so nothing from the aborted run can ever be staged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../transport/mock'
import { defs } from '../defs'
import { encodeFrame } from '../frame'
import { encodePayload } from '../encode'
import { MavRouter } from '../router'
import { Telemetry } from '../telemetry'
import {
  RC_CAL_CHANNEL_COUNT,
  RC_CAL_MOVED_THRESHOLD_US,
  RcCalibration,
  RcCalStartBlockedError,
} from '../rcCal'

const HEARTBEAT_MSGID = 0
const RC_CHANNELS_MSGID = 65
const MAV_MODE_FLAG_SAFETY_ARMED = 0x80

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, 1, 1)
}

function heartbeatFrame(armed: boolean, seq = 0): Uint8Array {
  return frame(
    HEARTBEAT_MSGID,
    { custom_mode: 0, type: 6, autopilot: 8, base_mode: armed ? MAV_MODE_FLAG_SAFETY_ARMED : 0, system_status: 4 },
    seq,
  )
}

/** `values` is 1-based-channel -> µs; unlisted channels are 0 ("channel not available"). */
function rcFrame(values: Record<number, number>, seq = 0): Uint8Array {
  const fields: Record<string, number> = { chancount: 16, rssi: 200 }
  for (let i = 1; i <= 18; i++) fields[`chan${i}_raw`] = values[i] ?? 0
  return frame(RC_CHANNELS_MSGID, fields, seq)
}

describe('RcCalibration', () => {
  let transport: MockTransport
  let router: MavRouter
  let telemetry: Telemetry
  let cal: RcCalibration

  beforeEach(async () => {
    vi.useFakeTimers()
    transport = new MockTransport()
    router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
    telemetry = new Telemetry(router, { sysid: 1, compid: 1 })
    cal = new RcCalibration(telemetry)
  })

  afterEach(() => {
    cal.dispose()
    telemetry.dispose()
    vi.useRealTimers()
  })

  /** Feeds a frame and advances past Telemetry's ~100ms subscriber throttle so the update reaches the state machine. */
  async function feed(bytes: Uint8Array): Promise<void> {
    transport.feed(bytes)
    await vi.advanceTimersByTimeAsync(150)
  }

  describe('entry gate', () => {
    it('refuses to start before any heartbeat has been seen', () => {
      expect(() => cal.start()).toThrowError(RcCalStartBlockedError)
      expect(cal.snapshot().phase).toBe('idle')
    })

    it('refuses to start while the latest heartbeat shows armed', async () => {
      await feed(heartbeatFrame(true))
      let caught: unknown
      try {
        cal.start()
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(RcCalStartBlockedError)
      expect((caught as RcCalStartBlockedError).reason).toBe('armed')
      expect(cal.snapshot().phase).toBe('idle')
    })

    it('starts once a disarmed heartbeat is the latest', async () => {
      await feed(heartbeatFrame(false))
      cal.start()
      expect(cal.snapshot().phase).toBe('sampling')
    })
  })

  describe('sampling', () => {
    beforeEach(async () => {
      await feed(heartbeatFrame(false))
      cal.start()
    })

    it('tracks per-channel min/max and the live value from RC telemetry', async () => {
      await feed(rcFrame({ 1: 1500, 2: 1500, 3: 1100 }, 0))
      await feed(rcFrame({ 1: 1000, 2: 1500, 3: 1900 }, 1))
      await feed(rcFrame({ 1: 2000, 2: 1500, 3: 1500 }, 2))

      const [ch1, ch2, ch3] = cal.snapshot().channels
      expect(ch1).toMatchObject({ channel: 1, min: 1000, max: 2000, value: 2000, moved: true })
      expect(ch2).toMatchObject({ channel: 2, min: 1500, max: 1500, value: 1500, moved: false })
      expect(ch3).toMatchObject({ channel: 3, min: 1100, max: 1900, moved: true })
    })

    it(`marks a channel moved only past the ${RC_CAL_MOVED_THRESHOLD_US}µs threshold`, async () => {
      await feed(rcFrame({ 1: 1500 }, 0))
      await feed(rcFrame({ 1: 1500 + RC_CAL_MOVED_THRESHOLD_US - 1 }, 1))
      expect(cal.snapshot().channels[0].moved).toBe(false)

      await feed(rcFrame({ 1: 1500 + RC_CAL_MOVED_THRESHOLD_US }, 2))
      expect(cal.snapshot().channels[0].moved).toBe(true)
    })

    it('ignores no-signal (0 / UINT16_MAX) and out-of-plausible-range samples', async () => {
      await feed(rcFrame({ 1: 1400, 2: 0xffff }, 0))
      await feed(rcFrame({ 1: 0, 2: 0xffff }, 1)) // ch1 dropout mid-run
      await feed(rcFrame({ 1: 500, 2: 0xffff }, 2)) // below the RCn_MIN metadata floor (800)
      await feed(rcFrame({ 1: 2500, 2: 0xffff }, 3)) // above the RCn_MAX metadata ceiling (2200)

      const [ch1, ch2, , ch4] = cal.snapshot().channels
      expect(ch1).toMatchObject({ min: 1400, max: 1400, value: 1400 })
      expect(ch2).toMatchObject({ min: undefined, max: undefined, value: undefined, moved: false })
      expect(ch4).toMatchObject({ min: undefined, max: undefined, value: undefined, moved: false })
    })

    it('exposes exactly 16 channels (RC1..RC16 parameters exist; 17/18 have none)', async () => {
      await feed(rcFrame({ 17: 1500, 18: 1500 }, 0))
      const channels = cal.snapshot().channels
      expect(channels).toHaveLength(RC_CAL_CHANNEL_COUNT)
      expect(channels[15].channel).toBe(16)
    })
  })

  describe('finish', () => {
    it('captures trim from the last valid sample of each channel', async () => {
      await feed(heartbeatFrame(false))
      cal.start()
      await feed(rcFrame({ 1: 1000, 3: 1000 }, 0))
      await feed(rcFrame({ 1: 2000, 3: 2000 }, 1))
      // "Center sticks, throttle down" moment: ch1 back to center, ch3 low.
      await feed(rcFrame({ 1: 1497, 3: 1001 }, 2))
      cal.finish()

      const snap = cal.snapshot()
      expect(snap.phase).toBe('done')
      expect(snap.channels[0]).toMatchObject({ min: 1000, max: 2000, trim: 1497, moved: true })
      expect(snap.channels[2]).toMatchObject({ min: 1000, max: 2000, trim: 1001, moved: true })
      expect(snap.channels[4].trim).toBeUndefined()
    })

    it('is a no-op outside sampling (races with an armed abort stay aborted+discarded)', async () => {
      await feed(heartbeatFrame(false))
      cal.start()
      await feed(rcFrame({ 1: 1000 }, 0))
      await feed(rcFrame({ 1: 2000 }, 1))
      await feed(heartbeatFrame(true, 1))
      cal.finish() // the user's click landing right after the abort
      const snap = cal.snapshot()
      expect(snap.phase).toBe('aborted')
      expect(snap.channels[0]).toMatchObject({ min: undefined, max: undefined, trim: undefined, moved: false })
    })
  })

  describe('armed abort (non-negotiable)', () => {
    it('aborts and discards all detected values on an armed heartbeat mid-calibration', async () => {
      await feed(heartbeatFrame(false))
      cal.start()
      await feed(rcFrame({ 1: 1000, 3: 1200 }, 0))
      await feed(rcFrame({ 1: 2000, 3: 1800 }, 1))
      expect(cal.snapshot().channels[0].moved).toBe(true)

      await feed(heartbeatFrame(true, 1))

      const snap = cal.snapshot()
      expect(snap.phase).toBe('aborted')
      for (const ch of snap.channels) {
        expect(ch.min).toBeUndefined()
        expect(ch.max).toBeUndefined()
        expect(ch.trim).toBeUndefined()
        expect(ch.moved).toBe(false)
      }
    })

    it('keeps ignoring later RC frames after an abort (nothing accumulates again until a fresh start)', async () => {
      await feed(heartbeatFrame(false))
      cal.start()
      await feed(heartbeatFrame(true, 1))
      await feed(rcFrame({ 1: 1000 }, 0))
      await feed(rcFrame({ 1: 2000 }, 1))
      expect(cal.snapshot().channels[0]).toMatchObject({ min: undefined, max: undefined, moved: false })
    })
  })

  describe('restart / cancel', () => {
    it('cancel returns to idle and clears tracking', async () => {
      await feed(heartbeatFrame(false))
      cal.start()
      await feed(rcFrame({ 1: 1000 }, 0))
      cal.cancel()
      expect(cal.snapshot().phase).toBe('idle')
      expect(cal.snapshot().channels[0].value).toBeUndefined()
    })

    it('a fresh start after done clears the previous run\'s results', async () => {
      await feed(heartbeatFrame(false))
      cal.start()
      await feed(rcFrame({ 1: 1000 }, 0))
      await feed(rcFrame({ 1: 2000 }, 1))
      cal.finish()
      cal.start()
      const snap = cal.snapshot()
      expect(snap.phase).toBe('sampling')
      // The previous run's range/trim is gone; start() re-seeds from the
      // *current* RC block (last value 2000), so min=max=that one sample.
      expect(snap.channels[0]).toMatchObject({ min: 2000, max: 2000, trim: undefined, moved: false })
    })

    it('start after an armed abort works once the latest heartbeat is disarmed again', async () => {
      await feed(heartbeatFrame(false))
      cal.start()
      await feed(heartbeatFrame(true, 1))
      expect(cal.snapshot().phase).toBe('aborted')
      expect(() => cal.start()).toThrowError(RcCalStartBlockedError) // still armed
      await feed(heartbeatFrame(false, 2))
      cal.start()
      expect(cal.snapshot().phase).toBe('sampling')
    })
  })

  describe('zero-write wire seam (non-negotiable)', () => {
    it('sends nothing — not one frame — across a full run including an armed abort and a finished rerun', async () => {
      await feed(heartbeatFrame(false))
      cal.start()
      await feed(rcFrame({ 1: 1000, 3: 1100 }, 0))
      await feed(rcFrame({ 1: 2000, 3: 1900 }, 1))
      await feed(heartbeatFrame(true, 1)) // armed abort
      await feed(heartbeatFrame(false, 2))
      cal.start()
      await feed(rcFrame({ 1: 1000 }, 2))
      await feed(rcFrame({ 1: 2000 }, 3))
      cal.finish()
      cal.cancel()

      expect(transport.sent).toHaveLength(0)
    })
  })

  describe('change notification', () => {
    it('notifies subscribers on phase changes and applied samples, and stops after unsubscribe/dispose', async () => {
      const seen: string[] = []
      const unsub = cal.onChange(() => seen.push(cal.snapshot().phase))
      await feed(heartbeatFrame(false))
      cal.start()
      await feed(rcFrame({ 1: 1000 }, 0))
      expect(seen.length).toBeGreaterThanOrEqual(2)
      expect(seen[0]).toBe('sampling')

      const count = seen.length
      unsub()
      await feed(rcFrame({ 1: 1200 }, 1))
      expect(seen.length).toBe(count)
    })
  })
})
