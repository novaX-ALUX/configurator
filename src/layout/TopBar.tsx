import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import novaxLogo from '../assets/novax-logo.png'
import { useConnectionStore } from '../store/connection'

const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'zh', nativeName: '中文' },
  { code: 'ko', nativeName: '한국어' },
  { code: 'ja', nativeName: '日本語' },
] as const

const BAUD_RATES = ['115200', '57600', '921600']

function portLabel(portInfo: { usbVendorId?: number; usbProductId?: number } | null): string | undefined {
  if (!portInfo || portInfo.usbVendorId === undefined) return undefined
  const vid = portInfo.usbVendorId.toString(16).padStart(4, '0').toUpperCase()
  const pid = portInfo.usbProductId?.toString(16).padStart(4, '0').toUpperCase()
  return pid ? `VID:${vid} PID:${pid}` : `VID:${vid}`
}

/**
 * Global connection topbar — wired to `useConnectionStore` (Task 3.1).
 *
 * Port picking deviates from the design file's literal mockup (a `<select>`
 * pre-populated with named COM ports): real Web Serial has no API to
 * enumerate not-yet-permitted system ports, only `requestPort()` (a native,
 * gesture-gated picker) and `getPorts()` (ports this origin already has
 * permission for, which is empty on a fresh profile). Faking a port list
 * would be indistinguishable from working until someone tried it against
 * real hardware. Connect itself *is* the gesture that opens the picker,
 * filtered to novaX's USB vendor ID; "Any device" removes that filter for
 * bring-up against generic USB-serial adapters — matching the brief's "allow
 * a no-filter manual pick" requirement. Documented in task-3.1-report.md.
 */
export function TopBar() {
  const { t, i18n } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const setBaud = useConnectionStore((s) => s.setBaud)
  const portInfo = useConnectionStore((s) => s.portInfo)
  const identity = useConnectionStore((s) => s.identity)
  const connect = useConnectionStore((s) => s.connect)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const [anyDevice, setAnyDevice] = useState(false)

  const disconnected = phase === 'disconnected'

  return (
    <header className="col-span-2 row-start-2 flex h-14 items-center gap-3 border-b border-nvx-border bg-nvx-surface px-[18px]">
      <img src={novaxLogo} alt="novaX" className="h-[17px] w-auto" />
      <span className="h-5 w-px bg-nvx-border" aria-hidden="true" />
      <span className="font-heading text-[10.5px] font-semibold tracking-[.22em] text-nvx-subtle">
        {t('topbar.brandLabel')}
      </span>

      <span className="flex-1" />

      {disconnected && (
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="baud-rate-select">
            {t('topbar.baud')}
          </label>
          <select
            id="baud-rate-select"
            value={String(baud)}
            onChange={(event) => setBaud(Number(event.target.value))}
            className="rounded-lg border border-nvx-border bg-nvx-field px-2 py-[7px] font-mono text-[11.5px] text-nvx-muted"
          >
            {BAUD_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-nvx-subtle">
            <input
              id="any-device-checkbox"
              type="checkbox"
              checked={anyDevice}
              onChange={(event) => setAnyDevice(event.target.checked)}
            />
            {t('topbar.anyDevice')}
          </label>

          <button
            type="button"
            onClick={() => void connect(baud, { anyDevice })}
            className="rounded-[9px] bg-nvx-primary px-[18px] py-2 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover"
          >
            {t('topbar.connect')}
          </button>
        </div>
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

      {phase === 'connected' && (
        <span className="inline-flex items-center gap-2 rounded-full bg-nvx-successSoft px-3 py-1.5">
          <span className="h-[7px] w-[7px] animate-nvxPulse rounded-full bg-nvx-success" />
          <span className="text-[12.5px] font-bold text-nvx-successText">
            {identity?.vehicleName ??
              (identity?.boardId !== undefined
                ? `${t('topbar.boardIdLabel')} ${identity.boardId}`
                : t('topbar.unknownBoard'))}
          </span>
          {identity?.fwVersion && (
            <span className="font-mono text-[10.5px] text-nvx-successMuted">{identity.fwVersion}</span>
          )}
        </span>
      )}

      {/* Disconnect is available whenever a session exists, not just while
          fully 'connected' — 'lost' still has an open transport/router
          (store.disconnect() works there too), so the user must be able to
          give up on a stalled link instead of being stuck until it recovers. */}
      {(phase === 'connected' || phase === 'lost') && (
        <>
          {portLabel(portInfo) && (
            <span className="rounded-lg border border-nvx-border bg-nvx-field px-2.5 py-1.5 font-mono text-[11px] text-nvx-muted">
              {portLabel(portInfo)} · {baud}
            </span>
          )}
          <button
            type="button"
            onClick={() => void disconnect()}
            className="rounded-[9px] border border-nvx-borderStrong bg-white px-[14px] py-[7px] text-[12.5px] font-semibold text-nvx-text hover:bg-nvx-field"
          >
            {t('topbar.disconnect')}
          </button>
        </>
      )}

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
