import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { ChartsPage } from '../ChartsPage'
import type { ChartHostProps } from '../ChartHost'
import { useConnectionStore } from '../../../store/connection'
import { useChartSelectionStore } from '../chartSelectionStore'
import { HistoryBuffer } from '../../../core/mavlink/recorder'
import type { MavSession } from '../../../core/mavlink/session'

// jsdom has no canvas, so uPlot cannot render here (issue #3's testing
// decision): the chart host is stubbed and these tests assert the page's
// states plus the exact data handed to the host. uPlot's actual drawing is
// verified manually in a browser.
vi.mock('../ChartHost', () => ({
  ChartHost: (props: ChartHostProps) => (
    <div data-testid="chart-host" data-props={JSON.stringify(props)} />
  ),
}))

const initialConnection = useConnectionStore.getState()
const DEFAULT_SELECTION = ['attitude.roll', 'attitude.pitch', 'attitude.yaw']

beforeEach(() => {
  localStorage.clear()
  useChartSelectionStore.setState({ selectedIds: [...DEFAULT_SELECTION] })
})

afterEach(() => {
  useConnectionStore.setState(initialConnection, true)
})

/** Minimal double satisfying only what `useTelemetry` reads — same shape DashboardPage.test.tsx's `fakeSession()` documents. */
function fakeSession(): MavSession {
  return {
    telemetry: {
      getState: () => ({}),
      subscribe: () => () => {},
    },
  } as unknown as MavSession
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
  it('not connected with no recorded history: shows the placeholder; CTA calls connect() only while truly disconnected', () => {
    const calls: unknown[] = []
    useConnectionStore.setState({
      phase: 'disconnected',
      baud: 115200,
      session: null,
      history: new HistoryBuffer(),
      connect: (baud, opts) => {
        calls.push([baud, opts])
        return Promise.resolve()
      },
    })

    render(<ChartsPage />)

    expect(screen.getByText('No chart data yet')).toBeInTheDocument()
    expect(screen.queryByTestId('chart-host')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect flight controller' }))
    expect(calls).toEqual([[115200, undefined]])
  })

  it('connecting: the placeholder CTA is disabled (connect() would be a silent no-op there)', () => {
    useConnectionStore.setState({ phase: 'connecting', session: null, history: new HistoryBuffer() })
    render(<ChartsPage />)
    expect(screen.getByRole('button', { name: 'Connect flight controller' })).toBeDisabled()
  })

  it('lists all 43 Series as checkboxes grouped by Block; fix_type is absent', () => {
    connectedWith(attitudeHistory(1))
    render(<ChartsPage />)

    expect(screen.getAllByRole('checkbox')).toHaveLength(43)
    for (const block of ['Attitude', 'Power', 'GPS', 'RC', 'Servo']) {
      expect(screen.getByText(block)).toBeInTheDocument()
    }
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
    expect(screen.getAllByRole('checkbox')).toHaveLength(43) // still pickable
  })

  it('selection survives navigating away and back (unmount/remount) and is written to localStorage', () => {
    connectedWith(attitudeHistory(2))
    const { unmount } = render(<ChartsPage />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Voltage' }))
    unmount()

    render(<ChartsPage />)
    expect(screen.getByRole('checkbox', { name: 'Voltage' })).toBeChecked()
    expect(screen.getByTestId('subplot-V')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('novax.charts.selectedSeries')!)).toContain('power.voltage')
  })

  it('disconnected with history: the frozen traces stay inspectable instead of the placeholder', () => {
    useConnectionStore.setState({ phase: 'disconnected', session: null, history: attitudeHistory(2) })

    render(<ChartsPage />)

    expect(hostProps('deg').series[0].timestampsMs).toEqual([1000, 1100])
    expect(screen.queryByText('No chart data yet')).not.toBeInTheDocument()
  })
})
