import { create } from 'zustand'
import { SERIES_CATALOG } from './seriesCatalog'

/**
 * Which Series the user is charting (issue #4). Selection is the one piece
 * of Charts state the spec persists: it survives page switches (module-scope
 * store, not page-local `useState`) and app reloads (localStorage,
 * write-through on every toggle, hydrated once at module evaluation).
 *
 * Hydration is defensive because storage is user-editable and outlives
 * builds: anything that isn't a JSON array is discarded wholesale (fall back
 * to the default), and ids the current catalog doesn't know are dropped
 * individually. An explicitly-empty stored array is respected — the default
 * is for fresh/broken profiles, not for a user who deselected everything.
 *
 * Hand-rolled rather than zustand's `persist` middleware: one key, one
 * synchronous read at startup, write-through on toggle — the middleware's
 * versioning/migration/rehydration machinery buys nothing here.
 */

const STORAGE_KEY = 'novax.charts.selectedSeries'

/** A sensible first-visit view (spec): the attitude Unit Group. */
const DEFAULT_SELECTION: readonly string[] = ['attitude.roll', 'attitude.pitch', 'attitude.yaw']

const KNOWN_IDS = new Set(SERIES_CATALOG.map((s) => s.id))

function loadSelection(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
    if (!Array.isArray(parsed)) return [...DEFAULT_SELECTION]
    return parsed.filter((id): id is string => typeof id === 'string' && KNOWN_IDS.has(id))
  } catch {
    return [...DEFAULT_SELECTION]
  }
}

export interface ChartSelectionState {
  /** Selected Series ids, in toggle order — display order comes from the catalog, not from here. */
  selectedIds: string[]
  toggleSeries: (id: string) => void
}

export const useChartSelectionStore = create<ChartSelectionState>((set) => ({
  selectedIds: loadSelection(),
  toggleSeries: (id) =>
    set((s) => {
      const selectedIds = s.selectedIds.includes(id)
        ? s.selectedIds.filter((sel) => sel !== id)
        : [...s.selectedIds, id]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedIds))
      return { selectedIds }
    }),
}))
