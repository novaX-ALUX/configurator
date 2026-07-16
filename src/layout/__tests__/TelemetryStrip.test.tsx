import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../i18n'
import { TelemetryStrip } from '../TelemetryStrip'
import { useConnectionStore, type StatusTextEntry } from '../../store/connection'
import { useNavigationStore } from '../../store/navigation'
import type { MavSession } from '../../core/mavlink/session'
import type { TelemetryState } from '../../core/mavlink/telemetry'
import type { MavRouterStats } from '../../core/mavlink/router'

const initialConnectionState = useConnectionStore.getState()
const initialNavigationState = useNavigationStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
  useNavigationStore.setState(initialNavigationState, true)
})

/** Same minimal double as DashboardPage.test.tsx's own `fakeSession` — only what `useTelemetry` reads. */
function fakeSession(state: TelemetryState): MavSession {
  return {
    telemetry: {
      getState: () => state,
      subscribe: () => () => {},
    },
  } as unknown as MavSession
}

function entry(overrides: Partial<StatusTextEntry> = {}): StatusTextEntry {
  return { severity: 4, text: 'PreArm: Compass not calibrated', ts: 0, ...overrides }
}

const STATS: MavRouterStats = { framesIn: 100, framesOut: 10, decodeErrors: 0, signedDropped: 0, crcErrors: 0, badMsgId: 0, dropped: 0 }

describe('TelemetryStrip', () => {
  it('renders nothing while disconnected/connecting — no session to read yet', () => {
    for (const phase of ['disconnected', 'connecting'] as const) {
      useConnectionStore.setState({ phase, session: null })
      const { container, unmount } = render(<TelemetryStrip />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('lost: still renders — the session/telemetry are still live (frozen), and ARMED must stay visible exactly while the link is degrading', () => {
    useConnectionStore.setState({
      phase: 'lost',
      session: fakeSession({ heartbeat: { armed: true, customMode: 5, baseMode: 0x80, systemStatus: 4, ts: 0 } }),
      statustext: [],
      linkStats: null,
    })
    render(<TelemetryStrip />)
    expect(screen.getByText('ARMED')).toBeInTheDocument()
  })

  it('connected, no telemetry yet: every item renders an honest em-dash, never a fabricated value', () => {
    useConnectionStore.setState({ phase: 'connected', session: fakeSession({}), statustext: [], linkStats: null })
    render(<TelemetryStrip />)
    // Arm chip, mode chip, prearm chip, battery, gps, link — six dashes.
    expect(screen.getAllByText('—')).toHaveLength(6)
  })

  it('armed: renders the ARMED pill and a Ready PreArm chip', () => {
    useConnectionStore.setState({
      phase: 'connected',
      session: fakeSession({ heartbeat: { armed: true, customMode: 5, baseMode: 0x80, systemStatus: 4, ts: 0 } }),
      statustext: [],
      linkStats: null,
    })
    render(<TelemetryStrip />)
    expect(screen.getByText('ARMED')).toBeInTheDocument()
    expect(screen.getByText('LOITER')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
  })

  it('disarmed with two distinct PreArm failures: shows "Not Ready +2" and clicking it navigates to the debug page', () => {
    useConnectionStore.setState({
      phase: 'connected',
      session: fakeSession({ heartbeat: { armed: false, customMode: 0, baseMode: 0, systemStatus: 4, ts: 0 } }),
      statustext: [entry({ text: 'PreArm: Compass not calibrated' }), entry({ text: 'PreArm: Waiting for GPS HDOP' })],
      linkStats: null,
    })
    render(<TelemetryStrip />)
    expect(screen.getByText('DISARMED')).toBeInTheDocument()

    const prearmButton = screen.getByRole('button', { name: 'Not Ready +2' })
    fireEvent.click(prearmButton)
    expect(useNavigationStore.getState().activePage).toBe('debug')
  })

  it('renders battery voltage/current, GPS fix + satellite count, and link loss percent from real telemetry/linkStats', () => {
    useConnectionStore.setState({
      phase: 'connected',
      session: fakeSession({
        power: { voltage: 12.42, current: 3.7, batteryRemaining: undefined, ts: 0 },
        gps: { fixType: 3, satellites: 9, ts: 0 },
      }),
      statustext: [],
      linkStats: { ...STATS, framesIn: 95, dropped: 5 },
    })
    render(<TelemetryStrip />)
    expect(screen.getByText('12.42')).toBeInTheDocument()
    expect(screen.getByText('3.7A')).toBeInTheDocument()
    expect(screen.getByText('9')).toBeInTheDocument()
    expect(screen.getByText('5.0% loss')).toBeInTheDocument()
  })

  it('no layout shift when current/satellites arrive after voltage/fix: the battery and GPS slots keep the same child count either way (only their text content changes)', () => {
    useConnectionStore.setState({
      phase: 'connected',
      session: fakeSession({
        power: { voltage: 12.42, current: undefined, batteryRemaining: undefined, ts: 0 },
        gps: { fixType: 3, satellites: 0, ts: 0 },
      }),
      statustext: [],
      linkStats: null,
    })
    const { rerender } = render(<TelemetryStrip />)
    const childCountBefore = {
      battery: screen.getByTestId('strip-battery').children.length,
      gps: screen.getByTestId('strip-gps').children.length,
    }

    useConnectionStore.setState({
      session: fakeSession({
        power: { voltage: 12.42, current: 3.7, batteryRemaining: undefined, ts: 0 },
        gps: { fixType: 3, satellites: 9, ts: 0 },
      }),
    })
    rerender(<TelemetryStrip />)
    const childCountAfter = {
      battery: screen.getByTestId('strip-battery').children.length,
      gps: screen.getByTestId('strip-gps').children.length,
    }

    expect(childCountAfter).toEqual(childCountBefore)
  })
})
