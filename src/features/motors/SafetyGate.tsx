import { useTranslation } from 'react-i18next'
import type { SafetyState } from './motorSafety'

interface SafetyGateProps {
  propsConfirmed: boolean
  connected: boolean
  state: SafetyState
  /** Milliseconds left in the 'counting' unlock countdown. */
  countdown: number
  /** Milliseconds left before an idle 'ready' auto-locks. */
  idleLeft: number
  /** The one path to `MotorSafety.confirmProps(false)` -- kill switch #5 (unchecking while armed) lives entirely inside that call, this component doesn't special-case it. */
  onToggleProps: (v: boolean) => void
  onEnable: () => void
  /** STOP ALL -- kill switch #6. */
  onStopAll: () => void
}

/**
 * The design mock's "SAFETY GATE" card: the props-removed hard gate plus the
 * Enable/STOP ALL pair. `onEnable` is disabled unless `propsConfirmed &&
 * connected` -- `MotorSafety.enable()` itself would silently no-op without
 * `propsConfirmed`, but disabling the button is the honest UI for that,
 * rather than a click that visibly does nothing.
 */
export function SafetyGate({ propsConfirmed, connected, state, countdown, idleLeft, onToggleProps, onEnable, onStopAll }: SafetyGateProps) {
  const { t } = useTranslation()
  const enableDisabled = !propsConfirmed || !connected

  const enableLabel =
    state === 'counting'
      ? t('motors.safetyGate.enableCounting', { s: Math.ceil(countdown / 1000) })
      : state === 'ready' || state === 'testing'
        ? t('motors.safetyGate.enableReady', { s: Math.ceil(idleLeft / 1000) })
        : t('motors.safetyGate.enableLocked')

  return (
    <section className="rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3 text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('motors.safetyGate.title')}</div>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-nvx-warningBorder bg-nvx-warningSoft p-3">
        <input
          type="checkbox"
          checked={propsConfirmed}
          onChange={(e) => onToggleProps(e.target.checked)}
          className="mt-0.5 h-[17px] w-[17px] cursor-pointer accent-nvx-warning"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-extrabold text-nvx-warningText">{t('motors.safetyGate.checkboxLabel')}</span>
          <span className="text-[11.5px] text-nvx-warningText">{t('motors.safetyGate.checkboxHint')}</span>
        </span>
      </label>

      <div className="mt-3 flex items-center gap-2.5">
        <button
          type="button"
          disabled={enableDisabled}
          onClick={onEnable}
          className={`flex-1 rounded-[10px] px-4 py-[11px] text-[13px] font-extrabold tracking-[.02em] ${
            enableDisabled ? 'cursor-not-allowed bg-nvx-field text-nvx-disabled' : 'cursor-pointer bg-nvx-warning text-white hover:bg-nvx-warningText'
          }`}
        >
          {enableLabel}
        </button>
        <button
          type="button"
          onClick={onStopAll}
          className="flex-none rounded-[10px] bg-nvx-danger px-[18px] py-[11px] text-[13px] font-extrabold text-white hover:bg-nvx-dangerHover"
        >
          {t('motors.safetyGate.stopAll')}
        </button>
      </div>
    </section>
  )
}
