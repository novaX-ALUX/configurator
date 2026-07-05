import { useTranslation } from 'react-i18next'
import { ESC_PROTOCOL_FIELD } from './paramEnums'

interface EscProtocolProps {
  /** Effective (pending ?? board) `MOT_PWM_TYPE` value — `undefined` before it's known, in which case no chip is highlighted. */
  value: number | undefined
  onSelect: (value: number, label: string) => void
}

/** ESC PROTOCOL card: the design mock's chip row (`MOT_PWM_TYPE`). `label` handed to `onSelect` is the resolved i18n string, for the sticky bar's chip tooltip — never written anywhere. */
export function EscProtocol({ value, onSelect }: EscProtocolProps) {
  const { t } = useTranslation()
  return (
    <section className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t(ESC_PROTOCOL_FIELD.titleKey)}</span>
        <span className="ml-2.5 rounded-md bg-nvx-field px-2 py-[3px] font-mono text-[10px] text-nvx-faint">{ESC_PROTOCOL_FIELD.param}</span>
        <span className="ml-auto text-[11.5px] text-nvx-faint">{t('setup.esc.note')}</span>
      </div>
      <div className="flex flex-wrap gap-2.5">
        {ESC_PROTOCOL_FIELD.options.map((opt) => {
          const active = opt.value === value
          const label = t(opt.labelKey)
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(opt.value, label)}
              className={`rounded-[9px] border-[1.5px] px-4 py-[9px] text-[12.5px] font-bold hover:border-nvx-primary ${
                active ? 'border-nvx-primary bg-nvx-primarySoft text-nvx-primarySoftText' : 'border-nvx-borderStrong bg-white text-nvx-text'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
    </section>
  )
}
