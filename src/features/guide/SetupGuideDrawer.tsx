import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParamStore } from '../../core/mavlink/params'
import { useConnectionStore } from '../../store/connection'
import { useNavigationStore, type PageId } from '../../store/navigation'
import { useSetupStore } from '../setup/setupStore'
import { ESC_PROTOCOL_FIELD, FRAME_FIELD } from '../setup/paramEnums'
import { useCalibrationProgress } from '../calibration/calibrationProgress'
import { useMotorTestStore } from '../motors/motorTestStore'
import { useGuideStore } from './guideStore'
import { buildGuideSteps, type GuideStep } from './guideSteps'

const TOTAL_STEPS = 5

/** Resolves the board's current frame tile (Setup's `FRAME_CLASS`/`FRAME_TYPE`, Task 7.1) to a translated label, or `null` if not read yet — same lookup `MotorTestPage.tsx`'s `resolveFrameOption` does, just display-only here (never written). */
function frameLabel(paramStore: ParamStore | null, t: (k: string) => string): string | null {
  const frameClass = paramStore?.get('FRAME_CLASS')?.value
  const frameType = paramStore?.get('FRAME_TYPE')?.value
  const option = FRAME_FIELD.options.find((o) => o.frameClass === frameClass && o.frameType === frameType)
  return option ? t(option.labelKey) : null
}

/** Same idea for the ESC protocol (`MOT_PWM_TYPE`). */
function escLabel(paramStore: ParamStore | null, t: (k: string) => string): string | null {
  const value = paramStore?.get(ESC_PROTOCOL_FIELD.param)?.value
  const option = ESC_PROTOCOL_FIELD.options.find((o) => o.value === value)
  return option ? t(option.labelKey) : null
}

function StepRow({ step, onOpenPage }: { step: GuideStep; onOpenPage: (page: PageId) => void }) {
  const { t } = useTranslation()

  return (
    <div className="flex gap-3 border-b border-[#F1F4F8] py-3.5 last:border-b-0">
      <span
        className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border-[1.5px] text-[12px] font-bold ${
          step.done ? 'border-nvx-success bg-nvx-success text-white' : 'border-nvx-borderStrong bg-white text-nvx-subtle'
        }`}
      >
        {step.done ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7" />
          </svg>
        ) : (
          step.n
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-nvx-text">{t(step.titleKey)}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[9.5px] font-extrabold tracking-[.06em] ${
              step.done ? 'bg-nvx-successSoft text-nvx-successText' : 'bg-nvx-field text-nvx-subtle'
            }`}
          >
            {step.done ? t('guide.done') : t('guide.todo')}
          </span>
        </span>
        <span className="text-[11.5px] leading-relaxed text-nvx-subtle">{t(step.descKey, step.descOptions)}</span>
        <button
          type="button"
          onClick={() => onOpenPage(step.page)}
          className="mt-1.5 self-start rounded-lg border border-nvx-borderStrong bg-white px-3 py-1.5 text-[11.5px] font-bold text-nvx-primary hover:bg-nvx-field"
        >
          {t('guide.openPage')}
        </button>
      </span>
    </div>
  )
}

/**
 * First-flight Setup Guide drawer (Task 10.1) -- a read-only onboarding
 * checklist tying every M2 feature together (connect -> frame/ESC ->
 * calibrate -> motor test -> failsafes). Right-side slide-in panel per
 * `docs/design/novaX-Configurator.dc.html`'s own Setup Guide screen; mounted
 * unconditionally in `App.tsx` (mirrors `DisconnectToast`'s own
 * self-managing "return null when there's nothing to show" convention) so
 * `Sidebar.tsx`'s trigger button -- a sibling, not an ancestor -- can open it
 * from any page via the shared `useGuideStore`.
 *
 * Every `done` flag is a plain read of state some other feature already
 * owns and mutates for its own reasons (`setupStore.frameEscTouched`/
 * `fsTouched`, `useCalibrationProgress.accelDone`/`compassApplied`,
 * `motorTestStore.motorsTested`, `useConnectionStore.phase`/`paramStore`) --
 * this component itself never calls `paramStore.set`, `stage`, or any
 * command. "Open page" only switches the active page (`useNavigationStore`)
 * and closes the drawer; it does not jump the wizard forward or touch any
 * of those flags.
 */
