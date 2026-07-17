import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageAggregateStore } from '../../core/mavlink/inspector'
import { hzFromWindow } from '../../core/mavlink/inspector'
import { formatTime } from '../../utils/time'
import { formatFieldValue, sortAggregatesByName } from './inspectorUtils'

/**
 * Redraw interval for the Hz column — `MessageAggregateStore` is a plain
 * object like `HistoryBuffer`, not a zustand store, so nothing re-renders
 * this component when `record()` runs. Gated on `!offline` (PRD §5/§7): a
 * frozen aggregate's `recentTimestamps` stop changing the moment the link
 * drops, but re-deriving Hz against a still-advancing `now` would decay
 * every value to 0 anyway — the tick must stop right alongside the data so
 * frozen Hz reads as "the rate when the link died," not a fake 0.
 */
const TICK_MS = 250

/**
 * The Messages section of the Console page (PRD §5/§6): the
 * `MessageAggregateStore` aggregate table with expandable rows. Originally
 * landed (issue #24 Ticket 1) as a bare tracer mounted at the bottom of the
 * now-retired `StatusPanel`; this ticket (#25) gives it its real i18n keys
 * and folds it into `ConsolePage`'s stacked, independently-scrollable layout.
 */
export function MessagesTable({ inspector, offline }: { inspector: MessageAggregateStore; offline: boolean }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (offline) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [offline])

  const rows = sortAggregatesByName(inspector.all())

  function toggle(msgid: number): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(msgid)) next.delete(msgid)
      else next.add(msgid)
      return next
    })
  }

  return (
    <div className="flex min-h-0 flex-[3] flex-col">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-heading text-[15px] font-bold text-nvx-text">{t('console.messagesTitle')}</span>
        <span className="font-mono text-[11px] text-nvx-faint">{t('console.typeCount', { count: rows.length })}</span>
      </div>
      <div className="min-h-[160px] flex-1 overflow-auto rounded-xl border border-nvx-border bg-nvx-surface shadow-card">
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-nvx-faint">{t('console.messagesEmpty')}</p>
        ) : (
          <table className="w-full border-collapse text-left font-mono text-[11.5px]">
            <thead>
              <tr className="border-b border-nvx-border text-nvx-faint">
                <th className="px-4 py-1.5 font-semibold">{t('console.colType')}</th>
                <th className="px-4 py-1.5 font-semibold">{t('console.colHz')}</th>
                <th className="px-4 py-1.5 font-semibold">{t('console.colCount')}</th>
                <th className="px-4 py-1.5 font-semibold">{t('console.colLastSeen')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => {
                const isExpanded = expanded.has(row.msgid)
                const hz = hzFromWindow(row.recentTimestamps, now)
                const trs = [
                  <tr
                    key={row.msgid}
                    onClick={() => toggle(row.msgid)}
                    aria-expanded={isExpanded}
                    className="cursor-pointer border-b border-nvx-border last:border-0 hover:bg-nvx-field"
                  >
                    <td className="px-4 py-1.5">
                      <span
                        aria-hidden="true"
                        className={`inline-block transition-transform duration-150 ease-out motion-reduce:transition-none ${isExpanded ? 'rotate-90' : ''}`}
                      >
                        ▸
                      </span>{' '}
                      <span>{row.name}</span>
                    </td>
                    <td className="px-4 py-1.5">{hz.toFixed(1)}</td>
                    <td className="px-4 py-1.5">{row.count}</td>
                    <td className="px-4 py-1.5">{formatTime(row.lastSeen)}</td>
                  </tr>,
                ]
                if (isExpanded) {
                  trs.push(
                    <tr key={`${row.msgid}-fields`} className="border-b border-nvx-border bg-nvx-field/60 last:border-0">
                      <td colSpan={4} className="px-4 py-2">
                        <div className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-0.5">
                          {Object.entries(row.latest.fields).map(([name, value]) => (
                            <Fragment key={name}>
                              <span className="text-nvx-faint">{name}</span>
                              <span className="break-all">{formatFieldValue(value)}</span>
                            </Fragment>
                          ))}
                        </div>
                      </td>
                    </tr>,
                  )
                }
                return trs
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
