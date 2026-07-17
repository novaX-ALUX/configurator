import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { encodeFrame } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { MavRouter } from '../../../core/mavlink/router'
import { ParamStore } from '../../../core/mavlink/params'
import { createStagedSlice, stagePatch, type StagedState } from '../stagedStore'

const MAV_PARAM_TYPE_REAL32 = 9

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A bare consumer store: exactly what a second page (Tuning, RC cal) would create — no Setup code involved. */
function makeStagedStore() {
  return create<StagedState>()((set, get) => createStagedSlice(set, get))
}

function paramValueFrame(opts: { name: string; value: number; type?: number; count: number; index: number }): Uint8Array {
  const payload = encodePayload(defs, 22, {
    param_id: opts.name,
    param_value: opts.value,
    param_type: opts.type ?? MAV_PARAM_TYPE_REAL32,
    param_count: opts.count,
    param_index: opts.index,
  })
  return encodeFrame(defs, { msgid: 22, payload }, 0, 1, 1)
}

/** Real ParamStore backed by a MockTransport+MavRouter — same "test the real protocol state machine" style as setupStore.test.ts. */
async function makeConnectedParamStore(): Promise<{ transport: MockTransport; paramStore: ParamStore }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const paramStore = new ParamStore(router, { sysid: 1, compid: 1 })
  return { transport, paramStore }
}

