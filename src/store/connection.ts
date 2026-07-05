/**
 * Global connection store: owns the transport/router/ParamStore/Telemetry
 * lifecycle for exactly one MAVLink session at a time, plus the state Task
 * 3.1's UI (TopBar, StatusPanel) reads.
 *
 * ARCHITECTURAL FACT (Task 2.3, `router.ts`'s own module doc): `MavRouter` is
 * single-shot per transport-open generation — it is never reused across a
 * disconnect/reconnect cycle. This store follows that contract literally:
 * `connect()` builds a brand new `Transport` + `MavRouter` + `ParamStore` +
 * `Telemetry` every time, and teardown (`disconnect()` or an unplug) disposes
 * the `Telemetry` and `ParamStore`, drops the `MavRouter` reference, and
 * closes the `Transport` — nothing is kept around for the next `connect()` to
 * reuse. `session` (Task 5.4, `core/mavlink/session.ts`) bundles all four
 * (`router`/`target`/`paramStore`/`telemetry`) for M2's feature modules and
 * follows the exact same lifecycle — non-null only while connected, rebuilt
 * fresh every generation.
 *
 * Testability: `navigator.serial` doesn't exist in jsdom, so the actual
 * `requestPort()` call is isolated behind an injectable `PortPicker`
 * (`createConnectionStore(pickPort)`). Tests inject a fake picker that hands
 * back a `MockTransport`; the app's singleton (`useConnectionStore`) uses the
 * real `defaultPickPort` below.
 */
import { create } from 'zustand'
import type { Transport } from '../core/transport/types'
import { SerialTransport } from '../core/transport/serial'
import { defs } from '../core/mavlink/defs'
import { MavRouter, type MavRouterStats } from '../core/mavlink/router'
import { ParamStore } from '../core/mavlink/params'
import { Telemetry, type TelemetryMsg } from '../core/mavlink/telemetry'
import type { MavSession } from '../core/mavlink/session'
import { sendCommand } from '../core/mavlink/command'

const NOVAX_USB_VENDOR_ID = 0x1209
const DEFAULT_BAUD = 115200
const STATUSTEXT_MSGID = 253
const AUTOPILOT_VERSION_MSGID = 148
const MAV_CMD_REQUEST_MESSAGE = 512
/** Ring-buffer cap for `statustext` (task brief: "~500 entries"). No virtual scrolling in M1 — the cap IS the memory bound. */
const STATUSTEXT_CAP = 500
/** `linkStats` is a periodic snapshot of `router.stats`, not push-updated per frame — 1Hz is plenty for a debug readout and decouples UI re-renders from telemetry rate. */
const LINK_STATS_INTERVAL_MS = 1000

/**
 * Per-message `requestStreams()` rates (Hz), requested once the link
 * reaches 'connected'. ATTITUDE is fast enough for a smooth attitude
 * readout (10Hz); SYS_STATUS/GPS_RAW_INT are slow since battery level and
 * GPS fix don't change quickly (2Hz each); RC_CHANNELS/SERVO_OUTPUT_RAW are
 * fast enough to see stick/output movement without flooding the link
 * (5Hz each). `Telemetry.requestStreams()`'s own default (10Hz) would apply
 * to any message left out of this map — nothing is, here, but it's a
 * `Partial` so that stays true if a message is ever added upstream without
 * this map being updated to match.
 */
const TELEMETRY_STREAM_RATES_HZ: Partial<Record<TelemetryMsg, number>> = {
  ATTITUDE: 10,
  SYS_STATUS: 2,
  GPS_RAW_INT: 2,
  RC_CHANNELS: 5,
  SERVO_OUTPUT_RAW: 5,
}

export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'lost'

export interface StatusTextEntry {
  /** MAV_SEVERITY (0 EMERGENCY .. 7 DEBUG). */
  severity: number
  text: string
  ts: number
}

/**
 * `boardId`/`fwVersion` come from AUTOPILOT_VERSION (msgid 148) — a board
 * that never answers that request (or answers with zeroed fields) simply
 * leaves these `undefined`; nothing in the app gates on them (decisions-m1:
 * board_id from AUTOPILOT_VERSION is display-only). `vehicleName` is a
 * friendly name resolved via the firmware manifest module by `apjBoardId`
 * once a manifest is loaded (Task 3.3+) — this store never fetches a
 * manifest itself, so it stays `undefined` for now and callers fall back to
 * showing the numeric `boardId`.
 */
