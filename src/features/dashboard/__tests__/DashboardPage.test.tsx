import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { DashboardPage } from '../DashboardPage'
import { useConnectionStore, type StatusTextEntry } from '../../../store/connection'
import type { MavSession } from '../../../core/mavlink/session'
import type { TelemetryState } from '../../../core/mavlink/telemetry'

const initialState = useConnectionStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialState, true)
})

/** Minimal double satisfying only what `useTelemetry` reads (`session.telemetry.getState()`/`.subscribe()`) — same shape useTelemetry.test.ts's own `makeSession()` documents needing, but without a real MavRouter/MockTransport since this page never touches the router directly. */
function fakeSession(state: TelemetryState): MavSession {
  return {
    telemetry: {
      getState: () => state,
      subscribe: () => () => {},
    },
  } as unknown as MavSession
}

function entry(overrides: Partial<StatusTextEntry> = {}): StatusTextEntry {
  return { severity: 6, text: 'hello', ts: 0, ...overrides }
}

describe('DashboardPage', () => {
  it('disconnected: renders the full card layout (not a full-page placeholder), with an "Offline" chip on every Block card and em-dash/no-data fallbacks — nothing pretends to be live (UI G5, issue #10)', () => {
    useConnectionStore.setState({ phase: 'disconnected', session: null, paramStore: null, statustext: [] })

    render(<DashboardPage />)

    // Full layout intact — every card's title still renders.
    expect(screen.getByText('Attitude')).toBeInTheDocument()
    expect(screen.getByText('Vehicle')).toBeInTheDocument()
    expect(screen.getByText('Power')).toBeInTheDocument()
    expect(screen.getByText('GPS')).toBeInTheDocument()
    expect(screen.getByText('Motor Outputs')).toBeInTheDocument()
    expect(screen.getByText('RC Channels')).toBeInTheDocument()
    // One "Offline" chip per Block (attitude, vehicle, power, gps, motors, rc).
    expect(screen.getAllByText('Offline')).toHaveLength(6)
    // No live data is fabricated — the same no-data fallbacks used while
    // connected-but-no-telemetry-yet.
    expect(screen.getByText('No heartbeat')).toBeInTheDocument()
    expect(screen.getByText('No data')).toBeInTheDocument()
    expect(screen.getByText('No motor output telemetry yet.')).toBeInTheDocument()
    expect(screen.getByText('No RC channel telemetry yet.')).toBeInTheDocument()
  })

  it('connecting/lost: still full layout with "Offline" chips (only "connected" counts as online)', () => {
    useConnectionStore.setState({ phase: 'connecting', session: null })
    const { unmount } = render(<DashboardPage />)
    expect(screen.getAllByText('Offline')).toHaveLength(6)
    unmount()

    useConnectionStore.setState({ phase: 'lost' })
    render(<DashboardPage />)
    expect(screen.getAllByText('Offline')).toHaveLength(6)
  })

  it('reconnecting restores live rendering without a remount — the "Offline" chips fade out (not vanish) and are gone once the exit transition finishes', async () => {
    vi.useFakeTimers()
    try {
      useConnectionStore.setState({ phase: 'disconnected', session: null, paramStore: null, statustext: [] })
      render(<DashboardPage />)
      expect(screen.getAllByText('Offline')).toHaveLength(6)

      act(() => {
        useConnectionStore.setState({ phase: 'connected' })
      })

      // Still present but marked `aria-hidden` immediately — mid-fade, not
      // pretending to be a live status for assistive tech.
      for (const chip of screen.getAllByText('Offline')) {
        expect(chip).toHaveAttribute('aria-hidden', 'true')
      }

      await vi.advanceTimersByTimeAsync(200)

      expect(screen.queryByText('Offline')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('connected with no session/telemetry yet: renders every card in its own no-data state without crashing, and no "Offline" chip', () => {
    useConnectionStore.setState({ phase: 'connected', session: null, paramStore: null, statustext: [] })

    render(<DashboardPage />)

    expect(screen.getByText('No heartbeat')).toBeInTheDocument()
    expect(screen.getByText('No data')).toBeInTheDocument()
    expect(screen.getByText('No motor output telemetry yet.')).toBeInTheDocument()
    expect(screen.getByText('No RC channel telemetry yet.')).toBeInTheDocument()
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it('connected with a full telemetry snapshot: populates every card, and resolves frame/pre-arm from paramStore/statustext', () => {
    const session = fakeSession({
      attitude: { rollDeg: 12.3, pitchDeg: -4.5, yawDeg: 90, ts: 0 },
      power: { voltage: 15.8, current: 8.2, batteryRemaining: 63, ts: 0 },
      gps: { fixType: 3, satellites: 14, hdop: 0.8, ts: 0 },
      rc: { channels: [1500, 1500, 1100, 1500, 1900, 1500, 1000, 2000], ts: 0 },
      servo: { outputs: [1500, 1500, 1500, 1500, 0, 0, 0, 0], ts: 0 },
      heartbeat: { armed: true, customMode: 5, baseMode: 0, systemStatus: 0, ts: 0 },
    })
    useConnectionStore.setState({
      phase: 'connected',
      session,
      paramStore: { get: (name: string) => (name === 'FRAME_CLASS' ? { name, value: 1, type: 9, index: 0 } : undefined) } as never,
      statustext: [entry({ text: 'PreArm: Compass not calibrated' }), entry({ text: 'info thing' })],
    })

    render(<DashboardPage />)

    expect(screen.getByText('+12.3°')).toBeInTheDocument()
    expect(screen.getByText('Armed')).toBeInTheDocument()
    expect(screen.getByText('LOITER')).toBeInTheDocument()
    expect(screen.getByText('Class 1')).toBeInTheDocument()
    expect(screen.getByText('PreArm: Compass not calibrated')).toBeInTheDocument()
    expect(screen.getByText('63% remaining')).toBeInTheDocument()
    expect(screen.getByText('3D fix')).toBeInTheDocument()
    expect(screen.getByText('14')).toBeInTheDocument()
    expect(screen.getByText('2000')).toBeInTheDocument()
  })
})