async function feedAll(transport: MockTransport, entries: Array<{ name: string; value: number }>): Promise<void> {
  entries.forEach((e, index) => {
    transport.feed(paramValueFrame({ name: e.name, value: e.value, count: entries.length, index }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('createStagedSlice', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  describe('stage / dedupe', () => {
    it('stages a param, dedupes on re-stage (latest wins, no duplicate entries)', () => {
      const store = makeStagedStore()
      store.getState().stage('ATC_RAT_RLL_P', 0.135, '0.135')
      expect(store.getState().pending.get('ATC_RAT_RLL_P')).toEqual({ value: 0.135, label: '0.135' })
      expect(store.getState().pending.size).toBe(1)

      store.getState().stage('ATC_RAT_RLL_P', 0.15, '0.15')
      expect(store.getState().pending.size).toBe(1)
      expect(store.getState().pending.get('ATC_RAT_RLL_P')).toEqual({ value: 0.15, label: '0.15' })
    })

    it('clears any existing write status when a param is re-staged', () => {
      const store = makeStagedStore()
      store.setState({ writeStatus: new Map([['ATC_RAT_RLL_P', { kind: 'timeout' }]]) })
      store.getState().stage('ATC_RAT_RLL_P', 0.15, '0.15')
      expect(store.getState().writeStatus.has('ATC_RAT_RLL_P')).toBe(false)
    })

    it('stagePatch stages several entries in one patch: dedupes against prior stages and clears their write statuses', () => {
      const store = makeStagedStore()
      store.getState().stage('RC1_MIN', 1000, '1000')
      store.setState({ writeStatus: new Map([['RC1_MIN', { kind: 'timeout' }]]) })
      // How a composing page store uses it: merged into its own single set().
      store.setState((s) =>
        stagePatch(s, [
          { param: 'RC1_MIN', value: 982, label: '982' },
          { param: 'RC1_MAX', value: 2006, label: '2006' },
        ]),
      )
      expect(store.getState().pending.size).toBe(2)
      expect(store.getState().pending.get('RC1_MIN')).toEqual({ value: 982, label: '982' })
      expect(store.getState().pending.get('RC1_MAX')).toEqual({ value: 2006, label: '2006' })
      expect(store.getState().writeStatus.has('RC1_MIN')).toBe(false)
    })

    it('discard removes exactly one param from pending and writeStatus', () => {
      const store = makeStagedStore()
      store.getState().stage('RC1_MIN', 982, '982')
      store.getState().stage('RC1_MAX', 2006, '2006')
      store.getState().discard('RC1_MIN')
      expect(store.getState().pending.has('RC1_MIN')).toBe(false)
      expect(store.getState().pending.has('RC1_MAX')).toBe(true)
    })
  })

  describe('revertAll', () => {
    it('clears every pending edit and write status', () => {
      const store = makeStagedStore()
      store.getState().stage('RC1_MIN', 982, '982')
      store.setState({ writeStatus: new Map([['RC1_MIN', { kind: 'timeout' }]]) })
      store.getState().revertAll()
      expect(store.getState().pending.size).toBe(0)
      expect(store.getState().writeStatus.size).toBe(0)
    })
  })

  describe('writeAll', () => {
    it('a successful write shows a transient ok status, then clears the param from pending', async () => {
      const store = makeStagedStore()
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, [{ name: 'ATC_RAT_RLL_P', value: 0.135 }])
      store.getState().stage('ATC_RAT_RLL_P', 0.15, '0.15')

      void store.getState().writeAll(paramStore)
      await tick() // PARAM_SET goes out
      expect(store.getState().writeStatus.get('ATC_RAT_RLL_P')?.kind).toBe('writing')

      transport.feed(paramValueFrame({ name: 'ATC_RAT_RLL_P', value: 0.15, count: 1, index: 0 }))
      await tick()
      expect(store.getState().writeStatus.get('ATC_RAT_RLL_P')?.kind).toBe('ok')
      expect(store.getState().pending.has('ATC_RAT_RLL_P')).toBe(true) // still there until the display window elapses

      await tick(2000)
      expect(store.getState().pending.has('ATC_RAT_RLL_P')).toBe(false)
      expect(store.getState().writeStatus.has('ATC_RAT_RLL_P')).toBe(false)
      expect(store.getState().writing).toBe(false)
    })

    it('a mismatch keeps the param in pending with its failure status', async () => {
      const store = makeStagedStore()
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, [{ name: 'ATC_RAT_RLL_P', value: 0.135 }])
      store.getState().stage('ATC_RAT_RLL_P', 99, '99')

      void store.getState().writeAll(paramStore)
      await tick()
      transport.feed(paramValueFrame({ name: 'ATC_RAT_RLL_P', value: 0.5, count: 1, index: 0 })) // FC clamped
      await tick()

      expect(store.getState().pending.get('ATC_RAT_RLL_P')).toEqual({ value: 99, label: '99' })
      expect(store.getState().writeStatus.get('ATC_RAT_RLL_P')).toEqual({ kind: 'mismatch', requested: 99, actual: 0.5 })
      expect(store.getState().writing).toBe(false)
    })

    it('a disconnect mid-batch (clearForDisconnect) stops the loop instead of resurrecting cleared state', async () => {
      const store = makeStagedStore()
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, [
        { name: 'FIRST_PARAM', value: 0 },
        { name: 'SECOND_PARAM', value: 0 },
      ])
      store.getState().stage('FIRST_PARAM', 1, '1')
      store.getState().stage('SECOND_PARAM', 2, '2')

      void store.getState().writeAll(paramStore)
      await tick() // FIRST_PARAM's PARAM_SET goes out; its set() awaits an echo that will never come

      store.getState().clearForDisconnect()
      await tick()

      expect(transport.sent).toHaveLength(1) // only FIRST_PARAM was ever sent — loop stopped rather than moving to SECOND_PARAM
      expect(store.getState().pending.size).toBe(0)
      expect(store.getState().writeStatus.size).toBe(0)
      expect(store.getState().writing).toBe(false)

      // Even the timed-out echo eventually settling must not repopulate state for the stale generation.
      await tick(1500)
      expect(store.getState().pending.size).toBe(0)
      expect(store.getState().writeStatus.size).toBe(0)
    })
  })

  describe('independence between consumers', () => {
    it('two stores created from the factory never share state', () => {
      const setupLike = makeStagedStore()
      const tuningLike = makeStagedStore()
      setupLike.getState().stage('MOT_PWM_TYPE', 4, 'DShot150')
      expect(tuningLike.getState().pending.size).toBe(0)
      tuningLike.getState().clearForDisconnect()
      expect(setupLike.getState().pending.size).toBe(1)
    })
  })
})
