import { useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { useNavigationStore } from '../../store/navigation'
import {
  ParamCountDriftError,
  ParamFetchError,
  ParamFetchNoResponseError,
  ParamPrecisionLossError,
  ParamStoreDisposedError,
  ParamWriteBusyError,
  ParamWriteMismatchError,
  ParamWriteTimeoutError,
} from '../../core/mavlink/params'
import { ParamRow } from './ParamRow'
import { DiffDrawer, type DiffRowStatus } from './DiffDrawer'
import { filterParams, paginate, paramPageSize, topGroups, totalPages } from './paramUtils'

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; got: number; total: number | undefined }
  | { kind: 'error'; message: string }
  | { kind: 'loaded' }

/** Top ~12 groups by count (task brief), plus an "All" chip the component adds itself. */
const GROUP_CHIP_MAX = 12

// ParamFetchBusyError (a second concurrent fetchAll()) isn't special-cased
// here: handleLoad's only callers are the idle/error states' own buttons,
// neither of which renders while a fetch is already in flight, so this UI
// has no path that can ever trigger it — it falls through to the generic
// message below, same treatment DiffDrawer's own 'busy'/'precision'
// statuses get for the equivalent reason (see writeErrorStatus below).
function fetchErrorMessage(err: unknown, t: TFunction): string {
  if (err instanceof ParamFetchNoResponseError) return t('params.errorNoResponse')
  if (err instanceof ParamFetchError) return t('params.errorMissing', { count: err.missing.length })
  if (err instanceof ParamCountDriftError) return t('params.errorDrift')
  return t('params.errorGeneric', { message: err instanceof Error ? err.message : String(err) })
}

// ParamWriteBusyError/ParamPrecisionLossError are handled for completeness
// (DiffDrawer knows how to render them) but are effectively unreachable
// through this page today: handleWriteAll only ever has one set() in
// flight per name at a time (sequential loop), and ParamRow already blocks
// precision-losing input before it's ever staged (paramUtils.wouldLosePrecision).
// If writes are ever parallelized, or staging validation changes, that
// invariant is what would make these reachable.
function writeErrorStatus(err: unknown): DiffRowStatus {
  if (err instanceof ParamWriteMismatchError) return { kind: 'mismatch', requested: err.requested, actual: err.actual }
  if (err instanceof ParamWriteTimeoutError) return { kind: 'timeout' }
  if (err instanceof ParamWriteBusyError) return { kind: 'busy' }
  if (err instanceof ParamPrecisionLossError) return { kind: 'precision' }
  return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
}

/** Removes `key` from a `Map`, returning the same reference untouched if it was already absent (cheap no-op for React state setters). */
function withoutKey<V>(map: Map<string, V>, key: string): Map<string, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

/**
 * Full parameter table: fetch (with progress + distinguishable errors),
 * search/group filter, pagination (page size 100, no virtualization — M1
 * cut per the task brief), staged edits with a diff-before-write drawer,
 * and two safety nets: a nav-store guard blocking navigation away with
 * unsaved edits, and a clear-with-warning on disconnect (edits don't
 * survive a session, so keeping them staged after teardown would be a lie).
 */
