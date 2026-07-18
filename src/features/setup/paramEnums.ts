/**
 * Hardcoded parameter/enum metadata for the Setup page (Task 7.1). Real
 * `.pdef.xml` parsing is out of scope for M2 — this is the same "small,
 * known set of ArduPilot params" shortcut the design doc itself takes
 * (`docs/design/novaX-Configurator.dc.html`'s Setup screen), just typed and
 * unit-tested instead of inlined into JSX. Task 7.2 builds the Setup page
 * and its `setupDirty` staging on top of this table; it also owns the
 * actual i18n strings the `labelKey`s below point at.
 *
 * No React here — pure data + types, per the task brief.
 *
 * **Second consumer (Task 9.3):** `features/motors/MotorTestPage.tsx` also
 * reads `FRAME_FIELD` directly — the "layout follows Setup -> Frame" link
 * the Motor Test page's frame diagram and motor count are built from. A
 * future change to `FRAME_FIELD.options`' shape or `motors[]` layout
 * coordinates ripples into that page's safety-relevant motor-count
 * resolution too, not just Setup's own frame tiles.
 *
 * ## Values verified against ArduPilot source, not just the design mock
 *
 * The design mock (and the task brief that transcribed it) got two enums
 * wrong. Both were checked directly against ArduPilot's own parameter
 * metadata comments (`@Values`) on GitHub, across tags `Copter-3.6.0`
 * through `Copter-4.6.0` and `master` — identical in every version checked:
 *
 * - `MOT_PWM_TYPE` (`libraries/AP_Motors/AP_MotorsMulticopter.cpp`,
 *   `@Param: PWM_TYPE`): `0:Normal,1:OneShot,2:OneShot125,3:Brushed,
 *   4:DShot150,5:DShot300,6:DShot600,7:DShot1200,...`. The design/brief had
 *   DShot300=6 and DShot600=7 — those are actually DShot600 and DShot1200.
 *   Writing the brief's numbers would silently misconfigure the ESC
 *   protocol. Corrected below: DShot300=5, DShot600=6.
 * - `BATT_FS_LOW_ACT` (`libraries/AP_BattMonitor/AP_BattMonitor_Params.cpp`,
 *   `@Param: FS_LOW_ACT`, `@Values{Copter}`): `0:None,1:Land,2:RTL,
 *   3:SmartRTL or RTL,4:SmartRTL or Land,...`. The design/brief labeled
 *   value 3 "SmartRTL, else Land" — that's actually value 4; value 3 is
 *   "SmartRTL or RTL". Corrected below: "SmartRTL, else Land" = 4 (value 3
 *   is dropped from the option list rather than mislabeled).
 *
 * `FRAME_CLASS`/`FRAME_TYPE` (`libraries/AP_Motors/AP_Motors_Class.h`'s
 * `motor_frame_class`/`motor_frame_type` enums — Quad=1/Hexa=2/Octa=3,
 * Plus=0/X=1/V=2/H=3) and `BATT_MONITOR`/`FS_THR_ENABLE`/`FS_GCS_ENABLE`
 * were also checked the same way and matched the design/brief exactly — no
 * correction needed there.
 */

/** Which widget a UI renders for a given field. */
export type SetupControlType = 'enum-dropdown' | 'enum-chips' | 'enum-tiles' | 'number'

/** One selectable value of an enum-valued param. `labelKey` is an i18n key (Task 7.2 supplies the strings), not a display string. */
export interface EnumOption {
  value: number
  labelKey: string
  /** Still offered (valid on older firmware) but removed in a later ArduPilot version -- `Failsafes.tsx`'s `FailsafeSelect` flags these with a legacy suffix. A property of this specific option, not derivable from its `value` alone: e.g. `BATT_FS_LOW_FIELD`'s value `2` ("RTL") is current, while `FS_THROTTLE_FIELD`/`FS_GCS_FIELD`'s value `2` ("Continue in Auto") is not (Task 7.1 review finding) -- two fields can assign the same numeric value to unrelated, differently-aged options. */
  legacy?: boolean
}

