/**
 * Owns one `RcCalibration` (core/mavlink/rcCal.ts) instance per session
 * generation — same construct/dispose-on-session-change lifecycle as
 * `useAccelCalibration`/`useCompassCalibration`, see those hooks' docs for
 * the shared reasoning (interrupted latch never auto-clearing, a fresh
 * session not silently resetting an unacknowledged banner).
 *
 * Alongside the state machine's own snapshot this hook exposes `armed` (from
 * the same Telemetry the machine reads) because the entry gate needs it
 * *before* `start()` exists to enforce anything: the Start button disables —
 * and explains itself — while the heartbeat is missing or armed, rather than
 * letting a click bounce off `RcCalStartBlockedError`. The throw is still
 * caught and surfaced (`blocked`, carrying the typed reason so the card can
 * render reason-specific copy) for the race where arming lands between the
 * last render and the click.
 */
import { useEffect, useRef, useState } from 'react'
import { RcCalibration, RcCalStartBlockedError, type RcCalSnapshot } from '../../core/mavlink/rcCal'
import type { MavSession } from '../../core/mavlink/session'
import type { ConnectionPhase } from '../../store/connection'

const IDLE_SNAPSHOT: RcCalSnapshot = { phase: 'idle', channels: [] }

export interface RcCalState {
  snapshot: RcCalSnapshot
  /** Latest heartbeat's armed flag; `undefined` until one has been seen this session. */
  armed: boolean | undefined
  /** Why the last `start()` bounced (the entry-gate race), cleared on the next start/cancel. */
  blocked: 'no-heartbeat' | 'armed' | null
  /** Set once the link drops mid-`sampling`; never clears on its own — same latch idiom as the accel/compass hooks. */
  interrupted: boolean
  start: () => void
  finish: () => void
  cancel: () => void
}

export function useRcCalibration(session: MavSession | null, phase: ConnectionPhase): RcCalState {
  const calRef = useRef<RcCalibration | null>(null)

  const [snapshot, setSnapshot] = useState<RcCalSnapshot>(IDLE_SNAPSHOT)
  const [armed, setArmed] = useState<boolean | undefined>(undefined)
  const [blocked, setBlocked] = useState<'no-heartbeat' | 'armed' | null>(null)
  const [interrupted, setInterrupted] = useState(false)

  useEffect(() => {
    if (!session) return
    const cal = new RcCalibration(session.telemetry)
    calRef.current = cal

    // No snapshot/armed sync here (only these subscription callbacks): a
    // fresh session deliberately does NOT reset what's on screen — same
    // policy as the accel/compass hooks' never-auto-clearing banners. The
    // user leaves a stale 'done'/'aborted' view via start/cancel, both of
    // which run against the new instance; and `armed` refreshes within one
    // heartbeat, with the authoritative gate being `RcCalibration.start()`'s
    // own live read either way.
    const unsubCal = cal.onChange(() => setSnapshot(cal.snapshot()))
    const unsubTelemetry = session.telemetry.subscribe((s) => setArmed(s.heartbeat?.armed))

    return () => {
      unsubCal()
      unsubTelemetry()
      cal.dispose()
      if (calRef.current === cal) calRef.current = null
    }
  }, [session])

  // Latches `interrupted` — computed during render, not a useEffect, same
  // monotonic-latch idiom as the accel/compass hooks (the `!interrupted`
  // guard makes it idempotent). Sampling is the only phase worth latching:
  // 'done' results are complete detections and stay reviewable; nothing was
  // in flight.
  if (!interrupted && phase !== 'connected' && snapshot.phase === 'sampling') {
    setInterrupted(true)
  }

  function start(): void {
    const cal = calRef.current
    if (!cal) return
    setBlocked(null)
    setInterrupted(false)
    try {
      cal.start()
    } catch (err) {
      // The card disables Start unless the latest heartbeat is disarmed, so
      // this only fires on the arm-vs-click race the module doc describes.
      // `start()` throws nothing else by construction — anything different
      // is a programming error and should stay loud.
      if (!(err instanceof RcCalStartBlockedError)) throw err
      setBlocked(err.reason)
    }
  }

  function finish(): void {
    calRef.current?.finish()
  }

  function cancel(): void {
    setBlocked(null)
    setInterrupted(false)
    calRef.current?.cancel()
    // A cancel with no live instance (post-disconnect banner dismissal) still
    // needs the stale snapshot cleared — there is no cal.onChange to do it.
    if (!calRef.current) setSnapshot(IDLE_SNAPSHOT)
  }

  return { snapshot, armed, blocked, interrupted, start, finish, cancel }
}
