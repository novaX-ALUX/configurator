import { afterEach, describe, expect, it } from 'vitest'
import { NAV_GROUPS, NAV_PAGES, useNavigationStore } from '../navigation'

const initialState = useNavigationStore.getState()

afterEach(() => {
  useNavigationStore.setState(initialState, true)
})

describe('nav group structure (ADR-0004)', () => {
  it('defines the three Nav Groups in order: Configure, Monitor, Maintain', () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(['configure', 'monitor', 'maintain'])
  })

  it('nav pages carry exact group membership and order per ADR-0004', () => {
    // Home ungrouped on top (IA T2); Configure in guide-journey order;
    // Maintain in frequency order, with the raw table (relabeled "Full
    // Parameters") first as the Escape Hatch.
    expect(NAV_PAGES.map((p) => [p.id, p.group])).toEqual([
      ['home', undefined],
      ['setup', 'configure'],
      ['calibration', 'configure'],
      ['motors', 'configure'],
      ['tuning', 'configure'],
      ['dashboard', 'monitor'],
      ['charts', 'monitor'],
      ['parameters', 'maintain'],
      ['firmware', 'maintain'],
      ['console', 'maintain'],
    ])
  })
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
    useNavigationStore.getState().setActivePage('charts')
    expect(calls).toEqual(['charts'])
    expect(useNavigationStore.getState().activePage).toBe('charts')
  })

  it('setActivePage is blocked when the guard returns false', () => {
    useNavigationStore.getState().setGuardNavigation(() => false)
    useNavigationStore.getState().setActivePage('charts')
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
