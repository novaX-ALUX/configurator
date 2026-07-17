import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { OfflineChip } from '../../layout/OfflineChip'
import { MessagesTable } from './MessagesTable'
import { StatusStream } from './StatusStream'

/**
 * Console page (issue #25, PRD §5/§7): merges the Messages aggregate table
 * (issue #24 Ticket 1) with the Status stream (STATUSTEXT feed, carried
 * forward from the retired `StatusPanel`) into one page, stacked — Messages
 * on top with more vertical room (its rows expand in place), Status stream
 * below at a smaller share — both independently scrollable so the page
 * itself never scrolls (G3: fills the viewport instead of one short list
 * floating in a tall empty page).
 *
 * Read-only telemetry page under G5's layered empty-state policy (same
 * bucket as Dashboard/Charts, PRD §7) — it sends no commands, so its full
 * layout always renders, offline or not. `ChartsPage`/`OfflineChip` is the
 * exact shape this mirrors: one chip in the header (`hasMessages ||
 * hasStatustext` decides "Offline" vs "Offline — frozen", since either
 * section having prior data means there's something frozen to show), each
 * section renders its own "no data yet" empty row rather than a full-page
 * connect-first placeholder.
 */
export function ConsolePage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const statustext = useConnectionStore((s) => s.statustext)
  const linkStats = useConnectionStore((s) => s.linkStats)
  const inspector = useConnectionStore((s) => s.inspector)
  const clearStatustext = useConnectionStore((s) => s.clearStatustext)

  const offline = phase !== 'connected'
  const hasMessages = inspector.all().length > 0
  const hasStatustext = statustext.length > 0

  return (
    <div className="flex h-full flex-col px-5 pb-6 pt-[18px]">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.console')}</span>
        <OfflineChip active={offline} label={t(hasMessages || hasStatustext ? 'console.offlineFrozen' : 'console.offline')} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <MessagesTable inspector={inspector} offline={offline} />
        <StatusStream statustext={statustext} linkStats={linkStats} clearStatustext={clearStatustext} />
      </div>
    </div>
  )
}
