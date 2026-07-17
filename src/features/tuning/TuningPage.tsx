import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { loadParamMetadata, lookupParamMeta, type LoadedParamMetadata, type ParamMetaEntry } from '../../core/paramMetadata'
import { rebootFlightController } from '../../core/mavlink/reboot'
import { batchNeedsReboot, fetchErrorMessage } from '../params/paramUtils'
import { StagedReviewBar } from '../staged/StagedReviewBar'
import { useTuningStore } from './tuningStore'
import { TUNING_CARDS } from './tuningFields'
import { TuningSlider } from './TuningSlider'
import { InitialTuneCalculator } from './InitialTuneCalculator'

type LoadState = { kind: 'idle' } | { kind: 'loading'; got: number; total: number | undefined } | { kind: 'error'; message: string } | { kind: 'loaded' }

/**
 * Tuning page (issue #35, PRD #32 ticket 1): Extended Tuning's Rate /
 * Stabilize / Filters cards plus the initial-tune calculator, all staged
 * against `tuningStore` and written together via the sticky
 * `StagedReviewBar` — the Review Gate of ADR-0003, no input event ever
 * writes. Connection/load gating mirrors `SetupPage` (same shared
 * `ParamStore`, same full-table fetch); slider ranges/steps/units and the
 * post-Apply reboot-required banner come from the bundled parameter
 * metadata, fetched the same way as `ParamsPage`.
 */
