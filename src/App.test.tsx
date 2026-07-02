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

    // Top bar shows the not-connected state with a disabled Connect button.
    expect(screen.getByText('Not connected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
  })
})
