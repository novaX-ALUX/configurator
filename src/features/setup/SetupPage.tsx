import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { fetchErrorMessage } from '../params/paramUtils'
import { BATT_CAPACITY_FIELD, BATT_FS_LOW_FIELD, BATT_LOW_VOLT_FIELD, BATT_MONITOR_FIELD, ESC_PROTOCOL_FIELD, FRAME_FIELD, FS_GCS_FIELD, FS_THROTTLE_FIELD } from './paramEnums'
import { FrameSelector } from './FrameSelector'
import { EscProtocol } from './EscProtocol'
import { BatteryMonitor } from './BatteryMonitor'
import { Failsafes } from './Failsafes'
import { StagedReviewBar } from '../staged/StagedReviewBar'
import { useSetupStore } from './setupStore'

type LoadState = { kind: 'idle' } | { kind: 'loading'; got: number; total: number | undefined } | { kind: 'error'; message: string } | { kind: 'loaded' }

/**
 * Setup page (Task 7.2): frame/ESC/battery/failsafe fields staged against
 * `setupStore` and written together via the sticky `StagedReviewBar`. Shares
 * the connected app's single `ParamStore` with `features/params` — if that
 * page (or a prior visit to this one) already ran `fetchAll()`, values are
 * already cached and this page skips straight to the form; otherwise it
 * offers its own "Load parameters" affordance, the same fetch this page
 * needs regardless of which page triggers it (`ParamStore` has no
 * single-param fetch, only the full table).
 */
