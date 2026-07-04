import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { useNavigationStore } from '../../store/navigation'
import { fetchManifest, type BoardFirmware, type FirmwareFile, type FirmwareManifest } from '../../core/firmware/manifest'
import { parseApj, type ParsedApj } from '../../core/firmware/apj'
import { FlashLog } from './FlashLog'
import { DfuRecovery } from './DfuRecovery'
import { CANCELLABLE_STEPS, useFlashSession, type FlashStep, type FlashTarget } from './flashSession'
import { formatBytes } from './firmwareUtils'

type ManifestLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'loaded'; manifest: FirmwareManifest }

type LocalApjState = { kind: 'idle' } | { kind: 'error'; message: string } | { kind: 'parsed'; fileName: string; size: number; apj: ParsedApj }

/**
 * Fixed display order for Tab 1's step indicator. `downloading`/`verifying`
 * only apply to an online source (a local `.apj` drop is already parsed —
 * see `flashSession.ts`'s own doc) — `visibleSteps` below filters them out
 * for a local target so the indicator never shows two steps that will never
 * run.
 */
const NORMAL_STEP_ORDER: { step: FlashStep; labelKey: string }[] = [
  { step: 'downloading', labelKey: 'firmware.stepDownload' },
  { step: 'verifying', labelKey: 'firmware.stepVerify' },
  { step: 'rebooting', labelKey: 'firmware.stepReboot' },
  { step: 'connecting', labelKey: 'firmware.stepReconnect' },
  { step: 'identifying', labelKey: 'firmware.stepIdentify' },
  { step: 'erasing', labelKey: 'firmware.stepErase' },
  { step: 'programming', labelKey: 'firmware.stepProgram' },
  { step: 'verifying-flash', labelKey: 'firmware.stepVerifyFlash' },
]

/** Steps a flash session is actively running through — leaving the page or closing the tab here risks a bricked/half-flashed board, so this drives both the nav guard and the `beforeunload` guard. */
const IN_FLIGHT_STEPS: readonly FlashStep[] = ['downloading', 'verifying', 'rebooting', 'connecting', 'identifying', 'erasing', 'programming', 'verifying-flash']

/** The manifest lists apj/other/with_bl_hex per board (task 1.2's contract) — the normal-update engine (`Px4Flasher`) always wants the `.apj`. */
function apjFile(board: BoardFirmware): FirmwareFile | undefined {
  return board.files.find((f) => f.kind === 'apj')
}

function stepIndex(steps: { step: FlashStep }[], step: FlashStep | null): number {
  if (!step) return -1
  return steps.findIndex((s) => s.step === step)
}

