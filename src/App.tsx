import './i18n'
import { Sidebar } from './layout/Sidebar'
import { TopBar } from './layout/TopBar'
import { PagePlaceholder } from './layout/PagePlaceholder'
import { NAV_PAGES, useNavigationStore } from './store/navigation'

function App() {
  const activePage = useNavigationStore((s) => s.activePage)
  const page = NAV_PAGES.find((p) => p.id === activePage)

  return (
    <div className="flex h-screen bg-[#0A0A0F] text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-auto p-6">
          {page && <PagePlaceholder titleKey={page.labelKey} />}
        </main>
      </div>
    </div>
  )
}

export default App
