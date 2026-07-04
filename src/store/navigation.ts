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
}

export const useNavigationStore = create<NavigationState>((set) => ({
  activePage: 'firmware',
  setActivePage: (page) => set({ activePage: page }),
}))
