import { useTranslation } from 'react-i18next'
import { diffStatusMessage, type DiffRowStatus } from './paramUtils'

export type { DiffRowStatus }

export interface DiffRow {
  name: string
  current: number
  next: number
  status: DiffRowStatus | undefined
}

interface DiffDrawerProps {
  rows: DiffRow[]
  /** True for the whole duration of the sequential write loop — disables Write/Keep-editing/Discard so the in-flight batch can't be interrupted or resubmitted concurrently. */
  writing: boolean
  onDiscard: (name: string) => void
  onWriteAll: () => void
  onClose: () => void
}

/**
 * Review-before-write modal (design file's centered dialog, not a slide-up
 * panel — `docs/design/novaX-Configurator.dc.html` lines 746-786 show a
 * fixed-center overlay for this exact screen, so this follows the design
 * file over the brief's "slide-up/side panel" wording, per this project's
 * established "design file wins" precedent (task-3.0-report.md)). Every
 * pending edit is a row; failed writes stay listed (never auto-retried —
 * the user decides whether to retry via a fresh "Write to board" click, or
 * discard).
 */
export function DiffDrawer({ rows, writing, onDiscard, onWriteAll, onClose }: DiffDrawerProps) {
  const { t } = useTranslation()

  return (
    <>
      <div onClick={writing ? undefined : onClose} className="fixed inset-0 z-[70] bg-[rgba(23,26,32,.4)]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('params.drawerTitle', { count: rows.length })}
        className="fixed left-1/2 top-1/2 z-[71] w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-popover"
      >
        <div className="mb-0.5 font-heading text-[16px] font-bold text-nvx-text">{t('params.drawerTitle', { count: rows.length })}</div>
        <div className="mb-3.5 text-[12px] text-nvx-subtle">{t('params.drawerSubtitle')}</div>

        <div className="mb-3.5 overflow-hidden rounded-[10px] border border-nvx-border">
          <div className="grid grid-cols-[1.4fr_1fr_1fr_70px] gap-2 bg-nvx-field px-3.5 py-[7px] text-[10px] font-extrabold tracking-[.1em] text-nvx-faint">
            <span>{t('params.columnName')}</span>
            <span>{t('params.drawerColOnBoard')}</span>
            <span>{t('params.drawerColNew')}</span>
            <span />
          </div>
          {rows.map((row) => {
            // Three tones: no status yet (or still writing) is neutral/amber
            // like an ordinary pending edit, 'ok' is green (written and
            // verified — about to clear), anything else is a failure (red,
            // stays listed, never auto-retried).
            const tone = !row.status || row.status.kind === 'writing' ? 'pending' : row.status.kind === 'ok' ? 'ok' : 'failed'
            return (
              <div key={row.name} className="border-t border-nvx-border px-3.5 py-2">
                <div className="grid grid-cols-[1.4fr_1fr_1fr_70px] items-center gap-2 font-mono text-[12.5px]">
                  <span className="font-semibold text-nvx-muted">{row.name}</span>
                  <span className="text-nvx-faint">{row.current}</span>
                  <span className={`font-bold ${tone === 'failed' ? 'text-nvx-danger' : tone === 'ok' ? 'text-nvx-successText' : 'text-nvx-warningText'}`}>
                    {row.next}
                  </span>
                  {!writing && (
                    <button
                      type="button"
                      onClick={() => onDiscard(row.name)}
                      className="justify-self-end text-[11px] font-semibold text-nvx-subtle hover:text-nvx-danger"
                    >
                      {t('params.discard')}
                    </button>
                  )}
                </div>
                {row.status && row.status.kind !== 'writing' && (
                  <div className={`mt-1 flex items-center gap-1 text-[11px] ${tone === 'ok' ? 'text-nvx-successText' : 'text-nvx-danger'}`}>
                    {tone === 'ok' && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="8.25" />
                        <path d="M8.5 12.3l2.4 2.4 4.6-5" />
                      </svg>
                    )}
                    {diffStatusMessage(row.status, t)}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {writing ? (
          <div className="flex items-center gap-2.5 rounded-[9px] bg-nvx-primarySoft px-3 py-2.5 text-[12.5px] font-bold text-nvx-primarySoftText">
            <span className="h-3.5 w-3.5 animate-nvxSpin rounded-full border-2 border-nvx-infoBorder border-t-nvx-primary" />
            {t('params.writing')}
          </div>
        ) : (
          <div className="flex justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[9px] border border-nvx-borderStrong bg-white px-4 py-2 text-[12.5px] font-semibold text-nvx-text hover:bg-nvx-field"
            >
              {t('params.keepEditing')}
            </button>
            <button
              type="button"
              onClick={onWriteAll}
              disabled={rows.length === 0}
              className="rounded-[9px] bg-nvx-primary px-[18px] py-2 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('params.writeToBoard')}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
