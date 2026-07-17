/**
 * Component-seam tests for the RC-calibration wizard (issue #38), rendered
 * through the real CalibrationPage against a MockTransport + real
 * MavRouter/ParamStore/Telemetry — same style as CalibrationPage.test.tsx.
 * The review-gate acceptance criteria are asserted at the wire: no
 * PARAM_SET frame exists before the review bar's Write is clicked, and
 * every write is followed by a readback-driven status.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { CalibrationPage } from '../CalibrationPage'
import { useConnectionStore } from '../../../store/connection'
import { useCalibrationProgress } from '../calibrationProgress'
import { useRcCalStagedStore } from '../rcCalStagedStore'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { encodeFrame, FrameParser } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { decodePayload } from '../../../core/mavlink/decode'
import { MavRouter } from '../../../core/mavlink/router'
import { ParamStore } from '../../../core/mavlink/params'
import { Telemetry } from '../../../core/mavlink/telemetry'
import type { MavSession } from '../../../core/mavlink/session'

const HEARTBEAT_MSGID = 0
const PARAM_VALUE_MSGID = 22
const PARAM_SET_MSGID = 23
const RC_CHANNELS_MSGID = 65
const MAV_MODE_FLAG_SAFETY_ARMED = 0x80
const MAV_PARAM_TYPE_REAL32 = 9

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

/** `values` is 1-based-channel -> µs; unlisted channels are 0 ("not available"). */
function rcFrame(values: Record<number, number>, seq = 0): Uint8Array {
  const fields: Record<string, number> = { chancount: 16, rssi: 200 }
  for (let i = 1; i <= 18; i++) fields[`chan${i}_raw`] = values[i] ?? 0
  return frame(RC_CHANNELS_MSGID, fields, seq)
}

function paramValueFrame(name: string, value: number, count = 1, index = 0): Uint8Array {
  return frame(PARAM_VALUE_MSGID, {
    param_id: name,
    param_value: value,
    param_type: MAV_PARAM_TYPE_REAL32,
    param_count: count,
    param_index: index,
  })
}

/** Every PARAM_SET frame the GCS has sent, decoded — the review-gate wire assertion reads this. */
function decodeParamSets(sent: Uint8Array[]): Array<{ name: string; value: number }> {
  const parser = new FrameParser(defs)
  const out: Array<{ name: string; value: number }> = []
  for (const bytes of sent) {
    const [f] = parser.push(bytes)
    if (f.msgid === PARAM_SET_MSGID) {
      const fields = decodePayload(defs, f).fields
      out.push({ name: String(fields.param_id), value: Number(fields.param_value) })
    }
  }
  return out
}

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Feeds a frame and advances past Telemetry's ~100ms subscriber throttle. */
async function feed(transport: MockTransport, bytes: Uint8Array): Promise<void> {
  transport.feed(bytes)
  await tick(150)
}

async function connectSession(): Promise<{ transport: MockTransport; paramStore: ParamStore; session: MavSession }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const target = { sysid: 1, compid: 1 }
  const paramStore = new ParamStore(router, target)
  const session: MavSession = { router, target, paramStore, telemetry: new Telemetry(router, target) }
  useConnectionStore.setState({ phase: 'connected', session, paramStore })
  return { transport, paramStore, session }
}

/** The RC params the pre-read serves in these tests: channels 1-3, RC1 also carrying a REVERSED entry. */
const PRELOAD_PARAMS: Array<{ name: string; value: number }> = [
  { name: 'RC1_MIN', value: 1100 },
  { name: 'RC1_TRIM', value: 1500 },
  { name: 'RC1_MAX', value: 1900 },
  { name: 'RC1_REVERSED', value: 0 },
  { name: 'RC2_MIN', value: 1100 },
  { name: 'RC2_TRIM', value: 1500 },
  { name: 'RC2_MAX', value: 1900 },
  { name: 'RC3_MIN', value: 1100 },
  { name: 'RC3_TRIM', value: 1500 },
  { name: 'RC3_MAX', value: 1900 },
]

/** Clicks "Load current values" and answers the fetchAll with PRELOAD_PARAMS. */
async function loadCurrentValues(transport: MockTransport): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Load current values' }))
  await tick()
  PRELOAD_PARAMS.forEach((p, index) => {
    transport.feed(paramValueFrame(p.name, p.value, PRELOAD_PARAMS.length, index))
  })
  await tick(800) // past the fetch silence window so fetchAll resolves
}

