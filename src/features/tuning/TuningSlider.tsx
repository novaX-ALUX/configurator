import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParamMetaEntry } from '../../core/paramMetadata'
import { rangeUnitsCaption } from '../params/paramUtils'
import { cleanParamValue, sliderStep } from './tuningFields'

interface TuningSliderProps {
  param: string
  meta: ParamMetaEntry | undefined
  /** Effective value (pending overlay ?? ParamStore cache) — `undefined` until the board value is known. */
  value: number | undefined
  /** True when this param has a pending Staged Change — tints the value readout so overlayed values are visibly not board truth. */
  staged: boolean
  onCommit: (value: number, label: string) => void
}

/**
 * One Extended Tuning slider row (issue #35). Review Gate mechanics
 * (ADR-0003): while dragging, the thumb position is component-local state
 * only — release (pointer up / key up / blur) is the single point that
 * calls `onCommit`, which stages; nothing here ever writes. Range, step and
 * units all come from the bundled metadata; without a documented range
 * there is no slider, only the current value read-only.
 */
export function TuningSlider({ param, meta, value, staged, onCommit }: TuningSliderProps) {
  const { t } = useTranslation()
  const [drag, setDrag] = useState<number | null>(null)
  const range = meta?.range
  const shown = drag ?? value

  function commit() {
    if (drag === null) return
    if (drag !== value) onCommit(drag, meta?.displayName ?? param)
    setDrag(null)
  }

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-[12px] font-semibold text-nvx-text" title={meta?.description}>
          {meta?.displayName ?? param}
        </span>
        <span
          className={`ml-auto flex-none font-mono text-[12px] ${staged ? 'font-bold text-nvx-warningText' : 'text-nvx-text'}`}
        >
          {shown !== undefined ? cleanParamValue(shown) : '—'}
          {meta?.units !== undefined && <span className="ml-1 text-nvx-faint">{meta.units}</span>}
        </span>
      </div>
      {range && shown !== undefined ? (
        <input
          type="range"
          className="nvx w-full"
          min={range[0]}
          max={range[1]}
          step={sliderStep(range, meta.increment)}
          value={Math.min(range[1], Math.max(range[0], shown))}
          aria-label={param}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      ) : (
        <div className="py-1 text-[11px] text-nvx-faint">{t('tuning.noRange')}</div>
      )}
      <div className="flex items-baseline justify-between font-mono text-[10px] text-nvx-faint">
        <span>{param}</span>
        {range && <span>{rangeUnitsCaption(meta)}</span>}
      </div>
    </div>
  )
}
