/**
 * Telemetry Charts core layer (vocabulary: CONTEXT.md "Telemetry Charts"):
 * the `Recorder` turns Telemetry snapshot notifications into timestamped
 * `Sample`s in the `HistoryBuffer`.
 *
 * The two classes deliberately have different owners/lifecycles (the spec's
 * central decision):
 * - `Recorder` lives and dies with the Session — the connection store
 *   creates it alongside `Telemetry` once the link is 'connected' and
 *   disposes it on teardown.
 * - `HistoryBuffer` is owned by the connection store *outside* the Session:
 *   a disconnect freezes it (the Recorder is gone, nothing appends anymore)
 *   but leaves it readable for post-mortem inspection; only the next
 *   connect clears it — see the store's 'connected' handler.
 *
 * Event-driven, never fabricates: a Sample is appended only when a Block's
 * own receive timestamp changed since the last notification (per-Block
 * dedupe) — there is no sampling timer, no resampling, no interpolation.
 * Because `Telemetry.subscribe` coalesces notifications to ~10Hz and the
 * trailing edge carries only the latest snapshot, two updates of the *same*
 * Block inside one throttle window record only the later one — accepted by
 * the spec, which defines recording as per-notification with per-Block
 * `ts` dedupe.
 *
 * Series set (43): attitude roll/pitch/yaw, power voltage/current/
 * batteryRemaining, GPS satellites/hdop, RC ch1–ch18 + rssi, servo
 * out1–out16. `gps.fixType` is excluded (an enum, not a continuous
 * quantity) and heartbeat carries no numeric Series. `undefined` snapshot
 * fields are recorded as gaps (`value: null`), never as zeros.
 */
import type { Telemetry, TelemetryState } from './telemetry'

/** Rolling retention window — fixed at 60s in v1 (spec), not configurable. */
const RETENTION_MS = 60_000

export interface Sample {
  /** The owning Block's receive time (`TelemetryState[block].ts`), never a clock read of the Recorder's own — Samples are plotted at real arrival times. */
  ts: number
  /** `null` is a gap: the Block updated but this field was absent (`undefined`, e.g. current on a board without a sensor). */
  value: number | null
}

export class HistoryBuffer {
  private readonly samples = new Map<string, Sample[]>()
  /**
   * Newest `ts` ever appended — the rolling window's leading edge. Eviction
   * is keyed to this rather than a live clock so the buffer freezes (instead
   * of draining) the moment appends stop, e.g. after a disconnect.
   */
  private newestTs = -Infinity

  append(seriesId: string, ts: number, value: number | null): void {
    let series = this.samples.get(seriesId)
    if (series === undefined) {
      series = []
      this.samples.set(seriesId, series)
    }
    series.push({ ts, value })
    if (ts > this.newestTs) {
      this.newestTs = ts
      this.evictBefore(ts - RETENTION_MS)
    }
  }

  /** Drops every Sample older than `cutoff`, across all Series (a stalled Series must not pin memory forever). Samples arrive in `ts` order per Series, so only a prefix is ever trimmed. */
  private evictBefore(cutoff: number): void {
    for (const series of this.samples.values()) {
      let drop = 0
      while (drop < series.length && series[drop].ts < cutoff) drop++
      if (drop > 0) series.splice(0, drop)
    }
  }

  getSamples(seriesId: string): readonly Sample[] {
    return this.samples.get(seriesId) ?? []
  }

  /** Every Series that has received at least one Sample this session, in first-appended order. */
  seriesIds(): string[] {
    return [...this.samples.keys()]
  }

  clear(): void {
    this.samples.clear()
    this.newestTs = -Infinity
  }
}

/** The five recorded Blocks — heartbeat is deliberately not one (no numeric Series). */
type RecordedBlock = 'attitude' | 'power' | 'gps' | 'rc' | 'servo'

export class Recorder {
  /** Last recorded `ts` per Block — the per-Block dedupe: a notification in which a Block's `ts` did not change appends nothing for that Block. */
  private readonly lastBlockTs: Partial<Record<RecordedBlock, number>> = {}
  private readonly unsubscribe: () => void

  constructor(
    telemetry: Telemetry,
    private readonly buffer: HistoryBuffer,
  ) {
    this.unsubscribe = telemetry.subscribe((s) => this.record(s))
  }

  /** Detaches from Telemetry notifications; the buffer is left exactly as-is (frozen). */
  dispose(): void {
    this.unsubscribe()
  }

  private record(s: Readonly<TelemetryState>): void {
    const { attitude, power, gps, rc, servo } = s
    if (attitude !== undefined && attitude.ts !== this.lastBlockTs.attitude) {
      this.lastBlockTs.attitude = attitude.ts
      this.buffer.append('attitude.roll', attitude.ts, attitude.rollDeg)
      this.buffer.append('attitude.pitch', attitude.ts, attitude.pitchDeg)
      this.buffer.append('attitude.yaw', attitude.ts, attitude.yawDeg)
    }
    if (power !== undefined && power.ts !== this.lastBlockTs.power) {
      this.lastBlockTs.power = power.ts
      this.buffer.append('power.voltage', power.ts, power.voltage ?? null)
      this.buffer.append('power.current', power.ts, power.current ?? null)
      this.buffer.append('power.batteryRemaining', power.ts, power.batteryRemaining ?? null)
    }
    if (gps !== undefined && gps.ts !== this.lastBlockTs.gps) {
      this.lastBlockTs.gps = gps.ts
      this.buffer.append('gps.satellites', gps.ts, gps.satellites)
      this.buffer.append('gps.hdop', gps.ts, gps.hdop ?? null)
    }
    if (rc !== undefined && rc.ts !== this.lastBlockTs.rc) {
      this.lastBlockTs.rc = rc.ts
      for (let i = 0; i < 18; i++) this.buffer.append(`rc.ch${i + 1}`, rc.ts, rc.channels[i])
      this.buffer.append('rc.rssi', rc.ts, rc.rssi ?? null)
    }
    if (servo !== undefined && servo.ts !== this.lastBlockTs.servo) {
      this.lastBlockTs.servo = servo.ts
      for (let i = 0; i < 16; i++) this.buffer.append(`servo.out${i + 1}`, servo.ts, servo.outputs[i])
    }
  }
}
