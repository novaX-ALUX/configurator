import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../App'
import { MotorTestPage } from '../MotorTestPage'
import { useConnectionStore } from '../../../store/connection'
import { useNavigationStore } from '../../../store/navigation'
import { useMotorTestStore } from '../motorTestStore'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { encodeFrame, FrameParser } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { decodePayload } from '../../../core/mavlink/decode'
import { MavRouter } from '../../../core/mavlink/router'
import { ParamStore } from '../../../core/mavlink/params'
import type { MavSession } from '../../../core/mavlink/session'

const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77
const PARAM_SET_MSGID = 23
const MAV_CMD_DO_MOTOR_TEST = 209
const MAV_RESULT_ACCEPTED = 0

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, 1, 1)
}

function ackFrame(): Uint8Array {
  return frame(COMMAND_ACK_MSGID, { command: MAV_CMD_DO_MOTOR_TEST, result: MAV_RESULT_ACCEPTED, progress: 0, result_param2: 0 })
}

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

/** Every `PARAM_SET` (msgid 23) frame ever sent -- used to assert `ManualMapGuide` never writes `SERVOx_FUNCTION` (or anything else). */
function decodeParamSets(sent: Uint8Array[]): Array<Record<string, unknown>> {
  const parser = new FrameParser(defs)
  const out: Array<Record<string, unknown>> = []
  for (const bytes of sent) {
    const [f] = parser.push(bytes)
    if (f.msgid === PARAM_SET_MSGID) out.push(decodePayload(defs, f).fields)
  }
  return out
}

async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** Advances fake time in `stepMs` increments, awaiting a flush at each step -- needed for the page's own ~200ms tick interval and `MotorSafety`'s stall-detection (a single huge jump reads as a stalled tick loop, see `motorSafety.ts`). */
async function advance(totalMs: number, stepMs = 200): Promise<void> {
  let remaining = totalMs
  while (remaining > 0) {
    const step = Math.min(stepMs, remaining)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step)
    })
    remaining -= step
  }
}

/** Feeds one ACCEPTED ack per pending DO_MOTOR_TEST, settling `stopAllMotors`'s sequential per-motor loop. */
async function settleStopAcks(transport: MockTransport, count: number): Promise<void> {
  await tick()
  for (let i = 0; i < count; i++) {
    transport.feed(ackFrame())
    await tick()
  }
}

async function connectSession(frameClass = 1, frameType = 1): Promise<{ transport: MockTransport; session: MavSession }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const target = { sysid: 1, compid: 1 }
  const paramStore = new ParamStore(router, target)
  // Minimal double for the one thing any `useTelemetry(session)` consumer
  // reads (`session.telemetry.getState()`/`.subscribe()`) — this file never
  // exercises telemetry itself, but issue #11's globally-mounted
  // TelemetryStrip now renders inside every `<App />` tree, including this
  // one, so the stub needs to satisfy that hook's contract, not just sit
  // unused. Same shape as DashboardPage.test.tsx's own `fakeSession`.
  const telemetry: MavSession['telemetry'] = {
    getState: () => ({}),
    subscribe: () => () => {},
  } as unknown as MavSession['telemetry']
  const session: MavSession = { router, target, paramStore, telemetry }
  useConnectionStore.setState({ phase: 'connected', session, paramStore })
  // Quad X (4 motors) -- feed FRAME_CLASS/FRAME_TYPE straight into the cache
  // via the same PARAM_VALUE path ParamStore itself uses, no fetchAll needed.
  transport.feed(
    frame(22, { param_id: 'FRAME_CLASS', param_value: frameClass, param_type: 6, param_count: 2, param_index: 0 }),
  )
  transport.feed(
    frame(22, { param_id: 'FRAME_TYPE', param_value: frameType, param_type: 6, param_count: 2, param_index: 1 }),
  )
  await tick()
  return { transport, session }
}

/**
 * Arms through the checkbox + Enable button + the real 3s countdown. Safe to
 * call more than once in the same test (e.g. re-arming after a kill switch
 * fired and stopped everything) -- only clicks the checkbox if it isn't
 * already checked, since `propsConfirmed` survives a plain `stop()` (only an
 * explicit uncheck resets it, per `motorSafety.ts`'s own doc) and clicking an
 * already-checked checkbox would toggle it back off.
 */
