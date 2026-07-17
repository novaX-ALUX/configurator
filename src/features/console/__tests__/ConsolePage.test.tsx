/**
 * Issue #25: Console page tests, replacing `StatusPanel.test.tsx`. Page-level
 * concerns only (offline/frozen framing per PRD §7, page-level pause/clear
 * wiring) — per-component behavior (Messages table formatting/expansion,
 * Status stream severity filtering) has its own dedicated test file
 * (`MessagesTable.test.tsx`, `StatusStream.test.tsx`).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../../i18n'
import { ConsolePage } from '../ConsolePage'
import { useConnectionStore, type StatusTextEntry } from '../../../store/connection'
import { MessageAggregateStore } from '../../../core/mavlink/inspector'
import type { DecodedMessage } from '../../../core/mavlink/decode'

const initialState = useConnectionStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialState, true)
})

function entry(overrides: Partial<StatusTextEntry> = {}): StatusTextEntry {
  return { severity: 6, text: 'hello', ts: 0, ...overrides }
}

function heartbeat(): DecodedMessage {
  return { msgid: 0, name: 'HEARTBEAT', fields: { type: 2 } }
}

describe('ConsolePage', () => {
  it('never-connected, no data: renders both sections’ empty rows and the plain "Offline" chip, no connect-CTA placeholder', () => {
    useConnectionStore.setState({ phase: 'disconnected', statustext: [], inspector: new MessageAggregateStore() })

    render(<ConsolePage />)

    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(screen.queryByText('Offline — frozen')).not.toBeInTheDocument()
    expect(screen.getByText('No messages yet.')).toBeInTheDocument()
    expect(screen.getByText('No STATUSTEXT messages yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/No MAVLink stream/)).not.toBeInTheDocument()
  })

  it('disconnected with prior data: keeps showing the frozen rows and flips to "Offline — frozen"', () => {
    const inspector = new MessageAggregateStore()
    inspector.record(heartbeat(), 1000)
    useConnectionStore.setState({ phase: 'disconnected', statustext: [entry({ text: 'frozen msg' })], inspector })

    render(<ConsolePage />)

    expect(screen.getByText('Offline — frozen')).toBeInTheDocument()
    expect(screen.getByText('HEARTBEAT')).toBeInTheDocument()
    expect(screen.getByText('frozen msg')).toBeInTheDocument()
  })

  it('connected: renders aggregate rows and STATUSTEXT rows together; expanding a Messages row shows its fields', () => {
    const inspector = new MessageAggregateStore()
    inspector.record(heartbeat(), 1000)
    useConnectionStore.setState({ phase: 'connected', statustext: [entry({ text: 'hi' })], inspector })

    render(<ConsolePage />)

    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
    expect(screen.getByText('hi')).toBeInTheDocument()

    fireEvent.click(screen.getByText('HEARTBEAT'))
    expect(screen.getByText('type')).toBeInTheDocument()
  })

  it('severity chips: toggling Errors off hides error rows; toggling all off shows the normal empty row (PRD §8, not a special message)', () => {
    useConnectionStore.setState({
      phase: 'connected',
      statustext: [entry({ severity: 3, text: 'err msg' }), entry({ severity: 6, text: 'info msg' })],
    })

    render(<ConsolePage />)

    expect(screen.getByText('err msg')).toBeInTheDocument()
    expect(screen.getByText('info msg')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Errors' }))
    expect(screen.queryByText('err msg')).not.toBeInTheDocument()
    expect(screen.getByText('info msg')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Warnings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Info' }))
    expect(screen.getByText('No STATUSTEXT messages yet.')).toBeInTheDocument()
  })

  it('each STATUSTEXT row shows its exact severity badge (not the group name)', () => {
    useConnectionStore.setState({ phase: 'connected', statustext: [entry({ severity: 3, text: 'err msg' })] })

    render(<ConsolePage />)

    expect(screen.getByText('ERR')).toBeInTheDocument()
  })

  it('Pause freezes the visible list; Resume shows what arrived meanwhile; Clear always empties it', () => {
    useConnectionStore.setState({ phase: 'connected', statustext: [entry({ text: 'first' })] })
    render(<ConsolePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    useConnectionStore.setState({ statustext: [entry({ text: 'first' }), entry({ text: 'second' })] })
    expect(screen.queryByText('second')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(screen.getByText('second')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(useConnectionStore.getState().statustext).toEqual([])
    expect(screen.getByText('No STATUSTEXT messages yet.')).toBeInTheDocument()
  })
})
