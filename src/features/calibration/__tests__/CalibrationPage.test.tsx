import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { CalibrationPage } from '../CalibrationPage'
import { useConnectionStore } from '../../../store/connection'
import { useActivityLog } from '../../../store/activityLog'
import { useCalibrationProgress } from '../calibrationProgress'
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
const PARAM_VALUE_MSGID = 22
const MAG_CAL_PROGRESS_MSGID = 191
const MAG_CAL_REPORT_MSGID = 192

const MAV_CMD_PREFLIGHT_CALIBRATION = 241
const MAV_CMD_ACCELCAL_VEHICLE_POS = 42429
const MAV_CMD_DO_START_MAG_CAL = 42424
const MAV_CMD_DO_ACCEPT_MAG_CAL = 42425
const MAV_CMD_DO_CANCEL_MAG_CAL = 42426
const MAV_CMD_SET_MESSAGE_INTERVAL = 511

const MAV_RESULT_ACCEPTED = 0
const MAV_RESULT_FAILED = 4

const MAG_CAL_RUNNING_STEP_TWO = 3
const MAG_CAL_SUCCESS = 4
const MAV_PARAM_TYPE_REAL32 = 9
const MAV_PARAM_TYPE_INT32 = 6

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, 1, 1)
}

function ackFrame(command: number, result: number): Uint8Array {
  return frame(COMMAND_ACK_MSGID, { command, result, progress: 0, result_param2: 0 })
}

/** Inbound FC->GCS COMMAND_LONG cmd=42429, matching AP_AccelCal's own send_accelcal_vehicle_position shape. */
function accelPosFrame(param1: number): Uint8Array {
  return frame(COMMAND_LONG_MSGID, { target_system: 255, target_component: 0, command: MAV_CMD_ACCELCAL_VEHICLE_POS, confirmation: 0, param1 })
}

function paramValueFrame(name: string, value: number, type = MAV_PARAM_TYPE_REAL32): Uint8Array {
  return frame(PARAM_VALUE_MSGID, { param_id: name, param_value: value, param_type: type, param_count: 1, param_index: 0 })
}

/**
 * `MAG_CAL_PROGRESS`'s `completion_mask` (`uint8_t[10]`) is a numeric array
 * field `encodePayload` deliberately doesn't support (see `encode.ts`'s own
 * doc) -- but it's simply omitted from `fields` here, which `encodePayload`
 * already treats as "leave at its zero default" for any field, array or not
 * (same as every other test file's frame builders never mentioning fields
 * they don't care about). This UI never reads `completionMask`, so a
 * zeroed one is harmless.
 */
/** `calMask` defaults to 0x01 (compass 0 only, i.e. this is the only compass in the run) -- pass 0x03 for a 2-compass scenario. */
function magProgressFrame(compassId: number, completionPct: number, calMask = 0x01): Uint8Array {
  return frame(MAG_CAL_PROGRESS_MSGID, {
    compass_id: compassId,
    cal_mask: calMask,
    cal_status: MAG_CAL_RUNNING_STEP_TWO,
    attempt: 1,
    completion_pct: completionPct,
    direction_x: 0.5,
    direction_y: 0.2,
    direction_z: -0.1,
  })
}

function magReportFrame(compassId: number, ofs: [number, number, number], fitness: number, opts: { calStatus?: number; calMask?: number } = {}): Uint8Array {
  return frame(MAG_CAL_REPORT_MSGID, {
    compass_id: compassId,
    cal_mask: opts.calMask ?? 0x01,
    cal_status: opts.calStatus ?? MAG_CAL_SUCCESS,
    autosaved: 0,
    fitness,
    ofs_x: ofs[0],
    ofs_y: ofs[1],
    ofs_z: ofs[2],
    diag_x: 1,
    diag_y: 1,
    diag_z: 1,
    offdiag_x: 0,
    offdiag_y: 0,
    offdiag_z: 0,
    orientation_confidence: 0.9,
    old_orientation: 0,
    new_orientation: 0,
    scale_factor: 1,
  })
}

