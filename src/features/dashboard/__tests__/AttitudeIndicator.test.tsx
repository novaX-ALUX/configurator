import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../../i18n'
import { AttitudeIndicator } from '../AttitudeIndicator'

describe('AttitudeIndicator', () => {
  it('shows "—" readouts before the first ATTITUDE message', () => {
    render(<AttitudeIndicator />)
    expect(screen.getAllByText('—')).toHaveLength(3) // ROLL, PITCH, heading
  })

  it('renders signed ROLL/PITCH readouts and the rounded heading from a snapshot', () => {
    render(<AttitudeIndicator attitude={{ rollDeg: 12.34, pitchDeg: -4.5, yawDeg: 271.2, ts: 0 }} />)
    expect(screen.getByText('+12.3°')).toBeInTheDocument()
    expect(screen.getByText('-4.5°')).toBeInTheDocument()
    expect(screen.getByText('271°')).toBeInTheDocument()
  })

  it('normalizes a negative yaw into a 0-360 compass heading', () => {
    render(<AttitudeIndicator attitude={{ rollDeg: 0, pitchDeg: 0, yawDeg: -90, ts: 0 }} />)
    expect(screen.getByText('270°')).toBeInTheDocument()
  })
})
