import { useTranslation } from 'react-i18next'
import { diffStatusMessage, type DiffRowStatus } from '../params/paramUtils'
import type { PendingChange } from './setupStore'

interface SetupDirtyBarProps {
  pending: Map<string, PendingChange>
  writeStatus: Map<string, DiffRowStatus>
  writing: boolean
  onWrite: () => void
  onRevert: () => void
}

type Tone = 'pending' | 'ok' | 'failed'

function toneOf(status: DiffRowStatus | undefined): Tone {
  if (!status || status.kind === 'writing') return 'pending'
  return status.kind === 'ok' ? 'ok' : 'failed'
}

/**
 * Sticky pending bar: the design mock's bottom bar (chips + Write/Revert),
 * not a separate review dialog like `features/params`' `DiffDrawer` — Setup
 * has no modal step between staging and writing, this bar *is* the review
 * surface. Only rendered by `SetupPage` while `pending.size > 0`.
 */
export function SetupDirtyBar({ pending, writeStatus, writing, onWrite, onRevert }: SetupDirtyBarProps) {
  const { t } = useTranslation()
  // Computed once per param, not re-looked-up separately for the chip tone,
  // the "any failures?" check, and the failure message below.
  const rows = [...pending.entries()].map(([param, change]) => ({ param, change, status: writeStatus.get(param), tone: toneOf(writeStatus.get(param)) }))
  const failed = rows.filter((row): row is typeof row & { status: DiffRowStatus } => row.tone === 'failed')

  return (
    <div className="sticky bottom-3 flex flex-col gap-2 rounded-xl border border-nvx-warningBorder bg-nvx-warningSoft px-4 py-3 shadow-popover">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="h-2 w-2 flex-none rounded-full bg-nvx-warning" />
        <span className="flex-none text-[12.5px] font-extrabold text-nvx-warningText">{t('setup.pendingBadge', { count: rows.length })}</span>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {rows.map(({ param, change, tone }) => (
            <span
              key={param}
              title={change.label}
              className={`rounded-md border px-2 py-[3px] font-mono text-[10.5px] ${
                tone === 'failed'
                  ? 'border-nvx-dangerBorder bg-nvx-dangerSoft text-nvx-danger'
                  : tone === 'ok'
                    ? 'border-nvx-success bg-nvx-successSoft text-nvx-successText'
                    : 'border-nvx-warningBorder bg-white text-nvx-warningText'
              }`}
            >
              {param} → {change.value}
            </span>
          ))}
        </div>
        <button
          type="button"
          disabled={writing}
          onClick={onWrite}
          className="ml-auto flex-none rounded-[9px] bg-nvx-primary px-4 py-2 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {writing ? t('params.writing') : t('params.writeToBoard')}
        </button>
        <button
          type="button"
          disabled={writing}
          onClick={onRevert}
          className="flex-none rounded-[9px] px-3 py-2 text-[12.5px] font-semibold text-nvx-warningText hover:bg-nvx-warningBorder/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('setup.revert')}
        </button>
      </div>
      {failed.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {failed.map(({ param, status }) => (
            <div key={param} className="text-[11px] text-nvx-danger">
              <span className="font-mono font-semibold">{param}</span>: {diffStatusMessage(status, t)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
