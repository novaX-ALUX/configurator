import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { OfflineChip } from '../../layout/OfflineChip'
import { MessagesTable } from './MessagesTable'
import { StatusStream } from './StatusStream'

/**
 * Console page (issue #25, PRD §5/§7): merges the Messages aggregate table
 * (issue #24 Ticket 1) with the Status stream (STATUSTEXT feed, carried
 * forward from the retired `StatusPanel`) into one page. Side by side at
 * desktop widths — Messages left, Status stream right (issue #30: a
 * live-hardware user call overriding PRD §5's "stacked" choice) — using the
 * same `flex-[3]`/`flex-[2]` ratio each section already carried from the
 * original stacked layout, where it controlled vertical grow; reused
 * unchanged as the horizontal 3:2 split here because it checks out by eye
 * in row mode too — Messages still reads as the wider column against real
 * seeded message rows (4 columns + expanded field grids), Status still gets
 * enough room for its severity-tinted rows.
 *
 * Falls back to the original stacked layout below `min-[1100px]`, chosen by
 * loading real seeded MAVLink/STATUSTEXT content in a live browser at a
 * range of widths rather than guessing: the Messages table itself stays
 * readable down to ~950px of page width, but the Status stream's header row
 * (severity filter chips + Pause/Clear, no `flex-wrap`) starts clipping
 * past the edge of its column first, around ~1010-1018px total page width —
 * that's the actual binding constraint, not Messages. `min-[1100px]` keeps
 * roughly 90px of margin above that measured floor. No component test
 * covers the breakpoint itself — jsdom doesn't evaluate CSS media queries,
 * so this was checked visually instead (browser screenshots, not
 * committed).
 *
 * Both sections are independently scrollable so the page itself never
 * scrolls (G3: fills the viewport instead of one short list floating in a
 * tall empty page) — `min-h-0` (vertical) and `min-w-0` (horizontal, added
 * for the new row-mode axis) on each section's wrapper let them shrink to
 * their flex share instead of overflowing it, in both layouts.
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 min-[1100px]:flex-row">
        <MessagesTable inspector={inspector} offline={offline} />
        <StatusStream statustext={statustext} linkStats={linkStats} clearStatustext={clearStatustext} />
      </div>
    </div>
  )
}
