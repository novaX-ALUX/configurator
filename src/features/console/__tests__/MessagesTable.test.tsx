/**
 * Issue #24/#25: Messages table component tests. Drives
 * `MessageAggregateStore` directly (no router/store) since `MessagesTable`
 * only needs the store's read surface (`all()`) — proves rendering, sort
 * order, empty state, row expansion (PRD §6 formatting, including one
 * array-field message and one char[]-field message), and the `offline`-gated
 * live tick (PRD §5/§7 — frozen Hz must not decay to 0).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import type { DecodedMessage } from '../../../core/mavlink/decode'
import { MessageAggregateStore } from '../../../core/mavlink/inspector'
import { MessagesTable } from '../MessagesTable'

const HEARTBEAT_MSGID = 0
const RC_CHANNELS_MSGID = 65
const STATUSTEXT_MSGID = 253

function heartbeat(): DecodedMessage {
  return { msgid: HEARTBEAT_MSGID, name: 'HEARTBEAT', fields: { type: 2, autopilot: 3, base_mode: 81 } }
}

function rcChannels(): DecodedMessage {
  return {
    msgid: RC_CHANNELS_MSGID,
    name: 'RC_CHANNELS',
    fields: { time_boot_ms: 123456, chan: [1000, 1500, 2000, 1500] },
  }
}

function statustext(): DecodedMessage {
  return { msgid: STATUSTEXT_MSGID, name: 'STATUSTEXT', fields: { severity: 6, text: 'EKF3 IMU0 is using GPS' } }
}

describe('MessagesTable', () => {
  it('shows the empty state when nothing has been recorded', () => {
    render(<MessagesTable inspector={new MessageAggregateStore()} offline={false} />)
    expect(screen.getByText('No messages yet.')).toBeInTheDocument()
  })

  it('renders one row per message type, sorted alphabetically by name', () => {
    const inspector = new MessageAggregateStore()
    inspector.record(rcChannels(), 1000)
    inspector.record(heartbeat(), 1000)
    inspector.record(statustext(), 1000)

    render(<MessagesTable inspector={inspector} offline={false} />)

    const names = screen.getAllByRole('row').slice(1).map((row) => row.textContent)
    expect(names[0]).toContain('HEARTBEAT')
    expect(names[1]).toContain('RC_CHANNELS')
    expect(names[2]).toContain('STATUSTEXT')
  })

  it('shows the type total (one row per distinct msgid) and the per-row count', () => {
    const inspector = new MessageAggregateStore()
    inspector.record(heartbeat(), 1000) // same msgid twice: one type, count 2
    inspector.record(heartbeat(), 1100)
    inspector.record(statustext(), 1000) // a second, distinct type
    render(<MessagesTable inspector={inspector} offline={false} />)

    expect(screen.getByText('2 types')).toBeInTheDocument()
    const row = screen.getByText('HEARTBEAT').closest('tr')!
    expect(row.textContent).toContain('2') // count column
  })

  it('expands a row on click to show latest.fields, array field comma-space joined untruncated', () => {
    const inspector = new MessageAggregateStore()
    inspector.record(rcChannels(), 1000)
    render(<MessagesTable inspector={inspector} offline={false} />)

    fireEvent.click(screen.getByText('RC_CHANNELS'))

    expect(screen.getByText('time_boot_ms')).toBeInTheDocument()
    expect(screen.getByText('123456')).toBeInTheDocument()
    expect(screen.getByText('chan')).toBeInTheDocument()
    expect(screen.getByText('1000, 1500, 2000, 1500')).toBeInTheDocument()
  })

  it('expands a char[]-field message (STATUSTEXT) showing its raw text field', () => {
    const inspector = new MessageAggregateStore()
    inspector.record(statustext(), 1000)
    render(<MessagesTable inspector={inspector} offline={false} />)

    fireEvent.click(screen.getByText('STATUSTEXT'))

    expect(screen.getByText('severity')).toBeInTheDocument()
    expect(screen.getByText('6')).toBeInTheDocument()
    expect(screen.getByText('text')).toBeInTheDocument()
    expect(screen.getByText('EKF3 IMU0 is using GPS')).toBeInTheDocument()
  })

  it('collapses an expanded row on a second click', () => {
    const inspector = new MessageAggregateStore()
    inspector.record(heartbeat(), 1000)
    render(<MessagesTable inspector={inspector} offline={false} />)

    fireEvent.click(screen.getByText('HEARTBEAT'))
    expect(screen.getByText('base_mode')).toBeInTheDocument()

    fireEvent.click(screen.getByText('HEARTBEAT'))
    expect(screen.queryByText('base_mode')).not.toBeInTheDocument()
  })

  it('offline: the 250ms Hz tick does not run, so a frozen Hz value never decays to 0 (PRD §7)', () => {
    vi.useFakeTimers()
    try {
      const inspector = new MessageAggregateStore()
      inspector.record(heartbeat(), 1000)
      inspector.record(heartbeat(), 1100) // two arrivals inside the 1s window -> nonzero Hz
      vi.setSystemTime(1100)
      render(<MessagesTable inspector={inspector} offline={true} />)

      const hzBefore = screen.getByText('HEARTBEAT').closest('tr')!.textContent
      vi.setSystemTime(5000) // well past the 1s Hz window, if the tick were running this would decay to 0
      vi.advanceTimersByTime(2000)
      const hzAfter = screen.getByText('HEARTBEAT').closest('tr')!.textContent
      expect(hzAfter).toBe(hzBefore)
    } finally {
      vi.useRealTimers()
    }
  })
})
