import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../i18n'
import { TopBar } from '../TopBar'
import { useConnectionStore } from '../../store/connection'

const initialState = useConnectionStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialState, true)
})

describe('TopBar', () => {
  it('disconnected: shows baud/any-device/Connect and calls connect(baud, {anyDevice}) on click', () => {
    const connectSpy = (baud: number, opts?: { anyDevice?: boolean }) => {
      calls.push([baud, opts])
      return Promise.resolve()
    }
    const calls: Array<[number, { anyDevice?: boolean } | undefined]> = []
    useConnectionStore.setState({ connect: connectSpy })

    render(<TopBar />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Any device' }))
    fireEvent.change(screen.getByLabelText('Baud rate'), { target: { value: '57600' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(calls).toEqual([[57600, { anyDevice: true }]])
  })

  it('connecting: shows the spinner chip, hides the disconnected controls', () => {
    useConnectionStore.setState({ phase: 'connecting' })

    render(<TopBar />)

    expect(screen.getByText('Connecting · identifying board…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
  })

  it('lost: shows the link-lost chip', () => {
    useConnectionStore.setState({ phase: 'lost' })

    render(<TopBar />)

    expect(screen.getByText('Link lost — retrying…')).toBeInTheDocument()
  })

  it('connected with a known board: shows board id + fw version chip, port info, and Disconnect', () => {
    const disconnectCalls: number[] = []
    useConnectionStore.setState({
      phase: 'connected',
      identity: { boardId: 1099, fwVersion: '4.5.7' },
      portInfo: { usbVendorId: 0x1209, usbProductId: 7 },
      baud: 115200,
      disconnect: () => {
        disconnectCalls.push(1)
        return Promise.resolve()
      },
    })

    render(<TopBar />)

    expect(screen.getByText('ID 1099')).toBeInTheDocument()
    expect(screen.getByText('4.5.7')).toBeInTheDocument()
    expect(screen.getByText('VID:1209 PID:0007 · 115200')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(disconnectCalls).toEqual([1])
  })

  it('connected with no identity: falls back to the "unknown board" label', () => {
    useConnectionStore.setState({ phase: 'connected', identity: null })

    render(<TopBar />)

    expect(screen.getByText('Unknown board')).toBeInTheDocument()
  })
})
