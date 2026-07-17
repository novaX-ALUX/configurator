import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { useNavigationStore } from '../../store/navigation'
import { ParamStoreDisposedError, type FetchProgressState } from '../../core/mavlink/params'
import { loadParamDefaults, loadParamMetadata, lookupParamMeta, type LoadedParamMetadata, type ParamDefaultsFile } from '../../core/paramMetadata'
import { rebootFlightController } from '../../core/mavlink/reboot'
import { ParamRow } from './ParamRow'
import { DiffDrawer, type DiffRowStatus } from './DiffDrawer'
import { downloadParamFile, parseParamFile, planImport, serializeParamFile, type ImportPlan } from './paramFileUtils'
import { batchNeedsReboot, fetchErrorMessage, fetchProgressPercent, filterParams, groupParams, withoutKey, writeErrorStatus } from './paramUtils'

type LoadState = { kind: 'idle' } | { kind: 'error'; message: string } | { kind: 'loaded' }

/**
 * Default `fetchProgress` for when there's no `ParamStore` yet (not
 * connected) — a plain "nothing in flight" value, never mutated in place, so
 * sharing this one reference across call sites is safe.
 */
const NO_FETCH_PROGRESS: FetchProgressState = { active: false, got: 0, total: undefined }

/** How long a successful write's 'ok' row stays visible in the drawer before it clears (spec: per-row status includes 'ok', not an immediate vanish). */
const WRITE_OK_DISPLAY_MS = 2000

// ParamFetchBusyError (a second concurrent fetchAll()) isn't special-cased
// here: handleLoad's only callers are the idle/error states' own buttons,
// neither of which renders while a fetch is already in flight, so this UI
// has no path that can ever trigger it — it falls through to fetchErrorMessage's
// generic message, same treatment DiffDrawer's own 'busy'/'precision'
// statuses get for the equivalent reason below.
//
// ParamWriteBusyError/ParamPrecisionLossError are handled by writeErrorStatus
// for completeness (DiffDrawer knows how to render them) but are effectively
// unreachable through this page today: handleWriteAll only ever has one
// set() in flight per name at a time (sequential loop), and ParamRow already
// blocks precision-losing input before it's ever staged
// (paramUtils.wouldLosePrecision). If writes are ever parallelized, or
// staging validation changes, that invariant is what would make these
// reachable.

/**
 * Full parameter table: fetch (with progress + distinguishable errors),
 * search filter (name or metadata display name), one collapsible section
 * per `deriveGroup()` prefix (all collapsed by default, expand state is
 * component state only — never persisted, PRD #12 §2.5), staged edits with
 * a diff-before-write drawer, and two safety nets: a nav-store guard
 * blocking navigation away with unsaved edits, and a clear-with-warning on
 * disconnect (edits don't survive a session, so keeping them staged after
 * teardown would be a lie).
 */
