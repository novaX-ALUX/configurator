import { useTranslation } from 'react-i18next'
import type { TelemetryState } from '../../core/mavlink/telemetry'
import { pctFromUs } from './dashboardUtils'

/** SERVO_OUTPUT_RAW carries 16 output slots; this shows the first 8 — enough for any common multirotor frame (quad through octo), with unused channels just reading idle/gray. */
const MOTOR_COUNT = 8

interface MotorOutputsCardProps {
  servo?: TelemetryState['servo']
}

export function MotorOutputsCard({ servo }: MotorOutputsCardProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col rounded-xl border border-nvx-border bg-white p-4 shadow-card">
      <div className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('dashboard.motors.title')}</div>
      {!servo ? (
        <p className="mt-2.5 text-[12px] text-nvx-faint">{t('dashboard.motors.noData')}</p>
      ) : (
        <div className="mt-3 flex h-16 items-end justify-around gap-2.5">
          {Array.from({ length: MOTOR_COUNT }, (_, i) => {
            const raw = servo.outputs[i] ?? 0
            const pct = pctFromUs(raw)
            const idle = pct <= 0
            return (
              <div key={i} className="flex h-full flex-col items-center gap-1">
                <div className="relative w-[26px] flex-1 overflow-hidden rounded-md bg-nvx-field">
                  <div
                    className={`absolute inset-x-0 bottom-0 rounded-md ${idle ? 'bg-nvx-disabled' : 'bg-nvx-primary'}`}
                    style={{ height: `${idle ? 0 : Math.max(pct, 3)}%` }}
                  />
                </div>
                <span className="font-mono text-[10.5px] text-nvx-subtle">{t('dashboard.motors.label', { n: i + 1 })}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
