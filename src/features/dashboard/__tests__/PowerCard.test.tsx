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
})
