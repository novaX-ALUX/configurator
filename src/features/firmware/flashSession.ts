/**
 * Firmware-update orchestrator — pure state machine + injected effects, no
 * React. `FirmwarePage`/`DfuRecovery` render from the store this creates and
 * call its actions; every actual side effect (network, transport, engine)
 * comes in through `effects` so this module (and its tests) never touch
 * `navigator.serial`/`navigator.usb`/`fetch` directly.
 *
 * Two sessions live here because the two tabs drive genuinely different
 * engines (`Px4Flasher` over a reopened serial `Transport`, vs `Stm32Dfu`
 * over an already-picked `USBDevice`) but share the same shape of problem
 * (confirm -> destructive flash -> done/failed, cancel-before-erase, no
 * auto-retry) — small enough to not be worth a shared abstraction beyond the
 * `FlashLogEntry` type both use.
 *
 * `createFlashSession` (Tab 1, normal update) follows the sequence fixed by
 * the task brief: idle -> confirming -> downloading -> verifying ->
 * rebooting -> connecting -> identifying -> erasing -> programming ->
 * verifying-flash -> done | failed(step, error). Decisions-m1.md decisions
 * 4/5 (same-origin mirror, no cross-origin fallback) mean `downloading` only
 * ever calls `firmwareFileUrl()`; a local `.apj` drop skips
 * downloading/verifying entirely (already parsed, see `FlashSource`).
 *
 * `prepareDirect()` (issue #29) is a second entry into this SAME `run()` for
 * a board that is already sitting in its bootloader (e.g. a flash that died
 * mid-erase, stranding the board with its app erased) — there is no running
 * app to reboot and no MAVLink connection to take over. It pre-seeds
 * `rebootSent` and hands `run()` an already-open `Transport` (acquired via
 * `navigator.serial.requestPort()` at the triggering click, see
 * `requestDirectBootloaderTransport()` below), so `run()` skips straight
 * from `confirming`/`downloading`/`verifying` past `rebooting`/`connecting`
 * into `identifying` — the exact same board_id/capacity gate inside
 * `Px4Flasher.flash()` still runs first, unmodified.
 *
 * The connection store's `takeoverForFlash()` is what makes "pause telemetry
 * -> flash -> resume" possible: `rebooting` calls it to get the live
 * transport, sends the MAVLink reboot-to-bootloader command over it (which
 * also closes it, per px4bl.ts), and `connecting` opens a *fresh* `Transport`
 * for the re-enumerated bootloader — `identifying`'s `createFlasher()` then
 * builds a brand new `Px4Flasher` around that fresh transport, never reusing
 * one across a transport generation (task 3.3's carried-forward architectural
 * fact).
 *
 * Cancellation is cooperative/checkpoint-based, not a hard abort: `cancel()`
 * only takes effect at the *next* checkpoint after whichever effect is
 * in-flight resolves — this is fine because nothing before `erasing` is
 * destructive (a reboot into the bootloader is recoverable by a power cycle;
 * no chip has been erased). Once `flash()` has been called, `cancel()` is a
 * no-op (see `CANCELLABLE_STEPS`): there is no way to safely interrupt an
 * erase/program/verify cycle already in flight.
 *
 * `Px4Flasher.flash()`/`Stm32Dfu.flash()` are monolithic (identify/erase/
 * program/verify all inside one call) and don't expose a phase-changed hook
 * beyond `onProgress`, so a failure thrown from inside either engine is
 * classified by message pattern + "did onProgress ever fire" rather than by
 * asking the engine which phase it was in — see `classifyPx4Failure` (the DFU
 * session inlines the equivalent, simpler logic directly in its own catch
 * block, since it only has two candidate steps). This is a deliberate,
 * documented heuristic: the known guard-failure message patterns (wrong
 * board, image too large, chip mismatch, ...) are the exact strings
 * px4bl.ts/dfu.ts throw today.
 */
import { create } from 'zustand'
import type { Transport } from '../../core/transport/types'
import { SerialTransport } from '../../core/transport/serial'
import { waitForBootloaderReconnect } from '../../core/transport/reconnect'
import { parseApj, verifyImageSha256, type ParsedApj } from '../../core/firmware/apj'
import { firmwareFileUrl, type BoardFirmware, type FirmwareFile } from '../../core/firmware/manifest'
import type { ParsedHex } from '../../core/firmware/intelhex'
import type { StmFamily } from '../../core/firmware/dfu'
import { Px4Flasher, sendRebootToBootloader } from '../../core/firmware/px4bl'
import { NOVAX_USB_VENDOR_ID, useConnectionStore } from '../../store/connection'

