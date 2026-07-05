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

/**
 * `FS_THR_ENABLE=2` and `FS_GCS_ENABLE=2` ("Continue in Auto, else RTL") were
 * removed in ArduPilot 4.0+ (Task 7.1 review finding) — still offered here
 * since they're valid on older firmware, but flagged with a subtle legacy
 * suffix rather than silently presenting them as equally current options.
 */
const LEGACY_VALUE = 2

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
            {opt.value === LEGACY_VALUE ? ` — ${t('setup.failsafes.legacyBadge')}` : ''}
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
