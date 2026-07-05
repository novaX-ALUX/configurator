import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../transport/mock'
import { defs } from '../defs'
import { decodePayload } from '../decode'
import { encodeFrame, FrameParser } from '../frame'
import { encodePayload } from '../encode'
import { MavRouter } from '../router'
import type { CommandAck } from '../command'
import type { MavSession } from '../session'
import { AccelCalibration, AccelCalUsageError, type AccelFace } from '../accelCal'

const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77

const MAV_CMD_PREFLIGHT_CALIBRATION = 241
const MAV_CMD_ACCELCAL_VEHICLE_POS = 42429

const MAV_RESULT_ACCEPTED = 0
const MAV_RESULT_FAILED = 4

const ACCELCAL_VEHICLE_POS_SUCCESS = 16777215
const ACCELCAL_VEHICLE_POS_FAILED = 16777216

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0, sysid = 1, compid = 1): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, sysid, compid)
}

/** Inbound FC->GCS COMMAND_LONG cmd=42429, matching `AP_AccelCal`'s own `send_accelcal_vehicle_position` shape. */
function accelcalPosFrame(param1: number, seq = 0): Uint8Array {
  return frame(
    COMMAND_LONG_MSGID,
    { target_system: 255, target_component: 0, command: MAV_CMD_ACCELCAL_VEHICLE_POS, confirmation: 0, param1 },
    seq,
  )
}

function ackFrame(opts: { command: number; result: number; sysid?: number; compid?: number; seq?: number }): Uint8Array {
  return frame(
    COMMAND_ACK_MSGID,
    { command: opts.command, result: opts.result, progress: 0, result_param2: 0 },
    opts.seq ?? 0,
    opts.sysid ?? 1,
    opts.compid ?? 1,
  )
}

/** Decodes every COMMAND_LONG frame in `sent`, in order. */
function decodeCommandLongs(sent: Uint8Array[]): Array<Record<string, unknown>> {
  const parser = new FrameParser(defs)
  const out: Array<Record<string, unknown>> = []
  for (const bytes of sent) {
    const [f] = parser.push(bytes)
    if (f.msgid === COMMAND_LONG_MSGID) out.push(decodePayload(defs, f).fields)
  }
  return out
}

