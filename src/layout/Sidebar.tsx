import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NAV_PAGES, type PageId, useNavigationStore } from '../store/navigation'

/**
 * Sidebar nav icons, ported from the left rail of docs/design/novaX-Configurator.dc.html.
 * The design doesn't have a dedicated "Debug/Status" screen (M1 folds STATUSTEXT/status
 * into that page ahead of the design's own Console screen), so its icon is authored to
 * match the design's stroke style rather than lifted verbatim.
 */
const NAV_ICONS: Record<PageId, ReactNode> = {
  firmware: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="7.25" y="7.25" width="9.5" height="9.5" rx="2" />
      <path d="M9.5 7.25v-3M14.5 7.25v-3M9.5 19.75v-3M14.5 19.75v-3M7.25 9.5h-3M7.25 14.5h-3M19.75 9.5h-3M19.75 14.5h-3" />
    </svg>
  ),
  parameters: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="3.75" y="4.5" width="16.5" height="15" rx="2" />
      <path d="M3.75 9.5h16.5M10 9.5v10" />
    </svg>
  ),
  debug: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 12h4l2-6 4 12 2-6h5" />
    </svg>
  ),
  dashboard: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4.75 14.5a7.25 7.25 0 1 1 14.5 0" />
      <path d="M12 14.5l3.6-4.1" />
      <circle cx="12" cy="14.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  setup: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h15" />
      <circle cx="9.5" cy="7.5" r="2" fill="#FFFFFF" />
      <circle cx="15" cy="12" r="2" fill="#FFFFFF" />
      <circle cx="8" cy="16.5" r="2" fill="#FFFFFF" />
    </svg>
  ),
  calibration: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2.75v3M12 18.25v3M2.75 12h3M18.25 12h3" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  motors: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="6.2" cy="6.2" r="2.45" />
      <circle cx="17.8" cy="6.2" r="2.45" />
      <circle cx="6.2" cy="17.8" r="2.45" />
      <circle cx="17.8" cy="17.8" r="2.45" />
      <path d="M8.1 8.1l7.8 7.8M15.9 8.1l-7.8 7.8" />
    </svg>
  ),
  console: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="3" y="4.75" width="18" height="14.5" rx="2.5" />
      <path d="M7 9.25l3.25 2.75L7 14.75M12.5 15h4.5" />
    </svg>
  ),
}

export function Sidebar() {
  const { t } = useTranslation()
  const activePage = useNavigationStore((s) => s.activePage)
  // The unsaved-changes guard lives inside setActivePage itself (navigation.ts)
  // rather than here, so every caller gets the same protection — not just
  // Sidebar's click handler.
  const setActivePage = useNavigationStore((s) => s.setActivePage)

  return (
    <nav
      aria-label={t('nav.ariaLabel')}
      className="col-start-1 row-start-2 flex flex-col items-center gap-1 border-r border-nvx-border bg-nvx-surface py-3"
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
            className={`flex h-[42px] w-[42px] items-center justify-center rounded-[11px] transition-colors ${
              !page.enabled
                ? 'cursor-not-allowed text-nvx-disabled'
                : isActive
                  ? 'bg-nvx-primarySoft text-nvx-primary'
                  : 'text-nvx-subtle hover:bg-nvx-field'
            }`}
          >
            <span aria-hidden="true">{NAV_ICONS[page.id]}</span>
            <span className="sr-only">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
