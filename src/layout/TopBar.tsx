import { useTranslation } from 'react-i18next'
import novaxLogo from '../assets/novax-logo.png'

const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'zh', nativeName: '中文' },
  { code: 'ko', nativeName: '한국어' },
  { code: 'ja', nativeName: '日本語' },
] as const

const BAUD_RATES = ['115200', '57600', '921600']

/**
 * Global connection topbar. Only the DISCONNECTED visual state from the design is
 * implemented here — port enumeration, connecting/connected states and the session
 * activity panel are wired up in Task 3.1.
 */
export function TopBar() {
  const { t, i18n } = useTranslation()

  return (
    <header className="col-span-2 row-start-1 flex h-14 items-center gap-3 border-b border-nvx-border bg-nvx-surface px-[18px]">
      <img src={novaxLogo} alt="novaX" className="h-[17px] w-auto" />
      <span className="h-5 w-px bg-nvx-border" aria-hidden="true" />
      <span className="font-heading text-[10.5px] font-semibold tracking-[.22em] text-nvx-subtle">
        {t('topbar.brandLabel')}
      </span>

      <span className="flex-1" />

      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="serial-port-select">
          {t('topbar.port')}
        </label>
        <select
          id="serial-port-select"
          disabled
          defaultValue=""
          className="rounded-lg border border-nvx-border bg-nvx-field px-2 py-[7px] font-mono text-[11.5px] text-nvx-muted disabled:cursor-not-allowed"
        >
          <option value="">{t('topbar.noPort')}</option>
        </select>

        <label className="sr-only" htmlFor="baud-rate-select">
          {t('topbar.baud')}
        </label>
        <select
          id="baud-rate-select"
          disabled
          defaultValue={BAUD_RATES[0]}
          className="rounded-lg border border-nvx-border bg-nvx-field px-2 py-[7px] font-mono text-[11.5px] text-nvx-muted disabled:cursor-not-allowed"
        >
          {BAUD_RATES.map((baud) => (
            <option key={baud} value={baud}>
              {baud}
            </option>
          ))}
        </select>

        <button
          type="button"
          disabled
          className="rounded-[9px] bg-nvx-primary px-[18px] py-2 text-[12.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('topbar.connect')}
        </button>
      </div>

      <span className="h-5 w-px bg-nvx-border" aria-hidden="true" />

      <label className="sr-only" htmlFor="language-select">
        {t('topbar.language')}
      </label>
      <select
        id="language-select"
        value={i18n.resolvedLanguage ?? 'en'}
        onChange={(event) => {
          void i18n.changeLanguage(event.target.value)
        }}
        className="rounded-lg border border-transparent px-2 py-[7px] text-[12px] font-semibold text-nvx-subtle hover:bg-nvx-field"
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.nativeName}
          </option>
        ))}
      </select>
    </header>
  )
}
