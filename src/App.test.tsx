import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App shell', () => {
  it('renders the sidebar nav items and the top bar connection placeholder', () => {
    render(<App />)

    // M1 pages are present and clickable.
    expect(screen.getByRole('button', { name: 'Firmware' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Parameters' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Debug / Status' })).toBeInTheDocument()

    // Future pages are listed but disabled.
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Console' })).toBeDisabled()

    // Top bar shows the disconnected state: port/baud pickers and Connect are
    // present but disabled until Task 3.1 wires up real connection logic.
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    expect(screen.getByLabelText('Serial port')).toBeDisabled()
    expect(screen.getByLabelText('Baud rate')).toBeDisabled()
  })
})
