import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineChip } from '../OfflineChip'

describe('OfflineChip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders immediately when mounted active', () => {
    render(<OfflineChip active label="Offline" />)
    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(screen.getByText('Offline')).not.toHaveAttribute('aria-hidden')
  })

  it('renders nothing when mounted inactive', () => {
    render(<OfflineChip active={false} label="Offline" />)
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it('going active -> inactive: stays mounted (aria-hidden immediately) and is removed only after the exit transition finishes', async () => {
    const { rerender } = render(<OfflineChip active label="Offline" />)
    expect(screen.getByText('Offline')).toBeInTheDocument()

    rerender(<OfflineChip active={false} label="Offline" />)

    // Still in the DOM mid-fade, but hidden from assistive tech right away.
    expect(screen.getByText('Offline')).toHaveAttribute('aria-hidden', 'true')

    await vi.advanceTimersByTimeAsync(199)
    expect(screen.getByText('Offline')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(1)
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it('going inactive -> active again mid-fade cancels the pending unmount', async () => {
    const { rerender } = render(<OfflineChip active label="Offline" />)
    rerender(<OfflineChip active={false} label="Offline" />)

    await vi.advanceTimersByTimeAsync(100) // mid-fade, not yet unmounted

    rerender(<OfflineChip active label="Offline" />)
    await vi.advanceTimersByTimeAsync(200) // past the original exit timer's deadline

    // Still here — flipping back to active cancelled the pending removal.
    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(screen.getByText('Offline')).not.toHaveAttribute('aria-hidden')
  })

  it('merges a caller-supplied className (e.g. GpsCard\'s shared "ml-auto" header slot) onto its own root, not a wrapper', () => {
    render(<OfflineChip active label="Offline" className="ml-auto" />)
    expect(screen.getByText('Offline').className).toContain('ml-auto')
  })
})
