import { create } from 'zustand'

export type PageId =
  | 'firmware'
  | 'parameters'
  | 'dashboard'
  | 'charts'
  | 'setup'
  | 'tuning'
  | 'calibration'
  | 'motors'
  | 'console'
  /** Not a NAV_PAGES tab — reached from the sidebar's footer button (issue #39, M1 Decision 3 licenses disclosure). */
  | 'licenses'

export type NavGroupId = 'configure' | 'monitor' | 'maintain'

export interface NavGroup {
  id: NavGroupId
  labelKey: string
}

/**
 * The three Nav Groups of ADR-0004, in display order. The boundary mirrors the
 * layered connection policy: Configure needs a board, Monitor works offline,
 * Maintain holds the low-frequency rescue/debug surfaces.
 */
export const NAV_GROUPS: NavGroup[] = [
  { id: 'configure', labelKey: 'nav.groups.configure' },
  { id: 'monitor', labelKey: 'nav.groups.monitor' },
  { id: 'maintain', labelKey: 'nav.groups.maintain' },
]

export interface NavPage {
  id: PageId
  labelKey: string
  /** Nav Group membership (ADR-0004). Absent = ungrouped, rendered above the groups — the slot Home occupies in IA T2. */
  group?: NavGroupId
  /** M1 shipped firmware/parameters; M2 adds dashboard (Task 6.2), setup (Task 7.2), calibration (Task 8.3), motors (Task 9.3), and console (issue #25 — the merged Debug/Status page, `debug` retired). */
  enabled: boolean
}

/** ADR-0004 order: Configure in guide-journey order, Maintain in frequency order ("Full Parameters" first, as the Escape Hatch). */
export const NAV_PAGES: NavPage[] = [
  { id: 'setup', labelKey: 'nav.setup', group: 'configure', enabled: true },
  { id: 'calibration', labelKey: 'nav.calibration', group: 'configure', enabled: true },
  { id: 'motors', labelKey: 'nav.motors', group: 'configure', enabled: true },
  { id: 'tuning', labelKey: 'nav.tuning', group: 'configure', enabled: true },
  { id: 'dashboard', labelKey: 'nav.dashboard', group: 'monitor', enabled: true },
  { id: 'charts', labelKey: 'nav.charts', group: 'monitor', enabled: true },
  { id: 'parameters', labelKey: 'nav.parameters', group: 'maintain', enabled: true },
  { id: 'firmware', labelKey: 'nav.firmware', group: 'maintain', enabled: true },
  { id: 'console', labelKey: 'nav.console', group: 'maintain', enabled: true },
]

interface NavigationState {
  activePage: PageId
  setActivePage: (page: PageId) => void
  /**
   * Optional check consulted before a page switches away — a page with
   * unsaved state (Task 3.2's parameter edits) registers one to intercept
   * navigation; returning `false` keeps `activePage` unchanged. `null` (the
   * default, and what a page must restore on unmount) means "navigate
   * freely", so only one page needs to care about this at a time.
   */
  guardNavigation: ((next: PageId) => boolean) | null
  setGuardNavigation: (guard: ((next: PageId) => boolean) | null) => void
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  activePage: 'firmware',
  guardNavigation: null,
  setActivePage: (page) => {
    const { activePage, guardNavigation } = get()
    if (page === activePage) return // re-clicking the current page is a no-op, same as before the guard existed — never worth a confirm prompt
    if (guardNavigation && !guardNavigation(page)) return
    set({ activePage: page })
  },
  setGuardNavigation: (guard) => set({ guardNavigation: guard }),
}))
