import type { Transport } from './types'

/**
 * Web-Serial-specific "wait for the bootloader to re-enumerate" dance run by
 * `flashSession.ts`'s real effects wiring after `sendRebootToBootloader()`
 * has fired. Not expressible through the transport-agnostic `Transport`
 * interface (see `px4bl.ts`'s own module doc: `MockTransport` "cannot
 * simulate 'a new port object appears'") — this module owns `navigator.serial`
 * behind an injectable seam and is unit-tested directly against a fake
 * `Serial`/`SerialPort` (`__tests__/reconnect.test.ts`), mirroring how
 * `serial.test.ts` exercises `SerialTransport` against a `FakeSerialPort`.
 *
 * ROOT CAUSE this fixes (issue #28, "Failure A" — the Reconnect race):
 * kernel-log evidence from a real AF-H7E showed the app logging
 * Reboot/Reconnect/Identify all within the same second, while the kernel
 * itself only enumerated the bootloader ~2s after the app-mode device
 * disconnected. The previous implementation called
 * `navigator.serial.getPorts()` and tried to `open()` whatever it found
 * *immediately* after closing the app-mode transport — including the exact
 * `SerialPort` object the app was just using, which Web Serial does not
 * remove from `getPorts()` just because the physical device dropped, and
 * whose `open()` can apparently resolve before the OS has actually finished
 * processing the disconnect. `identify()` then ran against a port that
 * wasn't actually attached to anything live and timed out.
 *
 * FIX: two explicit, sequential phases instead of one immediate poll.
 * 1. `waitForDisconnect` — wait for `oldPort` to actually become physically
 *    disconnected (`SerialPort.connected` / its `disconnect` event — per the
 *    Web Serial spec, "a serial port is logically connected if it is a
 *    wired serial port and the port is physically connected to the system",
 *    so for a USB port this genuinely tracks physical presence, not just
 *    some independent logical flag). Bounded by `disconnectTimeoutMs` as a
 *    safety net in case the event never arrives; never rejects — polling is
 *    always attempted afterward regardless, and gets its own timeout.
 * 2. `pollForPort` — only then start polling `getPorts()`/opening
 *    candidates. USB IDENTITY CAVEAT: the Web Serial spec's `SerialPortInfo`
 *    only guarantees `usbVendorId`/`usbProductId` (both identical between
 *    app mode and bootloader here — issue #28's kernel log shows the same
 *    1209:5741), not `serialNumber`; it does not mandate how (or whether)
 *    `getPorts()` re-grants a port across that reboot when the bootloader's
 *    USB serial number differs from the app's (Chrome's actual persisted-
 *    permission matching, including whether it keys on serial number at
 *    all, is implementation-defined, not spec-guaranteed). So this may
 *    legitimately find nothing if the bootloader enumerates as a device
 *    Chrome treats as new; that case gets its own distinct, honest error
 *    asking the user to grant access again, rather than the generic
 *    "reconnect the cable" message (which was actively wrong for it) or
 *    hanging forever.
 */

/** Subset of `navigator.serial` this module depends on — narrow so tests can inject a fake without implementing the whole `Serial` interface. */
export interface SerialLike {
  getPorts(): Promise<SerialPort[]>
}

export interface WaitForBootloaderReconnectOpts {
  serial: SerialLike
  /**
   * The exact `SerialPort` the app-mode transport was using (`SerialTransport.rawPort`),
   * so phase 1 can wait for *its* specific disconnect rather than any port's.
   * `null` when unknown (the live transport wasn't a real `SerialTransport`)
   * — phase 1 is skipped in that case and polling starts right away, same
   * as before this fix; this shouldn't happen for the app's real Web
   * Serial connections, kept honest rather than asserted.
   */
  oldPort: SerialPort | null
  /**
   * Builds and opens a `Transport` around a candidate port at the flashing
   * baud; rejects if the candidate isn't (yet, or ever) a live bootloader.
   * A rejection leaves the candidate transport closed/unopened — nothing
   * further to clean up on this module's side.
   */
  openCandidate: (port: SerialPort) => Promise<Transport>
  now?: () => number
  /** Injectable in place of a real timer — tests drive this like the repo's other manually-resolved-promise seams (e.g. flashSession.test.ts's `resolveFirstOpen`) rather than `vi.useFakeTimers()`. */
  sleep?: (ms: number) => Promise<void>
  /** Phase 1 deadline. Default comfortably above the ~2s re-enumeration gap observed on AF-H7E (issue #28). */
  disconnectTimeoutMs?: number
  /** Phase 2 deadline. Default chosen to clear the ~2s gap observed on AF-H7E (issue #28) with a wide safety margin — no spec/hardware guarantee bounds re-enumeration time in general. */
  pollTimeoutMs?: number
  pollIntervalMs?: number
}

export const DEFAULT_DISCONNECT_TIMEOUT_MS = 5000
export const DEFAULT_POLL_TIMEOUT_MS = 15000
export const DEFAULT_POLL_INTERVAL_MS = 300

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolves once `port` is no longer physically connected, or `timeoutMs`
 * elapses — whichever comes first. Never rejects: a timeout here just means
 * phase 2 starts without confirmation (its own timeout is the real
 * backstop), rather than the whole reconnect hanging forever if the browser
 * doesn't deliver the event for some reason.
 */
async function waitForDisconnect(port: SerialPort, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  if (!port.connected) return
  let settled = false
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      if (settled) return
      settled = true
      port.removeEventListener('disconnect', onDisconnect)
      resolve()
    }
    const onDisconnect = (): void => finish()
    port.addEventListener('disconnect', onDisconnect)
    void sleep(timeoutMs).then(finish)
  })
}

/**
 * The full two-phase wait — see module doc. Resolves with a freshly opened
 * `Transport` for whichever port answers, or rejects with a user-facing
 * error once `pollTimeoutMs` elapses without one.
 */
export async function waitForBootloaderReconnect(opts: WaitForBootloaderReconnectOpts): Promise<Transport> {
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const disconnectTimeoutMs = opts.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  if (opts.oldPort) {
    await waitForDisconnect(opts.oldPort, disconnectTimeoutMs, sleep)
  }

  const deadline = now() + pollTimeoutMs
  let sawAnyPort = false
  for (;;) {
    const ports = await opts.serial.getPorts()
    for (const port of ports) {
      sawAnyPort = true
      try {
        return await opts.openCandidate(port)
      } catch {
        // Not the bootloader, or not ready yet — try the next candidate, or wait and re-poll.
      }
    }
    if (now() >= deadline) {
      if (!sawAnyPort) {
        throw new Error(
          'The bootloader did not reappear as an already-authorized device. It may need a fresh permission grant — click "Connect flight controller" and select it again, then retry.',
        )
      }
      throw new Error('The board did not reappear after rebooting into its bootloader. Reconnect the USB cable and try again.')
    }
    await sleep(pollIntervalMs)
  }
}
