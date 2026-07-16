import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../transport/mock'
import { defs } from '../defs'
import { decodePayload } from '../decode'
import { encodeFrame, FrameParser } from '../frame'
import { encodePayload } from '../encode'
import { MavRouter } from '../router'
import { type CommandAck } from '../command'
import type { MavSession } from '../session'
import { rebootFlightController } from '../reboot'

const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77
const MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN = 246
const MAV_RESULT_ACCEPTED = 0

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0, sysid = 7, compid = 3): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, sysid, compid)
}

function ackFrame(opts: { result: number }): Uint8Array {
  return frame(COMMAND_ACK_MSGID, { command: MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, result: opts.result, progress: 0, result_param2: 0 })
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

describe('rebootFlightController', () => {
  let transport: MockTransport
  let router: MavRouter
  // Deliberately not sysid/compid 1/1 -- proves the command targets whatever
  // the Session's own target is, never a hardcoded pair (ADR-0002 rule 3).
  const target = { sysid: 7, compid: 3 }
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

  it('sends MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN with param1=1, addressed to the Session\'s own target', async () => {
    const promise = rebootFlightController(session)
    await flush()

    const cmds = decodeCommandLongs(transport.sent)
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({
      target_system: 7,
      target_component: 3,
      command: MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
      param1: 1,
    })

    transport.feed(ackFrame({ result: MAV_RESULT_ACCEPTED }))
    await flush()
    const ack = await promise
    expect(ack?.result).toBe(MAV_RESULT_ACCEPTED)
  })

  it('resolves with the ACK for any final result (not just ACCEPTED) -- policy is the caller\'s', async () => {
    const promise = rebootFlightController(session)
    await flush()
    transport.feed(ackFrame({ result: 4 })) // MAV_RESULT_FAILED
    await flush()
    const ack = await promise
    expect(ack?.result).toBe(4)
  })

  it('sends a single attempt (retries forced to 0, a DANGEROUS_COMMAND) and resolves undefined on ACK timeout -- the FC often resets before replying', async () => {
    const promise = rebootFlightController(session)
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise
    expect(result).toBeUndefined()
    // Only the initial send -- no retransmits for a DANGEROUS_COMMAND.
    expect(decodeCommandLongs(transport.sent)).toHaveLength(1)
  })

  it('still propagates a non-timeout rejection (e.g. a transport send failure)', async () => {
    const sendCommandFn = vi.fn(async (): Promise<CommandAck> => {
      throw new Error('boom')
    })
    await expect(rebootFlightController(session, { sendCommandFn })).rejects.toThrow('boom')
  })

  it('threads a caller-supplied commandTimeoutMs through to sendCommandFn', async () => {
    const sendCommandFn = vi.fn(async (): Promise<CommandAck> => ({
      command: MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
      result: MAV_RESULT_ACCEPTED,
      progress: 0,
      resultParam2: 0,
    }))
    await rebootFlightController(session, { sendCommandFn, commandTimeoutMs: 9000 })
    expect(sendCommandFn).toHaveBeenCalledWith(
      session.router,
      session.target,
      { command: MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, param1: 1 },
      { timeoutMs: 9000 },
    )
  })
})
