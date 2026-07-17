import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { SetupPage } from '../SetupPage'
import { useSetupStore } from '../setupStore'
import { useConnectionStore } from '../../../store/connection'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { encodeFrame, FrameParser } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { decodePayload } from '../../../core/mavlink/decode'
import { MavRouter } from '../../../core/mavlink/router'
import { ParamStore } from '../../../core/mavlink/params'
import { Telemetry } from '../../../core/mavlink/telemetry'
import type { MavSession } from '../../../core/mavlink/session'
import type { ParamMetaFile } from '../../../core/paramMetadata'

const PARAM_SET_MSGID = 23
const RC_CHANNELS_MSGID = 65
const MAV_PARAM_TYPE_REAL32 = 9
const MAV_PARAM_TYPE_INT32 = 6

const initialConnectionState = useConnectionStore.getState()
const initialSetupState = useSetupStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
  useSetupStore.setState(initialSetupState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Every param the Setup page reads/writes, at ArduPilot's own defaults (Task 7.1 metadata). */
const DEFAULT_SETUP_PARAMS = [
  { name: 'FRAME_CLASS', value: 1, type: MAV_PARAM_TYPE_INT32 },
  { name: 'FRAME_TYPE', value: 1, type: MAV_PARAM_TYPE_INT32 },
  { name: 'MOT_PWM_TYPE', value: 0, type: MAV_PARAM_TYPE_INT32 },
  { name: 'BATT_MONITOR', value: 4, type: MAV_PARAM_TYPE_INT32 },
  { name: 'BATT_CAPACITY', value: 5200, type: MAV_PARAM_TYPE_INT32 },
  { name: 'BATT_LOW_VOLT', value: 14, type: MAV_PARAM_TYPE_REAL32 },
  { name: 'FS_THR_ENABLE', value: 1, type: MAV_PARAM_TYPE_INT32 },
  { name: 'BATT_FS_LOW_ACT', value: 2, type: MAV_PARAM_TYPE_INT32 },
  { name: 'FS_GCS_ENABLE', value: 1, type: MAV_PARAM_TYPE_INT32 },
  { name: 'FLTMODE1', value: 0, type: MAV_PARAM_TYPE_INT32 },
  { name: 'FLTMODE2', value: 2, type: MAV_PARAM_TYPE_INT32 },
  { name: 'FLTMODE3', value: 5, type: MAV_PARAM_TYPE_INT32 },
  { name: 'FLTMODE4', value: 3, type: MAV_PARAM_TYPE_INT32 },
  { name: 'FLTMODE5', value: 6, type: MAV_PARAM_TYPE_INT32 },
  { name: 'FLTMODE6', value: 6, type: MAV_PARAM_TYPE_INT32 },
  { name: 'FLTMODE_CH', value: 5, type: MAV_PARAM_TYPE_INT32 },
  { name: 'SIMPLE', value: 0, type: MAV_PARAM_TYPE_INT32 },
  { name: 'SUPER_SIMPLE', value: 0, type: MAV_PARAM_TYPE_INT32 },
]

/** Mode-name enum shared by all six slots — every name the UI shows must come from here (issue #37: no hardcoded mode names). AutoTune included on purpose: assigning it to a slot is allowed bench-side config (ADR-0002). */
const FLTMODE_VALUES = [
  { value: 0, label: 'Stabilize' },
  { value: 1, label: 'Acro' },
  { value: 2, label: 'AltHold' },
  { value: 3, label: 'Auto' },
  { value: 5, label: 'Loiter' },
  { value: 6, label: 'RTL' },
  { value: 15, label: 'AutoTune' },
]

/** Bundled-metadata stand-in served to `loadParamMetadata`'s same-origin fetch — one shared fixture for the whole file (the module caches per version). */
const META_FIXTURE: ParamMetaFile = {
  FLTMODE1: { displayName: 'Flight Mode 1', description: 'x', values: FLTMODE_VALUES },
  FLTMODE2: { displayName: 'Flight Mode 2', description: 'x', values: FLTMODE_VALUES },
  FLTMODE3: { displayName: 'Flight Mode 3', description: 'x', values: FLTMODE_VALUES },
  FLTMODE4: { displayName: 'Flight Mode 4', description: 'x', values: FLTMODE_VALUES },
  FLTMODE5: { displayName: 'Flight Mode 5', description: 'x', values: FLTMODE_VALUES },
  FLTMODE6: { displayName: 'Flight Mode 6', description: 'x', values: FLTMODE_VALUES },
  FLTMODE_CH: {
    displayName: 'Flightmode channel',
    description: 'x',
    values: [
      { value: 0, label: 'Disabled' },
      { value: 5, label: 'Channel5' },
      { value: 6, label: 'Channel6' },
      { value: 7, label: 'Channel7' },
    ],
  },
  SIMPLE: { displayName: 'Simple mode bitmask', description: 'x' },
  SUPER_SIMPLE: { displayName: 'Super Simple Mode', description: 'x' },
}

function mockMetaFetch(body: ParamMetaFile): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
}

