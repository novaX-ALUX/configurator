/**
 * Command layer: sends a COMMAND_LONG (msgid 76) through a `MavRouter` and
 * resolves once the correlated COMMAND_ACK (msgid 77) arrives, retrying on
 * timeout per the MAVLink spec (retransmission bumps `confirmation`, not
 * the message content).
 *
 * ACK correlation is two-part:
 * - **Source** (who sent the ACK): matched via `MavRouter.subscribe`'s own
 *   `{ sysid, compid }` filter against `target` — this is the frame's
 *   header sysid/compid, i.e. the component that answered, not
 *   COMMAND_ACK's own `target_system`/`target_component` fields (those are
 *   extension fields addressed at whoever should *receive* the ack, a
 *   different thing, and are not consulted here).
 * - **Command**: the decoded `command` field must equal `cmd.command`.
 *
 * Resolves with a typed `CommandAck` for **any** final result — including
 * `MAV_RESULT_DENIED`/`FAILED`/etc. Deciding whether a non-ACCEPTED result
 * is a caller-visible failure is the caller's policy, not this layer's;
 * only a timeout or an aborted `signal` reject the returned promise.
 */
import { defs } from './defs'
import { encodePayload } from './encode'
import type { MavRouter } from './router'

const COMMAND_LONG_MSGID = 76
const COMMAND_ACK_MSGID = 77
const MAV_RESULT_IN_PROGRESS = 5

const DEFAULT_TIMEOUT_MS = 1500
const DEFAULT_RETRIES = 2
const MAX_CONFIRMATION = 255

/**
 * Commands whose accidental retransmission is unsafe (reboot/shutdown,
 * calibration, arm/disarm, motor test, persistent-storage load/save) —
 * a compile-time set, not caller-configurable. `sendCommand` forces
 * `retries` to 0 for any command in this set, regardless of `opts.retries`.
 */
export const DANGEROUS_COMMANDS: ReadonlySet<number> = new Set([
  241, // MAV_CMD_PREFLIGHT_CALIBRATION
  245, // MAV_CMD_PREFLIGHT_STORAGE
  246, // MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN
  400, // MAV_CMD_COMPONENT_ARM_DISARM
  209, // MAV_CMD_DO_MOTOR_TEST
])

export interface CommandLongSpec {
  command: number
  param1?: number
  param2?: number
  param3?: number
  param4?: number
  param5?: number
  param6?: number
  param7?: number
}

export interface CommandAck {
  command: number
  result: number
  progress: number
  resultParam2: number
}

export interface SendCommandOpts {
  /** Per-attempt timeout in ms, default 1500. Reset (not counted as a retry) on every MAV_RESULT_IN_PROGRESS ACK. */
  timeoutMs?: number
  /** Retransmit attempts after the first, default 2 (so up to 3 attempts total). Forced to 0 for `DANGEROUS_COMMANDS`. */
  retries?: number
  signal?: AbortSignal
  /** Called for every MAV_RESULT_IN_PROGRESS ACK received, with its `progress` (0-100 or 255=unknown) and `resultParam2`. */
  onProgress?: (progress: number, resultParam2: number) => void
}

/** Rejected when every attempt (initial send + retries) timed out without a matching final-result COMMAND_ACK. */
export class CommandTimeoutError extends Error {
  constructor(
    public readonly command: number,
    public readonly attempts: number,
  ) {
    super(`sendCommand: command ${command} timed out after ${attempts} attempt(s)`)
    this.name = 'CommandTimeoutError'
  }
}

/**
 * Thrown synchronously, before anything is sent, for a caller programming
 * error — `opts.retries > 0` on a `DANGEROUS_COMMANDS` entry. Deliberately
 * not silently clamped to 0: a caller asking for retries on a command
 * where retransmission is unsafe is a bug in the caller, and silently
 * "fixing" it would hide that bug instead of surfacing it.
 */
export class CommandUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandUsageError'
  }
}