export function SetupGuideDrawer() {
  const { t } = useTranslation()
  const open = useGuideStore((s) => s.open)
  const closeGuide = useGuideStore((s) => s.closeGuide)

  const phase = useConnectionStore((s) => s.phase)
  const paramStore = useConnectionStore((s) => s.paramStore)
  const setActivePage = useNavigationStore((s) => s.setActivePage)

  const frameEscTouched = useSetupStore((s) => s.frameEscTouched)
  const fsTouched = useSetupStore((s) => s.fsTouched)
  const accelDone = useCalibrationProgress((s) => s.accelDone)
  const compassApplied = useCalibrationProgress((s) => s.compassApplied)
  const motorsTested = useMotorTestStore((s) => s.motorsTested)

  // `paramStore.get()` isn't itself reactive to values arriving after this
  // component has already rendered (a passively-received PARAM_VALUE, or a
  // fetchAll() triggered from Setup/Motor Test while the guide is open) --
  // same onChange + version-bump idiom SetupPage.tsx/MotorTestPage.tsx use.
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (!paramStore) return
    return paramStore.onChange(() => setVersion((v) => v + 1))
  }, [paramStore])

  if (!open) return null

  const steps = buildGuideSteps({
    connected: phase === 'connected',
    paramCount: paramStore?.all.size ?? 0,
    frameLabel: frameLabel(paramStore, t),
    escLabel: escLabel(paramStore, t),
    frameEscTouched,
    accelDone,
    compassApplied,
    motorsTested,
    fsTouched,
  })
  const doneCount = steps.filter((s) => s.done).length
  const pct = (doneCount / TOTAL_STEPS) * 100

  function handleOpenPage(page: PageId): void {
    setActivePage(page)
    closeGuide()
  }

  return (
    <>
      <div onClick={closeGuide} className="fixed inset-0 z-[80] bg-[rgba(23,26,32,.32)]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('guide.title')}
        className="fixed bottom-0 right-0 top-0 z-[81] flex w-[400px] max-w-[92vw] flex-col bg-white shadow-popover"
      >
        <div className="border-b border-nvx-border px-5 pb-3.5 pt-[18px]">
          <div className="flex items-center">
            <span className="font-heading text-[17px] font-bold text-nvx-text">{t('guide.title')}</span>
            <button
              type="button"
              onClick={closeGuide}
              aria-label={t('guide.close')}
              className="ml-auto flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg text-nvx-subtle hover:bg-nvx-field"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="my-0.5 mb-3 text-[12px] text-nvx-subtle">{t('guide.subtitle')}</div>
          <div className="flex items-center gap-2.5">
            <div className="h-[7px] flex-1 overflow-hidden rounded-full bg-nvx-field">
              <div className="h-full rounded-full bg-nvx-success transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
            </div>
            <span className="font-mono text-[11.5px] font-semibold text-nvx-successText">{t('guide.progress', { done: doneCount, total: TOTAL_STEPS })}</span>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-5 py-3.5">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} onOpenPage={handleOpenPage} />
          ))}
        </div>

        <div className="flex items-center border-t border-nvx-border px-5 py-3.5">
          <span className="text-[11px] text-nvx-faint">{t('guide.footerNote')}</span>
          <button
            type="button"
            onClick={closeGuide}
            className="ml-auto flex-none rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2 text-[12px] font-semibold text-nvx-text hover:bg-nvx-field"
          >
            {t('guide.skip')}
          </button>
        </div>
      </div>
    </>
  )
}
