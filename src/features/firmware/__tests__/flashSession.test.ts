import { describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { MockTransport } from '../../../core/transport/mock'
import type { ParsedApj } from '../../../core/firmware/apj'
import type { BoardFirmware, FirmwareFile } from '../../../core/firmware/manifest'
import type { ParsedHex } from '../../../core/firmware/intelhex'
import {
  createDfuFlashSession,
  createFlashSession,
  realFlashSessionEffects,
  type DfuSessionEffects,
  type DfuSessionState,
  type FlashSessionEffects,
  type FlashTarget,
  type Px4FlasherLike,
  type Stm32DfuLike,
} from '../flashSession'

/** Waits for `predicate(store.getState())` to become true, polling on every store change plus once eagerly — avoids coupling tests to how many internal awaits a run happens to have. */
function waitFor<T>(store: StoreApi<T>, predicate: (s: T) => boolean, timeoutMs = 1000): Promise<void> {
  if (predicate(store.getState())) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const unsub = store.subscribe((s) => {
      if (predicate(s)) {
        unsub()
        clearTimeout(timer)
        resolve()
      }
    })
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`waitFor timeout; last state: ${JSON.stringify(store.getState())}`))
    }, timeoutMs)
  })
}

/** jsdom's `Blob` has no `.stream()` (same friction documented in apj.ts's own module doc) — pipe a plain `ReadableStream` through `CompressionStream` instead, mirroring apj.test.ts's `deflate()` helper. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const reader = input.pipeThrough(new CompressionStream('deflate') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function board(overrides: Partial<BoardFirmware> = {}): BoardFirmware {
  return {
    boardName: 'AF-F4_nano',
    apjBoardId: 6203,
    hwdefBoardId: 6203,
    mcuFamily: 'F4',
    vehicle: 'copter',
    version: '0.3.0',
    gitHash: 'deadbeef',
    method: 'ardupilot',
    softwareDfuAllowed: true,
    dfuRecoveryAllowed: true,
    files: [],
    ...overrides,
  }
}

function apj(overrides: Partial<ParsedApj> = {}): ParsedApj {
  return { boardId: 6203, image: new Uint8Array([1, 2, 3]), imageSize: 3, ...overrides }
}

function onlineTarget(file: FirmwareFile, b: BoardFirmware = board()): FlashTarget {
  return { boardName: b.boardName, version: b.version, apjBoardId: b.apjBoardId, source: { kind: 'online', board: b, file } }
}

function localTarget(parsed: ParsedApj = apj()): FlashTarget {
  return { boardName: 'AF-F4_nano', version: 'local', apjBoardId: parsed.boardId, source: { kind: 'local', fileName: 'custom.apj', apj: parsed } }
}

class FakePx4Flasher implements Px4FlasherLike {
  identifyCalls = 0
  flashCalls = 0
  identifyResult = { boardId: 6203, flashSize: 1024 * 1024, blRev: 5 }
  flashError: Error | null = null
  progressSteps: Array<[number, number]> = [[512, 1024]]

  async identify() {
    this.identifyCalls++
    return this.identifyResult
  }

  async flash(_apj: ParsedApj, onProgress: (done: number, total: number) => void) {
    this.flashCalls++
    for (const [done, total] of this.progressSteps) onProgress(done, total)
    if (this.flashError) throw this.flashError
  }
}

function baseEffects(overrides: Partial<FlashSessionEffects> = {}): { effects: FlashSessionEffects; flasher: FakePx4Flasher; transport: MockTransport; calls: { fetch: number; reboot: number; openBootloader: number; createFlasher: number } } {
  const flasher = new FakePx4Flasher()
  const bootloaderTransport = new MockTransport()
  const calls = { fetch: 0, reboot: 0, openBootloader: 0, createFlasher: 0 }
  const liveTransport = new MockTransport()

  const effects: FlashSessionEffects = {
    fetchFn: async () => {
      calls.fetch++
      return new Response('ok')
    },
    takeoverTransport: () => liveTransport,
    rebootToBootloader: async () => {
      calls.reboot++
    },
    openBootloaderTransport: async () => {
      calls.openBootloader++
      return bootloaderTransport
    },
    createFlasher: () => {
      calls.createFlasher++
      return flasher
    },
    now: () => 0,
    ...overrides,
  }
  return { effects, flasher, transport: bootloaderTransport, calls }
}

describe('createFlashSession (normal update, Px4Flasher)', () => {
  it('runs the full happy path in order for a local .apj (skips downloading/verifying)', async () => {
    const { effects, flasher, calls } = baseEffects()
    const store = createFlashSession(effects)
    const seen: string[] = []
    store.subscribe((s) => seen.push(s.step))

    store.getState().prepare(localTarget())
    expect(store.getState().step).toBe('confirming')
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'done' || s.step === 'failed')

    expect(store.getState().step).toBe('done')
    expect(store.getState().identify).toEqual(flasher.identifyResult)
    expect(store.getState().progress).toEqual({ done: 512, total: 1024 })
    expect(calls.reboot).toBe(1)
    expect(calls.openBootloader).toBe(1)
    expect(calls.createFlasher).toBe(1)
    expect(flasher.identifyCalls).toBe(1)
    expect(flasher.flashCalls).toBe(1)
    // No downloading/verifying for a local source.
    expect(seen).not.toContain('downloading')
    expect(seen).not.toContain('verifying')
    expect(seen.filter((s) => s === 'rebooting').length).toBeGreaterThan(0)
  })

  it('downloads + verifies sha256 + parses for an online source before rebooting', async () => {
    const imageBytes = new TextEncoder().encode('firmware-bytes')
    const sha = await sha256Hex(imageBytes)
    const file: FirmwareFile = { kind: 'apj', name: 'x.apj', url: 'https://example.invalid/x.apj', sha256: sha, size: imageBytes.length }

    // A minimal valid .apj JSON body (board_id + base64(deflate(image))).
    const compressed = await deflate(imageBytes)
    let binary = ''
    for (const b of compressed) binary += String.fromCharCode(b)
    const apjJson = JSON.stringify({ board_id: 6203, image_size: imageBytes.length, image: btoa(binary) })
    const apjBytes = new TextEncoder().encode(apjJson)
    const apjSha = await sha256Hex(apjBytes)
    file.sha256 = apjSha

    const seen: string[] = []
    const { effects } = baseEffects({
      fetchFn: async () => new Response(apjBytes.buffer as ArrayBuffer, { status: 200 }),
    })
    const store = createFlashSession(effects)
    store.subscribe((s) => seen.push(s.step))

    store.getState().prepare(onlineTarget(file))
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'done' || s.step === 'failed')

    expect(store.getState().error).toBeNull()
    expect(store.getState().step).toBe('done')
    expect(seen).toContain('downloading')
    expect(seen).toContain('verifying')
  })

  it('fails at "downloading" on a non-2xx HTTP response, never reaching the bootloader', async () => {
    const { effects, calls } = baseEffects({ fetchFn: async () => new Response('nope', { status: 404 }) })
    const store = createFlashSession(effects)

    store.getState().prepare(onlineTarget({ kind: 'apj', name: 'x.apj', url: 'https://x', sha256: 'a'.repeat(64), size: 1 }))
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('downloading')
    expect(store.getState().error).toMatch(/404/)
    expect(calls.reboot).toBe(0)
    expect(calls.createFlasher).toBe(0)
  })

  it('fails at "verifying" on a sha256 mismatch', async () => {
    const { effects } = baseEffects({ fetchFn: async () => new Response('some-bytes', { status: 200 }) })
    const store = createFlashSession(effects)

    store.getState().prepare(onlineTarget({ kind: 'apj', name: 'x.apj', url: 'https://x', sha256: '0'.repeat(64), size: 1 }))
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('verifying')
    expect(store.getState().error).toMatch(/checksum/i)
  })

  it('fails at "rebooting" when not connected (takeoverTransport returns null)', async () => {
    const { effects, calls } = baseEffects({ takeoverTransport: () => null })
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('rebooting')
    expect(calls.openBootloader).toBe(0)
  })

  it('passes the exact pre-reboot transport through to openBootloaderTransport (issue #28: the reconnect needs to know which port to wait on)', async () => {
    const liveTransport = new MockTransport()
    let receivedTransport: unknown
    const { effects } = baseEffects({
      takeoverTransport: () => liveTransport,
      openBootloaderTransport: async (oldTransport) => {
        receivedTransport = oldTransport
        return new MockTransport()
      },
    })
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'done' || s.step === 'failed')

    expect(store.getState().step).toBe('done')
    expect(receivedTransport).toBe(liveTransport) // not some fresh/unrelated transport — the reconnect step must see the actual just-rebooted one
  })

  it('still passes the pre-reboot transport through on retry() (rebootSent already true, the reboot block is skipped)', async () => {
    const liveTransport = new MockTransport()
    let openBootloaderCalls = 0
    let lastReceivedTransport: unknown
    const { effects } = baseEffects({
      takeoverTransport: () => liveTransport,
      openBootloaderTransport: async (oldTransport) => {
        openBootloaderCalls++
        lastReceivedTransport = oldTransport
        if (openBootloaderCalls === 1) throw new Error('timed out waiting for the bootloader')
        return new MockTransport()
      },
    })
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()
    await waitFor(store, (s) => s.step === 'failed')
    expect(store.getState().failedStep).toBe('connecting')

    store.getState().retry()
    await waitFor(store, (s) => s.step === 'done' || s.step === 'failed')

    expect(store.getState().step).toBe('done')
    expect(openBootloaderCalls).toBe(2)
    expect(lastReceivedTransport).toBe(liveTransport) // the retry still identifies the same original pre-reboot port, not undefined/null
  })

  it('fails at "connecting" when the bootloader never re-enumerates', async () => {
    const { effects } = baseEffects({ openBootloaderTransport: async () => { throw new Error('timed out waiting for the bootloader') } })
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('connecting')
    expect(store.getState().error).toMatch(/timed out/i)
  })

  it('surfaces a board-ID mismatch (engine guard failure) as a failure at "identifying"', async () => {
    const { effects, flasher } = baseEffects()
    flasher.flashError = new Error('Wrong firmware — flash aborted, nothing erased. This firmware is for board ID 6203, but the connected board is ID 9999.')
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('identifying')
    expect(store.getState().error).toMatch(/wrong firmware/i)
    expect(store.getState().disconnected).toBe(false)
  })

  it('classifies a CRC verify failure as "verifying-flash"', async () => {
    const { effects, flasher } = baseEffects()
    flasher.flashError = new Error('CRC verify failed — flash mismatch')
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('verifying-flash')
  })

  it('classifies a mid-program disconnect as "programming" + disconnected, and retry() redoes connecting (not rebooting/downloading)', async () => {
    const { effects, flasher, calls } = baseEffects()
    flasher.flashError = new Error('Serial port closed')
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()
    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('programming')
    expect(store.getState().disconnected).toBe(true)
    expect(calls.reboot).toBe(1)
    expect(calls.openBootloader).toBe(1)

    flasher.flashError = null // the retry succeeds
    store.getState().retry()
    await waitFor(store, (s) => s.step === 'done' || s.step === 'failed')

    expect(store.getState().step).toBe('done')
    expect(calls.reboot).toBe(1) // never re-sent
    expect(calls.openBootloader).toBe(2) // re-connected
  })

  it('retry() is a no-op unless the session is failed', async () => {
    const { effects } = baseEffects()
    const store = createFlashSession(effects)
    store.getState().prepare(localTarget())
    store.getState().retry()
    expect(store.getState().step).toBe('confirming')
  })

  it('cancel() aborts cleanly before the destructive point and later effect resolutions are ignored', async () => {
    let resolveFetch!: (r: Response) => void
    const { effects, calls } = baseEffects({
      fetchFn: () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    })
    const store = createFlashSession(effects)

    store.getState().prepare(onlineTarget({ kind: 'apj', name: 'x.apj', url: 'https://x', sha256: 'a'.repeat(64), size: 1 }))
    store.getState().confirm()
    expect(store.getState().step).toBe('downloading')

    store.getState().cancel()
    expect(store.getState().step).toBe('idle')

    resolveFetch(new Response('late', { status: 200 }))
    await new Promise((r) => setTimeout(r, 20))

    expect(store.getState().step).toBe('idle') // the stale run must not have clobbered this
    expect(calls.reboot).toBe(0)
  })

  it('cancel() is a no-op once erasing/programming has started', async () => {
    const { effects, flasher } = baseEffects()
    flasher.progressSteps = [[100, 1000]] // flash() will call onProgress once, synchronously observable
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()
    await waitFor(store, (s) => s.step === 'programming' || s.step === 'done' || s.step === 'failed')

    if (store.getState().step === 'programming') {
      store.getState().cancel()
      expect(store.getState().step).toBe('programming') // cancel ignored
    }
  })

  it('closes the bootloader transport once the flash completes successfully (it can no longer speak bootloader protocol post-reboot)', async () => {
    const { effects, transport } = baseEffects()
    const closeSpy = vi.spyOn(transport, 'close')
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()
    await waitFor(store, (s) => s.step === 'done' || s.step === 'failed')

    expect(store.getState().step).toBe('done')
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('cancel() during "connecting" closes a late-resolving transport instead of adopting it, and a fresh attempt reconnects for real', async () => {
    let openCalls = 0
    let resolveFirstOpen!: (t: MockTransport) => void
    const lateTransport = new MockTransport()
    const closeSpy = vi.spyOn(lateTransport, 'close')
    const freshTransport = new MockTransport()
    const { effects } = baseEffects({
      openBootloaderTransport: () => {
        openCalls++
        if (openCalls === 1) return new Promise((resolve) => (resolveFirstOpen = resolve))
        return Promise.resolve(freshTransport)
      },
    })
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()
    await waitFor(store, (s) => s.step === 'connecting')

    store.getState().cancel()
    expect(store.getState().step).toBe('idle')

    resolveFirstOpen(lateTransport) // the stale run's reconnect resolves only after the cancel
    await new Promise((r) => setTimeout(r, 20))

    expect(closeSpy).toHaveBeenCalledTimes(1) // superseded transport released, not adopted
    expect(store.getState().step).toBe('idle') // stale resolution never touched state

    store.getState().prepare(localTarget())
    store.getState().confirm()
    await waitFor(store, (s) => s.step === 'done' || s.step === 'failed')

    expect(store.getState().step).toBe('done')
    expect(openCalls).toBe(2) // reconnected for real, did not reuse the cancelled attempt's (closed) transport
  })

  it('classifies identify() itself failing as "identifying" (distinct from a flash() guard failure) and forces a fresh "connecting" on retry', async () => {
    let openCalls = 0
    const transport1 = new MockTransport()
    const transport2 = new MockTransport()
    const closeSpy1 = vi.spyOn(transport1, 'close')
    const { effects, flasher } = baseEffects({
      openBootloaderTransport: async () => {
        openCalls++
        return openCalls === 1 ? transport1 : transport2
      },
    })
    let identifyCalls = 0
    const originalIdentify = flasher.identify.bind(flasher)
    flasher.identify = async () => {
      identifyCalls++
      if (identifyCalls === 1) throw new Error('bootloader sync lost (expected INSYNC, got 0x00)')
      return originalIdentify()
    }
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()
    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('identifying') // not misclassified as 'erasing'
    expect(store.getState().disconnected).toBe(false) // a sync-lost/timeout error is not a dropped-cable error
    expect(closeSpy1).toHaveBeenCalledTimes(1) // this transport is presumed unusable for bootloader traffic — closed, not kept for retry

    store.getState().retry()
    await waitFor(store, (s) => s.step === 'done' || s.step === 'failed')

    expect(store.getState().step).toBe('done')
    expect(openCalls).toBe(2) // retry() reconnected fresh instead of reusing transport1
  })

  it('classifies an identify() failure caused by a dropped cable as disconnected:true (reconnect guidance, not "still in bootloader, retry is safe")', async () => {
    const { effects, flasher } = baseEffects()
    flasher.identify = async () => {
      throw new Error('Serial port closed')
    }
    const store = createFlashSession(effects)

    store.getState().prepare(localTarget())
    store.getState().confirm()
    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('identifying')
    expect(store.getState().disconnected).toBe(true)
  })
})

// ---------------------------------------------------------------------------

function hex(overrides: Partial<ParsedHex> = {}): ParsedHex {
  return { segments: [{ addr: 0x08000000, data: new Uint8Array([1, 2, 3]) }], minAddress: 0x08000000, maxAddress: 0x08000003, totalBytes: 3, ...overrides }
}

class FakeStm32Dfu implements Stm32DfuLike {
  flashCalls = 0
  flashError: Error | null = null
  progressSteps: Array<[number, number]> = [
    [300, 1000],
    [1000, 1000],
  ]

  async flash(_hex: ParsedHex, onProgress: (done: number, total: number) => void) {
    this.flashCalls++
    for (const [done, total] of this.progressSteps) onProgress(done, total)
    if (this.flashError) throw this.flashError
  }
}

describe('createDfuFlashSession (DFU recovery, Stm32Dfu)', () => {
  function dfuEffects(overrides: Partial<DfuSessionEffects> = {}): { effects: DfuSessionEffects; flasher: FakeStm32Dfu } {
    const flasher = new FakeStm32Dfu()
    return { effects: { flasher, now: () => 0, ...overrides }, flasher }
  }

  it('runs erase (progress < 300) then programming (>= 300) then done', async () => {
    const { effects } = dfuEffects()
    const store = createDfuFlashSession(effects)
    const seen: DfuSessionState['step'][] = []
    store.subscribe((s) => seen.push(s.step))

    store.getState().prepare({ fileName: 'x_with_bl.hex', hex: hex() })
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'done' || s.step === 'failed')

    expect(store.getState().step).toBe('done')
    expect(seen).toContain('erasing')
    expect(seen).toContain('programming')
  })

  it('surfaces a chip-mismatch guard failure as "erasing" (no progress observed)', async () => {
    const { effects, flasher } = dfuEffects()
    flasher.progressSteps = []
    flasher.flashError = new Error('Chip mismatch — flash aborted, nothing erased. The selected firmware is for STM32F4-class, but the connected board is STM32H7-class.')
    const store = createDfuFlashSession(effects)

    store.getState().prepare({ fileName: 'x_with_bl.hex', hex: hex(), expectedFamily: 'F4' })
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('erasing')
    expect(store.getState().error).toMatch(/chip mismatch/i)
  })

  it('classifies a mid-write failure (progress already >= 300) as "programming"', async () => {
    const { effects, flasher } = dfuEffects()
    flasher.progressSteps = [[300, 1000]]
    flasher.flashError = new Error('DNLOAD failed: stall')
    const store = createDfuFlashSession(effects)

    store.getState().prepare({ fileName: 'x_with_bl.hex', hex: hex() })
    store.getState().confirm()

    await waitFor(store, (s) => s.step === 'failed')

    expect(store.getState().failedStep).toBe('programming')
  })

  it('cancel() from confirming returns to idle; cancel() is a no-op elsewhere', async () => {
    const { effects } = dfuEffects()
    const store = createDfuFlashSession(effects)

    store.getState().prepare({ fileName: 'x.hex', hex: hex() })
    expect(store.getState().step).toBe('confirming')
    store.getState().cancel()
    expect(store.getState().step).toBe('idle')

    store.getState().cancel() // idle -> cancel is a no-op
    expect(store.getState().step).toBe('idle')
  })
})

describe('realFlashSessionEffects — issue #27 regression ("Illegal invocation")', () => {
  /**
   * jsdom/undici's `fetch` is NOT this-strict — `const f = fetch; f.call(someObject, url)`
   * succeeds there — so a naive test against the real global `fetch` would
   * pass both before and after the fix and prove nothing (this is exactly
   * how the original bug shipped unnoticed). This stub stands in for
   * Chrome's actual `Window.fetch`, which throws "Illegal invocation" for
   * any `this` other than `window`/`undefined`/`globalThis`.
   */
  function chromeStrictFetch(this: unknown): ReturnType<typeof fetch> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }
    return Promise.resolve(new Response('ok'))
  }

  it('reproduces the original bug: a bare stored fetchFn throws when invoked method-style off its containing object', async () => {
    // Mirrors the pre-fix shape at flashSession.ts:568 (`fetchFn: fetch`, no
    // `.bind()`) and the pre-fix call site at run() (`effects.fetchFn(url)`,
    // method-style) — proves the stub above is a faithful stand-in for
    // Chrome's fetch before asserting the fix neutralizes it below.
    const unbound = { fetchFn: chromeStrictFetch as unknown as typeof fetch }
    // Real Chrome throws this synchronously (not a rejected promise) — matches
    // why flashSession.ts's run() wraps the call in try/catch around the
    // `await`, which catches both forms.
    expect(() => unbound.fetchFn('https://example.invalid/x.apj')).toThrow('Illegal invocation')
  })

  it('fix: realFlashSessionEffects binds fetchFn at the storage site, so the same method-style call succeeds', async () => {
    const effects = realFlashSessionEffects(chromeStrictFetch as unknown as typeof fetch)
    // Method-style, exactly like `effects.fetchFn(firmwareFileUrl(file))` in
    // run() above — this is the call that broke in Chrome (issue #27).
    await expect(effects.fetchFn('https://example.invalid/x.apj')).resolves.toBeInstanceOf(Response)
  })
})
