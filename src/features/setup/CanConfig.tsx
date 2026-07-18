import { useTranslation } from 'react-i18next'
import { DRONECAN_ESC_FIELD, isDroneCanEscActive } from './paramEnums'

interface CanConfigProps {
  /** Effective (pending ?? board) values of the three enable-chain params, in `DRONECAN_ESC_FIELD.params` order — `undefined` when the board doesn't have the param. */
  driver: number | undefined
  protocol: number | undefined
  bitmask: number | undefined
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
 * Display only: staging happens on the chip (`SetupPage`), writes happen in
 * the sticky review bar. #57 adds the disable action and warnings here.
 */
export function CanConfig({ driver, protocol, bitmask }: CanConfigProps) {
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
        </div>
      ) : (
        <div className="text-[12.5px] leading-relaxed text-nvx-muted">{t('setup.esc.can.pickFrameFirst')}</div>
      )}
    </section>
  )
}
