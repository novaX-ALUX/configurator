import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BATT_CAPACITY_FIELD, BATT_LOW_VOLT_FIELD, BATT_MONITOR_FIELD, type NumberFieldMeta } from './paramEnums'

interface BatteryMonitorProps {
  monitorValue: number | undefined
  onMonitorChange: (value: number, label: string) => void
  capacityValue: number | undefined
  onCapacityChange: (value: number, label: string) => void
  lowVoltValue: number | undefined
  onLowVoltChange: (value: number, label: string) => void
}

interface NumberFieldProps {
  field: NumberFieldMeta
  /** `BATT_CAPACITY` is an ArduPilot integer param; `BATT_LOW_VOLT` is a decimal one (task brief) — hardcoded per-field rather than read from the live `Param.type`, since a field with no cached value yet (not fetched) would otherwise have no type to consult. */
  integer: boolean
  value: number | undefined
  onChange: (value: number, label: string) => void
}

/**
 * One labeled number input (`BATT_CAPACITY`/`BATT_LOW_VOLT`), following
 * `ParamRow`'s own pattern: local text state so the user can type freely,
 * validated and staged on blur/Enter — never on every keystroke. Client-side
 * validation only (integer-ness, non-negative); `ParamStore.set()` still
 * does its own float32-exactness check as a final backstop.
 */
function NumberField({ field, integer, value, onChange }: NumberFieldProps) {
  const { t } = useTranslation()
  const [text, setText] = useState(value !== undefined ? String(value) : '')
  const [error, setError] = useState<string | undefined>(undefined)
  const focusedRef = useRef(false)

  useEffect(() => {
    if (focusedRef.current) return
    setText(value !== undefined ? String(value) : '')
    setError(undefined)
  }, [value])

  function commit(): void {
    const trimmed = text.trim()
    if (trimmed === '') {
      setError(t('params.errorNumber'))
      return
    }
    const parsed = Number(trimmed)
    // Number.isFinite also rejects NaN, so this one check covers both "not a
    // number" and "Infinity/-Infinity" — the latter would otherwise pass every
    // check below (it's not < 0, and integer fields' Number.isInteger(Infinity)
    // is false but BATT_LOW_VOLT isn't an integer field) and get staged as a
    // literal Infinity write.
    if (!Number.isFinite(parsed)) {
      setError(t('params.errorNumber'))
      return
    }
    if (integer && !Number.isInteger(parsed)) {
      setError(t('params.errorInteger'))
      return
    }
    if (field.min !== undefined && parsed < field.min) {
      setError(t('setup.errorNonNegative'))
      return
    }
    setError(undefined)
    onChange(parsed, `${parsed} ${field.unit}`)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-bold text-nvx-text">{t(field.titleKey)}</span>
      <span className="font-mono text-[10px] text-nvx-faint">{field.param}</span>
      <span className="flex items-center gap-2">
        <input
          aria-label={field.param}
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          value={text}
          onFocus={() => {
            focusedRef.current = true
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            focusedRef.current = false
            commit()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          className={`w-[110px] rounded-[9px] border bg-white px-2.5 py-[9px] font-mono text-[13px] focus:border-nvx-primary focus:shadow-[0_0_0_3px_rgba(43,92,230,.15)] ${
            error ? 'border-nvx-danger' : 'border-nvx-borderStrong'
          }`}
        />
        <span className="text-[12px] text-nvx-subtle">{t(`setup.battery.${field.id === 'battCapacity' ? 'capacity' : 'lowVolt'}.suffix`)}</span>
      </span>
      {error && (
        <span role="alert" className="text-[10.5px] text-nvx-danger">
          {error}
        </span>
      )}
    </div>
  )
}

/** BATTERY MONITOR card: `BATT_MONITOR` dropdown + `BATT_CAPACITY`/`BATT_LOW_VOLT` number fields, the design mock's 3-column layout. */
export function BatteryMonitor({
  monitorValue,
  onMonitorChange,
  capacityValue,
  onCapacityChange,
  lowVoltValue,
  onLowVoltChange,
}: BatteryMonitorProps) {
  const { t } = useTranslation()
  return (
    <section className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3.5 text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('setup.battery.sectionTitle')}</div>
      <div className="grid grid-cols-3 gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-bold text-nvx-text">{t(BATT_MONITOR_FIELD.titleKey)}</span>
          <span className="font-mono text-[10px] text-nvx-faint">{BATT_MONITOR_FIELD.param}</span>
          <select
            aria-label={BATT_MONITOR_FIELD.param}
            value={monitorValue ?? ''}
            onChange={(e) => {
              const v = Number(e.target.value)
              const opt = BATT_MONITOR_FIELD.options.find((o) => o.value === v)
              onMonitorChange(v, opt ? t(opt.labelKey) : String(v))
            }}
            className="cursor-pointer rounded-[9px] border border-nvx-borderStrong bg-white px-2.5 py-[9px] text-[12.5px] text-nvx-text"
          >
            {BATT_MONITOR_FIELD.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </div>
        <NumberField field={BATT_CAPACITY_FIELD} integer value={capacityValue} onChange={onCapacityChange} />
        <NumberField field={BATT_LOW_VOLT_FIELD} integer={false} value={lowVoltValue} onChange={onLowVoltChange} />
      </div>
    </section>
  )
}
