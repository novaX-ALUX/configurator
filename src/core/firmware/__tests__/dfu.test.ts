import { describe, expect, it, vi } from 'vitest'
import type { ParsedHex } from '../intelhex'
import { Stm32Dfu } from '../dfu'

const DNLOAD = 1
const GETSTATUS = 3
const CLRSTATUS = 4
const ABORT = 6
const GET_DESCRIPTOR = 6
const DFU_STATE_DNBUSY = 4
const DFU_STATE_IDLE = 5
const DFU_STATE_ERROR = 10

const F4_LAYOUT_NAME = '@Internal Flash /0x08000000/04*016Kg,01*064Kg,07*128Kg'
// 4*16K + 1*64K + 7*128K = 1024 KB, base 0x08000000 -> end 0x08100000.
const F4_TOTAL_BYTES = 4 * 16 * 1024 + 64 * 1024 + 7 * 128 * 1024
const F4_END = 0x08000000 + F4_TOTAL_BYTES

function readLE32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function buildStringDescriptor(s: string): Uint8Array {
  const body = new Uint8Array(s.length * 2)
  for (let i = 0; i < s.length; i++) {
    body[i * 2] = s.charCodeAt(i) & 0xff
    body[i * 2 + 1] = (s.charCodeAt(i) >> 8) & 0xff
  }
  const out = new Uint8Array(2 + body.length)
  out[0] = out.length
  out[1] = 0x03 // STRING descriptor type
  out.set(body, 2)
  return out
}

/** Minimal fake `USBDevice`: scripts controlTransferIn/Out to speak just enough DfuSe for `Stm32Dfu` to drive. */
class FakeStm32Device implements Partial<USBDevice> {
  opened = false
  configuration: USBConfiguration | null = null
  configurations: USBConfiguration[]
  vendorId = 0x0483
  productId = 0xdf11

  currentAddress = 0
  eraseCalls: number[] = []
  writes: { addr: number; data: Uint8Array }[] = []
  recoverCalls = 0
  private busy = false
  private errorState = false
  /** Fails the NEXT actual-data DNLOAD (wValue=2, non-empty) with a WebUSB transfer error, then succeeds. */
  xferErrorOnce = false
  stringDescriptors: Record<number, string> = {}

  constructor(alt0InterfaceName: string) {
    this.configurations = [
      {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            alternates: [
              { alternateSetting: 0, interfaceClass: 0xfe, interfaceSubclass: 1, interfaceProtocol: 2, interfaceName: alt0InterfaceName },
            ],
          },
        ],
      },
    ]
  }

  async open(): Promise<void> {
    this.opened = true
  }
  async close(): Promise<void> {
    this.opened = false
  }
  async selectConfiguration(v: number): Promise<void> {
    this.configuration = this.configurations.find((c) => c.configurationValue === v) ?? this.configurations[0]
  }
  async claimInterface(): Promise<void> {}
  async selectAlternateInterface(): Promise<void> {}
  async reset(): Promise<void> {}

  async controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult> {
    const bytes = data ? new Uint8Array(data as ArrayBuffer) : new Uint8Array(0)
    if (setup.request === DNLOAD) {
      if (setup.value === 0) {
        const cmd = bytes[0]
        if (cmd === 0x21) this.currentAddress = readLE32(bytes, 1)
        else if (cmd === 0x41) this.eraseCalls.push(readLE32(bytes, 1))
        this.busy = true
        return { status: 'ok', bytesWritten: bytes.length }
      }
      if (setup.value === 2) {
        if (bytes.length === 0) {
          // Leave-DFU trigger.
          this.busy = false
          return { status: 'ok', bytesWritten: 0 }
        }
        if (this.xferErrorOnce) {
          this.xferErrorOnce = false
          const err = new Error('A transfer error has occurred.')
          err.name = 'NetworkError'
          throw err
        }
        this.writes.push({ addr: this.currentAddress, data: bytes.slice() })
        this.busy = true
        return { status: 'ok', bytesWritten: bytes.length }
      }
    }
    if (setup.request === CLRSTATUS) {
      this.errorState = false
      return { status: 'ok', bytesWritten: 0 }
    }
    if (setup.request === ABORT) {
      this.recoverCalls++
      this.busy = false
      return { status: 'ok', bytesWritten: 0 }
    }
    return { status: 'ok', bytesWritten: 0 }
  }

  async controlTransferIn(setup: USBControlTransferParameters): Promise<USBInTransferResult> {
    if (setup.request === GETSTATUS) {
      const state = this.errorState ? DFU_STATE_ERROR : this.busy ? DFU_STATE_DNBUSY : DFU_STATE_IDLE
      this.busy = false // one-shot busy: the NEXT getStatus() call (this pollIdle loop's next iteration) reports idle
      const buf = new Uint8Array([this.errorState ? 1 : 0, 0, 0, 0, state])
      return { status: 'ok', data: new DataView(buf.buffer) }
    }
    if (setup.request === GET_DESCRIPTOR && (setup.value >> 8) === 0x03) {
      const index = setup.value & 0xff
      const s = this.stringDescriptors[index]
      if (!s) return { status: 'stall' }
      const descriptor = buildStringDescriptor(s)
      return { status: 'ok', data: new DataView(descriptor.buffer) }
    }
    return { status: 'stall' }
  }
}

function makeF4Device(): FakeStm32Device {
  return new FakeStm32Device(F4_LAYOUT_NAME)
}

