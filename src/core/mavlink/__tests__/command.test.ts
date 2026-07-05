import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../transport/mock'
import { defs } from '../defs'
import { decodePayload } from '../decode'
import { encodeFrame, FrameParser } from '../frame'
import { encodePayload } from '../encode'
import { MavRouter } from '../router'
import {
  CommandTimeoutError,
  CommandUsageError,
  DANGEROUS_COMMANDS,
  sendCommand,
  type CommandLongSpec,
} from '../command'
import {
  MAV_CMD_ACCELCAL_VEHICLE_POS,
  MAV_CMD_DO_ACCEPT_MAG_CAL,
  MAV_CMD_DO_CANCEL_MAG_CAL,
  MAV_CMD_DO_START_MAG_CAL,
} from '../commandIds'

const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77

const MAV_CMD_COMPONENT_ARM_DISARM = 400
const MAV_CMD_DO_SET_MODE = 176 // an arbitrary non-dangerous command
const MAV_RESULT_ACCEPTED = 0
const MAV_RESULT_DENIED = 1
const MAV_RESULT_IN_PROGRESS = 5

function ackFrame(opts: {
  command: number
  result: number
  progress?: number
  resultParam2?: number
  sysid?: number
  compid?: number
  seq?: number
}): Uint8Array {
  const payload = encodePayload(defs, COMMAND_ACK_MSGID, {
    command: opts.command,
    result: opts.result,
    progress: opts.progress ?? 0,
    result_param2: opts.resultParam2 ?? 0,
  })
  return encodeFrame(defs, { msgid: COMMAND_ACK_MSGID, payload }, opts.seq ?? 0, opts.sysid ?? 1, opts.compid ?? 1)
}

function decodeSentCommandLong(bytes: Uint8Array): Record<string, unknown> {
  const parser = new FrameParser(defs)
  const [frame] = parser.push(bytes)
  expect(frame.msgid).toBe(COMMAND_LONG_MSGID)
  return decodePayload(defs, frame).fields
}

/** Subscriber-count introspection for leak tests — MavRouter has no public API for this, so we reach into its private field carefully (documented in the task brief as an accepted approach). */
function subscriberCount(router: MavRouter): number {
  return (router as unknown as { subscribers: Set<unknown> }).subscribers.size
}

