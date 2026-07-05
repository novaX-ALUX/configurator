import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../../i18n'
import { MotorOutputsCard } from '../MotorOutputsCard'

describe('MotorOutputsCard', () => {
  it('renders 8 motor labels from a snapshot', () => {
    const outputs = [1500, 1500, 1500, 1500, 0, 0, 0, 0]
    render(<MotorOutputsCard servo={{ outputs, ts: 0 }} />)
    expect(screen.getByText('M1')).toBeInTheDocument()
    expect(screen.getByText('M8')).toBeInTheDocument()
    expect(screen.queryByText('M9')).not.toBeInTheDocument()
  })

  it('grays out an idle motor (0us, never populated) vs. coloring an active one', () => {
    const outputs = [0, 1500, 1000, 0, 0, 0, 0, 0]
    const { container } = render(<MotorOutputsCard servo={{ outputs, ts: 0 }} />)
    const fills = container.querySelectorAll('.absolute.inset-x-0.bottom-0')
    expect(fills[0].className).toContain('bg-nvx-disabled') // idle (0us)
    expect(fills[1].className).toContain('bg-nvx-primary') // active (1500us)
    expect(fills[2].className).toContain('bg-nvx-disabled') // idle (1000us == 0%)
  })

  it('shows a no-data state when there is no SERVO_OUTPUT_RAW message yet', () => {
    render(<MotorOutputsCard />)
    expect(screen.getByText('No motor output telemetry yet.')).toBeInTheDocument()
  })
})
