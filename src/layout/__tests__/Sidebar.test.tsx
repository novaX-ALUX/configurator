import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../i18n'
import { Sidebar } from '../Sidebar'
import { useNavigationStore } from '../../store/navigation'

const initialState = useNavigationStore.getState()

function reset(): void {
  useNavigationStore.setState(initialState, true)
}

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
})
