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

  it('rotates the bank-angle triangle with a CSS transform, never the SVG transform attribute (issue #18)', () => {
    // jsdom can't reproduce the browser-compositor hang this guards against
    // (see the `<g>`'s own comment in AttitudeIndicator.tsx for the
    // mechanism) — this only verifies the structural fix stays in place.
    const { container } = render(<AttitudeIndicator attitude={{ rollDeg: 12.34, pitchDeg: 0, yawDeg: 0, ts: 0 }} />)
    const triangleGroup = container.querySelector('path[d="M120 28l-7 12h14z"]')?.parentElement
    expect(triangleGroup).not.toBeNull()
    expect(triangleGroup).not.toHaveAttribute('transform')
    expect(triangleGroup).toHaveStyle({ transform: 'rotate(12.34deg)', transformOrigin: '120px 120px' })
  })
})
