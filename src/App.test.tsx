import { fireEvent, render, screen, within } from '@testing-library/react'
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
    // "Serial port" selector — see TopBar.tsx's own doc). Scoped to the
    // top bar because Home's Connect CTA (IA T2) shares the same label.
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Connect' })).toBeEnabled()
    expect(screen.getByLabelText('Baud rate')).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Any device' })).toBeInTheDocument()
  })

  // The arrival journey as one story (IA T3, issue #45) — deliberately NOT
  // split into atomic per-fact assertions, so it survives refactors of the
  // intermediate structure as long as the journey itself still works.
  it('arrival journey: lands on Home, guide steps in view, rescue bypass reaches Firmware (issue #45)', () => {
    render(<App />)

    // The first screen after load is Home — no interaction needed.
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page')

    // The guide steps are waiting on that first screen, first to last.
    expect(screen.getByRole('heading', { name: 'First-flight Setup Guide' })).toBeInTheDocument()
    expect(screen.getByText('Connect & fetch parameters')).toBeInTheDocument()
    expect(screen.getByText('Failsafes')).toBeInTheDocument()

    // A bricked-board user takes the rescue bypass and lands on Firmware.
    fireEvent.click(screen.getByRole('button', { name: 'Open Firmware' }))
    expect(screen.getByRole('button', { name: 'DFU rescue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Firmware' })).toHaveAttribute('aria-current', 'page')

    useNavigationStore.setState({ activePage: 'home' })
  })

  it('reaches the Home page from the top of the sidebar with active-page marking (issue #44)', () => {
    useNavigationStore.setState({ activePage: 'firmware' })
    render(<App />)
    const homeButton = screen.getByRole('button', { name: 'Home' })
    fireEvent.click(homeButton)
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
    expect(homeButton).toHaveAttribute('aria-current', 'page')
  })

  it('reaches the licenses page from the sidebar without a vehicle connected (issue #39)', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Licenses' }))
    expect(screen.getByRole('heading', { name: 'Licenses & third-party notices' })).toBeInTheDocument()
    useNavigationStore.setState({ activePage: 'home' })
  })
})
