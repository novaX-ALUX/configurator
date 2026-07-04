/**
 * STM32 ROM-bootloader DFU (DfuSe) over WebUSB — the "DFU Recovery" engine.
 * Flashes a full bootloader+app image (parsed Intel HEX) to absolute
 * addresses. Rewrite of
 * `marketing/parts-catalog/src/scripts/update/dfu.ts`. Protocol: Set
 * Address (0x21), Erase (0x41), sequential DNLOAD blocks (wBlockNum >= 2),
 * GETSTATUS polling (waiting out dfuDNBUSY between commands), then Leave
 * DFU.
 *
 * Device VID/PID 0483:DF11 is the STM32 system bootloader (BOOT0 + reset);
 * the caller (task 3.4) is responsible for `navigator.usb.requestDevice()`
 * and handing the resulting `USBDevice` to this class's constructor — same
 * "caller owns the browser-permission gesture, this class only speaks the
 * wire protocol" split as `Px4Flasher`/`Transport`.
 *
 * Flash-layout resolution (needed for the chip guard below) prefers the
 * DfuSe alt-0 interface's `interfaceName` descriptor string, but that comes
 * back EMPTY on some bootloaders (verified on the STM32F405 ROM DFU —
 * Chrome surfaces `interfaceName` as `''` even though the descriptor exists
 * at string index 4), so `flashInfo()` falls back to reading raw USB STRING
 * descriptors directly via a control transfer (mirrors flash_dfu.py's
 * `get_string()`). If layout resolution still comes up empty after that
 * fallback, `flashInfo()` throws rather than guessing a chip's sector map:
 * this is a deliberate hardening over the reference (which guessed an F4
 * layout in that case) — for destructive-operation code, refusing to erase
 * an unidentified chip is the safer failure mode than silently assuming a
 * layout that might be wrong. In practice this throw should not trigger:
 * it is precisely the case the string-descriptor fallback exists to avoid.
 */
import type { ParsedHex } from './intelhex'

/** WebUSB device filter identity for the STM32 system bootloader — exported for task 3.4's `navigator.usb.requestDevice({ filters: [{ vendorId: STM32_DFU_VENDOR_ID, productId: STM32_DFU_PRODUCT_ID }] })`. */
export const STM32_DFU_VENDOR_ID = 0x0483
export const STM32_DFU_PRODUCT_ID = 0xdf11
const DNLOAD = 1
const GETSTATUS = 3
const CLRSTATUS = 4
const ABORT = 6
const DFU_STATE_DNBUSY = 4
const DFU_STATE_ERROR = 10

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type StmFamily = 'F4' | 'F7' | 'H7' | 'unknown'

export interface DfuSector {
  start: number
  size: number
}

export interface DfuFlashInfo {
  family: StmFamily
  flashKB: number
  sectors: DfuSector[]
}

/** `total` is always 1000 (a fixed permille scale spanning erase 0-300 + write 300-1000) — NOT raw bytes like `px4bl.ts`'s `Progress` (same name, different module, different units; each is independent, not a shared type). */
export type Progress = (done: number, total: number) => void

export class DfuError extends Error {}

/** True for USB-level transfer failures: WebUSB throws a DOMException "NetworkError: A transfer error has occurred", or a status/state response indicates one. Drives the adaptive chunk-size fallback in `flash()`. */
function isXferError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? ''
  const message = String((err as { message?: unknown })?.message ?? err ?? '')
  return name === 'NetworkError' || /transfer error|stall|babble|DNLOAD/i.test(message)
}

/** Real STM32 DfuSe layouts have at most a few dozen sectors — this bounds a malformed/spoofed descriptor string (the device is USB-authorized by the user, but its descriptor content isn't otherwise trusted) from driving an unbounded loop/allocation here. */
const MAX_SECTORS = 4096

