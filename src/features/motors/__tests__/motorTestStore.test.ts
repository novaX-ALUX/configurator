import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { decodePayload } from '../../../core/mavlink/decode'
import { encodeFrame, FrameParser } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { MavRouter } from '../../../core/mavlink/router'
import type { MavSession } from '../../../core/mavlink/session'
import { createMotorTestStore, type MotorTestState } from '../motorTestStore'

const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77
const MAV_CMD_DO_MOTOR_TEST = 209
const MAV_RESULT_ACCEPTED = 0

function ackFrame(): Uint8Array {
  return encodeFrame(
    defs,
    { msgid: COMMAND_ACK_MSGID, payload: encodePayload(defs, COMMAND_ACK_MSGID, { command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED, progress: 0, result_param2: 0 }) },
    0,
    1,
    1,
  )
}

/** Decodes every COMMAND_LONG (cmd=209 DO_MOTOR_TEST) frame in `sent`, in order. */
function decodeMotorTestCmds(sent: Uint8Array[]): Array<Record<string, unknown>> {
  const parser = new FrameParser(defs)
  const out: Array<Record<string, unknown>> = []
  for (const bytes of sent) {
    const [f] = parser.push(bytes)
    if (f.msgid === COMMAND_LONG_MSGID) {
      const fields = decodePayload(defs, f).fields
      if (fields.command === MAV_CMD_DO_MOTOR_TEST) out.push(fields)
    }
  }
  return out
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/**
 * Feeds one ACCEPTED ack per pending COMMAND_LONG, settling `stopAllMotors`'s
 * sequential per-motor loop (Task 9.2: each `stopMotorTest` call awaits its
 * own ACK before the next motor is even sent) -- same flush-then-feed
 * cadence `motorTest.test.ts`'s own `stopAllMotors` tests use.
 */
async function settleAcks(transport: MockTransport, count: number): Promise<void> {
  await flush()
  for (let i = 0; i < count; i++) {
    transport.feed(ackFrame())
    await flush()
  }
}

describe('motorTestStore', () => {
  let clock: number
  let store: ReturnType<typeof createMotorTestStore>
  let transport: MockTransport
  let router: MavRouter
  let session: MavSession

  function advance(ms: number): void {
    clock += ms
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    clock = 0
    store = createMotorTestStore(() => clock)
    transport = new MockTransport()
    router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
    session = { router, target: { sysid: 1, compid: 1 }, paramStore: {} as MavSession['paramStore'], telemetry: {} as MavSession['telemetry'] }
    store.getState().setSessionInfo(session, 4)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function arm(): void {
    store.getState().confirmProps(true)
    store.getState().enable()
    advance(store.getState().countdown || 3000)
    store.getState().tick()
  }

  it('starts locked/unconfirmed', () => {
    const s = store.getState()
    expect(s.state).toBe('locked')
    expect(s.propsConfirmed).toBe(false)
  })

  it('enable() is a no-op without propsConfirmed, and arms through counting -> ready once confirmed', () => {
    store.getState().enable()
    expect(store.getState().state).toBe('locked')

    arm()
    expect(store.getState().state).toBe('ready')
  })

  describe('the six kill switches all call MotorSafety.stop AND send a real FC stop to every motor', () => {
    async function assertKillSwitchStops(trigger: (s: MotorTestState & ReturnType<typeof store.getState>) => void): Promise<void> {
      arm()
      store.getState().setMotorPercent(1, 20)
      expect(store.getState().state).toBe('testing')
      transport.sent.length = 0

      trigger(store.getState() as MotorTestState & ReturnType<typeof store.getState>)
      expect(store.getState().state).toBe('locked')
      expect(store.getState().percents).toEqual({})

      // stopAllMotors(session, 4) sends sequentially (Task 9.2: one at a time,
      // each awaiting its own ACK before the next) -- feed one ACK per motor.
      await settleAcks(transport, 4)
      const cmds = decodeMotorTestCmds(transport.sent)
      expect(cmds.map((c) => c.param1)).toEqual([1, 2, 3, 4])
      expect(cmds.every((c) => c.param3 === 0 && c.param4 === 0)).toBe(true)
    }

    it('1. window blur -> stop("Window lost focus")', async () => {
      await assertKillSwitchStops((s) => s.stop('Window lost focus'))
    })

    it('2. visibilitychange hidden -> stop("Tab hidden")', async () => {
      await assertKillSwitchStops((s) => s.stop('Tab hidden'))
    })

    it('3. Escape -> stop("ESC pressed")', async () => {
      await assertKillSwitchStops((s) => s.stop('ESC pressed'))
    })

    it('4. leaving the motor page -> stop("Left Motor Test page")', async () => {
      await assertKillSwitchStops((s) => s.stop('Left Motor Test page'))
    })

    it('5. unchecking props-removed while armed -> stop("Prop confirmation revoked") via confirmProps(false)', async () => {
      await assertKillSwitchStops((s) => s.confirmProps(false))
    })

    it('6. STOP button -> stop("STOP pressed")', async () => {
      await assertKillSwitchStops((s) => s.stop('STOP pressed'))
    })
  })

  it('a stop with no live session transitions to locked without throwing (nothing to send to)', () => {
    store.getState().setSessionInfo(null, 4)
    arm()
    expect(() => store.getState().stop('Window lost focus')).not.toThrow()
    expect(store.getState().state).toBe('locked')
  })

  it('setMotorPercent moves ready -> testing, and the tick loop renews via runMotorTest with the capped percent', async () => {
    arm()
    store.getState().setMotorPercent(2, 45) // above MOTOR_TEST_MAX_PERCENT (30) -- must clamp
    expect(store.getState().state).toBe('testing')
    expect(store.getState().percents[2]).toBe(30)

    // Nothing sent yet -- onRenew only fires from tick(), not from the slider move itself.
    await flush()
    expect(transport.sent).toHaveLength(0)

    advance(400) // default renewMs
    store.getState().tick()
    await flush()

    const cmds = decodeMotorTestCmds(transport.sent)
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({ command: MAV_CMD_DO_MOTOR_TEST, param1: 2, param3: 30 })
    await settleAcks(transport, 1)
  })

  it('slider disabled/no-op path: moving it back to 0 returns to ready without a stop', () => {
    arm()
    store.getState().setMotorPercent(1, 10)
    expect(store.getState().state).toBe('testing')
    store.getState().setMotorPercent(1, 0)
    expect(store.getState().state).toBe('ready')
  })
})