describe('sendCommand', () => {
  let transport: MockTransport
  let router: MavRouter
  const target = { sysid: 1, compid: 1 }

  beforeEach(async () => {
    vi.useFakeTimers()
    transport = new MockTransport()
    router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a COMMAND_LONG with confirmation=0 and the given params/target on the first attempt', async () => {
    const cmd: CommandLongSpec = { command: MAV_CMD_DO_SET_MODE, param1: 1, param2: 4 }
    const promise = sendCommand(router, target, cmd)

    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sent).toHaveLength(1)
    const fields = decodeSentCommandLong(transport.sent[0])
    expect(fields).toMatchObject({
      target_system: 1,
      target_component: 1,
      command: MAV_CMD_DO_SET_MODE,
      confirmation: 0,
      param1: 1,
      param2: 4,
    })

    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_ACCEPTED }))
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toEqual({
      command: MAV_CMD_DO_SET_MODE,
      result: MAV_RESULT_ACCEPTED,
      progress: 0,
      resultParam2: 0,
    })
  })

  it('resolves with a non-ACCEPTED final result too (rejecting on that is the caller\'s policy)', async () => {
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE })
    await vi.advanceTimersByTimeAsync(0)

    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_DENIED }))
    await vi.advanceTimersByTimeAsync(0)

    await expect(promise).resolves.toEqual({
      command: MAV_CMD_DO_SET_MODE,
      result: MAV_RESULT_DENIED,
      progress: 0,
      resultParam2: 0,
    })
  })

  it('ignores an ACK for a different command from the same target', async () => {
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE }, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(0)

    transport.feed(ackFrame({ command: 999, result: MAV_RESULT_ACCEPTED }))
    await vi.advanceTimersByTimeAsync(0)

    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_ACCEPTED }))
    await vi.advanceTimersByTimeAsync(0)

    await expect(promise).resolves.toMatchObject({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_ACCEPTED })
  })

  it('ignores an ACK for the right command from a different source (sysid/compid)', async () => {
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE }, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(0)

    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_ACCEPTED, sysid: 2, compid: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0) // still waiting, not resolved by the wrong-source ACK

    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_ACCEPTED }))
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toMatchObject({ result: MAV_RESULT_ACCEPTED })
  })

  it('MAV_RESULT_IN_PROGRESS resets the timeout window and surfaces progress via onProgress, without resolving', async () => {
    const onProgress = vi.fn()
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE }, { timeoutMs: 1000, onProgress })

    await vi.advanceTimersByTimeAsync(0)
    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_IN_PROGRESS, progress: 42 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(onProgress).toHaveBeenCalledWith(42, 0)

    // Would have timed out at 1000ms from the original send, but IN_PROGRESS reset the window.
    await vi.advanceTimersByTimeAsync(900)
    expect(transport.sent).toHaveLength(1) // no retransmission yet

    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_ACCEPTED }))
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toMatchObject({ result: MAV_RESULT_ACCEPTED })
  })

  it('rejects with CommandTimeoutError after opts.maxProgressResets consecutive IN_PROGRESS ACKs, without ever retransmitting', async () => {
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE }, { timeoutMs: 100, maxProgressResets: 2 })
    const rejection = expect(promise).rejects.toBeInstanceOf(CommandTimeoutError)

    await vi.advanceTimersByTimeAsync(0)
    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_IN_PROGRESS, progress: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_IN_PROGRESS, progress: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_IN_PROGRESS, progress: 3 }))
    await vi.advanceTimersByTimeAsync(0)

    expect(transport.sent).toHaveLength(1) // IN_PROGRESS never triggers a retransmission, capped or not
    await rejection
  })

  it('retransmits on timeout with an incrementing confirmation field, then resolves once an ACK arrives', async () => {
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE }, { timeoutMs: 100, retries: 2 })

    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sent).toHaveLength(1)
    expect(decodeSentCommandLong(transport.sent[0]).confirmation).toBe(0)

    await vi.advanceTimersByTimeAsync(100) // 1st timeout -> retransmit
    expect(transport.sent).toHaveLength(2)
    expect(decodeSentCommandLong(transport.sent[1]).confirmation).toBe(1)

    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_ACCEPTED }))
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toMatchObject({ result: MAV_RESULT_ACCEPTED })
  })

  it('rejects with CommandTimeoutError after exhausting all retries with no ACK', async () => {
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE }, { timeoutMs: 100, retries: 2 })
    // Attached before advancing timers: the promise may reject synchronously
    // inside advanceTimersByTimeAsync below, and a handler must already be
    // attached at that point to avoid an unhandled-rejection warning.
    const rejection = expect(promise).rejects.toBeInstanceOf(CommandTimeoutError)

    await vi.advanceTimersByTimeAsync(0) // attempt 1
    await vi.advanceTimersByTimeAsync(100) // attempt 2 (retry 1)
    await vi.advanceTimersByTimeAsync(100) // attempt 3 (retry 2)
    await vi.advanceTimersByTimeAsync(100) // final timeout, no more retries

    expect(transport.sent).toHaveLength(3)
    await rejection
    expect(subscriberCount(router)).toBe(0) // unsubscribed on the rejecting exit path
  })

  it('a DANGEROUS_COMMANDS entry makes a single attempt and rejects with CommandTimeoutError on timeout (no retransmission)', async () => {
    expect(DANGEROUS_COMMANDS.has(MAV_CMD_COMPONENT_ARM_DISARM)).toBe(true)
    const promise = sendCommand(router, target, { command: MAV_CMD_COMPONENT_ARM_DISARM, param1: 1 }, { timeoutMs: 100 })
    const rejection = expect(promise).rejects.toBeInstanceOf(CommandTimeoutError)

    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sent).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(transport.sent).toHaveLength(1) // no retransmission at all

    await rejection
  })

  it('throws CommandUsageError synchronously (nothing sent) if opts.retries > 0 is given for a dangerous command', async () => {
    expect(() =>
      sendCommand(router, target, { command: MAV_CMD_COMPONENT_ARM_DISARM }, { retries: 1 }),
    ).toThrow(CommandUsageError)
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sent).toHaveLength(0)
  })

  describe.each([
    ['MAV_CMD_DO_START_MAG_CAL', MAV_CMD_DO_START_MAG_CAL],
    ['MAV_CMD_DO_ACCEPT_MAG_CAL', MAV_CMD_DO_ACCEPT_MAG_CAL],
    ['MAV_CMD_DO_CANCEL_MAG_CAL', MAV_CMD_DO_CANCEL_MAG_CAL],
    ['MAV_CMD_ACCELCAL_VEHICLE_POS', MAV_CMD_ACCELCAL_VEHICLE_POS],
  ])('%s as a DANGEROUS_COMMANDS entry', (_name, commandId) => {
    it('is registered in DANGEROUS_COMMANDS', () => {
      expect(DANGEROUS_COMMANDS.has(commandId)).toBe(true)
    })

    it('throws CommandUsageError synchronously (nothing sent) if opts.retries > 0', async () => {
      expect(() => sendCommand(router, target, { command: commandId }, { retries: 1 })).toThrow(CommandUsageError)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent).toHaveLength(0)
    })

    it('makes a single attempt with default/0 retries and rejects with CommandTimeoutError on timeout (no retransmission)', async () => {
      const promise = sendCommand(router, target, { command: commandId }, { timeoutMs: 100 })
      const rejection = expect(promise).rejects.toBeInstanceOf(CommandTimeoutError)

      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(100)
      expect(transport.sent).toHaveLength(1) // no retransmission at all

      await rejection
    })
  })

  it('an already-aborted signal rejects immediately with nothing sent', async () => {
    const controller = new AbortController()
    controller.abort()
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE }, { signal: controller.signal })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })

    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sent).toHaveLength(0)
    await rejection
  })

  it('aborting mid-wait unsubscribes and rejects, and a late-arriving ACK no longer has any effect', async () => {
    const controller = new AbortController()
    const before = subscriberCount(router)
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE }, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    expect(subscriberCount(router)).toBe(before + 1)

    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(subscriberCount(router)).toBe(before) // unsubscribed

    // A late ACK must not throw/resolve/reject again (promise already settled).
    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_ACCEPTED }))
    await vi.advanceTimersByTimeAsync(0)
  })

  it('unsubscribes after a normal resolve (no subscriber leak)', async () => {
    const before = subscriberCount(router)
    const promise = sendCommand(router, target, { command: MAV_CMD_DO_SET_MODE })
    await vi.advanceTimersByTimeAsync(0)
    transport.feed(ackFrame({ command: MAV_CMD_DO_SET_MODE, result: MAV_RESULT_ACCEPTED }))
    await vi.advanceTimersByTimeAsync(0)
    await promise
    expect(subscriberCount(router)).toBe(before)
  })
})