export interface FlashLogEntry {
  ts: number
  text: string
}

// ---------------------------------------------------------------------------
// Tab 1: normal update (Px4Flasher over a reopened serial Transport)
// ---------------------------------------------------------------------------

export type FlashStep =
  | 'idle'
  | 'confirming'
  | 'downloading'
  | 'verifying'
  | 'rebooting'
  | 'connecting'
  | 'identifying'
  | 'erasing'
  | 'programming'
  | 'verifying-flash'
  | 'done'
  | 'failed'

/** Steps where nothing destructive has happened yet — `cancel()` is only honored from one of these (see module doc). Exported so the page can render a Cancel affordance that's enabled/disabled in exact lockstep with what `cancel()` itself will actually honor, rather than duplicating this list. */
export const CANCELLABLE_STEPS: readonly FlashStep[] = ['confirming', 'downloading', 'verifying', 'rebooting', 'connecting', 'identifying']

export type FlashSource =
  | { kind: 'online'; board: BoardFirmware; file: FirmwareFile }
  | { kind: 'local'; fileName: string; apj: ParsedApj }

export interface FlashTarget {
  boardName: string
  version: string
  apjBoardId: number
  source: FlashSource
}

export interface Px4IdentifyLike {
  boardId: number
  flashSize: number
  blRev: number
}

/** Structural subset of `Px4Flasher` (src/core/firmware/px4bl.ts) this module depends on. */
export interface Px4FlasherLike {
  identify(): Promise<Px4IdentifyLike>
  flash(apj: ParsedApj, onProgress: (done: number, total: number) => void): Promise<void>
}

export interface FlashSessionEffects {
  fetchFn: typeof fetch
  /** `store.takeoverForFlash()` — hands off the live MAVLink transport, or `null` if not connected. */
  takeoverTransport: () => Transport | null
  /** `sendRebootToBootloader` (px4bl.ts) — sends the MAVLink command and closes `transport`. */
  rebootToBootloader: (transport: Transport) => Promise<void>
  /**
   * Opens a fresh `Transport` once the board has re-enumerated in bootloader
   * mode (`navigator.serial`-backed in production via
   * `core/transport/reconnect.ts`; a scripted fake in tests). Receives the
   * just-rebooted `Transport` (already closed by `rebootToBootloader`, kept
   * only for identity) so the real implementation can wait for *that exact*
   * port's physical disconnect before polling for the bootloader — see
   * `reconnect.ts`'s module doc (issue #28's Reconnect-race fix). `null` when
   * a `prepareDirect()` attempt (issue #29: board already in its bootloader,
   * no app-mode transport ever existed) retries past a failed `connecting` —
   * the real implementation already tolerates this (skips the wait-for-
   * disconnect phase, goes straight to polling `getPorts()`).
   */
  openBootloaderTransport: (oldTransport: Transport | null) => Promise<Transport>
  /** Fresh `Px4Flasher` per transport generation — never reused across a reconnect (task 3.3/router.ts's architectural fact). */
  createFlasher: (transport: Transport) => Px4FlasherLike
  now: () => number
}

class FlashStepError extends Error {
  constructor(
    readonly step: FlashStep,
    message: string,
  ) {
    super(message)
  }
}

/** Message patterns px4bl.ts's `Px4Flasher.flash()` guard checks throw before ever erasing — see that module's doc. */
const PX4_GUARD_FAILURE = /wrong firmware|image too large|flash capacity unknown|empty image/i
const PX4_VERIFY_FAILURE = /crc verify failed/i
/** A dropped serial connection surfaces as one of these from `ByteReader`/`Transport` — see px4bl.ts. */
const DISCONNECTED_PATTERN = /serial port closed|transport is not open/i

function classifyPx4Failure(err: unknown, sawProgress: boolean): { step: FlashStep; disconnected: boolean } {
  const message = err instanceof Error ? err.message : String(err)
  const disconnected = DISCONNECTED_PATTERN.test(message)
  if (PX4_GUARD_FAILURE.test(message)) return { step: 'identifying', disconnected }
  if (PX4_VERIFY_FAILURE.test(message)) return { step: 'verifying-flash', disconnected }
  return { step: sawProgress ? 'programming' : 'erasing', disconnected }
}

