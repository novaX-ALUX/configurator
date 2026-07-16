import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { ChartsPage } from '../ChartsPage'
import type { ChartHostProps } from '../ChartHost'
import { useConnectionStore } from '../../../store/connection'
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

const initialState = useConnectionStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialState, true)
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

/** A History Buffer with `n` attitude Block updates, the way the Recorder writes them: roll/pitch/yaw appended together per update, sharing one receive timestamp. */
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

function hostProps(): ChartHostProps {
  return JSON.parse(screen.getByTestId('chart-host').getAttribute('data-props')!) as ChartHostProps
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

  it('connected: hands the chart host the recorded attitude Samples — true degree values, real timestamps, one 60s window', () => {
    useConnectionStore.setState({
      phase: 'connected',
      session: fakeSession(),
      history: attitudeHistory(3),
    })

    render(<ChartsPage />)

    const props = hostProps()
    expect(props.timestampsMs).toEqual([1000, 1100, 1200])
    expect(props.windowSec).toEqual(60)
    expect(props.series).toEqual([
      { label: 'Roll', color: '#2B5CE6', values: [10, 11, 12] },
      { label: 'Pitch', color: '#1E9E6A', values: [-5, -4, -3] },
      { label: 'Yaw', color: '#D97706', values: [90, null, 92] },
    ])
  })

  it('connected with nothing recorded yet: renders the (empty) chart, not the placeholder', () => {
    useConnectionStore.setState({ phase: 'connected', session: fakeSession(), history: new HistoryBuffer() })

    render(<ChartsPage />)

    expect(hostProps().timestampsMs).toEqual([])
    expect(screen.queryByText('No chart data yet')).not.toBeInTheDocument()
  })

  it('disconnected with history: the frozen trace stays inspectable instead of the placeholder', () => {
    useConnectionStore.setState({ phase: 'disconnected', session: null, history: attitudeHistory(2) })

    render(<ChartsPage />)

    expect(hostProps().timestampsMs).toEqual([1000, 1100])
    expect(screen.queryByText('No chart data yet')).not.toBeInTheDocument()
  })
})