export function FirmwarePage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'normal' | 'dfu'>('normal')
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const identity = useConnectionStore((s) => s.identity)
  const setGuardNavigation = useNavigationStore((s) => s.setGuardNavigation)

  const session = useFlashSession()

  const [manifestLoad, setManifestLoad] = useState<ManifestLoad>({ kind: 'loading' })
  const [selectedBoard, setSelectedBoard] = useState<BoardFirmware | null>(null)
  const [localApj, setLocalApj] = useState<LocalApjState>({ kind: 'idle' })
  const [dragOver, setDragOver] = useState(false)
  const [dfuInFlight, setDfuInFlight] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadManifest()
    // Intentionally once on mount — the retry button re-invokes this directly.
  }, [])

  async function loadManifest(): Promise<void> {
    setManifestLoad({ kind: 'loading' })
    try {
      const manifest = await fetchManifest()
      setManifestLoad({ kind: 'loaded', manifest })
    } catch (err) {
      setManifestLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // Covers both tabs: Tab 1's own session (module singleton, survives a tab
  // switch on its own) and Tab 2's, which is owned by `DfuFlashControls` and
  // reported up via `onInFlight` since it unmounts on a tab switch otherwise.
  const inFlight = IN_FLIGHT_STEPS.includes(session.step) || dfuInFlight

  // Unsaved-edits-style guard, mirroring ParamsPage: a flash session that has
  // started (past the safely-cancellable confirm dialog) must not be
  // abandoned by switching pages — flashSession.ts's own CANCELLABLE_STEPS
  // doc explains why erasing/programming/verifying-flash can't be
  // interrupted, which is exactly why leaving here is dangerous.
  useEffect(() => {
    if (!inFlight) {
      setGuardNavigation(null)
      return
    }
    setGuardNavigation(() => window.confirm(t('firmware.leaveConfirm')))
    return () => setGuardNavigation(null)
  }, [inFlight, setGuardNavigation, t])

  // Browser-tab-close guard for the same reason.
  useEffect(() => {
    if (!inFlight) return
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [inFlight])

  // Switching between Tab 1/Tab 2 doesn't unmount either (see the render
  // below — both stay mounted, only hidden via CSS) specifically so a
  // background DFU flash keeps running, but the confirm-before-leaving
  // guard above only covers navigating to a *different page*; guard the
  // tab click itself too.
  function handleTabChange(next: 'normal' | 'dfu'): void {
    if (next === tab) return
    if (inFlight && !window.confirm(t('firmware.leaveConfirm'))) return
    setTab(next)
  }

  async function handleApjFile(file: File): Promise<void> {
    try {
      const buf = await file.arrayBuffer()
      const apj = await parseApj(buf)
      setLocalApj({ kind: 'parsed', fileName: file.name, size: apj.imageSize, apj })
    } catch (err) {
      setLocalApj({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  function startOnlineUpdate(): void {
    if (!selectedBoard) return
    const file = apjFile(selectedBoard)
    if (!file) return
    const target: FlashTarget = {
      boardName: selectedBoard.boardName,
      version: selectedBoard.version,
      apjBoardId: selectedBoard.apjBoardId,
      source: { kind: 'online', board: selectedBoard, file },
    }
    session.prepare(target)
  }

  function startLocalUpdate(): void {
    if (localApj.kind !== 'parsed') return
    const matched = manifestLoad.kind === 'loaded' ? manifestLoad.manifest.boards.find((b) => b.apjBoardId === localApj.apj.boardId) : undefined
    const target: FlashTarget = {
      boardName: matched?.boardName ?? t('firmware.localBoardName', { boardId: localApj.apj.boardId }),
      version: matched?.version ?? localApj.fileName,
      apjBoardId: localApj.apj.boardId,
      source: { kind: 'local', fileName: localApj.fileName, apj: localApj.apj },
    }
    session.prepare(target)
  }

  const visibleSteps = NORMAL_STEP_ORDER.filter((s) => {
    if (session.target?.source.kind !== 'local') return true
    return s.step !== 'downloading' && s.step !== 'verifying'
  })
  const curIdx = stepIndex(visibleSteps, session.step)
  const failIdx = stepIndex(visibleSteps, session.failedStep)
  const progressPct =
    session.step === 'done'
      ? 100
      : session.progress
        ? Math.min(100, Math.round((session.progress.done / session.progress.total) * 100))
        : 0

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <FirmwareHeader t={t} tab={tab} setTab={handleTabChange} />

      {/* Both tab bodies stay mounted (hidden via CSS, not unmounted) so a
          live flash session in the inactive tab is never silently killed by
          switching tabs — see the tab-switch guard above. */}
      <div className={tab === 'dfu' ? 'hidden' : undefined}>
      <div className="max-w-[900px]">
        {phase === 'connected' ? (
          <div className="mb-3.5 flex items-center gap-3 rounded-xl border border-nvx-border bg-white px-4 py-3 shadow-card">
            <span className="text-[13.5px] font-extrabold text-nvx-text">
              {t('firmware.connectedAs', { board: identity?.vehicleName ?? t('topbar.unknownBoard'), boardId: identity?.boardId ?? '—' })}
            </span>
          </div>
        ) : (
          <div className="mb-3.5 flex items-center gap-3 rounded-xl border border-dashed border-nvx-borderStrong bg-white px-4 py-4">
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-bold text-nvx-text">{t('firmware.connectNote')}</span>
            </span>
            <button
              type="button"
              // `inFlight` also covers Tab 2's DFU session: `takeoverForFlash()`
              // drops `phase` to 'disconnected' the instant either flow takes
              // the transport, which would otherwise make this button look
              // clickable while a flash (of either kind) is actually running —
              // starting a second, concurrent `connect()` here would race the
              // flash session for the same port.
              disabled={phase !== 'disconnected' || inFlight}
              onClick={() => void connect(baud)}
              className="ml-auto flex-none rounded-[9px] bg-nvx-primary px-4 py-2.5 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('firmware.connectCta')}
            </button>
          </div>
        )}

        {/* Online list — decisions-m1.md: never filtered/hidden by identity. Every board is always listed; a connected board's matching entry is only highlighted. */}
        <div className="mb-3.5 flex flex-col gap-2">
          {manifestLoad.kind === 'loading' && <p className="text-[12.5px] text-nvx-muted">{t('firmware.onlineLoading')}</p>}
          {manifestLoad.kind === 'error' && (
            <div className="flex flex-col gap-2 rounded-xl border border-nvx-dangerBorder bg-nvx-dangerSoft px-4 py-3">
              <span className="text-[12.5px] font-semibold text-nvx-dangerHover">{t('firmware.onlineError', { message: manifestLoad.message })}</span>
              <span className="text-[12px] text-nvx-muted">{t('firmware.onlineErrorNote')}</span>
              <button
                type="button"
                onClick={() => void loadManifest()}
                className="self-start rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-1.5 text-[12px] font-bold text-nvx-text hover:bg-nvx-field"
              >
                {t('firmware.onlineRetry')}
              </button>
            </div>
          )}
          {manifestLoad.kind === 'loaded' &&
            (manifestLoad.manifest.boards.length === 0 ? (
              <p className="text-[12.5px] text-nvx-muted">{t('firmware.onlineEmpty')}</p>
            ) : (
              manifestLoad.manifest.boards.map((b) => {
                const recommended = identity?.boardId !== undefined && identity.boardId === b.apjBoardId
                const selected = selectedBoard?.apjBoardId === b.apjBoardId && selectedBoard.version === b.version
                const file = apjFile(b)
                return (
                  <button
                    key={`${b.apjBoardId}-${b.version}`}
                    type="button"
                    onClick={() => setSelectedBoard(b)}
                    aria-pressed={selected}
                    className={`flex items-center gap-3 rounded-[11px] border-[1.5px] px-4 py-3 text-left ${
                      selected ? 'border-nvx-primary bg-nvx-primarySoft' : 'border-nvx-border bg-white hover:bg-nvx-field'
                    }`}
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[13px] font-bold text-nvx-text">
                          {b.boardName} {b.version}
                        </span>
                        {recommended && (
                          <span className="rounded-full bg-nvx-primarySoft px-2 py-0.5 text-[9.5px] font-extrabold tracking-[.06em] text-nvx-primarySoftText">
                            {t('firmware.recommended')}
                          </span>
                        )}
                      </span>
                      {file && <span className="font-mono text-[10.5px] text-nvx-faint">{t('firmware.fileMeta', { fileName: file.name, size: formatBytes(file.size) })}</span>}
                    </span>
                    <span className="ml-auto flex-none font-mono text-[11px] text-nvx-faint">{b.mcuFamily}</span>
                  </button>
                )
              })
            ))}
        </div>

        {/* Local .apj drop zone — always available, independent of the manifest's load state. */}
        <div className="mb-3.5">
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const file = e.dataTransfer.files[0]
              if (file) void handleApjFile(file)
            }}
            className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-[1.5px] border-dashed px-4 py-4 text-center ${
              dragOver ? 'border-nvx-primary bg-nvx-primarySoft' : 'border-nvx-borderStrong bg-white'
            }`}
          >
            <span className="text-[12.5px] font-bold text-nvx-text">{t('firmware.localTitle')}</span>
            <span className="text-[11.5px] text-nvx-faint">{t('firmware.localDropHint')}</span>
            <span className="text-[10.5px] text-nvx-faint">{t('firmware.localChecksumNote')}</span>
            {localApj.kind === 'parsed' && (
              <span className="font-mono text-[11px] text-nvx-primarySoftText">
                {localApj.fileName} · {t('firmware.localParsed', { boardId: localApj.apj.boardId, size: formatBytes(localApj.size) })}
              </span>
            )}
            {localApj.kind === 'error' && <span className="text-[11.5px] text-nvx-danger">{t('firmware.localParseError', { message: localApj.message })}</span>}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".apj"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleApjFile(file)
              e.target.value = ''
            }}
          />
        </div>

        {/* Action + progress card */}
        <div className="rounded-xl border border-nvx-border bg-white p-4 shadow-card">
          <div className="mb-3 flex items-center gap-3">
            {session.step !== 'idle' && session.target ? (
              // A session is actually running (or just finished/failed) — the
              // label must reflect what it's really flashing, not whatever
              // the list/drop-zone selection happens to be at this instant
              // (the user is free to click around the still-live list while
              // a flash of a *different* selection runs).
              <button type="button" disabled className="rounded-[10px] bg-nvx-primary px-5 py-2.5 text-[13px] font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-50">
                {t('firmware.updateButton', { board: session.target.boardName, version: session.target.version })}
              </button>
            ) : localApj.kind === 'parsed' && !selectedBoard ? (
              <button
                type="button"
                // `dfuInFlight`: don't let Tab 1 take over the connection
                // (its `rebooting` step) while Tab 2's DFU flash is using it.
                disabled={phase !== 'connected' || dfuInFlight}
                onClick={startLocalUpdate}
                className="rounded-[10px] bg-nvx-primary px-5 py-2.5 text-[13px] font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('firmware.updateButton', { board: t('firmware.localBoardName', { boardId: localApj.apj.boardId }), version: localApj.fileName })}
              </button>
            ) : (
              <button
                type="button"
                disabled={!selectedBoard || phase !== 'connected' || dfuInFlight}
                onClick={startOnlineUpdate}
                className="rounded-[10px] bg-nvx-primary px-5 py-2.5 text-[13px] font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {selectedBoard ? t('firmware.updateButton', { board: selectedBoard.boardName, version: selectedBoard.version }) : t('firmware.updateButton', { board: '—', version: '—' })}
              </button>
            )}
          </div>

          {session.step !== 'idle' && (
            <>
              <div className="mb-2.5 flex flex-wrap gap-3 font-mono text-[11px]">
                {visibleSteps.map((s, i) => {
                  const tone =
                    session.step === 'done'
                      ? 'done'
                      : session.step === 'failed'
                        ? i < failIdx
                          ? 'done'
                          : i === failIdx
                            ? 'failed'
                            : 'pending'
                        : i < curIdx
                          ? 'done'
                          : i === curIdx
                            ? 'active'
                            : 'pending'
                  const cls =
                    tone === 'failed'
                      ? 'text-nvx-danger'
                      : tone === 'done'
                        ? 'text-nvx-successText'
                        : tone === 'active'
                          ? 'text-nvx-primarySoftText'
                          : 'text-nvx-faint'
                  return (
                    <span key={s.step} className={`font-semibold ${cls}`}>
                      {i + 1} {t(s.labelKey)}
                    </span>
                  )
                })}
                <span className="ml-auto font-semibold text-nvx-text">{progressPct}%</span>
              </div>
              <div className="mb-3 h-2 overflow-hidden rounded-full bg-nvx-field">
                <div className="h-full rounded-full bg-nvx-primary transition-[width]" style={{ width: `${progressPct}%` }} />
              </div>

              {IN_FLIGHT_STEPS.includes(session.step) && (
                <div className="mb-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!CANCELLABLE_STEPS.includes(session.step)}
                    onClick={() => session.cancel()}
                    className="rounded-[8px] border border-nvx-borderStrong bg-white px-3.5 py-1.5 text-[11.5px] font-semibold text-nvx-text hover:bg-nvx-field disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('firmware.cancel')}
                  </button>
                  {!CANCELLABLE_STEPS.includes(session.step) && <span className="text-[11px] text-nvx-faint">{t('firmware.cancelUnavailable')}</span>}
                </div>
              )}

              {session.step === 'failed' && (
                <div className="mb-2.5 flex items-center gap-3 rounded-[10px] border border-nvx-dangerBorder bg-nvx-dangerSoft px-3.5 py-2.5">
                  <span className="text-[12.5px] font-semibold leading-relaxed text-nvx-dangerHover">
                    {t('firmware.failedAt', { step: session.failedStep ? t(NORMAL_STEP_ORDER.find((s) => s.step === session.failedStep)?.labelKey ?? '') : '', message: session.error })}
                    <br />
                    {session.disconnected ? t('firmware.disconnectedHint') : t('firmware.safeRetryHint')}
                  </span>
                  <button
                    type="button"
                    onClick={() => session.retry()}
                    className="ml-auto flex-none rounded-[8px] bg-nvx-danger px-3.5 py-2 text-[11.5px] font-extrabold text-white hover:bg-nvx-dangerHover"
                  >
                    {t('firmware.retry')}
                  </button>
                </div>
              )}
              {session.step === 'done' && (
                <div className="mb-2.5 flex items-center gap-3 rounded-[10px] bg-nvx-successSoft px-3.5 py-2.5">
                  <span className="text-[12.5px] font-bold text-nvx-successText">{t('firmware.doneMessage')}</span>
                  <button
                    type="button"
                    onClick={() => session.reset()}
                    className="ml-auto flex-none rounded-[8px] border border-nvx-success px-3 py-1.5 text-[11.5px] font-bold text-nvx-successText hover:bg-nvx-successSoft"
                  >
                    {t('firmware.doneClose')}
                  </button>
                </div>
              )}

              <FlashLog entries={session.log} />
            </>
          )}
        </div>
      </div>

      {session.step === 'confirming' && session.target && (
        <>
          <div onClick={() => session.cancel()} className="fixed inset-0 z-[70] bg-[rgba(23,26,32,.4)]" />
          <div role="dialog" aria-modal="true" className="fixed left-1/2 top-1/2 z-[71] w-[480px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-popover">
            <div className="mb-1 font-heading text-[16px] font-bold text-nvx-text">
              {t('firmware.confirmTitle', { board: session.target.boardName, version: session.target.version })}
            </div>
            <div className="mb-4 text-[12.5px] leading-relaxed text-nvx-muted">{t('firmware.confirmBody')}</div>
            <div className="flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => session.cancel()}
                className="rounded-[9px] border border-nvx-borderStrong bg-white px-4 py-2 text-[12.5px] font-semibold text-nvx-text hover:bg-nvx-field"
              >
                {t('firmware.confirmCancel')}
              </button>
              <button type="button" onClick={() => session.confirm()} className="rounded-[9px] bg-nvx-primary px-[18px] py-2 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover">
                {t('firmware.confirmProceed')}
              </button>
            </div>
          </div>
        </>
      )}
      </div>

      <div className={tab === 'normal' ? 'hidden' : undefined}>
        <DfuRecovery
          manifest={manifestLoad.kind === 'loaded' ? manifestLoad.manifest : null}
          onInFlight={setDfuInFlight}
          // Tab 1's own session is running (its `rebooting` step is about to
          // take over the connection) — Tab 2's transport-taking entry points
          // (Enter DFU / Select DFU device) must not race it for the same
          // `takeoverForFlash()` call.
          busy={IN_FLIGHT_STEPS.includes(session.step)}
        />
      </div>
    </div>
  )
}

function FirmwareHeader({ t, tab, setTab }: { t: (key: string) => string; tab: 'normal' | 'dfu'; setTab: (tab: 'normal' | 'dfu') => void }) {
  return (
    <>
      <div className="mb-3 flex items-baseline">
        <span className="font-heading text-[19px] font-bold text-nvx-text">{t('firmware.title')}</span>
        <span className="ml-auto text-[12px] text-nvx-faint">{t('firmware.subtitle')}</span>
      </div>
      <div className="mb-4 inline-flex rounded-[11px] bg-nvx-field p-[3px]">
        <button
          type="button"
          onClick={() => setTab('normal')}
          className={`rounded-[9px] px-[18px] py-2 text-[12.5px] font-bold ${tab === 'normal' ? 'bg-white text-nvx-text shadow-card' : 'text-nvx-muted'}`}
        >
          {t('firmware.tabNormal')}
        </button>
        <button
          type="button"
          onClick={() => setTab('dfu')}
          className={`rounded-[9px] px-[18px] py-2 text-[12.5px] font-bold ${tab === 'dfu' ? 'bg-white text-nvx-text shadow-card' : 'text-nvx-muted'}`}
        >
          {t('firmware.tabDfu')}
        </button>
      </div>
    </>
  )
}