export interface FlashSessionState {
  step: FlashStep
  target: FlashTarget | null
  progress: { done: number; total: number } | null
  identify: Px4IdentifyLike | null
  failedStep: FlashStep | null
  error: string | null
  /** True only when a `failed` state was caused by the connection dropping mid-flash — the page uses this to show reconnect guidance instead of a generic error, and `retry()` knows to redo the `connecting` step rather than reuse a dead transport. */
  disconnected: boolean
  /** True for an attempt started via `prepareDirect()` (issue #29: board already in its bootloader) — the page uses this to skip rendering the Reboot/Reconnect steps, which never run for this path, and to show accurate confirm-dialog copy (no reboot happens). */
  directEntry: boolean
  log: FlashLogEntry[]

  /** Loads a target and moves to `confirming` — does not start flashing. */
  prepare: (target: FlashTarget) => void
  /**
   * Direct-bootloader entry (issue #29): `transport` must already be open —
   * acquired via `requestDirectBootloaderTransport()` called directly from
   * the triggering click handler, since `navigator.serial.requestPort()`
   * needs a live user gesture that would no longer be valid by the time an
   * effect deep inside `run()`'s download/verify awaits got around to
   * calling it. Moves to `confirming`, same as `prepare()`.
   */
  prepareDirect: (target: FlashTarget, transport: Transport) => void
  /** Starts the flash from `confirming`; a no-op from any other step. */
  confirm: () => void
  /** Safe abort — only takes effect from a step in `CANCELLABLE_STEPS`; a no-op once erasing/programming has started. */
  cancel: () => void
  /** Resumes from `failed`, picking up after whatever already-completed, non-destructive work is still valid (never re-sends the reboot-to-bootloader command once it has gone out, never re-downloads a file already verified). Never called automatically. */
  retry: () => void
  reset: () => void
}

/**
 * Factory (mirrors `createConnectionStore`) so tests inject fake effects; the
 * page constructs its own instance wired to real effects (fetch,
 * `useConnectionStore.takeoverForFlash`, `sendRebootToBootloader`, a
 * `navigator.serial`-backed reconnect poll, `(t) => new Px4Flasher(t)`).
 */
