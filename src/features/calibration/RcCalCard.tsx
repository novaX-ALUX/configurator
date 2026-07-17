import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RC_CAL_VALID_MAX_US, RC_CAL_VALID_MIN_US, type RcChannelTrack } from '../../core/mavlink/rcCal'
import type { ParamStore } from '../../core/mavlink/params'
import { fetchErrorMessage } from '../params/paramUtils'
import { stagePatch, type StagedEntry } from '../staged/stagedStore'
import { useRcCalStagedStore } from './rcCalStagedStore'
import type { RcCalState } from './useRcCalibration'

interface RcCalCardProps {
  rc: RcCalState
  connected: boolean
  paramStore: ParamStore | null
}

/** Bar-scale helpers: a µs value mapped into the plausible sample window the core module itself accepts. */
function barPct(us: number): number {
  return ((us - RC_CAL_VALID_MIN_US) / (RC_CAL_VALID_MAX_US - RC_CAL_VALID_MIN_US)) * 100
}

function fmt(us: number | undefined): string {
  return us === undefined ? '—' : String(Math.round(us))
}

/**
 * The RC-calibration wizard (issue #38): entry gate (props-off confirmation
 * + disarmed heartbeat, grill Q4), pre-loaded current `RC{n}_MIN/TRIM/MAX`
 * before anything starts (axPlanner's missing pre-read), live channel bars
 * while `RcCalibration` samples, and a results table whose detected values
 * — plus per-channel reverse toggles — only ever become Staged Changes in
 * `useRcCalStagedStore`. The page's `StagedReviewBar` + `writeAll` is the
 * sole write path (ADR-0003); nothing in this file touches the wire.
 *
 * Start is additionally gated on the parameter table having been pulled
 * (`fetchProgress.completed`, same honesty rule as SetupPage): without the
 * pre-read there are no "current" values to show, and the review table
 * would have no before column to diff against.
 */
