/**
 * Pure derivation for the global telemetry status strip (issue #11, UI G2):
 * turns a Telemetry Snapshot + the connection store's STATUSTEXT log + link
 * stats into the six display-ready values the strip renders. Split out from
 * `TelemetryStrip.tsx` so the derivation is unit-testable against fixtures
 * without mounting React — same split as `dashboard/dashboardUtils.ts`.
 *
 * Every field is `undefined` when genuinely unknown (no HEARTBEAT/GPS/power
 * block received yet) — the strip renders that as an em-dash, never a stale
 * or fabricated value (ADR-0002-adjacent honesty rule already followed by
 * every Dashboard card).
 */
import type { TelemetryState } from '../core/mavlink/telemetry'
import type { StatusTextEntry } from '../store/connection'
import type { MavRouterStats } from '../core/mavlink/router'
import { arduCopterModeName, gpsFixTier, type GpsFixTier, PREARM_PREFIX } from '../features/dashboard/dashboardUtils'

/**
 * `'unknown'` (issue #19): disarmed with zero PreArm evidence on record.
 * ArduPilot only broadcasts PreArm failures periodically while disarmed —
 * there is no push on connect and no "all checks passed" message ever sent —
 * so silence is indistinguishable from "the first round just hasn't arrived
 * yet". Rendering that as Ready fabricates a state the session cannot back
 * up. `'ready'` is shown only once real evidence exists: the vehicle has
 * actually armed (ArduPilot itself gates arming on every check passing).
 */
export type PrearmStatus = 'unknown' | 'ready' | 'notReady'

export interface PrearmStripState {
  status: PrearmStatus
  /** Count of distinct "PreArm: ..." STATUSTEXT messages currently on record. Only meaningful when `status` is `'notReady'`. */
  count: number
}

export type LinkLossTier = 'good' | 'degraded' | 'bad'

/**
 * Judgement-call thresholds (not specified by issue #11 — "msg rate or
 * packet loss" left the exact metric open): 0% is the only "good" reading
 * since any dropped frame this session is a real, already-happened event;
 * up to 2% is "degraded" (link is noisy but usably intact); above that is
 * "bad". Pulled out of `TelemetryStrip.tsx` so the boundaries are
 * unit-testable against fixtures, same as every other derivation here.
 */
export function linkLossTier(pct: number): LinkLossTier {
  if (pct === 0) return 'good'
  if (pct <= 2) return 'degraded'
  return 'bad'
}

export interface StatusStripData {
  /** `undefined`: no HEARTBEAT received yet. */
  armed?: boolean
  /** `undefined`: no HEARTBEAT received yet. */
  modeLabel?: string
  /** `undefined`: no HEARTBEAT received yet — can't assess PreArm state without knowing the vehicle is there. */
  prearm?: PrearmStripState
  voltage?: number
  current?: number
  gpsFix?: GpsFixTier
  gpsSatellites?: number
  /** Percent of candidate frames rejected (CRC/bad-msgid/garbage) over the session so far. `undefined` before any link stats snapshot exists. */
  linkLossPct?: number
}

/**
 * PreArm state while disarmed: distinct "PreArm: ..." STATUSTEXT texts seen
 * so far this session, deduped by exact text (ArduPilot re-sends each
 * failing check's line roughly once a second, so dedup-by-text approximates
 * "currently failing checks", not "messages ever logged"). A successful arm
 * is the one real signal ArduPilot gives that every check passed — cheaper
 * and more honest than trying to guess when an individual check cleared
 * from the STATUSTEXT stream alone, which never announces a resolution.
 *
 * Zero distinct failures while disarmed is deliberately NOT read as Ready
 * (issue #19): that's exactly the fresh-connect silence the ticket flags,
 * and it recurs every time the vehicle disarms again with no new failure
 * logged yet — a stale "Ready" would be just as fabricated the second time
 * as the first. `'unknown'` until a failure report actually arrives, or the
 * vehicle proves it by arming.
 */
function derivePrearm(armed: boolean, statustext: readonly StatusTextEntry[]): PrearmStripState {
  if (armed) return { status: 'ready', count: 0 }
  const failures = new Set(statustext.filter((e) => PREARM_PREFIX.test(e.text)).map((e) => e.text))
  if (failures.size === 0) return { status: 'unknown', count: 0 }
  return { status: 'notReady', count: failures.size }
}

export function deriveStatusStrip(
  telemetry: Readonly<TelemetryState> | null,
  statustext: readonly StatusTextEntry[],
  linkStats: MavRouterStats | null,
): StatusStripData {
  const heartbeat = telemetry?.heartbeat
  const gps = telemetry?.gps
  const power = telemetry?.power

  const totalFrames = linkStats ? linkStats.framesIn + linkStats.dropped : 0

  return {
    armed: heartbeat?.armed,
    modeLabel: heartbeat ? arduCopterModeName(heartbeat.customMode) : undefined,
    prearm: heartbeat ? derivePrearm(heartbeat.armed, statustext) : undefined,
    voltage: power?.voltage,
    current: power?.current,
    gpsFix: gps ? gpsFixTier(gps.fixType) : undefined,
    gpsSatellites: gps?.satellites,
    linkLossPct: linkStats ? (totalFrames > 0 ? (linkStats.dropped / totalFrames) * 100 : 0) : undefined,
  }
}
