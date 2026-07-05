import { useTranslation } from 'react-i18next'
import { FRAME_FIELD, type FrameTileOption } from './paramEnums'

interface FrameSelectorProps {
  /** Effective (pending ?? board) `FRAME_CLASS`/`FRAME_TYPE` values — `undefined` before either is known (not yet fetched), in which case no tile is highlighted. */
  frameClassValue: number | undefined
  frameTypeValue: number | undefined
  onSelect: (option: FrameTileOption) => void
}

/**
 * FRAME card: the design mock's 4-tile grid, each with a small motor-position
 * diagram (`FrameTileOption.motors`, Task 7.1). Selecting a tile must stage
 * BOTH `FRAME_CLASS` and `FRAME_TYPE` — the design mock's own bug (its tile
 * `onClick` only staged `FRAME_TYPE`) that `paramEnums.ts`'s module doc and
 * tests call out — so this only ever hands the *whole* option back to the
 * caller (`SetupPage` wires it to `setupStore.stageFrame`), never a single
 * value through a generic `onChange`.
 */
export function FrameSelector({ frameClassValue, frameTypeValue, onSelect }: FrameSelectorProps) {
  const { t } = useTranslation()
  return (
    <section className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t(FRAME_FIELD.titleKey)}</span>
        <span className="ml-2.5 rounded-md bg-nvx-field px-2 py-[3px] font-mono text-[10px] text-nvx-faint">
          {FRAME_FIELD.params.join(' · ')}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {FRAME_FIELD.options.map((opt) => {
          const active = opt.frameClass === frameClassValue && opt.frameType === frameTypeValue
          return (
            <button
              key={opt.labelKey}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(opt)}
              className={`flex flex-col items-center gap-2.5 rounded-xl border-[1.5px] p-3.5 hover:border-nvx-primary ${
                active ? 'border-nvx-primary bg-nvx-primarySoft' : 'border-nvx-border bg-white'
              }`}
            >
              <div className="relative h-[92px] w-[92px]">
                <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-[3px] bg-nvx-disabled" />
                {opt.motors.map((m, i) => (
                  <span
                    key={i}
                    style={{ left: `${m.x}%`, top: `${m.y}%` }}
                    className="absolute flex h-[26px] w-[26px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[1.5px] border-nvx-subtle bg-white font-mono text-[10.5px] font-semibold text-nvx-text"
                  >
                    {i + 1}
                  </span>
                ))}
              </div>
              <span className="font-mono text-[12px] font-semibold text-nvx-text">{t(opt.labelKey)}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
