import { useTranslation } from 'react-i18next'
import type { ParamMetaEntry } from '../../core/paramMetadata'
import { isEnumValue } from '../params/paramUtils'
import { FLTMODE_CH_PARAM, FLTMODE_PARAMS, SIMPLE_PARAM, SLOT_PWM_LABELS, SUPER_SIMPLE_PARAM, slotBitEnabled, withSlotBit } from './flightModes'

interface FlightModesProps {
  valueOf: (param: string) => number | undefined
  metaOf: (param: string) => ParamMetaEntry | undefined
  onStage: (param: string, value: number, label: string) => void
  /** 0-based slot the transmitter switch currently selects (live RC), or null when unknown. */
  activeSlot: number | null
}

interface ModeSelectProps {
  param: string
  meta: ParamMetaEntry | undefined
  value: number | undefined
  onStage: (param: string, value: number, label: string) => void
}

/**
 * Enum dropdown fed entirely by the bundled metadata — `TuneKnobCard`'s
 * `isEnumValue` condition: options exist AND the effective value is one of
 * them. Anything else (metadata failed to load, or an out-of-spec board
 * value) degrades to a read-only raw value with a pointer to the Parameters
 * page — same honesty rule as Tuning's no-range rows, never a dropdown that
 * can't represent what the board actually has.
 */
function ModeSelect({ param, meta, value, onStage }: ModeSelectProps) {
  const { t } = useTranslation()
  const options = meta?.values
  const enumRenderable = options !== undefined && options.length > 0 && value !== undefined && isEnumValue(meta, value)

  if (!enumRenderable) {
    return (
      <span className="font-mono text-[12.5px] text-nvx-muted" title={t('setup.flightModes.noEnum')}>
        {value !== undefined ? value : '—'}
      </span>
    )
  }
  return (
    <select
      aria-label={param}
      value={value}
      onChange={(e) => {
        const v = Number(e.target.value)
        const opt = options.find((o) => o.value === v)
        onStage(param, v, opt?.label ?? String(v))
      }}
      className="w-full cursor-pointer rounded-[9px] border border-nvx-borderStrong bg-white px-2.5 py-[7px] text-[12.5px] text-nvx-text"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}

/**
 * FLIGHT MODES card (issue #37): FLTMODE1..6 slot assignments, the
 * FLTMODE_CH selector, and per-slot Simple / Super Simple toggles, all from
 * the bundled metadata (mode names are never hardcoded here). The row the
 * transmitter switch currently selects is highlighted live from the
 * Telemetry Snapshot's RC block. Assigning AutoTune to a slot is ordinary
 * bench-side configuration (ADR-0002); nothing here triggers or monitors it.
 */
export function FlightModes({ valueOf, metaOf, onStage, activeSlot }: FlightModesProps) {
  const { t } = useTranslation()
  const simpleMask = valueOf(SIMPLE_PARAM)
  const superSimpleMask = valueOf(SUPER_SIMPLE_PARAM)

  /** Chip label for a staged bitmask: the slot numbers it enables, e.g. "slots 1, 3" — a raw integer would mean nothing in the review bar. */
  function maskLabel(mask: number): string {
    const slots = FLTMODE_PARAMS.map((_, i) => i).filter((i) => slotBitEnabled(mask, i))
    return slots.length > 0 ? t('setup.flightModes.maskSlots', { slots: slots.map((i) => i + 1).join(', ') }) : t('setup.flightModes.maskNone')
  }

  function bitmaskToggle(param: string, mask: number | undefined, slotIndex: number, ariaLabel: string) {
    return (
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={slotBitEnabled(mask, slotIndex)}
        disabled={mask === undefined}
        onChange={(e) => {
          const next = withSlotBit(mask ?? 0, slotIndex, e.target.checked)
          onStage(param, next, maskLabel(next))
        }}
        className="h-[15px] w-[15px] cursor-pointer accent-nvx-primary disabled:cursor-not-allowed"
      />
    )
  }

  return (
    <section className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('setup.flightModes.sectionTitle')}</span>
        <span className="ml-auto text-[11.5px] text-nvx-faint">{t('setup.flightModes.sectionSubtitle')}</span>
      </div>

      <div className="grid grid-cols-[150px_minmax(0,1fr)_90px_110px] items-center gap-x-4 gap-y-1.5">
        <span />
        <span />
        <span className="text-center text-[10.5px] font-bold text-nvx-subtle">{t('setup.flightModes.simpleHeader')}</span>
        <span className="text-center text-[10.5px] font-bold text-nvx-subtle">{t('setup.flightModes.superSimpleHeader')}</span>

        {FLTMODE_PARAMS.map((param, i) => {
          const active = activeSlot === i
          return (
            <div
              key={param}
              data-slot={i + 1}
              className={`col-span-4 grid grid-cols-subgrid items-center rounded-[9px] border px-2 py-1.5 ${
                active ? 'border-nvx-primary bg-nvx-primary/5' : 'border-transparent'
              }`}
            >
              <div className="flex flex-col">
                <span className="text-[12.5px] font-bold text-nvx-text">
                  {t('setup.flightModes.slot', { n: i + 1 })}
                  {active && (
                    <span className="ml-1.5 rounded-full bg-nvx-primary px-1.5 py-px align-middle text-[9.5px] font-extrabold uppercase tracking-wide text-white">
                      {t('setup.flightModes.activeBadge')}
                    </span>
                  )}
                </span>
                <span className="font-mono text-[10px] text-nvx-faint">
                  {param} · {SLOT_PWM_LABELS[i]}
                </span>
              </div>
              <ModeSelect param={param} meta={metaOf(param)} value={valueOf(param)} onStage={onStage} />
              <div className="text-center">{bitmaskToggle(SIMPLE_PARAM, simpleMask, i, t('setup.flightModes.simpleFor', { n: i + 1 }))}</div>
              <div className="text-center">{bitmaskToggle(SUPER_SIMPLE_PARAM, superSimpleMask, i, t('setup.flightModes.superSimpleFor', { n: i + 1 }))}</div>
            </div>
          )
        })}
      </div>

      <div className="mt-3.5 flex items-center gap-4 border-t border-nvx-border pt-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-bold text-nvx-text">{t('setup.flightModes.channelTitle')}</span>
          <span className="font-mono text-[10px] text-nvx-faint">{FLTMODE_CH_PARAM}</span>
        </div>
        <div className="w-[180px]">
          <ModeSelect param={FLTMODE_CH_PARAM} meta={metaOf(FLTMODE_CH_PARAM)} value={valueOf(FLTMODE_CH_PARAM)} onStage={onStage} />
        </div>
        <span className="text-[11.5px] text-nvx-faint">{t('setup.flightModes.channelHint')}</span>
      </div>
    </section>
  )
}
