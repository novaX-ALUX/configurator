import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../transport/mock'
import { defs } from '../../mavlink/defs'
import { decodePayload } from '../../mavlink/decode'
import { FrameParser } from '../../mavlink/frame'
import type { ParsedApj } from '../apj'
import { Px4Flasher, crc32, sendEnterRomDfu, sendRebootToBootloader } from '../px4bl'

const INSYNC = 0x12
const OK = 0x10
const INVALID = 0x13
const GET_SYNC = 0x21
const GET_DEVICE = 0x22
const CHIP_ERASE = 0x23
const PROG_MULTI = 0x27
const GET_CRC = 0x29
const REBOOT = 0x30
const INFO_BL_REV = 1
const INFO_BOARD_ID = 2
const INFO_FLASH_SIZE = 4

function le32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
}

function concat(...arrays: number[][]): Uint8Array {
  return new Uint8Array(arrays.flat())
}

/**
 * Scripted bootloader: overrides `MockTransport`'s protected `doWrite` (each
 * `Px4Flasher` command write synchronously gets a scripted reply fed back
 * before `write()` resolves) so a full multi-round-trip bootloader
 * conversation can be driven without manual step-by-step orchestration.
 */
class ScriptedBootloader extends MockTransport {
  boardId = 6203
  flashSize = 1024 // small, 4-byte-aligned, keeps test fixtures tiny
  blRevQueried = false
  /** If true, CHIP_ERASE returns INVALID until INFO_BL_REV has been queried at least once — replicates the hardware quirk this module's identify()-before-erase ordering exists to avoid. */
  rejectEraseUntilBlRev = false
  /** If >0, the next N CHIP_ERASE attempts return INVALID unconditionally (a generic transient-failure simulation, distinct from the BL_REV quirk) — used to test the erase retry-once path. */
  rejectEraseTimes = 0
  eraseCount = 0
  flashBuf = new Uint8Array(0)
  writeOffset = 0
  /** If true, GET_CRC answers with a CRC that never matches (simulates a programming mismatch). */
  corruptCrc = false

  protected async doWrite(data: Uint8Array): Promise<void> {
    await super.doWrite(data)
    const resp = this.respond(data)
    if (resp) this.feed(resp)
  }

  private respond(cmd: Uint8Array): Uint8Array | null {
    const op = cmd[0]
    if (op === GET_SYNC) return concat([INSYNC, OK])
    if (op === GET_DEVICE) {
      const param = cmd[1]
      let value = 0
      if (param === INFO_BOARD_ID) value = this.boardId
      else if (param === INFO_FLASH_SIZE) value = this.flashSize
      else if (param === INFO_BL_REV) {
        this.blRevQueried = true
        value = 5
      }
      return concat(le32(value), [INSYNC, OK])
    }
    if (op === CHIP_ERASE) {
      this.eraseCount++
      if (this.rejectEraseUntilBlRev && !this.blRevQueried) return concat([INSYNC, INVALID])
      if (this.rejectEraseTimes > 0) {
        this.rejectEraseTimes--
        return concat([INSYNC, INVALID])
      }
      this.flashBuf = new Uint8Array(this.flashSize).fill(0xff)
      this.writeOffset = 0
      return concat([INSYNC, OK])
    }
    if (op === PROG_MULTI) {
      const len = cmd[1]
      const data = cmd.subarray(2, 2 + len)
      this.flashBuf.set(data, this.writeOffset)
      this.writeOffset += len
      return concat([INSYNC, OK])
    }
    if (op === GET_CRC) {
      const crc = this.corruptCrc ? (crc32(this.flashBuf) ^ 0xffffffff) >>> 0 : crc32(this.flashBuf)
      return concat(le32(crc), [INSYNC, OK])
    }
    if (op === REBOOT) return null // no reply expected/consumed
    return concat([INSYNC, 0x11 /* FAILED */])
  }
}

function makeApj(overrides: Partial<ParsedApj> = {}): ParsedApj {
  const image = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  return { boardId: 6203, image, imageSize: image.length, ...overrides }
}

describe('Px4Flasher.identify', () => {
  let transport: ScriptedBootloader

  beforeEach(async () => {
    transport = new ScriptedBootloader()
    await transport.open()
  })

  it('queries board ID, flash size, and BL rev (in that order), before anything else', async () => {
    const flasher = new Px4Flasher(transport)
    const info = await flasher.identify()

    expect(info).toEqual({ boardId: 6203, flashSize: 1024, blRev: 5 })
    expect(flasher.state).toBe('identified')

    // GET_DEVICE params, in the order they were sent — board_id(2), flash_size(4), bl_rev(1).
    const getDeviceParams = transport.sent.filter((b) => b[0] === GET_DEVICE).map((b) => b[1])
    expect(getDeviceParams).toEqual([INFO_BOARD_ID, INFO_FLASH_SIZE, INFO_BL_REV])
  })
})

describe('Px4Flasher erase hard gate (INFO_BL_REV before CHIP_ERASE)', () => {
  it('never sends CHIP_ERASE before INFO_BL_REV has been queried — flash() succeeds against a bootloader that rejects premature erase', async () => {
    const transport = new ScriptedBootloader()
    transport.rejectEraseUntilBlRev = true
    await transport.open()

    const flasher = new Px4Flasher(transport)
    const progress = vi.fn()
    await flasher.flash(makeApj(), progress)

    expect(flasher.state).toBe('done')

    const blRevIndex = transport.sent.findIndex((b) => b[0] === GET_DEVICE && b[1] === INFO_BL_REV)
    const eraseIndex = transport.sent.findIndex((b) => b[0] === CHIP_ERASE)
    expect(blRevIndex).toBeGreaterThanOrEqual(0)
    expect(eraseIndex).toBeGreaterThan(blRevIndex)
  })

  it('retries erase once (re-running identify) after a transient INVALID unrelated to BL_REV', async () => {
    const transport = new ScriptedBootloader()
    transport.rejectEraseTimes = 1 // first CHIP_ERASE attempt fails regardless of BL_REV state
    await transport.open()

    const flasher = new Px4Flasher(transport)
    await flasher.flash(makeApj(), vi.fn())

    expect(flasher.state).toBe('done')
    expect(transport.eraseCount).toBe(2) // first rejected, second (after re-identify) succeeded
  })
})