function decodeCommandLongs(sent: Uint8Array[]): Array<Record<string, unknown>> {
  const parser = new FrameParser(defs)
  const out: Array<Record<string, unknown>> = []
  for (const bytes of sent) {
    const [f] = parser.push(bytes)
    if (f.msgid === COMMAND_LONG_MSGID) out.push(decodePayload(defs, f).fields)
  }
  return out
}

async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function connectSession(): Promise<{ transport: MockTransport; paramStore: ParamStore; session: MavSession }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const target = { sysid: 1, compid: 1 }
  const paramStore = new ParamStore(router, target)
  const session: MavSession = { router, target, paramStore, telemetry: {} as MavSession['telemetry'] }
  useConnectionStore.setState({ phase: 'connected', session, paramStore })
  return { transport, paramStore, session }
}

/** Drives accel.start() through its ACK, ready for the first face prompt. */
async function startAccel(transport: MockTransport): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Start accel calibration' }))
  await tick()
  transport.feed(ackFrame(MAV_CMD_PREFLIGHT_CALIBRATION, MAV_RESULT_ACCEPTED))
  await tick()
}

/** Drives compass.start() through its 3-command handshake (2x SET_MESSAGE_INTERVAL, then DO_START_MAG_CAL). */
async function startCompass(transport: MockTransport): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Start compass calibration' }))
  await tick()
  transport.feed(ackFrame(MAV_CMD_SET_MESSAGE_INTERVAL, MAV_RESULT_ACCEPTED))
  await tick()
  transport.feed(ackFrame(MAV_CMD_SET_MESSAGE_INTERVAL, MAV_RESULT_ACCEPTED))
  await tick()
  transport.feed(ackFrame(MAV_CMD_DO_START_MAG_CAL, MAV_RESULT_ACCEPTED))
  await tick()
}

const initialConnectionState = useConnectionStore.getState()
const initialCalProgressState = useCalibrationProgress.getState()

beforeEach(() => {
  vi.useFakeTimers()
  useActivityLog.getState().clear()
})

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
  useCalibrationProgress.setState(initialCalProgressState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('CalibrationPage: not connected', () => {
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
    render(<CalibrationPage />)
    expect(screen.getByText('Calibration needs a connected board')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect flight controller' }))
    expect(calls).toEqual([115200])
  })
})

