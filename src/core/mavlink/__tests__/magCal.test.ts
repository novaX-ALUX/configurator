import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockTransport } from '../../transport/mock'
import { defs } from '../defs'
import { decodePayload } from '../decode'
import { encodeFrame, FrameParser } from '../frame'
import { encodePayload } from '../encode'
import { MavRouter } from '../router'
import { ParamStore } from '../params'
import type { CommandAck } from '../command'
import type { MavSession } from '../session'
import {
  MagCalAcceptRejectedError,
  MagCalibration,
  MagCalUndoError,
  snapshotFromDiffs,
  type MagCalProgress,
  type MagCalReport,
} from '../magCal'

const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77
const PARAM_VALUE_MSGID = 22

const MAV_CMD_DO_START_MAG_CAL = 42424
const MAV_CMD_DO_ACCEPT_MAG_CAL = 42425
const MAV_CMD_DO_CANCEL_MAG_CAL = 42426
const MAV_CMD_SET_MESSAGE_INTERVAL = 511

const MAV_RESULT_ACCEPTED = 0
const MAV_RESULT_FAILED = 4

const MAV_PARAM_TYPE_REAL32 = 9

function frame(msgid: number, fields: Record<string, number | bigint | string>, seq = 0, sysid = 1, compid = 1): Uint8Array {
  return encodeFrame(defs, { msgid, payload: encodePayload(defs, msgid, fields) }, seq, sysid, compid)
}

function ackFrame(opts: { command: number; result: number; seq?: number }): Uint8Array {
  return frame(
    COMMAND_ACK_MSGID,
    { command: opts.command, result: opts.result, progress: 0, result_param2: 0 },
    opts.seq ?? 0,
  )
}

function paramValueFrame(opts: { name: string; value: number; type?: number; count?: number; index?: number; seq?: number }): Uint8Array {
  return frame(
    PARAM_VALUE_MSGID,
    {
      param_id: opts.name,
      param_value: opts.value,
      param_type: opts.type ?? MAV_PARAM_TYPE_REAL32,
      param_count: opts.count ?? 1,
      param_index: opts.index ?? 0,
    },
    opts.seq ?? 0,
  )
}

/** Decodes every COMMAND_LONG frame in `sent`, in order. */
function decodeCommandLongs(sent: Uint8Array[]): Array<Record<string, unknown>> {
  const parser = new FrameParser(defs)
  const out: Array<Record<string, unknown>> = []
  for (const bytes of sent) {
    const [f] = parser.push(bytes)
    if (f.msgid === COMMAND_LONG_MSGID) out.push(decodePayload(defs, f).fields)
  }
  return out
}

