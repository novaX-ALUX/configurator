import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../../i18n'
import { SensorsCard } from '../SensorsCard'
import { useNavigationStore } from '../../../store/navigation'

const initialNavigationState = useNavigationStore.getState()

afterEach(() => {
  useNavigationStore.setState(initialNavigationState, true)
})

// MAV_SYS_STATUS_SENSOR bits (same values dashboardUtils documents):
// gyro 0x01 | accel 0x02 | mag 0x04 | baro 0x08 | gps 0x20 | optflow 0x40 | rangefinder 0x100
const ALL_SIX = 0x01 | 0x02 | 0x04 | 0x08 | 0x20 | 0x40 | 0x100

describe('SensorsCard', () => {
  it('renders all six tiles — absent sensors are visibly gray ("Not fitted"), never hidden', () => {
    // Only IMU/compass/baro/gps fitted and healthy; optflow + rangefinder absent.
    render(<SensorsCard sensors={{ present: 0x2f, enabled: 0x2f, health: 0x2f, ts: 0 }} />)

    for (const name of ['IMU', 'Compass', 'Baro', 'GPS', 'OptFlow', 'Rangefinder']) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
    expect(screen.getAllByText('OK')).toHaveLength(4)
    expect(screen.getAllByText('Not fitted')).toHaveLength(2)
  })

  it('an unhealthy enabled sensor renders as "Needs attention" (red), healthy ones as "OK" (green)', () => {
    // Everything fitted+enabled, compass (0x04) unhealthy.
    render(<SensorsCard sensors={{ present: ALL_SIX, enabled: ALL_SIX, health: ALL_SIX & ~0x04, ts: 0 }} />)

    expect(screen.getAllByText('OK')).toHaveLength(5)
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
  })

  it('a fitted-but-disabled sensor is gray "Disabled", not "Not fitted" — the tile never claims hardware is missing', () => {
    // Everything fitted, compass (0x04) not enabled.
    render(<SensorsCard sensors={{ present: ALL_SIX, enabled: ALL_SIX & ~0x04, health: ALL_SIX & ~0x04, ts: 0 }} />)

    expect(screen.getByText('Disabled')).toBeInTheDocument()
    expect(screen.queryByText('Not fitted')).not.toBeInTheDocument()
  })

  it('IMU and Compass tiles are buttons that navigate to the Calibration page; the rest are not interactive', () => {
    render(<SensorsCard sensors={{ present: ALL_SIX, enabled: ALL_SIX, health: ALL_SIX, ts: 0 }} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: /Compass/ }))
    expect(useNavigationStore.getState().activePage).toBe('calibration')
  })

  it('before the first SYS_STATUS arrives, every tile shows a gray em-dash — no status is fabricated', () => {
    render(<SensorsCard />)

    expect(screen.getAllByText('—')).toHaveLength(6)
    expect(screen.queryByText('OK')).not.toBeInTheDocument()
    expect(screen.queryByText('Not fitted')).not.toBeInTheDocument()
  })

  it('offline renders the "Offline" chip while keeping the full tile grid (UI G5)', () => {
    render(<SensorsCard offline />)

    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(screen.getByText('Sensors')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(6)
  })
})
