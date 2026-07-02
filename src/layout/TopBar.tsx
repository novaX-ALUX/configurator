import { useTranslation } from 'react-i18next'

const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'zh', nativeName: '中文' },
  { code: 'ko', nativeName: '한국어' },
  { code: 'ja', nativeName: '日本語' },
] as const

export function TopBar() {
  const { t, i18n } = useTranslation()

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-[#0A0A0F] px-4">
      <span className="text-sm font-medium text-slate-200">{t('app.title')}</span>

      <div className="flex items-center gap-3">
        <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-slate-400">
          {t('topbar.notConnected')}
        </span>
        <button
          type="button"
          disabled
          className="rounded-md bg-sky-500/20 px-3 py-1 text-xs font-medium text-sky-300/50 disabled:cursor-not-allowed"
        >
          {t('topbar.connect')}
        </button>
        <label className="sr-only" htmlFor="language-select">
          {t('topbar.language')}
        </label>
        <select
          id="language-select"
          value={i18n.resolvedLanguage ?? 'en'}
          onChange={(event) => {
            void i18n.changeLanguage(event.target.value)
          }}
          className="rounded-md border border-white/10 bg-transparent px-2 py-1 text-xs text-slate-300"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code} className="bg-[#0A0A0F] text-slate-200">
              {lang.nativeName}
            </option>
          ))}
        </select>
      </div>
    </header>
  )
}
