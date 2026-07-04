import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../../i18n'
import { StatusPanel } from '../StatusPanel'
import { useConnectionStore, type StatusTextEntry } from '../../../store/connection'

const initialState = useConnectionStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialState, true)
})

function entry(overrides: Partial<StatusTextEntry> = {}): StatusTextEntry {
  return { severity: 6, text: 'hello', ts: 0, ...overrides }
}

describe('StatusPanel', () => {
  it('not connected: shows the empty state and its CTA calls connect()', () => {
    const calls: Array<[number, unknown]> = []
    useConnectionStore.setState({
      phase: 'disconnected',
      baud: 115200,
      connect: (baud, opts) => {
        calls.push([baud, opts])
        return Promise.resolve()
      },
    })

    render(<StatusPanel />)

    expect(screen.getByText('No MAVLink stream')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect flight controller' }))
    expect(calls).toEqual([[115200, undefined]])
  })

  it('connecting/lost: the empty-state CTA is disabled (connect() would be a silent no-op there)', () => {
    useConnectionStore.setState({ phase: 'connecting' })
    render(<StatusPanel />)
    expect(screen.getByRole('button', { name: 'Connect flight controller' })).toBeDisabled()

    useConnectionStore.setState({ phase: 'lost' })
    expect(screen.getByRole('button', { name: 'Connect flight controller' })).toBeDisabled()
  })

  it('connected: renders STATUSTEXT rows, message count, and link stats', () => {
    useConnectionStore.setState({
      phase: 'connected',
      statustext: [entry({ severity: 3, text: 'ERROR: bad thing' }), entry({ severity: 6, text: 'info thing' })],
      linkStats: { framesIn: 42, framesOut: 3, decodeErrors: 0, signedDropped: 0, crcErrors: 1, badMsgId: 0, dropped: 2 },
    })

    render(<StatusPanel />)

    expect(screen.getByText('ERROR: bad thing')).toBeInTheDocument()
    expect(screen.getByText('info thing')).toBeInTheDocument()
    expect(screen.getByText('2 messages · buffer 500')).toBeInTheDocument()
    expect(screen.getByText('42 in · 3 out · 1 CRC errors · 2 dropped')).toBeInTheDocument()
  })

  it('connected with an empty buffer: shows the "no messages yet" row', () => {
    useConnectionStore.setState({ phase: 'connected', statustext: [] })

    render(<StatusPanel />)

    expect(screen.getByText('No STATUSTEXT messages yet.')).toBeInTheDocument()
  })

  it('Pause freezes the visible list; Resume shows what arrived meanwhile; Clear always empties it', () => {
    useConnectionStore.setState({ phase: 'connected', statustext: [entry({ text: 'first' })] })
    render(<StatusPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    useConnectionStore.setState({ statustext: [entry({ text: 'first' }), entry({ text: 'second' })] })
    expect(screen.queryByText('second')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(screen.getByText('second')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(useConnectionStore.getState().statustext).toEqual([])
    expect(screen.getByText('No STATUSTEXT messages yet.')).toBeInTheDocument()
  })

  it('Clear empties the on-screen list immediately even while paused', () => {
    useConnectionStore.setState({ phase: 'connected', statustext: [entry({ text: 'first' })] })
    render(<StatusPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(screen.getByText('No STATUSTEXT messages yet.')).toBeInTheDocument()
  })
})
