import { useTranslation } from 'react-i18next'
import { DRONECAN_ESC_FIELD, ESC_PROTOCOL_FIELD } from './paramEnums'

interface EscProtocolProps {
  /** Effective (pending ?? board) `MOT_PWM_TYPE` value — `undefined` before it's known, in which case no PWM-family chip is highlighted. */
  value: number | undefined
  /** Derived DroneCAN state (`isDroneCanEscActive` over effective values). While true, DroneCAN wins the highlight and no PWM-family chip shows active even if `MOT_PWM_TYPE` matches one (issue #55). */
  droneCanActive: boolean
  onSelect: (value: number, label: string) => void
  /** DroneCAN chip click. Not a `MOT_PWM_TYPE` option — the page stages the CAN enable chain (or shows the frame-first prompt) instead of calling `onSelect`. */
  onSelectDroneCan: (label: string) => void
}

/** ESC PROTOCOL card: the design mock's chip row (`MOT_PWM_TYPE`) plus the derived DroneCAN chip (issue #55). `label` handed to the select callbacks is the resolved i18n string, for the sticky bar's chip tooltip — never written anywhere. */
export function EscProtocol({ value, droneCanActive, onSelect, onSelectDroneCan }: EscProtocolProps) {
  const { t } = useTranslation()
  const droneCanLabel = t(DRONECAN_ESC_FIELD.chipLabelKey)
  return (
    <section className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t(ESC_PROTOCOL_FIELD.titleKey)}</span>
        <span className="ml-2.5 rounded-md bg-nvx-field px-2 py-[3px] font-mono text-[10px] text-nvx-faint">{ESC_PROTOCOL_FIELD.param}</span>
        <span className="ml-auto text-[11.5px] text-nvx-faint">{t('setup.esc.note')}</span>
      </div>
      <div className="flex flex-wrap gap-2.5">
        {ESC_PROTOCOL_FIELD.options.map((opt) => {
          const active = !droneCanActive && opt.value === value
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
        <button
          type="button"
          aria-pressed={droneCanActive}
          onClick={() => onSelectDroneCan(droneCanLabel)}
          className={`rounded-[9px] border-[1.5px] px-4 py-[9px] text-[12.5px] font-bold hover:border-nvx-primary ${
            droneCanActive ? 'border-nvx-primary bg-nvx-primarySoft text-nvx-primarySoftText' : 'border-nvx-borderStrong bg-white text-nvx-text'
          }`}
        >
          {droneCanLabel}
        </button>
      </div>
    </section>
  )
}