export interface ConnectionIdentity {
  boardId?: number
  fwVersion?: string
  vehicleName?: string
}

export interface ConnectionPortInfo {
  usbVendorId?: number
  usbProductId?: number
}

export interface PickedPort {
  transport: Transport
  portInfo: ConnectionPortInfo
}

/**
 * Isolates the one Web-Serial-specific, real-hardware-only call
 * (`navigator.serial.requestPort`) behind an injectable seam — mirrors how
 * `SerialTransport` itself never calls `requestPort()` (see that file's own
 * doc). Returns `null` if the user dismissed the native picker (not an
 * error); rejects for anything else (e.g. Web Serial unsupported).
 */
export type PortPicker = (opts: { anyDevice: boolean; baud: number }) => Promise<PickedPort | null>

async function defaultPickPort(opts: { anyDevice: boolean; baud: number }): Promise<PickedPort | null> {
  if (!navigator.serial) {
    throw new Error('Web Serial is not available in this browser')
  }
  let port: SerialPort
  try {
    port = await navigator.serial.requestPort(
      opts.anyDevice ? {} : { filters: [{ usbVendorId: NOVAX_USB_VENDOR_ID }] },
    )
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return null // user dismissed the native picker — not a failure worth surfacing
    }
    throw err
  }
  return { transport: new SerialTransport(port, opts.baud), portInfo: port.getInfo() }
}

/** ArduPilot's FIRMWARE_VERSION_TYPE (low byte of flight_sw_version); anything else is left unlabeled. */
const FIRMWARE_VERSION_TYPE_SUFFIX: Record<number, string> = {
  0: 'dev',
  64: 'alpha',
  128: 'beta',
  192: 'rc',
}

/** `flight_sw_version` is packed major<<24 | minor<<16 | patch<<8 | type. `0` means "not populated" — returns `undefined` rather than the misleading "0.0.0". */
function decodeFlightSwVersion(raw: number): string | undefined {
  if (raw === 0) return undefined
  const major = (raw >>> 24) & 0xff
  const minor = (raw >>> 16) & 0xff
  const patch = (raw >>> 8) & 0xff
  const versionType = raw & 0xff
  const suffix = FIRMWARE_VERSION_TYPE_SUFFIX[versionType]
  const base = `${major}.${minor}.${patch}`
  return suffix ? `${base}-${suffix}` : base
}

export interface ConnectionState {
  phase: ConnectionPhase
  portInfo: ConnectionPortInfo | null
  baud: number
  identity: ConnectionIdentity | null
  statustext: StatusTextEntry[]
  linkStats: MavRouterStats | null
  /** Set on any transition into 'disconnected' that followed a real connect attempt (not the app's initial idle state) — drives the disconnect toast. `null` again once a new `connect()` starts. */
  lastDisconnectReason: string | null
  /** Built once the link reaches 'connected' for the first time this generation; `null` before that and after teardown. Task 3.2 (parameter table) consumes this. */
  paramStore: ParamStore | null
  /**
   * Bundles `router`/`target`/`paramStore`/`telemetry` for M2's feature
   * modules (calibration, motor test, dashboard) so they don't each reach
   * into the store's internals separately. Built alongside `paramStore` once
   * the link reaches 'connected' for the first time this generation; `null`
   * before that and after teardown. `session.paramStore` is always the same
   * instance as this state's own `paramStore` (Task 5.4).
   */
  session: MavSession | null

  setBaud: (baud: number) => void
  connect: (baud: number, opts?: { anyDevice?: boolean }) => Promise<void>
  disconnect: () => Promise<void>
  clearStatustext: () => void
  /**
   * Hands off the live transport for a firmware flash (Task 3.4's flash
   * session): runs the same teardown as `disconnect()` (unsubscribes
   * telemetry, stops the stats timer, disposes `paramStore`, resets state to
   * 'disconnected') but does NOT close the transport and does NOT set
   * `lastDisconnectReason` — this is a deliberate handoff, not a disconnect.
   * Ownership of the returned `Transport` passes to the caller, which sends
   * the MAVLink reboot-to-bootloader command and closes it itself. Returns
   * `null` if not currently connected (nothing to hand off) — the flash
   * session's "reboot to bootloader" step surfaces that as its own failure.
   */
  takeoverForFlash: () => Transport | null
}