function routerSubscriberCount(router: MavRouter): number {
  return (router as unknown as { subscribers: Set<unknown> }).subscribers.size
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

const fixtureBytes = new Uint8Array(
  readFileSync(join(process.cwd(), 'src/core/mavlink/__tests__/fixtures/frames-m2.bin')),
)

describe('MagCalibration', () => {
  let transport: MockTransport
  let router: MavRouter
  const target = { sysid: 1, compid: 1 }
  let session: MavSession
  let paramStore: ParamStore

  beforeEach(async () => {
    vi.useFakeTimers()
    transport = new MockTransport()
    router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
    paramStore = new ParamStore(router, target)
    session = { router, target, paramStore, telemetry: {} as MavSession['telemetry'] }
  })

  afterEach(() => {
    paramStore.dispose()
    vi.useRealTimers()
  })

  describe('start()', () => {
    it('requests MAG_CAL_PROGRESS(191)+MAG_CAL_REPORT(192) intervals, sends DO_START_MAG_CAL with autosave=0, and fires onLearnDisclosure synchronously', async () => {
      const cal = new MagCalibration(session, paramStore)
      let disclosureCount = 0
      cal.onLearnDisclosure(() => {
        disclosureCount++
      })

      const promise = cal.start()
      // Fired synchronously, before any await inside start() -- see module doc.
      expect(disclosureCount).toBe(1)

      await flush()
      let cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({ command: MAV_CMD_SET_MESSAGE_INTERVAL, param1: 191, param2: 250000 })

      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(2)
      expect(cmds[1]).toMatchObject({ command: MAV_CMD_SET_MESSAGE_INTERVAL, param1: 192, param2: 250000 })

      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(3)
      expect(cmds[2]).toMatchObject({
        command: MAV_CMD_DO_START_MAG_CAL,
        param1: 0,
        param2: 0,
        param3: 0, // autosave OFF -- the review gate
        param4: 0,
        param5: 0, // autoreboot OFF
      })

      transport.feed(ackFrame({ command: MAV_CMD_DO_START_MAG_CAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
      cal.dispose()
    })

    it('rejects if DO_START_MAG_CAL is NACKed', async () => {
      const cal = new MagCalibration(session, paramStore)
      const promise = cal.start()
      const rejection = expect(promise).rejects.toThrow()

      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_DO_START_MAG_CAL, result: MAV_RESULT_FAILED }))
      await flush()

      await rejection
      cal.dispose()
    })
  })

  describe('inbound MAG_CAL_PROGRESS / MAG_CAL_REPORT', () => {
    it('feeding the committed frames-m2 fixture drives onProgress/onReport per compass_id, without touching ParamStore', async () => {
      // Seed a param the report would (eventually, only via accept()) change,
      // to prove onReport alone never writes it.
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_X', value: 7.5 }))
      await flush()

      const cal = new MagCalibration(session, paramStore)
      const progresses: MagCalProgress[] = []
      const reports: MagCalReport[] = []
      cal.onProgress((p) => progresses.push(p))
      cal.onReport((r) => reports.push(r))

      transport.feed(fixtureBytes)
      await flush()

      expect(progresses).toHaveLength(2)
      expect(progresses[0]).toMatchObject({
        compassId: 0,
        calMask: 3,
        calStatus: 3,
        attempt: 1,
        completionPct: 45,
        direction: { x: 0.5, y: 0.20000000298023224, z: -0.10000000149011612 },
      })
      expect(progresses[0].completionMask).toEqual([255, 255, 255, 255, 0, 0, 0, 0, 0, 0])
      expect(progresses[1]).toMatchObject({
        compassId: 1,
        completionPct: 45,
        direction: { x: 0.30000001192092896, y: 0.4000000059604645, z: -0.20000000298023224 },
      })

      expect(reports).toHaveLength(2)
      expect(reports[0]).toMatchObject({
        compassId: 0,
        calStatus: 4,
        autosaved: true,
        fitness: 1.25,
        ofsX: 15.199999809265137,
        ofsY: -8.699999809265137,
        ofsZ: 22.100000381469727,
        scaleFactor: 1.0,
        oldOrientation: 0,
        newOrientation: 0,
      })
      expect(reports[1]).toMatchObject({
        compassId: 1,
        ofsX: 10.100000381469727,
        ofsY: 5.400000095367432,
        ofsZ: -3.200000047683716,
      })

      // Fan-out: latest-per-compass maps.
      expect(cal.latestProgress.get(0)?.compassId).toBe(0)
      expect(cal.latestProgress.get(1)?.compassId).toBe(1)
      expect(cal.latestReport.get(0)?.compassId).toBe(0)
      expect(cal.latestReport.get(1)?.compassId).toBe(1)

      // The whole point of the review gate: a report arriving must not
      // change anything in ParamStore on its own.
      expect(paramStore.get('COMPASS_OFS_X')?.value).toBe(7.5)

      cal.dispose()
    })
  })

  describe('buildReview()', () => {
    it('returns COMPASS_OFS always, plus DIA/ODI/SCALE/ORIENT only when ParamStore already has them cached', async () => {
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_X', value: 1 }))
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_Y', value: 2 }))
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_Z', value: 3 }))
      transport.feed(paramValueFrame({ name: 'COMPASS_SCALE', value: 0.9 }))
      await flush()

      const cal = new MagCalibration(session, paramStore)
      let report: MagCalReport | undefined
      cal.onReport((r) => {
        report = r
      })
      transport.feed(fixtureBytes)
      await flush()
      expect(report).toBeDefined()
      const compass0Report = cal.latestReport.get(0)
      expect(compass0Report).toBeDefined()

      const diffs = await cal.buildReview(compass0Report!)
      const byParam = new Map(diffs.map((d) => [d.param, d]))

      expect(byParam.get('COMPASS_OFS_X')).toEqual({ param: 'COMPASS_OFS_X', current: 1, new: compass0Report!.ofsX })
      expect(byParam.get('COMPASS_OFS_Y')).toEqual({ param: 'COMPASS_OFS_Y', current: 2, new: compass0Report!.ofsY })
      expect(byParam.get('COMPASS_OFS_Z')).toEqual({ param: 'COMPASS_OFS_Z', current: 3, new: compass0Report!.ofsZ })
      expect(byParam.get('COMPASS_SCALE')).toEqual({
        param: 'COMPASS_SCALE',
        current: Math.fround(0.9), // wire round-trips through float32
        new: compass0Report!.scaleFactor,
      })

      // Never cached -> not disclosed as a diff row.
      expect(byParam.has('COMPASS_DIA_X')).toBe(false)
      expect(byParam.has('COMPASS_ODI_X')).toBe(false)
      expect(byParam.has('COMPASS_ORIENT')).toBe(false)

      const snapshot = snapshotFromDiffs(diffs)
      expect(snapshot).toEqual({ COMPASS_OFS_X: 1, COMPASS_OFS_Y: 2, COMPASS_OFS_Z: 3, COMPASS_SCALE: Math.fround(0.9) })

      cal.dispose()
    })

    it('uses the OFS2/DIA2/... suffix for compass_id 1', async () => {
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS2_X', value: 5 }))
      await flush()

      const cal = new MagCalibration(session, paramStore)
      transport.feed(fixtureBytes)
      await flush()
      const compass1Report = cal.latestReport.get(1)
      expect(compass1Report).toBeDefined()

      const diffs = await cal.buildReview(compass1Report!)
      const ofsXDiff = diffs.find((d) => d.param === 'COMPASS_OFS2_X')
      expect(ofsXDiff).toEqual({ param: 'COMPASS_OFS2_X', current: 5, new: compass1Report!.ofsX })

      cal.dispose()
    })
  })

  describe('accept()', () => {
    it('sends DO_ACCEPT_MAG_CAL, then confirms via ParamStore.fetchAll() -- never ParamStore.set()', async () => {
      const fetchAllSpy = vi.spyOn(paramStore, 'fetchAll').mockResolvedValue(undefined)
      const setSpy = vi.spyOn(paramStore, 'set')

      const cal = new MagCalibration(session, paramStore)
      const promise = cal.accept()
      await flush()

      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({ command: MAV_CMD_DO_ACCEPT_MAG_CAL, param1: 0 })
      expect(fetchAllSpy).not.toHaveBeenCalled()

      transport.feed(ackFrame({ command: MAV_CMD_DO_ACCEPT_MAG_CAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise

      expect(fetchAllSpy).toHaveBeenCalledTimes(1)
      expect(setSpy).not.toHaveBeenCalled()

      cal.dispose()
    })

    it('rejects (without calling fetchAll) if the ACK is not accepted', async () => {
      const fetchAllSpy = vi.spyOn(paramStore, 'fetchAll').mockResolvedValue(undefined)
      const cal = new MagCalibration(session, paramStore)
      const promise = cal.accept()
      const rejection = expect(promise).rejects.toThrow()

      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_DO_ACCEPT_MAG_CAL, result: MAV_RESULT_FAILED }))
      await flush()

      await rejection
      expect(fetchAllSpy).not.toHaveBeenCalled()
      cal.dispose()
    })

    it('rejects with the typed MagCalAcceptRejectedError (not a plain Error) when the ACK is not accepted -- classifyAcceptFailure keys off this type, not the message string', async () => {
      const cal = new MagCalibration(session, paramStore)
      const promise = cal.accept()
      const rejection = promise.catch((err: unknown) => {
        expect(err).toBeInstanceOf(MagCalAcceptRejectedError)
        expect((err as MagCalAcceptRejectedError).result).toBe(MAV_RESULT_FAILED)
      })

      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_DO_ACCEPT_MAG_CAL, result: MAV_RESULT_FAILED }))
      await flush()

      await rejection
      cal.dispose()
    })
  })

  describe('undo()', () => {
    it('re-writes the pre-accept snapshot via ParamStore.set', async () => {
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_X', value: 99 }))
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_Y', value: 98 }))
      await flush()

      const cal = new MagCalibration(session, paramStore)
      const undoPromise = cal.undo({ COMPASS_OFS_X: 1, COMPASS_OFS_Y: 2 })
      await flush()

      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_X', value: 1 }))
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_Y', value: 2 }))
      await flush()

      await undoPromise
      expect(paramStore.get('COMPASS_OFS_X')?.value).toBe(1)
      expect(paramStore.get('COMPASS_OFS_Y')?.value).toBe(2)
      cal.dispose()
    })

    it('skips entries with an undefined current (nothing known-good to restore)', async () => {
      const cal = new MagCalibration(session, paramStore)
      const setSpy = vi.spyOn(paramStore, 'set')
      await cal.undo({ COMPASS_OFS_X: undefined })
      expect(setSpy).not.toHaveBeenCalled()
      cal.dispose()
    })

    it('throws MagCalUndoError listing the params that failed to restore, on a write mismatch', async () => {
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_X', value: 99 }))
      await flush()

      const cal = new MagCalibration(session, paramStore)
      const undoPromise = cal.undo({ COMPASS_OFS_X: 1 })
      // Attached before the mismatch echo arrives, so the rejection is
      // never briefly unhandled.
      const rejection = expect(undoPromise).rejects.toBeInstanceOf(MagCalUndoError)
      await flush()
      // FC echoes back a different value than requested -> ParamWriteMismatchError.
      transport.feed(paramValueFrame({ name: 'COMPASS_OFS_X', value: 42 }))
      await flush()
      await rejection

      await undoPromise.catch((err: unknown) => {
        expect(err).toBeInstanceOf(MagCalUndoError)
        expect((err as MagCalUndoError).failed).toHaveLength(1)
        expect((err as MagCalUndoError).failed[0].param).toBe('COMPASS_OFS_X')
      })
      cal.dispose()
    })
  })

  describe('cancel()', () => {
    it('sends DO_CANCEL_MAG_CAL', async () => {
      const cal = new MagCalibration(session, paramStore)
      const promise = cal.cancel()
      await flush()

      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({ command: MAV_CMD_DO_CANCEL_MAG_CAL, param1: 0 })

      transport.feed(ackFrame({ command: MAV_CMD_DO_CANCEL_MAG_CAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise
      cal.dispose()
    })

    it('rejects if NACKed', async () => {
      const cal = new MagCalibration(session, paramStore)
      const promise = cal.cancel()
      const rejection = expect(promise).rejects.toThrow()
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_DO_CANCEL_MAG_CAL, result: MAV_RESULT_FAILED }))
      await flush()
      await rejection
      cal.dispose()
    })
  })

  describe('stopStreams()', () => {
    it('sets both message intervals to -1', async () => {
      const cal = new MagCalibration(session, paramStore)
      const promise = cal.stopStreams()
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_ACCEPTED }))
      await flush()
      await promise

      const cmds = decodeCommandLongs(transport.sent)
      expect(cmds).toHaveLength(2)
      expect(cmds[0]).toMatchObject({ command: MAV_CMD_SET_MESSAGE_INTERVAL, param1: 191, param2: -1 })
      expect(cmds[1]).toMatchObject({ command: MAV_CMD_SET_MESSAGE_INTERVAL, param1: 192, param2: -1 })
      cal.dispose()
    })

    it('is best-effort: a NACKed interval request does not reject', async () => {
      const cal = new MagCalibration(session, paramStore)
      const promise = cal.stopStreams()
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_FAILED }))
      await flush()
      transport.feed(ackFrame({ command: MAV_CMD_SET_MESSAGE_INTERVAL, result: MAV_RESULT_FAILED }))
      await flush()
      await expect(promise).resolves.toBeUndefined()
      cal.dispose()
    })
  })

  describe('dispose()', () => {
    it('unsubscribes both MAG_CAL_PROGRESS and MAG_CAL_REPORT subscriptions', () => {
      const before = routerSubscriberCount(router)
      const cal = new MagCalibration(session, paramStore)
      expect(routerSubscriberCount(router)).toBe(before + 2)
      cal.dispose()
      expect(routerSubscriberCount(router)).toBe(before)
    })
  })
})

