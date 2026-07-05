/**
 * Owns one `MagCalibration` (Task 8.2) instance per session generation --
 * same construct/dispose-on-session-change lifecycle as
 * `useAccelCalibration`, see that hook's own doc for the shared reasoning
 * (interrupted-latch never auto-clearing, a fresh session not silently
 * resetting an unacknowledged banner).
 *
 * This is the anti-silent-write gate the whole project exists for: no
 * `COMPASS_OFS*`/etc. param is ever written before the user reviews
 * `buildReview()`'s before/after diff and clicks "Write offsets to board"
 * (`accept()` below). The one write that *does* happen earlier —
 * `COMPASS_LEARN=0`, fired synchronously by `MagCalibration.start()` via
 * `onLearnDisclosure` — is deliberately never allowed to be silent either:
 * it's surfaced as `disclosure` (a stable boolean flag; `CompassCard` owns
 * the actual localized copy, `calibration.compass.learnDisclosure`, and
 * renders it both inline and in the idle body *before* `start()` is even
 * clicked) AND pushed into `useActivityLog` (`store/activityLog.ts`, same
 * localized text) in the same tick.
 *
 * **Multi-compass fan-out.** `MAG_CAL_PROGRESS`/`MAG_CAL_REPORT` arrive once
 * per `compass_id`; `progress`/`reports`/`diffs` are all keyed by it.
 * `knownCompassIds` accumulates every id ever seen (via either message) and
 * the running->review transition only fires once *every* known id has a
 * `MAG_CAL_SUCCESS` report AND a built diff — see `checkReviewReady`.
 *
 * **Accept's two failure modes** (task brief, carried from `magCal.ts`'s own
 * doc): `MagCalibration.accept()` sends `DO_ACCEPT_MAG_CAL` then calls
 * `paramStore.fetchAll()` to confirm. A rejection that's an instance of
 * `MagCalAcceptRejectedError` (a NACKed ACK) means nothing was written --
 * safe to retry, stays in `'review'`. Anything else (the confirm-fetch
 * itself failing, or even an ACK that never arrived at all e.g. a timeout)
 * is treated as the more conservative "may have been written, unconfirmed"
 * bucket (`'unconfirmed'`) rather than falsely reassuring the user nothing
 * happened -- an ACK timeout is genuinely ambiguous (unlike a definite
 * NACK), and leaning toward "go check" is the safer default for a
 * review-gate feature. This same "unconfirmed" bucket is also where a
 * real transport disconnect mid-`accept()` lands: see `accept()`'s own doc
 * below for why its stale-instance guard must not simply drop that settle.
 */
import { useEffect, useRef, useState } from 'react'
import {
  MAG_CAL_SUCCESS,
  MagCalAcceptRejectedError,
  MagCalibration,
  snapshotFromDiffs,
  type CompassDiff,
  type CompassParamSnapshot,
  type MagCalProgress,
  type MagCalReport,
} from '../../core/mavlink/magCal'
import type { ParamStore } from '../../core/mavlink/params'
import type { MavSession } from '../../core/mavlink/session'
import type { ConnectionPhase } from '../../store/connection'
import { useActivityLog } from '../../store/activityLog'
import { useCalibrationProgress } from './calibrationProgress'
import i18n from '../../i18n'

export type CompassCalStatus = 'idle' | 'running' | 'review' | 'accepting' | 'applied' | 'unconfirmed' | 'failed'

export interface CompassAcceptError {
  kind: 'ack-rejected' | 'confirm-failed'
  message: string
}

export interface CompassCalState {
  status: CompassCalStatus
  progress: ReadonlyMap<number, MagCalProgress>
  reports: ReadonlyMap<number, MagCalReport>
  diffs: ReadonlyMap<number, CompassDiff[]>
  /** `COMPASS_LEARN=0` disclosure flag, set the instant `start()` fires it -- see module doc. `CompassCard` owns the localized copy (`calibration.compass.learnDisclosure`), this is just "show it or don't". */
  disclosure: boolean
  acceptError: CompassAcceptError | null
  undoError: string | null
  /** `start()`/`cancel()` rejection, if any. */
  error: string | null
  /** Set once the link drops mid-flight (`running`/`review`); never clears on its own -- see `useAccelCalibration`'s doc for the shared reasoning. */
  interrupted: boolean
  start: () => void
  /** Sends `DO_CANCEL_MAG_CAL` best-effort, then resets to `idle` regardless of its outcome -- nothing was written either way (the review gate hasn't been passed yet), so there's nothing to roll back client-side. */
  cancel: () => void
  accept: () => void
  undo: () => void
}

/**
 * Classifies an `accept()` rejection -- see module doc for the
 * ack-rejected/confirm-failed split. Typed on `instanceof
 * MagCalAcceptRejectedError` (not a message-string regex) so a caller can't
 * be fooled by an unrelated error that merely happens to contain similar
 * text -- see that class's own doc in `magCal.ts`.
 */
