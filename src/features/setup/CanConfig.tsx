import { useTranslation } from 'react-i18next'
import { DRONECAN_ESC_FIELD, ESC_PROTOCOL_FIELD, isDroneCanEscActive, servoFunctionMismatches } from './paramEnums'

interface CanConfigProps {
  /** Effective (pending ?? board) values of the three enable-chain params, in `DRONECAN_ESC_FIELD.params` order — `undefined` when the board doesn't have the param. */
  driver: number | undefined
  protocol: number | undefined
  bitmask: number | undefined
  /** Effective `MOT_PWM_TYPE` — a non-default (≠ 0) value while the chain is active is a leftover worth noting (issue #57). */
  motPwmType: number | undefined
  /** Label of a staged-but-unapplied `MOT_PWM_TYPE` pick (the pending entry's own label), `undefined` when none — drives the still-enabled notice (issue #57). Takes precedence over the leftover note: both would describe the same value, and the notice is the one that answers the click the user just made. */
  stagedPwmLabel: string | undefined
  /** Effective `SERVO{output}_FUNCTION` reader for the read-only Motor1..N mapping check (issue #57). */
  servoFunctionOf: (output: number) => number | undefined
  /** Disable action (issue #57): the page stages `CAN_D1_UC_ESC_BM = 0` — never `CAN_P1_DRIVER`. `label` is the resolved button text, for the review bar's chip. */
  onDisable: (label: string) => void
}

/** Motor count when the mask is the contiguous bits-0..N−1 shape this feature stages, else `null` (the raw mask is shown then — e.g. a hand-edited escape-hatch value). */
function contiguousMotorCount(bitmask: number): number | null {
  const count = Math.log2(bitmask + 1)
  return Number.isInteger(count) ? count : null
}

/**
 * CAN configuration card (issue #55), revealed under the ESC PROTOCOL card
 * when the DroneCAN chain is effectively active or the user selected the
 * DroneCAN chip without a usable frame. Two states, decided by the same
 * `isDroneCanEscActive` rule the chip highlight uses: the enable-chain
 * readout (what is / will be enabled), or the frame-first prompt — the only
 * way this card is open while the chain is inactive is a chip click that
 * had no frame to derive the bitmask from, so nothing was staged.
 *
 * Issue #57 adds the chain state's guard rails, all state-derived like the
 * chip highlight (they appear/disappear with staging, Revert, Apply):
 *
 * - the still-enabled notice when a PWM-family pick is staged while the
 *   chain is active — the pick stages `MOT_PWM_TYPE` only, never a CAN
 *   param as a side effect;
 * - the leftover note when the effective `MOT_PWM_TYPE` holds a non-default
 *   value with nothing staged (0 is the firmware default — nothing left
 *   over);
 * - the read-only `SERVOx_FUNCTION` warning when Motor1..N aren't on
 *   outputs 1..N — validated only for the contiguous masks this feature
 *   stages (`servoFunctionMismatches` on `motorCount`); a raw escape-hatch
 *   mask has no expected layout to compare against;
 * - the disable action, staging `CAN_D1_UC_ESC_BM = 0` through `onDisable`
 *   and nothing else — the CAN interface may serve other Nodes.
 *
 * Writes happen only in the sticky review bar; nothing here touches the
 * board directly.
 */
