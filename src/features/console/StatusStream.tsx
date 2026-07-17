import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MavRouterStats } from '../../core/mavlink/router'
import type { StatusTextEntry } from '../../store/connection'
import { formatTime } from '../../utils/time'
import { MAV_SEVERITY_NAMES, severityGroup, type SeverityGroup } from './inspectorUtils'

const ALL_GROUPS: SeverityGroup[] = ['errors', 'warnings', 'info']

/** Row tint per severity group (PRD §8) — the same 3-group boundary the filter chips use, dropping the old 4-tier `severityTier`'s separate `muted` tint (DEBUG now reads as `info`, matching the settled grouping). */
const ROW_CLASSES: Record<SeverityGroup, string> = {
  errors: 'bg-nvx-dangerSoft text-nvx-dangerHover',
  warnings: 'bg-nvx-warningSoft text-nvx-warningText',
  info: 'bg-nvx-primarySoft text-nvx-primarySoftText',
}

/** Chip "on" styling per group, echoing the row tint it filters so a chip visually previews what it shows. */
const CHIP_ACTIVE_CLASSES: Record<SeverityGroup, string> = {
  errors: 'border-nvx-dangerBorder bg-nvx-dangerSoft text-nvx-dangerHover',
  warnings: 'border-nvx-warningBorder bg-nvx-warningSoft text-nvx-warningText',
  info: 'border-nvx-infoBorder bg-nvx-primarySoft text-nvx-primarySoftText',
}

const FILTER_LABEL_KEYS: Record<SeverityGroup, string> = {
  errors: 'console.filterErrors',
  warnings: 'console.filterWarnings',
  info: 'console.filterInfo',
}

function StatusRow({ entry }: { entry: StatusTextEntry }) {
  const group = severityGroup(entry.severity)
  return (
    <div className={`grid grid-cols-[76px_52px_1fr] gap-3 px-4 py-[3px] font-mono text-[11.5px] ${ROW_CLASSES[group]}`}>
      <span className="text-nvx-disabled">{formatTime(entry.ts)}</span>
      <span className="font-bold">{MAV_SEVERITY_NAMES[entry.severity] ?? entry.severity}</span>
      <span>{entry.text}</span>
    </div>
  )
}

/**
 * The Status stream section of the Console page (PRD §5/§8): the STATUSTEXT
 * feed carried forward from the now-retired `StatusPanel`, reworked to the
 * settled 3-group severity boundary for both row color and the new
 * multi-select filter chips (default all on, local non-persisted state,
 * mirroring `paused`'s own local-`useState` convention below).
 *
 * `StatusPanel`'s old "{{count}} messages · buffer {{cap}}" header readout
 * (`debug.messageCount`) is intentionally not carried over — PRD §10 lists
 * it among the keys "dropped outright," replaced by the severity chips +
 * per-row badge below. The 500-entry ring-buffer cap itself is unchanged
 * (`STATUSTEXT_CAP` in `store/connection.ts`); only its on-screen readout
 * is gone.
 *
 * Filtering is applied *before* the pause-snapshot (PRD §8): pausing while
 * filtered freezes the filtered view, matching `ChartsPage`'s pause
 * capturing "what's currently displayed." Toggling a chip while paused does
 * not reach back into the frozen snapshot — same "frozen means frozen" rule
 * `ChartsPage`'s own pause already sets. All-chips-off filters down to an
 * empty list, which renders the same "no messages yet" empty row as a
 * genuinely empty stream — no separate "you filtered everything out" copy.
 */
export function StatusStream({
  statustext,
  linkStats,
  clearStatustext,
}: {
  statustext: StatusTextEntry[]
  linkStats: MavRouterStats | null
  clearStatustext: () => void
}) {
  const { t } = useTranslation()
  const [activeGroups, setActiveGroups] = useState<Set<SeverityGroup>>(new Set(ALL_GROUPS))
  const [paused, setPaused] = useState(false)
  const [frozen, setFrozen] = useState<StatusTextEntry[] | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = statustext.filter((e) => activeGroups.has(severityGroup(e.severity)))
  const display = paused ? (frozen ?? filtered) : filtered

  useEffect(() => {
    if (paused) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [display, paused])

  function togglePause(): void {
    setPaused((was) => {
      if (!was) setFrozen(filtered) // entering paused: snapshot what's currently displayed (post-filter)
      else setFrozen(null) // resuming: drop the snapshot, go live again
      return !was
    })
  }

  function toggleGroup(group: SeverityGroup): void {
    setActiveGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  function handleClear(): void {
    clearStatustext()
    if (paused) setFrozen([])
  }

  return (
    <div className="flex min-h-0 flex-[2] flex-col">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-heading text-[15px] font-bold text-nvx-text">{t('console.statusTitle')}</span>
        <span className="flex gap-1.5">
          {ALL_GROUPS.map((group) => {
            const active = activeGroups.has(group)
            return (
              <button
                key={group}
                type="button"
                onClick={() => toggleGroup(group)}
                aria-pressed={active}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors duration-200 ease-out motion-reduce:transition-none ${
                  active ? CHIP_ACTIVE_CLASSES[group] : 'border-nvx-border bg-white text-nvx-faint hover:border-nvx-borderStrong'
                }`}
              >
                {t(FILTER_LABEL_KEYS[group])}
              </button>
            )
          })}
        </span>
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={togglePause}
            className={`rounded-[9px] border px-3.5 py-[7px] text-[11.5px] font-bold ${
              paused
                ? 'border-nvx-primary bg-nvx-primarySoft text-nvx-primarySoftText'
                : 'border-nvx-borderStrong bg-white text-nvx-text'
            }`}
          >
            {paused ? t('console.resume') : t('console.pause')}
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-[7px] text-[11.5px] font-semibold text-nvx-text hover:bg-nvx-field"
          >
            {t('console.clear')}
          </button>
        </span>
      </div>

      <div
        ref={scrollRef}
        className="min-h-[160px] flex-1 overflow-auto rounded-xl border border-nvx-border bg-nvx-surface py-1.5 shadow-card"
      >
        {display.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-nvx-faint">{t('console.statusEmpty')}</p>
        ) : (
          display.map((entry, i) => <StatusRow key={i} entry={entry} />)
        )}
      </div>

      {linkStats && (
        <div className="mt-2.5 text-right font-mono text-[11px] text-nvx-faint">
          {t('console.linkStats', {
            framesIn: linkStats.framesIn,
            framesOut: linkStats.framesOut,
            crcErrors: linkStats.crcErrors,
            dropped: linkStats.dropped,
          })}
        </div>
      )}
    </div>
  )
}