function toAbortError(): DOMException {
  return new DOMException('sendCommand() aborted', 'AbortError')
}

/** Always uses the app-wide `defs` singleton (`defs.ts`'s own doc: "the one GeneratedDefs instance the rest of the app consumes") — not parameterized, since `sendCommand`'s Produces signature has no `defs` param and there is no second instance to inject in practice. */
function encodeCommandLong(target: { sysid: number; compid: number }, cmd: CommandLongSpec, confirmation: number): Uint8Array {
  return encodePayload(defs, COMMAND_LONG_MSGID, {
    target_system: target.sysid,
    target_component: target.compid,
    command: cmd.command,
    confirmation,
    param1: cmd.param1 ?? 0,
    param2: cmd.param2 ?? 0,
    param3: cmd.param3 ?? 0,
    param4: cmd.param4 ?? 0,
    param5: cmd.param5 ?? 0,
    param6: cmd.param6 ?? 0,
    param7: cmd.param7 ?? 0,
  })
}

export function sendCommand(
  router: MavRouter,
  target: { sysid: number; compid: number },
  cmd: CommandLongSpec,
  opts: SendCommandOpts = {},
): Promise<CommandAck> {
  const dangerous = DANGEROUS_COMMANDS.has(cmd.command)
  if (dangerous && opts.retries !== undefined && opts.retries > 0) {
    throw new CommandUsageError(
      `sendCommand: command ${cmd.command} is in DANGEROUS_COMMANDS — retries must be 0 (or omitted), got ${opts.retries}`,
    )
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = dangerous ? 0 : (opts.retries ?? DEFAULT_RETRIES)
  const maxAttempts = retries + 1
  const { signal } = opts

  return new Promise<CommandAck>((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError())
      return
    }

    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attemptIndex = 0 // also the `confirmation` value of the most recent send

    const unsubscribe = router.subscribe(
      { msgid: COMMAND_ACK_MSGID, sysid: target.sysid, compid: target.compid },
      (msg) => {
        if (Number(msg.fields.command) !== cmd.command) return

        const result = Number(msg.fields.result)
        const progress = Number(msg.fields.progress)
        const resultParam2 = Number(msg.fields.result_param2)

        if (result === MAV_RESULT_IN_PROGRESS) {
          opts.onProgress?.(progress, resultParam2)
          armTimer() // keep waiting — reset the window, not a retry
          return
        }

        finish(() => resolve({ command: cmd.command, result, progress, resultParam2 }))
      },
    )

    const onAbort = (): void => {
      finish(() => reject(toAbortError()))
    }
    signal?.addEventListener('abort', onAbort)

    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
    }

    function finish(fn: () => void): void {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    function armTimer(): void {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(onTimeout, timeoutMs)
    }

    function onTimeout(): void {
      if (attemptIndex + 1 >= maxAttempts) {
        finish(() => reject(new CommandTimeoutError(cmd.command, attemptIndex + 1)))
        return
      }
      attemptIndex = Math.min(attemptIndex + 1, MAX_CONFIRMATION)
      doSend(attemptIndex)
      armTimer()
    }

    function doSend(confirmation: number): void {
      // Encoding is synchronous and (for COMMAND_LONG's always-numeric
      // fields) shouldn't throw, but this call site is reached both from
      // inside the Promise executor (doSend(0) below) and from a
      // setTimeout callback (onTimeout's retry) — a synchronous throw from
      // the latter would be an unhandled exception that never settles the
      // promise, leaking the subscription/abort-listener forever. Routing
      // any throw through the same finish()/cleanup() path both call sites
      // already use for router.send() failures keeps this uniform.
      let payload: Uint8Array
      try {
        payload = encodeCommandLong(target, cmd, confirmation)
      } catch (err) {
        finish(() => reject(err))
        return
      }
      router.send({ msgid: COMMAND_LONG_MSGID, payload }).catch((err: unknown) => {
        finish(() => reject(err))
      })
    }

    doSend(0)
    armTimer()
  })
}