export function ParamsPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const paramStore = useConnectionStore((s) => s.paramStore)
  const identity = useConnectionStore((s) => s.identity)
  const session = useConnectionStore((s) => s.session)
  const setGuardNavigation = useNavigationStore((s) => s.setGuardNavigation)

  // Lazy initializer, not a plain `{ kind: 'idle' }` literal: `paramStore` may
  // already have a populated cache at the very first render (e.g. the user
  // left this page and came back — the ParamStore itself outlives the page,
  // owned by the connection store). The change-detection effect below only
  // fires on a *later* paramStore identity change, so the initial mount has
  // to make this same "already fetched?" call itself.
  const [load, setLoad] = useState<LoadState>(() => (paramStore && paramStore.all.size > 0 ? { kind: 'loaded' } : { kind: 'idle' }))
  // Live fetchAll() progress, store-wide — not just from a fetch *this page*
  // triggered. A prior mount, another page (Setup shares the same
  // ParamStore), or a post-write confirm re-fetch (magCal) can all leave a
  // pull running when this page mounts or is already sitting on the loaded
  // table; `fetchProgress.active` is checked ahead of `load.kind` at render
  // time so none of those cases ever get mistaken for "done" just because
  // `paramStore.all` already has a few entries in it.
  const [fetchProgress, setFetchProgress] = useState<FetchProgressState>(() => paramStore?.fetchProgress ?? NO_FETCH_PROGRESS)
  const [version, setVersion] = useState(0) // bumped on every ParamStore.onChange to force paramsArray to re-derive from the live cache
  const [query, setQuery] = useState('')
  // Which groups the user has manually expanded — all collapsed by default,
  // component state only (not persisted across page loads/navigation, PRD
  // #12 §2.5: re-expanding a group is a single click, unlike Charts' series
  // selection which is expensive enough to justify persistence).
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Map<string, number>>(new Map())
  const [writeStatus, setWriteStatus] = useState<Map<string, DiffRowStatus>>(new Map())
  const [writing, setWriting] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Post-write "Reboot required" banner (PRD #12 Ticket 5) — shown once a
  // write batch that succeeded included any `rebootRequired` param, until
  // dismissed or a reboot is actually sent. Session-scoped like every other
  // piece of state here: reset on disconnect/reconnect below, since a stale
  // banner from a previous session is meaningless.
  const [rebootBanner, setRebootBanner] = useState(false)
  const [rebooting, setRebooting] = useState(false)
  const [discardedNotice, setDiscardedNotice] = useState<number | null>(null)
  // Additive param documentation (issue #13) — `null` until loaded, and left
  // `null` forever on a fetch failure (unsupported firmware, asset missing,
  // offline): every row already renders its raw name/type/index without
  // this, so there is no error state here, only "not available yet".
  const [meta, setMeta] = useState<LoadedParamMetadata | null>(null)
  const [metaBannerDismissed, setMetaBannerDismissed] = useState(false)
  // Bundled ArduCopter SITL default values (issue #15, PRD #12 §2.4) — same
  // "null until loaded, stays null forever on a fetch failure" additive
  // fallback as `meta` above, but a fully independent fetch/state: a
  // defaults-file 404 must never take down display-name/description
  // metadata that already loaded, and vice versa.
  const [defaults, setDefaults] = useState<ParamDefaultsFile | null>(null)
  // "Not Default" toggle (PRD §2.4) — session-scoped UI state, same as
  // `query`/`expandedGroups`: reset on disconnect below, never persisted.
  const [notDefaultOnly, setNotDefaultOnly] = useState(false)
  // `.param` file import/export (issue #16, PRD #12 §3). `importError` is the
  // single top-level parse failure (PRD §3.1: a malformed file rejects the
  // whole import, never partially stages); `importSummary` is the post-parse
  // "N staged, M skipped..." notice shown once staging is done — a plain
  // dismissible banner, not part of DiffDrawer itself, since PRD §3.3 calls
  // it a *pre-drawer* summary.
  const [importError, setImportError] = useState<string | null>(null)
  const [importSummary, setImportSummary] = useState<ImportPlan | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const prevParamStoreRef = useRef(paramStore)
  // Mirrors `writeStatus` for the scheduled ok-then-clear timeout below to
  // read the *current* state without itself being a dependency that would
  // force re-registering that timeout — see handleWriteAll.
  const writeStatusRef = useRef(writeStatus)
  useEffect(() => {
    writeStatusRef.current = writeStatus
  }, [writeStatus])

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
    setFetchProgress(paramStore?.fetchProgress ?? NO_FETCH_PROGRESS)
    setPending(new Map())
    setWriteStatus(new Map())
    setWriting(false)
    setDrawerOpen(false)
    setRebootBanner(false)
    setRebooting(false)
    setQuery('')
    setExpandedGroups(new Set())
    setMeta(null)
    setMetaBannerDismissed(false)
    setDefaults(null)
    setNotDefaultOnly(false)
    setImportError(null)
    setImportSummary(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramStore])

  // Same-origin lazy fetch after connect (core/firmware/manifest.ts's fetch
  // pattern) — independent of the param *table* fetch above (`handleLoad`/
  // `fetchProgress`): metadata is documentation, not part of the live
  // parameter cache, so it loads on its own schedule and a failure here
  // never blocks or errors the table. Re-runs if `fwVersion` resolves after
  // this first fires (AUTOPILOT_VERSION can arrive a beat after 'connected')
  // — cheap, since `fetchParamMetadata` caches by version and the version
  // picked rarely changes.
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

  // Same pattern as the metadata effect just above, for the second generated
  // asset (issue #15, PRD #12 §2.4) — fetched independently so a failure
  // here (asset missing, network) only disables the default-marker caption/
  // Not-Default toggle, never the display-name/description metadata above.
  useEffect(() => {
    if (!paramStore) return
    let cancelled = false
    loadParamDefaults(identity?.fwVersion)
      .then((result) => {
        if (!cancelled) setDefaults(result)
      })
      .catch(() => {
        if (!cancelled) setDefaults(null)
      })
    return () => {
      cancelled = true
    }
  }, [paramStore, identity?.fwVersion])

  // A real ArduPilot fetchAll delivers 800+ PARAM_VALUEs, each firing onChange
  // — bumping `version` (and so re-deriving paramsArray/groups/filtered) on
  // every single one would be pure waste while the progress screen (which
  // shows none of that; it only reads `fetchProgress`) is what's on screen.
  // `fetchActiveRef` lets the onChange subscription (kept stable across
  // `fetchProgress` updates — resubscribing on every arrival would be its own
  // waste) skip bumping until there's something to show, regardless of
  // whether *this page* is the one that called fetchAll(). `fetchProgress.active`
  // is in paramsArray's own deps below so the eventual pull -> done
  // transition still forces one fresh derivation even if no bump happened to
  // land exactly on it.
  const fetchActiveRef = useRef(fetchProgress.active)
  fetchActiveRef.current = fetchProgress.active

  useEffect(() => {
    if (!paramStore) return
    return paramStore.onChange(() => {
      if (!fetchActiveRef.current) setVersion((v) => v + 1)
    })
  }, [paramStore])

  useEffect(() => {
    if (!paramStore) return
    return paramStore.onFetchProgress(setFetchProgress)
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
    // so re-deriving whenever `version` OR `fetchProgress.active` changes (not
    // just when the paramStore instance itself changes) is the whole point of
    // listing them as deps despite neither being read in the body.
    void version
    void fetchProgress.active
    return paramStore ? [...paramStore.all.values()] : []
  }, [paramStore, version, fetchProgress.active])
  const hasQuery = query.trim() !== ''
  const filtered = useMemo(
    () => filterParams(paramsArray, query, meta ? (name) => lookupParamMeta(meta.table, name) : undefined, notDefaultOnly, defaults ? (name) => defaults[name] : undefined),
    [paramsArray, query, meta, notDefaultOnly, defaults],
  )
  // Derived from the already-filtered array: a group with zero matches on a
  // non-empty query simply has no entries here, which is how "hide
  // zero-match groups on search" falls out for free (PRD #12 §2.5) — no
  // separate visibility flag needed.
  const groups = useMemo(() => groupParams(filtered), [filtered])

  function isGroupExpanded(group: string): boolean {
    // Non-empty query auto-expands every group that has a match; the
    // section header's toggle is disabled while searching (see the button
    // below), so `expandedGroups` itself is never mutated by a search —
    // clearing it back to `''` is what puts every group back to collapsed
    // (handleQueryChange below), matching "clearing the query restores the
    // collapsed-by-default state" literally (PRD #12 §2.5).
    return hasQuery || expandedGroups.has(group)
  }

  function toggleGroup(group: string): void {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  function handleQueryChange(next: string): void {
    setQuery(next)
    // Clearing the search restores the collapsed-by-default state
    // unconditionally — including any group the user had expanded manually
    // before searching — rather than only the groups the search itself
    // auto-expanded (PRD §2.5).
    if (next.trim() === '') setExpandedGroups(new Set())
  }

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

  function handleExport(): void {
    if (!paramStore || load.kind !== 'loaded') return
    const content = serializeParamFile(paramsArray, { board: identity?.boardName, fw: identity?.fwVersion })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    downloadParamFile(`novax-params-${stamp}.param`, content)
  }

  // Parses the dropped/picked file, then stages every real change through
  // the exact same `stage()` a manual row edit uses — see paramFileUtils.ts's
  // module doc for why this is the only place import ever touches staged
  // state, never ParamStore.set directly.
  async function handleImportFile(file: File): Promise<void> {
    if (!paramStore) return
    const text = await file.text()
    const parsed = parseParamFile(text)
    if (parsed.kind === 'error') {
      setImportError(parsed.message)
      setImportSummary(null)
      return
    }
    setImportError(null)
    const plan = planImport(parsed.entries, paramStore.all)
    for (const entry of plan.toStage) stage(entry.name, entry.value)
    setImportSummary(plan)
  }

  async function handleLoad(): Promise<void> {
    if (!paramStore) return
    // No local 'loading' state to set here: the `fetchProgress.active` render
    // gate below picks this fetch up the moment fetchAll() flips it on (see
    // ParamStore.fetchProgress), the same path any other page's fetch would
    // be observed through.
    try {
      await paramStore.fetchAll()
      setLoad({ kind: 'loaded' })
    } catch (err) {
      setLoad({ kind: 'error', message: fetchErrorMessage(err, t) })
    }
  }

  async function handleWriteAll(): Promise<void> {
    if (!paramStore) return
    setWriting(true)
    // Names that actually wrote OK this batch — the sole input to the
    // post-write "Reboot required" banner (PRD #12 Ticket 5): a param that
    // failed to write never took effect, so it can't be the reason a reboot
    // is now needed.
    const writtenNames: string[] = []
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
        writtenNames.push(name)
        // Show "Written and verified" for a moment rather than vanishing the
        // row immediately (spec: per-row status is writing/ok/mismatch/
        // timeout/busy — 'ok' is a real state, not just an instant clear).
        // Scheduled, not awaited: a fixed per-row delay must not slow down
        // the rest of the sequential batch.
        setWriteStatus((s) => new Map(s).set(name, { kind: 'ok' }))
        setTimeout(() => {
          // Skip the clear if this name's status is no longer 'ok' by the
          // time this fires — the user re-staged (stage() clears writeStatus)
          // or discarded it in the meantime, and clearing `pending` here
          // would silently wipe out that newer edit.
          if (writeStatusRef.current.get(name)?.kind !== 'ok') return
          setPending((p) => withoutKey(p, name))
          setWriteStatus((s) => withoutKey(s, name))
        }, WRITE_OK_DISPLAY_MS)
      } catch (err) {
        if (err instanceof ParamStoreDisposedError) break // disposed while *this* set() was in flight — same reasoning as above
        setWriteStatus((s) => new Map(s).set(name, writeErrorStatus(err)))
      }
    }
    setWriting(false)
    if (batchNeedsReboot(writtenNames, meta ? (name) => lookupParamMeta(meta.table, name) : undefined)) setRebootBanner(true)
  }

  async function handleReboot(): Promise<void> {
    if (!session) return
    if (!window.confirm(t('params.rebootConfirm'))) return
    setRebooting(true)
    try {
      await rebootFlightController(session)
    } catch (err) {
      // `rebootFlightController` already resolves `undefined` (not a
      // rejection) for the ACK-timeout case a real reboot almost always hits
      // (its own module doc) — a rejection here is a genuine, rarer failure
      // (e.g. a transport-level send error). There's no dedicated error UI
      // for this trivial-hazard, no-stop-path bench operation (PRD #12
      // Ticket 5); only logged for diagnosis, same tolerance connection.ts
      // itself uses for other fire-and-forget commands.
      console.error('ParamsPage: rebootFlightController failed', err)
    } finally {
      // The banner's job (prompt the user to reboot) is done once the
      // command has gone out, whatever the outcome — the connection itself
      // dropping (or not) is the real signal from here on.
      setRebooting(false)
      setRebootBanner(false)
    }
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

  // Checked ahead of `load.kind`: a pull can be running even when this page
  // never called handleLoad() itself (another page shares the same
  // ParamStore, or this page mounted mid-pull) — see the `fetchProgress`
  // state doc above. While it's active, this is the only thing on screen:
  // the loaded table's "N of M shown" header must never stand in for pull
  // status.
  if (fetchProgress.active) {
    const pct = fetchProgressPercent(fetchProgress.got, fetchProgress.total)
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-5">
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('params.title')}</div>
        <div className="font-mono text-[12px] text-nvx-muted">
          {fetchProgress.total !== undefined ? t('params.loading', { got: fetchProgress.got, total: fetchProgress.total }) : t('params.loadingIndeterminate')}
        </div>
        {/* GPU-safe fill: only `transform` is animated (never `width`), with a
            linear transition — a constant-rate pull deserves a constant-rate
            fill (per emil-design-eng). No striped/marquee texture: that would
            animate `background-position`, which this ticket's motion
            criterion rules out for this element. */}
        <div className="h-2 w-[280px] overflow-hidden rounded-full bg-nvx-field">
          <div
            className="h-full origin-left rounded-full bg-nvx-primary transition-transform duration-200 ease-linear"
            style={{ transform: `scaleX(${pct !== undefined ? pct / 100 : 0.35})` }}
          />
        </div>
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

      {meta && meta.banner.kind !== 'exact' && !metaBannerDismissed && (
        <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-3.5 py-2.5 text-[12px] text-nvx-warningText">
          <span className="flex-1">
            {meta.banner.kind === 'mismatch'
              ? t('params.metaVersionMismatch', { bundled: meta.banner.bundled, fwVersion: meta.banner.fwVersion })
              : t('params.metaVersionUnknown', { bundled: meta.banner.bundled })}
          </span>
          <button
            type="button"
            onClick={() => setMetaBannerDismissed(true)}
            aria-label={t('params.metaBannerDismiss')}
            className="flex-none font-bold text-nvx-warningText hover:opacity-70"
          >
            ×
          </button>
        </div>
      )}

      {/* Post-write "Reboot required" banner (PRD #12 Ticket 5) — plain
          conditional render, no exit-fade state machine (unlike
          layout/OfflineChip.tsx): dismissal/reboot here is a hard state
          change, not something that needs to animate out. `@starting-style`
          fires the moment this element is newly inserted, giving the
          entrance fade for free. */}
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

      {importError && (
        <div role="alert" className="mb-3 flex items-start gap-2.5 rounded-lg border border-nvx-dangerBorder bg-nvx-dangerSoft px-3.5 py-2.5 text-[12px] text-nvx-dangerHover">
          <span className="flex-1">{t('params.importParseError', { message: importError })}</span>
          <button
            type="button"
            onClick={() => setImportError(null)}
            aria-label={t('params.metaBannerDismiss')}
            className="flex-none font-bold text-nvx-dangerHover hover:opacity-70"
          >
            ×
          </button>
        </div>
      )}

      {importSummary && (
        <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-nvx-infoBorder bg-nvx-primarySoft px-3.5 py-2.5 text-[12px] text-nvx-primarySoftText">
          <span className="flex-1">
            {t(importSummary.skippedPrecision > 0 ? 'params.importSummaryWithPrecision' : 'params.importSummary', {
              staged: importSummary.toStage.length,
              unknown: importSummary.skippedUnknown,
              unchanged: importSummary.skippedUnchanged,
              precision: importSummary.skippedPrecision,
            })}
          </span>
          <button
            type="button"
            onClick={() => setImportSummary(null)}
            aria-label={t('params.metaBannerDismiss')}
            className="flex-none font-bold text-nvx-primarySoftText hover:opacity-70"
          >
            ×
          </button>
        </div>
      )}

      <div className="mb-1 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder={t('params.searchPlaceholder')}
          className="w-[260px] rounded-[9px] border border-nvx-borderStrong px-3 py-2 font-mono text-[12px] focus:border-nvx-primary"
        />
        {/* Not-Default filter (PRD #12 §2.4, issue #15) — disabled until
            defaults data has loaded rather than silently rendering an
            empty table, since every row would otherwise fail the "has a
            bundled default" check for a reason that has nothing to do with
            what's actually staged on the board (same additive-fallback
            principle as Export/Import being no-ops before the table loads,
            just made visible here since this is a persistent toggle, not a
            one-shot action). */}
        <button
          type="button"
          aria-pressed={notDefaultOnly}
          disabled={!defaults}
          title={!defaults ? t('params.notDefaultUnavailable') : undefined}
          onClick={() => setNotDefaultOnly((v) => !v)}
          className={`rounded-[9px] border px-3.5 py-2 text-[12px] font-bold disabled:cursor-not-allowed disabled:opacity-50 ${
            notDefaultOnly ? 'border-nvx-primary bg-nvx-primarySoft text-nvx-primarySoftText' : 'border-nvx-borderStrong bg-white text-nvx-text hover:bg-nvx-field'
          }`}
        >
          {t('params.notDefaultCta')}
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="ml-auto rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2 text-[12px] font-bold text-nvx-text hover:bg-nvx-field"
        >
          {t('params.importCta')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".param,.parm,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleImportFile(file)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={handleExport}
          className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2 text-[12px] font-bold text-nvx-text hover:bg-nvx-field"
        >
          {t('params.exportCta')}
        </button>
      </div>
      {/* Accuracy caveat (PRD #12 §2.4): rendered prominently next to the
          toggle, always visible (not a hover-only tooltip) — matches this
          project's honesty-banner precedent (the metadata version-mismatch
          banner above), but as a plain caption rather than a dismissible
          box, since this is evergreen documentation for a permanent
          feature, not a transient/dismissible notice. */}
      <p className="mb-3 max-w-[720px] text-[10.5px] leading-snug text-nvx-faint">{t('params.notDefaultCaveat')}</p>

      <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-nvx-border bg-white shadow-card">
        <div className="grid grid-cols-[220px_140px_100px_70px] gap-3 border-b border-nvx-border bg-nvx-field px-4 py-[9px] text-[10px] font-extrabold tracking-[.1em] text-nvx-faint">
          <span>{t('params.columnName')}</span>
          <span>{t('params.columnValue')}</span>
          <span>{t('params.columnType')}</span>
          <span>{t('params.columnIndex')}</span>
        </div>
        <div className="min-h-[220px] flex-1 overflow-auto">
          {groups.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-nvx-faint">{t('params.noResults')}</p>
          ) : (
            groups.map((g) => {
              const expanded = isGroupExpanded(g.group)
              return (
                <div key={g.group} className="border-b border-nvx-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.group)}
                    disabled={hasQuery}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-1.5 bg-nvx-field px-4 py-[7px] text-left font-mono text-[11px] font-extrabold tracking-[.05em] text-nvx-muted disabled:cursor-default"
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`flex-none transition-transform duration-150 ease-out motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
                    >
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                    {g.group}_ <span className="font-normal text-nvx-faint">({g.items.length})</span>
                  </button>
                  {expanded &&
                    g.items.map((p) => (
                      <ParamRow
                        key={p.name}
                        param={p}
                        stagedValue={pending.get(p.name)}
                        onStage={stage}
                        meta={meta ? lookupParamMeta(meta.table, p.name) : undefined}
                        defaultValue={defaults?.[p.name]}
                      />
                    ))}
                </div>
              )
            })
          )}
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
            rebootRequired: meta ? lookupParamMeta(meta.table, name)?.rebootRequired : undefined,
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