describe('Px4Flasher.flash guards (must run before erase)', () => {
  let transport: ScriptedBootloader

  beforeEach(async () => {
    transport = new ScriptedBootloader()
    await transport.open()
  })

  it('rejects a board-ID mismatch — flash aborted, CHIP_ERASE never sent', async () => {
    const flasher = new Px4Flasher(transport)
    const apj = makeApj({ boardId: 9999 })

    await expect(flasher.flash(apj, vi.fn())).rejects.toThrow(/wrong firmware/i)

    expect(flasher.state).toBe('failed')
    expect(transport.sent.some((b) => b[0] === CHIP_ERASE)).toBe(false)
    // Bootloader is left rebooting back to the still-intact app.
    expect(transport.sent.some((b) => b[0] === REBOOT)).toBe(true)
  })

  it('rejects an oversized image — flash aborted, CHIP_ERASE never sent', async () => {
    transport.flashSize = 8
    const flasher = new Px4Flasher(transport)
    const apj = makeApj({ image: new Uint8Array(9), imageSize: 9 })

    await expect(flasher.flash(apj, vi.fn())).rejects.toThrow(/too large/i)

    expect(flasher.state).toBe('failed')
    expect(transport.sent.some((b) => b[0] === CHIP_ERASE)).toBe(false)
  })

  it('rejects a bootloader reporting 0 bytes of flash — capacity cannot be verified, so it fails closed instead of skipping the check', async () => {
    transport.flashSize = 0
    const flasher = new Px4Flasher(transport)

    await expect(flasher.flash(makeApj(), vi.fn())).rejects.toThrow(/flash capacity unknown/i)

    expect(flasher.state).toBe('failed')
    expect(transport.sent.some((b) => b[0] === CHIP_ERASE)).toBe(false)
  })
})

describe('Px4Flasher.flash happy path', () => {
  it('erases, programs (4-byte padded), verifies by CRC, and reboots', async () => {
    const transport = new ScriptedBootloader()
    await transport.open()
    const flasher = new Px4Flasher(transport)
    const progress = vi.fn()
    const image = new Uint8Array([10, 20, 30, 40, 50]) // 5 bytes -> padded to 8

    await flasher.flash(makeApj({ image, imageSize: image.length }), progress)

    expect(flasher.state).toBe('done')
    expect(transport.writeOffset).toBe(8) // padded length actually programmed
    expect(Array.from(transport.flashBuf.subarray(0, 8))).toEqual([10, 20, 30, 40, 50, 0xff, 0xff, 0xff])
    expect(transport.sent.some((b) => b[0] === REBOOT)).toBe(true)
    // Progress reaches the full padded length.
    const lastCall = progress.mock.calls[progress.mock.calls.length - 1]
    expect(lastCall).toEqual([8, 8])
  })

  it('throws when the device CRC does not match what was programmed', async () => {
    const transport = new ScriptedBootloader()
    transport.corruptCrc = true
    await transport.open()
    const flasher = new Px4Flasher(transport)

    await expect(flasher.flash(makeApj(), vi.fn())).rejects.toThrow(/crc verify failed/i)
    expect(flasher.state).toBe('failed')
  })
})

describe('Px4Flasher.identify — no bootloader response', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up after the wait budget and throws a clear error', async () => {
    const transport = new MockTransport() // never answers GET_SYNC
    await transport.open()
    const flasher = new Px4Flasher(transport)

    const result = flasher.identify()
    const assertion = expect(result).rejects.toThrow(/no bootloader response/i)
    await vi.advanceTimersByTimeAsync(9000)
    await assertion
  })
})

describe('sendRebootToBootloader / sendEnterRomDfu', () => {
  function decodeSentCommandLong(bytes: Uint8Array): Record<string, unknown> {
    const parser = new FrameParser(defs)
    const [frame] = parser.push(bytes)
    expect(frame.msgid).toBe(76) // COMMAND_LONG
    return decodePayload(defs, frame).fields
  }

  it('sends the reboot-to-bootloader COMMAND_LONG (param1=3) then closes the transport', async () => {
    const transport = new MockTransport()
    await transport.open()
    const writeSpy = vi.spyOn(transport, 'write')
    const closeSpy = vi.spyOn(transport, 'close')

    await sendRebootToBootloader(transport)

    expect(transport.sent).toHaveLength(1)
    const fields = decodeSentCommandLong(transport.sent[0])
    expect(fields).toMatchObject({
      target_system: 1,
      target_component: 0,
      command: 246, // MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN
      param1: 3,
    })
    // Written before the transport was closed.
    expect(writeSpy.mock.invocationCallOrder[0]).toBeLessThan(closeSpy.mock.invocationCallOrder[0])
    // Transport is now closed — a further write rejects.
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow()
  })

  it('sends the enter-ROM-DFU magic (param1..4 = 42/24/71/99) then closes the transport', async () => {
    const transport = new MockTransport()
    await transport.open()

    await sendEnterRomDfu(transport)

    const fields = decodeSentCommandLong(transport.sent[0])
    expect(fields).toMatchObject({
      command: 246,
      param1: 42,
      param2: 24,
      param3: 71,
      param4: 99,
    })
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow()
  })
})
