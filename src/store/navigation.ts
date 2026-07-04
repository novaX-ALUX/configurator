import { create } from 'zustand'

export type PageId =
  | 'firmware'
  | 'parameters'
  | 'debug'
  | 'dashboard'
  | 'setup'
  | 'calibration'
  | 'motors'
  | 'console'

export interface NavPage {
  id: PageId
  labelKey: string
  /** M1 ships firmware/parameters/debug; the rest are shown disabled for later milestones. */
  enabled: boolean
}

export const NAV_PAGES: NavPage[] = [
  { id: 'firmware', labelKey: 'nav.firmware', enabled: true },
  { id: 'parameters', labelKey: 'nav.parameters', enabled: true },
  { id: 'debug', labelKey: 'nav.debug', enabled: true },
  { id: 'dashboard', labelKey: 'nav.dashboard', enabled: false },
  { id: 'setup', labelKey: 'nav.setup', enabled: false },
  { id: 'calibration', labelKey: 'nav.calibration', enabled: false },
  { id: 'motors', labelKey: 'nav.motors', enabled: false },
  { id: 'console', labelKey: 'nav.console', enabled: false },
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