export function SetupPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const paramStore = useConnectionStore((s) => s.paramStore)

  const pending = useSetupStore((s) => s.pending)
  const writeStatus = useSetupStore((s) => s.writeStatus)
  const writing = useSetupStore((s) => s.writing)
  const stage = useSetupStore((s) => s.stage)
  const stageFrame = useSetupStore((s) => s.stageFrame)
  const revertAll = useSetupStore((s) => s.revertAll)
  const writeAll = useSetupStore((s) => s.writeAll)
  const clearForDisconnect = useSetupStore((s) => s.clearForDisconnect)

  // Gated on `fetchProgress.completed`, not `paramStore.all.size > 0` (issue
  // #20): ArduPilot re-broadcasts a changed param unprompted, so `all` can be
  // non-empty from a passive `PARAM_VALUE` with no `fetchAll()` ever having
  // run — `all.size > 0` would render this form's fields as real board
  // values (Frame/ESC/battery/failsafes) from a table that was never
  // actually pulled. Falling back to the 'idle' "Load parameters" CTA below
  // for that case, same as a never-fetched store, is the honest behavior.
  const [load, setLoad] = useState<LoadState>(() => (paramStore && paramStore.fetchProgress.completed ? { kind: 'loaded' } : { kind: 'idle' }))
  const [version, setVersion] = useState(0) // bumped on ParamStore.onChange to re-derive effective values from the live cache
  const [discardedNotice, setDiscardedNotice] = useState<number | null>(null)

  const prevParamStoreRef = useRef(paramStore)

  // A fresh ParamStore (new connect() generation) or its disappearance
  // (disconnect) resets this page's load state and clears staged setup
  // edits — they don't survive a session, same policy as ParamsPage.
  useEffect(() => {
    if (prevParamStoreRef.current === paramStore) return
    const discardedCount = prevParamStoreRef.current && pending.size > 0 ? pending.size : null
    prevParamStoreRef.current = paramStore
    setDiscardedNotice(paramStore ? null : discardedCount)
    setLoad(paramStore && paramStore.fetchProgress.completed ? { kind: 'loaded' } : { kind: 'idle' })
    clearForDisconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramStore])

  useEffect(() => {
    if (!paramStore) return
    return paramStore.onChange(() => setVersion((v) => v + 1))
  }, [paramStore])

  function valueOf(param: string): number | undefined {
    void version
    return pending.get(param)?.value ?? paramStore?.get(param)?.value
  }

  async function handleLoad(): Promise<void> {
    if (!paramStore) return
    setLoad({ kind: 'loading', got: 0, total: undefined })
    try {
      await paramStore.fetchAll({ onProgress: (got, total) => setLoad({ kind: 'loading', got, total }) })
      setLoad({ kind: 'loaded' })
    } catch (err) {
      setLoad({ kind: 'error', message: fetchErrorMessage(err, t) })
    }
  }

  if (phase !== 'connected') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        {discardedNotice !== null && (
          <div className="mb-1 max-w-[440px] rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-4 py-2 text-center text-[12px] font-semibold text-nvx-warningText">
            {t('setup.discardedOnDisconnect', { count: discardedNotice })}
          </div>
        )}
        <div className="flex h-[74px] w-[74px] items-center justify-center rounded-[22px] border border-nvx-border bg-white text-nvx-faint shadow-card">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h15" />
            <circle cx="9.5" cy="7.5" r="2" fill="#FFFFFF" />
            <circle cx="15" cy="12" r="2" fill="#FFFFFF" />
            <circle cx="8" cy="16.5" r="2" fill="#FFFFFF" />
          </svg>
        </div>
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('setup.notConnectedTitle')}</div>
        <div className="max-w-[400px] text-center text-[13px] leading-relaxed text-nvx-muted">{t('setup.notConnectedBody')}</div>
        <button
          type="button"
          disabled={phase !== 'disconnected'}
          onClick={() => void connect(baud)}
          className="rounded-[10px] bg-nvx-primary px-[22px] py-2.5 text-[13px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('setup.connectCta')}
        </button>
      </div>
    )
  }

  if (load.kind === 'idle') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.setup')}</div>
        <button
          type="button"
          onClick={() => void handleLoad()}
          className="rounded-[10px] bg-nvx-primary px-[22px] py-2.5 text-[13px] font-bold text-white hover:bg-nvx-primaryHover"
        >
          {t('params.loadCta')}
        </button>
      </div>
    )
  }

  if (load.kind === 'loading') {
    const pct = load.total !== undefined ? Math.min(100, Math.round((load.got / load.total) * 100)) : undefined
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-5">
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.setup')}</div>
        <div className="font-mono text-[12px] text-nvx-muted">
          {load.total !== undefined ? t('params.loading', { got: load.got, total: load.total }) : t('params.loadingIndeterminate')}
        </div>
        <div className="h-2 w-[280px] overflow-hidden rounded-full bg-nvx-field">
          <div
            className="h-full animate-nvxBar rounded-full bg-nvx-primary bg-[length:28px_100%] bg-[repeating-linear-gradient(45deg,rgba(255,255,255,.3)_0,rgba(255,255,255,.3)_10px,transparent_10px,transparent_20px)]"
            style={{ width: pct !== undefined ? `${pct}%` : '35%' }}
          />
        </div>
      </div>
    )
  }

  if (load.kind === 'error') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-5">
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.setup')}</div>
        <div role="alert" className="max-w-[440px] text-center text-[13px] text-nvx-danger">
          {load.message}
        </div>
        <button
          type="button"
          onClick={() => void handleLoad()}
          className="rounded-[9px] border border-nvx-borderStrong bg-white px-4 py-2 text-[12.5px] font-bold text-nvx-text hover:bg-nvx-field"
        >
          {t('params.retry')}
        </button>
      </div>
    )
  }

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <div className="mx-auto max-w-[1020px]">
        <div className="mb-1 flex items-baseline">
          <span className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.setup')}</span>
          <span className="ml-auto text-[12px] text-nvx-faint">{t('setup.subtitleNote')}</span>
        </div>
        <div className="mb-4 text-[12.5px] text-nvx-subtle">{t('setup.subtitleBody')}</div>

        <FrameSelector
          frameClassValue={valueOf(FRAME_FIELD.params[0])}
          frameTypeValue={valueOf(FRAME_FIELD.params[1])}
          onSelect={(opt) => stageFrame(opt.frameClass, opt.frameType, t(opt.labelKey))}
        />
        <EscProtocol value={valueOf(ESC_PROTOCOL_FIELD.param)} onSelect={(v, label) => stage(ESC_PROTOCOL_FIELD.param, v, label)} />
        <BatteryMonitor
          monitorValue={valueOf(BATT_MONITOR_FIELD.param)}
          onMonitorChange={(v, label) => stage(BATT_MONITOR_FIELD.param, v, label)}
          capacityValue={valueOf(BATT_CAPACITY_FIELD.param)}
          onCapacityChange={(v, label) => stage(BATT_CAPACITY_FIELD.param, v, label)}
          lowVoltValue={valueOf(BATT_LOW_VOLT_FIELD.param)}
          onLowVoltChange={(v, label) => stage(BATT_LOW_VOLT_FIELD.param, v, label)}
        />
        <Failsafes
          throttleValue={valueOf(FS_THROTTLE_FIELD.param)}
          onThrottleChange={(v, label) => stage(FS_THROTTLE_FIELD.param, v, label)}
          battLowValue={valueOf(BATT_FS_LOW_FIELD.param)}
          onBattLowChange={(v, label) => stage(BATT_FS_LOW_FIELD.param, v, label)}
          gcsValue={valueOf(FS_GCS_FIELD.param)}
          onGcsChange={(v, label) => stage(FS_GCS_FIELD.param, v, label)}
        />

        {pending.size > 0 && (
          <StagedReviewBar
            pending={pending}
            writeStatus={writeStatus}
            writing={writing}
            onWrite={() => paramStore && void writeAll(paramStore)}
            onRevert={revertAll}
          />
        )}
      </div>
    </div>
  )
}
