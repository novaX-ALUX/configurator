/**
 * ArduPilot/PX4 serial bootloader protocol (sync/erase/prog/crc/reboot) over
 * a `Transport` (task 2.1) — the "Firmware Update" engine. Rewrite of
 * `marketing/parts-catalog/src/scripts/update/serial-px4.ts`, verified on
 * real hardware against the CLI twin (`serial_update.py`).
 *
 * Scope boundary: `Px4Flasher` speaks ONLY the bootloader's raw byte
 * protocol, over a `transport` that is assumed to already be connected to a
 * device running that bootloader (freshly power-cycled with the bootloader
 * button held, or already reconnected post-reboot). It does not perform the
 * OS-level "close this SerialPort, wait for the device to re-enumerate, open
 * whichever new SerialPort answers" dance — that is Web Serial API surface
 * (`navigator.serial`), not expressible through the transport-agnostic
 * `Transport` interface this module is tested against (`MockTransport`
 * cannot simulate "a new port object appears"), and per `router.ts`'s own
 * documented transport-handoff pattern, reconnection across a physical
 * reset is the caller's responsibility (task 3.4's page), which owns
 * `navigator.serial` and constructs the fresh `Transport` + `Px4Flasher`
 * pair once the bootloader answers again.
 *
 * What this module DOES provide for the "reboot into the bootloader" step:
 * `sendRebootToBootloader()`/`sendEnterRomDfu()`, standalone functions that
 * write the (semantically) same MAVLink COMMAND_LONG the reference sent —
 * re-encoded through this project's own MAVLink2 frame/encode layer rather
 * than replaying the reference's raw MAVLink1 byte constants (see their
 * doc comments for the full justification) — and then close the transport
 * immediately, before the device actually resets, per the reference's
 * proven fix for an intermittent Windows re-enumeration failure.
 *
 * ⚠ CRITICAL ORDER (verified on hardware, see the reference's top-of-file
 * comment): a freshly-entered bootloader REJECTS CHIP_ERASE with INVALID
 * (0x13) until the device-info handshake — specifically GET_DEVICE
 * INFO_BL_REV — has completed. `identify()` always queries INFO_BL_REV
 * (last, matching the reference's own query order), and `flash()` always
 * calls `identify()` itself before ever attempting an erase — there is no
 * public erase entry point that could bypass this.
 */
import type { Transport } from '../transport/types'
import { defs } from '../mavlink/defs'
import { encodePayload } from '../mavlink/encode'
import { encodeFrame } from '../mavlink/frame'
import type { ParsedApj } from './apj'

const INSYNC = 0x12
const EOC = 0x20
const OK = 0x10
const FAILED = 0x11
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
const PROG_MULTI_MAX = 252

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** PX4 bootloader's own CRC-32 (poly 0xedb88320, init 0, no final XOR) — NOT the MAVLink X.25 CRC in `crc.ts`, and not zlib's CRC32 (which XORs 0xFFFFFFFF in/out). Verified against the device on real hardware. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** Exported for the test suite, which needs to compute the same device-side CRC over a scripted bootloader's accumulated flash image. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return crc >>> 0
}

export class Px4FlashError extends Error {}

/** Internal: the bootloader answered INSYNC + INVALID specifically — distinguished from other failures so `erase()` can apply its one-shot re-handshake-and-retry (see module doc's CRITICAL ORDER note). */
class Px4InvalidError extends Px4FlashError {}

/**
 * Thrown by `erase()` if it is somehow reached before `identify()` has
 * queried INFO_BL_REV — a programming-error/assertion-failure, not a device
 * response, so it deliberately does NOT extend `Px4FlashError` (a caller
 * that catches `Px4FlashError` to handle expected device-communication
 * failures should not accidentally swallow this). This turns the module
 * doc's CRITICAL ORDER requirement into a runtime invariant checked at the
 * one call site that matters, instead of relying on `flash()`'s current
 * call order never regressing under a future refactor.
 */
export class Px4InvariantError extends Error {}

/** Buffers bytes off `transport.readable` in the background so `read(n, timeoutMs)` can wait for enough of them (or time out) without busy-polling. Internal to this module — a byte-protocol concern, not part of the `Transport` contract. */
class ByteReader {
  private readonly buf: number[] = []
  private readonly waiters = new Set<{ n: number; wake: () => void }>()
  private closed = false
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>

