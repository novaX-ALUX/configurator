import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { useNavigationStore } from '../../store/navigation'
import { TOTAL_STEPS, useGuideSteps } from '../guide/useGuideSteps'
import type { GuideStep } from '../guide/guideSteps'

/**
 * Home — the landing page and journey splitter (IA T2, issue #44, ADR-0004):
 * first-run users find the Setup Guide steps, returning users find Connect,
 * rescue users find the path to Firmware. Ungrouped in the nav, above the
 * three Nav Groups.
 *
 * The guide steps here are the drawer's, not a copy: both render from the
 * shared `useGuideSteps()` derivation, so their done/to-do states can never
 * disagree. The Connect CTA calls the same `useConnectionStore.connect` as
 * the top bar (no second connection pathway). Bench-side read-only: this
 * page navigates and connects, never stages a parameter or issues a Named
 * Operation.
 */
export function HomePage() {
  const { t } = useTranslation()
  const setActivePage = useNavigationStore((s) => s.setActivePage)
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const steps = useGuideSteps()
  const doneCount = steps.filter((s) => s.done).length

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <div className="mx-auto max-w-[760px]">
        <h1 className="mb-1.5 font-heading text-[19px] font-bold text-nvx-text">{t('home.title')}</h1>
        <p className="mb-4 text-[13px] leading-relaxed text-nvx-muted">{t('home.subtitle')}</p>

        <section className="mb-4 rounded-xl border border-nvx-border bg-nvx-surface p-4 shadow-card">
          <h2 className="mb-1.5 font-heading text-[15px] font-bold text-nvx-text">{t('home.connect.title')}</h2>
          {phase === 'connected' ? (
            <p className="flex items-center gap-2 text-[13px] font-bold text-nvx-successText">
              <span className="h-[7px] w-[7px] flex-none animate-nvxPulse rounded-full bg-nvx-success" />
              {t('home.connect.connected')}
            </p>
          ) : (
            <>
              <p className="mb-3 text-[13px] leading-relaxed text-nvx-muted">{t('home.connect.body')}</p>
              {phase === 'disconnected' && (
                <button
                  type="button"
                  onClick={() => void connect(baud)}
                  className="rounded-[9px] bg-nvx-primary px-[18px] py-2 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover"
                >
                  {t('home.connect.cta')}
                </button>
              )}
              {phase === 'connecting' && (
                <span className="inline-flex items-center gap-[9px] rounded-full bg-nvx-primarySoft px-[14px] py-[7px] text-[12.5px] font-bold text-nvx-primarySoftText">
                  <span className="h-[13px] w-[13px] animate-nvxSpin rounded-full border-2 border-nvx-infoBorder border-t-nvx-primary" />
                  {t('topbar.connecting')}
                </span>
              )}
              {phase === 'lost' && (
                <span className="inline-flex items-center gap-2 rounded-full border border-nvx-warningBorder bg-nvx-warningSoft px-[13px] py-[7px] text-[12px] font-bold text-nvx-warningText">
                  <span className="h-[7px] w-[7px] animate-nvxPulse rounded-full bg-nvx-warning" />
                  {t('topbar.linkLost')}
                </span>
              )}
            </>
          )}
        </section>

        <section className="mb-4 rounded-xl border border-nvx-border bg-nvx-surface p-4 shadow-card">
          <div className="mb-1.5 flex items-center gap-2.5">
            <h2 className="font-heading text-[15px] font-bold text-nvx-text">{t('guide.title')}</h2>
            <span className="ml-auto font-mono text-[11.5px] font-semibold text-nvx-successText">
              {t('guide.progress', { done: doneCount, total: TOTAL_STEPS })}
            </span>
          </div>
          <div className="mb-2 h-[7px] overflow-hidden rounded-full bg-nvx-field">
            <div className="h-full rounded-full bg-nvx-success transition-[width] duration-300 ease-out" style={{ width: `${(doneCount / TOTAL_STEPS) * 100}%` }} />
          </div>
          {steps.map((step) => (
            <StepRow key={step.id} step={step} onOpenPage={setActivePage} />
          ))}
        </section>

        <section className="rounded-xl border border-nvx-border bg-nvx-surface p-4 shadow-card">
          <h2 className="mb-1.5 font-heading text-[15px] font-bold text-nvx-text">{t('home.rescue.title')}</h2>
          <p className="mb-3 text-[13px] leading-relaxed text-nvx-muted">{t('home.rescue.body')}</p>
          <button
            type="button"
            onClick={() => setActivePage('firmware')}
            className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2 text-[12px] font-semibold text-nvx-text hover:bg-nvx-field"
          >
            {t('home.rescue.cta')}
          </button>
        </section>
      </div>
    </div>
  )
}

/** Same row anatomy as the drawer's StepRow (number/check circle, Done/To do badge, "Open page"), sized for page content instead of a 400px panel. */
function StepRow({ step, onOpenPage }: { step: GuideStep; onOpenPage: (page: GuideStep['page']) => void }) {
  const { t } = useTranslation()

  return (
    <div className="flex gap-3 border-b border-[#F1F4F8] py-3.5 last:border-b-0 last:pb-0">
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
      </span>
      <button
        type="button"
        onClick={() => onOpenPage(step.page)}
        className="self-center rounded-lg border border-nvx-borderStrong bg-white px-3 py-1.5 text-[11.5px] font-bold text-nvx-primary hover:bg-nvx-field"
      >
        {t('guide.openPage')}
      </button>
    </div>
  )
}
