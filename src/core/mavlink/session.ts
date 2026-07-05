/**
 * `MavSession` bundles the live per-connection objects that M2's feature
 * modules (calibration, motor test, telemetry-driven UI) need, so they can
 * take a single `session` prop instead of each reaching into the connection
 * store's internals for `router`/`paramStore` separately and re-deriving
 * `target` themselves.
 *
 * This is deliberately just a type, not a class: `src/store/connection.ts`
 * owns construction and disposal (same single-shot-per-generation lifecycle
 * as `MavRouter` itself — see that module's doc), and assembles a fresh
 * `MavSession` object literal on every `connect()`.
 */
import type { MavRouter } from './router'
import type { ParamStore } from './params'
import type { Telemetry } from './telemetry'

export interface MavSession {
  router: MavRouter
  target: { sysid: number; compid: number }
  paramStore: ParamStore
  telemetry: Telemetry
}
