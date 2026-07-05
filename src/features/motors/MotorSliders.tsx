import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SafetyState } from './motorSafety'
import { MOTOR_TEST_MAX_PERCENT } from './motorTest'

/** Sequence test throttle -- design mock's own "Sequence M1→M4 @ 12%". */
const SEQUENCE_PERCENT = 12
const SEQUENCE_STEP_MS = 900
/** µs readout formula, per the design mock (`docs/design/novaX-Configurator.dc.html`'s `ms.us`): a purely illustrative PWM-ish readout, not read back from `SERVO_OUTPUT_RAW`. */
const US_BASE = 1000
const US_PER_PERCENT = 10

interface MotorSlidersProps {
  motorCount: number
  /** motorSeq (1-based) -> current percent. */
  percents: Record<number, number>
  state: SafetyState
  onSetPercent: (motorSeq: number, percent: number) => void
}

/**
 * Per-motor 0-30% sliders plus the "Sequence M1→Mn @ 12%" button -- both
 * disabled unless `state` is 'ready' or 'testing' (the safety gate must be
 * armed first). Every slider move (and the sequence loop) goes through
 * `onSetPercent` -- `useMotorTestStore`'s own `setMotorPercent`, which is
 * what actually drives `MotorSafety.noteActivity()`/`setSpinning()`; this
 * component never talks to the flight controller directly.
 */
export function MotorSliders({ motorCount, percents, state, onSetPercent }: MotorSlidersProps) {
  const { t } = useTranslation()
  const disabled = state !== 'ready' && state !== 'testing'
  const [seqRunning, setSeqRunning] = useState(false)
  const seqTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (seqTimer.current) clearInterval(seqTimer.current)
    },
    [],
  )

  function runSequence(): void {
    if (disabled || seqRunning) return
    setSeqRunning(true)
    let motor = 1
    onSetPercent(motor, SEQUENCE_PERCENT)
    seqTimer.current = setInterval(() => {
      onSetPercent(motor, 0)
      motor++
      if (motor > motorCount) {
        if (seqTimer.current) clearInterval(seqTimer.current)
        seqTimer.current = null
        setSeqRunning(false)
        return
      }
      onSetPercent(motor, SEQUENCE_PERCENT)
    }, SEQUENCE_STEP_MS)
  }

  const motors = Array.from({ length: motorCount }, (_, i) => i + 1)

  return (
    <section className="rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('motors.sliders.title')}</span>
        <button
          type="button"
          disabled={disabled || seqRunning}
          onClick={runSequence}
          className="ml-auto rounded-lg border border-nvx-borderStrong bg-white px-[13px] py-[7px] text-[11.5px] font-bold text-nvx-text hover:bg-nvx-field disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('motors.sliders.sequence', { labels: `M1→M${motorCount}`, pct: SEQUENCE_PERCENT })}
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {motors.map((seq) => {
          const pct = percents[seq] ?? 0
          const us = US_BASE + pct * US_PER_PERCENT
          return (
            <div key={seq} className="grid grid-cols-[36px_1fr_104px] items-center gap-3">
              <span className={`font-mono text-[13px] font-bold ${pct > 0 ? 'text-nvx-danger' : 'text-nvx-text'}`}>M{seq}</span>
              <input
                type="range"
                className="nvx w-full"
                min={0}
                max={MOTOR_TEST_MAX_PERCENT}
                step={1}
                value={pct}
                disabled={disabled}
                aria-label={`M${seq}`}
                onChange={(e) => onSetPercent(seq, Number(e.target.value))}
              />
              <span className="flex justify-end gap-2 font-mono text-[11.5px]">
                <span className={`min-w-[34px] text-right font-semibold ${pct > 0 ? 'text-nvx-danger' : 'text-nvx-text'}`}>{pct}%</span>
                <span className="text-nvx-faint">{us} µs</span>
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-3.5 flex items-center gap-1.5 text-[11.5px] text-nvx-faint">
        {t('motors.sliders.footnote', { max: MOTOR_TEST_MAX_PERCENT })}
      </div>
    </section>
  )
}
