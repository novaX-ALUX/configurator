import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../store/connection'

const AUTO_DISMISS_MS = 5000

interface ToastEntry {
  id: number
  text: string
}

/**
 * Fixed-position toast stack (design file's `nvxToast` keyframe + the
 * bottom-right toast container from `docs/design/novaX-Configurator.dc.html`),
 * driven entirely by `useConnectionStore`'s `phase`/`lastDisconnectReason` —
 * no page wires this up itself, so it needs to be mounted once at the App
 * shell level to cover every page consistently (task 3.1 requirement 4).
 *
 * Fires on two phase transitions only:
 * - into 'lost' (heartbeat timeout, link still physically open)
 * - into 'disconnected' *from* 'connected'/'lost' *with* a
 *   `lastDisconnectReason` (a real teardown — unplug or explicit
 *   Disconnect). A fresh app boot, or the user simply dismissing the native
 *   port picker, both leave `lastDisconnectReason` `null` and must not toast.
 */
export function DisconnectToast() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const lastDisconnectReason = useConnectionStore((s) => s.lastDisconnectReason)
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const prevPhaseRef = useRef(phase)
  const nextIdRef = useRef(0)

  function dismiss(id: number): void {
    setToasts((ts) => ts.filter((toast) => toast.id !== id))
  }

  function push(text: string): void {
    const id = ++nextIdRef.current
    // Cap the visible stack at 3 (design file's own toast system, `nvxToast`'s
    // `slice(-2)` before append) — drop the oldest rather than let a burst of
    // transitions pile up an unbounded column of toasts.
    setToasts((ts) => [...ts.slice(-2), { id, text }])
    setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
  }

  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    if (phase === prev) return

    if (phase === 'lost') {
      push(t('topbar.linkLost'))
    } else if (phase === 'disconnected' && (prev === 'connected' || prev === 'lost') && lastDisconnectReason) {
      push(t('toast.disconnected', { reason: lastDisconnectReason }))
    }
    // Only phase transitions should trigger a new toast — re-running this on
    // every lastDisconnectReason/t identity change would refire on renders
    // that aren't an actual transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-[18px] right-[18px] z-[90] flex w-[350px] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="animate-nvxToast flex items-start gap-2.5 rounded-xl border border-nvx-border bg-white p-3.5 text-[12.5px] font-semibold text-nvx-text shadow-popover"
        >
          <span className="min-w-0 flex-1">{toast.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(toast.id)}
            className="flex-none rounded-md px-1 text-nvx-subtle hover:bg-nvx-field"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
