import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { encodeFrame } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { MavRouter } from '../../../core/mavlink/router'
import { ParamStore } from '../../../core/mavlink/params'
import { useSetupStore } from '../setupStore'

const MAV_PARAM_TYPE_REAL32 = 9

const initialState = useSetupStore.getState()

afterEach(() => {
  useSetupStore.setState(initialState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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

/** Real ParamStore backed by a MockTransport+MavRouter — same "test the real protocol state machine" style as ParamsPage.test.tsx, rather than a fake ParamStore. */
async function makeConnectedParamStore(opts?: ConstructorParameters<typeof ParamStore>[2]): Promise<{ transport: MockTransport; paramStore: ParamStore }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const paramStore = new ParamStore(router, { sysid: 1, compid: 1 }, opts)
  return { transport, paramStore }
}

async function feedAll(transport: MockTransport, entries: Array<{ name: string; value: number; type?: number }>): Promise<void> {
  entries.forEach((e, index) => {
    transport.feed(paramValueFrame({ name: e.name, value: e.value, type: e.type, count: entries.length, index }))
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

describe('useSetupStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  describe('stage / dedupe', () => {
    it('stages a param, dedupes on re-stage (latest wins, no duplicate entries)', () => {
      useSetupStore.getState().stage('MOT_PWM_TYPE', 4, 'DShot150')
      expect(useSetupStore.getState().pending.get('MOT_PWM_TYPE')).toEqual({ value: 4, label: 'DShot150' })
      expect(useSetupStore.getState().pending.size).toBe(1)

      useSetupStore.getState().stage('MOT_PWM_TYPE', 5, 'DShot300')
      expect(useSetupStore.getState().pending.size).toBe(1)
      expect(useSetupStore.getState().pending.get('MOT_PWM_TYPE')).toEqual({ value: 5, label: 'DShot300' })
    })

    it('clears any existing write status when a param is re-staged', () => {
      useSetupStore.setState({ writeStatus: new Map([['BATT_CAPACITY', { kind: 'timeout' }]]) })
      useSetupStore.getState().stage('BATT_CAPACITY', 5200, '5200 mAh')
      expect(useSetupStore.getState().writeStatus.has('BATT_CAPACITY')).toBe(false)
    })

    it('discard removes exactly one param from pending and writeStatus', () => {
      useSetupStore.getState().stage('BATT_CAPACITY', 5200, '5200 mAh')
      useSetupStore.getState().stage('BATT_LOW_VOLT', 14, '14 V')
      useSetupStore.getState().discard('BATT_CAPACITY')
      expect(useSetupStore.getState().pending.has('BATT_CAPACITY')).toBe(false)
      expect(useSetupStore.getState().pending.has('BATT_LOW_VOLT')).toBe(true)
    })
  })

  describe('stageFrame', () => {
    it('stages BOTH FRAME_CLASS and FRAME_TYPE from a single tile pick', () => {
      useSetupStore.getState().stageFrame(1, 1, 'Quad X')
      const pending = useSetupStore.getState().pending
      expect(pending.get('FRAME_CLASS')).toEqual({ value: 1, label: 'Quad X' })
      expect(pending.get('FRAME_TYPE')).toEqual({ value: 1, label: 'Quad X' })
      expect(pending.size).toBe(2)
    })

    it('picking a different tile later replaces both params (dedupe still applies)', () => {
      useSetupStore.getState().stageFrame(1, 1, 'Quad X')
      useSetupStore.getState().stageFrame(2, 1, 'Hex X')
      const pending = useSetupStore.getState().pending
      expect(pending.size).toBe(2)
      expect(pending.get('FRAME_CLASS')).toEqual({ value: 2, label: 'Hex X' })
      expect(pending.get('FRAME_TYPE')).toEqual({ value: 1, label: 'Hex X' })
    })
  })

  describe('stageDroneCanEnable (issue #55)', () => {
    it('stages exactly the three CAN enable params with the frame-derived bitmask — MOT_PWM_TYPE untouched', () => {
      useSetupStore.getState().stageDroneCanEnable(4, 'DroneCAN')
      const pending = useSetupStore.getState().pending
      expect(pending.size).toBe(3)
      expect(pending.get('CAN_P1_DRIVER')).toEqual({ value: 1, label: 'DroneCAN' })
      expect(pending.get('CAN_D1_PROTOCOL')).toEqual({ value: 1, label: 'DroneCAN' })
      expect(pending.get('CAN_D1_UC_ESC_BM')).toEqual({ value: 15, label: 'DroneCAN' })
      expect(pending.has('MOT_PWM_TYPE')).toBe(false)
    })

    it('re-selecting after a frame change replaces the chain (dedupe: still 3 entries, Hexa bitmask)', () => {
      useSetupStore.getState().stageDroneCanEnable(4, 'DroneCAN')
      useSetupStore.getState().stageDroneCanEnable(6, 'DroneCAN')
      const pending = useSetupStore.getState().pending
      expect(pending.size).toBe(3)
      expect(pending.get('CAN_D1_UC_ESC_BM')).toEqual({ value: 63, label: 'DroneCAN' })
    })

    it('sets frameEscTouched (the guide\'s frame/ESC step), not fsTouched', () => {
      useSetupStore.getState().stageDroneCanEnable(4, 'DroneCAN')
      expect(useSetupStore.getState().frameEscTouched).toBe(true)
      expect(useSetupStore.getState().fsTouched).toBe(false)
    })

    it('staging a single CAN enable param through generic stage() also sets frameEscTouched', () => {
      useSetupStore.getState().stage('CAN_D1_UC_ESC_BM', 0, 'CAN ESC output off')
      expect(useSetupStore.getState().frameEscTouched).toBe(true)
    })

    it('updates all three params and the touched flag in ONE state update (issue #33 atomicity rule)', () => {
      const snapshots: Array<{ pendingSize: number; frameEscTouched: boolean }> = []
      const unsub = useSetupStore.subscribe((s) => snapshots.push({ pendingSize: s.pending.size, frameEscTouched: s.frameEscTouched }))
      useSetupStore.getState().stageDroneCanEnable(4, 'DroneCAN')
      unsub()
      expect(snapshots).toEqual([{ pendingSize: 3, frameEscTouched: true }])
    })

    it('revertAll discards the staged chain like any other Staged Change', () => {
      useSetupStore.getState().stageDroneCanEnable(4, 'DroneCAN')
      useSetupStore.getState().revertAll()
      expect(useSetupStore.getState().pending.size).toBe(0)
    })

    it('Apply writes the three params one at a time, each PARAM_SET only after the previous readback verified', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, [
        { name: 'CAN_P1_DRIVER', value: 0 },
        { name: 'CAN_D1_PROTOCOL', value: 1 },
        { name: 'CAN_D1_UC_ESC_BM', value: 0 },
      ])
      useSetupStore.getState().stageDroneCanEnable(4, 'DroneCAN')
      void useSetupStore.getState().writeAll(paramStore)

      await tick() // CAN_P1_DRIVER's PARAM_SET goes out; the next two wait on its readback
      expect(transport.sent).toHaveLength(1)
      expect(useSetupStore.getState().writeStatus.get('CAN_P1_DRIVER')?.kind).toBe('writing')

      transport.feed(paramValueFrame({ name: 'CAN_P1_DRIVER', value: 1, count: 3, index: 0 }))
      await tick()
      expect(transport.sent).toHaveLength(2)
      expect(useSetupStore.getState().writeStatus.get('CAN_P1_DRIVER')?.kind).toBe('ok')

      transport.feed(paramValueFrame({ name: 'CAN_D1_PROTOCOL', value: 1, count: 3, index: 1 }))
      await tick()
      expect(transport.sent).toHaveLength(3)

      transport.feed(paramValueFrame({ name: 'CAN_D1_UC_ESC_BM', value: 15, count: 3, index: 2 }))
      await tick()
      expect(useSetupStore.getState().writeStatus.get('CAN_D1_UC_ESC_BM')?.kind).toBe('ok')

      await tick(2000) // transient 'ok' display window elapses
      expect(useSetupStore.getState().pending.size).toBe(0)
      expect(useSetupStore.getState().writing).toBe(false)
    })
  })

  describe('touched flags', () => {
    it('staging a frame/ESC param sets frameEscTouched, not fsTouched', () => {
      useSetupStore.getState().stage('MOT_PWM_TYPE', 4, 'DShot150')
      expect(useSetupStore.getState().frameEscTouched).toBe(true)
      expect(useSetupStore.getState().fsTouched).toBe(false)
    })

    it('stageFrame sets frameEscTouched', () => {
      useSetupStore.getState().stageFrame(1, 1, 'Quad X')
      expect(useSetupStore.getState().frameEscTouched).toBe(true)
    })

    it('staging a failsafe param sets fsTouched, not frameEscTouched', () => {
      useSetupStore.getState().stage('FS_THR_ENABLE', 1, 'Always RTL')
      expect(useSetupStore.getState().fsTouched).toBe(true)
      expect(useSetupStore.getState().frameEscTouched).toBe(false)
    })

    it('staging BATT_FS_LOW_ACT also sets fsTouched', () => {
      useSetupStore.getState().stage('BATT_FS_LOW_ACT', 2, 'RTL')
      expect(useSetupStore.getState().fsTouched).toBe(true)
    })

    it('staging an unrelated param (battery monitor/capacity) sets neither flag', () => {
      useSetupStore.getState().stage('BATT_MONITOR', 4, 'Analog Voltage & Current')
      useSetupStore.getState().stage('BATT_CAPACITY', 5200, '5200 mAh')
      expect(useSetupStore.getState().fsTouched).toBe(false)
      expect(useSetupStore.getState().frameEscTouched).toBe(false)
    })

    it('touched flags survive revertAll and clearForDisconnect (they track "reviewed", not "currently pending")', () => {
      useSetupStore.getState().stage('FS_THR_ENABLE', 1, 'Always RTL')
      useSetupStore.getState().revertAll()
      expect(useSetupStore.getState().fsTouched).toBe(true)
      useSetupStore.getState().clearForDisconnect()
      expect(useSetupStore.getState().fsTouched).toBe(true)
    })
  })

  describe('atomicity (issue #33 review finding)', () => {
    it('stage updates pending and touched flags in ONE state update — no intermediate notification', () => {
      const snapshots: Array<{ pendingSize: number; fsTouched: boolean }> = []
      const unsub = useSetupStore.subscribe((s) => snapshots.push({ pendingSize: s.pending.size, fsTouched: s.fsTouched }))
      useSetupStore.getState().stage('FS_THR_ENABLE', 1, 'Always RTL')
      unsub()
      expect(snapshots).toEqual([{ pendingSize: 1, fsTouched: true }])
    })

    it('stageFrame updates both params and frameEscTouched in ONE state update', () => {
      const snapshots: Array<{ pendingSize: number; frameEscTouched: boolean }> = []
      const unsub = useSetupStore.subscribe((s) => snapshots.push({ pendingSize: s.pending.size, frameEscTouched: s.frameEscTouched }))
      useSetupStore.getState().stageFrame(1, 1, 'Quad X')
      unsub()
      expect(snapshots).toEqual([{ pendingSize: 2, frameEscTouched: true }])
    })
  })

  describe('revertAll', () => {
    it('clears every pending edit and write status', () => {
      useSetupStore.getState().stage('BATT_CAPACITY', 5200, '5200 mAh')
      useSetupStore.setState({ writeStatus: new Map([['BATT_CAPACITY', { kind: 'timeout' }]]) })
      useSetupStore.getState().revertAll()
      expect(useSetupStore.getState().pending.size).toBe(0)
      expect(useSetupStore.getState().writeStatus.size).toBe(0)
    })
  })

  describe('writeAll', () => {
    async function renderPending(entries: Array<{ name: string; value: number }>) {
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(
        transport,
        entries.map((e) => ({ name: e.name, value: 0 })),
      )
      for (const e of entries) useSetupStore.getState().stage(e.name, e.value, String(e.value))
      return { transport, paramStore }
    }

    it('a successful write shows a transient ok status, then clears the param from pending', async () => {
      const { transport, paramStore } = await renderPending([{ name: 'BATT_CAPACITY', value: 5200 }])
      void useSetupStore.getState().writeAll(paramStore)
      await tick() // BATT_CAPACITY's PARAM_SET goes out
      expect(useSetupStore.getState().writeStatus.get('BATT_CAPACITY')?.kind).toBe('writing')

      transport.feed(paramValueFrame({ name: 'BATT_CAPACITY', value: 5200, count: 1, index: 0 }))
      await tick()
      expect(useSetupStore.getState().writeStatus.get('BATT_CAPACITY')?.kind).toBe('ok')
      expect(useSetupStore.getState().pending.has('BATT_CAPACITY')).toBe(true) // still there until the display window elapses

      await tick(2000)
      expect(useSetupStore.getState().pending.has('BATT_CAPACITY')).toBe(false)
      expect(useSetupStore.getState().writeStatus.has('BATT_CAPACITY')).toBe(false)
      expect(useSetupStore.getState().writing).toBe(false)
    })

    it('write flow with mixed results: ok clears, mismatch/timeout stay marked in pending+writeStatus', async () => {
      const { transport, paramStore } = await renderPending([
        { name: 'OK_PARAM', value: 1 },
        { name: 'MISMATCH_PARAM', value: 2000 },
        { name: 'TIMEOUT_PARAM', value: 5 },
      ])

      void useSetupStore.getState().writeAll(paramStore)
      await tick() // OK_PARAM's PARAM_SET goes out
      transport.feed(paramValueFrame({ name: 'OK_PARAM', value: 1, count: 3, index: 0 }))
      await tick() // OK_PARAM echoes ok; MISMATCH_PARAM's PARAM_SET goes out

      transport.feed(paramValueFrame({ name: 'MISMATCH_PARAM', value: 999, count: 3, index: 1 })) // FC clamped
      await tick() // mismatch resolves; TIMEOUT_PARAM's PARAM_SET goes out

      await tick(1500) // default setTimeoutMs elapses with no echo for TIMEOUT_PARAM
      await tick(2000) // OK_PARAM's transient 'ok' display window elapses -> it clears

      expect(useSetupStore.getState().pending.has('OK_PARAM')).toBe(false)
      expect(useSetupStore.getState().pending.get('MISMATCH_PARAM')).toEqual({ value: 2000, label: '2000' })
      expect(useSetupStore.getState().pending.get('TIMEOUT_PARAM')).toEqual({ value: 5, label: '5' })
      expect(useSetupStore.getState().writeStatus.get('MISMATCH_PARAM')).toEqual({ kind: 'mismatch', requested: 2000, actual: 999 })
      expect(useSetupStore.getState().writeStatus.get('TIMEOUT_PARAM')).toEqual({ kind: 'timeout' })
      expect(useSetupStore.getState().writing).toBe(false)
    })

    it('does not silently drop a fresh re-stage that lands during a prior success\'s "ok" display window', async () => {
      const { transport, paramStore } = await renderPending([{ name: 'BATT_CAPACITY', value: 5200 }])
      void useSetupStore.getState().writeAll(paramStore)
      await tick()
      transport.feed(paramValueFrame({ name: 'BATT_CAPACITY', value: 5200, count: 1, index: 0 }))
      await tick() // shows transient 'ok', clear scheduled 2s out

      useSetupStore.getState().stage('BATT_CAPACITY', 6000, '6000 mAh') // user re-edits before the clear fires
      await tick(2000) // the earlier write's scheduled clear fires now

      expect(useSetupStore.getState().pending.get('BATT_CAPACITY')).toEqual({ value: 6000, label: '6000 mAh' })
    })

    it('a disconnect mid-batch (clearForDisconnect) stops the loop instead of resurrecting cleared state', async () => {
      const { transport, paramStore } = await renderPending([
        { name: 'FIRST_PARAM', value: 1 },
        { name: 'SECOND_PARAM', value: 2 },
      ])

      void useSetupStore.getState().writeAll(paramStore)
      await tick() // FIRST_PARAM's PARAM_SET goes out; its set() awaits an echo that will never come

      useSetupStore.getState().clearForDisconnect()
      await tick()

      expect(transport.sent).toHaveLength(1) // only FIRST_PARAM was ever sent — loop stopped rather than moving to SECOND_PARAM
      expect(useSetupStore.getState().pending.size).toBe(0)
      expect(useSetupStore.getState().writeStatus.size).toBe(0)
      expect(useSetupStore.getState().writing).toBe(false)

      // Even the timed-out echo eventually settling must not repopulate state for the stale generation.
      await tick(1500)
      expect(useSetupStore.getState().pending.size).toBe(0)
      expect(useSetupStore.getState().writeStatus.size).toBe(0)
    })
  })
})
