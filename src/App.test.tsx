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

    // Dashboard shipped in M2 (Task 6.2) and is now clickable too.
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeEnabled()

    // Future pages are listed but disabled.
    expect(screen.getByRole('button', { name: 'Console' })).toBeDisabled()

    // Top bar shows the disconnected state: baud rate + "Any device" fallback
    // + Connect are all live controls now that Task 3.1 wired up the
    // connection store (Web Serial itself has no port enumeration to back a
    // "Serial port" selector — see TopBar.tsx's own doc).
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    expect(screen.getByLabelText('Baud rate')).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Any device' })).toBeInTheDocument()
  })
})
