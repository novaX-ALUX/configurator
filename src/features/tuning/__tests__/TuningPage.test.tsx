import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { TuningPage } from '../TuningPage'
import { useTuningStore } from '../tuningStore'
import { useConnectionStore } from '../../../store/connection'
import { NAV_PAGES } from '../../../store/navigation'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { encodeFrame, FrameParser } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { decodePayload } from '../../../core/mavlink/decode'
import { MavRouter } from '../../../core/mavlink/router'
import { ParamStore } from '../../../core/mavlink/params'
import type { MavSession } from '../../../core/mavlink/session'
import type { ParamMetaFile } from '../../../core/paramMetadata'

const PARAM_SET_MSGID = 23
const COMMAND_LONG_MSGID = 76
const MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN = 246
const MAV_PARAM_TYPE_REAL32 = 9

const initialConnectionState = useConnectionStore.getState()
const initialTuningState = useTuningStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
  useTuningStore.setState(initialTuningState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The board-primed subset of the six cards' params (plus TUNE), at ArduCopter-ish defaults, REAL32 like the board reports them. */
const TUNING_PARAMS = [
  { name: 'ATC_RAT_RLL_P', value: 0.135 },
  { name: 'ATC_RAT_RLL_I', value: 0.135 },
  { name: 'ATC_RAT_RLL_D', value: 0.0036 },
  { name: 'ATC_RAT_PIT_P', value: 0.135 },
  { name: 'ATC_RAT_PIT_I', value: 0.135 },
  { name: 'ATC_RAT_PIT_D', value: 0.0036 },
  { name: 'ATC_RAT_YAW_P', value: 0.18 },
  { name: 'ATC_RAT_YAW_I', value: 0.018 },
  { name: 'ATC_RAT_YAW_D', value: 0 },
  { name: 'ATC_ANG_RLL_P', value: 4.5 },
  { name: 'ATC_ANG_PIT_P', value: 4.5 },
  { name: 'ATC_ANG_YAW_P', value: 4.5 },
  { name: 'INS_GYRO_FILTER', value: 20 },
  { name: 'INS_ACCEL_FILTER', value: 20 },
  { name: 'ATC_RAT_RLL_FLTD', value: 20 },
  { name: 'ATC_RAT_RLL_FLTT', value: 20 },
  { name: 'ATC_RAT_PIT_FLTD', value: 20 },
  { name: 'ATC_RAT_PIT_FLTT', value: 20 },
  { name: 'ATC_RAT_YAW_FLTE', value: 2 },
  { name: 'ATC_RAT_YAW_FLTT', value: 20 },
  { name: 'ATC_RAT_RLL_IMAX', value: 0.5 },
  { name: 'PSC_POSZ_P', value: 1 },
  { name: 'PSC_VELZ_P', value: 5 },
  { name: 'PSC_ACCZ_P', value: 0.5 },
  { name: 'PSC_ACCZ_I', value: 1 },
  { name: 'PSC_ACCZ_D', value: 0 },
  { name: 'LOIT_SPEED', value: 1250 },
  { name: 'PSC_POSXY_P', value: 1 },
  { name: 'PSC_VELXY_P', value: 2 },
  { name: 'PSC_VELXY_I', value: 1 },
  { name: 'WPNAV_SPEED', value: 1000 },
  { name: 'WPNAV_RADIUS', value: 200 },
  { name: 'TUNE', value: 0 },
  { name: 'TUNE_MIN', value: 0 },
  { name: 'TUNE_MAX', value: 1 },
]

/**
 * Bundled-metadata stand-in served to `loadParamMetadata`'s same-origin
 * fetch. One shared fixture for the whole file (the module caches by
 * resolved version, so every test sees this body). `INS_ACCEL_FILTER` is
 * marked rebootRequired here purely to exercise the banner mechanism — the
 * real 4.6 metadata does not flag it.
 */
const META_FIXTURE: ParamMetaFile = {
  ATC_RAT_RLL_P: { displayName: 'Roll axis rate controller P gain', description: 'x', range: [0, 0.35], increment: 0.005 },
  ATC_ANG_RLL_P: { displayName: 'Roll axis angle controller P gain', description: 'x', range: [3, 12] },
  INS_GYRO_FILTER: { displayName: 'Gyro filter cutoff frequency', description: 'x', range: [0, 256], units: 'Hz' },
  INS_ACCEL_FILTER: { displayName: 'Accel filter cutoff frequency', description: 'x', range: [0, 256], units: 'Hz', rebootRequired: true },
  ATC_RAT_RLL_IMAX: { displayName: 'Roll axis rate controller I gain maximum', description: 'x', range: [0, 1], increment: 0.01 },
  PSC_POSZ_P: { displayName: 'Position (vertical) controller P gain', description: 'x', range: [1, 3] },
  LOIT_SPEED: { displayName: 'Loiter Horizontal Maximum Speed', description: 'x', range: [20, 3500], increment: 50, units: 'cm/s' },
  WPNAV_SPEED: { displayName: 'Waypoint Horizontal Speed Target', description: 'x', range: [10, 2000], increment: 50, units: 'cm/s' },
  TUNE: {
    displayName: 'Channel 6 Tuning',
    description: 'x',
    values: [
      { value: 0, label: 'None' },
      { value: 4, label: 'Rate Roll/Pitch kP' },
    ],
  },
  TUNE_MIN: { displayName: 'Tuning minimum', description: 'x' },
  TUNE_MAX: { displayName: 'Tuning maximum', description: 'x' },
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

/** Every PARAM_SET frame the page has emitted — the wire seam the ADR-0003 assertions run against. */
function paramSetFrames(transport: MockTransport): Array<Record<string, unknown>> {
  return transport.sent.map(decodeSent).filter((f) => f.msgid === PARAM_SET_MSGID).map((f) => f.fields)
}

function mockMetaFetch(body: ParamMetaFile): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
}

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** A connected Session + ParamStore on one MockTransport, so PARAM_SET and the reboot COMMAND_LONG are both observable on the same `transport.sent`. */
async function makeConnected(): Promise<{ transport: MockTransport; paramStore: ParamStore; session: MavSession }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const target = { sysid: 1, compid: 1 }
  const paramStore = new ParamStore(router, target)
  const session: MavSession = { router, target, paramStore, telemetry: {} as MavSession['telemetry'] }
  return { transport, paramStore, session }
}