export function RcCalCard({ rc, connected, paramStore }: RcCalCardProps) {
  const { t } = useTranslation()
  const { snapshot, armed, blocked, interrupted, start, finish, cancel } = rc
  const pending = useRcCalStagedStore((s) => s.pending)
  const stage = useRcCalStagedStore((s) => s.stage)

  const [propsConfirmed, setPropsConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // `paramStore.get()` isn't reactive on its own — same onChange +
  // version-bump idiom as SetupPage/MotorTestPage.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!paramStore) return
    return paramStore.onChange(() => setVersion((v) => v + 1))
  }, [paramStore])
  void version

  const loaded = paramStore !== null && paramStore.fetchProgress.completed

  /** Effective (staged-overlay) value, for the reverse toggles — same rule as SetupPage's `valueOf`. */
  function valueOf(param: string): number | undefined {
    return pending.get(param)?.value ?? paramStore?.get(param)?.value
  }

  function currentOf(channel: number): { min?: number; trim?: number; max?: number } {
    return {
      min: paramStore?.get(`RC${channel}_MIN`)?.value,
      trim: paramStore?.get(`RC${channel}_TRIM`)?.value,
      max: paramStore?.get(`RC${channel}_MAX`)?.value,
    }
  }

  async function handleLoad(): Promise<void> {
    if (!paramStore) return
    setLoading(true)
    setLoadError(null)
    try {
      await paramStore.fetchAll()
    } catch (err) {
      setLoadError(fetchErrorMessage(err, t))
    } finally {
      setLoading(false)
    }
  }

  /** Stages every moved channel's detected MIN/MAX/TRIM in one atomic update (`stagePatch`, not N `stage()` calls). Unmoved channels never enter (PRD story 24). */
  function stageResults(): void {
    const entries: StagedEntry[] = []
    for (const ch of snapshot.channels) {
      if (!ch.moved || ch.min === undefined || ch.max === undefined) continue
      const label = t('calibration.rc.stagedLabel', { n: ch.channel })
      entries.push({ param: `RC${ch.channel}_MIN`, value: ch.min, label })
      entries.push({ param: `RC${ch.channel}_MAX`, value: ch.max, label })
      if (ch.trim !== undefined) entries.push({ param: `RC${ch.channel}_TRIM`, value: ch.trim, label })
    }
    useRcCalStagedStore.setState((s) => stagePatch(s, entries))
  }

  const movedCount = snapshot.channels.filter((ch) => ch.moved).length
  const canStart = connected && propsConfirmed && armed === false && loaded

  const armedChip =
    armed === undefined ? (
      <span className="text-[11.5px] font-semibold text-nvx-faint">{t('calibration.rc.noHeartbeat')}</span>
    ) : armed ? (
      <span className="rounded-full bg-nvx-dangerSoft px-2.5 py-1 text-[11px] font-extrabold text-nvx-danger">{t('calibration.rc.armedChip')}</span>
    ) : (
      <span className="rounded-full bg-nvx-successSoft px-2.5 py-1 text-[11px] font-extrabold text-nvx-successText">{t('calibration.rc.disarmedChip')}</span>
    )

  return (
    <section className="mt-4 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-1.5 flex items-center gap-2.5">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t('calibration.rc.sectionTitle')}</span>
        <span className="ml-auto">{armedChip}</span>
      </div>

      {interrupted || snapshot.phase === 'aborted' ? (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-nvx-dangerBorder bg-nvx-dangerSoft px-3.5 py-2.5 text-nvx-dangerHover">
          <p className="text-[12.5px] font-semibold leading-relaxed">
            {interrupted ? t('calibration.rc.interrupted') : t('calibration.rc.aborted')}
          </p>
          <button
            type="button"
            disabled={!canStart}
            onClick={start}
            className="ml-auto flex-none rounded-lg border border-nvx-dangerBorder px-3 py-[7px] text-[11.5px] font-bold text-nvx-dangerHover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('calibration.rc.restartCta')}
          </button>
          <button
            type="button"
            onClick={cancel}
            className="flex-none rounded-lg px-3 py-[7px] text-[11.5px] font-semibold text-nvx-dangerHover hover:bg-nvx-dangerBorder/30"
          >
            {t('calibration.rc.dismissCta')}
          </button>
        </div>
      ) : snapshot.phase === 'sampling' ? (
        <>
          <p className="my-2 text-[12.5px] leading-relaxed text-nvx-muted">
            <span className="font-bold text-nvx-text">{t('calibration.rc.samplingTitle')}</span> {t('calibration.rc.samplingBody')}
          </p>
          <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
            {snapshot.channels.map((ch) => (
              <ChannelBar key={ch.channel} ch={ch} />
            ))}
          </div>
          <div className="mt-3.5 flex items-center gap-2.5">
            <button
              type="button"
              onClick={finish}
              className="rounded-[9px] bg-nvx-primary px-[18px] py-2.5 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover"
            >
              {t('calibration.rc.finishCta')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2.5 text-[12.5px] font-semibold text-nvx-text hover:bg-nvx-field"
            >
              {t('calibration.rc.cancelCta')}
            </button>
            <span className="text-[11.5px] text-nvx-faint">{t('calibration.rc.finishHint')}</span>
          </div>
        </>
      ) : snapshot.phase === 'done' ? (
        <>
          <p className="my-2 text-[12.5px] leading-relaxed text-nvx-muted">
            <span className="font-bold text-nvx-text">{t('calibration.rc.doneTitle')}</span> {t('calibration.rc.doneBody')}
          </p>
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="text-left text-[10.5px] font-extrabold tracking-[.08em] text-nvx-faint">
                <th className="py-1.5 pr-2">{t('calibration.rc.colChannel')}</th>
                <th className="py-1.5 pr-2">{t('calibration.rc.colCurrent')}</th>
                <th className="py-1.5 pr-2">{t('calibration.rc.colDetected')}</th>
                <th className="py-1.5 pr-2">{t('calibration.rc.colStatus')}</th>
                <th className="py-1.5">{t('calibration.rc.colReverse')}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.channels.map((ch) => {
                const cur = currentOf(ch.channel)
                const reversed = valueOf(`RC${ch.channel}_REVERSED`) === 1
                return (
                  <tr key={ch.channel} className={`border-t border-nvx-border ${ch.moved ? '' : 'text-nvx-faint'}`}>
                    <td className="py-1.5 pr-2 font-mono font-semibold">RC{ch.channel}</td>
                    <td className="py-1.5 pr-2 font-mono">
                      {fmt(cur.min)} / {fmt(cur.trim)} / {fmt(cur.max)}
                    </td>
                    <td className="py-1.5 pr-2 font-mono">
                      {fmt(ch.min)} / {fmt(ch.trim)} / {fmt(ch.max)}
                    </td>
                    <td className="py-1.5 pr-2">
                      {ch.moved ? (
                        <span className="rounded-full bg-nvx-successSoft px-2 py-0.5 text-[10.5px] font-extrabold text-nvx-successText">
                          {t('calibration.rc.movedBadge')}
                        </span>
                      ) : (
                        <span className="rounded-full bg-nvx-field px-2 py-0.5 text-[10.5px] font-extrabold">
                          {t('calibration.rc.unmovedBadge')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5">
                      {ch.moved && (
                        <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px]">
                          <input
                            type="checkbox"
                            checked={reversed}
                            onChange={(e) =>
                              stage(
                                `RC${ch.channel}_REVERSED`,
                                e.target.checked ? 1 : 0,
                                t('calibration.rc.stagedReverseLabel', { n: ch.channel }),
                              )
                            }
                            className="h-[15px] w-[15px] cursor-pointer accent-nvx-primary"
                            aria-label={t('calibration.rc.reverseAria', { n: ch.channel })}
                          />
                          {t('calibration.rc.reverseLabel')}
                        </label>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="mt-3 flex items-center gap-2.5">
            <button
              type="button"
              disabled={movedCount === 0}
              onClick={stageResults}
              className="rounded-[9px] bg-nvx-primary px-[18px] py-2.5 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('calibration.rc.stageCta', { count: movedCount })}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2.5 text-[12.5px] font-semibold text-nvx-text hover:bg-nvx-field"
            >
              {t('calibration.rc.discardCta')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="my-2 text-[12.5px] leading-relaxed text-nvx-muted">{t('calibration.rc.idleBody')}</p>

          {loaded ? (
            <table className="my-2 w-auto border-collapse font-mono text-[11.5px]">
              <thead>
                <tr className="text-left text-[10px] font-extrabold tracking-[.08em] text-nvx-faint">
                  <th className="py-1 pr-4">{t('calibration.rc.colChannel')}</th>
                  <th className="py-1 pr-4">MIN</th>
                  <th className="py-1 pr-4">TRIM</th>
                  <th className="py-1 pr-4">MAX</th>
                  <th className="py-1">{t('calibration.rc.colReversedShort')}</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 16 }, (_, i) => i + 1)
                  .filter((n) => paramStore?.get(`RC${n}_MIN`) !== undefined)
                  .map((n) => {
                    const cur = currentOf(n)
                    return (
                      <tr key={n} className="border-t border-nvx-border">
                        <td className="py-1 pr-4 font-semibold">RC{n}</td>
                        <td className="py-1 pr-4">{fmt(cur.min)}</td>
                        <td className="py-1 pr-4">{fmt(cur.trim)}</td>
                        <td className="py-1 pr-4">{fmt(cur.max)}</td>
                        <td className="py-1">{paramStore?.get(`RC${n}_REVERSED`)?.value === 1 ? t('calibration.rc.reversedYes') : t('calibration.rc.reversedNo')}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          ) : (
            <div className="my-2 flex items-center gap-2.5">
              <button
                type="button"
                disabled={!connected || loading}
                onClick={() => void handleLoad()}
                className="rounded-[9px] border border-nvx-borderStrong bg-white px-3.5 py-2 text-[12px] font-semibold text-nvx-text hover:bg-nvx-field disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? t('calibration.rc.loadingCurrent') : t('calibration.rc.loadCta')}
              </button>
              <span className="text-[11.5px] text-nvx-faint">{t('calibration.rc.loadHint')}</span>
            </div>
          )}
          {loadError && <p className="my-1.5 text-[11.5px] font-semibold text-nvx-danger">{loadError}</p>}

          <label className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-nvx-warningBorder bg-nvx-warningSoft p-3">
            <input
              type="checkbox"
              checked={propsConfirmed}
              onChange={(e) => setPropsConfirmed(e.target.checked)}
              className="mt-0.5 h-[17px] w-[17px] cursor-pointer accent-nvx-warning"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-extrabold text-nvx-warningText">{t('calibration.rc.propsLabel')}</span>
              <span className="text-[11.5px] text-nvx-warningText">{t('calibration.rc.propsHint')}</span>
            </span>
          </label>

          <div className="mt-3 flex items-center gap-2.5">
            <button
              type="button"
              disabled={!canStart}
              onClick={start}
              className="rounded-[9px] bg-nvx-primary px-[18px] py-2.5 text-[12.5px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('calibration.rc.startCta')}
            </button>
            {!canStart && connected && (
              <span className="text-[11.5px] text-nvx-faint">
                {!loaded ? t('calibration.rc.gateNeedLoad') : !propsConfirmed ? t('calibration.rc.gateNeedProps') : armed !== false ? t('calibration.rc.gateNeedDisarm') : ''}
              </span>
            )}
          </div>
          {blocked && (
            <p className="mt-2 text-[11.5px] font-semibold text-nvx-danger">
              {blocked === 'armed' ? t('calibration.rc.startBlockedArmed') : t('calibration.rc.startBlockedNoHeartbeat')}
            </p>
          )}
        </>
      )}
    </section>
  )
}

/** One live channel row while sampling: label, value bar over the detected-range band, min–max readout. */
function ChannelBar({ ch }: { ch: RcChannelTrack }) {
  const { t } = useTranslation()
  const noSignal = ch.value === undefined
  return (
    <div className="flex items-center gap-2">
      <span className={`w-9 flex-none font-mono text-[11px] font-semibold ${ch.moved ? 'text-nvx-text' : 'text-nvx-faint'}`}>RC{ch.channel}</span>
      <div className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-[4px] bg-nvx-field">
        {ch.min !== undefined && ch.max !== undefined && (
          <span
            className="absolute inset-y-0 rounded-[4px] bg-nvx-primary/20"
            style={{ left: `${barPct(ch.min)}%`, width: `${Math.max(barPct(ch.max) - barPct(ch.min), 0.5)}%` }}
          />
        )}
        {ch.value !== undefined && (
          <span className="absolute inset-y-0 w-[3px] rounded-sm bg-nvx-primary" style={{ left: `calc(${barPct(ch.value)}% - 1.5px)` }} />
        )}
      </div>
      <span className="w-[86px] flex-none text-right font-mono text-[10.5px] text-nvx-faint">
        {noSignal ? t('calibration.rc.noSignal') : `${fmt(ch.min)}–${fmt(ch.max)}`}
      </span>
    </div>
  )
}
