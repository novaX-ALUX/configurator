import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { STM32_DFU_PRODUCT_ID, STM32_DFU_VENDOR_ID, Stm32Dfu, type DfuFlashInfo } from '../../core/firmware/dfu'
import { parseIntelHex, type ParsedHex } from '../../core/firmware/intelhex'
import { sendEnterRomDfu } from '../../core/firmware/px4bl'
import type { FirmwareManifest } from '../../core/firmware/manifest'
import { DFU_CANCELLABLE_STEPS, createDfuFlashSession, type Stm32DfuLike } from './flashSession'
import { FlashLog } from './FlashLog'
import { formatBytes } from './firmwareUtils'

type ChipInfoState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'loaded'; info: DfuFlashInfo } | { kind: 'error'; message: string }
type LocalHexState = { kind: 'idle' } | { kind: 'error'; message: string } | { kind: 'parsed'; fileName: string; size: number; hex: ParsedHex }
type EnterDfuState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'done' } | { kind: 'error'; message: string }

/** Hoisted so `DfuFlashControls`'s `useMemo` below passes a stable reference rather than defining a new closure over `Date.now()` during render — the project's React Compiler lint rules flag calling an impure function's syntax anywhere inside a render-time closure, even one only invoked later. */
function currentTime(): number {
  return Date.now()
}

/**
 * Owns the DFU flash session once a device has actually been selected — a
 * separate component (not inlined in `DfuRecovery`) so the session is built
 * from a concrete `flasher` prop rather than a `useRef` placeholder swapped
 * in later; `DfuRecovery` only mounts this after `handleSelectDevice()`
 * resolves. `useMemo`'s `[flasher]` dependency recreates the session (fresh
 * progress/log) whenever a new device is picked. `onInFlight` reports
 * erasing/programming up to `FirmwarePage`, which is what a tab switch
 * (CSS-hidden, not unmounted — see FirmwarePage's own doc) needs to know to
 * guard against abandoning a live DFU flash.
 */