async function primeCompletedFetch(paramStore: ParamStore, transport: MockTransport, entries: Array<{ name: string; value: number }>): Promise<void> {
  const fetchPromise = paramStore.fetchAll()
  await tick()
  entries.forEach((e, index) => {
    transport.feed(paramValueFrame({ name: e.name, value: e.value, count: entries.length, index }))
  })
  await tick()
  await fetchPromise
}

async function renderLoaded() {
  mockMetaFetch(META_FIXTURE)
  const { transport, paramStore, session } = await makeConnected()
  await primeCompletedFetch(paramStore, transport, TUNING_PARAMS)
  useConnectionStore.setState({ phase: 'connected', paramStore, session, identity: { fwVersion: '4.6.3' } })
  render(<TuningPage />)
  await tick() // let the metadata fetch resolve
  return { transport, paramStore, session }
}

/** Slider-drag choreography: `change` events are the drag, `pointerUp` is the release. */
function dragSlider(param: string, value: string): HTMLElement {
  const slider = screen.getByLabelText(param)
  fireEvent.change(slider, { target: { value } })
  return slider
}

describe('TuningPage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  describe('navigation', () => {
    it('has a nav entry closing the Configure group (guide-journey order, ADR-0004)', () => {
      const configureIds = NAV_PAGES.filter((p) => p.group === 'configure').map((p) => p.id)
      expect(configureIds[configureIds.length - 1]).toBe('tuning')
    })
  })

  describe('gates', () => {
    it('shows the empty state when not connected', () => {
      useConnectionStore.setState({ phase: 'disconnected', paramStore: null })
      render(<TuningPage />)
      expect(screen.getByText('Tuning needs a connected board')).toBeInTheDocument()
    })

    it('offers the Load CTA when connected but never fetched', async () => {
      mockMetaFetch(META_FIXTURE)
      const { paramStore } = await makeConnected()
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<TuningPage />)
      expect(screen.getByRole('button', { name: 'Load parameters' })).toBeInTheDocument()
      expect(screen.queryByText('RATE')).not.toBeInTheDocument()
    })
  })

  describe('metadata-driven sliders', () => {
    it('takes range/step/units from the bundled metadata, nothing hardcoded', async () => {
      await renderLoaded()
      const rllP = screen.getByLabelText('ATC_RAT_RLL_P')
      expect(rllP).toHaveAttribute('min', '0')
      expect(rllP).toHaveAttribute('max', '0.35')
      expect(rllP).toHaveAttribute('step', '0.005')
      // No increment in metadata → derived decade step, still not hardcoded per-param.
      expect(screen.getByLabelText('ATC_ANG_RLL_P')).toHaveAttribute('step', '0.01')
    })

    it('renders a param without metadata range as read-only — no slider to drag', async () => {
      await renderLoaded()
      // ATC_RAT_PIT_P is deliberately absent from META_FIXTURE.
      expect(screen.queryByLabelText('ATC_RAT_PIT_P')).not.toBeInTheDocument()
      expect(screen.getAllByText('No documented range in the bundled metadata — edit this parameter from the Parameters page.').length).toBeGreaterThan(0)
    })
  })

  describe('Review Gate wire seam (ADR-0003)', () => {
    it('dragging and releasing a slider emits zero parameter-write frames; release only stages', async () => {
      const { transport } = await renderLoaded()

      const slider = dragSlider('ATC_RAT_RLL_P', '0.2')
      expect(paramSetFrames(transport)).toHaveLength(0) // mid-drag: nothing written
      expect(screen.queryByText(/pending — nothing written yet/)).not.toBeInTheDocument() // and nothing staged yet

      fireEvent.pointerUp(slider)
      expect(screen.getByText('1 pending — nothing written yet')).toBeInTheDocument()
      expect(screen.getByText('ATC_RAT_RLL_P → 0.2')).toBeInTheDocument()
      expect(paramSetFrames(transport)).toHaveLength(0) // staged, still nothing written
    })

    it('releasing a slider without moving it stages nothing', async () => {
      await renderLoaded()
      fireEvent.pointerUp(screen.getByLabelText('ATC_RAT_RLL_P'))
      expect(screen.queryByText(/pending — nothing written yet/)).not.toBeInTheDocument()
    })

    it('Apply writes the staged params sequentially with per-param readback, then the bar clears', async () => {
      const { transport } = await renderLoaded()
      fireEvent.pointerUp(dragSlider('ATC_RAT_RLL_P', '0.2'))
      fireEvent.pointerUp(dragSlider('ATC_ANG_RLL_P', '6'))
      expect(screen.getByText('2 pending — nothing written yet')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
      await tick()

      // Sequential: the second PARAM_SET must not leave before the first readback arrives.
      let sets = paramSetFrames(transport)
      expect(sets).toHaveLength(1)
      expect(sets[0].param_id).toBe('ATC_RAT_RLL_P')
      expect(sets[0].param_value as number).toBeCloseTo(0.2, 5)

      transport.feed(paramValueFrame({ name: 'ATC_RAT_RLL_P', value: 0.2, count: 1, index: 0 }))
      await tick()
      sets = paramSetFrames(transport)
      expect(sets).toHaveLength(2)
      expect(sets[1].param_id).toBe('ATC_ANG_RLL_P')

      transport.feed(paramValueFrame({ name: 'ATC_ANG_RLL_P', value: 6, count: 1, index: 0 }))
      await tick()
      expect(screen.queryByText('Reboot required for changes to take effect')).not.toBeInTheDocument() // no rebootRequired param in this batch

      await tick(2000) // transient 'ok' chips clear
      expect(screen.queryByText(/pending — nothing written yet/)).not.toBeInTheDocument()
    })
  })

  describe('six Extended Tuning groups (issue #36)', () => {
    it('renders all six group cards, matching the Mico/MP Extended Tuning block structure', async () => {
      await renderLoaded()
      for (const title of ['RATE', 'STABILIZE', 'ALT HOLD', 'LOITER', 'WPNAV', 'FILTERS']) {
        expect(screen.getByText(title)).toBeInTheDocument()
      }
    })

    it('new-group sliders are metadata-driven and stage through the same Review Gate', async () => {
      const { transport } = await renderLoaded()

      const posz = screen.getByLabelText('PSC_POSZ_P') // AltHold
      expect(posz).toHaveAttribute('min', '1')
      expect(posz).toHaveAttribute('max', '3')
      expect(screen.getByLabelText('WPNAV_SPEED')).toHaveAttribute('step', '50')

      fireEvent.pointerUp(dragSlider('LOIT_SPEED', '1000')) // Loiter
      fireEvent.pointerUp(dragSlider('WPNAV_SPEED', '1500')) // WPNav
      expect(screen.getByText('2 pending — nothing written yet')).toBeInTheDocument()
      expect(screen.getByText('LOIT_SPEED → 1000')).toBeInTheDocument()
      expect(screen.getByText('WPNAV_SPEED → 1500')).toBeInTheDocument()
      expect(paramSetFrames(transport)).toHaveLength(0)
    })
  })

  describe('Show Advanced toggle', () => {
    it('is off by default: advanced parameters are not rendered at all', async () => {
      await renderLoaded()
      expect(screen.getByRole('checkbox', { name: 'Show advanced' })).not.toBeChecked()
      expect(screen.queryByLabelText('ATC_RAT_RLL_IMAX')).not.toBeInTheDocument()
      expect(screen.queryByText('ATC_RAT_RLL_IMAX')).not.toBeInTheDocument()
      // An all-advanced section stays hidden with its label (Pilot Vertical is advanced-only).
      expect(screen.queryByText('Pilot')).not.toBeInTheDocument()
    })

    it('toggling on reveals metadata-driven advanced sliders that stage through the same Review Gate', async () => {
      const { transport } = await renderLoaded()
      fireEvent.click(screen.getByRole('checkbox', { name: 'Show advanced' }))

      const imax = screen.getByLabelText('ATC_RAT_RLL_IMAX')
      expect(imax).toHaveAttribute('min', '0')
      expect(imax).toHaveAttribute('max', '1')
      expect(imax).toHaveAttribute('step', '0.01')

      fireEvent.pointerUp(dragSlider('ATC_RAT_RLL_IMAX', '0.6'))
      expect(screen.getByText('1 pending — nothing written yet')).toBeInTheDocument()
      expect(screen.getByText('ATC_RAT_RLL_IMAX → 0.6')).toBeInTheDocument()
      expect(paramSetFrames(transport)).toHaveLength(0)
    })

    it('toggling back off hides the advanced sliders again but keeps their staged edits pending', async () => {
      await renderLoaded()
      const toggle = screen.getByRole('checkbox', { name: 'Show advanced' })
      fireEvent.click(toggle)
      fireEvent.pointerUp(dragSlider('ATC_RAT_RLL_IMAX', '0.6'))
      fireEvent.click(toggle)
      expect(screen.queryByLabelText('ATC_RAT_RLL_IMAX')).not.toBeInTheDocument()
      expect(screen.getByText('1 pending — nothing written yet')).toBeInTheDocument()
    })
  })

  describe('transmitter tuning knob (TUNE)', () => {
    it('offers the metadata enum options and stages a selection without writing', async () => {
      const { transport } = await renderLoaded()
      const select = screen.getByLabelText('TUNE')
      expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Rate Roll/Pitch kP' })).toBeInTheDocument()

      fireEvent.change(select, { target: { value: '4' } })
      expect(screen.getByText('1 pending — nothing written yet')).toBeInTheDocument()
      expect(screen.getByText('TUNE → 4')).toBeInTheDocument()
      expect(paramSetFrames(transport)).toHaveLength(0)
    })

    it('stages TUNE_MIN/TUNE_MAX numeric edits on commit, through the same pending set', async () => {
      const { transport } = await renderLoaded()
      const min = screen.getByLabelText('TUNE_MIN')
      fireEvent.change(min, { target: { value: '0.08' } })
      fireEvent.blur(min)
      const max = screen.getByLabelText('TUNE_MAX')
      fireEvent.change(max, { target: { value: '0.25' } })
      fireEvent.blur(max)

      expect(screen.getByText('2 pending — nothing written yet')).toBeInTheDocument()
      expect(screen.getByText('TUNE_MIN → 0.08')).toBeInTheDocument()
      expect(screen.getByText('TUNE_MAX → 0.25')).toBeInTheDocument()
      expect(paramSetFrames(transport)).toHaveLength(0)
    })

    it('falls back to a numeric field when the board value is outside the metadata enum list', async () => {
      const { transport } = await renderLoaded()
      // A passively broadcast PARAM_VALUE moves TUNE to 99 — not among the fixture's options.
      await act(async () => {
        transport.feed(paramValueFrame({ name: 'TUNE', value: 99, count: TUNING_PARAMS.length, index: 0 }))
      })
      const field = screen.getByLabelText('TUNE')
      expect(field.tagName).toBe('INPUT') // no dropdown that would hide the real value
      expect(field).toHaveValue('99')
      expect(screen.queryByRole('option', { name: 'None' })).not.toBeInTheDocument()
    })

    it('rejects a non-numeric TUNE_MIN without staging', async () => {
      await renderLoaded()
      const min = screen.getByLabelText('TUNE_MIN')
      fireEvent.change(min, { target: { value: 'abc' } })
      fireEvent.blur(min)
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.queryByText(/pending — nothing written yet/)).not.toBeInTheDocument()
    })
  })

  describe('initial-tune calculator', () => {
    it('shows a current → suggested comparison; staging enters the same set as slider edits; a deselected row is not staged', async () => {
      const { transport } = await renderLoaded()

      // A slider edit already staged — calculator rows must join it, not replace it.
      fireEvent.pointerUp(dragSlider('ATC_RAT_RLL_P', '0.2'))

      fireEvent.change(screen.getByLabelText('Prop diameter (in)'), { target: { value: '5' } })
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))

      // 5" 4S LiPo golden vector (#34 note): suggested INS_GYRO_FILTER 75 vs current 20.
      const gyroRow = screen.getByRole('checkbox', { name: 'INS_GYRO_FILTER' }).closest('tr')!
      expect(gyroRow).toHaveTextContent('20')
      expect(gyroRow).toHaveTextContent('75')

      fireEvent.click(screen.getByRole('checkbox', { name: 'ATC_ACCEL_Y_MAX' })) // deselect one of the 23 suggestion rows
      fireEvent.click(screen.getByRole('button', { name: 'Stage 22 selected' }))

      // 22 calculator rows + 1 slider edit, one shared Staged Changes set.
      expect(screen.getByText('23 pending — nothing written yet')).toBeInTheDocument()
      expect(screen.getByText('ATC_RAT_RLL_P → 0.2')).toBeInTheDocument()
      expect(screen.getByText('INS_GYRO_FILTER → 75')).toBeInTheDocument()
      expect(screen.getByText('ATC_RAT_PIT_FLTD → 37.5')).toBeInTheDocument()
      expect(screen.queryByText('ATC_ACCEL_Y_MAX → 31500')).not.toBeInTheDocument() // deselected row still in the table, but never staged
      expect(paramSetFrames(transport)).toHaveLength(0) // staging is not writing
    })

    it('rejects an invalid prop diameter without producing suggestions', async () => {
      await renderLoaded()
      fireEvent.change(screen.getByLabelText('Prop diameter (in)'), { target: { value: '0' } })
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
      expect(screen.getByRole('alert')).toHaveTextContent('Prop diameter must be greater than 0')
      // No suggestion-row checkboxes — only the page's Show advanced toggle remains.
      expect(screen.queryByRole('checkbox', { name: 'INS_GYRO_FILTER' })).not.toBeInTheDocument()
    })
  })

  describe('reboot-required banner', () => {
    it('appears after a written batch includes a rebootRequired param, and the CTA sends the reboot command', async () => {
      const { transport } = await renderLoaded()
      fireEvent.pointerUp(dragSlider('INS_ACCEL_FILTER', '30'))
      fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
      await tick()
      transport.feed(paramValueFrame({ name: 'INS_ACCEL_FILTER', value: 30, count: 1, index: 0 }))
      await tick()

      expect(screen.getByText('Reboot required for changes to take effect')).toBeInTheDocument()

      vi.spyOn(window, 'confirm').mockReturnValue(true)
      fireEvent.click(screen.getByRole('button', { name: 'Reboot' }))
      await tick()
      const reboot = transport.sent.map(decodeSent).find((f) => f.msgid === COMMAND_LONG_MSGID)
      expect(reboot?.fields.command).toBe(MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN)
    })
  })

  describe('disconnect handling', () => {
    it('disconnecting with pending edits clears them and shows a discard warning', async () => {
      await renderLoaded()
      fireEvent.pointerUp(dragSlider('ATC_RAT_RLL_P', '0.2'))
      expect(screen.getByText('1 pending — nothing written yet')).toBeInTheDocument()

      await act(async () => {
        useConnectionStore.setState({ phase: 'disconnected', paramStore: null, session: null })
      })

      expect(screen.getByText(/1 unsaved tuning change\(s\) were discarded/)).toBeInTheDocument()
      expect(useTuningStore.getState().pending.size).toBe(0)
    })
  })
})
