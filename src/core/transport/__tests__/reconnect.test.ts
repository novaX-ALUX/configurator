import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '../types'
import { MockTransport } from '../mock'
import { DEFAULT_DISCONNECT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS, waitForBootloaderReconnect, type SerialLike } from '../reconnect'

/** Minimal fake `SerialPort` — only the surface `reconnect.ts` touches (`connected`, `disconnect` events). Real `open()`/`getInfo()`/etc. are irrelevant here since `openCandidate` is injected directly in these tests (the real `SerialTransport.open()` path is `serial.test.ts`'s job). */
class FakeSerialPort extends EventTarget {
  connected: boolean

  constructor(connected = true) {
    super()
    this.connected = connected
  }

  /** Simulates the OS actually processing the physical detach: flips `connected` and fires the event exactly as the Web Serial spec describes for a wired port. */
  disconnect(): void {
    this.connected = false
    this.dispatchEvent(new Event('disconnect'))
  }
}

class FakeSerial implements SerialLike {
  ports: FakeSerialPort[] = []

  async getPorts(): Promise<SerialPort[]> {
    return this.ports as unknown as SerialPort[]
  }
}

/**
 * Manually-driven virtual clock — the repo's existing convention for
 * deterministic async timing is a manually-resolved promise per case (see
 * flashSession.test.ts's `resolveFirstOpen`) rather than `vi.useFakeTimers()`;
 * this generalizes that into a `now()`/`sleep()` pair so `reconnect.ts`'s two
 * *different* timeouts (disconnect-wait vs poll-interval) can be advanced
 * independently and deterministically without any real waiting.
 */
