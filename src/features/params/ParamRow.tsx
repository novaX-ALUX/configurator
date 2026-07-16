import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Param } from '../../core/mavlink/params'
import type { ParamMetaEntry } from '../../core/paramMetadata'
import { isIntegerParamType, paramTypeLabel, wouldLosePrecision } from './paramUtils'

interface ParamRowProps {
  param: Param
  /** Staged edit for this param (from `ParamsPage`'s pending map), or `undefined` if untouched. */
  stagedValue: number | undefined
  onStage: (name: string, value: number) => void
  /**
   * Generated documentation for this param (`core/paramMetadata.ts`), or
   * `undefined` if metadata never loaded or this specific name has no exact
   * or pattern match — either way the row renders exactly as it did before
   * this field existed (PRD #12 §1.4/§2.1, issue #13's tracer bullet: purely
   * additive, no grouping/enum/default change).
   */
  meta?: ParamMetaEntry
}

/**
 * Single parameter row: mono-font name, editable value (Enter/blur stages
 * the edit — never writes directly, see `ParamsPage`/`DiffDrawer`), type
 * badge, and index. Client-side validation rejects non-integer input for
 * integer MAV_PARAM_TYPEs and float32-inexact integers before ever staging
 * an edit — `ParamStore.set()` would reject the latter anyway
 * (`ParamPrecisionLossError`), so catching it here means the diff drawer
 * never queues a write that's guaranteed to fail.
 */
export function ParamRow({ param, stagedValue, onStage, meta }: ParamRowProps) {
  const { t } = useTranslation()
  const displayValue = stagedValue ?? param.value
  const [text, setText] = useState(String(displayValue))
  const [error, setError] = useState<string | undefined>(undefined)
  const focusedRef = useRef(false)

  // Re-sync from the authoritative value (staged, or the live cache) whenever
  // it changes from outside this row — but never while the user is actively
  // typing, or every keystroke-driven re-render would clobber their input.
  useEffect(() => {
    if (focusedRef.current) return
    setText(String(displayValue))
    setError(undefined)
  }, [displayValue])

  const isInteger = isIntegerParamType(param.type)

  function commit(): void {
    const trimmed = text.trim()
    if (trimmed === '') {
      setError(t('params.errorNumber'))
      return
    }
    const parsed = Number(trimmed)
    if (Number.isNaN(parsed)) {
      setError(t('params.errorNumber'))
      return
    }
    if (isInteger && !Number.isInteger(parsed)) {
      setError(t('params.errorInteger'))
      return
    }
    if (wouldLosePrecision(param.type, parsed)) {
      setError(t('params.errorPrecision'))
      return
    }
    setError(undefined)
    onStage(param.name, parsed)
  }

  const pending = stagedValue !== undefined

  return (
    <div
      className={`grid grid-cols-[220px_140px_100px_70px] items-center gap-3 border-b border-nvx-border px-4 py-1.5 ${
        pending ? 'bg-nvx-warningSoft' : ''
      }`}
    >
      <div className="flex flex-col gap-0.5 py-1">
        <span className={`flex items-center gap-1.5 font-mono text-[12px] font-semibold ${pending ? 'text-nvx-warningText' : 'text-nvx-text'}`}>
          {pending && <span title={t('params.modifiedTitle')} className="h-1.5 w-1.5 flex-none rounded-full bg-nvx-warning" />}
          {param.name}
          {meta && <span className="truncate font-sans text-[11px] font-medium text-nvx-muted">{meta.displayName}</span>}
        </span>
        {meta && <span className="text-[10.5px] leading-snug text-nvx-faint">{meta.description}</span>}
      </div>
      <div className="flex flex-col gap-0.5">
        <input
          aria-label={param.name}
          type="number"
          step={isInteger ? 1 : 'any'}
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
          className={`w-[110px] rounded-[7px] border bg-white px-2 py-[5px] font-mono text-[12px] focus:border-nvx-primary focus:shadow-[0_0_0_3px_rgba(43,92,230,.15)] ${
            error ? 'border-nvx-danger' : 'border-nvx-borderStrong'
          }`}
        />
        {error && (
          <span role="alert" className="text-[10.5px] text-nvx-danger">
            {error}
          </span>
        )}
      </div>
      <span className="font-mono text-[11px] text-nvx-muted">{paramTypeLabel(param.type)}</span>
      <span className="font-mono text-[11px] text-nvx-faint">{param.index}</span>
    </div>
  )
}
