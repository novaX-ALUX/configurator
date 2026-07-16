import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../store/connection'
import { useNavigationStore } from '../store/navigation'
import { useTelemetry } from '../features/dashboard/useTelemetry'
import { deriveStatusStrip, linkLossTier, type LinkLossTier, type PrearmStripState } from './telemetryStripUtils'

const DASH = '—'

const LOSS_CLASSES: Record<LinkLossTier, string> = {
  good: 'text-nvx-successText',
  degraded: 'text-nvx-warningText',
  bad: 'text-nvx-dangerHover',
}

/** Vertical hairline between strip items — same pattern as TopBar's own dividers. */
function Divider() {
  return <span className="h-4 w-px flex-none bg-nvx-border" aria-hidden="true" />
}

/**
 * Shared chip shell: fixed-height, tabular-numeral value, ≤200ms ease-out
 * color transition (motion discipline — issue #11's own acceptance
 * criteria: state chips may transition color/opacity, live numerics never
 * do, and `motion-reduce` drops it entirely).
 */
function Chip({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-bold tabular-nums transition-colors duration-200 ease-out motion-reduce:transition-none ${className}`}
    >
      {children}
    </span>
  )
}

/**
 * Deliberately duplicates (not shares) VehicleCard's armed/disarmed color
 * mapping: the strip's whole reason to exist is making ARMED "impossible to
 * miss" (issue #11's own acceptance criterion), so it uses a solid danger
 * fill here, one step more urgent than VehicleCard's soft pill — the same
 * semantic state, an intentionally different visual weight. A shared helper
 * would have to branch on that difference anyway, so this stays two small,
 * independently-readable chips rather than one with a "which caller are
 * you" parameter.
 */
function ArmChip({ armed }: { armed?: boolean }) {
  const { t } = useTranslation()
  if (armed === undefined) return <Chip className="bg-nvx-field text-nvx-faint">{DASH}</Chip>
  return armed ? (
    <Chip className="bg-nvx-danger text-white">
      <span className="h-[6px] w-[6px] flex-none rounded-full bg-white" />
      {t('dashboard.vehicle.armed').toUpperCase()}
    </Chip>
  ) : (
    <Chip className="bg-nvx-successSoft text-nvx-successText">{t('dashboard.vehicle.disarmed').toUpperCase()}</Chip>
  )
}

function ModeChip({ modeLabel }: { modeLabel?: string }) {
  return (
    <Chip className="bg-nvx-primarySoft font-mono text-nvx-primarySoftText">{modeLabel ?? DASH}</Chip>
  )
}

function PrearmChip({ prearm, onClick }: { prearm?: PrearmStripState; onClick: () => void }) {
  const { t } = useTranslation()

  if (prearm === undefined) {
    return <Chip className="bg-nvx-field text-nvx-faint">{DASH}</Chip>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={t('strip.statusView')}
      className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-bold tabular-nums transition-colors duration-200 ease-out hover:brightness-95 motion-reduce:transition-none ${
        prearm.ready ? 'bg-nvx-successSoft text-nvx-successText' : 'bg-nvx-warningSoft text-nvx-warningText'
      }`}
    >
      {prearm.ready ? t('strip.prearmReady') : t('strip.prearmNotReady', { count: prearm.count })}
    </button>
  )
}

/**
 * Battery/GPS both pair a primary value with an optional secondary one
 * (voltage+current, fix+satellite count) that can each independently be
 * present or absent. Rendering the secondary conditionally (mount/unmount)
 * would satisfy "no layout shift" for the primary value alone but violate it
 * the moment the secondary value's own presence flips — everything to its
 * right would jump. Both slots below are always mounted at a fixed width
 * instead, so nothing but the text inside them ever changes.
 */
function NumberSlot({ widthClass, value, align = 'left' }: { widthClass: string; value: string; align?: 'left' | 'right' }) {
  return <span className={`inline-block flex-none ${widthClass} ${align === 'right' ? 'text-right' : ''}`}>{value}</span>
}

/**
 * Global connected-state telemetry strip (issue #11, UI G2): exactly six
 * bench-relevant items — arm state / flight mode / PreArm / battery / GPS
 * fix / link health. No altitude/heading/climb (flight-side, ADR-0002) and
 * no CPU/temp bar (excluded by the same decision).
 *
 * Read-only consumer of the Telemetry Snapshot (plus the connection store's
 * STATUSTEXT log and link stats, same sources VehicleCard/StatusPanel
 * already read) — sends nothing, matches ADR-0002's named-operations-only
 * rule trivially since this component has no write path at all.
 *
 * Renders while `phase` is `'connected'` OR `'lost'` — 'lost' still has a
 * live session (router/telemetry aren't torn down, only a heartbeat timeout
 * — see `store/connection.ts`), and the strip's whole reason to exist is
 * making ARMED impossible to miss; hiding it the moment the link degrades
 * would defeat that at exactly the highest-risk moment. Telemetry freezes
 * its last real snapshot during 'lost' (`Telemetry`'s own documented
 * behavior), so every value shown is still real, just possibly stale —
 * `'disconnected'`/`'connecting'` are the only phases with no session to
 * read at all, and those hide it.
 */
export function TelemetryStrip() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const session = useConnectionStore((s) => s.session)
  const statustext = useConnectionStore((s) => s.statustext)
  const linkStats = useConnectionStore((s) => s.linkStats)
  const setActivePage = useNavigationStore((s) => s.setActivePage)
  const telemetry = useTelemetry(session)

  if (phase !== 'connected' && phase !== 'lost') return null

  const strip = deriveStatusStrip(telemetry, statustext, linkStats)
  const lossTier = strip.linkLossPct === undefined ? undefined : linkLossTier(strip.linkLossPct)

  return (
    <div
      aria-label={t('strip.ariaLabel')}
      className="col-span-2 row-start-3 flex h-9 items-center gap-3 border-b border-nvx-border bg-nvx-surface px-[18px]"
    >
      <ArmChip armed={strip.armed} />
      <ModeChip modeLabel={strip.modeLabel} />
      <Divider />
      <PrearmChip prearm={strip.prearm} onClick={() => setActivePage('debug')} />
      <Divider />
      <span data-testid="strip-battery" className="inline-flex items-baseline gap-1 font-mono text-[12px] tabular-nums text-nvx-text">
        <NumberSlot widthClass="w-[40px]" align="right" value={strip.voltage !== undefined ? strip.voltage.toFixed(2) : DASH} />
        <span className="text-[10px] text-nvx-faint">V</span>
        <NumberSlot
          widthClass="w-[38px] text-nvx-muted"
          value={strip.current !== undefined ? `${strip.current.toFixed(1)}A` : ''}
        />
      </span>
      <Divider />
      <span data-testid="strip-gps" className="inline-flex items-baseline gap-1 font-mono text-[12px] tabular-nums text-nvx-text">
        <NumberSlot widthClass="w-[44px]" value={strip.gpsFix !== undefined ? t(`dashboard.gps.fix.${strip.gpsFix}`) : DASH} />
        <NumberSlot widthClass="w-[20px] text-nvx-faint" align="right" value={strip.gpsSatellites !== undefined ? String(strip.gpsSatellites) : ''} />
      </span>
      <Divider />
      <NumberSlot
        widthClass={`w-[74px] font-mono text-[12px] ${lossTier ? LOSS_CLASSES[lossTier] : 'text-nvx-faint'}`}
        value={strip.linkLossPct !== undefined ? t('strip.linkLoss', { pct: strip.linkLossPct.toFixed(1) }) : DASH}
      />
    </div>
  )
}
