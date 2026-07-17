import type { UnitGroupId } from './seriesCatalog'

/** Display precision per Unit Group — enough to be exact at each unit's real resolution without noise digits (trailing zeros are trimmed by the parseFloat round-trip in formatValue). */
const GROUP_DECIMALS: Record<UnitGroupId, number> = { deg: 1, V: 2, A: 2, pct: 0, us: 0, count: 1 }

/**
 * Shared by the subplot legend and the picker's live readout (issue #49) so
 * the two present one Series at one precision. `null` reads as '—', never 0.
 */
export function formatValue(value: number | null, unitGroup: UnitGroupId): string {
  if (value === null) return '—'
  return String(parseFloat(value.toFixed(GROUP_DECIMALS[unitGroup])))
}