  constructor(transport: Transport) {
    this.reader = transport.readable.getReader()
    void this.pump()
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader.read()
        if (done) break
        if (value && value.length) {
          for (let i = 0; i < value.length; i++) this.buf.push(value[i])
          this.wake()
        }
      }
    } catch {
      // Read error — treated the same as a graceful end (see wake()/closed below).
    }
    this.closed = true
    this.wake()
  }

  private wake(): void {
    for (const waiter of this.waiters) {
      if (this.buf.length >= waiter.n || this.closed) waiter.wake()
    }
  }

  /** Discards any buffered bytes — mirrors pyserial's `reset_input_buffer()` before a sync attempt, so a stray/duplicate response can never desync the next command. */
  drain(): void {
    this.buf.length = 0
  }

  async read(n: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.buf.length < n && !this.closed) {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          n,
          wake: () => {
            clearTimeout(timer)
            this.waiters.delete(waiter)
            resolve()
          },
        }
        const timer = setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Px4FlashError('Serial response timeout'))
        }, timeoutMs)
        this.waiters.add(waiter)
      })
    }
    if (this.buf.length < n) throw new Px4FlashError('Serial port closed')
    return new Uint8Array(this.buf.splice(0, n))
  }

  release(): void {
    try {
      this.reader.cancel()
    } catch {
      // Best-effort.
    }
    try {
      this.reader.releaseLock()
    } catch {
      // Best-effort.
    }
  }
}

export type Px4FlasherState =
  | 'idle'
  | 'identified'
  | 'verified'
  | 'erasing'
  | 'programming'
  | 'verifying'
  | 'done'
  | 'failed'

export interface Px4Identify {
  boardId: number
  flashSize: number
  blRev: number
}

/** `done`/`total` are raw bytes of the (4-byte-padded) image programmed so far — NOT a 0-1000 permille scale like `dfu.ts`'s `Progress` (same name, different module, different units; each is independent, not a shared type). */
export type Progress = (done: number, total: number) => void

export class Px4Flasher {
  private readonly io: ByteReader
  private state_: Px4FlasherState = 'idle'
  private boardId = 0
  private flashSize = 0
  private blRev = 0
  /** Set by `identify()` once INFO_BL_REV has actually been queried — `erase()` asserts this is true (see `Px4InvariantError`). Intentionally never reset back to `false`: once queried for this bootloader session it stays queried (sticky-true matches the bootloader-session semantics — a fresh `Px4Flasher` is constructed per transport generation, so there is no "re-entered a fresh bootloader" case for this same instance to track). */
  private blRevQueried = false

  constructor(private readonly transport: Transport) {
    this.io = new ByteReader(transport)
  }

  get state(): Px4FlasherState {
    return this.state_
  }

  private async getSync(timeoutMs = 1000): Promise<void> {
    const r = await this.io.read(2, timeoutMs)
    if (r[0] !== INSYNC) {
      throw new Px4FlashError(`bootloader sync lost (expected INSYNC, got 0x${r[0].toString(16)})`)
    }
    if (r[1] === OK) return
    if (r[1] === INVALID) throw new Px4InvalidError('bootloader returned INVALID')
    if (r[1] === FAILED) throw new Px4FlashError('bootloader returned FAILED')
    throw new Px4FlashError(`unexpected bootloader status byte 0x${r[1].toString(16)}`)
  }

  private async cmd(bytes: number[], timeoutMs = 1000): Promise<void> {
    await this.transport.write(new Uint8Array(bytes))
    await this.getSync(timeoutMs)
  }

  private async trySync(timeoutMs: number): Promise<boolean> {
    this.io.drain()
    try {
      await this.cmd([GET_SYNC, EOC], timeoutMs)
      return true
    } catch {
      return false
    }
  }

  /** Polls GET_SYNC until the bootloader answers (the board may still be powering up / the user may need to power-cycle it), up to `totalMs`. */
  private async waitForSync(totalMs = 8000): Promise<void> {
    const deadline = Date.now() + totalMs
    for (;;) {
      if (await this.trySync(400)) return
      if (Date.now() > deadline) {
        throw new Px4FlashError('No bootloader response — power-cycle the board and retry.')
      }
      await sleep(200)
    }
  }

