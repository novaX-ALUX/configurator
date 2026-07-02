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
    <div className="rounded-lg border border-dashed border-white/10 p-8 text-slate-400">
      <h1 className="mb-2 text-lg font-semibold text-slate-200">{t(titleKey)}</h1>
      <p className="text-sm">{t('placeholder.comingSoon')}</p>
    </div>
  )
}