/** Parses a DfuSe interface name, e.g. `"@Internal Flash /0x08000000/04*016Kg,01*064Kg,07*128Kg"`. Returns `[]` (unresolvable) rather than a partial layout if the descriptor implies more than `MAX_SECTORS`. */
function parseMemoryLayout(name: string): DfuSector[] {
  const match = name.match(/\/0x([0-9a-fA-F]+)\/(.+)$/)
  if (!match) return []
  let addr = parseInt(match[1], 16)
  const out: DfuSector[] = []
  for (const part of match[2].split(',')) {
    const sectorMatch = part.match(/(\d+)\*(\d+)([KMB])/)
    if (!sectorMatch) continue
    const count = parseInt(sectorMatch[1], 10)
    const unit = sectorMatch[3] === 'K' ? 1024 : sectorMatch[3] === 'M' ? 1024 * 1024 : 1
    const size = parseInt(sectorMatch[2], 10) * unit
    for (let i = 0; i < count; i++) {
      if (out.length >= MAX_SECTORS) return []
      out.push({ start: addr, size })
      addr += size
    }
  }
  return out
}

function classifyFamily(sectors: DfuSector[]): StmFamily {
  const sizes = sectors.map((s) => s.size)
  if (!sizes.length) return 'unknown'
  const K = 1024
  const min = Math.min(...sizes)
  const max = Math.max(...sizes)
  if (min === 16 * K) return 'F4'
  if (min === 32 * K || max === 256 * K) return 'F7'
  if (sizes.every((s) => s === 128 * K)) return 'H7'
  return 'unknown'
}

export class Stm32Dfu {
  private iface = 0
  private sectors: DfuSector[] | null = null
  private opening: Promise<void> | null = null

  constructor(private readonly dev: USBDevice) {}

  /**
   * Idempotent/memoized: opens the device, claims the DFU interface, and
   * resolves its flash layout, exactly once — triggered lazily by the
   * first `flashInfo()` call rather than an eager `open()`-style
   * constructor/factory step (contrast `SerialTransport`, which opens
   * eagerly per `open()` call). This mirrors `flashInfo()`'s own signature
   * being async (`Promise<DfuFlashInfo>`, unlike the reference
   * `STM32Dfu.flashInfo()`'s synchronous getter): the string-descriptor
   * fallback (see module doc) needs a `controlTransferIn` round trip, so
   * layout resolution is unavoidably async, and doing it lazily on first
   * use avoids requiring a separate async static factory before
   * construction just to open/claim/resolve up front.
   */
  private async ensureOpen(): Promise<void> {
    if (this.sectors) return
    if (!this.opening) this.opening = this.doOpen()
    await this.opening
  }

  private async doOpen(): Promise<void> {
    if (!this.dev.opened) await this.dev.open()
    if (this.dev.configuration === null) await this.dev.selectConfiguration(1)
    const cfg = this.dev.configuration
    if (!cfg) throw new DfuError('USB device has no active configuration')

    const ifc = cfg.interfaces.find((i) => i.alternates.some((a) => a.interfaceClass === 0xfe)) ?? cfg.interfaces[0]
    if (!ifc) throw new DfuError('USB device exposes no interfaces')
    this.iface = ifc.interfaceNumber
    await this.dev.claimInterface(this.iface)
    await this.dev.selectAlternateInterface(this.iface, 0)

    this.sectors = await this.resolveLayout(ifc)
    await this.clearIfError()
  }

