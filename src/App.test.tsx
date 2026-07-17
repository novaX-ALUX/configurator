import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'
import { useNavigationStore } from './store/navigation'

describe('App shell', () => {
  it('renders the sidebar nav items and the top bar connection placeholder', () => {
    render(<App />)

    // M1 pages are present and clickable.
    expect(screen.getByRole('button', { name: 'Firmware' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Full Parameters' })).toBeInTheDocument()

    // Dashboard shipped in M2 (Task 6.2) and is now clickable too.
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeEnabled()

    // Charts shipped with the Telemetry Charts tracer bullet (issue #3).
    expect(screen.getByRole('button', { name: 'Charts' })).toBeEnabled()

    // Console (issue #25) merges the old Debug/Status page's STATUSTEXT feed
    // with the Messages aggregate table (issue #24) and is enabled.
    expect(screen.getByRole('button', { name: 'Console' })).toBeEnabled()

    // Top bar shows the disconnected state: baud rate + "Any device" fallback
    // + Connect are all live controls now that Task 3.1 wired up the
    // connection store (Web Serial itself has no port enumeration to back a
    // "Serial port" selector — see TopBar.tsx's own doc).
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    expect(screen.getByLabelText('Baud rate')).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Any device' })).toBeInTheDocument()
  })

  it('still lands on Firmware by default — Home does not take over arrival until IA T3', () => {
    render(<App />)
    expect(useNavigationStore.getState().activePage).toBe('firmware')
    expect(screen.getByRole('button', { name: 'Home' })).not.toHaveAttribute('aria-current')
  })

  it('reaches the Home page from the top of the sidebar with active-page marking (issue #44)', () => {
    render(<App />)
    const homeButton = screen.getByRole('button', { name: 'Home' })
    fireEvent.click(homeButton)
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
    expect(homeButton).toHaveAttribute('aria-current', 'page')
    useNavigationStore.setState({ activePage: 'firmware' })
  })

  it('reaches the licenses page from the sidebar without a vehicle connected (issue #39)', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Licenses' }))
    expect(screen.getByRole('heading', { name: 'Licenses & third-party notices' })).toBeInTheDocument()
    useNavigationStore.setState({ activePage: 'firmware' })
  })
})
