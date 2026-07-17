/**
 * Flight-mode slot logic (issue #37): which FLTMODE1..6 slot the
 * transmitter's mode switch currently selects, and the SIMPLE/SUPER_SIMPLE
 * per-slot bitmask arithmetic. Mode *names* are never defined here — they
 * come from the bundled parameter metadata (a missing enum is a metadata
 * bug, PRD #32). What is defined here are ArduPilot's protocol constants:
 * the PWM bands of `RC_Channel::read_6pos_switch` and the bit-per-slot
 * layout its `SIMPLE`/`SUPER_SIMPLE` descriptions document.
 */

export const FLTMODE_PARAMS = ['FLTMODE1', 'FLTMODE2', 'FLTMODE3', 'FLTMODE4', 'FLTMODE5', 'FLTMODE6'] as const
export const FLTMODE_CH_PARAM = 'FLTMODE_CH'
export const SIMPLE_PARAM = 'SIMPLE'
export const SUPER_SIMPLE_PARAM = 'SUPER_SIMPLE'

/**
 * Upper PWM bound of each slot's band (`RC_Channel::read_6pos_switch`):
 * slot 0 ≤1230, then 1360/1490/1620/1749, slot 5 ≥1750. Displayed next to
 * each slot so the user can match transmitter endpoints without memorizing
 * them.
 */
export const SLOT_PWM_LABELS = ['≤ 1230', '1231–1360', '1361–1490', '1491–1620', '1621–1749', '≥ 1750'] as const

/**
 * The slot index (0-based, slot 0 = FLTMODE1) the vehicle's mode switch
 * currently selects, or `null` when that can't be known: no/disabled
 * `FLTMODE_CH`, no RC telemetry yet, or a pulse outside the firmware's
 * valid window (≤900 µs or ≥2100 µs — which also covers MAVLink's 0 /
 * UINT16_MAX "channel not available" markers).
 *
 * `fltmodeCh` must be the value actually written on the board, not a staged
 * edit — the firmware switches on what it has, not on what's pending.
 */
export function activeFlightModeSlot(fltmodeCh: number | undefined, channels: readonly number[] | undefined): number | null {
  if (fltmodeCh === undefined || !channels) return null
  const pwm = channels[fltmodeCh - 1]
  if (pwm === undefined || !Number.isFinite(pwm)) return null
  if (pwm <= 900 || pwm >= 2100) return null
  if (pwm < 1231) return 0
  if (pwm < 1361) return 1
  if (pwm < 1491) return 2
  if (pwm < 1621) return 3
  if (pwm < 1750) return 4
  return 5
}

/** Whether `mask` has slot `slotIndex`'s bit set (bit 0 = FLTMODE1). Boards report masks as REAL32, hence the rounding. */
export function slotBitEnabled(mask: number | undefined, slotIndex: number): boolean {
  if (mask === undefined) return false
  return (Math.round(mask) & (1 << slotIndex)) !== 0
}

/** `mask` with slot `slotIndex`'s bit set or cleared, all other bits untouched. */
export function withSlotBit(mask: number, slotIndex: number, enabled: boolean): number {
  const bit = 1 << slotIndex
  return enabled ? Math.round(mask) | bit : Math.round(mask) & ~bit
}
