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

  // Issue #14 (PA2): enum dropdown replaces the number input only when the
  // live/staged value is one of meta.values' listed options — an
  // out-of-spec value must never be hidden behind a dropdown (PRD #12
  // §1.4/§2.2).
  describe('enum dropdown (issue #14)', () => {
    const enumMeta = {
      displayName: 'Auto rotate',
      description: 'Automatically check orientation.',
      values: [
        { value: 0, label: 'Disabled' },
        { value: 1, label: 'Enabled' },
        { value: 2, label: 'Enabled with compass fixup' },
      ],
    }

    it('renders a <select> (not a number input) when the live value is a listed option, and stages via the same onStage path', () => {
      const onStage = vi.fn()
      render(<ParamRow param={param({ name: 'COMPASS_AUTO_ROT', value: 0 })} stagedValue={undefined} onStage={onStage} meta={enumMeta} />)

      const select = screen.getByLabelText('COMPASS_AUTO_ROT')
      expect(select.tagName).toBe('SELECT')
      expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument() // no number input alongside it

      fireEvent.change(select, { target: { value: '2' } })
      expect(onStage).toHaveBeenCalledWith('COMPASS_AUTO_ROT', 2)
    })

    it('reflects a staged value in the dropdown selection', () => {
      render(<ParamRow param={param({ name: 'COMPASS_AUTO_ROT', value: 0 })} stagedValue={1} onStage={vi.fn()} meta={enumMeta} />)

      expect(screen.getByLabelText('COMPASS_AUTO_ROT')).toHaveValue('1')
    })

    it('falls back to the plain number input when the live value is not one of the listed options — never hides the real value behind a dropdown', () => {
      render(<ParamRow param={param({ name: 'COMPASS_AUTO_ROT', value: 7 })} stagedValue={undefined} onStage={vi.fn()} meta={enumMeta} />)

      const input = screen.getByLabelText('COMPASS_AUTO_ROT')
      expect(input.tagName).toBe('INPUT')
      expect(input).toHaveValue(7)
    })
  })

  // Issue #15 (PRD #12 §2.4): "Default: {n}" caption + the existing
  // warning-tone highlight (reused from the pending/staged-edit styling, no
  // new visual language) when the live value differs from the bundled SITL
  // default. Comparison uses `param.value` (the live/on-board value), not a
  // staged edit — the whole point is "has this ever been touched", which a
  // not-yet-written staged value can't answer.
  describe('default marker (issue #15)', () => {
    it('shows the "Default: {n}" caption and the warning-tone highlight when the live value differs from the bundled default', () => {
      render(<ParamRow param={param({ value: 100 })} stagedValue={undefined} onStage={vi.fn()} defaultValue={50} />)

      expect(screen.getByText('Default: 50')).toBeInTheDocument()
      expect(screen.getByText('THR_MIN')).toHaveClass('text-nvx-warningText')
    })

    it('shows no caption, and no highlight, when the live value matches the bundled default', () => {
      render(<ParamRow param={param({ value: 50 })} stagedValue={undefined} onStage={vi.fn()} defaultValue={50} />)

      expect(screen.queryByText(/^Default:/)).not.toBeInTheDocument()
      expect(screen.getByText('THR_MIN')).toHaveClass('text-nvx-text')
    })

    it('shows no caption when there is no bundled default at all — never guessed', () => {
      render(<ParamRow param={param({ value: 100 })} stagedValue={undefined} onStage={vi.fn()} defaultValue={undefined} />)

      expect(screen.queryByText(/^Default:/)).not.toBeInTheDocument()
      expect(screen.getByText('THR_MIN')).toHaveClass('text-nvx-text')
    })

    it('is float32-tolerant: a wire-rounded value that float64-differs from the literal default shows no caption', () => {
      render(<ParamRow param={param({ name: 'SOME_GAIN', type: MAV_PARAM_TYPE_REAL32, value: Math.fround(0.1) })} stagedValue={undefined} onStage={vi.fn()} defaultValue={0.1} />)

      expect(screen.queryByText(/^Default:/)).not.toBeInTheDocument()
    })

    it('still highlights a pending (staged) row on top of a default-differs row using the same warning tone, not a second visual language', () => {
      render(<ParamRow param={param({ value: 100 })} stagedValue={120} onStage={vi.fn()} defaultValue={50} />)

      expect(screen.getByText('Default: 50')).toBeInTheDocument()
      expect(screen.getByTitle('Modified — not yet written')).toBeInTheDocument()
    })
  })

  // Issue #14 (PA2): advisory-only caption, never an HTML min/max (PRD #12 §2.3).
  describe('range/units caption (issue #14)', () => {
    it('shows a gray range/units caption when metadata has them, without constraining the input', () => {
      render(
        <ParamRow
          param={param()}
          stagedValue={undefined}
          onStage={vi.fn()}
          meta={{ displayName: 'Throttle minimum', description: 'x', range: [0, 100], units: '%' }}
        />,
      )

      expect(screen.getByText('0–100 %')).toBeInTheDocument()
      const input = screen.getByLabelText('THR_MIN')
      expect(input).not.toHaveAttribute('min')
      expect(input).not.toHaveAttribute('max')
    })

    it('renders no caption when metadata has neither range nor units', () => {
      render(<ParamRow param={param()} stagedValue={undefined} onStage={vi.fn()} meta={{ displayName: 'x', description: 'y' }} />)
      expect(screen.queryByText(/–/)).not.toBeInTheDocument()
    })
  })
})
