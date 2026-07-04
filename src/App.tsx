import './i18n'
import { Sidebar } from './layout/Sidebar'
import { TopBar } from './layout/TopBar'
import { PagePlaceholder } from './layout/PagePlaceholder'
import { DisconnectToast } from './layout/DisconnectToast'
import { StatusPanel } from './features/debug/StatusPanel'
import { ParamsPage } from './features/params/ParamsPage'
import { FirmwarePage } from './features/firmware/FirmwarePage'
import { NAV_PAGES, useNavigationStore } from './store/navigation'

function App() {
  const activePage = useNavigationStore((s) => s.activePage)
  const page = NAV_PAGES.find((p) => p.id === activePage)

  return (
    <div className="grid h-screen min-w-[1024px] grid-cols-[64px_1fr] grid-rows-[56px_minmax(0,1fr)] bg-nvx-bg font-sans text-nvx-text">
      <TopBar />
      <Sidebar />
      <main className="col-start-2 row-start-2 min-w-0 overflow-auto">
        {activePage === 'debug' ? (
          <StatusPanel />
        ) : activePage === 'parameters' ? (
          <ParamsPage />
        ) : activePage === 'firmware' ? (
          <FirmwarePage />
        ) : (
          page && <PagePlaceholder titleKey={page.labelKey} />
        )}
      </main>
      <DisconnectToast />
    </div>
  )
}

export default App