/** A motor's position within a frame tile's mini-diagram, as a percentage offset (0-100) from the tile's top-left corner — sourced from the design mock's own `frameOpts[].ms` layout coordinates. Index in the array is the motor number (index + 1), matching ArduPilot's own 1-based motor numbering. Purely a visual layout hint: nothing here is written to the flight controller, unlike every other value in this file. */
export interface MotorPosition {
  x: number
  y: number
}

/** One frame tile. Staging this option must write BOTH `FRAME_CLASS` and `FRAME_TYPE` — the design mock's tile `onClick` only staged `FRAME_TYPE`, which is the bug this task brief called out. */
export interface FrameTileOption {
  labelKey: string
  frameClass: number
  frameType: number
  motors: MotorPosition[]
}

export interface FrameFieldMeta {
  id: 'frame'
  controlType: 'enum-tiles'
  titleKey: string
  params: readonly ['FRAME_CLASS', 'FRAME_TYPE']
  options: FrameTileOption[]
}

export interface EnumFieldMeta {
  id: 'escProtocol' | 'battMonitor' | 'fsThrottle' | 'battFsLow' | 'fsGcs'
  controlType: 'enum-dropdown' | 'enum-chips'
  titleKey: string
  param: string
  options: EnumOption[]
}

export interface NumberFieldMeta {
  id: 'battCapacity' | 'battLowVolt'
  controlType: 'number'
  titleKey: string
  param: string
  unit: string
  min?: number
  max?: number
}

export type SetupFieldMeta = FrameFieldMeta | EnumFieldMeta | NumberFieldMeta

export const FRAME_FIELD: FrameFieldMeta = {
  id: 'frame',
  controlType: 'enum-tiles',
  titleKey: 'setup.frame.title',
  params: ['FRAME_CLASS', 'FRAME_TYPE'],
  options: [
    {
      labelKey: 'setup.frame.options.quadX',
      frameClass: 1,
      frameType: 1,
      motors: [
        { x: 78, y: 22 },
        { x: 22, y: 78 },
        { x: 22, y: 22 },
        { x: 78, y: 78 },
      ],
    },
    {
      labelKey: 'setup.frame.options.quadPlus',
      frameClass: 1,
      frameType: 0,
      motors: [
        { x: 50, y: 15 },
        { x: 50, y: 85 },
        { x: 15, y: 50 },
        { x: 85, y: 50 },
      ],
    },
    {
      labelKey: 'setup.frame.options.hexX',
      frameClass: 2,
      frameType: 1,
      motors: [
        { x: 75, y: 20 },
        { x: 25, y: 80 },
        { x: 25, y: 20 },
        { x: 75, y: 80 },
        { x: 15, y: 50 },
        { x: 85, y: 50 },
      ],
    },
    {
      labelKey: 'setup.frame.options.octoX',
      frameClass: 3,
      frameType: 1,
      motors: [
        { x: 72, y: 16 },
        { x: 28, y: 84 },
        { x: 28, y: 16 },
        { x: 72, y: 84 },
        { x: 14, y: 40 },
        { x: 86, y: 60 },
        { x: 14, y: 60 },
        { x: 86, y: 40 },
      ],
    },
  ],
}

export const ESC_PROTOCOL_FIELD: EnumFieldMeta = {
  id: 'escProtocol',
  controlType: 'enum-chips',
  titleKey: 'setup.esc.title',
  param: 'MOT_PWM_TYPE',
  options: [
    { value: 0, labelKey: 'setup.esc.options.pwm' },
    { value: 2, labelKey: 'setup.esc.options.oneShot125' },
    { value: 4, labelKey: 'setup.esc.options.dshot150' },
    { value: 5, labelKey: 'setup.esc.options.dshot300' },
    { value: 6, labelKey: 'setup.esc.options.dshot600' },
  ],
}

