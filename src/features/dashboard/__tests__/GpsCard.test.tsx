import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../../i18n'
import { GpsCard } from '../GpsCard'

describe('GpsCard', () => {
  it('fix_type 0/1 renders a red "No fix" badge', () => {
    render(<GpsCard gps={{ fixType: 0, satellites: 0, ts: 0 }} />)
    expect(screen.getByText('No fix')).toBeInTheDocument()
  })

  it('fix_type 1 also renders "No fix"', () => {
    render(<GpsCard gps={{ fixType: 1, satellites: 2, ts: 0 }} />)
    expect(screen.getByText('No fix')).toBeInTheDocument()
  })

  it('fix_type 2 renders an amber "2D fix" badge', () => {
    render(<GpsCard gps={{ fixType: 2, satellites: 6, ts: 0 }} />)
    expect(screen.getByText('2D fix')).toBeInTheDocument()
  })

  it('fix_type 3+ renders a green "3D fix" badge, with satellite count and HDOP', () => {
    render(<GpsCard gps={{ fixType: 3, satellites: 14, hdop: 0.82, ts: 0 }} />)
    expect(screen.getByText('3D fix')).toBeInTheDocument()
    expect(screen.getByText('14')).toBeInTheDocument()
    expect(screen.getByText('HDOP 0.8')).toBeInTheDocument()
  })

  it('shows "—" for hdop when undefined', () => {
    render(<GpsCard gps={{ fixType: 3, satellites: 14, ts: 0 }} />)
    expect(screen.getByText('HDOP —')).toBeInTheDocument()
  })

  it('shows a no-data state when there is no GPS_RAW_INT yet', () => {
    render(<GpsCard />)
    expect(screen.getByText('No data')).toBeInTheDocument()
  })
})