/**
 * Factory so tests can inject a fake `PortPicker` (`navigator.serial` doesn't
 * exist in jsdom) and get a store instance fully isolated from the app's
 * singleton. `useConnectionStore` below is just `createConnectionStore()`
 * with the real picker.
 */
export function createConnectionStore(pickPort: PortPicker = defaultPickPort) {
  return create<ConnectionState>((set, get) => {
    // Per-generation session state, never reused across a disconnect/reconnect
    // cycle (see module doc's architectural fact) — deliberately kept outside
    // the reactive `ConnectionState` for the transport itself (`paramStore`
    // and the `session` bundle built around it, Task 5.4, are exposed there).
    let transportRef: Transport | undefined
    let cleanupFns: Array<() => void> = []
    let statsTimer: ReturnType<typeof setInterval> | undefined
    let paramStoreRef: ParamStore | undefined
    let telemetryRef: Telemetry | undefined
    let identityRequested = false
    // Captured so `takeoverForFlash()` can unsubscribe `teardown` from the
    // transport being handed off — without this, the flash session's own
    // later `transport.close()` (after sending the reboot-to-bootloader
    // command) would still fire the store's `teardown`, re-running it a
    // second time against state this method has already reset.
    let unsubTransportDisconnect: (() => void) | undefined

    /**
     * Shared reset step for both `teardown()` (a genuine disconnect) and
     * `takeoverForFlash()` (a deliberate handoff) — clears all per-generation
     * bookkeeping and resets the reactive state identically either way.
     * `reason` is only set as `lastDisconnectReason` when given: a flash
     * handoff must never be reported as a disconnect (see
     * `takeoverForFlash()`'s own doc), so it omits `reason` entirely rather
     * than passing e.g. an empty string.
     */
    function resetSession(reason?: string): void {
      for (const fn of cleanupFns) fn()
      cleanupFns = []
      if (statsTimer !== undefined) {
        clearInterval(statsTimer)
        statsTimer = undefined
      }
      telemetryRef?.dispose()
      telemetryRef = undefined
      paramStoreRef?.dispose()
      paramStoreRef = undefined
      transportRef = undefined
      identityRequested = false
      set({
        phase: 'disconnected',
        identity: null,
        portInfo: null,
        linkStats: null,
        paramStore: null,
        session: null,
        ...(reason !== undefined ? { lastDisconnectReason: reason } : {}),
      })
    }

    /** Single teardown path for both `disconnect()` (via `transport.close()`) and an unplug — both funnel through `Transport.onDisconnect`, fired exactly once per open/close cycle. */
    function teardown(reason: string): void {
      resetSession(reason)
    }

    return {
      phase: 'disconnected',
      portInfo: null,
      baud: DEFAULT_BAUD,
      identity: null,
      statustext: [],
      linkStats: null,
      lastDisconnectReason: null,
      paramStore: null,
      session: null,

      setBaud(baud) {
        set({ baud })
      },

      async connect(baud, opts = {}) {
        if (get().phase !== 'disconnected') return // already connecting/connected/lost — Disconnect first

        set({ phase: 'connecting', baud, lastDisconnectReason: null })

        let picked: PickedPort | null
        try {
          picked = await pickPort({ anyDevice: opts.anyDevice ?? false, baud })
        } catch (err) {
          set({ phase: 'disconnected', lastDisconnectReason: err instanceof Error ? err.message : String(err) })
          return
        }
        if (!picked) {
          set({ phase: 'disconnected' }) // user dismissed the picker — not an error, nothing to report
          return
        }

        const { transport, portInfo } = picked
        try {
          await transport.open()
        } catch (err) {
          set({ phase: 'disconnected', lastDisconnectReason: err instanceof Error ? err.message : String(err) })
          return
        }

        transportRef = transport
        identityRequested = false
        const router = new MavRouter(transport, defs)

        // Registered once per generation, right after a successful open() —
        // fires for a caller-initiated close() (disconnect() below) and for
        // a physical unplug alike, exactly once (Transport's own contract).
        unsubTransportDisconnect = transport.onDisconnect(teardown)

        const unsubLinkState = router.onLinkState((linkState) => {
          if (linkState === 'idle') return // transport.onDisconnect's teardown() owns the disconnected transition
          set({ phase: linkState })

          if (linkState === 'connected' && !identityRequested) {
            identityRequested = true
            const [target] = router.getComponents().values()
            if (target) {
              const targetIds = { sysid: target.sysid, compid: target.compid }
              const store = new ParamStore(router, targetIds)
              paramStoreRef = store
              const telemetry = new Telemetry(router, targetIds)
              telemetryRef = telemetry
              set({
                paramStore: store,
                session: { router, target: targetIds, paramStore: store, telemetry },
              })
              // Fire-and-forget, same error tolerance as the AUTOPILOT_VERSION
              // request just below: a board that never answers (or rejects
              // every message in the set) must not block or throw out of the
              // 'connected' transition — only log for diagnosis.
              telemetry.requestStreams(TELEMETRY_STREAM_RATES_HZ).catch((err) => {
                console.error('connection: telemetry requestStreams failed', err)
              })
              // Graceful absence tolerance (task brief): a board that never
              // answers (or this request being unsupported) just leaves
              // `identity` as-is — never awaited, never blocks anything.
              sendCommand(router, { sysid: target.sysid, compid: target.compid }, {
                command: MAV_CMD_REQUEST_MESSAGE,
                param1: AUTOPILOT_VERSION_MSGID,
              }).catch(() => {})
            }
          }
        })
        cleanupFns.push(unsubLinkState)

        const unsubStatusText = router.subscribe({ msgid: STATUSTEXT_MSGID }, (msg) => {
          const severity = Number(msg.fields.severity)
          const text = String(msg.fields.text)
          set((s) => {
            const next = s.statustext.concat({ severity, text, ts: Date.now() })
            if (next.length > STATUSTEXT_CAP) next.splice(0, next.length - STATUSTEXT_CAP)
            return { statustext: next }
          })
        })
        cleanupFns.push(unsubStatusText)

        const unsubIdentity = router.subscribe({ msgid: AUTOPILOT_VERSION_MSGID }, (msg) => {
          // `product_id` -> `boardId` is a plausible-but-unverified mapping,
          // not something confirmed against ArduPilot firmware source: the
          // MAVLink common spec only describes vendor_id/product_id as
          // generic "USB-style IDs", but Mission Planner/QGroundControl-style
          // GCS tools are known to display ArduPilot's product_id as a
          // "board ID". If real-hardware verification ever shows this field
          // means something else (or is always 0) on some firmware, this is
          // the only line to change — identity is display-only either way
          // (decisions-m1: board_id from AUTOPILOT_VERSION never gates
          // anything), so a wrong/absent value here cannot break anything
          // else, only mislabel the topbar chip.
          const productId = Number(msg.fields.product_id)
          set({
            identity: {
              boardId: productId > 0 ? productId : undefined,
              fwVersion: decodeFlightSwVersion(Number(msg.fields.flight_sw_version)),
              vehicleName: undefined,
            },
          })
        })
        cleanupFns.push(unsubIdentity)

        set({ portInfo, linkStats: router.stats })
        statsTimer = setInterval(() => {
          set({ linkStats: router.stats })
        }, LINK_STATS_INTERVAL_MS)

        router.start()
      },

      async disconnect() {
        const transport = transportRef
        if (!transport) return
        // Best-effort: send the stop-stream commands while the link is still
        // live, before transport.close() tears everything down (its
        // onDisconnect -> teardown() fires synchronously within that call
        // and disposes `telemetryRef` — this must happen first, on the
        // still-open link, not after). A board that's already unresponsive
        // must not block or throw out of a graceful disconnect — only log.
        if (telemetryRef) {
          await telemetryRef.stopStreams().catch((err) => {
            console.error('connection: telemetry stopStreams failed', err)
          })
        }
        await transport.close() // triggers the registered onDisconnect -> teardown() synchronously within this call
      },

      clearStatustext() {
        set({ statustext: [] })
      },

      takeoverForFlash() {
        const phase = get().phase
        if (phase !== 'connected' && phase !== 'lost') return null
        const transport = transportRef
        if (!transport) return null

        unsubTransportDisconnect?.()
        unsubTransportDisconnect = undefined
        resetSession()
        return transport
      },
    }
  })
}

/** The app-wide singleton, using the real Web Serial picker. */
export const useConnectionStore = createConnectionStore()
