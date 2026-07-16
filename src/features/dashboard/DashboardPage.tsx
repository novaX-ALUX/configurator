import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { useTelemetry } from './useTelemetry'
import { AttitudeIndicator } from './AttitudeIndicator'
import { VehicleCard } from './VehicleCard'
import { PowerCard } from './PowerCard'
import { GpsCard } from './GpsCard'
import { MotorOutputsCard } from './MotorOutputsCard'
import { RcChannelsCard } from './RcChannelsCard'
import { PREARM_PREFIX } from './dashboardUtils'

/** ArduPilot's FRAME_CLASS param — VehicleCard's own doc: DashboardPage resolves `frame` from this cached value, if any, rather than guessing. */
const FRAME_CLASS_PARAM = 'FRAME_CLASS'

/**
 * Live telemetry view (read-only, no writes anywhere on this page — task
 * brief). UI G5 (issue #10): unlike the write-capable pages, this renders its
 * full layout even while disconnected — every card already has its own
 * no-data fallback (em-dash/zeroed), so the only thing offline needs to add
 * is an explicit "Offline" chip per Block so nothing pretends to be live
 * (see each card's own `offline` prop). The connected layout follows the
 * design file's own 3-column grid (ATTITUDE / VEHICLE+POWER / GPS+MOTOR
 * OUTPUTS) plus a full-width RC CHANNELS row.
 */
export function DashboardPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const session = useConnectionStore((s) => s.session)
  const paramStore = useConnectionStore((s) => s.paramStore)
  const statustext = useConnectionStore((s) => s.statustext)

  // Renders whatever the throttled snapshot currently is — `null` (no
  // session yet, or one that's mid-teardown) is a real possibility even
  // while `phase` briefly still reads 'connected' (state updates don't all
  // land in the same tick), so every card below is passed `telemetry?.x`
  // rather than assuming a non-null snapshot. It's also `null` for the whole
  // 'disconnected'/'connecting'/'lost' duration, which is exactly the state
  // each card's own no-data fallback already renders.
  const telemetry = useTelemetry(session)
  const offline = phase !== 'connected'

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
        <AttitudeIndicator attitude={telemetry?.attitude} offline={offline} />
        <div className="grid grid-rows-2 gap-4">
          <VehicleCard heartbeat={telemetry?.heartbeat} frame={frame} prearmText={prearmText} offline={offline} />
          <PowerCard power={telemetry?.power} offline={offline} />
        </div>
        <div className="grid grid-rows-2 gap-4">
          <GpsCard gps={telemetry?.gps} offline={offline} />
          <MotorOutputsCard servo={telemetry?.servo} offline={offline} />
        </div>
      </div>
      <RcChannelsCard rc={telemetry?.rc} offline={offline} />
    </div>
  )
}