async function arm(): Promise<void> {
  const checkbox = screen.getByRole('checkbox', { name: /confirm ALL propellers/i })
  if (!(checkbox as HTMLInputElement).checked) fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: /Enable motor outputs/i }))
  await advance(3000)
  expect(screen.getByRole('button', { name: /Outputs enabled/i })).toBeInTheDocument()
}

const initialConnectionState = useConnectionStore.getState()
const initialNavigationState = useNavigationStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  // Drive the real MotorSafety singleton back to a clean 'locked' state --
  // its internal engine isn't reset by useConnectionStore/setState (it's a
  // module-scope singleton, mirrors useConnectionStore itself), so the next
  // test must start from a genuinely fresh arm cycle, not just a
  // reactive-field reset.
  useMotorTestStore.getState().confirmProps(false)
  useMotorTestStore.getState().stop('test cleanup')
  useConnectionStore.setState(initialConnectionState, true)
  useNavigationStore.setState(initialNavigationState, true)
  vi.useRealTimers()
})

describe('MotorTestPage: not connected', () => {
  it('shows the empty state and gates the connect CTA on phase===disconnected', () => {
    const calls: unknown[] = []
    useConnectionStore.setState({
      phase: 'disconnected',
      baud: 115200,
      session: null,
      paramStore: null,
      connect: (baud) => {
        calls.push(baud)
        return Promise.resolve()
      },
    })
    render(<MotorTestPage />)
    expect(screen.getByText(/Motor test needs a connected board/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect flight controller' }))
    expect(calls).toEqual([115200])
  })
})

describe('MotorTestPage: connected but session not yet resolved (Task 5.4 known gap)', () => {
  it('does not show an armable safety gate when phase is connected but session is still null -- shows the waiting/empty state instead', () => {
    // Regression test (calibration/motor-test review finding): the page used
    // to gate its whole interactive UI on `phase === 'connected'` alone.
    // Task 5.4's own documented gap is that `phase` can read 'connected'
    // (HEARTBEAT-driven) before `getComponents()` has resolved a target,
    // leaving `session` still `null` -- and neither `enable()` nor
    // `setMotorPercent` (only `onStop`/`onRenew`) guard on a live session, so
    // without this fix a user could check props/enable/slide while every
    // real FC command silently no-ops: false confidence that a motor test
    // actually ran.
    useConnectionStore.setState({ phase: 'connected', session: null, paramStore: null })
    render(<MotorTestPage />)

    expect(screen.getByText(/Motor test needs a connected board/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Enable motor outputs/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /confirm ALL propellers/i })).not.toBeInTheDocument()
  })
})

describe('MotorTestPage: unknown frame disclosure', () => {
  it('discloses the Quad-X fallback as a placeholder when FRAME_CLASS/FRAME_TYPE have not been fetched, and stops disclosing once they are', async () => {
    const transport = new MockTransport()
    const router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
    const target = { sysid: 1, compid: 1 }
    const paramStore = new ParamStore(router, target)
    const session: MavSession = { router, target, paramStore, telemetry: {} as MavSession['telemetry'] }
    useConnectionStore.setState({ phase: 'connected', session, paramStore }) // deliberately no FRAME_CLASS/FRAME_TYPE fed

    render(<MotorTestPage />)
    expect(screen.getByText(/Frame not loaded yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load parameters' })).toBeInTheDocument()

    // A passively-received PARAM_VALUE (another GCS's write, or the FC's own
    // listener -- ParamStore subscribes from construction, independent of
    // fetchAll()) must make the disclosure disappear once the real frame is
    // known, not just an explicit fetchAll() from this page.
    transport.feed(frame(22, { param_id: 'FRAME_CLASS', param_value: 1, param_type: 6, param_count: 2, param_index: 0 }))
    transport.feed(frame(22, { param_id: 'FRAME_TYPE', param_value: 1, param_type: 6, param_count: 2, param_index: 1 }))
    await tick()
    expect(screen.queryByText(/Frame not loaded yet/i)).not.toBeInTheDocument()
  })
})

describe('MotorTestPage: safety gating', () => {
  it('Enable is disabled unless propsConfirmed && connected; arming counts down to ready', async () => {
    await connectSession()
    render(<MotorTestPage />)

    const enableBtn = screen.getByRole('button', { name: /Enable motor outputs/i })
    expect(enableBtn).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: /confirm ALL propellers/i }))
    expect(screen.getByRole('button', { name: /Enable motor outputs/i })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /Enable motor outputs/i }))
    expect(screen.getByRole('button', { name: /Arming outputs in/i })).toBeInTheDocument()

    await advance(3000)
    expect(screen.getByRole('button', { name: /Outputs enabled/i })).toBeInTheDocument()
  })

  it('sliders are disabled until ready', async () => {
    await connectSession()
    render(<MotorTestPage />)
    expect(screen.getByRole('slider', { name: 'M1' })).toBeDisabled()

    await arm()
    expect(screen.getByRole('slider', { name: 'M1' })).not.toBeDisabled()
  })

  it('moving a slider drives onRenew -> runMotorTest with the value, capped at 30 by the input itself', async () => {
    const { transport } = await connectSession()
    render(<MotorTestPage />)
    await arm()

    transport.sent.length = 0
    fireEvent.change(screen.getByRole('slider', { name: 'M2' }), { target: { value: '25' } })
    // Nothing sent yet -- onRenew only fires from the tick loop.
    await tick()
    expect(decodeMotorTestCmds(transport.sent)).toHaveLength(0)

    await advance(400) // default renewMs
    const cmds = decodeMotorTestCmds(transport.sent)
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({ command: MAV_CMD_DO_MOTOR_TEST, param1: 2, param3: 25 })
    transport.feed(ackFrame())
    await tick()
  })
})