/** Full path to a started wizard: disarmed heartbeat, pre-read loaded, props confirmed, Start clicked. */
async function startRcCal(transport: MockTransport): Promise<void> {
  await feed(transport, heartbeatFrame(false))
  await loadCurrentValues(transport)
  fireEvent.click(screen.getByLabelText(/Propellers are removed/))
  fireEvent.click(screen.getByRole('button', { name: 'Start RC calibration' }))
  await tick()
}

/**
 * Sampling run shared by the flow tests: ch1 full sweep ending centered,
 * ch2 never moves, ch3 (throttle-like) sweeps and ends low. Channels 4+
 * never report (0 = not available).
 */
async function sampleSticks(transport: MockTransport): Promise<void> {
  await feed(transport, rcFrame({ 1: 1000, 2: 1500, 3: 1000 }, 0))
  await feed(transport, rcFrame({ 1: 2000, 2: 1500, 3: 1900 }, 1))
  await feed(transport, rcFrame({ 1: 1500, 2: 1500, 3: 1000 }, 2))
}

const initialConnectionState = useConnectionStore.getState()
const initialRcStagedState = useRcCalStagedStore.getState()
const initialCalProgressState = useCalibrationProgress.getState()

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
  useRcCalStagedStore.setState(initialRcStagedState, true)
  useCalibrationProgress.setState(initialCalProgressState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RC calibration: entry gate', () => {
  it('Start stays disabled until values are loaded, props confirmed AND a disarmed heartbeat is the latest', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)

    const startBtn = () => screen.getByRole('button', { name: 'Start RC calibration' })
    expect(startBtn()).toBeDisabled()
    expect(screen.getByText('Load the current values first.')).toBeInTheDocument()

    await feed(transport, heartbeatFrame(true)) // armed
    await loadCurrentValues(transport)
    expect(startBtn()).toBeDisabled()
    expect(screen.getByText('Confirm the props are removed first.')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/Propellers are removed/))
    expect(startBtn()).toBeDisabled()
    expect(screen.getByText('Needs a disarmed heartbeat.')).toBeInTheDocument()
    expect(screen.getByText('ARMED')).toBeInTheDocument()

    await feed(transport, heartbeatFrame(false, 1))
    expect(screen.getByText('DISARMED')).toBeInTheDocument()
    expect(startBtn()).toBeEnabled()
  })

  it('pre-loads and shows current MIN/TRIM/MAX before starting', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)
    await feed(transport, heartbeatFrame(false))
    await loadCurrentValues(transport)

    const rc1Row = screen.getByText('RC1').closest('tr')!
    expect(rc1Row).toHaveTextContent('1100')
    expect(rc1Row).toHaveTextContent('1500')
    expect(rc1Row).toHaveTextContent('1900')
    expect(rc1Row).toHaveTextContent('normal')
    // Channels the board has no RCn_MIN for don't get a phantom row.
    expect(screen.queryByText('RC4')).not.toBeInTheDocument()
  })
})

