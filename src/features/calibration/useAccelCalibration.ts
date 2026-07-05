/**
 * Owns one `AccelCalibration` (Task 8.1) instance per session generation:
 * constructs it when `session` first becomes a given (non-null) identity,
 * disposes it when `session` changes identity or goes away, and turns its
 * callback-based protocol (`onFacePrompt`/`onComplete`) into reactive state
 * for `AccelCard`.
 *
 * **Link-state cross-reference (carried forward from Task 8.1's review).**
 * `AccelCalibration` cannot detect a disconnect itself — it only reacts to
 * inbound MAVLink frames, which simply stop arriving. This hook is handed
 * `phase` (`useConnectionStore`'s own mirror of `router.onLinkState`,
 * `store/connection.ts`) alongside `session` specifically so it can notice
 * that cross-cutting condition: whenever `phase` isn't `'connected'` while
 * the calibration's own status is `'running'`/`'busy'`, `interrupted` latches
 * `true`. It deliberately never *un*-latches on its own — not when `phase`
 * recovers, not even across a full reconnect (a fresh `session` identity
 * still gets a fresh `AccelCalibration`, but this hook does not reset
 * `status`/`interrupted` for that alone) — because per `accelCal.ts`'s own
 * module doc there is no way to know whether the FC's save already committed
 * mid-sequence; only an explicit `start()`/`abandon()` (the user
 * acknowledging the interrupt banner and choosing to redo all 6 faces, or
 * giving up) clears it. Without this latch, a link that merely blips back to
 * `'connected'` would silently swap the interrupt banner back for the stale
 * in-progress face UI — exactly the "stale progress" the task brief warns
 * against.
 */
import { useEffect, useRef, useState } from 'react'
import { AccelCalibration, type AccelCalStatus, type AccelFace } from '../../core/mavlink/accelCal'
import type { MavSession } from '../../core/mavlink/session'
import type { ConnectionPhase } from '../../store/connection'
import { useCalibrationProgress } from './calibrationProgress'

/** Prompt order — mirrors `accelCal.ts`'s own `FACE_FOR_STEP` (step 1..6). */
export const ACCEL_FACE_ORDER: readonly AccelFace[] = ['level', 'left', 'right', 'nosedown', 'noseup', 'back']

export interface AccelCalState {
  status: AccelCalStatus
  currentFace: AccelFace | null
  /** 1-based "FACE n/6" while a face is outstanding; `0` before the first prompt. */
  stepIndex: number
  /** Faces fully completed so far (drives the 6-segment progress bar) — `6` once `status === 'done'`. */
  doneFaces: number
  /** True while a `start()`/`captureFace()` confirm is in flight (`status === 'busy'`) — disables the capture button, shows "Capturing…". */
  busy: boolean
  /** Set once the link drops mid-sequence; see module doc — never clears on its own. */
  interrupted: boolean
  /** Last `start()`/`captureFace()` rejection message, if any. */
  error: string | null
  start: () => void
  captureFace: () => void
  abandon: () => void
}

export function useAccelCalibration(session: MavSession | null, phase: ConnectionPhase): AccelCalState {
  const calRef = useRef<AccelCalibration | null>(null)

  const [status, setStatus] = useState<AccelCalStatus>('idle')
  const [currentFace, setCurrentFace] = useState<AccelFace | null>(null)
  const [interrupted, setInterrupted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Construct on a fresh session identity, dispose on the previous one --
  // deliberately does NOT touch `status`/`currentFace`/`interrupted` when
  // `session` goes to `null` (a disconnect): that's exactly the state the
  // interrupted banner needs to keep describing. A genuinely *new* session
  // (reconnect) does get a fresh `AccelCalibration`, but still leaves
  // `status`/`interrupted` alone -- only `start()`/`abandon()` (the user
  // explicitly acting on the banner) resets them, see module doc.
  useEffect(() => {
    if (!session) return
    const cal = new AccelCalibration(session)
    calRef.current = cal

    const unsubFace = cal.onFacePrompt((face) => {
      setCurrentFace(face)
      setStatus(cal.status)
      setError(null)
    })
    const unsubComplete = cal.onComplete((ok) => {
      setStatus(cal.status)
      setCurrentFace(null)
      if (!ok) setError('Calibration failed on the board.')
      // Read-only signal for Task 10.1's Setup Guide -- see calibrationProgress.ts's own doc.
      else useCalibrationProgress.getState().markAccelDone()
    })

    return () => {
      unsubFace()
      unsubComplete()
      cal.dispose()
      if (calRef.current === cal) calRef.current = null
    }
  }, [session])

  // Latches `interrupted` -- computed during render (not a useEffect) per
  // React's "adjusting state" guidance, same idiom `useTelemetry.ts` already
  // uses in this codebase: this is a monotonic one-way latch, so the
  // `!interrupted` guard makes the `setInterrupted(true)` call below
  // idempotent -- it fires at most once per interruption, never loops (the
  // re-render it triggers has `interrupted === true`, so the condition is
  // false next time). Never clears here, see module doc.
  if (!interrupted && phase !== 'connected' && (status === 'running' || status === 'busy')) {
    setInterrupted(true)
  }

  function start(): void {
    const cal = calRef.current
    if (!cal) return
    setError(null)
    setInterrupted(false)
    setCurrentFace(null)
    cal.start().then(
      () => {
        if (calRef.current === cal) setStatus(cal.status)
      },
      (err: unknown) => {
        // Guarded: dispose() doesn't cancel this promise (see accelCal.ts's
        // own doc -- there's no real FC cancel), so a disconnect+reconnect
        // within start()'s timeout window can let this settle long after
        // `cal` was superseded by a fresh instance for the new session. An
        // unguarded write here would clobber that fresh instance's live
        // status/error with this stale one's.
        if (calRef.current !== cal) return
        setStatus(cal.status)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
    setStatus(cal.status) // reflects the synchronous 'busy' AccelCalibration.start() sets before its own first await
  }

  function captureFace(): void {
    const cal = calRef.current
    if (!cal) return
    setError(null)
    cal.captureFace().then(
      () => {
        if (calRef.current === cal) setStatus(cal.status)
      },
      (err: unknown) => {
        if (calRef.current !== cal) return // see start()'s own comment -- same stale-instance guard
        setStatus(cal.status)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
    setStatus(cal.status)
  }

  function abandon(): void {
    const cal = calRef.current
    if (!cal) return
    void cal.abandon().then(() => {
      if (calRef.current === cal) setStatus(cal.status)
    })
    setStatus(cal.status) // abandon() sets 'idle' synchronously, no real await inside
    setCurrentFace(null)
    setInterrupted(false)
    setError(null)
  }

  const stepIndex = currentFace ? ACCEL_FACE_ORDER.indexOf(currentFace) + 1 : 0
  const doneFaces = status === 'done' ? ACCEL_FACE_ORDER.length : Math.max(0, stepIndex - 1)

  return {
    status,
    currentFace,
    stepIndex,
    doneFaces,
    busy: status === 'busy',
    interrupted,
    error,
    start,
    captureFace,
    abandon,
  }
}
