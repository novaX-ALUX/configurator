import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { decodePayload } from '../../../core/mavlink/decode'
import { encodeFrame, FrameParser } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { MavRouter } from '../../../core/mavlink/router'
import { CommandTimeoutError, type CommandAck } from '../../../core/mavlink/command'
import type { MavSession } from '../../../core/mavlink/session'
import {
  MOTOR_TEST_MAX_PERCENT,
  MotorTestUsageError,
  runMotorTest,
  stopAllMotors,
  stopMotorTest,
} from '../motorTest'

const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77
const MAV_CMD_DO_MOTOR_TEST = 209
const MAV_RESULT_ACCEPTED = 0

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0, sysid = 1, compid = 1): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, sysid, compid)
}

function ackFrame(opts: { command: number; result: number; seq?: number }): Uint8Array {
  return frame(
    COMMAND_ACK_MSGID,
    { command: opts.command, result: opts.result, progress: 0, result_param2: 0 },
    opts.seq ?? 0,
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

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** The committed Task 5.3 fixture pair -- includes one COMMAND_ACK (command=209, result=MAV_RESULT_ACCEPTED), see `fixtures-m2.test.ts`'s module doc. */
const fixtureBytes = new Uint8Array(
  readFileSync(join(process.cwd(), 'src/core/mavlink/__tests__/fixtures/frames-m2.bin')),
)

describe('motorTest', () => {
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

  describe('runMotorTest', () => {
    it('encodes DO_MOTOR_TEST with throttle_type=0 (percent), motorSeq as param1, throttle as param3, timeout as param4', async () => {
      const promise = runMotorTest(session, { motorSeq: 3, throttlePercent: 20, timeoutS: 0.8 })
      await flush()

      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({
        command: MAV_CMD_DO_MOTOR_TEST,
        param1: 3, // motorSeq (1-based test-order number, not a servo channel)
        param2: 0, // throttle_type: 0 = percent
        param3: 20,
      })
      // param4 (timeout) round-trips through a float32 wire encoding -- compare
      // with tolerance rather than exact equality.
      expect(Number(cmds[0].param4)).toBeCloseTo(0.8, 5)

      transport.feed(ackFrame({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED }))
      await flush()
      const ack = await promise
      expect(ack.result).toBe(MAV_RESULT_ACCEPTED)
    })

    it('defaults timeoutS to a short renewal-friendly value (0.5-1s)', async () => {
      const promise = runMotorTest(session, { motorSeq: 1, throttlePercent: 10 })
      await flush()
      const cmds = decodeCommandLongs(transport.sent)
      const timeout = Number(cmds[0].param4)
      expect(timeout).toBeGreaterThanOrEqual(0.5)
      expect(timeout).toBeLessThanOrEqual(1)

      transport.feed(ackFrame({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
    })

    it('hard-clamps throttlePercent above MOTOR_TEST_MAX_PERCENT (30) down to 30', async () => {
      const promise = runMotorTest(session, { motorSeq: 1, throttlePercent: 50, timeoutS: 1 })
      await flush()
      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds[0].param3).toBe(MOTOR_TEST_MAX_PERCENT)
      expect(MOTOR_TEST_MAX_PERCENT).toBe(30)

      transport.feed(ackFrame({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
    })

    it('hard-clamps negative throttlePercent up to 0', async () => {
      const promise = runMotorTest(session, { motorSeq: 1, throttlePercent: -5, timeoutS: 1 })
      await flush()
      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds[0].param3).toBe(0)

      transport.feed(ackFrame({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
    })

    it('resolves off the committed cmd-209 ACK fixture (frames-m2.bin)', async () => {
      const promise = runMotorTest(session, { motorSeq: 1, throttlePercent: 10, timeoutS: 1 })
      await flush()
      transport.feed(fixtureBytes)
      await flush()
      const ack = await promise
      expect(ack).toMatchObject({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED })
    })

    it('sends a single attempt (retries forced to 0, DO_MOTOR_TEST is a DANGEROUS_COMMAND) on ACK timeout', async () => {
      const promise = runMotorTest(session, { motorSeq: 1, throttlePercent: 10, timeoutS: 1 })
      const rejection = expect(promise).rejects.toBeInstanceOf(CommandTimeoutError)
      await flush()
      await vi.advanceTimersByTimeAsync(5000)
      await rejection
      // Only the initial send -- no retransmits for a DANGEROUS_COMMAND.
      expect(decodeCommandLongs(transport.sent)).toHaveLength(1)
    })

    it.each([0, -1, 1.5, Number.NaN])(
      'throws MotorTestUsageError synchronously (nothing sent) for an invalid motorSeq=%s',
      (motorSeq) => {
        expect(() => runMotorTest(session, { motorSeq, throttlePercent: 10 })).toThrow(MotorTestUsageError)
        expect(transport.sent).toHaveLength(0)
      },
    )
  })

  describe('stopMotorTest', () => {
    it('sends DO_MOTOR_TEST with throttle_value=0 and timeout=0 (immediate stop per source)', async () => {
      const promise = stopMotorTest(session, 2)
      await flush()
      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({
        command: MAV_CMD_DO_MOTOR_TEST,
        param1: 2,
        param2: 0,
        param3: 0,
        param4: 0,
      })

      transport.feed(ackFrame({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED }))
      await flush()
      const ack = await promise
      expect(ack?.result).toBe(MAV_RESULT_ACCEPTED)
    })

    it('defaults motorSeq to 1 when omitted', async () => {
      const promise = stopMotorTest(session)
      await flush()
      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds[0].param1).toBe(1)

      transport.feed(ackFrame({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
    })

    it('resolves (does not throw) on an ACK timeout -- safety layer must not be blocked by an unconfirmable stop', async () => {
      const promise = stopMotorTest(session, 1)
      await flush()
      await vi.advanceTimersByTimeAsync(5000)
      const result = await promise
      expect(result).toBeUndefined()
    })

    it('still throws for a genuine programming error (CommandUsageError), only swallows timeouts', async () => {
      const sendCommandFn = vi.fn(async (): Promise<CommandAck> => {
        throw new Error('boom')
      })
      await expect(stopMotorTest(session, 1, { sendCommandFn })).rejects.toThrow('boom')
    })

    it.each([0, -1, 2.5, Number.NaN])('rejects with MotorTestUsageError for an invalid explicit motorSeq=%s, without sending', async (motorSeq) => {
      await expect(stopMotorTest(session, motorSeq)).rejects.toBeInstanceOf(MotorTestUsageError)
      await flush()
      expect(transport.sent).toHaveLength(0)
    })
  })

  describe('stopAllMotors', () => {
    it('loops DO_MOTOR_TEST stop across motorCount motors, 1-based', async () => {
      const promise = stopAllMotors(session, 3)
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED }))
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED }))
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise

      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds.map((c) => c.param1)).toEqual([1, 2, 3])
      expect(cmds.every((c) => c.param3 === 0 && c.param4 === 0)).toBe(true)
    })

    it('does not throw even if every stop in the loop times out (stopMotorTest already swallows those, so no failures are reported)', async () => {
      const promise = stopAllMotors(session, 2)
      await flush()
      await vi.advanceTimersByTimeAsync(5000)
      await flush()
      await vi.advanceTimersByTimeAsync(5000)
      await expect(promise).resolves.toEqual([])
    })

    it('continues past a non-timeout failure on one motor -- every motor is still attempted', async () => {
      const sendCommandFn = vi.fn(async (_router, _target, cmd): Promise<CommandAck> => {
        if (cmd.param1 === 2) throw new Error('boom on motor 2')
        return { command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED, progress: 0, resultParam2: 0 }
      })

      const failures = await stopAllMotors(session, 4, { sendCommandFn })

      // All 4 motors attempted, in order, despite motor 2's failure.
      expect(sendCommandFn).toHaveBeenCalledTimes(4)
      expect(sendCommandFn.mock.calls.map((c) => c[2].param1)).toEqual([1, 2, 3, 4])
      expect(failures).toEqual([{ motorSeq: 2, error: expect.any(Error) }])
    })
  })

  describe('injected sendCommandFn', () => {
    it('runMotorTest threads a caller-supplied commandTimeoutMs through to sendCommandFn', async () => {
      const sendCommandFn = vi.fn(async (): Promise<CommandAck> => ({ command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED, progress: 0, resultParam2: 0 }))
      await runMotorTest(session, { motorSeq: 1, throttlePercent: 10, timeoutS: 1 }, { sendCommandFn, commandTimeoutMs: 9000 })
      expect(sendCommandFn).toHaveBeenCalledWith(
        session.router,
        session.target,
        expect.objectContaining({ command: MAV_CMD_DO_MOTOR_TEST, param1: 1, param2: 0, param3: 10, param4: 1 }),
        { timeoutMs: 9000 },
      )
    })
  })
})
