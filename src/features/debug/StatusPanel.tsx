import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore, type StatusTextEntry } from '../../store/connection'

/**
 * MAV_SEVERITY (0 EMERGENCY .. 7 DEBUG) collapsed into the 4 visual tiers this
 * app has design tokens for. The design file (`docs/design/novaX-Configurator.dc.html`,
 * its Console screen) only ever distinguishes WARNING (amber) from everything
 * else (default blue "STATUSTEXT" tint) — this extends that same idea to the
 * full severity range: EMERGENCY..ERROR read as more alarming than WARNING
 * (danger), NOTICE/INFO match the design's own default tint, and DEBUG is
 * de-emphasized (muted) since it's the least actionable severity.
 */
type SeverityTier = 'danger' | 'warning' | 'info' | 'muted'

function severityTier(severity: number): SeverityTier {
  if (severity <= 3) return 'danger' // EMERGENCY, ALERT, CRITICAL, ERROR
  if (severity === 4) return 'warning'
  if (severity <= 6) return 'info' // NOTICE, INFO
  return 'muted' // DEBUG
}

const ROW_CLASSES: Record<SeverityTier, string> = {
  danger: 'bg-nvx-dangerSoft text-nvx-dangerHover',
  warning: 'bg-nvx-warningSoft text-nvx-warningText',
  info: 'bg-nvx-primarySoft text-nvx-primarySoftText',
  muted: 'bg-transparent text-nvx-faint',
}

const STATUSTEXT_CAP = 500

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function StatusRow({ entry }: { entry: StatusTextEntry }) {
  const tier = severityTier(entry.severity)
  return (
    <div className={`grid grid-cols-[76px_1fr] gap-3 px-4 py-[3px] font-mono text-[11.5px] ${ROW_CLASSES[tier]}`}>
      <span className="text-nvx-disabled">{formatTime(entry.ts)}</span>
      <span>{entry.text}</span>
    </div>
  )
}

/**
 * Debug/Status page: STATUSTEXT stream (severity-colored, task 3.1 scope) +
 * link stats from `router.stats`. A full raw-message console (all msgids,
 * filters) is Task M2 scope — see Sidebar.tsx's own note that this page
 * folds STATUSTEXT/link status into what the design file calls "Console".
 */
export function StatusPanel() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const statustext = useConnectionStore((s) => s.statustext)
  const linkStats = useConnectionStore((s) => s.linkStats)
  const connect = useConnectionStore((s) => s.connect)
  const baud = useConnectionStore((s) => s.baud)
  const clearStatustext = useConnectionStore((s) => s.clearStatustext)

  const [paused, setPaused] = useState(false)
  const [frozen, setFrozen] = useState<StatusTextEntry[] | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const display = paused ? (frozen ?? statustext) : statustext

  useEffect(() => {
    if (paused) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [display, paused])

  function togglePause(): void {
    setPaused((was) => {
      if (!was) setFrozen(statustext) // entering paused: snapshot what's on screen now
      else setFrozen(null) // resuming: drop the snapshot, go live again
      return !was
    })
  }

  function handleClear(): void {
    clearStatustext()
    if (paused) setFrozen([])
  }

  if (phase !== 'connected') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        <div className="flex h-[74px] w-[74px] items-center justify-center rounded-[22px] border border-nvx-border bg-nvx-surface text-nvx-faint">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <rect x="3" y="4.75" width="18" height="14.5" rx="2.5" />
            <path d="M7 9.25l3.25 2.75L7 14.75M12.5 15h4.5" />
          </svg>
        </div>
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('debug.notConnectedTitle')}</div>
        <div className="max-w-[400px] text-center text-[13px] leading-relaxed text-nvx-muted">
          {t('debug.notConnectedBody')}
        </div>
        <button
          type="button"
          onClick={() => void connect(baud)}
          className="rounded-[10px] bg-nvx-primary px-[22px] py-2.5 text-[13px] font-bold text-white hover:bg-nvx-primaryHover"
        >
          {t('debug.connectCta')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col px-5 pb-6 pt-[18px]">
      <div className="mb-3 flex items-baseline">
        <span className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.debug')}</span>
        <span className="ml-auto font-mono text-[11px] text-nvx-faint">
          {t('debug.messageCount', { count: statustext.length, cap: STATUSTEXT_CAP })}
        </span>
      </div>

      <div className="mb-3 flex items-center gap-2">
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
            {paused ? t('debug.resume') : t('debug.pause')}
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-[7px] text-[11.5px] font-semibold text-nvx-text hover:bg-nvx-field"
          >
            {t('debug.clear')}
          </button>
        </span>
      </div>

      <div
        ref={scrollRef}
        className="min-h-[240px] flex-1 overflow-auto rounded-xl border border-nvx-border bg-nvx-surface py-1.5 shadow-card"
      >
        {display.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-nvx-faint">{t('debug.empty')}</p>
        ) : (
          display.map((entry, i) => <StatusRow key={i} entry={entry} />)
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-nvx-faint">
        <span className="h-2.5 w-2.5 rounded-[3px] border border-nvx-infoBorder bg-nvx-primarySoft" />
        {t('debug.legendStatustext')}
        <span className="ml-2 h-2.5 w-2.5 rounded-[3px] border border-nvx-warningBorder bg-nvx-warningSoft" />
        {t('debug.legendWarning')}
        <span className="ml-2 h-2.5 w-2.5 rounded-[3px] border border-nvx-dangerBorder bg-nvx-dangerSoft" />
        {t('debug.legendError')}
        {linkStats && (
          <span className="ml-auto font-mono">
            {t('debug.linkStats', {
              framesIn: linkStats.framesIn,
              framesOut: linkStats.framesOut,
              crcErrors: linkStats.crcErrors,
              dropped: linkStats.dropped,
            })}
          </span>
        )}
      </div>
    </div>
  )
}