function paramValueFrame(opts: { name: string; value: number; type?: number; count: number; index: number }): Uint8Array {
  const payload = encodePayload(defs, 22, {
    param_id: opts.name,
    param_value: opts.value,
    param_type: opts.type ?? MAV_PARAM_TYPE_REAL32,
    param_count: opts.count,
    param_index: opts.index,
  })
  return encodeFrame(defs, { msgid: 22, payload }, 0, 1, 1)
}

function decodeSent(bytes: Uint8Array): { msgid: number; fields: Record<string, unknown> } {
  const parser = new FrameParser(defs)
  const [frame] = parser.push(bytes)
  return { msgid: frame.msgid, fields: decodePayload(defs, frame).fields }
}

async function makeConnectedParamStore(
  opts?: ConstructorParameters<typeof ParamStore>[2],
): Promise<{ transport: MockTransport; paramStore: ParamStore; session: MavSession }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const target = { sysid: 1, compid: 1 }
  const paramStore = new ParamStore(router, target, opts)
  // A real Telemetry on the same router — the wire seam the flight-mode
  // active-slot tests inject RC_CHANNELS frames through.
  const session: MavSession = { router, target, paramStore, telemetry: new Telemetry(router, target) }
  return { transport, paramStore, session }
}

/** RC_CHANNELS frame; `values` is 1-based channel → µs, unlisted channels are 0 ("channel not available"). */
function rcFrame(values: Record<number, number>, seq = 0): Uint8Array {
  const fields: Record<string, number> = { chancount: 16, rssi: 200 }
  for (let i = 1; i <= 18; i++) fields[`chan${i}_raw`] = values[i] ?? 0
  const payload = encodePayload(defs, RC_CHANNELS_MSGID, fields)
  return encodeFrame(defs, { msgid: RC_CHANNELS_MSGID, payload }, seq, 1, 1)
}