describe('CalibrationPage: accelerometer', () => {
  it('start -> face prompts advance the UI -> capture -> done', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)

    expect(screen.getByText('Start accel calibration')).toBeInTheDocument()
    await startAccel(transport)

    transport.feed(accelPosFrame(1))
    await tick()
    expect(screen.getByText('FACE 1 / 6')).toBeInTheDocument()
    expect(screen.getByText('Level')).toBeInTheDocument()

    const steps: Array<{ face: number; next: number }> = [
      { face: 1, next: 2 },
      { face: 2, next: 3 },
      { face: 3, next: 4 },
      { face: 4, next: 5 },
      { face: 5, next: 6 },
    ]
    for (const { face, next } of steps) {
      transport.sent.length = 0
      fireEvent.click(screen.getByRole('button', { name: 'Capture this face' }))
      await tick()
      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toMatchObject([{ command: MAV_CMD_ACCELCAL_VEHICLE_POS, param1: face }])
      transport.feed(ackFrame(MAV_CMD_ACCELCAL_VEHICLE_POS, MAV_RESULT_ACCEPTED))
      await tick()
      transport.feed(accelPosFrame(next))
      await tick()
      expect(screen.getByText(`FACE ${next} / 6`)).toBeInTheDocument()
    }

    // Face 6 (back): capture, then the FC's SUCCESS sentinel (16777215).
    fireEvent.click(screen.getByRole('button', { name: 'Capture this face' }))
    await tick()
    transport.feed(ackFrame(MAV_CMD_ACCELCAL_VEHICLE_POS, MAV_RESULT_ACCEPTED))
    await tick()
    transport.feed(accelPosFrame(16777215))
    await tick()

    expect(screen.getByText('CALIBRATED')).toBeInTheDocument()
    // Task 10.1's Setup Guide reads this session-scoped flag -- see calibrationProgress.ts's own doc.
    expect(useCalibrationProgress.getState().accelDone).toBe(true)
  })

  it('disconnect mid-sequence shows the honest interrupted copy, latches across reconnect, and clears only on explicit restart', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)

    await startAccel(transport)
    transport.feed(accelPosFrame(1))
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'Capture this face' }))
    await tick()
    transport.feed(ackFrame(MAV_CMD_ACCELCAL_VEHICLE_POS, MAV_RESULT_ACCEPTED))
    await tick()
    transport.feed(accelPosFrame(2))
    await tick()
    expect(screen.getByText('FACE 2 / 6')).toBeInTheDocument()

    // The link drops mid-sequence -- connection.ts mirrors this into `phase`.
    act(() => {
      useConnectionStore.setState({ phase: 'lost' })
    })
    await tick()

    const interruptedText = screen.getByText(/Calibration was interrupted/)
    expect(interruptedText.textContent).not.toMatch(/nothing was written/i)
    expect(interruptedText.textContent).toMatch(/incomplete/i)
    expect(interruptedText.textContent).toMatch(/redo all 6 faces/i)
    expect(screen.queryByText('FACE 2 / 6')).not.toBeInTheDocument()

    // Link recovers -- the banner must NOT silently clear (no stale progress
    // UI reappearing) until the user explicitly acts on it.
    act(() => {
      useConnectionStore.setState({ phase: 'connected' })
    })
    await tick()
    expect(screen.getByText(/Calibration was interrupted/)).toBeInTheDocument()
    expect(screen.queryByText('FACE 2 / 6')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Restart calibration' }))
    await tick()
    expect(screen.queryByText(/Calibration was interrupted/)).not.toBeInTheDocument()
    expect(screen.getByText('Start accel calibration')).toBeInTheDocument()
  })

  it('a disposed instance late-timing-out its own start() does not clobber a fresh attempt after reconnect', async () => {
    // Regression test (code review finding): AccelCalibration.dispose() only
    // unsubscribes from the router -- it does NOT cancel an in-flight
    // sendCommand()'s own timeout timer (accelCal.ts has no real FC-side
    // cancel to hook into either). Without a stale-instance guard, that
    // timer firing well after the user reconnected and started a brand new
    // attempt would overwrite the *new* attempt's live status/error with
    // the old, disposed instance's.
    await connectSession()
    render(<CalibrationPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Start accel calibration' }))
    await tick()
    // The old attempt's PREFLIGHT_CALIBRATION ack is never fed -- its
    // sendCommand() stays pending, timer running, right up until reconnect.

    act(() => {
      useConnectionStore.setState({ phase: 'disconnected', session: null, paramStore: null })
    })
    await tick()
    expect(screen.getByText(/Calibration was interrupted/)).toBeInTheDocument()

    const { transport: newTransport } = await connectSession()
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'Restart calibration' })) // acknowledges the banner -> back to idle
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'Start accel calibration' })) // starts the actual new attempt
    await tick()
    newTransport.feed(ackFrame(MAV_CMD_PREFLIGHT_CALIBRATION, MAV_RESULT_ACCEPTED))
    await tick()
    newTransport.feed(accelPosFrame(1))
    await tick()
    expect(screen.getByText('FACE 1 / 6')).toBeInTheDocument() // the new attempt is genuinely running

    // The old (disposed) instance's own sendCommand() timeout now fires
    // (DEFAULT_COMMAND_TIMEOUT_MS = 5000ms from its original start() call).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    // Must be unaffected: still showing the new attempt's real progress,
    // no error surfaced from the old instance's stale rejection.
    expect(screen.getByText('FACE 1 / 6')).toBeInTheDocument()
    expect(screen.queryByText(/Calibration was interrupted/)).not.toBeInTheDocument()
  })
})

