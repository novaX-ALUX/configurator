/**
 * Named MAV_CMD (COMMAND_LONG `command` field) constants — single source of
 * truth so M2 call sites (calibration, motor test, telemetry stream setup)
 * reference a name instead of a bare number, and so `DANGEROUS_COMMANDS` in
 * `command.ts` doesn't duplicate the literals it guards.
 *
 * Values are cross-checked against `mavlink-mappings`' compiled `MavCmd`
 * enum (`ardupilotmega.js`/`common.js`, generated from the upstream MAVLink
 * XML) rather than re-exported from it — `defs.ts`'s own doc records that
 * this project's only allowed import of `mavlink-mappings` is through the
 * `GeneratedDefs` adapter, which exposes message defs (`msgIdForName` etc.)
 * but not the `MavCmd` command-id enum, so these stay hardcoded-and-verified
 * constants rather than a re-export.
 */

/** Run accelerometer, gyro, level, or compass calibration. */
export const MAV_CMD_PREFLIGHT_CALIBRATION = 241

/** Request storage of different parameter/mission values on persistent storage. */
export const MAV_CMD_PREFLIGHT_STORAGE = 245

/** Request the reboot or shutdown of system components. */
export const MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN = 246

/** Arm or disarm the vehicle. */
export const MAV_CMD_COMPONENT_ARM_DISARM = 400

/** Spin a specified motor (or all motors) for a bench/pre-flight test. */
export const MAV_CMD_DO_MOTOR_TEST = 209

/** Start onboard magnetometer calibration. */
export const MAV_CMD_DO_START_MAG_CAL = 42424

/** Accept the result of a running magnetometer calibration. */
export const MAV_CMD_DO_ACCEPT_MAG_CAL = 42425

/** Cancel a running magnetometer calibration. */
export const MAV_CMD_DO_CANCEL_MAG_CAL = 42426

/** Tell the vehicle (or report to the GCS) which position to hold during accelerometer calibration. */
export const MAV_CMD_ACCELCAL_VEHICLE_POS = 42429

/** Set the interval (or disable) a message is streamed at, by message id. */
export const MAV_CMD_SET_MESSAGE_INTERVAL = 511

/** Request the target emit a single instance of a specified message ("one-shot" version of SET_MESSAGE_INTERVAL). */
export const MAV_CMD_REQUEST_MESSAGE = 512

/**
 * `REQUEST_DATA_STREAM` (msgid 66) is a *message*, not a MAV_CMD — there is
 * no such command in the MavCmd enum. It's the legacy, MAVLink-1-era way to
 * ask for a data stream, superseded by `MAV_CMD_SET_MESSAGE_INTERVAL` /
 * `MAV_CMD_REQUEST_MESSAGE` above. Kept here as its own group, named and
 * commented distinctly, so it never gets treated as a `COMMAND_LONG.command`
 * value by mistake.
 */
export const MAVLINK_MSG_ID_REQUEST_DATA_STREAM = 66