export function TuningPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const paramStore = useConnectionStore((s) => s.paramStore)
  const session = useConnectionStore((s) => s.session)
  const identity = useConnectionStore((s) => s.identity)

  const pending = useTuningStore((s) => s.pending)
  const writeStatus = useTuningStore((s) => s.writeStatus)
  const writing = useTuningStore((s) => s.writing)
  const stage = useTuningStore((s) => s.stage)
  const stageMany = useTuningStore((s) => s.stageMany)
  const revertAll = useTuningStore((s) => s.revertAll)
  const writeAll = useTuningStore((s) => s.writeAll)
  const clearForDisconnect = useTuningStore((s) => s.clearForDisconnect)

  // Same issue-#20 gate as SetupPage: only a completed `fetchAll()` counts as
  // loaded — a passively broadcast PARAM_VALUE must not render slider values.
  const [load, setLoad] = useState<LoadState>(() => (paramStore && paramStore.fetchProgress.completed ? { kind: 'loaded' } : { kind: 'idle' }))
  const [version, setVersion] = useState(0) // bumped on ParamStore.onChange to re-derive effective values from the live cache
  const [discardedNotice, setDiscardedNotice] = useState<number | null>(null)
  const [meta, setMeta] = useState<LoadedParamMetadata | null>(null)
  const [rebootBanner, setRebootBanner] = useState(false)
  const [rebooting, setRebooting] = useState(false)

  const prevParamStoreRef = useRef(paramStore)

  // A fresh ParamStore (new connect() generation) or its disappearance
  // (disconnect) resets this page's session state and discards staged edits
  // with a visible notice — same policy as SetupPage/ParamsPage.
  useEffect(() => {
    if (prevParamStoreRef.current === paramStore) return
    const discardedCount = prevParamStoreRef.current && pending.size > 0 ? pending.size : null
    prevParamStoreRef.current = paramStore
    setDiscardedNotice(paramStore ? null : discardedCount)
    setLoad(paramStore && paramStore.fetchProgress.completed ? { kind: 'loaded' } : { kind: 'idle' })
    setMeta(null)
    setRebootBanner(false)
    setRebooting(false)
    clearForDisconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramStore])

  useEffect(() => {
    if (!paramStore) return
    return paramStore.onChange(() => setVersion((v) => v + 1))
  }, [paramStore])

  // Same-origin lazy metadata fetch after connect — ParamsPage's pattern:
  // additive documentation, a failure never blocks the page (sliders then
  // fall back to read-only rows, since a range is required to render one).
  useEffect(() => {
    if (!paramStore) return
    let cancelled = false
    loadParamMetadata(identity?.fwVersion)
      .then((result) => {
        if (!cancelled) setMeta(result)
      })
      .catch(() => {
        if (!cancelled) setMeta(null)
      })
    return () => {
      cancelled = true
    }
  }, [paramStore, identity?.fwVersion])

  function metaOf(param: string): ParamMetaEntry | undefined {
    return meta ? lookupParamMeta(meta.table, param) : undefined
  }

  function currentOf(param: string): number | undefined {
    void version
    return paramStore?.get(param)?.value
  }

  /** Effective value for a slider: staged overlay wins over the live cache — the ParamStore stays the single source of truth for current values. */
  function valueOf(param: string): number | undefined {
    return pending.get(param)?.value ?? currentOf(param)
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

  async function handleWrite(): Promise<void> {
    if (!paramStore) return
    const names = [...pending.keys()]
    await writeAll(paramStore)
    // A name still carrying a non-'ok' status failed and stayed pending;
    // everything else in the batch was written (its 'ok' chip may have
    // already cleared). Only written params can demand the reboot banner.
    const statusAfter = useTuningStore.getState().writeStatus
    const written = names.filter((name) => {
      const status = statusAfter.get(name)
      return !status || status.kind === 'ok'
    })
    if (batchNeedsReboot(written, meta ? (name) => lookupParamMeta(meta.table, name) : undefined)) setRebootBanner(true)
  }

  async function handleReboot(): Promise<void> {
    if (!session) return
    if (!window.confirm(t('params.rebootConfirm'))) return
    setRebooting(true)
    try {
      await rebootFlightController(session)
    } finally {
      setRebooting(false)
      setRebootBanner(false)
    }
  }

  if (phase !== 'connected') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        {discardedNotice !== null && (
          <div className="mb-1 max-w-[440px] rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-4 py-2 text-center text-[12px] font-semibold text-nvx-warningText">
            {t('tuning.discardedOnDisconnect', { count: discardedNotice })}
          </div>
        )}
        <div className="flex h-[74px] w-[74px] items-center justify-center rounded-[22px] border border-nvx-border bg-white text-nvx-faint shadow-card">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M7 4.5v15M12 4.5v15M17 4.5v15" />
            <circle cx="7" cy="14.5" r="2" fill="#FFFFFF" />
            <circle cx="12" cy="8.5" r="2" fill="#FFFFFF" />
            <circle cx="17" cy="12" r="2" fill="#FFFFFF" />
          </svg>
        </div>
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('tuning.notConnectedTitle')}</div>
        <div className="max-w-[400px] text-center text-[13px] leading-relaxed text-nvx-muted">{t('tuning.notConnectedBody')}</div>
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
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.tuning')}</div>
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
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.tuning')}</div>
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
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.tuning')}</div>
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
          <span className="font-heading text-[19px] font-bold text-nvx-text">{t('nav.tuning')}</span>
          <span className="ml-auto text-[12px] text-nvx-faint">{t('tuning.subtitleNote')}</span>
        </div>
        <div className="mb-4 text-[12.5px] text-nvx-subtle">{t('tuning.subtitleBody')}</div>

        {rebootBanner && (
          <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-3.5 py-2.5 text-[12px] text-nvx-warningText opacity-100 transition-opacity duration-200 ease-out motion-reduce:transition-none [@starting-style]:opacity-0">
            <span className="flex-1 font-semibold">{t('params.rebootBannerText')}</span>
            <button
              type="button"
              onClick={() => void handleReboot()}
              disabled={!session || rebooting}
              className="flex-none rounded-[9px] bg-nvx-primary px-3.5 py-1.5 text-[12px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rebooting ? t('params.rebooting') : t('params.rebootCta')}
            </button>
          </div>
        )}

        {TUNING_CARDS.map((card) => (
          <section key={card.key} className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
            <div className="mb-3.5 flex items-center">
              <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t(card.titleKey)}</span>
            </div>
            <div className="flex flex-col gap-3.5">
              {card.sections.map((section, i) => (
                <div key={section.labelKey ?? i}>
                  {section.labelKey !== undefined && (
                    <div className="mb-2 text-[11px] font-bold uppercase tracking-[.08em] text-nvx-faint">{t(section.labelKey)}</div>
                  )}
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-3">
                    {section.params.map((param) => (
                      <TuningSlider
                        key={param}
                        param={param}
                        meta={metaOf(param)}
                        value={valueOf(param)}
                        staged={pending.has(param)}
                        onCommit={(value, label) => stage(param, value, label)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}

        <InitialTuneCalculator currentOf={currentOf} metaOf={metaOf} onStage={stageMany} />

        {pending.size > 0 && (
          <StagedReviewBar
            pending={pending}
            writeStatus={writeStatus}
            writing={writing}
            onWrite={() => void handleWrite()}
            onRevert={revertAll}
          />
        )}
      </div>
    </div>
  )
}
