import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { useTelemetry } from './useTelemetry'
import { AttitudeIndicator } from './AttitudeIndicator'
import { VehicleCard } from './VehicleCard'
import { PowerCard } from './PowerCard'
import { GpsCard } from './GpsCard'
import { MotorOutputsCard } from './MotorOutputsCard'
import { RcChannelsCard } from './RcChannelsCard'

/** ArduPilot's FRAME_CLASS param — VehicleCard's own doc: DashboardPage resolves `frame` from this cached value, if any, rather than guessing. */
const FRAME_CLASS_PARAM = 'FRAME_CLASS'

/** ArduPilot always prefixes pre-arm-check STATUSTEXT with this literal (case varies by firmware version) — VehicleCard's own doc: only a real captured message is ever shown, never a fabricated "all checks passed". */
const PREARM_PREFIX = /^PreArm:/i

/**
 * Live telemetry view (read-only, no writes anywhere on this page — task
 * brief). Below `phase === 'connected'` this mirrors the empty states used by
 * ParamsPage/StatusPanel (Task 3.1/3.2); the connected layout follows the
 * design file's own 3-column grid (ATTITUDE / VEHICLE+POWER / GPS+MOTOR
 * OUTPUTS) plus a full-width RC CHANNELS row.
 */
export function DashboardPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const session = useConnectionStore((s) => s.session)
  const paramStore = useConnectionStore((s) => s.paramStore)
  const statustext = useConnectionStore((s) => s.statustext)

  // Renders whatever the throttled snapshot currently is — `null` (no
  // session yet, or one that's mid-teardown) is a real possibility even
  // while `phase` briefly still reads 'connected' (state updates don't all
  // land in the same tick), so every card below is passed `telemetry?.x`
  // rather than assuming a non-null snapshot.
  const telemetry = useTelemetry(session)

  if (phase !== 'connected') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        <div className="flex h-[74px] w-[74px] items-center justify-center rounded-[22px] border border-nvx-border bg-white text-nvx-faint shadow-card">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <circle cx="6.2" cy="6.2" r="2.45" />
            <circle cx="17.8" cy="6.2" r="2.45" />
            <circle cx="6.2" cy="17.8" r="2.45" />
            <circle cx="17.8" cy="17.8" r="2.45" />
            <path d="M8.1 8.1l7.8 7.8M15.9 8.1l-7.8 7.8" />
          </svg>
        </div>
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('dashboard.notConnectedTitle')}</div>
        <div className="max-w-[420px] text-center text-[13px] leading-relaxed text-nvx-muted">{t('dashboard.notConnectedBody')}</div>
        <button
          type="button"
          disabled={phase !== 'disconnected'}
          onClick={() => void connect(baud)}
          className="rounded-[10px] bg-nvx-primary px-[22px] py-2.5 text-[13px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('dashboard.connectCta')}
        </button>
        <div className="flex items-center gap-2 font-mono text-[11.5px] text-nvx-faint">
          <span>1</span>
          <span className="font-sans">{t('dashboard.hintStep1')}</span>
          <span className="text-nvx-borderStrong">→</span>
          <span>2</span>
          <span className="font-sans">{t('dashboard.hintStep2')}</span>
          <span className="text-nvx-borderStrong">→</span>
          <span>3</span>
          <span className="font-sans">{t('dashboard.hintStep3')}</span>
        </div>
      </div>
    )
  }

  const frameClassValue = paramStore?.get(FRAME_CLASS_PARAM)?.value
  const frame = frameClassValue !== undefined ? t('dashboard.vehicle.frameClass', { n: frameClassValue }) : undefined
  // Latest matching entry, not the first — an older PreArm complaint that's
  // since been superseded (or resolved, if ArduPilot ever announced that)
  // must not outrank whatever the board said most recently.
  const prearmText = [...statustext].reverse().find((e) => PREARM_PREFIX.test(e.text))?.text

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <div className="mb-3.5 flex items-baseline">
        <span className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.dashboard')}</span>
      </div>
      <div className="grid grid-cols-3 items-stretch gap-4">
        <AttitudeIndicator attitude={telemetry?.attitude} />
        <div className="grid grid-rows-2 gap-4">
          <VehicleCard heartbeat={telemetry?.heartbeat} frame={frame} prearmText={prearmText} />
          <PowerCard power={telemetry?.power} />
        </div>
        <div className="grid grid-rows-2 gap-4">
          <GpsCard gps={telemetry?.gps} />
          <MotorOutputsCard servo={telemetry?.servo} />
        </div>
      </div>
      <RcChannelsCard rc={telemetry?.rc} />
    </div>
  )
}
