import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../../i18n'
import { PowerCard } from '../PowerCard'

describe('PowerCard', () => {
  it('shows voltage/current and a percent bar when batteryRemaining is present', () => {
    render(<PowerCard power={{ voltage: 15.8, current: 8.2, batteryRemaining: 63, ts: 0 }} />)
    expect(screen.getByText('15.80')).toBeInTheDocument()
    expect(screen.getByText('8.2 A')).toBeInTheDocument()
    expect(screen.getByText('63% remaining')).toBeInTheDocument()
  })

  it('shows voltage only, with no percent bar or fabricated number, when batteryRemaining is undefined', () => {
    render(<PowerCard power={{ voltage: 15.8, current: 8.2, ts: 0 }} />)
    expect(screen.getByText('15.80')).toBeInTheDocument()
    expect(screen.queryByText(/remaining/)).not.toBeInTheDocument()
    expect(screen.getByText('Battery percentage unavailable — showing voltage only')).toBeInTheDocument()
  })

  it('shows a dash when there is no SYS_STATUS at all yet', () => {
    render(<PowerCard />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/A$/)).not.toBeInTheDocument()
  })

  it('de-emphasizes the percent bar and adds a plausibility qualifier when voltage is far too low for a real pack (issue #9)', () => {
    const { container } = render(<PowerCard power={{ voltage: 0.02, current: 0.1, batteryRemaining: 80, ts: 0 }} />)
    expect(screen.getByText('0.02')).toBeInTheDocument()
    // Still reports what the FC says — never fabricated away.
    expect(screen.getByText('80% remaining')).toBeInTheDocument()
    expect(screen.getByText('reported by FC — voltage suggests USB/bench power')).toBeInTheDocument()
    // Not styled as a healthy/green (or warning/danger) tier — de-emphasized instead.
    expect(container.querySelector('.bg-nvx-disabled')).toBeInTheDocument()
    expect(container.querySelector('.bg-nvx-success')).not.toBeInTheDocument()
  })

  it('renders exactly as before when voltage is plausible, even right at the implausibility floor', () => {
    const { container } = render(<PowerCard power={{ voltage: 3.0, current: 0.5, batteryRemaining: 20, ts: 0 }} />)
    expect(screen.getByText('3.00')).toBeInTheDocument()
    expect(screen.getByText('20% remaining')).toBeInTheDocument()
    expect(screen.queryByText(/USB\/bench power/)).not.toBeInTheDocument()
    expect(container.querySelector('.bg-nvx-disabled')).not.toBeInTheDocument()
    expect(container.querySelector('.bg-nvx-danger')).toBeInTheDocument()
  })
})
