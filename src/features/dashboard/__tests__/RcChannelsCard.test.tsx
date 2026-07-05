import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../../i18n'
import { RcChannelsCard } from '../RcChannelsCard'

describe('RcChannelsCard', () => {
  it('renders 8 channel rows with raw PWM values from a snapshot', () => {
    const channels = [1500, 1500, 1100, 1500, 1900, 1500, 1000, 2000, 1500, 1500]
    render(<RcChannelsCard rc={{ channels, ts: 0 }} />)

    expect(screen.getByText('CH1')).toBeInTheDocument()
    expect(screen.getByText('CH8')).toBeInTheDocument()
    expect(screen.queryByText('CH9')).not.toBeInTheDocument() // only 8 shown

    expect(screen.getByText('1100')).toBeInTheDocument()
    expect(screen.getByText('1900')).toBeInTheDocument()
    expect(screen.getByText('2000')).toBeInTheDocument()
  })

  it('shows a no-data state when there is no RC_CHANNELS message yet', () => {
    render(<RcChannelsCard />)
    expect(screen.getByText('No RC channel telemetry yet.')).toBeInTheDocument()
  })
})
