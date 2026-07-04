import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { DiffDrawer, type DiffRow } from '../DiffDrawer'

function row(overrides: Partial<DiffRow> = {}): DiffRow {
  return { name: 'THR_MIN', current: 0, next: 120, status: undefined, ...overrides }
}

describe('DiffDrawer', () => {
  it('lists each pending change as current -> new', () => {
    render(
      <DiffDrawer
        rows={[row({ name: 'THR_MIN', current: 0, next: 120 }), row({ name: 'THR_MAX', current: 1000, next: 900 })]}
        writing={false}
        onDiscard={vi.fn()}
        onWriteAll={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('THR_MIN')).toBeInTheDocument()
    expect(screen.getByText('120')).toBeInTheDocument()
    expect(screen.getByText('THR_MAX')).toBeInTheDocument()
    expect(screen.getByText('900')).toBeInTheDocument()
  })

  it('"Write N parameter(s)?" reflects the row count', () => {
    render(
      <DiffDrawer
        rows={[row(), row({ name: 'THR_MAX' })]}
        writing={false}
        onDiscard={vi.fn()}
        onWriteAll={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Write 2 parameter(s)?')).toBeInTheDocument()
  })

  it('discarding a row calls onDiscard with its name', () => {
    const onDiscard = vi.fn()
    render(
      <DiffDrawer rows={[row({ name: 'THR_MIN' })]} writing={false} onDiscard={onDiscard} onWriteAll={vi.fn()} onClose={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDiscard).toHaveBeenCalledWith('THR_MIN')
  })

  it('"Write to board" calls onWriteAll once', () => {
    const onWriteAll = vi.fn()
    render(<DiffDrawer rows={[row()]} writing={false} onDiscard={vi.fn()} onWriteAll={onWriteAll} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    expect(onWriteAll).toHaveBeenCalledTimes(1)
  })

  it('while writing: disables Write/Keep-editing/Discard and shows the writing banner', () => {
    render(
      <DiffDrawer rows={[row({ status: { kind: 'writing' } })]} writing={true} onDiscard={vi.fn()} onWriteAll={vi.fn()} onClose={vi.fn()} />,
    )

    expect(screen.getByText('Writing values to the board…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Write to board' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  })

  it('shows a mismatch row in red with requested vs actual, and it stays listed (not auto-retried)', () => {
    render(
      <DiffDrawer
        rows={[row({ name: 'THR_MAX', next: 2000, status: { kind: 'mismatch', requested: 2000, actual: 1000 } })]}
        writing={false}
        onDiscard={vi.fn()}
        onWriteAll={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Board reports 1000 (requested 2000)')).toBeInTheDocument()
    // Still offers Discard/Write — a failure is not silently retried, the user decides.
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Write to board' })).toBeInTheDocument()
  })

  it('shows timeout/busy/precision statuses with their own messages', () => {
    const { rerender } = render(
      <DiffDrawer rows={[row({ status: { kind: 'timeout' } })]} writing={false} onDiscard={vi.fn()} onWriteAll={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByText('No confirmation from the board (timed out)')).toBeInTheDocument()

    rerender(
      <DiffDrawer rows={[row({ status: { kind: 'busy' } })]} writing={false} onDiscard={vi.fn()} onWriteAll={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByText('Write already in progress for this parameter')).toBeInTheDocument()

    rerender(
      <DiffDrawer rows={[row({ status: { kind: 'precision' } })]} writing={false} onDiscard={vi.fn()} onWriteAll={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByText('Value too large to store exactly — not sent')).toBeInTheDocument()
  })

  it('Keep editing calls onClose', () => {
    const onClose = vi.fn()
    render(<DiffDrawer rows={[row()]} writing={false} onDiscard={vi.fn()} onWriteAll={vi.fn()} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders nothing to write when rows is empty (all succeeded and cleared)', () => {
    render(<DiffDrawer rows={[]} writing={false} onDiscard={vi.fn()} onWriteAll={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Write 0 parameter(s)?')).toBeInTheDocument()
  })
})
