import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { DisconnectToast } from '../DisconnectToast'
import { useConnectionStore } from '../../store/connection'

const initialState = useConnectionStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialState, true)
})

describe('DisconnectToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing on a fresh mount (no transition has happened yet)', () => {
    render(<DisconnectToast />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a toast when the link goes from connected to lost', () => {
    useConnectionStore.setState({ phase: 'connected' })
    render(<DisconnectToast />)

    act(() => {
      useConnectionStore.setState({ phase: 'lost' })
    })

    expect(screen.getByText('Link lost — retrying…')).toBeInTheDocument()
  })

  it('shows a toast with the reason when the link tears down from connected to disconnected', () => {
    useConnectionStore.setState({ phase: 'connected' })
    render(<DisconnectToast />)

    act(() => {
      useConnectionStore.setState({ phase: 'disconnected', lastDisconnectReason: 'device unplugged' })
    })

    expect(screen.getByText('Disconnected: device unplugged')).toBeInTheDocument()
  })

  it('shows a toast when tearing down from lost to disconnected', () => {
    useConnectionStore.setState({ phase: 'lost' })
    render(<DisconnectToast />)

    act(() => {
      useConnectionStore.setState({ phase: 'disconnected', lastDisconnectReason: 'closed' })
    })

    expect(screen.getByText('Disconnected: closed')).toBeInTheDocument()
  })

  it('does not toast for the initial idle disconnected state, nor a dismissed port picker', () => {
    useConnectionStore.setState({ phase: 'disconnected', lastDisconnectReason: null })
    render(<DisconnectToast />)

    // connecting -> disconnected with no reason (user dismissed the picker) — no toast.
    act(() => {
      useConnectionStore.setState({ phase: 'connecting' })
    })
    act(() => {
      useConnectionStore.setState({ phase: 'disconnected', lastDisconnectReason: null })
    })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('dismisses manually via its close button', () => {
    useConnectionStore.setState({ phase: 'connected' })
    render(<DisconnectToast />)
    act(() => {
      useConnectionStore.setState({ phase: 'lost' })
    })
    expect(screen.getByRole('status')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('auto-dismisses after ~5s', async () => {
    useConnectionStore.setState({ phase: 'connected' })
    render(<DisconnectToast />)
    act(() => {
      useConnectionStore.setState({ phase: 'lost' })
    })
    expect(screen.getByRole('status')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(5000)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
