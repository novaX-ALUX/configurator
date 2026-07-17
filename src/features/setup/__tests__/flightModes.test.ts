import { describe, expect, it } from 'vitest'
import { activeFlightModeSlot, slotBitEnabled, withSlotBit } from '../flightModes'

/** chan5 carries the pwm; everything else at a neutral 1500. */
function channelsWith(ch: number, pwm: number): number[] {
  const channels = new Array<number>(18).fill(1500)
  channels[ch - 1] = pwm
  return channels
}

describe('activeFlightModeSlot', () => {
  it('maps each PWM band to its slot exactly at ArduPilot read_6pos_switch thresholds', () => {
    const cases: Array<[pwm: number, slot: number]> = [
      [1000, 0],
      [1230, 0],
      [1231, 1],
      [1360, 1],
      [1361, 2],
      [1490, 2],
      [1491, 3],
      [1620, 3],
      [1621, 4],
      [1749, 4],
      [1750, 5],
      [2000, 5],
    ]
    for (const [pwm, slot] of cases) {
      expect(activeFlightModeSlot(5, channelsWith(5, pwm)), `pwm ${pwm}`).toBe(slot)
    }
  })

  it('rejects out-of-window pulses the same way the firmware does (<=900 or >=2100)', () => {
    expect(activeFlightModeSlot(5, channelsWith(5, 900))).toBeNull()
    expect(activeFlightModeSlot(5, channelsWith(5, 901))).toBe(0)
    expect(activeFlightModeSlot(5, channelsWith(5, 2099))).toBe(5)
    expect(activeFlightModeSlot(5, channelsWith(5, 2100))).toBeNull()
    // MAVLink RC_CHANNELS "channel not available" markers
    expect(activeFlightModeSlot(5, channelsWith(5, 0))).toBeNull()
    expect(activeFlightModeSlot(5, channelsWith(5, 65535))).toBeNull()
  })

  it('returns null without a usable channel selection or RC data', () => {
    expect(activeFlightModeSlot(undefined, channelsWith(5, 1500))).toBeNull()
    expect(activeFlightModeSlot(0, channelsWith(5, 1500))).toBeNull() // FLTMODE_CH=0 is Disabled
    expect(activeFlightModeSlot(5, undefined)).toBeNull()
    expect(activeFlightModeSlot(19, channelsWith(5, 1500))).toBeNull() // beyond the 18-entry RC block
  })

  it('reads the 1-based FLTMODE_CH against the 0-based RC block', () => {
    // Only chan6 sits in the slot-4 band — a correct lookup must land there.
    const channels = channelsWith(6, 1700)
    expect(activeFlightModeSlot(6, channels)).toBe(4)
  })
})

describe('SIMPLE / SUPER_SIMPLE bitmask helpers', () => {
  it('slotBitEnabled reads bit N for slot index N (bit 0 = FLTMODE1)', () => {
    expect(slotBitEnabled(0b000101, 0)).toBe(true)
    expect(slotBitEnabled(0b000101, 1)).toBe(false)
    expect(slotBitEnabled(0b000101, 2)).toBe(true)
    expect(slotBitEnabled(0b100000, 5)).toBe(true)
    expect(slotBitEnabled(undefined, 0)).toBe(false)
  })

  it('withSlotBit sets and clears exactly one bit', () => {
    expect(withSlotBit(0, 2, true)).toBe(0b100)
    expect(withSlotBit(0b111, 1, false)).toBe(0b101)
    expect(withSlotBit(0b101, 0, true)).toBe(0b101) // idempotent
  })

  it('tolerates the REAL32 float values a board reports masks as', () => {
    expect(slotBitEnabled(5.0, 2)).toBe(true)
    expect(withSlotBit(5.0, 1, true)).toBe(7)
  })
})
