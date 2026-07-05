import { useTranslation } from 'react-i18next'
import { BATT_FS_LOW_FIELD, type EnumFieldMeta, FS_GCS_FIELD, FS_THROTTLE_FIELD } from './paramEnums'

interface FailsafesProps {
  throttleValue: number | undefined
  onThrottleChange: (value: number, label: string) => void
  battLowValue: number | undefined
  onBattLowChange: (value: number, label: string) => void
  gcsValue: number | undefined
  onGcsChange: (value: number, label: string) => void
}

interface FailsafeSelectProps {
  field: EnumFieldMeta
  value: number | undefined
  onChange: (value: number, label: string) => void
}

function FailsafeSelect({ field, value, onChange }: FailsafeSelectProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-bold text-nvx-text">{t(field.titleKey)}</span>
      <span className="font-mono text-[10px] text-nvx-faint">{field.param}</span>
      <select
        aria-label={field.param}
        value={value ?? ''}
        onChange={(e) => {
          const v = Number(e.target.value)
          const opt = field.options.find((o) => o.value === v)
          onChange(v, opt ? t(opt.labelKey) : String(v))
        }}
        className="cursor-pointer rounded-[9px] border border-nvx-borderStrong bg-white px-2.5 py-[9px] text-[12.5px] text-nvx-text"
      >
        {field.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {t(opt.labelKey)}
            {/* `legacy` lives on the option itself (paramEnums.ts), not a raw
                value match here -- e.g. BATT_FS_LOW_ACT=2 ("RTL") is a
                current, valid option, unlike FS_THR_ENABLE/FS_GCS_ENABLE=2
                ("Continue in Auto", removed in ArduPilot 4.0+, Task 7.1
                review finding), even though all three share the number 2. */}
            {opt.legacy ? ` — ${t('setup.failsafes.legacyBadge')}` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

/** FAILSAFES card: `FS_THR_ENABLE`/`BATT_FS_LOW_ACT`/`FS_GCS_ENABLE`, the design mock's 3-column layout. */
export function Failsafes({ throttleValue, onThrottleChange, battLowValue, onBattLowChange, gcsValue, onGcsChange }: FailsafesProps) {
  const { t } = useTranslation()
  return (
    <section className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('setup.failsafes.sectionTitle')}</span>
        <span className="ml-auto text-[11.5px] text-nvx-faint">{t('setup.failsafes.sectionSubtitle')}</span>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <FailsafeSelect field={FS_THROTTLE_FIELD} value={throttleValue} onChange={onThrottleChange} />
        <FailsafeSelect field={BATT_FS_LOW_FIELD} value={battLowValue} onChange={onBattLowChange} />
        <FailsafeSelect field={FS_GCS_FIELD} value={gcsValue} onChange={onGcsChange} />
      </div>
    </section>
  )
}