function makeClock() {
  let time = 0
  const pending: Array<{ at: number; resolve: () => void }> = []
  return {
    now: () => time,
    sleep: (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        pending.push({ at: time + ms, resolve })
      }),
    /** Advances virtual time and settles every pending `sleep()` whose deadline has now passed, in deadline order. */
    async advance(ms: number): Promise<void> {
      time += ms
      const ready = pending.filter((p) => p.at <= time).sort((a, b) => a.at - b.at)
      for (const p of ready) {
        const idx = pending.indexOf(p)
        if (idx >= 0) pending.splice(idx, 1)
      }
      for (const p of ready) p.resolve()
      // Let the resolved promises' .then() chains (and any synchronous work
      // they trigger, like the reconnect loop's next getPorts() call) run
      // before the caller inspects state.
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

function openViaMockTransport(): (port: SerialPort) => Promise<Transport> {
  return async () => {
    const t = new MockTransport()
    await t.open()
    return t
  }
}

describe('waitForBootloaderReconnect', () => {
  it('regression (issue #28): does not open ANY candidate — even one already sitting in getPorts() — until the old port has actually disconnected', async () => {
    const oldPort = new FakeSerialPort(true) // still "connected" — the app-mode device hasn't dropped yet
    const bootloaderPort = new FakeSerialPort(true)
    const serial = new FakeSerial()
    serial.ports = [oldPort, bootloaderPort] // the stale handle AND a plausible new one both already present
    const clock = makeClock()
    let openCandidateCalls = 0
    const openCandidate = vi.fn(async (port: SerialPort) => {
      openCandidateCalls++
      if (port !== (bootloaderPort as unknown as SerialPort)) throw new Error('not the bootloader')
      return openViaMockTransport()(port)
    })

    const resultPromise = waitForBootloaderReconnect({
      serial,
      oldPort: oldPort as unknown as SerialPort,
      openCandidate,
      now: clock.now,
      sleep: clock.sleep,
    })

    // Give the microtask queue a chance to run — must NOT have attempted to open anything yet.
    await Promise.resolve()
    await Promise.resolve()
    expect(openCandidateCalls).toBe(0)

    oldPort.disconnect() // the OS finally processes the physical detach
    await Promise.resolve()
    await Promise.resolve()

    const transport = await resultPromise
    expect(transport).toBeInstanceOf(MockTransport)
    expect(openCandidateCalls).toBeGreaterThan(0)
  })

  it('skips the disconnect-wait entirely when the old port is already logically disconnected', async () => {
    const oldPort = new FakeSerialPort(false) // already gone by the time we get here
    const bootloaderPort = new FakeSerialPort(true)
    const serial = new FakeSerial()
    serial.ports = [bootloaderPort]
    const clock = makeClock()

    const transport = await waitForBootloaderReconnect({
      serial,
      oldPort: oldPort as unknown as SerialPort,
      openCandidate: openViaMockTransport(),
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(transport).toBeInstanceOf(MockTransport)
  })

  it('skips the disconnect-wait when oldPort is null (non-SerialTransport live connection)', async () => {
    const bootloaderPort = new FakeSerialPort(true)
    const serial = new FakeSerial()
    serial.ports = [bootloaderPort]
    const clock = makeClock()

    const transport = await waitForBootloaderReconnect({
      serial,
      oldPort: null,
      openCandidate: openViaMockTransport(),
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(transport).toBeInstanceOf(MockTransport)
  })

  it('falls back to polling if the disconnect event never arrives, once the disconnect-wait timeout elapses', async () => {
    const oldPort = new FakeSerialPort(true) // never calls .disconnect()
    const bootloaderPort = new FakeSerialPort(true)
    const serial = new FakeSerial()
    serial.ports = [bootloaderPort]
    const clock = makeClock()

    const resultPromise = waitForBootloaderReconnect({
      serial,
      oldPort: oldPort as unknown as SerialPort,
      openCandidate: openViaMockTransport(),
      now: clock.now,
      sleep: clock.sleep,
    })

    await Promise.resolve()
    await clock.advance(DEFAULT_DISCONNECT_TIMEOUT_MS)

    const transport = await resultPromise
    expect(transport).toBeInstanceOf(MockTransport)
  })

  it('re-polls at the poll interval when getPorts() has nothing yet, then succeeds once a port appears', async () => {
    const oldPort = new FakeSerialPort(false)
    const serial = new FakeSerial()
    serial.ports = [] // nothing yet
    const clock = makeClock()

    const resultPromise = waitForBootloaderReconnect({
      serial,
      oldPort: oldPort as unknown as SerialPort,
      openCandidate: openViaMockTransport(),
      now: clock.now,
      sleep: clock.sleep,
    })

    await Promise.resolve()
    await clock.advance(DEFAULT_POLL_INTERVAL_MS) // first re-poll: still nothing
    await clock.advance(DEFAULT_POLL_INTERVAL_MS) // second re-poll: still nothing

    serial.ports = [new FakeSerialPort(true)] // now it appears
    await clock.advance(DEFAULT_POLL_INTERVAL_MS)

    const transport = await resultPromise
    expect(transport).toBeInstanceOf(MockTransport)
  })

  it('throws a "needs a fresh permission grant" error when getPorts() never returns any candidate before the poll deadline', async () => {
    const oldPort = new FakeSerialPort(false)
    const serial = new FakeSerial()
    serial.ports = []
    const clock = makeClock()

    const resultPromise = waitForBootloaderReconnect({
      serial,
      oldPort: oldPort as unknown as SerialPort,
      openCandidate: openViaMockTransport(),
      now: clock.now,
      sleep: clock.sleep,
      pollTimeoutMs: 1000,
      pollIntervalMs: 300,
    })
    const assertion = expect(resultPromise).rejects.toThrow(/fresh permission grant/i)

    await Promise.resolve()
    await clock.advance(300)
    await clock.advance(300)
    await clock.advance(300)
    await clock.advance(300) // total 1200ms >= 1000ms deadline

    await assertion
  })

  it('throws the generic reconnect-cable error when candidates appear but never successfully open before the poll deadline', async () => {
    const oldPort = new FakeSerialPort(false)
    const deadPort = new FakeSerialPort(true)
    const serial = new FakeSerial()
    serial.ports = [deadPort] // present, but never answers
    const clock = makeClock()

    const resultPromise = waitForBootloaderReconnect({
      serial,
      oldPort: oldPort as unknown as SerialPort,
      openCandidate: async () => {
        throw new Error('not ready')
      },
      now: clock.now,
      sleep: clock.sleep,
      pollTimeoutMs: 1000,
      pollIntervalMs: 300,
    })
    const assertion = expect(resultPromise).rejects.toThrow(/reconnect the usb cable/i)

    await Promise.resolve()
    await clock.advance(300)
    await clock.advance(300)
    await clock.advance(300)
    await clock.advance(300)

    await assertion
  })
})
