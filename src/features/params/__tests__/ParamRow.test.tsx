import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { ParamRow } from '../ParamRow'
import type { Param } from '../../../core/mavlink/params'

const MAV_PARAM_TYPE_INT32 = 6
const MAV_PARAM_TYPE_REAL32 = 9

function param(overrides: Partial<Param> = {}): Param {
  return { name: 'THR_MIN', value: 100, type: MAV_PARAM_TYPE_INT32, index: 3, ...overrides }
}

describe('ParamRow', () => {
  it('renders name, type badge, index, and the value input pre-filled with the current value', () => {
    render(<ParamRow param={param()} stagedValue={undefined} onStage={vi.fn()} />)

    expect(screen.getByText('THR_MIN')).toBeInTheDocument()
    expect(screen.getByText('INT32')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByDisplayValue('100')).toBeInTheDocument()
  })

  it('shows the staged value (not the on-board value) once one is pending, and marks the row modified', () => {
    render(<ParamRow param={param()} stagedValue={150} onStage={vi.fn()} />)

    expect(screen.getByDisplayValue('150')).toBeInTheDocument()
    expect(screen.getByTitle('Modified — not yet written')).toBeInTheDocument()
  })

  it('stages a valid edit on Enter', () => {
    const onStage = vi.fn()
    render(<ParamRow param={param()} stagedValue={undefined} onStage={onStage} />)

    const input = screen.getByDisplayValue('100')
    fireEvent.change(input, { target: { value: '120' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onStage).toHaveBeenCalledWith('THR_MIN', 120)
  })

  it('stages a valid edit on blur', () => {
    const onStage = vi.fn()
    render(<ParamRow param={param()} stagedValue={undefined} onStage={onStage} />)

    const input = screen.getByDisplayValue('100')
    fireEvent.change(input, { target: { value: '80' } })
    fireEvent.blur(input)

    expect(onStage).toHaveBeenCalledWith('THR_MIN', 80)
  })

  it('rejects a non-integer value for an integer param type with an inline error, and does not stage it', () => {
    const onStage = vi.fn()
    render(<ParamRow param={param({ type: MAV_PARAM_TYPE_INT32 })} stagedValue={undefined} onStage={onStage} />)

    const input = screen.getByDisplayValue('100')
    fireEvent.change(input, { target: { value: '1.5' } })
    fireEvent.blur(input)

    expect(onStage).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/i)
  })

  it('allows a free decimal for a REAL32 param', () => {
    const onStage = vi.fn()
    render(
      <ParamRow
        param={param({ name: 'SOME_GAIN', type: MAV_PARAM_TYPE_REAL32, value: 0.1 })}
        stagedValue={undefined}
        onStage={onStage}
      />,
    )

    const input = screen.getByDisplayValue('0.1')
    fireEvent.change(input, { target: { value: '0.123456' } })
    fireEvent.blur(input)

    expect(onStage).toHaveBeenCalledWith('SOME_GAIN', 0.123456)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('rejects an empty value with an inline error, and does not stage it', () => {
    const onStage = vi.fn()
    render(<ParamRow param={param()} stagedValue={undefined} onStage={onStage} />)

    const input = screen.getByDisplayValue('100')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(onStage).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  // Issue #13: additive display-name/description line, purely additional to
  // the raw name — never a replacement for it (PRD #12 §2.1/§1.4).
  describe('meta (issue #13 param metadata)', () => {
    it('renders the raw name exactly as before when no metadata is available (regression guard for the additive fallback)', () => {
      render(<ParamRow param={param()} stagedValue={undefined} onStage={vi.fn()} />)

      expect(screen.getByText('THR_MIN')).toBeInTheDocument()
      expect(screen.getByDisplayValue('100')).toBeInTheDocument()
      expect(screen.getByText('INT32')).toBeInTheDocument()
    })

    it('renders the display name and description alongside the raw name when metadata matches', () => {
      render(
        <ParamRow
          param={param()}
          stagedValue={undefined}
          onStage={vi.fn()}
          meta={{ displayName: 'Throttle minimum', description: 'Minimum throttle output.' }}
        />,
      )

      expect(screen.getByText('THR_MIN')).toBeInTheDocument()
      expect(screen.getByText('Throttle minimum')).toBeInTheDocument()
      expect(screen.getByText('Minimum throttle output.')).toBeInTheDocument()
    })
  })
})
