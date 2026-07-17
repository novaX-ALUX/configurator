/**
 * Issue #24/#25/#26: Messages table component tests. Drives
 * `MessageAggregateStore` directly (no router/store) since `MessagesTable`
 * only needs the store's read surface (`all()`) — proves rendering, sort
 * order, empty state, row expansion (PRD §6 formatting, including one
 * array-field message and one char[]-field message), the `offline`-gated
 * live tick (PRD §5/§7 — frozen Hz must not decay to 0), and clipboard
 * export (PRD §9/§10 — "Copy table"/"Copy fields" exact strings, the
 * transient "Copied" label swap, and both staying enabled while offline).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import type { DecodedMessage } from '../../../core/mavlink/decode'
import { MessageAggregateStore } from '../../../core/mavlink/inspector'
import { formatTime } from '../../../utils/time'
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

  const originalClipboard = navigator.clipboard

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
  })

  it('"Copy table" writes the exact TSV (header + sorted rows) and swaps to "Copied" for ~1.5s (PRD §9/§10)', async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

      const inspector = new MessageAggregateStore()
      inspector.record(heartbeat(), 1000)
      inspector.record(statustext(), 1000)
      render(<MessagesTable inspector={inspector} offline={false} />)

      fireEvent.click(screen.getByRole('button', { name: 'Copy table' }))
      await vi.advanceTimersByTimeAsync(0) // flushes the awaited writeText() promise + the resulting setCopied(true)

      // Both arrivals are 1000ms stale relative to the fake clock's "now" by the time this runs -> 0.0 Hz for both.
      expect(writeText).toHaveBeenCalledWith(
        `Type\tHz\tCount\tLast seen\nHEARTBEAT\t0.0\t1\t${formatTime(1000)}\nSTATUSTEXT\t0.0\t1\t${formatTime(1000)}`,
      )
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()

      await vi.advanceTimersByTimeAsync(1499)
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(1)
      expect(screen.getByRole('button', { name: 'Copy table' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('"Copy fields" only appears on an expanded row, copies "{name} (msgid N)" + one field line each, and does not collapse the row', async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

      const inspector = new MessageAggregateStore()
      inspector.record(heartbeat(), 1000)
      render(<MessagesTable inspector={inspector} offline={false} />)

      expect(screen.queryByRole('button', { name: 'Copy fields' })).not.toBeInTheDocument()

      fireEvent.click(screen.getByText('HEARTBEAT'))
      const copyFieldsBtn = screen.getByRole('button', { name: 'Copy fields' })

      fireEvent.click(copyFieldsBtn)
      await vi.advanceTimersByTimeAsync(0)
      expect(writeText).toHaveBeenCalledWith('HEARTBEAT (msgid 0)\ntype: 2\nautopilot: 3\nbase_mode: 81\n')

      // still expanded — the copy click must not have bubbled into the row's own toggle handler
      expect(screen.getByText('base_mode')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('copy actions stay enabled and correct while offline-and-frozen (PRD §7)', async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

      const inspector = new MessageAggregateStore()
      inspector.record(heartbeat(), 1000)
      render(<MessagesTable inspector={inspector} offline={true} />)

      const copyTableBtn = screen.getByRole('button', { name: 'Copy table' })
      expect(copyTableBtn).not.toBeDisabled()
      fireEvent.click(copyTableBtn)
      await vi.advanceTimersByTimeAsync(0)
      expect(writeText).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByText('HEARTBEAT'))
      fireEvent.click(screen.getByRole('button', { name: 'Copy fields' }))
      await vi.advanceTimersByTimeAsync(0)
      expect(writeText).toHaveBeenCalledTimes(2)
      expect(writeText.mock.calls[1][0]).toBe('HEARTBEAT (msgid 0)\ntype: 2\nautopilot: 3\nbase_mode: 81\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('"Copy table" button is disabled when the Clipboard API is unavailable, instead of throwing on click', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })

    const inspector = new MessageAggregateStore()
    inspector.record(heartbeat(), 1000)
    render(<MessagesTable inspector={inspector} offline={false} />)

    expect(screen.getByRole('button', { name: 'Copy table' })).toBeDisabled()
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