describe('RC calibration: wizard flow', () => {
  it('samples live ranges, excludes unmoved channels, and stages only moved channels for review', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)
    await startRcCal(transport)

    expect(screen.getByText(/Move every stick, switch and knob/)).toBeInTheDocument()
    await sampleSticks(transport)
    expect(screen.getAllByText('1000–2000').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Finish — capture centers' }))
    await tick()

    // Results: RC1 moved (trim = last centered sample), RC2 unmoved, RC3 moved.
    expect(screen.getByText(/Review detected values/)).toBeInTheDocument()
    const rc1Row = screen.getByText('RC1').closest('tr')!
    expect(rc1Row).toHaveTextContent('1000 / 1500 / 2000')
    expect(rc1Row).toHaveTextContent('Moved')
    const rc2Row = screen.getByText('RC2').closest('tr')!
    expect(rc2Row).toHaveTextContent('No movement — excluded')
    const rc3Row = screen.getByText('RC3').closest('tr')!
    expect(rc3Row).toHaveTextContent('1000 / 1000 / 1900')

    // Nothing on the wire yet, and staging still writes nothing.
    expect(decodeParamSets(transport.sent)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Stage 2 moved channels for review' }))
    await tick()
    expect(decodeParamSets(transport.sent)).toHaveLength(0)

    // The review bar lists RC1/RC3's MIN/MAX/TRIM — and nothing for unmoved RC2.
    expect(screen.getByText('6 pending — nothing written yet')).toBeInTheDocument()
    expect(screen.getByText('RC1_MIN → 1000')).toBeInTheDocument()
    expect(screen.getByText('RC3_MAX → 1900')).toBeInTheDocument()
    expect(screen.queryByText(/RC2_/)).not.toBeInTheDocument()
  })

  it('Apply goes through the Review Gate: PARAM_SET only after Write, each confirmed by readback', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)
    await startRcCal(transport)
    await sampleSticks(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Finish — capture centers' }))
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'Stage 2 moved channels for review' }))
    await tick()

    expect(decodeParamSets(transport.sent)).toHaveLength(0)
    // Staging alone must not latch the guide's step-3 RC flag (issue #46).
    expect(useCalibrationProgress.getState().rcCalApplied).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))

    // Sequential set() with readback: answer each PARAM_SET's echo in turn.
    for (let i = 0; i < 6; i++) {
      await tick()
      const sets = decodeParamSets(transport.sent)
      expect(sets).toHaveLength(i + 1)
      const last = sets[sets.length - 1]
      transport.feed(paramValueFrame(last.name, last.value))
      await tick()
    }

    const written = decodeParamSets(transport.sent)
    expect(written.map((w) => w.name).sort()).toEqual([
      'RC1_MAX',
      'RC1_MIN',
      'RC1_TRIM',
      'RC3_MAX',
      'RC3_MIN',
      'RC3_TRIM',
    ])
    // All confirmed: the bar's transient 'ok' chips clear after their display window.
    await tick(2500)
    expect(useRcCalStagedStore.getState().pending.size).toBe(0)
    // The verified write latches the Setup Guide's session-scoped RC flag -- see calibrationProgress.ts's own doc.
    expect(useCalibrationProgress.getState().rcCalApplied).toBe(true)
  })

  it('a partially-failed Apply does NOT latch rcCalApplied; the retry that verifies everything does (issue #46)', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)
    await startRcCal(transport)
    await sampleSticks(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Finish — capture centers' }))
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'Stage 2 moved channels for review' }))
    await tick()

    // 5 of 6 confirmed by readback; the last echoes a clamped value -> 'mismatch'.
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    for (let i = 0; i < 6; i++) {
      await tick()
      const sets = decodeParamSets(transport.sent)
      const last = sets[sets.length - 1]
      transport.feed(paramValueFrame(last.name, i < 5 ? last.value : last.value + 50))
      await tick()
    }
    await tick(2500) // succeeded params clear; the mismatched one stays pending
    expect(useRcCalStagedStore.getState().pending.size).toBe(1)
    expect(useCalibrationProgress.getState().rcCalApplied).toBe(false)

    // Retry the failed param; once every status is a verified 'ok', the latch flips.
    transport.sent.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    await tick()
    const [retried] = decodeParamSets(transport.sent)
    transport.feed(paramValueFrame(retried.name, retried.value))
    await tick()
    expect(useCalibrationProgress.getState().rcCalApplied).toBe(true)
  })

  it('stages a reverse toggle as RCn_REVERSED without writing', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)
    await startRcCal(transport)
    await sampleSticks(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Finish — capture centers' }))
    await tick()

    fireEvent.click(screen.getByLabelText('Reverse channel 1'))
    await tick()
    expect(screen.getByText('RC1_REVERSED → 1')).toBeInTheDocument()
    expect(decodeParamSets(transport.sent)).toHaveLength(0)
  })
})

describe('RC calibration: armed abort (non-negotiable)', () => {
  it('aborts, discards, and blocks staging when an armed heartbeat lands mid-calibration', async () => {
    const { transport } = await connectSession()
    render(<CalibrationPage />)
    await startRcCal(transport)
    await sampleSticks(transport)

    await feed(transport, heartbeatFrame(true, 1))

    expect(screen.getByText(/The vehicle armed during calibration/)).toBeInTheDocument()
    // No results table, no staging path, nothing pending, nothing on the wire.
    expect(screen.queryByRole('button', { name: /Stage .* for review/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Finish — capture centers' })).not.toBeInTheDocument()
    expect(useRcCalStagedStore.getState().pending.size).toBe(0)
    expect(decodeParamSets(transport.sent)).toHaveLength(0)

    // Recovery: disarmed again -> Start again runs a fresh (empty) run.
    await feed(transport, heartbeatFrame(false, 2))
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    await tick()
    expect(screen.getByText(/Move every stick, switch and knob/)).toBeInTheDocument()
  })
})
