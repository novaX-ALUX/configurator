import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../types'

/**
 * Per-implementation hooks the shared contract suite needs beyond the
 * public `Transport` interface, to simulate the "outside world" (bytes
 * arriving on the wire, the peer/device disconnecting) and to observe what
 * was actually sent.
 */
export interface TransportTestHarness {
  transport: Transport
  /** Injects bytes as if received from the wire, after `open()` has resolved. */
  feed: (bytes: Uint8Array) => void
  /** Bytes written via `transport.write()` so far, in call order. */
  getSent: () => Uint8Array[]
  /** Simulates an external/abnormal disconnect (device unplugged, peer closed, read error). */
  simulateDisconnect: (reason: string) => void
}

/**
 * Shared behavioral contract, run against every `Transport` implementation
 * (see `types.ts` module doc for the semantics being asserted here).
 */
export function describeTransportContract(name: string, makeHarness: () => TransportTestHarness): void {
  describe(`${name} (transport contract)`, () => {
    let harness: TransportTestHarness

    beforeEach(() => {
      harness = makeHarness()
    })

    it('open() resolves and readable becomes a lock-free stream', async () => {
      await expect(harness.transport.open()).resolves.toBeUndefined()
      expect(harness.transport.readable.locked).toBe(false)
    })

    it('rejects a second open() while already open', async () => {
      await harness.transport.open()
      await expect(harness.transport.open()).rejects.toThrow()
    })

    it('delivers fragmented chunks via readable in order, with no loss or duplication', async () => {
      await harness.transport.open()
      const reader = harness.transport.readable.getReader()
      const chunks = [
        new Uint8Array([1, 2]),
        new Uint8Array([3]),
        new Uint8Array([]),
        new Uint8Array([4, 5, 6, 7]),
      ]
      const expectedTotal = chunks.reduce((n, c) => n + c.length, 0)

      for (const chunk of chunks) harness.feed(chunk)

      const received: number[] = []
      while (received.length < expectedTotal) {
        const { value, done } = await reader.read()
        expect(done).toBe(false)
        if (value) received.push(...value)
      }
      expect(received).toEqual([1, 2, 3, 4, 5, 6, 7])
    })

    it('close() is idempotent, ends readable, and rejects write() afterward', async () => {
      await harness.transport.open()
      const reader = harness.transport.readable.getReader()

      await harness.transport.close()

      await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
      await expect(harness.transport.close()).resolves.toBeUndefined()
      await expect(harness.transport.write(new Uint8Array([1]))).rejects.toThrow()
    })

    it('a mid-read disconnect fires onDisconnect exactly once and ends readable', async () => {
      await harness.transport.open()
      const reader = harness.transport.readable.getReader()
      const readPromise = reader.read()
      const onDisconnect = vi.fn()
      harness.transport.onDisconnect(onDisconnect)

      harness.simulateDisconnect('unplugged')

      await expect(readPromise).resolves.toEqual({ value: undefined, done: true })
      expect(onDisconnect).toHaveBeenCalledTimes(1)
      expect(onDisconnect).toHaveBeenCalledWith(expect.any(String))
    })

    it('onDisconnect returns an unsubscribe function; unsubscribed callbacks do not fire', async () => {
      await harness.transport.open()
      const kept = vi.fn()
      const removed = vi.fn()
      const unsubscribe = harness.transport.onDisconnect(removed)
      harness.transport.onDisconnect(kept)

      unsubscribe()
      harness.simulateDisconnect('bye')

      expect(removed).not.toHaveBeenCalled()
      expect(kept).toHaveBeenCalledTimes(1)
    })

    it('write() after open sends bytes verbatim', async () => {
      await harness.transport.open()
      const data = new Uint8Array([9, 8, 7, 6])

      await harness.transport.write(data)

      expect(harness.getSent()).toEqual([data])
    })

    it('a pre-aborted signal rejects open() immediately with no side effects', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(harness.transport.open({ signal: controller.signal })).rejects.toThrow()
      expect(() => harness.transport.readable).toThrow()
      expect(harness.getSent()).toEqual([])

      // No corrupted state left behind: a real open() still works afterward.
      await expect(harness.transport.open()).resolves.toBeUndefined()
    })
  })
}
