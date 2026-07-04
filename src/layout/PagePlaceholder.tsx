import { useTranslation } from 'react-i18next'

interface PagePlaceholderProps {
  titleKey: string
}

/**
 * Generic placeholder shown for every M1 page until its real implementation
 * lands (Phase 3 of the M1 plan). Replaced page-by-page, not extended.
 */
export function PagePlaceholder({ titleKey }: PagePlaceholderProps) {
  const { t } = useTranslation()

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <div className="mb-3 flex items-baseline">
        <h1 className="font-heading text-[19px] font-bold text-nvx-text">{t(titleKey)}</h1>
      </div>
      <div className="rounded-xl border border-nvx-border bg-nvx-surface p-4 text-nvx-muted shadow-card">
        <p className="text-sm">{t('placeholder.comingSoon')}</p>
      </div>
    </div>
  )
}
