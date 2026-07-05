import { create } from 'zustand'

/**
 * Open/closed state for the Setup Guide drawer (Task 10.1). A tiny
 * module-scope store, not page-local `useState`, for the same reason
 * `features/motors/motorTestStore.ts` is one (see that file's own doc):
 * the trigger button lives in `Sidebar.tsx` while the drawer itself is
 * mounted in `App.tsx` -- siblings in the tree, not ancestor/descendant --
 * so both need to read/drive the same live `open` flag.
 */
export interface GuideState {
  open: boolean
  openGuide: () => void
  closeGuide: () => void
  toggleGuide: () => void
}

export const useGuideStore = create<GuideState>((set) => ({
  open: false,
  openGuide: () => set({ open: true }),
  closeGuide: () => set({ open: false }),
  toggleGuide: () => set((s) => ({ open: !s.open })),
}))
