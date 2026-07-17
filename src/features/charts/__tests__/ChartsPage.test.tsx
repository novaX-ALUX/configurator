import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { ChartsPage } from '../ChartsPage'
import type { ChartHostProps } from '../ChartHost'
import { useConnectionStore } from '../../../store/connection'
import { useChartSelectionStore } from '../chartSelectionStore'
import { HistoryBuffer } from '../../../core/mavlink/recorder'
import type { MavSession } from '../../../core/mavlink/session'
import type { TelemetryState } from '../../../core/mavlink/telemetry'

// jsdom has no canvas, so uPlot cannot render here (issue #3's testing
// decision): the chart host is stubbed and these tests assert the page's
// states plus the exact data handed to the host. uPlot's actual drawing —
// including the crosshair — is verified manually in a browser; the stub
// captures each host's `onCursor` so the legend's readout *reaction* (plain
// React) is still testable here.
const cursorCallbacks: NonNullable<ChartHostProps['onCursor']>[] = []
vi.mock('../ChartHost', () => ({
  ChartHost: (props: ChartHostProps) => {
    if (props.onCursor) cursorCallbacks.push(props.onCursor)
    return <div data-testid="chart-host" data-props={JSON.stringify(props)} />
  },
}))

const initialConnection = useConnectionStore.getState()
const DEFAULT_SELECTION = ['attitude.roll', 'attitude.pitch', 'attitude.yaw']

beforeEach(() => {
  localStorage.clear()
  cursorCallbacks.length = 0
  useChartSelectionStore.setState({ selectedIds: [...DEFAULT_SELECTION] })
})

afterEach(() => {
  useConnectionStore.setState(initialConnection, true)
})

/**
 * Minimal double satisfying only what `useTelemetry` reads — same shape
 * DashboardPage.test.tsx's `fakeSession()` documents. `state` feeds the
 * picker's live readout; `subscribers` (when given) captures the
 * subscription callback so a test can push a later snapshot.
 */
function fakeSession(state: TelemetryState = {}, subscribers?: Array<(s: TelemetryState) => void>): MavSession {
  return {
    telemetry: {
      getState: () => state,
      subscribe: (cb: (s: TelemetryState) => void) => {
        subscribers?.push(cb)
        return () => {}
      },
    },
  } as unknown as MavSession
}

/** Expands a picker group by its header button ("RC (0/19)" etc.). */
function expandGroup(name: RegExp): void {
  fireEvent.click(screen.getByRole('button', { name }))
}

/** `n` attitude Block updates the way the Recorder writes them: roll/pitch/yaw appended together per update, sharing one receive timestamp. */
function attitudeHistory(n: number): HistoryBuffer {
  const buffer = new HistoryBuffer()
  for (let i = 0; i < n; i++) {
    const ts = 1_000 + i * 100
    buffer.append('attitude.roll', ts, 10 + i)
    buffer.append('attitude.pitch', ts, -5 + i)
    buffer.append('attitude.yaw', ts, i === 1 ? null : 90 + i)
  }
  return buffer
}

function connectedWith(history: HistoryBuffer): void {
  useConnectionStore.setState({ phase: 'connected', session: fakeSession(), history })
}

/** Parses the stubbed chart host's props inside one Unit Group's subplot. */
function hostProps(group: string): ChartHostProps {
  const subplot = screen.getByTestId(`subplot-${group}`)
  const host = within(subplot).getByTestId('chart-host')
  return JSON.parse(host.getAttribute('data-props')!) as ChartHostProps
}

