import { useTranslation } from 'react-i18next'
import { FRAME_FIELD, type FrameTileOption } from '../setup/paramEnums'

interface MotorLayoutProps {
  frameOption: FrameTileOption
  /** motorSeq (1-based) -> current slider percent. A motor with `percent > 0` is highlighted as spinning. */
  percents: Record<number, number>
}

/** Frame diagram (design mock's Motor Layout card) -- numbers are ArduPilot outputs (1-based, matching `FrameTileOption.motors`' own index+1 convention, see `paramEnums.ts`), not necessarily physical wiring order (that's exactly what `ManualMapGuide` helps the user verify). */
export function MotorLayout({ frameOption, percents }: MotorLayoutProps) {
  const { t } = useTranslation()

  return (
    <section className="rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('motors.layout.title')}</span>
        <span className="ml-auto rounded-md bg-nvx-field px-2 py-[3px] font-mono text-[10.5px] text-nvx-faint">
          {FRAME_FIELD.params.join(' · ')}
        </span>
      </div>
      <div className="flex justify-center py-1.5">
        <div className="relative h-[240px] w-[240px]">
          <div className="absolute left-1/2 top-1/2 h-[210px] w-[2px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-nvx-border" />
          <div className="absolute left-1/2 top-1/2 h-[210px] w-[2px] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-nvx-border" />
          <div className="absolute left-1/2 top-1/2 flex h-[34px] w-[34px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[10px] border-[1.5px] border-nvx-borderStrong bg-nvx-bg">
            <span className="h-[9px] w-[9px] rounded-[3px] bg-nvx-primary" />
          </div>
          <div className="absolute left-1/2 top-1.5 -translate-x-1/2 font-mono text-[9.5px] tracking-[.1em] text-nvx-disabled">FRONT ↑</div>
          {frameOption.motors.map((m, i) => {
            const num = i + 1
            const pct = percents[num] ?? 0
            const active = pct > 0
            return (
              <div
                key={num}
                style={{ left: `${m.x}%`, top: `${m.y}%` }}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-[3px]"
              >
                <span
                  className={`flex h-[46px] w-[46px] items-center justify-center rounded-full border-2 font-mono text-[15px] font-bold shadow-card ${
                    active ? 'border-nvx-danger bg-nvx-danger text-white' : 'border-nvx-borderStrong bg-white text-nvx-text'
                  }`}
                >
                  {num}
                </span>
                <span className="font-mono text-[9.5px] text-nvx-faint">{pct}%</span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="text-center text-[11.5px] text-nvx-faint">{t('motors.layout.caption')}</div>
    </section>
  )
}