export function DfuFlashControls({ flasher, localHex, onInFlight }: { flasher: Stm32DfuLike; localHex: LocalHexState; onInFlight?: (v: boolean) => void }) {
  const { t } = useTranslation()
  const session = useMemo(() => createDfuFlashSession({ flasher, now: currentTime }), [flasher])()

  useEffect(() => {
    onInFlight?.(session.step === 'erasing' || session.step === 'programming')
  }, [session.step, onInFlight])

  function startFlash(): void {
    if (localHex.kind !== 'parsed') return
    // No `expectedFamily`: a dropped `.hex` carries no target-chip metadata of
    // its own (dfu.ts's own doc) and there is no reliable key to join it back
    // to a manifest board — `Stm32Dfu.flash()`'s capacity-only fallback for
    // an unknown family is the honest thing to do here, not a guess.
    session.prepare({ fileName: localHex.fileName, hex: localHex.hex })
  }

  const canFlash = localHex.kind === 'parsed' && session.step === 'idle'
  const progressPct = session.step === 'done' ? 100 : session.progress ? Math.round((session.progress.done / session.progress.total) * 1000) / 10 : 0

  return (
    <>
      <button
        type="button"
        disabled={!canFlash}
        onClick={startFlash}
        className="mt-3.5 w-full rounded-[9px] bg-nvx-primary px-4 py-2.5 text-[12.5px] font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {localHex.kind === 'parsed' ? t('firmware.dfuFlashButton', { fileName: localHex.fileName }) : t('firmware.dfuFlashButton', { fileName: '—' })}
      </button>

      {session.step !== 'idle' && session.step !== 'confirming' && (
        <div className="mt-3.5">
          <div className="mb-2 h-2 overflow-hidden rounded-full bg-nvx-field">
            <div className="h-full rounded-full bg-nvx-primary transition-[width]" style={{ width: `${progressPct}%` }} />
          </div>
          {(session.step === 'erasing' || session.step === 'programming') && (
            <div className="mb-2.5 flex items-center gap-2">
              <button
                type="button"
                disabled={!DFU_CANCELLABLE_STEPS.includes(session.step)}
                onClick={() => session.cancel()}
                className="rounded-[8px] border border-nvx-borderStrong bg-white px-3.5 py-1.5 text-[11.5px] font-semibold text-nvx-text hover:bg-nvx-field disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('firmware.cancel')}
              </button>
              {/* DFU has no safely-cancellable window once a flash starts (see DFU_CANCELLABLE_STEPS's own doc) — this is always disabled here, shown for parity/discoverability with Tab 1's Cancel affordance. */}
              {!DFU_CANCELLABLE_STEPS.includes(session.step) && <span className="text-[11px] text-nvx-faint">{t('firmware.cancelUnavailable')}</span>}
            </div>
          )}
          {session.step === 'failed' && (
            <div className="mb-2.5 flex items-center gap-3 rounded-[10px] border border-nvx-dangerBorder bg-nvx-dangerSoft px-3.5 py-2.5">
              <span className="text-[12px] font-semibold text-nvx-dangerHover">{session.error}</span>
              <button
                type="button"
                onClick={() => session.retry()}
                className="ml-auto flex-none rounded-[8px] bg-nvx-danger px-3 py-1.5 text-[11px] font-extrabold text-white hover:bg-nvx-dangerHover"
              >
                {t('firmware.retry')}
              </button>
            </div>
          )}
          {session.step === 'done' && <div className="mb-2.5 rounded-[10px] bg-nvx-successSoft px-3.5 py-2.5 text-[12px] font-bold text-nvx-successText">{t('firmware.doneMessage')}</div>}
          <FlashLog entries={session.log} />
        </div>
      )}

      {session.step === 'confirming' && session.target && (
        <>
          <div onClick={() => session.cancel()} className="fixed inset-0 z-[70] bg-[rgba(23,26,32,.4)]" />
          <div role="dialog" aria-modal="true" className="fixed left-1/2 top-1/2 z-[71] w-[480px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-popover">
            <div className="mb-1 font-heading text-[16px] font-bold text-nvx-text">{t('firmware.dfuConfirmTitle', { fileName: session.target.fileName })}</div>
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-nvx-dangerBorder bg-nvx-dangerSoft px-3 py-2.5 text-[12.5px] font-semibold leading-relaxed text-nvx-dangerHover">
              {t('firmware.dfuConfirmWarning')}
            </div>
            <div className="flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => session.cancel()}
                className="rounded-[9px] border border-nvx-borderStrong bg-white px-4 py-2 text-[12.5px] font-semibold text-nvx-text hover:bg-nvx-field"
              >
                {t('firmware.confirmCancel')}
              </button>
              <button type="button" onClick={() => session.confirm()} className="rounded-[9px] bg-nvx-danger px-[18px] py-2 text-[12.5px] font-bold text-white hover:bg-nvx-dangerHover">
                {t('firmware.dfuConfirmProceed')}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

/**
 * Tab 2: DFU recovery. Two independent entry points into the same STM32 ROM
 * DFU (0483:DF11) protocol — a one-click "reboot into DFU" for
 * `softwareDfuAllowed` novaX boards (F4-only; H7 bricks on this magic, see
 * px4bl.ts's `sendEnterRomDfu` doc, so this is gated on the manifest's own
 * flag rather than re-deriving an F4 check here) and a fully manual path
 * (BOOT0 + WebUSB) for an already-bricked board. Both converge on the same
 * "select a WebUSB device -> drop a `_with_bl.hex` -> confirm (full-chip
 * erase warning) -> flash" flow, owned by `DfuFlashControls` once a device
 * has been picked.
 */
export function DfuRecovery({
  manifest,
  onInFlight,
  busy = false,
}: {
  manifest: FirmwareManifest | null
  onInFlight?: (v: boolean) => void
  /** True while Tab 1's own session is running — its `rebooting` step is about to call `takeoverForFlash()`, so this tab's own transport-taking entry points (Enter DFU / Select DFU device) must not race it for the same connection. */
  busy?: boolean
}) {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const identity = useConnectionStore((s) => s.identity)

  const [enterDfuState, setEnterDfuState] = useState<EnterDfuState>({ kind: 'idle' })
  const [device, setDevice] = useState<{ label: string; flasher: Stm32DfuLike } | null>(null)
  const [chipInfo, setChipInfo] = useState<ChipInfoState>({ kind: 'idle' })
  const [selectError, setSelectError] = useState<string | null>(null)
  const [localHex, setLocalHex] = useState<LocalHexState>({ kind: 'idle' })
  const [dragOver, setDragOver] = useState(false)
  // Only ever set via `handleFlashInFlight` below (from `DfuFlashControls`,
  // which itself only exists once `device` is non-null) — there is no path
  // that clears `device` back to `null` once picked, so no separate reset is
  // needed for the "no device yet" case; it's already `false` by default.
  const [ownFlashBusy, setOwnFlashBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleFlashInFlight(v: boolean): void {
    setOwnFlashBusy(v)
    onInFlight?.(v)
  }

  // `matchedBoard.dfuRecoveryAllowed` (gen_manifest.py semantics,
  // task-1.1-brief.md) means a `_with_bl.hex` recovery image exists for this
  // board in the manifest. It is intentionally NOT consumed here: this tab
  // has no *online* recovery-image list to gate with it — both entry points
  // below converge on a *local* file drop (module doc above). The manual
  // BOOT0+local-file path is deliberately left ungated by it: BOOT0 ROM DFU
  // is a hardware-universal STM32 feature, not board-specific, and it's
  // exactly the path a bricked board with no working manifest lookup still
  // needs.
  const matchedBoard = manifest?.boards.find((b) => identity?.boardId !== undefined && b.apjBoardId === identity.boardId)
  const softwareDfuAvailable = phase === 'connected' && !!matchedBoard?.softwareDfuAllowed
  // Neither entry point may run while this tab's own DFU flash is already
  // erasing/programming (picking a new device or re-entering DFU mid-flash
  // would abandon that in-flight session with nothing left observing it —
  // see DfuFlashControls's own doc) nor while Tab 1 is busy with the
  // connection.
  const transportEntryPointsDisabled = busy || ownFlashBusy

  async function handleEnterDfu(): Promise<void> {
    setEnterDfuState({ kind: 'loading' })
    const transport = useConnectionStore.getState().takeoverForFlash()
    if (!transport) {
      setEnterDfuState({ kind: 'error', message: t('firmware.dfuEnterFailed', { message: 'not connected' }) })
      return
    }
    try {
      await sendEnterRomDfu(transport)
      setEnterDfuState({ kind: 'done' })
    } catch (err) {
      setEnterDfuState({ kind: 'error', message: t('firmware.dfuEnterFailed', { message: err instanceof Error ? err.message : String(err) }) })
    }
  }

  async function handleSelectDevice(): Promise<void> {
    setSelectError(null)
    let usbDevice: USBDevice
    try {
      usbDevice = await navigator.usb.requestDevice({ filters: [{ vendorId: STM32_DFU_VENDOR_ID, productId: STM32_DFU_PRODUCT_ID }] })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return // user dismissed the picker — not a failure worth surfacing
      setSelectError(err instanceof Error ? err.message : String(err))
      return
    }
    const flasher = new Stm32Dfu(usbDevice)
    setDevice({ label: usbDevice.productName || 'STM32 BOOTLOADER', flasher })
    setChipInfo({ kind: 'loading' })
    try {
      const info = await flasher.flashInfo()
      setChipInfo({ kind: 'loaded', info })
    } catch (err) {
      setChipInfo({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleHexFile(file: File): Promise<void> {
    try {
      const text = await file.text()
      const hex = parseIntelHex(text)
      setLocalHex({ kind: 'parsed', fileName: file.name, size: hex.totalBytes, hex })
    } catch (err) {
      setLocalHex({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="grid max-w-[900px] grid-cols-2 items-start gap-3.5">
      <div className="rounded-xl border border-nvx-border bg-white p-4.5 shadow-card">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('firmware.dfuSoftwareLabel')}</span>
          <span className="rounded-full bg-nvx-primarySoft px-2 py-0.5 text-[9.5px] font-extrabold tracking-[.06em] text-nvx-primarySoftText">{t('firmware.dfuSoftwareBadge')}</span>
        </div>
        <p className="mb-3.5 text-[12.5px] leading-relaxed text-nvx-muted">{t('firmware.dfuSoftwareBody')}</p>

        {softwareDfuAvailable ? (
          <>
            <button
              type="button"
              disabled={enterDfuState.kind === 'loading' || enterDfuState.kind === 'done' || transportEntryPointsDisabled}
              onClick={() => void handleEnterDfu()}
              className="rounded-[9px] bg-nvx-primary px-[18px] py-2.5 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('firmware.dfuEnterButton')}
            </button>
            <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-2.5 py-2 text-[11.5px] text-nvx-warningText">
              {t('firmware.dfuEnterWarning')}
            </div>
            {enterDfuState.kind === 'done' && <p className="mt-2.5 text-[11.5px] font-semibold text-nvx-successText">{t('firmware.dfuEnterDone')}</p>}
            {enterDfuState.kind === 'error' && <p className="mt-2.5 text-[11.5px] text-nvx-danger">{enterDfuState.message}</p>}
          </>
        ) : (
          <p className="text-[11.5px] text-nvx-faint">{t('firmware.dfuEnterUnavailable')}</p>
        )}
      </div>

      <div className="rounded-xl border border-nvx-border bg-white p-4.5 shadow-card">
        <div className="mb-2 text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('firmware.dfuManualLabel')}</div>
        <div className="mb-3.5 flex flex-col gap-2.5 text-[12.5px] leading-relaxed text-nvx-muted">
          <div className="flex gap-2.5">
            <span className="flex-none font-mono text-nvx-faint">1</span>
            {t('firmware.dfuStep1')}
          </div>
          <div className="flex gap-2.5">
            <span className="flex-none font-mono text-nvx-faint">2</span>
            {t('firmware.dfuStep2')}
          </div>
          <div className="flex gap-2.5">
            <span className="flex-none font-mono text-nvx-faint">3</span>
            {t('firmware.dfuStep3')}
          </div>
        </div>

        <button
          type="button"
          disabled={transportEntryPointsDisabled}
          onClick={() => void handleSelectDevice()}
          className="rounded-[9px] border border-nvx-borderStrong bg-white px-4 py-2 text-[12.5px] font-bold text-nvx-text hover:bg-nvx-field disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('firmware.dfuSelectDevice')}
        </button>
        {selectError && <p className="mt-2 text-[11.5px] text-nvx-danger">{t('firmware.dfuSelectFailed', { message: selectError })}</p>}

        {!device ? (
          <div className="mt-3.5 flex flex-col items-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed border-nvx-borderStrong px-4 py-4">
            <span className="font-mono text-[11px] text-nvx-faint">{t('firmware.dfuNoDevice')}</span>
            <span className="text-[11px] text-nvx-disabled">{t('firmware.dfuWaiting')}</span>
          </div>
        ) : (
          <div className="mt-3.5 flex flex-col gap-1.5">
            <span className="font-mono text-[12px] font-semibold text-nvx-text">{device.label}</span>
            {chipInfo.kind === 'loading' && <span className="text-[11.5px] text-nvx-muted">…</span>}
            {chipInfo.kind === 'loaded' && (
              <span className="font-mono text-[11.5px] text-nvx-muted">{t('firmware.dfuChipInfo', { family: chipInfo.info.family, flashKB: chipInfo.info.flashKB })}</span>
            )}
            {chipInfo.kind === 'error' && <span className="text-[11.5px] text-nvx-danger">{t('firmware.dfuChipInfoError', { message: chipInfo.message })}</span>}
          </div>
        )}

        <div className="mt-3.5 flex items-center gap-1.5 rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-2.5 py-2 text-[11px] text-nvx-warningText">{t('firmware.dfuZadigHint')}</div>

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
            if (file) void handleHexFile(file)
          }}
          className={`mt-3.5 flex cursor-pointer flex-col items-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed px-4 py-4 text-center ${
            dragOver ? 'border-nvx-primary bg-nvx-primarySoft' : 'border-nvx-borderStrong bg-white'
          }`}
        >
          <span className="text-[12px] font-bold text-nvx-text">{t('firmware.dfuDropTitle')}</span>
          <span className="text-[11px] text-nvx-faint">{t('firmware.dfuDropHint')}</span>
          {localHex.kind === 'parsed' && (
            <span className="font-mono text-[11px] text-nvx-primarySoftText">{t('firmware.dfuParsed', { fileName: localHex.fileName, size: formatBytes(localHex.size) })}</span>
          )}
          {localHex.kind === 'error' && <span className="text-[11.5px] text-nvx-danger">{t('firmware.dfuParseError', { message: localHex.message })}</span>}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".hex"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleHexFile(file)
            e.target.value = ''
          }}
        />

        {device && <DfuFlashControls flasher={device.flasher} localHex={localHex} onInFlight={handleFlashInFlight} />}
      </div>
    </div>
  )
}