  private async getInfo(param: number): Promise<number> {
    await this.transport.write(new Uint8Array([GET_DEVICE, param, EOC]))
    const v = await this.io.read(4, 1000)
    await this.getSync()
    return (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0
  }

  /**
   * Waits for the bootloader to answer, then queries board ID, flash size,
   * and (last, matching the reference's verified order) INFO_BL_REV. This
   * order is preserved exactly as proven on hardware — see the module doc's
   * CRITICAL ORDER note.
   */
  async identify(): Promise<Px4Identify> {
    await this.waitForSync()
    this.boardId = await this.getInfo(INFO_BOARD_ID)
    this.flashSize = await this.getInfo(INFO_FLASH_SIZE)
    this.blRev = await this.getInfo(INFO_BL_REV)
    this.blRevQueried = true
    this.state_ = 'identified'
    return { boardId: this.boardId, flashSize: this.flashSize, blRev: this.blRev }
  }

  /** Not exported: the only way to reach this is through `flash()`, after its guards pass. */
  private async erase(): Promise<void> {
    if (!this.blRevQueried) {
      // Not a retry path: this is a bug in this class (identify() bypassed or reordered
      // relative to erase()), not a device response — see Px4InvariantError's doc.
      throw new Px4InvariantError(
        'Px4Flasher internal invariant violated: erase() reached before INFO_BL_REV was queried. A fresh bootloader rejects CHIP_ERASE with INVALID until this handshake completes (verified on hardware, see module doc CRITICAL ORDER) — identify() must run first.',
      )
    }
    try {
      await this.cmd([CHIP_ERASE, EOC], 20000)
    } catch (err) {
      if (!(err instanceof Px4InvalidError)) throw err
      // Defense-in-depth: if the bootloader still rejects erase as INVALID, redo the
      // device-info handshake (re-queries INFO_BL_REV) and retry once.
      await this.identify()
      await this.cmd([CHIP_ERASE, EOC], 20000)
    }
  }

  private async program(image: Uint8Array, onProgress: Progress): Promise<Uint8Array> {
    const padLen = image.length % 4 === 0 ? image.length : image.length + (4 - (image.length % 4))
    const padded = new Uint8Array(padLen)
    padded.set(image)
    padded.fill(0xff, image.length)

    for (let off = 0; off < padded.length; off += PROG_MULTI_MAX) {
      const chunk = padded.subarray(off, Math.min(off + PROG_MULTI_MAX, padded.length))
      await this.cmd([PROG_MULTI, chunk.length, ...chunk, EOC], 2000)
      onProgress(off + chunk.length, padded.length)
    }
    return padded
  }

  private async verify(programmed: Uint8Array): Promise<boolean> {
    const full = new Uint8Array(this.flashSize).fill(0xff)
    full.set(programmed.subarray(0, Math.min(programmed.length, this.flashSize)))
    const local = crc32(full)

    await this.transport.write(new Uint8Array([GET_CRC, EOC]))
    const v = await this.io.read(4, 5000)
    await this.getSync()
    const device = (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0
    return device === local
  }

  private async rebootToApp(): Promise<void> {
    try {
      await this.transport.write(new Uint8Array([REBOOT, EOC]))
    } catch {
      // The device may drop the port the instant it reboots — best-effort.
    }
  }

  /**
   * identify -> GUARD (board ID + capacity) -> erase -> program -> verify ->
   * reboot. Always re-runs `identify()` itself (even if the caller already
   * called it separately) so the erase gate can never be bypassed by a
   * stale/cached result. Guards run BEFORE erase: a wrong/oversized image is
   * rejected with nothing erased, and the bootloader is left (rebooting
   * back into the still-intact app) rather than stuck.
   */
  async flash(apj: ParsedApj, onProgress: Progress): Promise<void> {
    if (apj.image.length === 0) {
      // Checked before ever talking to the device: a blank image erasing a chip and then
      // "verifying" an all-0xFF blank against itself is exactly the class of accident this
      // module exists to prevent — no identify()/erase() attempt is worth starting for it.
      this.state_ = 'failed'
      throw new Px4FlashError('Empty image — flash aborted, nothing erased. The firmware image has 0 bytes.')
    }
    const info = await this.identify()

    if (apj.boardId !== info.boardId) {
      await this.rebootToApp()
      this.state_ = 'failed'
      throw new Px4FlashError(
        `Wrong firmware — flash aborted, nothing erased. This firmware is for board ID ${apj.boardId}, but the connected board is ID ${info.boardId}.`,
      )
    }
    if (info.flashSize === 0) {
      // Fail closed rather than silently skip the capacity check: a real PX4 bootloader
      // never reports 0 bytes of flash, so this means either a malfunctioning device or one
      // that isn't actually a PX4 bootloader — either way, capacity cannot be verified, and
      // "image fits flashSize" (the hard gate) cannot be satisfied by an unknown capacity.
      await this.rebootToApp()
      this.state_ = 'failed'
      throw new Px4FlashError(
        'Flash capacity unknown — flash aborted, nothing erased. The bootloader reported 0 bytes of flash (INFO_FLASH_SIZE), so the image-fits-flash guard cannot be verified.',
      )
    }
    if (apj.image.length > info.flashSize) {
      await this.rebootToApp()
      this.state_ = 'failed'
      throw new Px4FlashError(
        `Image too large — flash aborted, nothing erased. Firmware is ${apj.image.length} bytes but this chip has only ${info.flashSize} bytes of flash.`,
      )
    }
    this.state_ = 'verified'

    this.state_ = 'erasing'
    try {
      await this.erase()
    } catch (err) {
      this.state_ = 'failed'
      throw err
    }

    this.state_ = 'programming'
    let programmed: Uint8Array
    try {
      programmed = await this.program(apj.image, onProgress)
    } catch (err) {
      this.state_ = 'failed'
      throw err
    }

    this.state_ = 'verifying'
    let ok: boolean
    try {
      ok = await this.verify(programmed)
    } catch (err) {
      this.state_ = 'failed'
      throw err
    }
    if (!ok) {
      this.state_ = 'failed'
      throw new Px4FlashError('CRC verify failed — flash mismatch')
    }

    await this.rebootToApp()
    this.state_ = 'done'
  }
}

// ---- Reboot-to-bootloader (sent while the device is still running its app, over MAVLink) ----

const COMMAND_LONG_MSGID = 76
const MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN = 246
/** Source identity for this one-shot fire-and-forget frame — a GCS-class sender, distinct from `MavRouter`'s own default (255/190): there is no router/session here to share sysid/compid conventions with. */
const SENDER_SYSID = 255
const SENDER_COMPID = 0
const TARGET_SYSID = 1
const TARGET_COMPID = 0

function encodeCommandLongFrame(cmd: { command: number; param1?: number; param2?: number; param3?: number; param4?: number }): Uint8Array {
  const payload = encodePayload(defs, COMMAND_LONG_MSGID, {
    target_system: TARGET_SYSID,
    target_component: TARGET_COMPID,
    command: cmd.command,
    confirmation: 0,
    param1: cmd.param1 ?? 0,
    param2: cmd.param2 ?? 0,
    param3: cmd.param3 ?? 0,
    param4: cmd.param4 ?? 0,
    param5: 0,
    param6: 0,
    param7: 0,
  })
  return encodeFrame(defs, { msgid: COMMAND_LONG_MSGID, payload }, 0, SENDER_SYSID, SENDER_COMPID)
}

/**
 * Reboots a running ArduPilot app straight into its PX4 bootloader:
 * MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN(246), param1=3 (reference:
 * `serial-px4.ts`'s `REBOOT_BL_MAVLINK`, verified on hardware).
 *
 * Re-encoded through this project's own MAVLink2 frame/encode/CRC layer
 * rather than replaying the reference's raw MAVLink1 byte constant:
 * ArduPilot's parser accepts either wire version for COMMAND_LONG, so the
 * semantic content (target/command/params) is what "verified on hardware"
 * actually needs to preserve — re-encoding avoids a second, hand-rolled X.25
 * checksum implementation living outside `crc.ts`. This is deliberately
 * fire-and-forget: `sendCommand()`'s ack-correlation/retry machinery (with
 * its forced `retries=0` for this DANGEROUS command) would only buy a
 * guaranteed-timeout wait, since the device is about to drop off the bus
 * before any COMMAND_ACK could arrive.
 *
 * Per the reference's proven re-enumeration fix, `transport` is closed
 * IMMEDIATELY after the write — before the board actually resets a few
 * hundred ms later. Keeping the host port open across the reset is what
 * caused an intermittent "device descriptor request failed" re-enumeration
 * failure on Windows; closing first avoids it. The caller is responsible
 * for reopening a fresh `Transport` once the bootloader re-enumerates and
 * constructing a new `Px4Flasher` around it (see module doc).
 */
export async function sendRebootToBootloader(transport: Transport): Promise<void> {
  const frame = encodeCommandLongFrame({ command: MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, param1: 3 })
  try {
    await transport.write(frame)
  } catch {
    // The device may drop the port the instant it reboots — best-effort.
  }
  await transport.close()
}

/**
 * Sends ArduPilot's "boot to DFU" magic — MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN
 * with param1..4 = 42/24/71/99 (reference: `ENTER_DFU_MAVLINK`) —
 * triggering `hal.util->boot_to_dfu()`: the running app drops USB and
 * resets, and its (ENABLE_DFU_BOOT) bootloader jumps to the ST ROM DFU
 * (0483:DF11) instead of the PX4 bootloader. F4-only: the bootloader must
 * have ENABLE_DFU_BOOT, and on H7 this magic leaves USB dark without
 * entering DFU (a silicon/bootloader limitation, not fixable from here).
 * Same close-before-reset discipline as `sendRebootToBootloader`.
 */
export async function sendEnterRomDfu(transport: Transport): Promise<void> {
  const frame = encodeCommandLongFrame({
    command: MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
    param1: 42,
    param2: 24,
    param3: 71,
    param4: 99,
  })
  try {
    await transport.write(frame)
  } catch {
    // The device may drop the port the instant it reboots — best-effort.
  }
  await transport.close()
}
