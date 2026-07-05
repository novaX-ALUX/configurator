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
    fireEvent.click(screen.getByRole('button', { name: 'Parameters' }))
    expect(useNavigationStore.getState().activePage).toBe('parameters')
    reset()
  })

  it('blocks navigation when the registered guard returns false (e.g. unsaved parameter edits)', () => {
    reset()
    useNavigationStore.getState().setGuardNavigation(() => false)
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Debug / Status' }))
    expect(useNavigationStore.getState().activePage).toBe('firmware') // unchanged
    reset()
  })

  it('allows navigation when the registered guard returns true', () => {
    reset()
    useNavigationStore.getState().setGuardNavigation(() => true)
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Debug / Status' }))
    expect(useNavigationStore.getState().activePage).toBe('debug')
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
