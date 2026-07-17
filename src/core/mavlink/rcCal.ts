/**
 * RC-calibration session state machine (issue #38, PRD #32) — the
 * calibration module with the simplest possible safety story: it writes
 * nothing because it *can't*. Unlike `accelCal.ts`/`magCal.ts` this class
 * holds no router, no `sendCommand`, no `ParamStore` — its only collaborator
 * is the Telemetry snapshot it reads RC-channel and heartbeat state from, so
 * the zero-parameter-write guarantee is structural, not behavioral. Detected
 * results only ever reach the vehicle through the Calibration page's staged
 * store (`createStagedSlice`) after the user reviews and Applies (ADR-0003
 * Review Gate); this module merely detects.
 *
 * **Why it consumes `Telemetry`, not raw frames.** `telemetry.ts`'s module
 * doc is explicit that nothing else in the app decodes RC_CHANNELS/HEARTBEAT
 * payloads — that layer already unit-converts both blocks and derives
 * `armed` from `base_mode`. Subscribing to the snapshot (throttled ~10Hz,
 * leading-edge immediate) also costs nothing in fidelity: RC_CHANNELS is
 * requested at 5Hz (`connection.ts`'s stream-rate table), below the
 * throttle, so every RC update reaches `handleUpdate`. No extra stream
 * request is needed either — RC_CHANNELS is already flowing for the
 * Dashboard, and HEARTBEAT is always broadcast.
 *
 * **Phases.** `idle -> sampling -> done`, plus `aborted`:
 *  - `start()` requires the latest heartbeat to exist AND show disarmed
 *    (grill Q4's entry gate; the props-off confirmation half of that gate is
 *    UI state, owned by the Calibration page). Link *liveness* is also the
 *    caller's gate — a frozen Telemetry snapshot can't distinguish "stale"
 *    from "old but live", and the page already watches `phase`.
 *  - While `sampling`, every RC update folds into per-channel min/max plus
 *    the live value the channel bars render. An armed heartbeat aborts
 *    instantly and discards every detected value (`aborted`), because the
 *    calibration choreography itself includes the rudder-arm gesture
 *    (throttle low + full right yaw) — nothing from an aborted run may
 *    survive to be staged.
 *  - `finish()` (the "center sticks, throttle low, done" click) captures
 *    each channel's trim from its last valid sample — which is by
 *    construction within [min, max] — and lands on `done`.
 *
 * **Sample validity.** A sample is folded in only when it's inside
 * [800, 2200]µs — the bundled metadata's own documented range for
 * `RC{idx}_MIN`/`MAX`/`TRIM` (`public/param-metadata/4.6.json`). `0` and
 * `UINT16_MAX` are the RC_CHANNELS "channel not available/unused"
 * conventions, and anything else outside that window is a glitch ArduPilot
 * itself would never accept as an endpoint — a single corrupt frame must
 * not poison a run's detected MIN/MAX.
 *
 * **Moved threshold.** A channel counts as moved once its observed span
 * reaches `RC_CAL_MOVED_THRESHOLD_US` (100µs) — an order of magnitude above
 * real receiver jitter (a few µs), far below the smallest real control
 * range (a 2-position switch spans ~800µs). Unmoved channels keep their
 * live bar but are marked so the UI excludes them from staging: an
 * unplugged or dead channel's bogus range is never written (PRD story 24).
 * This threshold is this project's own choice, not a cited upstream value.
 */
import type { TelemetryState } from './telemetry'

/** RC1..RC16 — the channels ArduPilot has `RC{idx}_MIN/MAX/TRIM/REVERSED` parameters for. RC_CHANNELS carries 18, but 17/18 have no parameters to calibrate. */
export const RC_CAL_CHANNEL_COUNT = 16

/** Plausibility window for one RC sample (µs) — the bundled metadata's own `RC{idx}_MIN`/`MAX` range, see module doc. */
export const RC_CAL_VALID_MIN_US = 800
export const RC_CAL_VALID_MAX_US = 2200

/** Span (µs) past which a channel counts as deliberately moved — see module doc for the bounds rationale. */
export const RC_CAL_MOVED_THRESHOLD_US = 100

const UINT16_MAX = 0xffff

export type RcCalPhase = 'idle' | 'sampling' | 'done' | 'aborted'

export interface RcChannelTrack {
  /** 1-based channel number (RC1..RC16). */
  channel: number
  /** Last valid sample seen this run (µs) — what the live bar renders. */
  value: number | undefined
  min: number | undefined
  max: number | undefined
  /** Captured by `finish()` from the last valid sample; `undefined` until then and for channels that never produced one. */
  trim: number | undefined
  /** True once `max - min` reaches `RC_CAL_MOVED_THRESHOLD_US`. Unmoved channels must be excluded from staging by the caller. */
  moved: boolean
}

