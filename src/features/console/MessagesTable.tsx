import { Fragment, useEffect, useRef, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { DecodedMessage } from '../../core/mavlink/decode'
import type { MessageAggregateStore } from '../../core/mavlink/inspector'
import { hzFromWindow } from '../../core/mavlink/inspector'
import { formatTime } from '../../utils/time'
import { copyToClipboard, formatFieldsText, formatFieldValue, formatMessagesTableTSV, sortAggregatesByName } from './inspectorUtils'

/** How long the "Copy table" button shows `console.copyTableDone` ("Copied") before reverting — PRD §9/§10, same transient-state budget `OfflineChip`'s `EXIT_MS` uses for a short-lived UI state (not a toast component). */
const COPIED_MS = 1500

/** Feature-detected once per render rather than assumed — an insecure context or a browser that never exposes `navigator.clipboard` gets a disabled affordance instead of a button that throws on click (PRD §9). */
function clipboardAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText
}

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
 * The Messages section of the Console page (PRD §5/§6/§9): the
 * `MessageAggregateStore` aggregate table with expandable rows and clipboard
 * export. Originally landed (issue #24 Ticket 1) as a bare tracer mounted at
 * the bottom of the now-retired `StatusPanel`; issue #25 gave it its real
 * i18n keys and folded it into `ConsolePage`'s stacked layout; issue #26
 * (this ticket) adds "Copy table"/"Copy fields" (PRD §9) — both stay enabled
 * while offline-and-frozen, since a disconnected user copying the last-known
 * table/fields is a legitimate use case (PRD §7), not something to gate
 * behind reconnecting.
 */
export function MessagesTable({ inspector, offline }: { inspector: MessageAggregateStore; offline: boolean }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [copied, setCopied] = useState(false)
  // A plain ref, not a `copied`-keyed effect: setCopied(true) while `copied`
  // is already `true` is a same-value update, which React bails out of
  // without re-running effects — that would leave a re-click of "Copy table"
  // mid-swap unable to restart the ~1.5s countdown. Managing the timeout
  // directly in the click handler (clear-then-restart) sidesteps that.
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (offline) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [offline])

  // Copy actions stay enabled while offline-and-frozen (PRD §7) — there's
  // real, frozen data worth copying, so neither handler checks `offline`.
  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
    }
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

  async function handleCopyTable(): Promise<void> {
    const ok = await copyToClipboard(formatMessagesTableTSV(rows, now))
    if (!ok) return
    setCopied(true)
    if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
    copiedTimeoutRef.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  async function handleCopyFields(e: MouseEvent, latest: DecodedMessage): Promise<void> {
    e.stopPropagation() // the row itself toggles expansion on click — the button must not also toggle it
    await copyToClipboard(formatFieldsText(latest))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-[3] flex-col">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-heading text-[15px] font-bold text-nvx-text">{t('console.messagesTitle')}</span>
        <span className="ml-auto flex items-baseline gap-2">
          <button
            type="button"
            onClick={handleCopyTable}
            disabled={!clipboardAvailable()}
            className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-[7px] text-[11.5px] font-semibold text-nvx-text transition-transform duration-150 ease-out hover:bg-nvx-field active:scale-[0.97] motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
          >
            {copied ? t('console.copyTableDone') : t('console.copyTable')}
          </button>
          <span className="font-mono text-[11px] text-nvx-faint">{t('console.typeCount', { count: rows.length })}</span>
        </span>
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
                    <td className="px-4 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span>{formatTime(row.lastSeen)}</span>
                        {isExpanded && (
                          <button
                            type="button"
                            onClick={(e) => handleCopyFields(e, row.latest)}
                            disabled={!clipboardAvailable()}
                            className="rounded-md border border-nvx-border bg-white px-2 py-0.5 text-[10.5px] font-semibold text-nvx-text transition-transform duration-150 ease-out hover:bg-nvx-field active:scale-[0.97] motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
                          >
                            {t('console.copyFields')}
                          </button>
                        )}
                      </div>
                    </td>
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