// Keep `sendCommandFn` injection ability sanity-checked, mirroring accelCal.test.ts.
describe('MagCalibration with injected sendCommandFn', () => {
  it('routes start()/accept()/cancel() through the injected sendCommandFn', async () => {
    vi.useFakeTimers()
    const transport = new MockTransport()
    const router = new MavRouter(transport, defs, {})
    await transport.open()
    router.start()
    const target = { sysid: 1, compid: 1 }
    const paramStore = new ParamStore(router, target)
    vi.spyOn(paramStore, 'fetchAll').mockResolvedValue(undefined)
    const session: MavSession = { router, target, paramStore, telemetry: {} as MavSession['telemetry'] }

    const sendCommandFn = vi.fn(
      async (_router, _target, cmd): Promise<CommandAck> => ({ command: cmd.command, result: MAV_RESULT_ACCEPTED, progress: 0, resultParam2: 0 }),
    )
    const cal = new MagCalibration(session, paramStore, { sendCommandFn })

    await cal.start()
    expect(sendCommandFn).toHaveBeenCalledWith(
      router,
      target,
      expect.objectContaining({ command: MAV_CMD_DO_START_MAG_CAL, param3: 0 }),
      { timeoutMs: undefined },
    )

    await cal.accept()
    expect(sendCommandFn).toHaveBeenLastCalledWith(router, target, { command: MAV_CMD_DO_ACCEPT_MAG_CAL, param1: 0 }, { timeoutMs: undefined })

    await cal.cancel()
    expect(sendCommandFn).toHaveBeenLastCalledWith(router, target, { command: MAV_CMD_DO_CANCEL_MAG_CAL, param1: 0 }, { timeoutMs: undefined })

    cal.dispose()
    paramStore.dispose()
    vi.useRealTimers()
  })
})