describe('CalibrationPage: compass', () => {
  it('start discloses COMPASS_LEARN=0 (inline + Session Activity), before any progress/report', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Start compass calibration' }))
    await tick()
    expect(screen.getByText(/COMPASS_LEARN=0/)).toBeInTheDocument()
    expect(useActivityLog.getState().entries.map((e) => e.text)).toEqual([expect.stringMatching(/COMPASS_LEARN=0/)])

    transport.feed(ackFrame(MAV_CMD_SET_MESSAGE_INTERVAL, MAV_RESULT_ACCEPTED))
    await tick()
    transport.feed(ackFrame(MAV_CMD_SET_MESSAGE_INTERVAL, MAV_RESULT_ACCEPTED))
    await tick()
    transport.feed(ackFrame(MAV_CMD_DO_START_MAG_CAL, MAV_RESULT_ACCEPTED))
    await tick()
  })

  it('progress ring updates per-compass, then review appears once every compass in cal_mask has reported (multi-compass)', async () => {
    const { transport, paramStore } = await connectSession()
    const setSpy = vi.spyOn(paramStore, 'set')

    render(<CalibrationPage />)
    await startCompass(transport)

    transport.feed(magProgressFrame(0, 45, 0x03))
    await tick()
    expect(screen.getByText('45%')).toBeInTheDocument()
    transport.feed(magProgressFrame(1, 20, 0x03))
    await tick()
    expect(screen.getByText('20%')).toBeInTheDocument()
    expect(screen.getByText('45%')).toBeInTheDocument() // both rings render independently

    // cal_mask (0x03) says 2 compasses are in this run -- compass 0's report
    // alone must not be treated as "everyone's done".
    transport.feed(magReportFrame(0, [-34, 112, -8], 3.0, { calMask: 0x03 }))
    await tick()
    expect(screen.queryByText('Write offsets to board')).not.toBeInTheDocument()

    transport.feed(magReportFrame(1, [5, 6, 7], 4.0, { calMask: 0x03 }))
    await tick()

    expect(screen.getByText('Write offsets to board')).toBeInTheDocument()
    expect(screen.getByText('COMPASS_OFS_X')).toBeInTheDocument()
    expect(screen.getByText('COMPASS_OFS2_X')).toBeInTheDocument()

    // The whole point of the review gate: nothing written before the click.
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('report -> review table shows the before/after diff, including a low-fitness warning badge', async () => {
    const { transport, paramStore } = await connectSession()
    transport.feed(paramValueFrame('COMPASS_OFS_X', -51))
    transport.feed(paramValueFrame('COMPASS_OFS_Y', 96))
    transport.feed(paramValueFrame('COMPASS_OFS_Z', -2))
    transport.feed(paramValueFrame('COMPASS_OFS2_X', 10))
    await tick()
    const setSpy = vi.spyOn(paramStore, 'set')

    render(<CalibrationPage />)
    await startCompass(transport)

    // compass 0's report arrives; compass 1 hasn't reported yet -- must not
    // jump to review with an incomplete multi-compass set.
    transport.feed(magReportFrame(0, [-34, 112, -8], 3.0, { calMask: 0x03 }))
    await tick()
    expect(screen.queryByText('Write offsets to board')).not.toBeInTheDocument()

    // A high-fitness (poor) report for compass 1 -- exercises the low-fitness warning.
    transport.feed(magReportFrame(1, [5, 6, 7], 22.0, { calMask: 0x03 }))
    await tick()

    expect(screen.getByText('Write offsets to board')).toBeInTheDocument()
    expect(screen.getByText('-34')).toBeInTheDocument()
    expect(screen.getByText(/FITNESS 22\.0/)).toBeInTheDocument() // warn badge for the poor-fitness compass
    expect(screen.getByText(/FITNESS 3\.0/)).toBeInTheDocument() // good badge

    expect(setSpy).not.toHaveBeenCalled()
    expect(paramStore.get('COMPASS_OFS_X')?.value).toBe(-51)
  })

  it('accept: ACK-rejected stays in review (nothing written, safe to retry)', async () => {
    const { transport, paramStore } = await connectSession()
    const setSpy = vi.spyOn(paramStore, 'set')
    const fetchAllSpy = vi.spyOn(paramStore, 'fetchAll').mockResolvedValue(undefined)
    render(<CalibrationPage />)
    await startCompass(transport)
    transport.feed(magReportFrame(0, [-34, 112, -8], 3.0))
    await tick()

    transport.sent.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Write offsets to board' }))
    await tick()
    const cmds = decodeCommandLongs(transport.sent)
    expect(cmds).toMatchObject([{ command: MAV_CMD_DO_ACCEPT_MAG_CAL }])
    transport.feed(ackFrame(MAV_CMD_DO_ACCEPT_MAG_CAL, MAV_RESULT_FAILED))
    await tick()

    expect(screen.getByText(/rejected the write — nothing was written/)).toBeInTheDocument()
    expect(screen.getByText('Write offsets to board')).toBeInTheDocument() // still there, safe to retry
    expect(fetchAllSpy).not.toHaveBeenCalled()
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('accept: ACK accepted but confirm fetch fails -> written-but-unconfirmed, distinct message', async () => {
    const { transport, paramStore } = await connectSession()
    vi.spyOn(paramStore, 'fetchAll').mockRejectedValueOnce(new Error('no response'))
    render(<CalibrationPage />)
    await startCompass(transport)
    transport.feed(magReportFrame(0, [-34, 112, -8], 3.0))
    await tick()

    fireEvent.click(screen.getByRole('button', { name: 'Write offsets to board' }))
    await tick()
    transport.feed(ackFrame(MAV_CMD_DO_ACCEPT_MAG_CAL, MAV_RESULT_ACCEPTED))
    await tick()

    expect(screen.getByText(/could not be verified — check the Parameters page/)).toBeInTheDocument()
    expect(screen.getByText('OFFSETS WRITTEN')).toBeInTheDocument()
    expect(screen.queryByText('Write offsets to board')).not.toBeInTheDocument()
  })

  it('accept success -> applied; undo restores the previous snapshot via paramStore.set', async () => {
    const { transport, paramStore } = await connectSession()
    transport.feed(paramValueFrame('COMPASS_OFS_X', -51))
    transport.feed(paramValueFrame('COMPASS_OFS_Y', 96))
    transport.feed(paramValueFrame('COMPASS_OFS_Z', -2))
    await tick()
    vi.spyOn(paramStore, 'fetchAll').mockResolvedValue(undefined)
    const setSpy = vi.spyOn(paramStore, 'set').mockImplementation(async (name, value) => ({ name, value, type: MAV_PARAM_TYPE_REAL32, index: 0 }))

    render(<CalibrationPage />)
    await startCompass(transport)
    transport.feed(magReportFrame(0, [-34, 112, -8], 3.0))
    await tick()

    fireEvent.click(screen.getByRole('button', { name: 'Write offsets to board' }))
    await tick()
    transport.feed(ackFrame(MAV_CMD_DO_ACCEPT_MAG_CAL, MAV_RESULT_ACCEPTED))
    await tick()
    expect(screen.getByText('OFFSETS WRITTEN')).toBeInTheDocument()
    // Task 10.1's Setup Guide reads this session-scoped flag -- see calibrationProgress.ts's own doc.
    expect(useCalibrationProgress.getState().compassApplied).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Undo — restore previous' }))
    await tick()
    expect(setSpy).toHaveBeenCalledWith('COMPASS_OFS_X', -51)
    expect(setSpy).toHaveBeenCalledWith('COMPASS_OFS_Y', 96)
    expect(setSpy).toHaveBeenCalledWith('COMPASS_OFS_Z', -2)
    expect(screen.getByText('Start compass calibration')).toBeInTheDocument()
  })

  it('cancel discards without writing, from both running and review', async () => {
    const { transport, paramStore } = await connectSession()
    const setSpy = vi.spyOn(paramStore, 'set')
    render(<CalibrationPage />)
    await startCompass(transport)

    transport.sent.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Cancel — write nothing' }))
    await tick()
    const cmds = decodeCommandLongs(transport.sent)
    expect(cmds).toMatchObject([{ command: MAV_CMD_DO_CANCEL_MAG_CAL }])
    expect(screen.getByText('Start compass calibration')).toBeInTheDocument()
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('discards from the review screen too, without ever calling paramStore.set', async () => {
    const { transport, paramStore } = await connectSession()
    const setSpy = vi.spyOn(paramStore, 'set')
    render(<CalibrationPage />)
    await startCompass(transport)
    transport.feed(magReportFrame(0, [-34, 112, -8], 3.0))
    await tick()
    expect(screen.getByText('Write offsets to board')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Discard result' }))
    await tick()
    expect(screen.getByText('Start compass calibration')).toBeInTheDocument()
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('disconnect while running/review shows the honest interrupted copy and latches until restart', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)
    await startCompass(transport)
    transport.feed(magReportFrame(0, [-34, 112, -8], 3.0))
    await tick()
    expect(screen.getByText('Write offsets to board')).toBeInTheDocument()

    act(() => {
      useConnectionStore.setState({ phase: 'disconnected', session: null, paramStore: null })
    })
    await tick()
    expect(screen.getByText(/Compass calibration was interrupted/)).toBeInTheDocument()
    expect(screen.queryByText('Write offsets to board')).not.toBeInTheDocument()
  })

  it('a disconnect while accept() is in flight keeps the card mounted so the eventual written-but-unconfirmed message can still surface', async () => {
    // Regression test (code review finding): the interrupted latch only
    // covers 'running'/'review', not 'accepting' -- the window right after
    // clicking "Write offsets to board" but before its ACK arrives. An
    // earlier version of CalibrationPage gated its whole not-connected empty
    // state on `interrupted` alone, so a link drop in exactly that window
    // unmounted CompassCard entirely, hiding the "written but could not be
    // verified" message this feature exists to guarantee is never silent.
    const { transport, paramStore } = await connectSession()
    vi.spyOn(paramStore, 'fetchAll').mockRejectedValueOnce(new Error('no response'))
    render(<CalibrationPage />)
    await startCompass(transport)
    transport.feed(magReportFrame(0, [-34, 112, -8], 3.0))
    await tick()

    fireEvent.click(screen.getByRole('button', { name: 'Write offsets to board' }))
    await tick() // DO_ACCEPT_MAG_CAL sent, ACK not yet fed -- status is 'accepting'

    act(() => {
      useConnectionStore.setState({ phase: 'disconnected' })
    })
    await tick()
    // Must NOT have fallen back to the generic "needs a connected board" page.
    expect(screen.queryByText('Calibration needs a connected board')).not.toBeInTheDocument()

    transport.feed(ackFrame(MAV_CMD_DO_ACCEPT_MAG_CAL, MAV_RESULT_ACCEPTED))
    await tick()
    expect(screen.getByText(/could not be verified — check the Parameters page/)).toBeInTheDocument()
  })
})

describe('CalibrationPage: orientation note', () => {
  it('shows the cached AHRS_ORIENTATION value, or "unknown" when not cached', async () => {
    const { transport } = await connectSession()
    transport.feed(paramValueFrame('AHRS_ORIENTATION', 6, MAV_PARAM_TYPE_INT32))
    await tick()
    render(<CalibrationPage />)
    expect(screen.getByText('6')).toBeInTheDocument()
  })

  it('shows unknown before AHRS_ORIENTATION has ever been fetched', async () => {
    await connectSession()
    render(<CalibrationPage />)
    expect(screen.getByText('unknown')).toBeInTheDocument()
  })
})