function classifyAcceptFailure(err: unknown): CompassAcceptError {
  const message = err instanceof Error ? err.message : String(err)
  return { kind: err instanceof MagCalAcceptRejectedError ? 'ack-rejected' : 'confirm-failed', message }
}

/** `cal_mask` (`MagCalProgress`/`MagCalReport`'s own field) is a bitmask of every compass_id being calibrated THIS run, fixed for the whole session -- e.g. `0x03` means compasses 0 and 1. Bit-scanning it (rather than just accumulating whichever ids have happened to report so far) is what lets the running->review gate below know a 2nd/3rd compass is still outstanding even before *any* message for it has arrived yet. */
function compassIdsFromMask(calMask: number): number[] {
  const ids: number[] = []
  for (let bit = 0; bit < 10; bit++) {
    if ((calMask >> bit) & 1) ids.push(bit)
  }
  return ids
}

export function useCompassCalibration(
  session: MavSession | null,
  paramStore: ParamStore | null,
  phase: ConnectionPhase,
): CompassCalState {
  const calRef = useRef<MagCalibration | null>(null)
  /** `cal_mask` from the first progress/report message seen this run -- see `compassIdsFromMask`'s doc. */
  const calMaskRef = useRef<number | null>(null)
  const snapshotRef = useRef<CompassParamSnapshot>({})
  /** Mirrors `diffs` state synchronously so the readiness check (run from inside an async `buildReview().then()`, not an effect) always reads the latest map instead of whatever was captured when the mount effect below first subscribed. */
  const diffsRef = useRef<Map<number, CompassDiff[]>>(new Map())

  const [status, setStatus] = useState<CompassCalStatus>('idle')
  const [progress, setProgress] = useState<ReadonlyMap<number, MagCalProgress>>(new Map())
  const [reports, setReports] = useState<ReadonlyMap<number, MagCalReport>>(new Map())
  const [diffs, setDiffs] = useState<ReadonlyMap<number, CompassDiff[]>>(new Map())
  const [disclosure, setDisclosure] = useState(false)
  const [acceptError, setAcceptError] = useState<CompassAcceptError | null>(null)
  const [undoError, setUndoError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [interrupted, setInterrupted] = useState(false)

  useEffect(() => {
    if (!session || !paramStore) return
    const cal = new MagCalibration(session, paramStore)
    calRef.current = cal
    calMaskRef.current = null

    const unsubDisclosure = cal.onLearnDisclosure(() => {
      setDisclosure(true)
      // never silent -- see module doc. Localized here (not in magCal.ts,
      // which has no i18n of its own) so the activity log entry reads the
      // same as the inline copy `CompassCard` shows for the same event.
      useActivityLog.getState().log(i18n.t('calibration.compass.learnDisclosure'))
    })
    const unsubProgress = cal.onProgress((p) => {
      if (calMaskRef.current === null) calMaskRef.current = p.calMask
      setProgress(new Map(cal.latestProgress))
    })
    const unsubReport = cal.onReport((r) => {
      if (calMaskRef.current === null) calMaskRef.current = r.calMask
      setReports(new Map(cal.latestReport))

      if (r.calStatus !== MAG_CAL_SUCCESS) {
        // A poor fit/bad orientation/bad radius report: nothing meaningful
        // to review for this run. Guarded on 'running' (a functional updater,
        // not the closed-over `status`) so a report arriving after the user
        // already cancelled/moved on doesn't resurrect a failure banner.
        setStatus((s) => (s === 'running' ? 'failed' : s))
        return
      }

      cal.buildReview(r).then((rowDiffs) => {
        const next = new Map(diffsRef.current)
        next.set(r.compassId, rowDiffs)
        diffsRef.current = next
        setDiffs(next)
        snapshotRef.current = { ...snapshotRef.current, ...snapshotFromDiffs(rowDiffs) }

        // running -> review once every compass_id in cal_mask has a diff --
        // computed right here (not a separate effect watching
        // reports/diffs/status) so this doesn't need `react-hooks/
        // set-state-in-effect`'s disallowed setState-in-effect pattern, and
        // reads `diffsRef`/`calMaskRef` instead of a possibly-stale closure.
        const mask = calMaskRef.current
        if (mask === null) return
        const expected = compassIdsFromMask(mask)
        if (expected.length > 0 && expected.every((id) => next.has(id))) {
          setStatus((s) => (s === 'running' ? 'review' : s))
        }
      })
    })

    return () => {
      unsubDisclosure()
      unsubProgress()
      unsubReport()
      cal.stopStreams().catch(() => {}) // best-effort, mirrors magCal.ts's own doc for this call
      cal.dispose()
      if (calRef.current === cal) calRef.current = null
    }
  }, [session, paramStore])

  // Latches `interrupted` -- computed during render, not a useEffect, same
  // idiom as `useAccelCalibration`'s own doc explains (monotonic latch, the
  // `!interrupted` guard makes this idempotent). Never clears here.
  if (!interrupted && phase !== 'connected' && (status === 'running' || status === 'review')) {
    setInterrupted(true)
  }

  function resetToIdle(): void {
    setStatus('idle')
    setProgress(new Map())
    setReports(new Map())
    setDiffs(new Map())
    setAcceptError(null)
    calMaskRef.current = null
    diffsRef.current = new Map()
    snapshotRef.current = {}
  }

  function start(): void {
    const cal = calRef.current
    if (!cal) return
    setError(null)
    setAcceptError(null)
    setUndoError(null)
    setInterrupted(false)
    setStatus('running')
    setProgress(new Map())
    setReports(new Map())
    setDiffs(new Map())
    calMaskRef.current = null
    diffsRef.current = new Map()
    snapshotRef.current = {}
    cal.start().catch((err: unknown) => {
      // Guarded: dispose() doesn't cancel this promise, so a disconnect+
      // reconnect within start()'s timeout window can let a stale instance's
      // rejection land after a fresh attempt is already underway -- see
      // useAccelCalibration.ts's own version of this same guard.
      //
      // Deliberately NOT `isStaleInstance` (accept()'s own guard, below):
      // that relaxation exists because 'accepting' has no other terminal
      // fallback if a settle gets dropped. 'running' isn't in that position
      // -- the `interrupted` latch above already covers `status ===
      // 'running'` unconditionally, and takes render priority over whatever
      // this call sets `status`/`error` to (see `CompassCard`'s own
      // branching). So even with this plain `calRef.current !== cal` guard
      // discarding a real-disconnect settle here (`calRef.current` now
      // `null`, not superseded by a fresh instance), the user still sees the
      // honest interrupted banner, never a silent hang -- there is no
      // FIX-1-shaped bug to close on this path.
      if (calRef.current !== cal) return
      setStatus('failed')
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  function cancel(): void {
    calRef.current?.cancel().catch(() => {})
    resetToIdle()
    setInterrupted(false)
  }

  function accept(): void {
    const cal = calRef.current
    if (!cal || status !== 'review') return
    setStatus('accepting')
    setAcceptError(null)
    cal.accept().then(
      () => {
        if (isStaleInstance(cal)) return
        setStatus('applied')
        // Read-only signal for Task 10.1's Setup Guide -- see calibrationProgress.ts's own doc.
        useCalibrationProgress.getState().markCompassApplied()
      },
      (err: unknown) => {
        if (isStaleInstance(cal)) return
        const classified = classifyAcceptFailure(err)
        setAcceptError(classified)
        setStatus(classified.kind === 'ack-rejected' ? 'review' : 'unconfirmed')
      },
    )
  }

  /**
   * Whether `cal`'s own settle should be discarded as superseded, for the
   * `start()`/`accept()` stale-instance guards.
   *
   * **`accept()`'s own bug this closes (task brief, calibration review
   * highest-priority fix).** The old guard here was the same `calRef.current
   * !== cal` check `start()` still uses below -- correct for `start()`, but
   * wrong for `accept()`: a *real* transport disconnect while `status` is
   * `'accepting'` runs the mount effect's cleanup (session -> `null`), which
   * disposes `cal` and nulls `calRef.current` *without* constructing a
   * replacement (the effect's own `if (!session || !paramStore) return`
   * guard). `accept()`'s in-flight promise (bound to the now-dead transport)
   * still settles later -- via `DO_ACCEPT_MAG_CAL`'s forced-0-retries
   * timeout, since it's in `DANGEROUS_COMMANDS` -- and the old
   * `!== cal` check silently dropped that settle because `calRef.current`
   * was `null`, not because a *fresh* instance had superseded it. `status`
   * then stuck at `'accepting'` forever: both buttons disabled (`status ===
   * 'accepting'`), no message, the single most safety-critical moment this
   * feature has.
   *
   * The fix: only treat this as stale when a *different, non-null* instance
   * has taken over (a reconnect that already got as far as constructing a
   * new `MagCalibration` before this settle arrived) -- `calRef.current ===
   * null` on its own means "no live cal right now", not "someone else owns
   * this settle", so it must still be applied. In practice this routes a
   * disconnected `accept()` to the classifier, which (since a real
   * disconnect never delivers a NACKed ACK, only a timeout) lands on
   * `'unconfirmed'` -- the honest "written but could not be verified, check
   * the Parameters page" state, not a hang.
   */
  function isStaleInstance(cal: MagCalibration): boolean {
    return calRef.current !== null && calRef.current !== cal
  }

  function undo(): void {
    const cal = calRef.current
    if (!cal || (status !== 'applied' && status !== 'unconfirmed')) return
    setUndoError(null)
    cal.undo(snapshotRef.current).then(
      () => {
        if (calRef.current === cal) resetToIdle()
      },
      (err: unknown) => {
        if (calRef.current === cal) setUndoError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return {
    status,
    progress,
    reports,
    diffs,
    disclosure,
    acceptError,
    undoError,
    error,
    interrupted,
    start,
    cancel,
    accept,
    undo,
  }
}
