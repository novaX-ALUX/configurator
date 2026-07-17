import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParamMetaEntry } from '../../core/paramMetadata'
import { isEnumValue } from '../params/paramUtils'
import { cleanParamValue, TUNE_PARAM, TUNE_RANGE_PARAMS } from './tuningFields'

interface TuneKnobCardProps {
  /** Effective value (pending overlay ?? ParamStore cache), same contract as `TuningSlider`. */
  valueOf: (param: string) => number | undefined
  metaOf: (param: string) => ParamMetaEntry | undefined
  staged: (param: string) => boolean
  onStage: (param: string, value: number, label: string) => void
}

interface TuneNumberFieldProps {
  param: string
  meta: ParamMetaEntry | undefined
  value: number | undefined
  staged: boolean
  onStage: (param: string, value: number, label: string) => void
}

/**
 * TUNE_MIN / TUNE_MAX numeric input — these two carry no documented range
 * in the bundled metadata (their span is whatever the tuned parameter
 * needs), so they get a free-typed number field instead of a slider:
 * `BatteryMonitor.NumberField`'s local-text/commit-on-blur-or-Enter
 * pattern, staging only when the parsed value actually differs (the same
 * "release without a change stages nothing" rule the sliders follow).
 */
function TuneNumberField({ param, meta, value, staged, onStage }: TuneNumberFieldProps) {
  const { t } = useTranslation()
  const [text, setText] = useState(value !== undefined ? String(cleanParamValue(value)) : '')
  const [error, setError] = useState(false)
  const focusedRef = useRef(false)

  useEffect(() => {
    if (focusedRef.current) return
    setText(value !== undefined ? String(cleanParamValue(value)) : '')
    setError(false)
  }, [value])

  function commit(): void {
    const parsed = Number(text.trim())
    if (text.trim() === '' || !Number.isFinite(parsed)) {
      setError(true)
      return
    }
    setError(false)
    if (parsed !== value) onStage(param, parsed, meta?.displayName ?? param)
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[12px] font-semibold text-nvx-text" title={meta?.description}>
        {meta?.displayName ?? param}
      </span>
      <input
        aria-label={param}
        type="text"
        inputMode="decimal"
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
        className={`w-[110px] rounded-[9px] border bg-white px-2.5 py-[7px] font-mono text-[13px] focus:border-nvx-primary focus:shadow-[0_0_0_3px_rgba(43,92,230,.15)] ${
          error ? 'border-nvx-danger' : staged ? 'border-nvx-warningBorder' : 'border-nvx-borderStrong'
        }`}
      />
      <span className="font-mono text-[10px] text-nvx-faint">{param}</span>
      {error && (
        <span role="alert" className="text-[10.5px] text-nvx-danger">
          {t('params.errorNumber')}
        </span>
      )}
    </div>
  )
}

/**
 * Transmitter tuning knob card (issue #36, PRD #32 story 10): which
 * parameter the radio's channel-6 knob tunes (`TUNE`, enum options straight
 * from the bundled metadata) and the value span it sweeps
 * (`TUNE_MIN`/`TUNE_MAX`). Bench-side configuration only per ADR-0002 —
 * the knob itself acts in flight, on the radio, not through this tool. All
 * three fields stage through the page's Review Gate like every slider.
 *
 * The `TUNE` dropdown renders only under `ParamRow`'s `isEnumValue`
 * condition: metadata options exist AND the effective value is one of them.
 * An out-of-spec board value (firmware drift, deprecated option) falls back
 * to the numeric field — never hidden behind a dropdown that can't
 * represent it.
 */
export function TuneKnobCard({ valueOf, metaOf, staged, onStage }: TuneKnobCardProps) {
  const { t } = useTranslation()
  const meta = metaOf(TUNE_PARAM)
  const value = valueOf(TUNE_PARAM)
  const options = meta?.values
  const enumRenderable = options !== undefined && options.length > 0 && value !== undefined && isEnumValue(meta, value)

  return (
    <section className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-1 text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('tuning.tune.title')}</div>
      <div className="mb-3.5 text-[12px] text-nvx-muted">{t('tuning.tune.subtitle')}</div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        {enumRenderable ? (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-[12px] font-semibold text-nvx-text" title={meta?.description}>
              {meta?.displayName ?? TUNE_PARAM}
            </span>
            <select
              aria-label={TUNE_PARAM}
              value={value}
              onChange={(e) => {
                const v = Number(e.target.value)
                const opt = options.find((o) => o.value === v)
                onStage(TUNE_PARAM, v, opt?.label ?? String(v))
              }}
              className={`cursor-pointer rounded-[9px] border bg-white px-2.5 py-[7px] text-[12.5px] text-nvx-text ${
                staged(TUNE_PARAM) ? 'border-nvx-warningBorder' : 'border-nvx-borderStrong'
              }`}
            >
              {options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span className="font-mono text-[10px] text-nvx-faint">{TUNE_PARAM}</span>
          </div>
        ) : (
          <TuneNumberField param={TUNE_PARAM} meta={meta} value={value} staged={staged(TUNE_PARAM)} onStage={onStage} />
        )}
        {TUNE_RANGE_PARAMS.map((param) => (
          <TuneNumberField key={param} param={param} meta={metaOf(param)} value={valueOf(param)} staged={staged(param)} onStage={onStage} />
        ))}
      </div>
    </section>
  )
}