function makeHex(overrides: Partial<ParsedHex> = {}): ParsedHex {
  const segments = [
    { addr: 0x08000000, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
    { addr: 0x08010000, data: new Uint8Array([9, 9, 9, 9]) },
  ]
  return {
    segments,
    minAddress: segments[0].addr,
    maxAddress: segments[1].addr + segments[1].data.length,
    totalBytes: segments.reduce((n, s) => n + s.data.length, 0),
    ...overrides,
  }
}

describe('Stm32Dfu.flashInfo', () => {
  it('resolves family/flashKB/sectors from the DfuSe alt-0 interfaceName', async () => {
    const dfu = new Stm32Dfu(makeF4Device() as unknown as USBDevice)
    const info = await dfu.flashInfo()

    expect(info.family).toBe('F4')
    expect(info.flashKB).toBe(F4_TOTAL_BYTES / 1024)
    expect(info.sectors).toHaveLength(12) // 4 + 1 + 7
    expect(info.sectors[0]).toEqual({ start: 0x08000000, size: 16 * 1024 })
  })

  it('falls back to a raw string-descriptor scan when interfaceName is empty (the F405 "0 KB" case)', async () => {
    const dev = new FakeStm32Device('') // alt-0 interfaceName empty, as Chrome surfaces it on some F405 ROM DFUs
    dev.stringDescriptors[4] = F4_LAYOUT_NAME
    const dfu = new Stm32Dfu(dev as unknown as USBDevice)

    const info = await dfu.flashInfo()

    expect(info.family).toBe('F4')
    expect(info.sectors).toHaveLength(12)
  })

  it('throws rather than guess a layout when it is unresolvable both ways', async () => {
    const dev = new FakeStm32Device('') // no fallback string descriptors configured either
    const dfu = new Stm32Dfu(dev as unknown as USBDevice)

    await expect(dfu.flashInfo()).rejects.toThrow(/could not determine the flash layout/i)
  })
})

describe('Stm32Dfu.flash chip guard (must run before erase)', () => {
  it('rejects an oversized image — chip mismatch, nothing erased', async () => {
    const dev = makeF4Device()
    const dfu = new Stm32Dfu(dev as unknown as USBDevice)
    const hex = makeHex({ maxAddress: F4_END + 4 })

    await expect(dfu.flash(hex, vi.fn())).rejects.toThrow(/chip mismatch/i)
    expect(dev.eraseCalls).toHaveLength(0)
  })

  it('rejects a cross-family firmware pick — chip mismatch, nothing erased', async () => {
    const dev = makeF4Device()
    const dfu = new Stm32Dfu(dev as unknown as USBDevice)
    const hex = makeHex()

    await expect(dfu.flash(hex, vi.fn(), 'H7')).rejects.toThrow(/chip mismatch/i)
    expect(dev.eraseCalls).toHaveLength(0)
  })

  it('allows a matching family, and skips the family check entirely when none is supplied', async () => {
    const dev = makeF4Device()
    const dfu = new Stm32Dfu(dev as unknown as USBDevice)
    await expect(dfu.flash(makeHex(), vi.fn(), 'F4')).resolves.toBeUndefined()

    const dev2 = makeF4Device()
    const dfu2 = new Stm32Dfu(dev2 as unknown as USBDevice)
    await expect(dfu2.flash(makeHex(), vi.fn())).resolves.toBeUndefined()
  })
})

describe('Stm32Dfu.flash happy path', () => {
  it('erases every sector (full chip, not just the covered ones), programs both segments, and leaves DFU', async () => {
    const dev = makeF4Device()
    const dfu = new Stm32Dfu(dev as unknown as USBDevice)
    const progress = vi.fn()

    await dfu.flash(makeHex(), progress)

    expect(dev.eraseCalls).toHaveLength(12)
    expect(dev.eraseCalls[0]).toBe(0x08000000)

    expect(dev.writes).toHaveLength(2)
    expect(dev.writes[0]).toEqual({ addr: 0x08000000, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) })
    expect(dev.writes[1]).toEqual({ addr: 0x08010000, data: new Uint8Array([9, 9, 9, 9]) })

    const lastCall = progress.mock.calls[progress.mock.calls.length - 1]
    expect(lastCall).toEqual([1000, 1000]) // erase 0-30% + write 30-100% = 1000/1000 at the end
  })

  it('falls back to a smaller chunk size after a transfer error, and completes the write at the same offset', async () => {
    const dev = makeF4Device()
    dev.xferErrorOnce = true // the first data DNLOAD fails; Stm32Dfu should halve the chunk and retry
    const dfu = new Stm32Dfu(dev as unknown as USBDevice)

    await dfu.flash(makeHex(), vi.fn())

    expect(dev.recoverCalls).toBeGreaterThan(0)
    // Despite the induced failure, all bytes for segment 0 arrive intact (possibly split into more, smaller writes).
    const seg0Writes = dev.writes.filter((w) => w.addr < 0x08010000).sort((a, b) => a.addr - b.addr)
    const rebuilt = new Uint8Array(seg0Writes.reduce((n, w) => n + w.data.length, 0))
    let off = 0
    for (const w of seg0Writes) {
      rebuilt.set(w.data, off)
      off += w.data.length
    }
    expect(rebuilt).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
  })
})

describe('Stm32Dfu.close', () => {
  it('closes the underlying USB device', async () => {
    const dev = makeF4Device()
    const dfu = new Stm32Dfu(dev as unknown as USBDevice)
    await dfu.flashInfo()
    await dfu.close()
    expect(dev.opened).toBe(false)
  })
})
