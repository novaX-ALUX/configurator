import { Fragment, useEffect, useState } from 'react'
import type { MessageAggregateStore } from '../../core/mavlink/inspector'
import { hzFromWindow } from '../../core/mavlink/inspector'
import { formatTime } from '../../utils/time'
import { formatFieldValue, sortAggregatesByName } from './inspectorUtils'

/** Redraw interval for the Hz column — `MessageAggregateStore` is a plain object like `HistoryBuffer`, not a zustand store, so nothing re-renders this component when `record()` runs. Ticket 2's `ConsolePage` will own gating this against `phase !== 'connected'`; here the table is only ever mounted while `StatusPanel` is already in its connected branch, so the interval's lifetime already matches "connected". */
const TICK_MS = 250

/**
 * Bare tracer table (issue #24 Ticket 1): proves the `MessageAggregateStore`
 * tap point end-to-end — mounted temporarily at the bottom of `StatusPanel`
 * — before Ticket 2 relocates it into the real Console page (severity
 * filters, copy actions, i18n, `ConsolePage`'s offline/frozen framing).
 * English strings are hardcoded here on purpose: PRD §10 assigns the real
 * `console.*` i18n keys to Ticket 2, and adding them now would only be
 * thrown away at that cutover (see the ticket's own note on this tradeoff).
 */
export function MessagesTable({ inspector }: { inspector: MessageAggregateStore }) {
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

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
    <div className="mt-6">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-heading text-[15px] font-bold text-nvx-text">Messages</span>
        <span className="font-mono text-[11px] text-nvx-faint">{rows.length} types</span>
      </div>
      <div className="max-h-[420px] overflow-auto rounded-xl border border-nvx-border bg-nvx-surface shadow-card">
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-nvx-faint">No messages yet.</p>
        ) : (
          <table className="w-full border-collapse text-left font-mono text-[11.5px]">
            <thead>
              <tr className="border-b border-nvx-border text-nvx-faint">
                <th className="px-4 py-1.5 font-semibold">Type</th>
                <th className="px-4 py-1.5 font-semibold">Hz</th>
                <th className="px-4 py-1.5 font-semibold">Count</th>
                <th className="px-4 py-1.5 font-semibold">Last seen</th>
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
                      <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span> <span>{row.name}</span>
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