describe('ChartsPage', () => {
  it('disconnected with no recorded history: renders the full layout (picker + empty chart area), not a full-page placeholder — the picker is marked awaiting connection and its checkboxes are disabled (UI G5, issue #10)', () => {
    useConnectionStore.setState({ phase: 'disconnected', session: null, history: new HistoryBuffer() })

    render(<ChartsPage />)

    // Picker still renders: all five Block groups listed, the default
    // selection's group (Attitude) expanded with its checkboxes disabled.
    for (const block of [/^Attitude/, /^Power/, /^GPS/, /^RC/, /^Servo/]) {
      expect(screen.getByRole('button', { name: block })).toBeInTheDocument()
    }
    expect(screen.getByText('Awaiting connection')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Roll' })).toBeDisabled()
    // "Offline" (not "— frozen": there's nothing recorded yet).
    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(screen.queryByText('Offline — frozen')).not.toBeInTheDocument()
    // The default selection's empty chart layout still renders (real
    // subplot, zero Samples) rather than a connect-first placeholder.
    expect(screen.getByTestId('subplot-deg')).toBeInTheDocument()
    expect(hostProps('deg').series.every((s) => s.timestampsMs.length === 0)).toBe(true)
  })

  it('connecting: same awaiting-connection layout — only "connected" counts as online', () => {
    useConnectionStore.setState({ phase: 'connecting', session: null, history: new HistoryBuffer() })
    render(<ChartsPage />)
    expect(screen.getByRole('checkbox', { name: 'Roll' })).toBeDisabled()
    expect(screen.getByText('Awaiting connection')).toBeInTheDocument()
  })

  it('reconnecting enables the picker immediately and fades the "Offline" marker out (rather than vanishing) without a remount', async () => {
    vi.useFakeTimers()
    try {
      useConnectionStore.setState({ phase: 'disconnected', session: null, history: new HistoryBuffer() })
      render(<ChartsPage />)
      expect(screen.getByRole('checkbox', { name: 'Roll' })).toBeDisabled()

      act(() => {
        useConnectionStore.setState({ phase: 'connected', session: fakeSession() })
      })

      // The picker's enabled state isn't animated — it flips the same tick.
      expect(screen.getByRole('checkbox', { name: 'Roll' })).toBeEnabled()
      expect(screen.queryByText('Awaiting connection')).not.toBeInTheDocument()
      // The "Offline" chip is still mid-fade (aria-hidden immediately, but
      // still in the DOM) rather than gone the instant `phase` flips.
      expect(screen.getByText('Offline')).toHaveAttribute('aria-hidden', 'true')

      await vi.advanceTimersByTimeAsync(200)

      expect(screen.queryByText('Offline')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists all 43 Series as checkboxes across the five Block groups once expanded; fix_type is absent', () => {
    connectedWith(attitudeHistory(1))
    render(<ChartsPage />)

    // Attitude (the default selection's group) is already expanded.
    for (const block of [/^Power/, /^GPS/, /^RC/, /^Servo/]) expandGroup(block)
    expect(screen.getAllByRole('checkbox')).toHaveLength(43)
    // Interpolated labels cover the full RC/servo ranges…
    expect(screen.getByRole('checkbox', { name: 'CH18' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'OUT16' })).toBeInTheDocument()
    // …and the one excluded field never shows up.
    expect(screen.queryByRole('checkbox', { name: /fix/i })).not.toBeInTheDocument()
  })

  it('default selection: one degrees subplot fed the recorded attitude Samples — real timestamps, null gaps, one shared 60s window', () => {
    connectedWith(attitudeHistory(3))
    render(<ChartsPage />)

    expect(screen.getAllByTestId('chart-host')).toHaveLength(1)
    const props = hostProps('deg')
    expect(props.windowSec).toBe(60)
    expect(props.windowEndMs).toBe(1200)
    expect(props.series.map((s) => s.label)).toEqual(['Roll', 'Pitch', 'Yaw'])
    for (const s of props.series) expect(s.timestampsMs).toEqual([1000, 1100, 1200])
    expect(props.series[0].values).toEqual([10, 11, 12])
    expect(props.series[2].values).toEqual([90, null, 92])
    expect(new Set(props.series.map((s) => s.color)).size).toBe(3)
  })

  it('N distinct Unit Groups -> exactly N stacked subplots, in fixed group order, sharing one window end', () => {
    const history = attitudeHistory(3) // newest ts 1200
    history.append('power.voltage', 1150, 12.6)
    useChartSelectionStore.setState({ selectedIds: ['power.voltage', 'attitude.roll', 'attitude.pitch'] })
    connectedWith(history)

    render(<ChartsPage />)

    const hosts = screen.getAllByTestId('chart-host')
    expect(hosts).toHaveLength(2)
    // degrees before volts (UNIT_GROUP_ORDER), regardless of selection order
    expect(screen.getByTestId('subplot-deg').compareDocumentPosition(screen.getByTestId('subplot-V')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(hostProps('deg').series.map((s) => s.label)).toEqual(['Roll', 'Pitch'])
    expect(hostProps('V').series.map((s) => s.label)).toEqual(['Voltage'])
    // both subplots pin to the page-wide newest Sample, not their own
    expect(hostProps('deg').windowEndMs).toBe(1200)
    expect(hostProps('V').windowEndMs).toBe(1200)
  })

  it('Series sharing a unit share one subplot even across Blocks, each keeping its own timestamps (RC + servo -> µs)', () => {
    const history = new HistoryBuffer()
    history.append('rc.ch3', 1050, 1500)
    history.append('servo.out1', 1075, 1100)
    history.append('rc.ch3', 1250, 1512)
    useChartSelectionStore.setState({ selectedIds: ['rc.ch3', 'servo.out1'] })
    connectedWith(history)

    render(<ChartsPage />)

    expect(screen.getAllByTestId('chart-host')).toHaveLength(1)
    const props = hostProps('us')
    expect(props.series.map((s) => s.label)).toEqual(['CH3', 'OUT1'])
    expect(props.series[0].timestampsMs).toEqual([1050, 1250])
    expect(props.series[1].timestampsMs).toEqual([1075])
    expect(props.windowEndMs).toBe(1250)
  })

  it('picking a Series from a new Unit Group adds its subplot; deselecting it again removes it', () => {
    connectedWith(attitudeHistory(2))
    render(<ChartsPage />)

    expect(screen.queryByTestId('subplot-us')).not.toBeInTheDocument()
    expandGroup(/^RC/)
    fireEvent.click(screen.getByRole('checkbox', { name: 'CH3' }))
    expect(screen.getByTestId('subplot-us')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'CH3' }))
    expect(screen.queryByTestId('subplot-us')).not.toBeInTheDocument()
    expect(screen.getByTestId('subplot-deg')).toBeInTheDocument()
  })

  it('nothing selected: an empty-state hint with the picker still available, never a blank page', () => {
    useChartSelectionStore.setState({ selectedIds: [] })
    connectedWith(attitudeHistory(2))

    render(<ChartsPage />)

    expect(screen.getByText('No Series selected')).toBeInTheDocument()
    expect(screen.queryByTestId('chart-host')).not.toBeInTheDocument()
    // Still pickable: every group starts collapsed (nothing selected), but
    // expanding one exposes enabled checkboxes.
    expandGroup(/^Attitude/)
    expect(screen.getByRole('checkbox', { name: 'Roll' })).toBeEnabled()
  })

  it('selection survives navigating away and back (unmount/remount) and is written to localStorage', () => {
    connectedWith(attitudeHistory(2))
    const { unmount } = render(<ChartsPage />)
    expandGroup(/^Power/)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Voltage' }))
    unmount()

    render(<ChartsPage />)
    expect(screen.getByRole('checkbox', { name: 'Voltage' })).toBeChecked()
    expect(screen.getByTestId('subplot-V')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('novax.charts.selectedSeries')!)).toContain('power.voltage')
  })

  it('legend lists each visible Series with its latest value; a trailing gap reads as absent, not zero', () => {
    // attitudeHistory(2): latest roll 11, pitch -4, yaw null (the i===1 gap)
    connectedWith(attitudeHistory(2))
    render(<ChartsPage />)

    const subplot = screen.getByTestId('subplot-deg')
    expect(within(subplot).getByText('Roll')).toBeInTheDocument()
    expect(within(subplot).getByText('11')).toBeInTheDocument()
    expect(within(subplot).getByText('-4')).toBeInTheDocument()
    expect(within(subplot).getByText('—')).toBeInTheDocument()
    expect(within(subplot).queryByText('0')).not.toBeInTheDocument()
  })

  it('while hovering, the legend reads out the cursor values and timestamp; leaving snaps back to latest', () => {
    connectedWith(attitudeHistory(2)) // latest: roll 11, pitch -4, yaw — (gap)
    render(<ChartsPage />)
    const subplot = screen.getByTestId('subplot-deg')

    act(() => {
      cursorCallbacks.at(-1)!({
        tsMs: 1000,
        series: [
          { value: 10, tsMs: 1000 },
          { value: -5, tsMs: 1000 },
          // resolved from its own nearest Sample, 75ms off the crosshair —
          // the mixed-Block case where the row must carry its true timestamp
          { value: 90, tsMs: 1075 },
        ],
      })
    })
    expect(within(subplot).getByText('10')).toBeInTheDocument()
    expect(within(subplot).getByText('-5')).toBeInTheDocument()
    expect(within(subplot).getByText('90')).toBeInTheDocument()
    expect(within(subplot).getByText(/\.000$/)).toBeInTheDocument() // crosshair timestamp in the header
    expect(within(subplot).getByText(/\.075$/)).toBeInTheDocument() // the off-crosshair row's own timestamp
    expect(within(subplot).getAllByText(/\.\d{3}$/)).toHaveLength(2) // rows matching the crosshair stay clean

    act(() => {
      cursorCallbacks.at(-1)!(null)
    })
    expect(within(subplot).getByText('11')).toBeInTheDocument()
    expect(within(subplot).getByText('—')).toBeInTheDocument()
    expect(within(subplot).queryByText(/\.000$/)).not.toBeInTheDocument()
  })

  it('Pause freezes the display while recording continues; Resume shows everything recorded meanwhile', () => {
    const history = attitudeHistory(2) // ts 1000, 1100
    connectedWith(history)
    const { rerender } = render(<ChartsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    // the Recorder keeps appending while the display is paused
    history.append('attitude.roll', 1200, 12)
    history.append('attitude.pitch', 1200, -3)
    history.append('attitude.yaw', 1200, 92)
    rerender(<ChartsPage />) // the telemetry-cadence redraw that would normally advance the chart

    let props = hostProps('deg')
    expect(props.series[0].timestampsMs).toEqual([1000, 1100]) // display frozen…
    expect(props.windowEndMs).toBe(1100)
    expect(within(screen.getByTestId('subplot-deg')).getByText('11')).toBeInTheDocument() // …legend too

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    props = hostProps('deg')
    expect(props.series[0].timestampsMs).toEqual([1000, 1100, 1200]) // nothing recorded during the pause was lost
    expect(props.windowEndMs).toBe(1200)
  })

  it('pause is display-local state: a remount starts live again', () => {
    connectedWith(attitudeHistory(2))
    const { unmount } = render(<ChartsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    unmount()

    render(<ChartsPage />)
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('a new session (reconnect) resets pause to live', () => {
    const history = attitudeHistory(2)
    connectedWith(history)
    render(<ChartsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))

    history.append('attitude.roll', 1200, 12)
    history.append('attitude.pitch', 1200, -3)
    history.append('attitude.yaw', 1200, 92)
    act(() => {
      useConnectionStore.setState({ session: fakeSession() })
    })

    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(hostProps('deg').series[0].timestampsMs).toEqual([1000, 1100, 1200])
  })

  it('disconnected with history: the frozen History Buffer stays inspectable, marked "Offline — frozen" (CONTEXT.md: survives disconnect frozen, cleared only on next connect)', () => {
    useConnectionStore.setState({ phase: 'disconnected', session: null, history: attitudeHistory(2) })

    render(<ChartsPage />)

    expect(hostProps('deg').series[0].timestampsMs).toEqual([1000, 1100])
    expect(screen.getByText('Offline — frozen')).toBeInTheDocument()
    // There IS recorded history, so the picker is not disabled — the user
    // can still change which Series are inspected in the frozen buffer.
    expect(screen.getByRole('checkbox', { name: 'Roll' })).toBeEnabled()
    expect(screen.queryByText('Awaiting connection')).not.toBeInTheDocument()
  })

  it('picker groups holding a selected Series start expanded, the rest collapsed (issue #49 — no more 43-chip wall)', () => {
    connectedWith(attitudeHistory(1))
    render(<ChartsPage />)

    expect(screen.getByRole('button', { name: /^Attitude/ })).toHaveAttribute('aria-expanded', 'true')
    for (const block of [/^Power/, /^GPS/, /^RC/, /^Servo/]) {
      expect(screen.getByRole('button', { name: block })).toHaveAttribute('aria-expanded', 'false')
    }
    // Collapsed groups keep their Series out of the DOM entirely.
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    expect(screen.queryByRole('checkbox', { name: 'CH3' })).not.toBeInTheDocument()
  })

  it('collapsing a group preserves its selection: the subplot stays, the header count still shows it, re-expanding finds it checked', () => {
    connectedWith(attitudeHistory(2))
    render(<ChartsPage />)

    expandGroup(/^RC/)
    fireEvent.click(screen.getByRole('checkbox', { name: 'CH3' }))
    expect(screen.getByTestId('subplot-us')).toBeInTheDocument()

    expandGroup(/^RC/) // collapse again
    expect(screen.queryByRole('checkbox', { name: 'CH3' })).not.toBeInTheDocument()
    expect(screen.getByTestId('subplot-us')).toBeInTheDocument() // still charted
    expect(screen.getByRole('button', { name: /^RC/ })).toHaveTextContent('RC (1/19)')

    expandGroup(/^RC/)
    expect(screen.getByRole('checkbox', { name: 'CH3' })).toBeChecked()
    // And the persisted store never saw the collapse.
    expect(JSON.parse(localStorage.getItem('novax.charts.selectedSeries')!)).toContain('rc.ch3')
  })

  it('each selected Series shows its live Snapshot value (already unit-converted) beside the checkbox; unselected Series show none', () => {
    useChartSelectionStore.setState({ selectedIds: ['attitude.roll', 'attitude.pitch', 'power.voltage'] })
    const snapshot: TelemetryState = {
      attitude: { rollDeg: 12.34, pitchDeg: -4.26, yawDeg: 180.05, ts: 1000 },
      power: { voltage: 12.61, ts: 1000 },
    }
    useConnectionStore.setState({ phase: 'connected', session: fakeSession(snapshot), history: attitudeHistory(1) })

    render(<ChartsPage />)
    const picker = screen.getByTestId('series-picker')

    // Snapshot values at each Unit Group's display precision, with a unit.
    expect(within(picker).getByText('12.3')).toBeInTheDocument() // roll, deg → 1 decimal
    expect(within(picker).getByText('-4.3')).toBeInTheDocument() // pitch, rounded
    expect(within(picker).getByText('12.61')).toBeInTheDocument() // voltage, V → 2 decimals
    expect(within(picker).getAllByText('deg')).toHaveLength(2)
    expect(within(picker).getByText('V')).toBeInTheDocument()
    // Yaw is unselected — its Snapshot value must not render.
    expect(within(picker).queryByText('180.1')).not.toBeInTheDocument()
    // The checkbox's accessible name stays the label alone, without the value.
    expect(screen.getByRole('checkbox', { name: 'Roll' })).toBeChecked()
  })

  it('the picker readout is live: a new Snapshot updates it; a Block that never arrived reads as "—"', () => {
    useChartSelectionStore.setState({ selectedIds: ['power.voltage', 'rc.ch3'] })
    const subscribers: Array<(s: TelemetryState) => void> = []
    const first: TelemetryState = { power: { voltage: 12.61, ts: 1000 } }
    useConnectionStore.setState({ phase: 'connected', session: fakeSession(first, subscribers), history: attitudeHistory(1) })

    render(<ChartsPage />)
    const picker = screen.getByTestId('series-picker')

    expect(within(picker).getByText('12.61')).toBeInTheDocument()
    expect(within(picker).getByText('—')).toBeInTheDocument() // rc.ch3: no RC Block yet

    act(() => {
      subscribers[0]({ power: { voltage: 11.98, ts: 2000 }, rc: { channels: [1500, 1500, 1512], ts: 2000 } })
    })

    expect(within(picker).getByText('11.98')).toBeInTheDocument()
    expect(within(picker).queryByText('12.61')).not.toBeInTheDocument()
    expect(within(picker).getByText('1512')).toBeInTheDocument()
    expect(within(picker).queryByText('—')).not.toBeInTheDocument()
  })

  it('offline: selected Series read "—" in the picker — there is no live Snapshot to show', () => {
    useConnectionStore.setState({ phase: 'disconnected', session: null, history: attitudeHistory(2) })
    render(<ChartsPage />)

    const picker = screen.getByTestId('series-picker')
    expect(within(picker).getAllByText('—')).toHaveLength(3) // roll, pitch, yaw
  })
})
