import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SafetyState } from './motorSafety'

/** Spin throttle for the guide's own test spins -- same bench-safe order of magnitude as `MotorSliders`' sequence test. */
const GUIDE_TEST_PERCENT = 12

interface ManualMapGuideProps {
  motorCount: number
  state: SafetyState
  onSetPercent: (motorSeq: number, percent: number) => void
}

type GuideStep =
  | { kind: 'idle' }
  | { kind: 'spinning'; expected: number }
  | { kind: 'result'; expected: number; picked: number; match: boolean }
  | { kind: 'done' }

/**
 * Task 9.3's "auto-map degraded" guide (per the Codex review that flagged
 * the original task brief's "wizard remaps SERVOx_FUNCTION for you" copy as
 * unsafe for M2, since real-hardware verification of an auto-remap hasn't
 * happened yet). Spins one motor at a time through the SAME safety-gated
 * path every slider uses (`onSetPercent`, i.e. still subject to every one of
 * `MotorSafety`'s six kill switches and idle auto-stops) and asks the user
 * which physical position actually moved, comparing it against the expected
 * ArduPilot output number from the frame diagram.
 *
 * This component deliberately takes no `ParamStore` (or any other write
 * path) at all -- not merely "happens not to call `.set()`", but
 * structurally unable to write `SERVOx_FUNCTION` or any other parameter. A
 * mismatch only shows a warning pointing the user at Parameters to fix the
 * mapping themselves; nothing here ever remaps anything automatically.
 *
 * **Adversarial-review fix.** `onSetPercent` (`motorTestStore.ts`'s
 * `setMotorPercent`) already refuses to spin anything unless `state` is
 * currently 'ready'/'testing' -- a stop always disarms this guide's own test
 * spins centrally, no matter what this component does. But a stale local
 * `step` (still showing "spinning position N" or a result screen after a
 * kill switch fired) would be a dishonest UI even though it's now harmless,
 * and a stale `next()` press would silently no-op instead of failing
 * loudly. So `step` resets to 'idle' the moment `state` drops to 'locked'
 * (the render-time "adjust state on prop change" idiom this codebase
 * already uses in `useTelemetry.ts`/`useAccelCalibration.ts`, not a
 * `useEffect`, to avoid a one-frame flash of the stale screen), and every
 * mid-guide action is also explicitly disabled outside 'ready'/'testing'.
 */
export function ManualMapGuide({ motorCount, state, onSetPercent }: ManualMapGuideProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState<GuideStep>({ kind: 'idle' })
  const disabled = state !== 'ready' && state !== 'testing'

  const [prevState, setPrevState] = useState(state)
  if (state !== prevState) {
    setPrevState(state)
    if (state === 'locked' && step.kind !== 'idle') {
      setStep({ kind: 'idle' })
    }
  }

  function start(): void {
    if (disabled) return
    onSetPercent(1, GUIDE_TEST_PERCENT)
    setStep({ kind: 'spinning', expected: 1 })
  }

  function confirmPosition(picked: number): void {
    if (step.kind !== 'spinning') return
    onSetPercent(step.expected, 0)
    setStep({ kind: 'result', expected: step.expected, picked, match: picked === step.expected })
  }

  function next(): void {
    if (step.kind !== 'result') return
    const nextExpected = step.expected + 1
    if (nextExpected > motorCount) {
      setStep({ kind: 'done' })
      return
    }
    onSetPercent(nextExpected, GUIDE_TEST_PERCENT)
    setStep({ kind: 'spinning', expected: nextExpected })
  }

  function close(): void {
    if (step.kind === 'spinning') onSetPercent(step.expected, 0)
    setStep({ kind: 'idle' })
  }

  return (
    <section className="flex items-center gap-3 rounded-xl border border-dashed border-nvx-borderStrong bg-white p-4">
      <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[11px] bg-nvx-primarySoft text-nvx-primary">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <circle cx="12" cy="12" r="7.5" />
          <path d="M14.8 9.2l-1.8 4.4-4.4 1.8 1.8-4.4z" />
        </svg>
      </span>

      {step.kind === 'idle' && (
        <>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[12.5px] font-bold text-nvx-text">{t('motors.guide.title')}</span>
            <span className="text-[11.5px] leading-relaxed text-nvx-subtle">{t('motors.guide.body')}</span>
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={start}
            className="ml-auto flex-none rounded-[9px] border border-nvx-borderStrong bg-white px-[14px] py-2 text-[12px] font-bold text-nvx-text hover:bg-nvx-field disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('motors.guide.start')}
          </button>
        </>
      )}

      {step.kind === 'spinning' && (
        <>
          <span className="min-w-0 flex-1 text-[12.5px] font-semibold text-nvx-text">
            {t('motors.guide.spinning', { n: step.expected })}
          </span>
          <div className="ml-auto flex flex-none gap-1.5">
            {Array.from({ length: motorCount }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                disabled={disabled}
                onClick={() => confirmPosition(n)}
                className="h-8 w-8 rounded-full border border-nvx-borderStrong bg-white font-mono text-[12px] font-bold text-nvx-text hover:bg-nvx-field disabled:cursor-not-allowed disabled:opacity-50"
              >
                {n}
              </button>
            ))}
          </div>
        </>
      )}

      {step.kind === 'result' && (
        <>
          <span className={`min-w-0 flex-1 text-[12.5px] font-semibold ${step.match ? 'text-nvx-successText' : 'text-nvx-warningText'}`}>
            {step.match ? t('motors.guide.match', { n: step.expected }) : t('motors.guide.mismatch', { n: step.expected, picked: step.picked })}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={next}
            className="ml-auto flex-none rounded-[9px] bg-nvx-primary px-[14px] py-2 text-[12px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('motors.guide.next')}
          </button>
        </>
      )}

      {step.kind === 'done' && (
        <>
          <span className="min-w-0 flex-1 text-[12.5px] font-semibold text-nvx-successText">{t('motors.guide.done')}</span>
          <button
            type="button"
            onClick={close}
            className="ml-auto flex-none rounded-[9px] border border-nvx-borderStrong bg-white px-[14px] py-2 text-[12px] font-bold text-nvx-text hover:bg-nvx-field"
          >
            {t('motors.guide.close')}
          </button>
        </>
      )}
    </section>
  )
}
