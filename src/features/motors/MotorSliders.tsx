import { useTranslation } from 'react-i18next'
import type { SafetyState } from './motorSafety'
import { MOTOR_TEST_MAX_PERCENT } from './motorTest'
import { SPIN_DURATION_MAX_S, SPIN_DURATION_MIN_S } from './motorTestStore'

/** Sequence test throttle -- design mock's own "Sequence M1→M4 @ 12%", purely for the button's own label copy (the actual value lives in `motorTestStore.ts`, which owns the sequence timer -- see that module's doc for why). */
const SEQUENCE_PERCENT = 12
/** µs readout formula, per the design mock (`docs/design/novaX-Configurator.dc.html`'s `ms.us`): a purely illustrative PWM-ish readout, not read back from `SERVO_OUTPUT_RAW`. */
const US_BASE = 1000
const US_PER_PERCENT = 10

interface MotorSlidersProps {
  motorCount: number
  /** motorSeq (1-based) -> current percent. */
  percents: Record<number, number>
  state: SafetyState
  onSetPercent: (motorSeq: number, percent: number) => void
  sequenceRunning: boolean
  onRunSequence: () => void
  /** Hands-off spin duration in seconds (issue #59) -- `motorTestStore.ts`'s `spinDurationS`. */
  spinDurationS: number
  /** The store's `setSpinDuration` (clamps to 1-30s itself; this component sends the raw input value). */
  onSetSpinDuration: (seconds: number) => void
}

/**
 * Per-motor 0-100% sliders plus the "Sequence M1→Mn @ 12%" button -- both
 * disabled unless `state` is 'ready' or 'testing' (the safety gate must be
 * armed first). Every slider move goes through `onSetPercent` --
 * `useMotorTestStore`'s own `setMotorPercent`, which is what actually drives
 * `MotorSafety.noteActivity()`/`setSpinning()`; this component never talks
 * to the flight controller directly.
 *
 * **The sequence-test timer itself lives in `motorTestStore.ts`, not here**
 * (`onRunSequence`/`sequenceRunning` are the store's own `runSequence`
 * action and reactive flag) -- an adversarial-review fix. A component-owned
 * `setInterval` here would keep stepping through motors even after a kill
 * switch fires (nothing about a stop unmounts this component), and if that
 * stale interval's next tick happened to land *after* the user re-armed, it
 * would look like an ordinary fresh percent-set and genuinely spin a motor
 * with nobody touching a slider. Owning the timer in the store instead lets
 * `onStop` (every path into 'locked') cancel it unconditionally, in the same
 * atomic step that clears `percents` -- see that module's doc for the full
 * writeup.
 */
export function MotorSliders({ motorCount, percents, state, onSetPercent, sequenceRunning, onRunSequence, spinDurationS, onSetSpinDuration }: MotorSlidersProps) {
  const { t } = useTranslation()
  const disabled = state !== 'ready' && state !== 'testing'

  const motors = Array.from({ length: motorCount }, (_, i) => i + 1)

  return (
    <section className="rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('motors.sliders.title')}</span>
        <button
          type="button"
          disabled={disabled || sequenceRunning}
          onClick={onRunSequence}
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
      <div className="mt-3.5 flex items-center gap-2 text-[11.5px]">
        <label htmlFor="nvx-spin-duration" className="font-bold text-nvx-subtle">
          {t('motors.sliders.durationLabel')}
        </label>
        <input
          id="nvx-spin-duration"
          type="number"
          min={SPIN_DURATION_MIN_S}
          max={SPIN_DURATION_MAX_S}
          step={1}
          value={spinDurationS}
          onChange={(e) => onSetSpinDuration(Number(e.target.value))}
          className="w-[60px] rounded-lg border border-nvx-borderStrong bg-white px-2 py-1 text-right font-mono text-[11.5px] font-semibold text-nvx-text"
        />
        <span className="text-nvx-faint">{t('motors.sliders.durationHint', { min: SPIN_DURATION_MIN_S, max: SPIN_DURATION_MAX_S })}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-nvx-faint">
        {t('motors.sliders.footnote', { max: MOTOR_TEST_MAX_PERCENT })}
      </div>
    </section>
  )
}