describe('MotorTestPage: the six kill switches', () => {
  async function armAndSpin(transport: MockTransport): Promise<void> {
    await arm()
    fireEvent.change(screen.getByRole('slider', { name: 'M1' }), { target: { value: '20' } })
    await advance(400)
    transport.feed(ackFrame())
    await tick()
    transport.sent.length = 0
  }

  async function expectFullStop(transport: MockTransport, motorCount = 4): Promise<void> {
    expect(screen.getByRole('button', { name: /Enable motor outputs/i })).toBeInTheDocument() // back to 'locked'
    await settleStopAcks(transport, motorCount)
    const cmds = decodeMotorTestCmds(transport.sent)
    expect(cmds.map((c) => c.param1)).toEqual([1, 2, 3, 4])
    expect(cmds.every((c) => c.param3 === 0 && c.param4 === 0)).toBe(true)
    void motorCount
  }

  it('1. window blur stops all motors', async () => {
    const { transport } = await connectSession()
    render(<MotorTestPage />)
    await armAndSpin(transport)
    fireEvent(window, new Event('blur'))
    await expectFullStop(transport)
  })

  it('2. document visibilitychange (hidden) stops all motors', async () => {
    const { transport } = await connectSession()
    render(<MotorTestPage />)
    await armAndSpin(transport)
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    fireEvent(document, new Event('visibilitychange'))
    await expectFullStop(transport)
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })

  it('3. Escape keydown stops all motors', async () => {
    const { transport } = await connectSession()
    render(<MotorTestPage />)
    await armAndSpin(transport)
    fireEvent.keyDown(window, { key: 'Escape' })
    await expectFullStop(transport)
  })

  it('4. leaving the motor page (unmount) stops all motors', async () => {
    const { transport } = await connectSession()
    const { unmount } = render(<MotorTestPage />)
    await armAndSpin(transport)
    unmount()
    await settleStopAcks(transport, 4)
    const cmds = decodeMotorTestCmds(transport.sent)
    expect(cmds.map((c) => c.param1)).toEqual([1, 2, 3, 4])
    expect(cmds.every((c) => c.param3 === 0 && c.param4 === 0)).toBe(true)
  })

  it('5. unchecking props-removed while armed stops all motors', async () => {
    const { transport } = await connectSession()
    render(<MotorTestPage />)
    await armAndSpin(transport)
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm ALL propellers/i }))
    await expectFullStop(transport)
  })

  it('6. STOP ALL button stops all motors', async () => {
    const { transport } = await connectSession()
    render(<MotorTestPage />)
    await armAndSpin(transport)
    fireEvent.click(screen.getByRole('button', { name: 'STOP ALL' }))
    await expectFullStop(transport)
  })
})