function routerSubscriberCount(router: MavRouter): number {
  return (router as unknown as { subscribers: Set<unknown> }).subscribers.size
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

const fixtureBytes = new Uint8Array(
  readFileSync(join(process.cwd(), 'src/core/mavlink/__tests__/fixtures/frames-m2.bin')),
)

describe('AccelCalibration', () => {
  let transport: MockTransport
  let router: MavRouter
  const target = { sysid: 1, compid: 1 }
  let session: MavSession

  beforeEach(async () => {
    vi.useFakeTimers()
    transport = new MockTransport()
    router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
    session = { router, target, paramStore: {} as MavSession['paramStore'], telemetry: {} as MavSession['telemetry'] }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('start()', () => {
    it('sends PREFLIGHT_CALIBRATION with param5=1', async () => {
      const cal = new AccelCalibration(session)
      const promise = cal.start()
      await flush()

      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({ command: MAV_CMD_PREFLIGHT_CALIBRATION, param5: 1 })
      expect(cal.status).toBe('busy')

      transport.feed(ackFrame({ command: MAV_CMD_PREFLIGHT_CALIBRATION, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
      expect(cal.status).toBe('running')
      cal.dispose()
    })

    it('a rejected ACK sets status failed and rejects', async () => {
      const cal = new AccelCalibration(session)
      const promise = cal.start()
      const rejection = expect(promise).rejects.toThrow()
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_PREFLIGHT_CALIBRATION, result: MAV_RESULT_FAILED }))
      await flush()

      await rejection
      expect(cal.status).toBe('failed')
      cal.dispose()
    })
  })

  describe('inbound 42429 drives onFacePrompt / onComplete', () => {
    it('feeding the committed frames-m2 fixture drives onFacePrompt level->back in order, then onComplete(true)', async () => {
      const cal = new AccelCalibration(session)
      const faces: AccelFace[] = []
      const completions: Array<[boolean, string | undefined]> = []
      cal.onFacePrompt((f) => faces.push(f))
      cal.onComplete((ok, msg) => completions.push([ok, msg]))

      // Get into 'running' so inbound signals aren't ignored (mirrors real
      // usage: start() must succeed before the FC begins prompting).
      const startPromise = cal.start()
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_PREFLIGHT_CALIBRATION, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await startPromise

      transport.feed(fixtureBytes)
      await flush()

      expect(faces).toEqual(['level', 'left', 'right', 'nosedown', 'noseup', 'back'])
      // The fixture also contains a trailing FAILED frame after SUCCESS
      // (fixture coverage, not a real sequence) -- already-terminal 'done'
      // must ignore it, so onComplete fires exactly once, with true.
      expect(completions).toEqual([[true, undefined]])
      expect(cal.status).toBe('done')
      cal.dispose()
    })

    it('an inbound failure sentinel (16777216) drives onComplete(false)', async () => {
      const cal = new AccelCalibration(session)
      const completions: Array<[boolean, string | undefined]> = []
      cal.onComplete((ok, msg) => completions.push([ok, msg]))

      const startPromise = cal.start()
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_PREFLIGHT_CALIBRATION, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await startPromise

      transport.feed(accelcalPosFrame(1))
      await flush()
      transport.feed(accelcalPosFrame(ACCELCAL_VEHICLE_POS_FAILED))
      await flush()

      expect(completions).toEqual([[false, undefined]])
      expect(cal.status).toBe('failed')
      cal.dispose()
    })
  })

  describe('captureFace()', () => {
    async function startAndPromptLevel(cal: AccelCalibration): Promise<void> {
      const startPromise = cal.start()
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_PREFLIGHT_CALIBRATION, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await startPromise
      transport.feed(accelcalPosFrame(1))
      await flush()
    }

    it('sends ACCELCAL_VEHICLE_POS with param1 = the current step (the verified confirm mechanism, not a bare ACK)', async () => {
      const cal = new AccelCalibration(session)
      await startAndPromptLevel(cal)
      transport.sent.length = 0 // clear the start()/nothing-else noise

      const capturePromise = cal.captureFace()
      await flush()

      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({ command: MAV_CMD_ACCELCAL_VEHICLE_POS, param1: 1 })
      expect(cal.status).toBe('busy')

      transport.feed(ackFrame({ command: MAV_CMD_ACCELCAL_VEHICLE_POS, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await capturePromise
      expect(cal.status).toBe('busy') // now "collecting" -- next inbound 42429 resolves it
      cal.dispose()
    })

    it('throws AccelCalUsageError when there is no outstanding face prompt', async () => {
      const cal = new AccelCalibration(session)
      await expect(cal.captureFace()).rejects.toBeInstanceOf(AccelCalUsageError)
      cal.dispose()
    })

    it('a rejected confirm ACK reverts status to running and rejects', async () => {
      const cal = new AccelCalibration(session)
      await startAndPromptLevel(cal)

      const capturePromise = cal.captureFace()
      const rejection = expect(capturePromise).rejects.toThrow()
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_ACCELCAL_VEHICLE_POS, result: MAV_RESULT_FAILED }))
      await flush()

      await rejection
      expect(cal.status).toBe('running')
      cal.dispose()
    })

    it('a late-arriving rejected ACK does not clobber a status already advanced by a concurrent inbound 42429', async () => {
      // Regression test: captureFace()'s own confirm-ACK is in flight when
      // the FC's inbound SUCCESS sentinel arrives first (a real possible
      // ordering on the last face) -- the eventual (redundant/late)
      // rejected ACK for the confirm must not revert 'done' back to
      // 'running'.
      let resolveAck!: (ack: CommandAck) => void
      let calls = 0
      const sendCommandFn = vi.fn((_router, _target, cmd): Promise<CommandAck> => {
        calls++
        if (calls === 1) {
          // start()'s own PREFLIGHT_CALIBRATION confirm -- resolve immediately.
          return Promise.resolve({ command: cmd.command, result: MAV_RESULT_ACCEPTED, progress: 0, resultParam2: 0 })
        }
        // captureFace()'s confirm -- held open under test control.
        return new Promise<CommandAck>((resolve) => {
          resolveAck = resolve
        })
      })
      const cal = new AccelCalibration(session, { sendCommandFn })
      const completions: boolean[] = []
      cal.onComplete((ok) => completions.push(ok))

      await cal.start()
      transport.feed(accelcalPosFrame(1))
      await flush()

      const capturePromise = cal.captureFace()
      const rejection = expect(capturePromise).rejects.toThrow()
      await flush()
      expect(cal.status).toBe('busy')

      // FC's SUCCESS sentinel arrives before the confirm's own ACK does.
      transport.feed(accelcalPosFrame(ACCELCAL_VEHICLE_POS_SUCCESS))
      await flush()
      expect(cal.status).toBe('done')
      expect(completions).toEqual([true])

      // The confirm's ACK finally resolves, rejected -- must not clobber 'done'.
      resolveAck({ command: MAV_CMD_ACCELCAL_VEHICLE_POS, result: MAV_RESULT_FAILED, progress: 0, resultParam2: 0 })
      await rejection
      expect(cal.status).toBe('done')
      cal.dispose()
    })
  })

  describe('abandon()', () => {
    it('tears down UI-side state without sending anything, and ignores further inbound signals', async () => {
      const cal = new AccelCalibration(session)
      const faces: AccelFace[] = []
      cal.onFacePrompt((f) => faces.push(f))

      const startPromise = cal.start()
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_PREFLIGHT_CALIBRATION, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await startPromise
      transport.feed(accelcalPosFrame(1))
      await flush()
      expect(faces).toEqual(['level'])

      const sentBefore = transport.sent.length
      await cal.abandon()
      expect(transport.sent.length).toBe(sentBefore) // abandon() sends nothing to the FC

      expect(cal.status).toBe('idle')

      // FC keeps "running" server-side (no real cancel) and might still
      // broadcast -- the UI must not react anymore.
      transport.feed(accelcalPosFrame(2))
      await flush()
      expect(faces).toEqual(['level'])
      expect(cal.status).toBe('idle')

      cal.dispose()
    })
  })

  describe('dispose()', () => {
    it('unsubscribes from the router', () => {
      const before = routerSubscriberCount(router)
      const cal = new AccelCalibration(session)
      expect(routerSubscriberCount(router)).toBe(before + 1)
      cal.dispose()
      expect(routerSubscriberCount(router)).toBe(before)
    })
  })
})

// Keep `sendCommandFn` injection ability sanity-checked, mirroring how
// telemetry.test.ts verifies the same optional-injection pattern.
describe('AccelCalibration with injected sendCommandFn', () => {
  it('routes start() through the injected sendCommandFn', async () => {
    vi.useFakeTimers()
    const transport = new MockTransport()
    const router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
    const target = { sysid: 1, compid: 1 }
    const session: MavSession = { router, target, paramStore: {} as MavSession['paramStore'], telemetry: {} as MavSession['telemetry'] }

    const sendCommandFn = vi.fn(async (): Promise<CommandAck> => ({ command: MAV_CMD_PREFLIGHT_CALIBRATION, result: MAV_RESULT_ACCEPTED, progress: 0, resultParam2: 0 }))
    const cal = new AccelCalibration(session, { sendCommandFn })
    await cal.start()
    expect(sendCommandFn).toHaveBeenCalledWith(
      router,
      target,
      { command: MAV_CMD_PREFLIGHT_CALIBRATION, param5: 1 },
      { timeoutMs: 5000 }, // DEFAULT_COMMAND_TIMEOUT_MS, when commandTimeoutMs isn't overridden
    )
    cal.dispose()
    vi.useRealTimers()
  })

  it('threads a caller-supplied commandTimeoutMs through to sendCommandFn for both start() and captureFace() (retries stay forced to 0 -- both commands are DANGEROUS_COMMANDS, only the timeout changes)', async () => {
    vi.useFakeTimers()
    const transport = new MockTransport()
    const router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
    const target = { sysid: 1, compid: 1 }
    const session: MavSession = { router, target, paramStore: {} as MavSession['paramStore'], telemetry: {} as MavSession['telemetry'] }

    const sendCommandFn = vi.fn(async (): Promise<CommandAck> => ({ command: MAV_CMD_PREFLIGHT_CALIBRATION, result: MAV_RESULT_ACCEPTED, progress: 0, resultParam2: 0 }))
    const cal = new AccelCalibration(session, { sendCommandFn, commandTimeoutMs: 9000 })

    await cal.start()
    expect(sendCommandFn).toHaveBeenLastCalledWith(
      router,
      target,
      { command: MAV_CMD_PREFLIGHT_CALIBRATION, param5: 1 },
      { timeoutMs: 9000 },
    )

    transport.feed(accelcalPosFrame(1))
    await flush()
    await cal.captureFace()
    expect(sendCommandFn).toHaveBeenLastCalledWith(
      router,
      target,
      { command: MAV_CMD_ACCELCAL_VEHICLE_POS, param1: 1 },
      { timeoutMs: 9000 },
    )

    cal.dispose()
    vi.useRealTimers()
  })
})