export function CanConfig({ driver, protocol, bitmask, motPwmType, stagedPwmLabel, servoFunctionOf, onDisable }: CanConfigProps) {
  const { t } = useTranslation()
  const chain =
    driver !== undefined && protocol !== undefined && bitmask !== undefined && isDroneCanEscActive(driver, protocol, bitmask)
      ? { driver, protocol, bitmask, motorCount: contiguousMotorCount(bitmask) }
      : null
  const [driverParam, protocolParam, bitmaskParam] = DRONECAN_ESC_FIELD.params
  const rows = chain
    ? [
        {
          param: driverParam,
          label: t('setup.esc.can.driver'),
          display: chain.driver === DRONECAN_ESC_FIELD.driverValue ? t('setup.esc.can.driverFirst') : `${chain.driver}`,
          raw: chain.driver,
        },
        {
          param: protocolParam,
          label: t('setup.esc.can.protocol'),
          display: t('setup.esc.can.protocolDroneCan'), // active implies protocol == 1
          raw: chain.protocol,
        },
        {
          param: bitmaskParam,
          label: t('setup.esc.can.outputs'),
          display: chain.motorCount !== null ? t('setup.esc.can.motorsRange', { count: chain.motorCount }) : `${chain.bitmask}`,
          raw: chain.bitmask,
        },
      ]
    : null

  // Leftover MOT_PWM_TYPE, displayed with its chip label when it matches one
  // ("DShot300 (5)"), else as the bare value — an escape-hatch value like
  // Brushed (3) is still a leftover.
  const leftoverOption = ESC_PROTOCOL_FIELD.options.find((o) => o.value === motPwmType)
  const leftover = chain && stagedPwmLabel === undefined && motPwmType !== undefined && motPwmType !== 0
  const servoMismatches = chain && chain.motorCount !== null ? servoFunctionMismatches(chain.motorCount, servoFunctionOf) : []
  const disableLabel = t('setup.esc.can.disable')

  return (
    <section className="mb-3.5 rounded-xl border border-nvx-border bg-white p-[18px] shadow-card">
      <div className="mb-3.5 flex items-center">
        <span className="text-[10.5px] font-extrabold tracking-[.14em] text-nvx-subtle">{t(DRONECAN_ESC_FIELD.titleKey)}</span>
        <span className="ml-2.5 rounded-md bg-nvx-field px-2 py-[3px] font-mono text-[10px] text-nvx-faint">
          {DRONECAN_ESC_FIELD.params.join(' · ')}
        </span>
      </div>
      {rows ? (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.param} className="flex items-baseline gap-2.5">
              <span className="w-[130px] flex-none text-[12px] text-nvx-subtle">{row.label}</span>
              <span className="text-[12.5px] font-bold text-nvx-text">{row.display}</span>
              <span className="ml-auto font-mono text-[10.5px] text-nvx-faint">
                {row.param} = {row.raw}
              </span>
            </div>
          ))}
          {stagedPwmLabel !== undefined && (
            <div className="mt-1 rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-3 py-2 text-[11.5px] leading-relaxed text-nvx-warningText">
              {t('setup.esc.can.stillEnabled', { label: stagedPwmLabel })}
            </div>
          )}
          {leftover && (
            <div className="mt-1 text-[11.5px] leading-relaxed text-nvx-muted">
              {t('setup.esc.can.leftoverPwm', { display: leftoverOption ? `${t(leftoverOption.labelKey)} (${motPwmType})` : `${motPwmType}` })}
            </div>
          )}
          {servoMismatches.length > 0 && (
            <div className="mt-1 rounded-lg border border-nvx-warningBorder bg-nvx-warningSoft px-3 py-2 text-[11.5px] leading-relaxed text-nvx-warningText">
              {t('setup.esc.can.servoWarning', { params: servoMismatches.join(', ') })}
            </div>
          )}
          <div className="mt-2 flex items-center gap-3 border-t border-nvx-border pt-3">
            <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-nvx-faint">{t('setup.esc.can.disableHint')}</span>
            <button
              type="button"
              onClick={() => onDisable(disableLabel)}
              className="flex-none rounded-[9px] border-[1.5px] border-nvx-dangerBorder bg-white px-3.5 py-2 text-[12px] font-bold text-nvx-danger hover:bg-nvx-dangerSoft"
            >
              {disableLabel}
            </button>
          </div>
        </div>
      ) : (
        <div className="text-[12.5px] leading-relaxed text-nvx-muted">{t('setup.esc.can.pickFrameFirst')}</div>
      )}
    </section>
  )
}