/**
 * The DroneCAN ESC enable chain (issue #55, ADR-0005 P1). Deliberately NOT
 * an `EnumOption` of `ESC_PROTOCOL_FIELD`: the DroneCAN chip is not a
 * `MOT_PWM_TYPE` value — its active state is *derived* from the effective
 * values of these three params (`isDroneCanEscActive`), and selecting it
 * stages all three (`setupStore.stageDroneCanEnable`). `MOT_PWM_TYPE` is
 * never touched: CAN ESC output is driven by `SERVOx_FUNCTION` + this
 * bitmask, independent of the physical pins (wiki-confirmed, research note
 * §1). Also deliberately not in `SETUP_FIELDS`: that array is the
 * display-ordered list of standalone cards, while this chip renders inside
 * `ESC_PROTOCOL_FIELD`'s card and its `CanConfig` card is only
 * conditionally revealed.
 *
 * Values verified against ArduPilot source, same rigor as the fields above
 * (`docs/notes/dronecan-gcs-research-2026-07.md` §1, pinned at commit
 * 92b0cd7 / Copter 4.6.3-dev):
 *
 * - `CAN_P1_DRIVER` (`libraries/AP_CANManager/AP_CANIfaceParams.cpp`,
 *   `@Values: 0:Disabled,1:First driver,2:Second driver,3:Third driver`) —
 *   staged as `driverValue` 1, "First driver".
 * - `CAN_D1_PROTOCOL`
 *   (`libraries/AP_CANManager/AP_CANManager_CANDriver_Params.cpp`,
 *   `@Values: 0:Disabled,1:DroneCAN,4:PiccoloCAN,6:EFI_NWPMU,7:USD1,
 *   8:KDECAN,...`) — staged as `protocolValue` 1, "DroneCAN".
 * - `CAN_D1_UC_ESC_BM` (`libraries/AP_DroneCAN/AP_DroneCAN.cpp`) — bitmask,
 *   bit 0 = output 1 … bit 31 = output 32, selecting which outputs are sent
 *   as DroneCAN `esc.RawCommand`; staged as `droneCanEscBitmask()` of the
 *   selected frame's motor count.
 */
export interface DroneCanEscFieldMeta {
  /** CAN configuration card title — the card `SetupPage` reveals when the chain is active or the chip was selected without a frame. */
  titleKey: string
  /** The DroneCAN chip's label in the ESC PROTOCOL card's chip row. */
  chipLabelKey: string
  /** The three enable-chain params, in the exact order they are staged (and therefore written by `writeAll`). */
  params: readonly ['CAN_P1_DRIVER', 'CAN_D1_PROTOCOL', 'CAN_D1_UC_ESC_BM']
  /** Staged into `CAN_P1_DRIVER`: 1 = First driver. */
  driverValue: number
  /** Staged into `CAN_D1_PROTOCOL`: 1 = DroneCAN. */
  protocolValue: number
}

export const DRONECAN_ESC_FIELD: DroneCanEscFieldMeta = {
  titleKey: 'setup.esc.can.title',
  chipLabelKey: 'setup.esc.options.droneCan',
  params: ['CAN_P1_DRIVER', 'CAN_D1_PROTOCOL', 'CAN_D1_UC_ESC_BM'],
  driverValue: 1,
  protocolValue: 1,
}

/** `CAN_D1_UC_ESC_BM` for an N-motor frame: bits 0..N−1 set (bit 0 = output 1), i.e. Quad → 15, Hexa → 63, Octo → 255. Assumes Motor1..N on outputs 1..N, the same layout `FRAME_FIELD` and the Motor Test page assume. */
export function droneCanEscBitmask(motorCount: number): number {
  return (1 << motorCount) - 1
}

