import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParamMetaEntry } from '../../core/paramMetadata'
import type { StagedEntry } from '../staged/stagedStore'
import { computeInitialTune, type Chemistry } from './initialTune'
import { cleanParamValue } from './tuningFields'

const CHEMISTRY_OPTIONS: readonly { value: Chemistry; labelKey: string }[] = [
  { value: 'lipo', labelKey: 'tuning.calc.chemLipo' },
  { value: 'lipohv', labelKey: 'tuning.calc.chemLipoHV' },
  { value: 'liion', labelKey: 'tuning.calc.chemLiIon' },
]

interface InitialTuneCalculatorProps {
  /** Board-cached value for the "current" comparison column — deliberately NOT the staged overlay: the column answers "what is on the vehicle now". */
  currentOf: (param: string) => number | undefined
  metaOf: (param: string) => ParamMetaEntry | undefined
  /** Stages every still-selected suggestion row — the page passes `stageMany`, so calculator output enters the same Staged Changes set as slider edits (PRD #32 story 9). */
  onStage: (entries: StagedEntry[]) => void
}

/**
 * Initial-tune calculator card (issue #35): prop / cells / chemistry in,
 * `computeInitialTune` suggestions out, shown as a current → suggested
 * comparison table with per-row deselection before anything is staged
 * (PRD #32 story 8). Calculate only fills the table; Stage hands the
 * selected rows to the page's staged store — the Review Gate's Apply is
 * still the only write path (ADR-0003).
 */
export function InitialTuneCalculator({ currentOf, metaOf, onStage }: InitialTuneCalculatorProps) {
  const { t } = useTranslation()
  const [propText, setPropText] = useState('9')
  const [cellsText, setCellsText] = useState('4')
  const [chemistry, setChemistry] = useState<Chemistry>('lipo')
  const [result, setResult] = useState<Record<string, number> | null>(null)
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  const [inputError, setInputError] = useState(false)

  function handleCalculate(): void {
    const prop = Number(propText)
    const cells = Number(cellsText)
    // Same domain S2 enforces (note "Inputs"): prop > 0, whole cells >= 1.
    if (!Number.isFinite(prop) || prop <= 0 || !Number.isInteger(cells) || cells < 1) {
      setInputError(true)
      setResult(null)
      return
    }
    setInputError(false)
    const suggested = computeInitialTune({ prop, cells, chemistry })
    // Clean float64 formula residue (e.g. `(cells − 1)·0.1` → 14.700000000000001)
    // once here, so the table, the staged chip and the wire all carry 14.7.
    setResult(Object.fromEntries(Object.entries(suggested).map(([param, value]) => [param, cleanParamValue(value)])))
    setExcluded(new Set())
  }

  function toggleRow(param: string): void {
    const next = new Set(excluded)
    if (!next.delete(param)) next.add(param)
    setExcluded(next)
  }

  const rows = result ? Object.entries(result) : []
  const selected = rows.filter(([param]) => !excluded.has(param))

  return (
    <section className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-1 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('tuning.calc.title')}</span>
        <span className="ml-auto text-[11.5px] text-nvx-faint">{t('tuning.calc.sourceNote')}</span>
      </div>
      <div className="mb-3.5 text-[12px] text-nvx-muted">{t('tuning.calc.subtitle')}</div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-nvx-subtle">
          {t('tuning.calc.prop')}
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={propText}
            onChange={(e) => setPropText(e.target.value)}
            className="w-[110px] rounded-[9px] border border-nvx-borderStrong bg-white px-3 py-2 font-mono text-[13px] text-nvx-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-nvx-subtle">
          {t('tuning.calc.cells')}
          <input
            type="number"
            min={1}
            step={1}
            value={cellsText}
            onChange={(e) => setCellsText(e.target.value)}
            className="w-[110px] rounded-[9px] border border-nvx-borderStrong bg-white px-3 py-2 font-mono text-[13px] text-nvx-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-nvx-subtle">
          {t('tuning.calc.chemistry')}
          <select
            value={chemistry}
            onChange={(e) => setChemistry(e.target.value as Chemistry)}
            className="rounded-[9px] border border-nvx-borderStrong bg-white px-3 py-2 text-[13px] text-nvx-text"
          >
            {CHEMISTRY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={handleCalculate}
          className="rounded-[9px] bg-nvx-primary px-4 py-2 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover"
        >
          {t('tuning.calc.calculate')}
        </button>
      </div>

      {inputError && (
        <div role="alert" className="mt-2.5 text-[12px] text-nvx-danger">
          {t('tuning.calc.invalidInput')}
        </div>
      )}

      {result && (
        <>
          <table className="mt-3.5 w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-nvx-border text-left text-[10.5px] font-extrabold tracking-[.1em] text-nvx-subtle">
                <th className="w-8 py-1.5" aria-label={t('tuning.calc.colInclude')} />
                <th className="py-1.5">{t('tuning.calc.colParam')}</th>
                <th className="py-1.5 text-right">{t('tuning.calc.colCurrent')}</th>
                <th className="py-1.5 text-right">{t('tuning.calc.colSuggested')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([param, suggested]) => {
                const current = currentOf(param)
                const meta = metaOf(param)
                const included = !excluded.has(param)
                return (
                  <tr key={param} className={`border-b border-nvx-border ${included ? '' : 'opacity-45'}`}>
                    <td className="py-1.5">
                      <input type="checkbox" checked={included} aria-label={param} onChange={() => toggleRow(param)} />
                    </td>
                    <td className="py-1.5">
                      <span className="font-mono text-nvx-text">{param}</span>
                      {meta?.displayName !== undefined && <span className="ml-2 text-nvx-faint">{meta.displayName}</span>}
                    </td>
                    <td className="py-1.5 text-right font-mono text-nvx-muted">{current !== undefined ? cleanParamValue(current) : '—'}</td>
                    <td className="py-1.5 text-right font-mono font-bold text-nvx-text">
                      {suggested}
                      {meta?.units !== undefined && <span className="ml-1 font-normal text-nvx-faint">{meta.units}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="mt-3 flex items-center">
            <span className="text-[11.5px] text-nvx-faint">{t('tuning.calc.stagedHint')}</span>
            <button
              type="button"
              disabled={selected.length === 0}
              onClick={() => onStage(selected.map(([param, value]) => ({ param, value, label: metaOf(param)?.displayName ?? param })))}
              className="ml-auto rounded-[9px] bg-nvx-primary px-4 py-2 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('tuning.calc.stageSelected', { count: selected.length })}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