describe('MotorTestPage: link-state (not one of the six, same principle)', () => {
  it('disconnecting mid-test stops all motors (still-live session, per link-state doc like Task 8.3)', async () => {
    const { transport } = await connectSession()
    render(<MotorTestPage />)
    await arm()
    fireEvent.change(screen.getByRole('slider', { name: 'M1' }), { target: { value: '15' } })
    await advance(400)
    transport.feed(ackFrame())
    await tick()
    transport.sent.length = 0

    act(() => {
      useConnectionStore.setState({ phase: 'lost' })
    })
    expect(useMotorTestStore.getState().state).toBe('locked')
    await settleStopAcks(transport, 4)
    const cmds = decodeMotorTestCmds(transport.sent)
    expect(cmds.map((c) => c.param1)).toEqual([1, 2, 3, 4])
  })
})

describe('MotorTestPage: sequence test', () => {
  it('cycles M1..M4 at 12%, disabled unless armed', async () => {
    await connectSession()
    render(<MotorTestPage />)
    expect(screen.getByRole('button', { name: /Sequence/i })).toBeDisabled()

    await arm()
    fireEvent.click(screen.getByRole('button', { name: /Sequence/i }))
    expect(screen.getByRole('slider', { name: 'M1' })).toHaveValue('12')

    await advance(900)
    expect(screen.getByRole('slider', { name: 'M1' })).toHaveValue('0')
    expect(screen.getByRole('slider', { name: 'M2' })).toHaveValue('12')

    await advance(900 * 3) // through M3, M4, and the final reset-to-0
    expect(screen.getByRole('slider', { name: 'M4' })).toHaveValue('0')
  })
})

describe('MotorTestPage: adversarial-review regression — a stale sequence timer cannot resurrect a spin after re-arm', () => {
  it("reproduces the reviewer's exact repro end-to-end on a 6-motor frame: sequence test + Escape mid-sequence + re-arm sends zero autonomous spins", async () => {
    const { transport } = await connectSession(2, 1) // Hex X, 6 motors
    render(<MotorTestPage />)
    await arm()

    fireEvent.click(screen.getByRole('button', { name: /Sequence/i }))
    expect(screen.getByRole('slider', { name: 'M1' })).toHaveValue('12')

    // Well before the sequence's own 900ms step -- its interval is still
    // alive. A multiple of `advance`'s own 200ms step keeps it phase-aligned
    // with the page's own tick interval (registered at mount, t=0) so a
    // later `arm()`'s countdown isn't left short by an unrelated fractional
    // remainder -- a test-harness-only concern, not a product timing issue.
    await advance(400)

    transport.sent.length = 0
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('button', { name: /Enable motor outputs/i })).toBeInTheDocument() // back to 'locked'
    await settleStopAcks(transport, 6)

    // Re-arm exactly like a normal recovery.
    await arm()
    // If `sequenceRunning` were still stuck `true` (the old bug: the
    // interval never got cancelled), this button would still show as
    // running/disabled even once fully re-armed.
    expect(screen.getByRole('button', { name: /Sequence/i })).not.toBeDisabled()

    transport.sent.length = 0
    // Advance well past where the old, uncancelled sequence interval would
    // have fired its next step (900ms) and a subsequent renew tick (400ms).
    await advance(900 * 3)

    const spins = decodeMotorTestCmds(transport.sent).filter((c) => Number(c.param3) > 0)
    expect(spins).toEqual([]) // the whole point: no autonomous spin with zero slider interaction
    expect(screen.getAllByRole('slider').every((el) => (el as HTMLInputElement).value === '0')).toBe(true)
  })
})

