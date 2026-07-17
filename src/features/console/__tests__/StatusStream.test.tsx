/**
 * Issue #25 (Console page merge, PRD §8): Status stream component tests —
 * severity badges/row color on the new 3-group boundary, multi-select filter
 * chips (default all on, filter applied before the pause snapshot), and the
 * pause/resume/clear behavior carried forward from `StatusPanel`.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { StatusStream } from '../StatusStream'
import type { StatusTextEntry } from '../../../store/connection'

function entry(overrides: Partial<StatusTextEntry> = {}): StatusTextEntry {
  return { severity: 6, text: 'hello', ts: 0, ...overrides }
}

function renderStream(statustext: StatusTextEntry[]) {
  return render(<StatusStream statustext={statustext} linkStats={null} clearStatustext={vi.fn()} />)
}

describe('StatusStream', () => {
  it('empty: shows the "no messages yet" row', () => {
    renderStream([])
    expect(screen.getByText('No STATUSTEXT messages yet.')).toBeInTheDocument()
  })

  it('renders every severity group by default, each with its exact-severity badge', () => {
    renderStream([
      entry({ severity: 3, text: 'error text' }),
      entry({ severity: 4, text: 'warning text' }),
      entry({ severity: 6, text: 'info text' }),
    ])

    expect(screen.getByText('error text')).toBeInTheDocument()
    expect(screen.getByText('warning text')).toBeInTheDocument()
    expect(screen.getByText('info text')).toBeInTheDocument()
    expect(screen.getByText('ERR')).toBeInTheDocument()
    expect(screen.getByText('WARN')).toBeInTheDocument()
    expect(screen.getByText('INFO')).toBeInTheDocument()
  })

  it('toggling a chip off hides rows in that group only', () => {
    renderStream([entry({ severity: 3, text: 'error text' }), entry({ severity: 6, text: 'info text' })])

    fireEvent.click(screen.getByRole('button', { name: 'Errors' }))

    expect(screen.queryByText('error text')).not.toBeInTheDocument()
    expect(screen.getByText('info text')).toBeInTheDocument()
  })

  it('toggling all three chips off shows the normal empty row, not a special "filtered" message', () => {
    renderStream([entry({ severity: 3, text: 'error text' }), entry({ severity: 6, text: 'info text' })])

    fireEvent.click(screen.getByRole('button', { name: 'Errors' }))
    fireEvent.click(screen.getByRole('button', { name: 'Warnings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Info' }))

    expect(screen.getByText('No STATUSTEXT messages yet.')).toBeInTheDocument()
  })

  it('WARNING(4) and NOTICE(5) both land in the warnings chip (PRD §8 boundary)', () => {
    renderStream([entry({ severity: 4, text: 'warn4' }), entry({ severity: 5, text: 'notice5' })])

    fireEvent.click(screen.getByRole('button', { name: 'Warnings' }))

    expect(screen.queryByText('warn4')).not.toBeInTheDocument()
    expect(screen.queryByText('notice5')).not.toBeInTheDocument()
  })

  it('Pause freezes the currently-filtered view; a chip toggled while paused does not reach into the frozen snapshot', () => {
    const { rerender } = renderStream([entry({ severity: 6, text: 'info text' })])

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(screen.getByRole('button', { name: 'Info' })) // toggle off while paused
    expect(screen.getByText('info text')).toBeInTheDocument() // frozen snapshot, unaffected by the later filter change

    rerender(<StatusStream statustext={[entry({ severity: 6, text: 'info text' }), entry({ severity: 6, text: 'second' })]} linkStats={null} clearStatustext={vi.fn()} />)
    expect(screen.queryByText('second')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(screen.queryByText('info text')).not.toBeInTheDocument() // filter (Info off) applies again once live
    expect(screen.queryByText('second')).not.toBeInTheDocument()
  })

  it('Clear always empties the on-screen list, even while paused', () => {
    const clearStatustext = vi.fn()
    render(<StatusStream statustext={[entry({ text: 'first' })]} linkStats={null} clearStatustext={clearStatustext} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(clearStatustext).toHaveBeenCalled()
    expect(screen.getByText('No STATUSTEXT messages yet.')).toBeInTheDocument()
  })

  it('renders link stats when provided', () => {
    render(
      <StatusStream
        statustext={[]}
        linkStats={{ framesIn: 42, framesOut: 3, decodeErrors: 0, signedDropped: 0, crcErrors: 1, badMsgId: 0, dropped: 2 }}
        clearStatustext={vi.fn()}
      />,
    )
    expect(screen.getByText('42 in · 3 out · 1 CRC errors · 2 dropped')).toBeInTheDocument()
  })
})
