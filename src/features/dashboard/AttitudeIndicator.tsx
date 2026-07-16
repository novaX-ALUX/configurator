import { useTranslation } from 'react-i18next'
import type { TelemetryState } from '../../core/mavlink/telemetry'
import { OfflineChip } from '../../layout/OfflineChip'
import { formatSignedDeg, normalizeHeadingDeg } from './dashboardUtils'

/** px-per-degree factors match the design file's own `pitchPx`/`tapeShift` formulas (`docs/design/novaX-Configurator.dc.html`). */
const PITCH_PX_PER_DEG = 1.9
const HEADING_TAPE_PX_PER_DEG = 1.6

interface AttitudeIndicatorProps {
  attitude?: TelemetryState['attitude']
  /** UI G5 (issue #10): renders an explicit "Offline" chip instead of pretending the level/0° fallback below is live data. */
  offline?: boolean
}

/**
 * 2D artificial horizon (3D was cut per the M2 plan): a sky/ground gradient
 * translated by pitch and rotated by roll inside a fixed circular bezel,
 * with a static aircraft symbol + bank-angle triangle drawn on top via SVG,
 * plus a scrolling heading tape. Renders level (0/0) with "—" readouts
 * before the first ATTITUDE message ever arrives.
 */
export function AttitudeIndicator({ attitude, offline = false }: AttitudeIndicatorProps) {
  const { t } = useTranslation()
  const rollDeg = attitude?.rollDeg ?? 0
  const pitchDeg = attitude?.pitchDeg ?? 0
  const headingDeg = attitude ? normalizeHeadingDeg(attitude.yawDeg) : undefined

  return (
    <div className="rounded-xl border border-nvx-border bg-white p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('dashboard.attitude.title')}</span>
        <OfflineChip active={offline} label={t('dashboard.offline')} />
      </div>
      <div className="flex justify-center">
        <div className="relative h-[240px] w-[240px] overflow-hidden rounded-full shadow-[inset_0_0_0_5px_#272C34,0_0_0_1px_#E3E8EF,inset_0_6px_14px_rgba(0,0,0,.28)]">
          <div
            className="absolute -left-[60px] -top-[60px] h-[360px] w-[360px]"
            style={{ transform: `translateY(${pitchDeg * PITCH_PX_PER_DEG}px) rotate(${rollDeg}deg)` }}
          >
            <div className="absolute inset-0 bg-[linear-gradient(180deg,#4E8FD0_0%,#8FBDE8_49.7%,#F4F6F8_49.7%,#F4F6F8_50.3%,#9C7048_50.3%,#6B4526_100%)]" />
            <div className="absolute left-1/2 top-[calc(50%-44px)] -ml-[42px] h-[2px] w-[84px] rounded-sm bg-white/90" />
            <div className="absolute left-1/2 top-[calc(50%-22px)] -ml-[28px] h-[2px] w-[56px] rounded-sm bg-white/90" />
            <div className="absolute left-1/2 top-[calc(50%+22px)] -ml-[28px] h-[2px] w-[56px] rounded-sm bg-white/85" />
            <div className="absolute left-1/2 top-[calc(50%+44px)] -ml-[42px] h-[2px] w-[84px] rounded-sm bg-white/85" />
          </div>
          <div className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_50%_26%,rgba(255,255,255,.16),rgba(255,255,255,0)_55%)]" />
          <svg width="240" height="240" viewBox="0 0 240 240" fill="none" className="pointer-events-none absolute inset-0">
            <g stroke="rgba(255,255,255,.9)" strokeWidth="2" strokeLinecap="round">
              <path d="M120 8v12" />
              <path d="M139.4 9.7l-2 11.8M100.6 9.7l2 11.8" />
              <path d="M158.3 14.8l-4.1 11.2M81.7 14.8l4.1 11.2" />
              <path d="M176 23l-6 10.4M64 23l6 10.4" />
              <path d="M199.2 40.8l-8.5 8.5M40.8 40.8l8.5 8.5" />
              <path d="M217 64l-10.4 6M23 64l10.4 6" />
            </g>
            <path d="M120 26l-6-11h12z" fill="#FFFFFF" />
            <g transform={`rotate(${rollDeg} 120 120)`}>
              <path d="M120 28l-7 12h14z" fill="#F6A821" />
            </g>
          </svg>
          <div className="absolute left-9 top-1/2 h-[5px] w-[50px] -translate-y-1/2 rounded-[3px] bg-[#F6A821] shadow-[0_1px_2px_rgba(0,0,0,.35)]" />
          <div className="absolute right-9 top-1/2 h-[5px] w-[50px] -translate-y-1/2 rounded-[3px] bg-[#F6A821] shadow-[0_1px_2px_rgba(0,0,0,.35)]" />
          <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#F6A821] shadow-[0_1px_2px_rgba(0,0,0,.35)]" />
        </div>
      </div>
      <div className="mt-3 flex justify-center gap-5 font-mono text-[12px] text-nvx-subtle">
        <span>
          {t('dashboard.attitude.roll')} <b className="font-semibold text-nvx-text">{attitude ? formatSignedDeg(attitude.rollDeg) : '—'}</b>
        </span>
        <span>
          {t('dashboard.attitude.pitch')} <b className="font-semibold text-nvx-text">{attitude ? formatSignedDeg(attitude.pitchDeg) : '—'}</b>
        </span>
      </div>
      <div className="relative mt-2.5 h-[30px] overflow-hidden rounded-lg bg-nvx-field">
        <div
          className="absolute inset-0 bg-[repeating-linear-gradient(90deg,rgba(23,26,32,.22)_0_1px,transparent_1px_13px)]"
          style={{ backgroundPositionX: attitude ? `${-attitude.yawDeg * HEADING_TAPE_PX_PER_DEG}px` : '0px' }}
        />
        <span className="absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-nvx-faint">{t('dashboard.attitude.hdg')}</span>
        <span className="absolute left-1/2 top-0 h-1.5 w-0.5 -translate-x-1/2 bg-nvx-primary" />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md border border-nvx-border bg-white px-2.5 py-0.5 font-mono text-[13px] font-semibold text-nvx-text">
          {headingDeg !== undefined ? `${Math.round(headingDeg)}°` : '—'}
        </span>
      </div>
    </div>
  )
}