export interface RcCalSnapshot {
  phase: RcCalPhase
  /** Always exactly `RC_CAL_CHANNEL_COUNT` entries, index 0 = channel 1. */
  channels: RcChannelTrack[]
}

/**
 * The Telemetry surface this module needs — a structural subset of
 * `Telemetry` (`session.telemetry` satisfies it as-is), narrowed so the
 * dependency is exactly "read RC/heartbeat state", nothing stream- or
 * command-shaped.
 */
export interface RcTelemetrySource {
  getState(): Readonly<TelemetryState>
  subscribe(cb: (s: Readonly<TelemetryState>) => void): () => void
}

/** Thrown by `start()` when the entry gate isn't met: `'no-heartbeat'` (never seen one — armed-ness unknown) or `'armed'` (the latest heartbeat shows armed). */
export class RcCalStartBlockedError extends Error {
  constructor(public readonly reason: 'no-heartbeat' | 'armed') {
    super(`RcCalibration.start: blocked (${reason})`)
    this.name = 'RcCalStartBlockedError'
  }
}

function emptyTracks(): RcChannelTrack[] {
  return Array.from({ length: RC_CAL_CHANNEL_COUNT }, (_, i) => ({
    channel: i + 1,
    value: undefined,
    min: undefined,
    max: undefined,
    trim: undefined,
    moved: false,
  }))
}

export class RcCalibration {
  private phase: RcCalPhase = 'idle'
  private tracks: RcChannelTrack[] = emptyTracks()

  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void

  constructor(private readonly telemetry: RcTelemetrySource) {
    this.unsubscribe = telemetry.subscribe((s) => this.handleUpdate(s))
  }

  /** Copies, not live views — safe to hold across later updates (React state, assertions). */
  snapshot(): RcCalSnapshot {
    return { phase: this.phase, channels: this.tracks.map((t) => ({ ...t })) }
  }

  /**
   * Clears any previous run and enters `sampling`. Throws
   * `RcCalStartBlockedError` unless the latest heartbeat exists and shows
   * disarmed — the armed half of the entry gate; props-off confirmation and
   * link liveness are the caller's (see module doc). The current RC block,
   * if any, seeds the tracks immediately so the bars aren't blank until the
   * next 5Hz update.
   */
  start(): void {
    const heartbeat = this.telemetry.getState().heartbeat
    if (!heartbeat) throw new RcCalStartBlockedError('no-heartbeat')
    if (heartbeat.armed) throw new RcCalStartBlockedError('armed')

    this.tracks = emptyTracks()
    this.phase = 'sampling'
    const rc = this.telemetry.getState().rc
    if (rc) this.applySamples(rc.channels)
    this.notify()
  }

  /**
   * `sampling -> done`: captures each channel's trim from its last valid
   * sample (the "center sticks, throttle low" position the wizard asks for
   * right before this click; for the throttle that lands at ~MIN, which is
   * the conventional throttle trim). A no-op outside `sampling` — the one
   * real caller races an armed abort, and the abort must win.
   */
  finish(): void {
    if (this.phase !== 'sampling') return
    for (const t of this.tracks) t.trim = t.value
    this.phase = 'done'
    this.notify()
  }

  /** Back to `idle`, clearing all tracking. Safe from any phase. */
  cancel(): void {
    this.tracks = emptyTracks()
    this.phase = 'idle'
    this.notify()
  }

  /** Registers a change callback (phase transitions and applied samples); returns an unsubscribe function. Read `snapshot()` for the current state. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** Unsubscribes from telemetry and drops all listeners. Safe to call once. */
  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  // --- internals ---------------------------------------------------------

  private handleUpdate(s: Readonly<TelemetryState>): void {
    if (this.phase !== 'sampling') return
    if (s.heartbeat?.armed) {
      // Armed mid-calibration: discard everything, instantly. See module doc.
      this.tracks = emptyTracks()
      this.phase = 'aborted'
      this.notify()
      return
    }
    if (s.rc) {
      this.applySamples(s.rc.channels)
      this.notify()
    }
  }

  private applySamples(channels: readonly number[]): void {
    for (let i = 0; i < RC_CAL_CHANNEL_COUNT; i++) {
      const sample = channels[i]
      if (sample === 0 || sample === UINT16_MAX) continue // "not available"/"unused" per RC_CHANNELS
      if (sample < RC_CAL_VALID_MIN_US || sample > RC_CAL_VALID_MAX_US) continue // glitch — see module doc
      const t = this.tracks[i]
      t.value = sample
      t.min = t.min === undefined ? sample : Math.min(t.min, sample)
      t.max = t.max === undefined ? sample : Math.max(t.max, sample)
      t.moved = t.max - t.min >= RC_CAL_MOVED_THRESHOLD_US
    }
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }
}
