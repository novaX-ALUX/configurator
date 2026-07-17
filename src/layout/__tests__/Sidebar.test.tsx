import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../i18n'
import { Sidebar } from '../Sidebar'
import { useNavigationStore } from '../../store/navigation'
import { useGuideStore } from '../../features/guide/guideStore'

const initialState = useNavigationStore.getState()
const initialGuideState = useGuideStore.getState()

function reset(): void {
  useNavigationStore.setState(initialState, true)
}

afterEach(() => {
  useGuideStore.setState(initialGuideState, true)
})

describe('Sidebar', () => {
  it('navigates directly when no guard is registered', () => {
    reset()
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Full Parameters' }))
    expect(useNavigationStore.getState().activePage).toBe('parameters')
    reset()
  })

  it('renders the three Nav Group labels with pages in ADR-0004 order', () => {
    reset()
    render(<Sidebar />)
    expect(screen.getByText('Configure')).toBeInTheDocument()
    expect(screen.getByText('Monitor')).toBeInTheDocument()
    expect(screen.getByText('Maintain')).toBeInTheDocument()
    // Page buttons appear top-to-bottom in group order — Home ungrouped on
    // top (IA T2), guide + licenses footer trailing the groups.
    const names = screen.getAllByRole('button').map((b) => b.textContent)
    expect(names).toEqual([
      'Home',
      'Setup',
      'Calibration',
      'Motors',
      'Tuning',
      'Dashboard',
      'Charts',
      'Full Parameters',
      'Firmware',
      'Console',
      'Setup Guide',
      'Licenses',
    ])
    reset()
  })

  it('blocks navigation when the registered guard returns false (e.g. unsaved parameter edits)', () => {
    reset()
    useNavigationStore.getState().setGuardNavigation(() => false)
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Console' }))
    expect(useNavigationStore.getState().activePage).toBe('home') // unchanged
    reset()
  })

  it('allows navigation when the registered guard returns true', () => {
    reset()
    useNavigationStore.getState().setGuardNavigation(() => true)
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Console' }))
    expect(useNavigationStore.getState().activePage).toBe('console')
    reset()
  })

  it('the Licenses footer button navigates to the licenses page', () => {
    reset()
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Licenses' }))
    expect(useNavigationStore.getState().activePage).toBe('licenses')
    reset()
  })

  it('the dashed-border Setup Guide button toggles the shared guide store', () => {
    render(<Sidebar />)
    expect(useGuideStore.getState().open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Setup Guide' }))
    expect(useGuideStore.getState().open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Setup Guide' }))
    expect(useGuideStore.getState().open).toBe(false)
  })
})