/**
 * Issue #55's derived-active rule for the DroneCAN chip: effective
 * `CAN_P1_DRIVER >= 1` (interface bound to any driver slot, not only First)
 * AND `CAN_D1_PROTOCOL == 1` (DroneCAN) AND `CAN_D1_UC_ESC_BM != 0` (at
 * least one output rides CAN). `undefined` (param not on the board, or not
 * read yet) is never active.
 */
export function isDroneCanEscActive(driver: number | undefined, protocol: number | undefined, bitmask: number | undefined): boolean {
  return driver !== undefined && driver >= 1 && protocol === DRONECAN_ESC_FIELD.protocolValue && bitmask !== undefined && bitmask !== 0
}

export const BATT_MONITOR_FIELD: EnumFieldMeta = {
  id: 'battMonitor',
  controlType: 'enum-dropdown',
  titleKey: 'setup.battery.monitor.title',
  param: 'BATT_MONITOR',
  options: [
    { value: 4, labelKey: 'setup.battery.monitor.options.analogVoltageCurrent' },
    { value: 3, labelKey: 'setup.battery.monitor.options.analogVoltageOnly' },
    { value: 0, labelKey: 'setup.battery.monitor.options.disabled' },
  ],
}

export const BATT_CAPACITY_FIELD: NumberFieldMeta = {
  id: 'battCapacity',
  controlType: 'number',
  titleKey: 'setup.battery.capacity.title',
  param: 'BATT_CAPACITY',
  unit: 'mAh',
  min: 0,
}

export const BATT_LOW_VOLT_FIELD: NumberFieldMeta = {
  id: 'battLowVolt',
  controlType: 'number',
  titleKey: 'setup.battery.lowVolt.title',
  param: 'BATT_LOW_VOLT',
  unit: 'V',
  min: 0,
}

export const FS_THROTTLE_FIELD: EnumFieldMeta = {
  id: 'fsThrottle',
  controlType: 'enum-dropdown',
  titleKey: 'setup.failsafes.throttle.title',
  param: 'FS_THR_ENABLE',
  options: [
    { value: 1, labelKey: 'setup.failsafes.throttle.options.rtl' },
    { value: 2, labelKey: 'setup.failsafes.throttle.options.continueAuto', legacy: true },
    { value: 3, labelKey: 'setup.failsafes.throttle.options.land' },
    { value: 0, labelKey: 'setup.failsafes.throttle.options.disabled' },
  ],
}

export const BATT_FS_LOW_FIELD: EnumFieldMeta = {
  id: 'battFsLow',
  controlType: 'enum-dropdown',
  titleKey: 'setup.failsafes.battLow.title',
  param: 'BATT_FS_LOW_ACT',
  options: [
    { value: 1, labelKey: 'setup.failsafes.battLow.options.land' },
    { value: 2, labelKey: 'setup.failsafes.battLow.options.rtl' },
    { value: 4, labelKey: 'setup.failsafes.battLow.options.smartRtlElseLand' },
    { value: 0, labelKey: 'setup.failsafes.battLow.options.none' },
  ],
}

export const FS_GCS_FIELD: EnumFieldMeta = {
  id: 'fsGcs',
  controlType: 'enum-dropdown',
  titleKey: 'setup.failsafes.gcs.title',
  param: 'FS_GCS_ENABLE',
  options: [
    { value: 1, labelKey: 'setup.failsafes.gcs.options.rtl' },
    { value: 2, labelKey: 'setup.failsafes.gcs.options.continueAuto', legacy: true },
    { value: 0, labelKey: 'setup.failsafes.gcs.options.disabled' },
  ],
}

/** Every Setup field, in the design mock's own display order — a UI maps over this directly rather than importing each field individually. */
export const SETUP_FIELDS: readonly SetupFieldMeta[] = [
  FRAME_FIELD,
  ESC_PROTOCOL_FIELD,
  BATT_MONITOR_FIELD,
  BATT_CAPACITY_FIELD,
  BATT_LOW_VOLT_FIELD,
  FS_THROTTLE_FIELD,
  BATT_FS_LOW_FIELD,
  FS_GCS_FIELD,
]