describe('MotorTestPage: ManualMapGuide never writes SERVOx_FUNCTION', () => {
  it('guides motor-by-motor and only ever sends DO_MOTOR_TEST commands, never a PARAM_SET', async () => {
    const { transport } = await connectSession()
    render(<MotorTestPage />)
    await arm()
    transport.sent.length = 0

    fireEvent.click(screen.getByRole('button', { name: 'Start guide' }))
    expect(screen.getByText(/Spinning position 1/i)).toBeInTheDocument()
    // The guide spins motor 1 through the SAME renewal-gated path as the
    // sliders -- give the tick loop a chance to actually renew it before
    // confirming, so there's a real DO_MOTOR_TEST to assert against below.
    await advance(400)
    transport.feed(ackFrame())
    await tick()

    // Confirm a MISMATCH: user says position 2 spun, not 1.
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(screen.getByText(/Mismatch/i)).toBeInTheDocument()
    expect(screen.getByText(/SERVOx_FUNCTION/i)).toBeInTheDocument() // advises a manual fix, never performs one

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/Spinning position 2/i)).toBeInTheDocument()

    // Confirm the remaining motors as matches.
    for (const n of [2, 3, 4]) {
      await advance(400)
      transport.feed(ackFrame())
      await tick()
      fireEvent.click(screen.getByRole('button', { name: String(n) }))
      expect(screen.getByText(/Matches/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /Next|Close/i }))
    }
    expect(screen.getByText(/Guide complete/i)).toBeInTheDocument()

    expect(decodeParamSets(transport.sent)).toHaveLength(0)
    const cmds = decodeMotorTestCmds(transport.sent)
    expect(cmds.length).toBeGreaterThan(0) // it really did spin motors via the safety-gated path
  })

  it('adversarial-review regression: a stop mid-guide resets its step to idle and does not resurrect a spin on re-arm', async () => {
    const { transport } = await connectSession()
    render(<MotorTestPage />)
    await arm()

    fireEvent.click(screen.getByRole('button', { name: 'Start guide' }))
    expect(screen.getByText(/Spinning position 1/i)).toBeInTheDocument()

    transport.sent.length = 0
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('button', { name: /Enable motor outputs/i })).toBeInTheDocument() // back to 'locked'
    // The guide must not still be showing a stale "spinning"/result screen --
    // it's back to its own idle "Start guide" affordance.
    expect(screen.getByRole('button', { name: 'Start guide' })).toBeInTheDocument()
    expect(screen.queryByText(/Spinning position/i)).not.toBeInTheDocument()
    await settleStopAcks(transport, 4)

    await arm()
    expect(screen.getByRole('button', { name: 'Start guide' })).not.toBeDisabled()

    transport.sent.length = 0
    await advance(1200) // well past a renew cycle -- nothing should fire on its own
    const spins = decodeMotorTestCmds(transport.sent).filter((c) => Number(c.param3) > 0)
    expect(spins).toEqual([]) // no autonomous spin just because a stop happened mid-guide
  })
})

describe('App: global safety banners', () => {
  function goToMotors(): void {
    act(() => {
      useNavigationStore.getState().setActivePage('motors')
    })
  }

  it('amber banner shows once armed (ready), and LOCK OUTPUTS stops it', async () => {
    await connectSession()
    goToMotors()
    render(<App />)

    expect(screen.queryByText('MOTOR OUTPUTS ENABLED')).not.toBeInTheDocument()
    await arm()
    expect(screen.getByText('MOTOR OUTPUTS ENABLED')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'LOCK OUTPUTS' }))
    expect(screen.queryByText('MOTOR OUTPUTS ENABLED')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Enable motor outputs/i })).toBeInTheDocument()
  })

  it('red banner shows once a motor is actually spinning (testing), mutually exclusive with amber, and STOP ALL stops it', async () => {
    const { transport } = await connectSession()
    goToMotors()
    render(<App />)
    await arm()

    fireEvent.change(screen.getByRole('slider', { name: 'M1' }), { target: { value: '10' } })
    expect(screen.getByText('MOTOR TEST ACTIVE')).toBeInTheDocument()
    expect(screen.queryByText('MOTOR OUTPUTS ENABLED')).not.toBeInTheDocument()

    await advance(400)
    transport.feed(ackFrame())
    await tick()

    const banner = screen.getByText('MOTOR TEST ACTIVE').closest('div') as HTMLElement
    fireEvent.click(within(banner).getByRole('button', { name: 'STOP ALL' }))
    expect(screen.queryByText('MOTOR TEST ACTIVE')).not.toBeInTheDocument()
    await settleStopAcks(transport, 4)
  })
})