  /** Reads a USB STRING descriptor by index via a raw control transfer (langid 0x0409 en-US) — see module doc for why this fallback is needed. */
  private async readString(index: number): Promise<string> {
    if (!index) return ''
    try {
      const r = await this.dev.controlTransferIn(
        { requestType: 'standard', recipient: 'device', request: 6 /* GET_DESCRIPTOR */, value: (0x03 << 8) | index, index: 0x0409 },
        255,
      )
      if (r.status !== 'ok' || !r.data || r.data.byteLength < 2) return ''
      const bytes = new Uint8Array(r.data.buffer)
      let s = ''
      for (let i = 2; i + 1 < bytes[0]; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
      return s
    } catch {
      return ''
    }
  }

  private async resolveLayout(ifc: USBInterface): Promise<DfuSector[]> {
    let layout = parseMemoryLayout(ifc.alternates[0]?.interfaceName ?? '')
    if (layout.length) return layout
    for (let idx = 1; idx <= 8; idx++) {
      const s = await this.readString(idx)
      if (/\/0x08000000\//.test(s)) {
        layout = parseMemoryLayout(s)
        if (layout.length) return layout
      }
    }
    return layout
  }

  /** Internal-flash geometry + classified family. Opens/claims the device and resolves its layout on first call (memoized after). Throws if the layout cannot be determined at all (see module doc) — never guesses a chip's sector map. */
  async flashInfo(): Promise<DfuFlashInfo> {
    await this.ensureOpen()
    const sectors = this.sectors ?? []
    if (!sectors.length) {
      throw new DfuError(
        'Could not determine the flash layout from this DFU device (no usable descriptor). Refusing to guess a chip layout before an erase — verify the board and retry.',
      )
    }
    const flashKB = Math.round(sectors.reduce((a, s) => a + s.size, 0) / 1024)
    return { family: classifyFamily(sectors), flashKB, sectors }
  }

  private async dnload(wValue: number, data?: BufferSource): Promise<void> {
    const r = await this.dev.controlTransferOut({ requestType: 'class', recipient: 'interface', request: DNLOAD, value: wValue, index: this.iface }, data)
    if (r.status !== 'ok') throw new DfuError(`DNLOAD failed: ${r.status}`)
  }

  private async getStatus(): Promise<{ status: number; poll: number; state: number }> {
    const r = await this.dev.controlTransferIn({ requestType: 'class', recipient: 'interface', request: GETSTATUS, value: 0, index: this.iface }, 6)
    const d = new Uint8Array(r.data!.buffer)
    return { status: d[0], poll: d[1] | (d[2] << 8) | (d[3] << 16), state: d[4] }
  }

  private async clearIfError(): Promise<void> {
    try {
      const st = await this.getStatus()
      if (st.state === DFU_STATE_ERROR) {
        await this.dev.controlTransferOut({ requestType: 'class', recipient: 'interface', request: CLRSTATUS, value: 0, index: this.iface })
      }
    } catch {
      // Best-effort.
    }
  }

  /** Polls GETSTATUS until the device leaves dfuDNBUSY (the operation truly completed); throws on a device-reported error. Sending the next transfer before this settles stalls with a "transfer error". */
  private async pollIdle(): Promise<void> {
    for (let i = 0; i < 5000; i++) {
      const st = await this.getStatus()
      if (st.status !== 0) throw new DfuError(`device status ${st.status} (state ${st.state})`)
      if (st.state !== DFU_STATE_DNBUSY) return
      await sleep(st.poll > 5 ? 5 : st.poll || 1)
    }
    throw new DfuError('status poll timeout')
  }

  /** Best-effort: clears a latched error (via `clearIfError()`) and ABORTs back to idle after a failed transfer. */
  private async recover(): Promise<void> {
    await this.clearIfError()
    try {
      await this.dev.controlTransferOut({ requestType: 'class', recipient: 'interface', request: ABORT, value: 0, index: this.iface })
    } catch {
      // Best-effort.
    }
    try {
      await this.getStatus()
    } catch {
      // Best-effort.
    }
  }

  /** DfuSe special command (Set Address 0x21 / Erase page 0x41). Also used directly for a plain address-pointer set (`dfuseCmd(0x21, addr)`) — there is no separate `setAddress()`. */
  private async dfuseCmd(cmd: number, addr?: number): Promise<void> {
    const payload = addr === undefined ? new Uint8Array([cmd]) : new Uint8Array([cmd, addr & 0xff, (addr >>> 8) & 0xff, (addr >>> 16) & 0xff, (addr >>> 24) & 0xff])
    await this.dnload(0, payload)
    await this.pollIdle()
  }

  /** Leave DFU: Set Address to the image base, zero-length DNLOAD, GETSTATUS (triggers manifestation — the device resets, which may surface as a thrown disconnect and is expected). */
  private async leave(baseAddr: number): Promise<void> {
    try {
      await this.dfuseCmd(0x21, baseAddr)
      await this.dnload(2, new Uint8Array(0))
      await this.getStatus()
    } catch {
      // Device reset/disconnect is expected here.
    }
  }

  /**
   * Chip guard (family + capacity vs the firmware being flashed) — MUST run
   * before the full-chip erase below, and does: `flashInfo()` itself throws
   * rather than proceed if the layout is unresolvable (see module doc), the
   * capacity check is unconditional (self-contained from `hex` + the
   * resolved layout), and the family check runs only when the caller
   * supplies `expectedFamily` — a `ParsedHex` carries no target-chip
   * metadata of its own (unlike `Px4Flasher.flash`'s `apj.boardId`), so a
   * caller with no family knowledge (e.g. a dropped file) still gets the
   * capacity check, matching the reference's own "unknown family -> capacity
   * only" fallback.
   *
   * Full-chip erase: every sector in the resolved layout, not just the ones
   * `hex` covers, so any leftover firmware/parameters above the new image
   * are removed — DFU Recovery always flashes a full bootloader+app image.
   * Programming uses an adaptive chunk size (starts at 1024 B, halves and
   * retries the same offset on a transfer error) since each block sets its
   * own address pointer, so the chunk size is free.
   */
  async flash(hex: ParsedHex, onProgress: Progress, expectedFamily?: StmFamily): Promise<void> {
    const info = await this.flashInfo()
    const base = info.sectors[0].start
    const totalSize = info.sectors.reduce((a, s) => a + s.size, 0)

    if (hex.minAddress < base || hex.maxAddress > base + totalSize) {
      throw new DfuError(
        `Chip mismatch — flash aborted, nothing erased. This firmware writes 0x${hex.minAddress.toString(16)}-0x${hex.maxAddress.toString(16)}, outside the connected chip's flash range 0x${base.toString(16)}-0x${(base + totalSize).toString(16)} (${info.flashKB} KB).`,
      )
    }
    if (expectedFamily && info.family !== 'unknown' && expectedFamily !== info.family) {
      throw new DfuError(
        `Chip mismatch — flash aborted, nothing erased. The selected firmware is for STM32${expectedFamily}-class, but the connected board is STM32${info.family}-class.`,
      )
    }

    for (let i = 0; i < info.sectors.length; i++) {
      await this.dfuseCmd(0x41, info.sectors[i].start)
      onProgress(Math.round(((i + 1) / info.sectors.length) * 300), 1000) // erase = first 0-30%
    }

    let cap = 1024
    let written = 0
    for (const seg of hex.segments) {
      let off = 0
      while (off < seg.data.length) {
        const size = Math.min(cap, seg.data.length - off)
        const addr = seg.addr + off
        const chunk = new Uint8Array(seg.data.subarray(off, off + size))
        try {
          await this.dfuseCmd(0x21, addr)
          await this.dnload(2, chunk)
          await this.pollIdle()
          off += size
          written += size
          onProgress(300 + Math.round((written / hex.totalBytes) * 700), 1000) // write = 30-100%
        } catch (err) {
          if (isXferError(err) && cap > 64) {
            cap = cap >> 1
            await this.recover()
            continue // retry the same offset with the smaller cap
          }
          throw err
        }
      }
    }

    await this.leave(hex.minAddress)
  }

  async close(): Promise<void> {
    try {
      await this.dev.close()
    } catch {
      // Best-effort — the device may already be gone.
    }
  }
}
