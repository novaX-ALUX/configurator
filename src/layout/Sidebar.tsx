import { useTranslation } from 'react-i18next'
import { NAV_PAGES, useNavigationStore } from '../store/navigation'

export function Sidebar() {
  const { t } = useTranslation()
  const activePage = useNavigationStore((s) => s.activePage)
  const setActivePage = useNavigationStore((s) => s.setActivePage)

  return (
    <nav
      aria-label={t('nav.ariaLabel')}
      className="flex w-16 flex-col items-center gap-1 border-r border-white/10 bg-[#0A0A0F] py-3"
    >
      {NAV_PAGES.map((page) => {
        const label = t(page.labelKey)
        const isActive = activePage === page.id

        return (
          <button
            key={page.id}
            type="button"
            disabled={!page.enabled}
            aria-current={isActive ? 'page' : undefined}
            title={label}
            onClick={() => setActivePage(page.id)}
            className={`flex h-11 w-11 flex-col items-center justify-center rounded-lg text-xs font-medium transition-colors ${
              isActive
                ? 'bg-sky-500/20 text-sky-300'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            } disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent`}
          >
            <span aria-hidden="true">{page.glyph}</span>
            <span className="sr-only">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
