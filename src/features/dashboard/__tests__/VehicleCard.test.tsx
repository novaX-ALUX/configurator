import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../../i18n'
import { VehicleCard } from '../VehicleCard'

describe('VehicleCard', () => {
  it('renders a red ARMED pill and the decoded mode when armed', () => {
    render(<VehicleCard heartbeat={{ armed: true, customMode: 5, baseMode: 0, systemStatus: 0, ts: 0 }} />)
    expect(screen.getByText('Armed')).toBeInTheDocument()
    expect(screen.getByText('LOITER')).toBeInTheDocument()
  })

  it('renders a green DISARMED pill when disarmed', () => {
    render(<VehicleCard heartbeat={{ armed: false, customMode: 0, baseMode: 0, systemStatus: 0, ts: 0 }} />)
    expect(screen.getByText('Disarmed')).toBeInTheDocument()
    expect(screen.getByText('STABILIZE')).toBeInTheDocument()
  })

  it('falls back to "MODE {n}" for an unrecognized custom_mode', () => {
    render(<VehicleCard heartbeat={{ armed: false, customMode: 42, baseMode: 0, systemStatus: 0, ts: 0 }} />)
    expect(screen.getByText('MODE 42')).toBeInTheDocument()
  })

  it('shows a "no heartbeat" placeholder before HEARTBEAT ever arrives', () => {
    render(<VehicleCard />)
    expect(screen.getByText('No heartbeat')).toBeInTheDocument()
  })

  it('renders optional frame and pre-arm lines when passed in', () => {
    render(<VehicleCard heartbeat={{ armed: false, customMode: 0, baseMode: 0, systemStatus: 0, ts: 0 }} frame="Class 1" prearmText="PreArm: Compass not calibrated" />)
    expect(screen.getByText('Class 1')).toBeInTheDocument()
    expect(screen.getByText('PreArm: Compass not calibrated')).toBeInTheDocument()
  })
})
