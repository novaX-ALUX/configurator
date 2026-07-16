/**
 * `rebootFlightController()` — the Named Operation (ADR-0002 rule 1) for
 * sending `MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN` (246) with `param1=1` (reboot
 * autopilot) through the connected Session's `sendCommand` machinery
 * (`command.ts`). Target sysid/compid come from `session.target`, resolved
 * once by the Session's link layer — never a hardcoded sysid (ADR-0002 rule
 * 3, `CONTEXT.md`'s "Session" entry).
 *
 * This is a distinct code path from `core/firmware/px4bl.ts`'s
 * `sendRebootToBootloader`/`sendEnterRomDfu`, which hand-encode a raw
 * COMMAND_LONG frame with a fixed sysid/compid (`param1=3`, reboot to
 * bootloader) *before* any Session exists — that pre-Session exception is
 * documented there (`px4bl.ts`'s own module doc) and does not apply here:
 * this operation only ever runs inside a live, connected Session.
 *
 * **Safety pattern** (ADR-0002 rule 1, declared here per that rule):
 * - *Confirmation*: the caller (`ParamsPage`) gates every call behind a
 *   `window.confirm` dialog before invoking this function — this module
 *   performs no gating of its own, matching `magCal.ts`/`accelCal.ts`'s
 *   convention that the confirmation UI belongs to the feature layer, not
 *   the protocol module.
 * - *Disabled while disconnected*: the caller only renders/enables the
 *   Reboot control while it holds a live `MavSession` (`useConnectionStore`'s
 *   `session` is `null` whenever nothing is connected) — this function
 *   requires a `MavSession` argument, so there is no way to call it without
 *   one.
 * - *Stop path*: none — a reboot is a single, trivial-hazard, bench-side,
 *   one-shot command (PRD #12 Ticket 5) with nothing to cancel once sent.
 *
 * `MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN` is already in `command.ts`'s
 * `DANGEROUS_COMMANDS` set, so `sendCommand` forces `retries=0` here
 * regardless of `opts`.
 *
 * A rebooting FC very often never sends back a `COMMAND_ACK` at all (it
 * resets before the reply goes out) — `sendCommand` then rejects with
 * `CommandTimeoutError` after its one allowed attempt. That is an *expected*
 * outcome here, not a failure to surface: the command going out is success
 * from this module's point of view, so it resolves `undefined` instead of
 * rejecting (mirrors `motorTest.ts`'s `stopMotorTest`, which swallows the
 * same error for the same "the device may already be gone" reason). Any
 * other rejection (e.g. a transport-level send failure) still propagates.
 */
import { sendCommand, CommandTimeoutError, type CommandAck, type SendCommandOpts } from './command'
import { MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN } from './commandIds'
import type { MavSession } from './session'

/** `MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN` param1: 1 = reboot autopilot (0=do nothing, 2=shutdown, 3=reboot to bootloader — `px4bl.ts` uses that value pre-Session, common.xml:2054-2059). */
const REBOOT_AUTOPILOT = 1

export interface RebootOpts {
  /** Injectable in place of the real `sendCommand` (`command.ts`), for tests. */
  sendCommandFn?: typeof sendCommand
  /** Overrides `sendCommand`'s ACK-wait `timeoutMs`. Defaults to `sendCommand`'s own default (1500ms) — a reboot has no larger FC-side duration to pad against. */
  commandTimeoutMs?: number
}

/**
 * Sends `MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN` with `param1=1` through
 * `session.router`/`session.target`. Resolves with the `CommandAck` if one
 * arrives, or `undefined` if the wait timed out (module doc: an expected
 * outcome for a command that reboots the FC before it can reply). Any other
 * rejection (transport failure) propagates.
 */
export async function rebootFlightController(session: MavSession, opts: RebootOpts = {}): Promise<CommandAck | undefined> {
  const sendCommandFn = opts.sendCommandFn ?? sendCommand
  const sendOpts: SendCommandOpts = { timeoutMs: opts.commandTimeoutMs }
  try {
    return await sendCommandFn(
      session.router,
      session.target,
      { command: MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, param1: REBOOT_AUTOPILOT },
      sendOpts,
    )
  } catch (err) {
    if (err instanceof CommandTimeoutError) return undefined // FC likely reset before ACKing -- see module doc
    throw err
  }
}
