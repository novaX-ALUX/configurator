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
  /** Short wireframe glyph shown in the sidebar; real icons come from the UI/UX track. */
  glyph: string
  /** M1 ships firmware/parameters/debug; the rest are shown disabled for later milestones. */
  enabled: boolean
}

export const NAV_PAGES: NavPage[] = [
  { id: 'firmware', labelKey: 'nav.firmware', glyph: 'FW', enabled: true },
  { id: 'parameters', labelKey: 'nav.parameters', glyph: 'PM', enabled: true },
  { id: 'debug', labelKey: 'nav.debug', glyph: 'DBG', enabled: true },
  { id: 'dashboard', labelKey: 'nav.dashboard', glyph: 'DSH', enabled: false },
  { id: 'setup', labelKey: 'nav.setup', glyph: 'SET', enabled: false },
  { id: 'calibration', labelKey: 'nav.calibration', glyph: 'CAL', enabled: false },
  { id: 'motors', labelKey: 'nav.motors', glyph: 'MTR', enabled: false },
  { id: 'console', labelKey: 'nav.console', glyph: 'CON', enabled: false },
]

interface NavigationState {
  activePage: PageId
  setActivePage: (page: PageId) => void
}

export const useNavigationStore = create<NavigationState>((set) => ({
  activePage: 'firmware',
  setActivePage: (page) => set({ activePage: page }),
}))