export function createFlashSession(effects: FlashSessionEffects) {
  return create<FlashSessionState>((set, get) => {
    // Per-attempt session state, deliberately kept outside the reactive
    // `FlashSessionState` (mirrors connection.ts's own transportRef/etc.
    // pattern) — `retry()` reads these to skip already-completed,
    // non-destructive work instead of redoing it.
    let runGeneration = 0
    let apjRef: ParsedApj | null = null
    /** Set the instant `rebootToBootloader()` succeeds and never cleared until `prepare()`/`reset()`/`cancel()` starts a new attempt — once the running app has been told to reboot into its bootloader, there is no app left to receive that MAVLink command again, so a retry after this point must never re-send it (see `classifyPx4Failure`'s `disconnected` handling, which only clears `bootloaderTransportRef`, not this). */
    let rebootSent = false
    /** Set by `prepareDirect()` (issue #29) — true when this attempt entered via the direct-bootloader path rather than `prepare()`. Reset alongside `rebootSent` by `prepare()`/`cancel()`/`reset()`. */
    let directEntry = false
    let bootloaderTransportRef: Transport | null = null
    /** The `Transport` handed to `rebootToBootloader()` (already closed by it) — kept only so `connecting`'s `openBootloaderTransport()` can identify "the exact port the app was just using" for the wait-for-disconnect step (issue #28). Set once per attempt alongside `rebootSent`; survives a `retry()` that resumes at `connecting` (where `rebootSent` is already `true` and this block is skipped). */
    let rebootedTransportRef: Transport | null = null

    function log(text: string): void {
      set((s) => ({ log: [...s.log, { ts: effects.now(), text }] }))
    }

    /** Best-effort, fire-and-forget close — used whenever a transport is being discarded (superseded by a newer generation, or no longer usable after a failure/success) rather than handed to whatever comes next. */
    function closeBootloaderTransport(): void {
      if (!bootloaderTransportRef) return
      void bootloaderTransportRef.close()
      bootloaderTransportRef = null
    }

    async function run(): Promise<void> {
      const gen = ++runGeneration
      const isCurrent = (): boolean => gen === runGeneration
      let sawProgress = false
      try {
        if (directEntry) log('Board already in bootloader — skipping reboot and reconnect.')
        if (!apjRef) {
          const target = get().target
          if (!target) throw new FlashStepError('confirming', 'No firmware selected.')
          set({ step: 'downloading' })
          log('Downloading firmware…')

          if (target.source.kind === 'local') {
            apjRef = target.source.apj
          } else {
            const { file } = target.source
            let res: Response
            try {
              res = await effects.fetchFn(firmwareFileUrl(file))
            } catch (err) {
              throw new FlashStepError('downloading', `Download failed: ${err instanceof Error ? err.message : String(err)}`)
            }
            if (!isCurrent()) return
            if (!res.ok) throw new FlashStepError('downloading', `Download failed: HTTP ${res.status}. The firmware mirror may not be synced yet — try again shortly.`)
            const bytes = await res.arrayBuffer()
            if (!isCurrent()) return

            set({ step: 'verifying' })
            log('Verifying checksum…')
            const ok = await verifyImageSha256(new Uint8Array(bytes), file.sha256)
            if (!isCurrent()) return
            if (!ok) throw new FlashStepError('verifying', 'Downloaded firmware failed checksum verification. Try again, or use a local firmware file instead.')
            const parsed = await parseApj(bytes)
            // Checked again right after this last await, before writing the
            // shared `apjRef` — a `cancel()` mid-parse must not let a stale
            // run's result land in a fresh attempt's state (see flashSession
            // review notes: this is the same "supersede -> don't adopt into
            // shared state" discipline BaseTransport.doOpen() documents).
            if (!isCurrent()) return
            apjRef = parsed
          }
        }
        if (!isCurrent()) return

        if (!rebootSent) {
          set({ step: 'rebooting' })
          log('Rebooting the board into its bootloader…')
          const liveTransport = effects.takeoverTransport()
          if (!liveTransport) throw new FlashStepError('rebooting', 'Not connected — connect to the board before updating its firmware.')
          rebootedTransportRef = liveTransport
          try {
            await effects.rebootToBootloader(liveTransport)
          } catch (err) {
            throw new FlashStepError('rebooting', `Reboot-to-bootloader failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          if (!isCurrent()) return
          rebootSent = true
        }
        if (!isCurrent()) return

        if (!bootloaderTransportRef) {
          set({ step: 'connecting' })
          log('Waiting for the bootloader to reconnect…')
          let transport: Transport
          try {
            // `rebootedTransportRef` is non-null here for a normal attempt
            // (set alongside `rebootSent` by the `!rebootSent` block above,
            // this attempt or an earlier one before a retry) but legitimately
            // null for a `prepareDirect()` attempt (issue #29) that reaches
            // this block on a retry after `bootloaderTransportRef` was
            // cleared by a prior failure — there was never an app-mode
            // transport to identify. `openBootloaderTransport` handles both.
            transport = await effects.openBootloaderTransport(rebootedTransportRef)
          } catch (err) {
            throw new FlashStepError('connecting', err instanceof Error ? err.message : String(err))
          }
          if (!isCurrent()) {
            void transport.close() // superseded — don't adopt into shared state, release it directly
            return
          }
          bootloaderTransportRef = transport
        }
        if (!isCurrent()) return

        const flasher = effects.createFlasher(bootloaderTransportRef)
        set({ step: 'identifying' })
        log('Identifying the board…')
        let identity: Px4IdentifyLike
        try {
          identity = await flasher.identify()
        } catch (err) {
          // Tagged distinctly from classifyPx4Failure's heuristics below: this
          // is `identify()` itself failing (sync lost, timeout, ...), not one
          // of `flash()`'s guard checks — conflating the two previously
          // reported every identify()-level failure as an 'erasing' failure.
          throw new FlashStepError('identifying', err instanceof Error ? err.message : String(err))
        }
        if (!isCurrent()) return
        set({ identify: identity })

        set({ step: 'erasing', progress: null })
        log('Erasing and programming…')
        const apj = apjRef
        await flasher.flash(apj, (done, total) => {
          if (!isCurrent()) return // an abandoned run's device-side bytes are still real, but nothing here should still be mutating shared state
          sawProgress = true
          set({ step: 'programming', progress: { done, total } })
        })
        if (!isCurrent()) return

        set({ step: 'done' })
        log('Flashed and verified.')
        // The board just rebooted back into its app (Px4Flasher.flash()'s own
        // final step) — this transport can no longer talk bootloader
        // protocol, so it must not be left open (blocking a future connect())
        // or handed to a future retry().
        closeBootloaderTransport()
      } catch (err) {
        if (!isCurrent()) return
        if (err instanceof FlashStepError) {
          // Route through the same disconnected-pattern check classifyPx4Failure
          // uses below, rather than hardcoding `disconnected: false` — an
          // identify() (or rebooting/connecting) failure caused by the cable
          // actually dropping must show "connection lost, reconnect" guidance,
          // not "still in its bootloader, retry is safe" (those are different
          // instructions to the user, and only one is true here).
          const disconnected = DISCONNECTED_PATTERN.test(err.message)
          // A guard failure inside `flash()` (wrong board/oversized image/
          // capacity unknown) already reboots the device back to its app
          // before throwing, and a failed `identify()` at minimum means this
          // transport isn't currently talking to a cooperative bootloader —
          // in both cases (and whenever the message itself indicates a drop),
          // force `retry()` to redo `connecting` from scratch rather than risk
          // reusing a transport that no longer speaks the bootloader protocol
          // (fails safe: worst case is one extra reconnect wait, not a
          // confusing hang against a dead link).
          if (err.step === 'identifying' || disconnected) closeBootloaderTransport()
          set({ step: 'failed', failedStep: err.step, error: err.message, disconnected })
          log(`Failed: ${err.message}`)
          return
        }
        const { step, disconnected } = classifyPx4Failure(err, sawProgress)
        // A dropped connection means the bootloader transport handed to the
        // (now-failed) flasher is dead — clear it so a later retry() redoes
        // `connecting` instead of reusing it. Never triggered automatically:
        // retry() is only ever called by an explicit user action.
        if (disconnected || step === 'identifying') closeBootloaderTransport()
        const message = err instanceof Error ? err.message : String(err)
        set({ step: 'failed', failedStep: step, error: message, disconnected })
        log(`Failed: ${message}`)
      }
    }

    return {
      step: 'idle',
      target: null,
      progress: null,
      identify: null,
      failedStep: null,
      error: null,
      disconnected: false,
      directEntry: false,
      log: [],

      prepare(target) {
        apjRef = target.source.kind === 'local' ? target.source.apj : null
        rebootSent = false
        directEntry = false
        rebootedTransportRef = null
        closeBootloaderTransport() // abandoning any still-open transport from a previous (failed) attempt on a different target, not just dropping the reference
        runGeneration++ // invalidates any stale in-flight run from a previous target
        set({
          step: 'confirming',
          target,
          progress: null,
          identify: null,
          failedStep: null,
          error: null,
          disconnected: false,
          directEntry: false,
          log: [],
        })
      },

      prepareDirect(target, transport) {
        apjRef = target.source.kind === 'local' ? target.source.apj : null
        rebootSent = true // already in the bootloader — no app-mode reboot to send
        directEntry = true
        rebootedTransportRef = null // no app-mode transport preceded this attempt
        closeBootloaderTransport() // abandoning any still-open transport from a previous (failed) attempt
        bootloaderTransportRef = transport // already open — acquired via requestPort() at the triggering click, see requestDirectBootloaderTransport()
        runGeneration++
        set({
          step: 'confirming',
          target,
          progress: null,
          identify: null,
          failedStep: null,
          error: null,
          disconnected: false,
          directEntry: true,
          log: [],
        })
      },

      confirm() {
        if (get().step !== 'confirming') return
        void run()
      },

      cancel() {
        if (!CANCELLABLE_STEPS.includes(get().step)) return
        runGeneration++ // the in-flight run notices at its next checkpoint and returns without touching state
        apjRef = null
        rebootSent = false
        directEntry = false
        rebootedTransportRef = null
        closeBootloaderTransport()
        set({ step: 'idle', target: null, progress: null, identify: null, failedStep: null, error: null, disconnected: false, directEntry: false })
      },

      retry() {
        if (get().step !== 'failed') return
        set({ failedStep: null, error: null, disconnected: false })
        void run() // resumes using whatever apjRef/rebootSent/bootloaderTransportRef survived the failure (see classifyPx4Failure's disconnected handling) — never re-sends the reboot-to-bootloader command once rebootSent is true
      },

      reset() {
        runGeneration++
        apjRef = null
        rebootSent = false
        directEntry = false
        rebootedTransportRef = null
        closeBootloaderTransport()
        set({ step: 'idle', target: null, progress: null, identify: null, failedStep: null, error: null, disconnected: false, directEntry: false, log: [] })
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Tab 2: DFU recovery (Stm32Dfu over an already-picked USBDevice)
// ---------------------------------------------------------------------------

export type DfuStep = 'idle' | 'confirming' | 'erasing' | 'programming' | 'done' | 'failed'

export interface DfuTarget {
  fileName: string
  hex: ParsedHex
  /** Compared against the connected chip's classified family inside `Stm32Dfu.flash()`'s guard — `undefined` when the family is unknown (e.g. a dropped file with no board context), matching that guard's own "unknown family -> capacity-only" fallback. */
  expectedFamily?: StmFamily
}

/** Structural subset of `Stm32Dfu` (src/core/firmware/dfu.ts) this module depends on. Constructed once around a user-picked `USBDevice` by the page (WebUSB's permission gesture lives there, not here) and passed in via `effects.flasher`. */
export interface Stm32DfuLike {
  flash(hex: ParsedHex, onProgress: (done: number, total: number) => void, expectedFamily?: StmFamily): Promise<void>
}

export interface DfuSessionEffects {
  flasher: Stm32DfuLike
  now: () => number
}

/** dfu.ts's `Progress` is a fixed 0-1000 permille scale, erase = first 0-300, write = 300-1000 (see that module's doc) — this is how erase/programming are distinguished here, since `Stm32Dfu.flash()` is one call with no phase-changed hook of its own. */
const DFU_ERASE_PERMILLE_CEILING = 300

/** DFU has no earlier non-destructive steps to cancel out of (no download/reboot dance — the device is already in DFU mode by the time a target exists), so this is just `['confirming']`. Exported (mirrors `CANCELLABLE_STEPS`) so the page renders a Cancel affordance in exact lockstep with what `cancel()` will actually honor. */
export const DFU_CANCELLABLE_STEPS: readonly DfuStep[] = ['confirming']

export interface DfuSessionState {
  step: DfuStep
  target: DfuTarget | null
  progress: { done: number; total: number } | null
  failedStep: DfuStep | null
  error: string | null
  log: FlashLogEntry[]

  prepare: (target: DfuTarget) => void
  confirm: () => void
  /** Only takes effect from `confirming` — DFU has no earlier non-destructive steps to cancel out of (no download/reboot dance; the device is already in DFU mode by the time a target exists). */
  cancel: () => void
  retry: () => void
  reset: () => void
}

export function createDfuFlashSession(effects: DfuSessionEffects) {
  return create<DfuSessionState>((set, get) => {
    let runGeneration = 0

    function log(text: string): void {
      set((s) => ({ log: [...s.log, { ts: effects.now(), text }] }))
    }

    async function run(): Promise<void> {
      const gen = ++runGeneration
      const isCurrent = (): boolean => gen === runGeneration
      const target = get().target
      if (!target) return
      let sawProgress = false
      try {
        set({ step: 'erasing', progress: null })
        log('Erasing and programming…')
        await effects.flasher.flash(
          target.hex,
          (done, total) => {
            sawProgress = true
            if (!isCurrent()) return
            set({ step: done < DFU_ERASE_PERMILLE_CEILING ? 'erasing' : 'programming', progress: { done, total } })
          },
          target.expectedFamily,
        )
        if (!isCurrent()) return
        set({ step: 'done' })
        log('Flashed.')
      } catch (err) {
        if (!isCurrent()) return
        const message = err instanceof Error ? err.message : String(err)
        set({ step: 'failed', failedStep: sawProgress ? 'programming' : 'erasing', error: message })
        log(`Failed: ${message}`)
      }
    }

    return {
      step: 'idle',
      target: null,
      progress: null,
      failedStep: null,
      error: null,
      log: [],

      prepare(target) {
        runGeneration++
        set({ step: 'confirming', target, progress: null, failedStep: null, error: null, log: [] })
      },

      confirm() {
        if (get().step !== 'confirming') return
        void run()
      },

      cancel() {
        if (!DFU_CANCELLABLE_STEPS.includes(get().step)) return
        runGeneration++
        set({ step: 'idle', target: null, progress: null, failedStep: null, error: null })
      },

      retry() {
        if (get().step !== 'failed') return
        set({ failedStep: null, error: null })
        void run()
      },

      reset() {
        runGeneration++
        set({ step: 'idle', target: null, progress: null, failedStep: null, error: null, log: [] })
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Real effects wiring for the app's Tab-1 singleton (mirrors
// store/connection.ts's own `useConnectionStore = createConnectionStore()`
// pattern) — DFU's `Stm32Dfu` is bound to a runtime-picked `USBDevice`
// instead, so `DfuRecovery.tsx` constructs its own `createDfuFlashSession`
// once a device is selected rather than using a fixed singleton.
// ---------------------------------------------------------------------------

/**
 * Waits for the bootloader to re-enumerate and opens a fresh `Transport` for
 * it, never `requestPort()` (which needs a user gesture this reconnect
 * doesn't have) — only already-authorized ports (`navigator.serial.getPorts()`).
 * Delegates the actual wait-for-disconnect-then-poll state machine to
 * `core/transport/reconnect.ts` (issue #28's Reconnect-race fix: the
 * previous version here polled immediately, without confirming the old
 * device had actually disconnected first — see that module's doc for the
 * full root-cause writeup and its own dedicated unit tests). `oldTransport`
 * is the just-closed app-mode `Transport`; its underlying `SerialPort` (when
 * it's a real `SerialTransport`, always true in production) is what phase 1
 * waits on. `null` when called on a `prepareDirect()` retry (issue #29 — no
 * app-mode transport ever existed for this attempt): phase 1 is skipped and
 * polling starts immediately, same as the "unknown" case this already
 * handled before issue #29 existed.
 */
async function openBootloaderTransport(oldTransport: Transport | null): Promise<Transport> {
  const oldPort = oldTransport instanceof SerialTransport ? oldTransport.rawPort : null
  return waitForBootloaderReconnect({
    serial: navigator.serial,
    oldPort,
    openCandidate: async (port) => {
      const transport = new SerialTransport(port, useConnectionStore.getState().baud)
      await transport.open()
      return transport
    },
  })
}

/**
 * Direct-bootloader entry (issue #29): opens a fresh `Transport` for a board
 * that is ALREADY sitting in its bootloader, via
 * `navigator.serial.requestPort()` — unlike `openBootloaderTransport()`
 * above (which only uses the already-authorized `getPorts()`, since it runs
 * with no user gesture of its own), this calls `requestPort()` directly and
 * therefore MUST be invoked directly from the triggering click handler
 * (`FirmwarePage`'s direct-flash button), before any download/verify network
 * work — a browser's transient user-activation for `requestPort()` is not
 * guaranteed to still be valid by the time an effect deep inside `run()`'s
 * own awaits would otherwise get around to calling it. The resulting
 * already-open `Transport` is handed to `session.prepareDirect()`, not
 * routed through `FlashSessionEffects` — there is nothing for `run()` itself
 * to await here. Filtered to novaX's USB vendor ID, same as the normal
 * Connect flow's `defaultPickPort` (`store/connection.ts`): the bootloader
 * enumerates under the same VID:PID as the app (confirmed on hardware,
 * issue #28's kernel-log evidence).
 */
export async function requestDirectBootloaderTransport(baud: number): Promise<Transport> {
  const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: NOVAX_USB_VENDOR_ID }] })
  const transport = new SerialTransport(port, baud)
  await transport.open()
  return transport
}

/**
 * Builds the real effects object for the Tab 1 singleton below. A factory
 * (not inlined into the `createFlashSession` call) so tests can construct it
 * against an injected `fetch` stub and verify the storage-site `.bind()`
 * actually neutralizes Chrome's "Illegal invocation" (see flashSession.test.ts's
 * regression test for issue #27): storing the bare global `fetch` here as an
 * object property and calling it method-style (`effects.fetchFn(url)`, as
 * `run()` above does) makes Chrome bind `this` to the effects object, which
 * its native `fetch` rejects — `.bind(globalThis)` fixes `this` permanently
 * at the storage site regardless of how the resulting function is later
 * invoked.
 */
export function realFlashSessionEffects(fetchFn: typeof fetch = fetch): FlashSessionEffects {
  return {
    fetchFn: fetchFn.bind(globalThis),
    takeoverTransport: () => useConnectionStore.getState().takeoverForFlash(),
    rebootToBootloader: sendRebootToBootloader,
    openBootloaderTransport,
    createFlasher: (transport) => new Px4Flasher(transport),
    now: () => Date.now(),
  }
}

/** The app-wide singleton for Tab 1 (normal update), using real effects. */
export const useFlashSession = createFlashSession(realFlashSessionEffects())