export function ParamsPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const paramStore = useConnectionStore((s) => s.paramStore)
  const setGuardNavigation = useNavigationStore((s) => s.setGuardNavigation)

  // Lazy initializer, not a plain `{ kind: 'idle' }` literal: `paramStore` may
  // already have a populated cache at the very first render (e.g. the user
  // left this page and came back — the ParamStore itself outlives the page,
  // owned by the connection store). The change-detection effect below only
  // fires on a *later* paramStore identity change, so the initial mount has
  // to make this same "already fetched?" call itself.
  const [load, setLoad] = useState<LoadState>(() => (paramStore && paramStore.all.size > 0 ? { kind: 'loaded' } : { kind: 'idle' }))
  const [version, setVersion] = useState(0) // bumped on every ParamStore.onChange to force paramsArray to re-derive from the live cache
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pending, setPending] = useState<Map<string, number>>(new Map())
  const [writeStatus, setWriteStatus] = useState<Map<string, DiffRowStatus>>(new Map())
  const [writing, setWriting] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [discardedNotice, setDiscardedNotice] = useState<number | null>(null)

  const prevParamStoreRef = useRef(paramStore)

  // A fresh ParamStore (new connect() generation — never reused, per
  // router.ts's own architectural fact) or its disappearance (disconnect)
  // resets every bit of this page's session-scoped UI state. Losing the
  // link with edits still staged clears them with a visible notice: they
  // are meaningless once the session that could write them is gone.
  useEffect(() => {
    if (prevParamStoreRef.current === paramStore) return
    const discardedCount = prevParamStoreRef.current && pending.size > 0 ? pending.size : null
    prevParamStoreRef.current = paramStore
    setDiscardedNotice(paramStore ? null : discardedCount)
    setLoad(paramStore && paramStore.all.size > 0 ? { kind: 'loaded' } : { kind: 'idle' })
    setPending(new Map())
    setWriteStatus(new Map())
    setWriting(false)
    setDrawerOpen(false)
    setQuery('')
    setGroup(null)
    setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramStore])

  // A real ArduPilot fetchAll delivers 800+ PARAM_VALUEs, each firing onChange
  // — bumping `version` (and so re-deriving paramsArray/groups/filtered) on
  // every single one would be pure waste while the 'loading' screen (which
  // shows none of that; it only reads fetchAll's own onProgress callback)
  // is what's on screen. `loadKindRef` lets the onChange subscription (kept
  // stable across `load` transitions — resubscribing per keystroke-like
  // state change would be its own waste) skip bumping until there's
  // something to show. `load.kind` is in paramsArray's own deps below so
  // the eventual loading -> loaded transition still forces one fresh
  // derivation even if no bump happened to land exactly on it.
  const loadKindRef = useRef(load.kind)
  loadKindRef.current = load.kind

  useEffect(() => {
    if (!paramStore) return
    return paramStore.onChange(() => {
      if (loadKindRef.current !== 'loading') setVersion((v) => v + 1)
    })
  }, [paramStore])

  // Unsaved-changes guard: Sidebar consults `guardNavigation` before switching
  // pages. A plain `window.confirm` is the M1-acceptable choice here (task
  // brief) — this page is the only thing that ever has unsaved state to lose.
  useEffect(() => {
    if (pending.size === 0) {
      setGuardNavigation(null)
      return
    }
    const count = pending.size
    setGuardNavigation(() => window.confirm(t('params.confirmLeave', { count })))
    return () => setGuardNavigation(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.size])

  // Once every failed write is either resolved or discarded, close the
  // drawer automatically — nothing left to review. Gated on `!writing` so
  // this can't fire mid-batch (pending only reaches 0 once the *last*
  // sequential set() call has already settled successfully).
  useEffect(() => {
    if (drawerOpen && pending.size === 0 && !writing) setDrawerOpen(false)
  }, [pending.size, writing, drawerOpen])

  const paramsArray = useMemo(() => {
    // Deliberate cache-bust: paramStore.all is a live, mutated-in-place Map,
    // so re-deriving whenever `version` OR `load.kind` changes (not just
    // when the paramStore instance itself changes) is the whole point of
    // listing them as deps despite neither being read in the body.
    void version
    void load.kind
    return paramStore ? [...paramStore.all.values()] : []
  }, [paramStore, version, load.kind])
  const groups = useMemo(() => topGroups(paramsArray, GROUP_CHIP_MAX), [paramsArray])
  const filtered = useMemo(() => filterParams(paramsArray, query, group), [paramsArray, query, group])
  const pageSize = paramPageSize()
  const pageCount = totalPages(filtered.length, pageSize)
  const clampedPage = Math.min(page, pageCount)
  const pageItems = useMemo(() => paginate(filtered, clampedPage, pageSize), [filtered, clampedPage, pageSize])

  useEffect(() => {
    setPage(1)
  }, [query, group])

  function stage(name: string, value: number): void {
    setPending((p) => new Map(p).set(name, value))
    setWriteStatus((s) => withoutKey(s, name))
  }

  function discard(name: string): void {
    setPending((p) => withoutKey(p, name))
    setWriteStatus((s) => withoutKey(s, name))
  }

  function revertAll(): void {
    setPending(new Map())
    setWriteStatus(new Map())
  }

  async function handleLoad(): Promise<void> {
    if (!paramStore) return
    setLoad({ kind: 'loading', got: 0, total: undefined })
    try {
      await paramStore.fetchAll({
        onProgress: (got, total) => setLoad({ kind: 'loading', got, total }),
      })
      setLoad({ kind: 'loaded' })
    } catch (err) {
      setLoad({ kind: 'error', message: fetchErrorMessage(err, t) })
    }
  }

  async function handleWriteAll(): Promise<void> {
    if (!paramStore) return
    setWriting(true)
    for (const [name, value] of [...pending.entries()]) {
      // The link can drop mid-batch: teardown disposes this exact ParamStore
      // and the paramStore-change effect above already wiped pending/
      // writeStatus to empty maps. Stop rather than keep calling set() on a
      // store that's gone and re-populating those maps with status for
      // entries nothing on screen shows anymore.
      if (prevParamStoreRef.current !== paramStore) break
      setWriteStatus((s) => new Map(s).set(name, { kind: 'writing' }))
      try {
        await paramStore.set(name, value)
        setPending((p) => withoutKey(p, name))
        setWriteStatus((s) => withoutKey(s, name))
      } catch (err) {
        if (err instanceof ParamStoreDisposedError) break // disposed while *this* set() was in flight — same reasoning as above
        setWriteStatus((s) => new Map(s).set(name, writeErrorStatus(err)))
      }
    }
    setWriting(false)
  }

  if (phase !== 'connected') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        {discardedNotice !== null && (
          <div className="mb-1 max-w-[440px] rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-4 py-2 text-center text-[12px] font-semibold text-nvx-warningText">
            {t('params.discardedOnDisconnect', { count: discardedNotice })}
          </div>
        )}
        <div className="flex h-[74px] w-[74px] items-center justify-center rounded-[22px] border border-nvx-border bg-nvx-surface text-nvx-faint">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <rect x="3.75" y="4.5" width="16.5" height="15" rx="2" />
            <path d="M3.75 9.5h16.5M10 9.5v10" />
          </svg>
        </div>
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('params.notConnectedTitle')}</div>
        <div className="max-w-[400px] text-center text-[13px] leading-relaxed text-nvx-muted">{t('params.notConnectedBody')}</div>
        <button
          type="button"
          disabled={phase !== 'disconnected'}
          onClick={() => void connect(baud)}
          className="rounded-[10px] bg-nvx-primary px-[22px] py-2.5 text-[13px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('params.connectCta')}
        </button>
      </div>
    )
  }

  if (load.kind === 'idle') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('params.title')}</div>
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
    const pct = load.total ? Math.min(100, Math.round((load.got / load.total) * 100)) : undefined
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-5">
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('params.title')}</div>
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
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('params.title')}</div>
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
    <div className="flex h-full flex-col px-5 pb-6 pt-[18px]">
      <div className="mb-3 flex items-baseline">
        <span className="font-heading text-[19px] font-bold text-nvx-text">{t('params.title')}</span>
        <span className="ml-auto font-mono text-[11px] text-nvx-faint">{t('params.count', { shown: filtered.length, total: paramsArray.length })}</span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('params.searchPlaceholder')}
          className="w-[260px] rounded-[9px] border border-nvx-borderStrong px-3 py-2 font-mono text-[12px] focus:border-nvx-primary"
        />
        <button
          type="button"
          onClick={() => setGroup(null)}
          aria-pressed={group === null}
          className={`rounded-full border px-2.5 py-1.5 font-mono text-[10.5px] font-semibold ${
            group === null ? 'border-nvx-primary bg-nvx-primarySoft text-nvx-primarySoftText' : 'border-nvx-borderStrong bg-white text-nvx-muted'
          }`}
        >
          {t('params.allGroup')} ({paramsArray.length})
        </button>
        {groups.map((g) => (
          <button
            key={g.group}
            type="button"
            onClick={() => setGroup(g.group)}
            aria-pressed={group === g.group}
            className={`rounded-full border px-2.5 py-1.5 font-mono text-[10.5px] font-semibold ${
              group === g.group ? 'border-nvx-primary bg-nvx-primarySoft text-nvx-primarySoftText' : 'border-nvx-borderStrong bg-white text-nvx-muted'
            }`}
          >
            {g.group}_ ({g.count})
          </button>
        ))}
      </div>

      <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-nvx-border bg-white shadow-card">
        <div className="grid grid-cols-[220px_140px_100px_70px] gap-3 border-b border-nvx-border bg-nvx-field px-4 py-[9px] text-[10px] font-extrabold tracking-[.1em] text-nvx-faint">
          <span>{t('params.columnName')}</span>
          <span>{t('params.columnValue')}</span>
          <span>{t('params.columnType')}</span>
          <span>{t('params.columnIndex')}</span>
        </div>
        <div className="min-h-[220px] flex-1 overflow-auto">
          {pageItems.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-nvx-faint">{t('params.noResults')}</p>
          ) : (
            pageItems.map((p) => <ParamRow key={p.name} param={p} stagedValue={pending.get(p.name)} onStage={stage} />)
          )}
        </div>
        <div className="flex items-center justify-between border-t border-nvx-border px-4 py-2 text-[11.5px] text-nvx-muted">
          <button
            type="button"
            disabled={clampedPage <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-md px-2 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('params.prev')}
          </button>
          <span className="font-mono">{t('params.page', { page: clampedPage, total: pageCount })}</span>
          <button
            type="button"
            disabled={clampedPage >= pageCount}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md px-2 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('params.next')}
          </button>
        </div>
        {pending.size > 0 ? (
          <div className="flex items-center gap-2.5 border-t border-nvx-warningBorder bg-nvx-warningSoft px-4 py-2.5">
            <span className="h-2 w-2 flex-none rounded-full bg-nvx-warning" />
            <span className="text-[12.5px] font-extrabold text-nvx-warningText">{t('params.pendingBadge', { count: pending.size })}</span>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="ml-auto rounded-[9px] bg-nvx-primary px-4 py-2 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover"
            >
              {t('params.reviewWrite')}
            </button>
            <button type="button" onClick={revertAll} className="rounded-[9px] px-3 py-2 text-[12.5px] font-semibold text-nvx-warningText hover:bg-nvx-warningBorder/30">
              {t('params.revertAll')}
            </button>
          </div>
        ) : (
          <div className="border-t border-nvx-border px-4 py-2.5 text-[11.5px] text-nvx-faint">{t('params.noChanges')}</div>
        )}
      </div>

      {drawerOpen && (
        <DiffDrawer
          rows={[...pending.entries()].map(([name, next]) => ({
            name,
            current: paramStore?.get(name)?.value ?? 0,
            next,
            status: writeStatus.get(name),
          }))}
          writing={writing}
          onDiscard={discard}
          onWriteAll={() => void handleWriteAll()}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  )
}
