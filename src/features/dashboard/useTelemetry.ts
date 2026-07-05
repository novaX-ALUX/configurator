import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MavSession } from '../../core/mavlink/session'
import type { TelemetryState } from '../../core/mavlink/telemetry'

/**
 * Subscribes to `session.telemetry`'s throttled snapshots (~10Hz — see
 * `Telemetry.subscribe`'s own throttle) and re-renders the calling component
 * with the latest `TelemetryState`. Takes `session` explicitly (typically
 * `useConnectionStore((s) => s.session)`) rather than reaching into the
 * connection store itself, so Dashboard (task 6.2) — or any other consumer —
 * can pass whatever session it already has, and this hook stays testable
 * against a directly-fed session instead of the whole app singleton.
 *
 * Returns `null` while there is no session (not connected yet, or torn down
 * on disconnect) — callers treat that as "no data yet", not an error.
 * Re-subscribes whenever `session` changes identity (a fresh `connect()`
 * generation never reuses the previous `Telemetry` instance — see
 * `connection.ts`'s module doc) and always unsubscribes first, so there is
 * never more than one live subscription and never a `setState` after this
 * hook's own unmount.
 *
 * **Stale-subscription guard.** The render-phase state swap below (rather
 * than an effect) makes `state` reflect a new `telemetry` immediately, but
 * React doesn't unsubscribe the *previous* effect until its passive-effect
 * cleanup actually runs — a real gap after commit, before that cleanup, in
 * which the old (not-yet-unsubscribed) `Telemetry` instance could still
 * emit and try to overwrite the already-correct new state with stale data.
 * `latestTelemetryRef` is written in a layout effect — which always flushes
 * before any passive effect's (i.e. the subscribe effect's below) cleanup
 * — so it's updated to the new `telemetry` before that gap can be reached,
 * letting each subscription's callback check "is my `telemetry` still the
 * current one?" and drop the update if not, independent of whether its own
 * cleanup has run yet.
 */
export function useTelemetry(session: MavSession | null): Readonly<TelemetryState> | null {
  const telemetry = session?.telemetry ?? null

  // "Adjusting state when a prop changes" (react.dev) rather than deriving it
  // in an effect: `telemetry` changing identity (reconnect, or session
  // becoming null) is detected during render by comparing against the
  // previous render's value, and `state` is reset to that new telemetry's
  // current snapshot right away — no extra render, and nothing for the
  // effect below to do except the one thing an effect is actually for here
  // (subscribing to the external `Telemetry` instance).
  const [prevTelemetry, setPrevTelemetry] = useState(telemetry)
  const [state, setState] = useState<Readonly<TelemetryState> | null>(() => telemetry?.getState() ?? null)
  if (telemetry !== prevTelemetry) {
    setPrevTelemetry(telemetry)
    setState(telemetry?.getState() ?? null)
  }

  const latestTelemetryRef = useRef(telemetry)
  useLayoutEffect(() => {
    latestTelemetryRef.current = telemetry
  })

  useEffect(() => {
    if (!telemetry) return
    return telemetry.subscribe((s) => {
      if (latestTelemetryRef.current === telemetry) setState(s)
    })
  }, [telemetry])

  return state
}