async function feedAll(transport: MockTransport, entries: Array<{ name: string; value: number; type?: number }>): Promise<void> {
  entries.forEach((e, index) => {
    transport.feed(paramValueFrame({ name: e.name, value: e.value, type: e.type, count: entries.length, index }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/**
 * Runs a real, successfully-completed `fetchAll()` seeded with these entries
 * *before* the page ever mounts — the "already fetched in a prior mount"
 * state. Distinct from `feedAll` (which just injects frames into a fetch the
 * test/page already started elsewhere): only a completed `fetchAll()` sets
 * `paramStore.fetchProgress.completed`, which is what `SetupPage` now gates
 * "already loaded" on (issue #20 — an ArduPilot unsolicited broadcast can
 * populate `all` with entries no `fetchAll()` ever fetched, and rendering
 * the setup form from that would show the board's actual FRAME/ESC/battery
 * values as blank/default-looking instead of honestly asking to load first).
 */
async function primeCompletedFetch(paramStore: ParamStore, transport: MockTransport, entries: Array<{ name: string; value: number; type?: number }>): Promise<void> {
  const fetchPromise = paramStore.fetchAll()
  await tick()
  await feedAll(transport, entries)
  await fetchPromise
}

async function renderLoaded(entries: Array<{ name: string; value: number; type?: number }> = DEFAULT_SETUP_PARAMS) {
  mockMetaFetch(META_FIXTURE)
  const { transport, paramStore, session } = await makeConnectedParamStore()
  await primeCompletedFetch(paramStore, transport, entries)
  useConnectionStore.setState({ phase: 'connected', paramStore, session, identity: { fwVersion: '4.6.3' } })
  render(<SetupPage />)
  await tick() // let the metadata fetch resolve
  return { transport, paramStore, session }
}

describe('SetupPage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  describe('not connected', () => {
    it('shows the empty state; CTA calls connect() only while truly disconnected', () => {
      const calls: unknown[] = []
      useConnectionStore.setState({
        phase: 'disconnected',
        baud: 115200,
        paramStore: null,
        connect: (baud, opts) => {
          calls.push([baud, opts])
          return Promise.resolve()
        },
      })
      render(<SetupPage />)

      expect(screen.getByText('Setup needs a connected board')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Connect flight controller' }))
      expect(calls).toEqual([[115200, undefined]])
    })
  })

  describe('load flow', () => {
    it('shows a Load button before any fetch, then the form once loaded', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<SetupPage />)

      expect(screen.getByRole('button', { name: 'Load parameters' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Load parameters' }))
      await tick()

      await feedAll(transport, DEFAULT_SETUP_PARAMS)
      expect(screen.getByText('FRAME')).toBeInTheDocument()
    })

    it('skips straight to the form if the ParamStore was already fetched in a prior mount', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      await primeCompletedFetch(paramStore, transport, DEFAULT_SETUP_PARAMS)
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<SetupPage />)
      expect(screen.queryByRole('button', { name: 'Load parameters' })).not.toBeInTheDocument()
      expect(screen.getByText('FRAME')).toBeInTheDocument()
    })

    it('bug repro (issue #20): a single unsolicited PARAM_VALUE with no fetchAll ever run must not render the form with stale/empty board values', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      // ArduPilot re-broadcasts a changed param unprompted — no fetchAll() ever ran.
      transport.feed(paramValueFrame({ name: 'BATT_CAPACITY', value: 5200, type: MAV_PARAM_TYPE_INT32, count: 1, index: 0 }))
      await tick()
      expect(paramStore.fetchProgress.completed).toBe(false)

      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<SetupPage />)

      // Honest gate: offers the "Load parameters" CTA rather than the form
      // with FRAME/ESC/other-battery-fields silently missing.
      expect(screen.getByRole('button', { name: 'Load parameters' })).toBeInTheDocument()
      expect(screen.queryByText('FRAME')).not.toBeInTheDocument()
    })
  })

  describe('field initialization from ParamStore', () => {
    it('highlights the frame tile matching the board\'s current FRAME_CLASS/FRAME_TYPE', async () => {
      await renderLoaded()
      expect(screen.getByRole('button', { name: /Quad X/ })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: /Quad \+/ })).toHaveAttribute('aria-pressed', 'false')
    })

    it('highlights the ESC chip matching MOT_PWM_TYPE', async () => {
      await renderLoaded()
      expect(screen.getByRole('button', { name: 'PWM' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('initializes battery/failsafe controls from cached values', async () => {
      await renderLoaded()
      expect(screen.getByLabelText('BATT_MONITOR')).toHaveValue('4')
      expect(screen.getByLabelText('BATT_CAPACITY')).toHaveValue('5200')
      expect(screen.getByLabelText('BATT_LOW_VOLT')).toHaveValue('14')
      expect(screen.getByLabelText('FS_THR_ENABLE')).toHaveValue('1')
      expect(screen.getByLabelText('BATT_FS_LOW_ACT')).toHaveValue('2')
      expect(screen.getByLabelText('FS_GCS_ENABLE')).toHaveValue('1')
    })
  })

  describe('failsafe legacy tagging (Task 7.1 review finding, scoped per field)', () => {
    it('tags value=2 as legacy on FS_THR_ENABLE/FS_GCS_ENABLE (removed in ArduPilot 4.0+), but NOT on BATT_FS_LOW_ACT (2=RTL, a current, valid option)', async () => {
      // Regression test (calibration review finding): the old code tagged
      // "legacy" by raw value (===2) across all three dropdowns. BATT_FS_LOW_ACT
      // never had a value 2 removed in 4.0+ -- it's "RTL", still fully valid --
      // so it must never get the legacy suffix just because it shares the
      // number 2 with the two fields that actually do have a removed option.
      await renderLoaded()

      const thrSelect = screen.getByLabelText('FS_THR_ENABLE')
      const gcsSelect = screen.getByLabelText('FS_GCS_ENABLE')
      const battSelect = screen.getByLabelText('BATT_FS_LOW_ACT')

      expect(within(thrSelect).getByText(/Continue in Auto, else RTL/)).toHaveTextContent(/legacy/i)
      expect(within(gcsSelect).getByText(/Continue in Auto, else RTL/)).toHaveTextContent(/legacy/i)
      // Exact text match -- fails if a legacy suffix got appended.
      expect(within(battSelect).getByText('Return-to-Launch')).not.toHaveTextContent(/legacy/i)
    })
  })

  describe('staging', () => {
    it('picking a frame tile stages BOTH FRAME_CLASS and FRAME_TYPE, and shows both chips in the sticky bar', async () => {
      await renderLoaded()
      fireEvent.click(screen.getByRole('button', { name: /Hex X/ }))

      expect(screen.getByText('2 pending — nothing written yet')).toBeInTheDocument()
      expect(screen.getByText('FRAME_CLASS → 2')).toBeInTheDocument()
      expect(screen.getByText('FRAME_TYPE → 1')).toBeInTheDocument()
      expect(useSetupStore.getState().frameEscTouched).toBe(true)
    })

    it('re-picking a different ESC chip dedupes to a single MOT_PWM_TYPE chip', async () => {
      await renderLoaded()
      fireEvent.click(screen.getByRole('button', { name: 'DShot150' }))
      fireEvent.click(screen.getByRole('button', { name: 'DShot300' }))

      expect(screen.getByText('1 pending — nothing written yet')).toBeInTheDocument()
      expect(screen.getByText('MOT_PWM_TYPE → 5')).toBeInTheDocument()
    })

    it('changing the battery monitor dropdown stages BATT_MONITOR', async () => {
      await renderLoaded()
      fireEvent.change(screen.getByLabelText('BATT_MONITOR'), { target: { value: '0' } })
      expect(screen.getByText('BATT_MONITOR → 0')).toBeInTheDocument()
    })

    it('changing a failsafe dropdown stages it and sets fsTouched', async () => {
      await renderLoaded()
      fireEvent.change(screen.getByLabelText('FS_THR_ENABLE'), { target: { value: '3' } })
      expect(screen.getByText('FS_THR_ENABLE → 3')).toBeInTheDocument()
      expect(useSetupStore.getState().fsTouched).toBe(true)
      expect(useSetupStore.getState().frameEscTouched).toBe(false)
    })

    it('"Revert" clears every staged edit and the bar disappears', async () => {
      await renderLoaded()
      fireEvent.click(screen.getByRole('button', { name: /Hex X/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
      expect(screen.queryByText(/pending — nothing written yet/)).not.toBeInTheDocument()
      // Frame tile falls back to displaying the board's real cached value (Quad X), not a hardcoded default.
      expect(screen.getByRole('button', { name: /Quad X/ })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  describe('number field validation', () => {
    it('rejects a non-integer BATT_CAPACITY without staging it', async () => {
      await renderLoaded()
      const input = screen.getByLabelText('BATT_CAPACITY')
      fireEvent.change(input, { target: { value: '100.5' } })
      fireEvent.blur(input)
      expect(screen.getByText('Must be a whole number')).toBeInTheDocument()
      expect(screen.queryByText(/pending — nothing written yet/)).not.toBeInTheDocument()
    })

    it('rejects a negative BATT_LOW_VOLT without staging it', async () => {
      await renderLoaded()
      const input = screen.getByLabelText('BATT_LOW_VOLT')
      fireEvent.change(input, { target: { value: '-1' } })
      fireEvent.blur(input)
      expect(screen.getByText('Must be zero or greater')).toBeInTheDocument()
      expect(screen.queryByText(/pending — nothing written yet/)).not.toBeInTheDocument()
    })

    it('accepts a valid decimal BATT_LOW_VOLT and stages it', async () => {
      await renderLoaded()
      const input = screen.getByLabelText('BATT_LOW_VOLT')
      fireEvent.change(input, { target: { value: '14.4' } })
      fireEvent.blur(input)
      expect(screen.getByText('BATT_LOW_VOLT → 14.4')).toBeInTheDocument()
    })

    it('rejects "Infinity" for a non-integer field rather than staging an unwritable value', async () => {
      await renderLoaded()
      const input = screen.getByLabelText('BATT_LOW_VOLT')
      fireEvent.change(input, { target: { value: 'Infinity' } })
      fireEvent.blur(input)
      expect(screen.getByText('Enter a number')).toBeInTheDocument()
      expect(screen.queryByText(/pending — nothing written yet/)).not.toBeInTheDocument()
    })
  })

  describe('write flow', () => {
    it('writing stages a successful set() with per-chip status, then clears once verified', async () => {
      const { transport } = await renderLoaded()
      fireEvent.change(screen.getByLabelText('BATT_CAPACITY'), { target: { value: '6000' } })
      fireEvent.blur(screen.getByLabelText('BATT_CAPACITY'))

      fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
      await tick()

      const sent = decodeSent(transport.sent.find((b) => decodeSent(b).msgid === PARAM_SET_MSGID)!)
      expect(sent.fields.param_value).toBeCloseTo(6000, 5)

      transport.feed(paramValueFrame({ name: 'BATT_CAPACITY', value: 6000, count: 1, index: 0 }))
      await tick()
      expect(screen.getByText('BATT_CAPACITY → 6000')).toBeInTheDocument() // still shown, now in its transient 'ok' tone

      await tick(2000)
      expect(screen.queryByText(/pending — nothing written yet/)).not.toBeInTheDocument()
    })

    it('a mismatch keeps the chip listed with a failure message', async () => {
      const { transport } = await renderLoaded()
      fireEvent.change(screen.getByLabelText('BATT_CAPACITY'), { target: { value: '6000' } })
      fireEvent.blur(screen.getByLabelText('BATT_CAPACITY'))
      fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
      await tick()

      transport.feed(paramValueFrame({ name: 'BATT_CAPACITY', value: 5500, count: 1, index: 0 })) // FC clamped
      await tick()

      expect(screen.getByText('BATT_CAPACITY → 6000')).toBeInTheDocument()
      expect(screen.getByText(/Board reports 5500 \(requested 6000\)/)).toBeInTheDocument()
    })
  })

  describe('flight modes (issue #37)', () => {
    async function feedRc(transport: MockTransport, values: Record<number, number>, seq = 0): Promise<void> {
      transport.feed(rcFrame(values, seq))
      await tick(150) // past Telemetry's ~100ms subscriber throttle
    }

    /** Which slot row currently carries the live badge, or null. */
    function activeSlotOf(): string | null {
      const badge = screen.queryByText('switch is here')
      return badge ? (badge.closest('[data-slot]')?.getAttribute('data-slot') ?? null) : null
    }

    it('renders every slot dropdown from the bundled metadata enum — AutoTune assignable — and initializes from board values', async () => {
      await renderLoaded()
      const select = screen.getByLabelText('FLTMODE1')
      const labels = within(select)
        .getAllByRole('option')
        .map((o) => o.textContent)
      expect(labels).toEqual(FLTMODE_VALUES.map((v) => v.label)) // exactly the metadata enum, nothing hardcoded
      expect(select).toHaveValue('0')
      expect(screen.getByLabelText('FLTMODE3')).toHaveValue('5')
    })

    it('FLTMODE_CH renders from its metadata enum and initializes from the board value', async () => {
      await renderLoaded()
      const select = screen.getByLabelText('FLTMODE_CH')
      expect(select).toHaveValue('5')
      const labels = within(select)
        .getAllByRole('option')
        .map((o) => o.textContent)
      expect(labels).toEqual(['Disabled', 'Channel5', 'Channel6', 'Channel7'])
    })

    it('choosing a mode stages it with the metadata label and emits zero parameter-write frames (Review Gate)', async () => {
      const { transport } = await renderLoaded()
      fireEvent.change(screen.getByLabelText('FLTMODE3'), { target: { value: '15' } })

      expect(screen.getByText('1 pending — nothing written yet')).toBeInTheDocument()
      expect(screen.getByText('FLTMODE3 → 15')).toHaveAttribute('title', 'AutoTune') // chip tooltip carries the metadata label
      expect(transport.sent.map(decodeSent).filter((f) => f.msgid === PARAM_SET_MSGID)).toHaveLength(0)
    })

    it('changing FLTMODE_CH stages through the same bar', async () => {
      await renderLoaded()
      fireEvent.change(screen.getByLabelText('FLTMODE_CH'), { target: { value: '6' } })
      expect(screen.getByText('FLTMODE_CH → 6')).toHaveAttribute('title', 'Channel6')
    })

    it('Simple / Super Simple toggles stage the correct bitmask values (bit N = slot N+1)', async () => {
      await renderLoaded()
      fireEvent.click(screen.getByLabelText('Simple mode for slot 1'))
      fireEvent.click(screen.getByLabelText('Simple mode for slot 3'))
      expect(useSetupStore.getState().pending.get('SIMPLE')?.value).toBe(0b101)
      expect(screen.getByText('SIMPLE → 5')).toHaveAttribute('title', 'slots 1, 3')

      fireEvent.click(screen.getByLabelText('Simple mode for slot 1')) // uncheck builds on the staged mask
      expect(useSetupStore.getState().pending.get('SIMPLE')?.value).toBe(0b100)

      fireEvent.click(screen.getByLabelText('Super Simple mode for slot 6'))
      expect(useSetupStore.getState().pending.get('SUPER_SIMPLE')?.value).toBe(0b100000)
    })

    it('Apply writes the staged SIMPLE bitmask to the wire', async () => {
      const { transport } = await renderLoaded()
      fireEvent.click(screen.getByLabelText('Simple mode for slot 1'))
      fireEvent.click(screen.getByLabelText('Simple mode for slot 3'))
      fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
      await tick()

      const sets = transport.sent
        .map(decodeSent)
        .filter((f) => f.msgid === PARAM_SET_MSGID)
        .map((f) => f.fields)
      expect(sets).toHaveLength(1)
      expect(sets[0].param_id).toBe('SIMPLE')
      expect(sets[0].param_value).toBeCloseTo(5, 5)
    })

    it('wire seam: injected RC_CHANNELS frames move the active-slot highlight across every PWM threshold', async () => {
      const { transport } = await renderLoaded()
      expect(activeSlotOf()).toBeNull() // no RC data yet

      const bands: Array<[pwm: number, slot: string]> = [
        [1000, '1'],
        [1230, '1'],
        [1231, '2'],
        [1360, '2'],
        [1361, '3'],
        [1490, '3'],
        [1491, '4'],
        [1620, '4'],
        [1621, '5'],
        [1749, '5'],
        [1750, '6'],
        [1900, '6'],
      ]
      let seq = 0
      for (const [pwm, slot] of bands) {
        await feedRc(transport, { 5: pwm }, seq++)
        expect(activeSlotOf(), `pwm ${pwm}`).toBe(slot)
      }

      // Channel dropping out (0 = "not available") clears the highlight.
      await feedRc(transport, {}, seq++)
      expect(activeSlotOf()).toBeNull()
    })

    it('the highlight follows the FLTMODE_CH written on the board, never a staged-but-unapplied channel change', async () => {
      const { transport } = await renderLoaded()
      fireEvent.change(screen.getByLabelText('FLTMODE_CH'), { target: { value: '6' } })
      // chan5 (board value) says slot 6; chan6 (staged, unwritten) would say slot 1.
      await feedRc(transport, { 5: 1800, 6: 1000 })
      expect(activeSlotOf()).toBe('6')
    })
  })

  describe('disconnect handling', () => {
    it('disconnecting with pending edits clears them and shows a discard warning', async () => {
      await renderLoaded()
      fireEvent.click(screen.getByRole('button', { name: /Hex X/ }))
      expect(screen.getByText('2 pending — nothing written yet')).toBeInTheDocument()

      await act(async () => {
        useConnectionStore.setState({ phase: 'disconnected', paramStore: null })
      })

      expect(screen.getByText(/2 unsaved setup change\(s\) were discarded/)).toBeInTheDocument()
      expect(useSetupStore.getState().pending.size).toBe(0)
    })
  })
})
