import { afterEach, describe, expect, it } from 'vitest'
import { useNavigationStore } from '../navigation'

const initialState = useNavigationStore.getState()

afterEach(() => {
  useNavigationStore.setState(initialState, true)
})

describe('navigation store', () => {
  it('setActivePage navigates freely with no guard registered', () => {
    useNavigationStore.getState().setActivePage('parameters')
    expect(useNavigationStore.getState().activePage).toBe('parameters')
  })

  it('setActivePage consults the registered guard, passing the destination page', () => {
    const calls: string[] = []
    useNavigationStore.getState().setGuardNavigation((next) => {
      calls.push(next)
      return true
    })
    useNavigationStore.getState().setActivePage('debug')
    expect(calls).toEqual(['debug'])
    expect(useNavigationStore.getState().activePage).toBe('debug')
  })

  it('setActivePage is blocked when the guard returns false', () => {
    useNavigationStore.getState().setGuardNavigation(() => false)
    useNavigationStore.getState().setActivePage('debug')
    expect(useNavigationStore.getState().activePage).toBe('firmware') // unchanged
  })

  it('re-selecting the already-active page is a no-op and never consults the guard (no spurious confirm prompt)', () => {
    const calls: string[] = []
    useNavigationStore.getState().setGuardNavigation((next) => {
      calls.push(next)
      return false
    })
    useNavigationStore.getState().setActivePage('firmware') // already the active page
    expect(calls).toEqual([])
    expect(useNavigationStore.getState().activePage).toBe('firmware')
  })

  it('the guard protects every caller of setActivePage, not just one call site', () => {
    useNavigationStore.getState().setGuardNavigation(() => false)
    const { setActivePage } = useNavigationStore.getState()
    setActivePage('console') // called directly, not through any UI wrapper
    expect(useNavigationStore.getState().activePage).toBe('firmware')
  })
})
