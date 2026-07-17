import './i18n'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './layout/Sidebar'
import { TopBar } from './layout/TopBar'
import { TelemetryStrip } from './layout/TelemetryStrip'
import { PagePlaceholder } from './layout/PagePlaceholder'
import { DisconnectToast } from './layout/DisconnectToast'
import { ConsolePage } from './features/console/ConsolePage'
import { ParamsPage } from './features/params/ParamsPage'
import { FirmwarePage } from './features/firmware/FirmwarePage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { ChartsPage } from './features/charts/ChartsPage'
import { SetupPage } from './features/setup/SetupPage'
import { TuningPage } from './features/tuning/TuningPage'
import { CalibrationPage } from './features/calibration/CalibrationPage'
import { MotorTestPage } from './features/motors/MotorTestPage'
import { LicensesPage } from './features/licenses/LicensesPage'
import { useMotorTestStore } from './features/motors/motorTestStore'
import { SetupGuideDrawer } from './features/guide/SetupGuideDrawer'
import { NAV_PAGES, useNavigationStore } from './store/navigation'

/**
 * Global safety banners (Task 9.3) -- the design mock's red "MOTOR TEST
 * ACTIVE" / amber "MOTOR OUTPUTS ENABLED" bars, in the root grid's own
 * `auto`-height row so they collapse to nothing when neither applies.
 * Reads `useMotorTestStore` directly rather than through `MotorTestPage`
 * (a sibling here, not an ancestor) -- both the page and this banner drive
 * the SAME store, so STOP ALL/LOCK OUTPUTS here calls the exact same
 * `stop()` as every one of the six kill switches.
 *
 * Red (`state === 'testing'`) and amber (`state === 'ready' | 'counting'`)
 * are mutually exclusive by construction (`MotorSafety.state` is a single
 * value) -- at most one of these ever renders.
 */
function SafetyBanners() {
  const { t } = useTranslation()
  const state = useMotorTestStore((s) => s.state)
  const countdown = useMotorTestStore((s) => s.countdown)
  const idleLeft = useMotorTestStore((s) => s.idleLeft)
  const stopLeft = useMotorTestStore((s) => s.stopLeft)
  const stop = useMotorTestStore((s) => s.stop)

  if (state === 'testing') {
    return (
      <div className="col-span-2 row-start-1 flex items-center gap-2.5 bg-nvx-danger px-4 py-2.5 text-white">
        <BannerWarningIcon />
        <span className="text-[12.5px] font-extrabold tracking-[.05em]">{t('motors.banners.testActive')}</span>
        <span className="text-[12px] text-white/85">{t('motors.banners.testActiveBody', { s: Math.ceil(stopLeft / 1000) })}</span>
        <button
          type="button"
          onClick={() => stop('STOP pressed')}
          className="ml-auto flex-none rounded-lg border border-white/45 bg-white/[.16] px-3.5 py-1.5 text-[11.5px] font-extrabold hover:bg-white/30"
        >
          {t('motors.banners.stopAll')}
        </button>
      </div>
    )
  }

  if (state === 'ready' || state === 'counting') {
    return (
      <div className="col-span-2 row-start-1 flex items-center gap-2.5 bg-[#B45309] px-4 py-2.5 text-white">
        <BannerWarningIcon />
        <span className="text-[12.5px] font-extrabold tracking-[.05em]">{t('motors.banners.outputsEnabled')}</span>
        <span className="text-[12px] text-white/85">
          {state === 'ready'
            ? t('motors.banners.outputsEnabledBody', { s: Math.ceil(idleLeft / 1000) })
            : t('motors.safetyGate.enableCounting', { s: Math.ceil(countdown / 1000) })}
        </span>
        <button
          type="button"
          onClick={() => stop('STOP pressed')}
          className="ml-auto flex-none rounded-lg border border-white/45 bg-white/[.16] px-3.5 py-1.5 text-[11.5px] font-extrabold hover:bg-white/30"
        >
          {t('motors.banners.lockOutputs')}
        </button>
      </div>
    )
  }

  return null
}

function BannerWarningIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" className="flex-none">
      <path d="M12 4.2 21.6 20.3H2.4Z" />
      <path d="M12 10v4.4" strokeLinecap="round" />
      <circle cx="12" cy="17.1" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

function App() {
  const activePage = useNavigationStore((s) => s.activePage)
  const page = NAV_PAGES.find((p) => p.id === activePage)

  return (
    <div className="grid h-screen min-w-[1024px] grid-cols-[64px_1fr] grid-rows-[auto_56px_auto_minmax(0,1fr)] bg-nvx-bg font-sans text-nvx-text">
      <SafetyBanners />
      <TopBar />
      <TelemetryStrip />
      <Sidebar />
      <main className="col-start-2 row-start-4 min-w-0 overflow-auto">
        {activePage === 'console' ? (
          <ConsolePage />
        ) : activePage === 'parameters' ? (
          <ParamsPage />
        ) : activePage === 'firmware' ? (
          <FirmwarePage />
        ) : activePage === 'dashboard' ? (
          <DashboardPage />
        ) : activePage === 'charts' ? (
          <ChartsPage />
        ) : activePage === 'setup' ? (
          <SetupPage />
        ) : activePage === 'tuning' ? (
          <TuningPage />
        ) : activePage === 'calibration' ? (
          <CalibrationPage />
        ) : activePage === 'motors' ? (
          <MotorTestPage />
        ) : activePage === 'licenses' ? (
          <LicensesPage />
        ) : (
          page && <PagePlaceholder titleKey={page.labelKey} />
        )}
      </main>
      <DisconnectToast />
      <SetupGuideDrawer />
    </div>
  )
}

export default App
