# novaX Configurator M2 实施计划(rev2,已按 Codex + ArduPilot 源码核对修订)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已合并的 M1 协议栈之上交付 M2 五个功能面:实时遥测流 + Dashboard、Setup(机架/ESC/电池/失控保护)、传感器校准(加速度计六面 + 罗盘,写入前审查门)、电机测试(六重安全联锁 + 真达飞控的急停)、装机引导抽屉。

**Context:** M1 已合并 main(69 提交,352 测试,真机 SITL 验证)。可复用:`src/core/transport`、`src/core/mavlink`(FrameParser/MavRouter/sendCommand/ParamStore/encode-decode/defs)、连接 store、参数表页、固件页。规格来自 `docs/design/novaX-Configurator.dc.html`(视觉唯一事实源)+ 三份屏规格探查 + Codex 对本地 ArduPilot 源码(`flight_controller/firmware/ardupilot`)的逐条协议核对(2026-07-05,session `019f20fc`)。

**Architecture:** 新增遥测核心层 `telemetry.ts`(流请求+类型化订阅);校准/电机命令走已有 `sendCommand`;**加速度计校准由飞控 → GCS 反向发 `ACCELCAL_VEHICLE_POS`(42429)驱动**,需入站命令订阅;**罗盘 apply 走 `DO_ACCEPT_MAG_CAL`(42425)让飞控原子写全套磁参**,而非手写 `COMPASS_OFS_*`;参数类写入(Setup、undo)走 `ParamStore.set` 回读。features 只依赖 core 公开接口。

**Tech Stack:** 沿用 M1,无新增运行时依赖。

## Global Constraints(承接 M1 + Codex 修订,每任务默认遵守)

- 浏览器 runtime 禁用 Node 专属 API;参数写入用 ParamStore.set 回读确认,不绕过
- **危险命令白名单必须扩充**(Task 5.1):现有 `DANGEROUS_COMMANDS` 仅含 241/245/246/400/209,缺 **42424(DO_START_MAG_CAL)/42425(DO_ACCEPT_MAG_CAL)/42426(DO_CANCEL_MAG_CAL)/42429(ACCELCAL_VEHICLE_POS)**——校准/电机命令 retries=0 的前提依赖此扩充
- **校准与电机是全项目最高风险面**:任何参数修改显式告知 + 可撤销 + 记会话日志。罗盘结果先审查后写入,绝不静默。**罗盘校准启动会隐式写 `COMPASS_LEARN=0`——必须在 UI 与日志明确告知**(不是"零写入")
- **电机急停必须真达飞控**:ArduCopter motor test 内部 soft-arm 并按 `timeout_sec` 持续输出。采用**短超时续期模型**——每条测试命令给 0.5–1s timeout,UI 活跃时续期;`stop()` best-effort 发 percent=0/timeout=0 停止命令;ACK 超时按"可能已生效"处理。UI 状态机单独不足以保证停转。
- 电机 `throttle_type=0` 才是 percent(`1=PWM`,设计假设曾写反);电机 param1 是 **1-based 电机序号(test order)**,非 SERVO 输出通道
- UI 文案走 i18next(en 全量,zh/ko/ja key 齐);视觉以设计稿为准,token 复用 M1 Task 3.0
- 断连是常态:遥测流断连时停止,重连重新请求;校准/电机断连 → 安全态 + 诚实提示
- npm test / tsc / lint / build 全绿;conventional commits;MockTransport 驱动 TDD

**M2 降级/后置**(Codex 建议):自动映射向导**默认降级为"逐电机测试 + 用户手动指认"**,M2 不自动写 SERVOx_FUNCTION;Dashboard 3D 姿态与复杂电池百分比砍(优先显示 `battery_remaining`,未知则显电压不显百分比);多罗盘做 fan-out 数据结构 + report 表,不做复杂可视化;pdef 参数元数据后置(Setup 硬编码枚举);控制台不在本轮 M2 范围(spec 原列 M2,本轮明确排除)。

---

## Phase 5 — 遥测流核心层 + 会话管线

### Task 5.1: 扩充危险命令白名单 + 命令 id 常量

**Files:** Modify: `src/core/mavlink/command.ts`(DANGEROUS_COMMANDS);Create: `src/core/mavlink/commandIds.ts`(具名常量);Test: 更新 command.test.ts

- 向 DANGEROUS_COMMANDS 加入 42424/42425/42426/42429;新增具名常量文件(DO_START_MAG_CAL/DO_ACCEPT_MAG_CAL/DO_CANCEL_MAG_CAL/ACCELCAL_VEHICLE_POS/DO_MOTOR_TEST/SET_MESSAGE_INTERVAL/REQUEST_DATA_STREAM/PREFLIGHT_CALIBRATION/REQUEST_MESSAGE…)供后续任务引用
- 测试:每个新增 id `retries>0` 抛 CommandUsageError;单发验证
- Commit

### Task 5.2: 遥测流请求 + 类型化订阅 `telemetry.ts`

**Files:** Create: `src/core/mavlink/telemetry.ts`;Test: `__tests__/telemetry.test.ts`

**Interfaces(Produces):**
```ts
interface TelemetryState {                    // 最新值,已做单位换算,字段可空
  attitude?: { rollDeg: number; pitchDeg: number; yawDeg: number; ts: number }   // ATTITUDE 弧度→度
  power?: { voltage?: number; current?: number; batteryRemaining?: number; ts: number } // mV→V, cA→A, -1→undefined
  gps?: { fixType: number; satellites: number; hdop?: number; ts: number }        // eph==UINT16_MAX→undefined
  rc?: { channels: number[]; rssi?: number; ts: number }
  servo?: { outputs: number[]; ts: number }
  heartbeat?: { armed: boolean; customMode: number; baseMode: number; systemStatus: number; ts: number }
}
class Telemetry {
  constructor(router: MavRouter, target: { sysid: number; compid: number },
    opts?: { sendCommandFn?: ...; now?: () => number })
  requestStreams(msgRates?: Partial<Record<TelemetryMsg, number>>): Promise<void> // SET_MESSAGE_INTERVAL(511) per msg
  stopStreams(): Promise<void>                 // interval_us=-1 per msg;断连前调用
  getState(): Readonly<TelemetryState>
  subscribe(cb: (s: Readonly<TelemetryState>) => void): () => void  // 节流 ~10Hz
  dispose(): void
}
```
- **单位/哨兵值全部在此换算**(Codex):ATTITUDE rad→deg;SYS_STATUS voltage mV→V、current cA→A、battery_remaining=-1→undefined;GPS eph=UINT16_MAX→undefined
- `requestStreams` 用 SET_MESSAGE_INTERVAL(511)逐条(ATTITUDE/SYS_STATUS/GPS_RAW_INT/RC_CHANNELS/SERVO_OUTPUT_RAW);ACK 拒绝/旧固件回退 REQUEST_DATA_STREAM(66)按 stream group(**非逐消息等价,注释说明**);stopStreams 用 interval_us=-1
- 订阅通知节流(注入 now,不硬绑 Date.now);断连(router linkState lost/idle)冻结快照;dispose 退订
- TDD:feed 各消息帧 → getState 换算正确;511 命令编码;回退路径;节流;断连冻结;dispose 无泄漏
- Commit

### Task 5.3: fixture 扩展

**Files:** Modify: `scripts/gen-fixtures.py`;committed fixture 输出

- pymavlink 追加:ATTITUDE/SYS_STATUS/GPS_RAW_INT/RC_CHANNELS/SERVO_OUTPUT_RAW/HEARTBEAT(armed+disarmed)、**入站 COMMAND_LONG cmd=42429(ACCELCAL_VEHICLE_POS,各 face + success/failure)**、**MAG_CAL_PROGRESS(191)/MAG_CAL_REPORT(192)**、**COMMAND_ACK for DO_MOTOR_TEST**;`frames.expected.json` 带权威解码值
- Commit

### Task 5.4: 从连接 store 暴露受控 MavSession

**Files:** Modify: `src/store/connection.ts`;Create: `src/core/mavlink/session.ts`(轻封装)

- 现状:connection store 只暴露 `paramStore`。M2 的校准/电机/遥测类都需要 router+target。暴露一个受控 `MavSession { router, target, paramStore, telemetry }`(或等价 getter),生命周期与连接绑定(M1 router 单发事实:重连重建整个 session)
- 测试:连接→session 可用;断连→session 置空 + 各成员 dispose;重连重建
- Commit

## Phase 6 — Dashboard

### Task 6.1: 遥测生命周期接线

**Files:** Modify: `src/store/connection.ts`(连接构建 Telemetry+requestStreams,断连 stopStreams+dispose);Create: `src/features/dashboard/useTelemetry.ts`

- 与 ParamStore 生命周期并列;重连重建;hook 提供节流快照
- 测试:连接→请求;断连→停止;重连→重建(MockTransport)
- Commit

### Task 6.2: Dashboard 页

**Files:** Create: `src/features/dashboard/{DashboardPage.tsx, AttitudeIndicator.tsx, PowerCard.tsx, GpsCard.tsx, RcChannelsCard.tsx, MotorOutputsCard.tsx, VehicleCard.tsx}`

- 按设计稿:2D 人工地平线 + 航向带;VEHICLE(armed/飞行模式/预解锁/机架);POWER(**优先 battery_remaining;无则显电压不显百分比**——不默认 4S 13.2–16.8);GPS(fix/sats/hdop,fix_type 决定色标);MOTOR OUTPUTS(SERVO 归一柱);RC(8 通道 + 原始 PWM)
- 飞行模式:HEARTBEAT.custom_mode → ArduCopter 模式名(内置表)
- 断连空状态;只读
- 测试:各卡片给定快照渲染;fix_type/armed 分支;未知电量分支;空状态
- Commit

## Phase 7 — Setup 页

### Task 7.1: 参数枚举元数据 `paramEnums.ts`

**Files:** Create: `src/features/setup/paramEnums.ts`;Test

- 硬编码枚举:FRAME_CLASS/FRAME_TYPE、MOT_PWM_TYPE、BATT_MONITOR、BATT_CAPACITY(num)、BATT_LOW_VOLT(num)、FS_THR_ENABLE、BATT_FS_LOW_ACT、FS_GCS_ENABLE
- **机架 tile 点击须同时暂存 FRAME_CLASS 与 FRAME_TYPE**(设计稿只写 FRAME_TYPE 是缺陷:Quad=1/Hex=2/Octo=3)
- Commit

### Task 7.2: setupDirty 暂存 store + Setup 页

**Files:** Create: `src/features/setup/{SetupPage.tsx, FrameSelector.tsx, EscProtocol.tsx, BatteryMonitor.tsx, Failsafes.tsx, SetupDirtyBar.tsx, setupStore.ts}`

- setupStore:字段从 ParamStore 现值初始化;控件 onChange 乐观更新 + 暂存(按 param 去重);sticky pending 条 `PARAM → value` chips
- "Write to board":逐个 ParamStore.set 回读,三态(复用 Task 3.2 写入 UX),失败保留标红;"Revert":恢复 ParamStore 最后已知值(非硬编码常量)
- 触碰 FS*/BATT_FS* 置 fsTouched(供引导);机架/ESC 显式写过置对应 touched 标志(供引导 step2 真实检测)
- 断连:pending 清空 + 提示
- 测试:暂存/去重/写入混合/revert 恢复真实值/断连清空/touched 标志
- Commit

## Phase 8 — 传感器校准

### Task 8.1: 加速度计校准协议 `accelCal.ts`(入站命令驱动)

**Files:** Create: `src/core/mavlink/accelCal.ts`;Test(MockTransport + 脚本化入站 42429)

**实现前须核对**(Codex 强调,implementer 在 Task 内先读 `libraries/AP_AccelCal/AP_AccelCal.cpp`):飞控周期性向 GCS 发 **COMMAND_LONG cmd=42429(ACCELCAL_VEHICLE_POS)**,param1 编码当前 face 与 success/failure。前端**以入站 42429 驱动 UI**,STATUSTEXT 仅显示/兜底。capture-confirm 的确切回发机制以源码为准。

**Produces:**
```ts
class AccelCalibration {
  constructor(session, opts?)
  start(): Promise<void>                        // PREFLIGHT_CALIBRATION param5=1(转 COMMAND_INT.x==1)
  onFacePrompt(cb: (face: AccelFace) => void): () => void   // 订阅入站 42429,按 param1 映射 face
  captureFace(): Promise<void>                  // 按源码确认的回发机制推进(非旧 ACK 路径——源码注释称其不安全)
  abandon(): Promise<void>                       // ⚠ 无外部 MAVLink cancel;这是"放弃 UI + 断开状态",不宣称飞控已取消
  readonly status: 'idle'|'running'|'busy'|'done'|'failed'
  onComplete(cb: (ok: boolean, message?: string) => void): () => void  // 42429 success/failure 或 STATUSTEXT
  dispose(): void
}
```
- 面序列 level→left→right→nosedown→noseup→back;**校准边界说明**:ArduPilot 最后一面成功后自行调用 `_acal_save_calibrations()` 写 INS_ACC*,浏览器无可审查中间参数——故审查门只用于罗盘。**但断连提示不能写"nothing written"**:最后阶段断连可能已保存,提示改为"校准未完成/结果未知,重连后请核对并从 face 1 重做"
- abandon 语义诚实(无真取消命令)
- Commit

### Task 8.2: 罗盘校准协议 `magCal.ts`(accept 命令写入)

**Files:** Create: `src/core/mavlink/magCal.ts`;Test

**实现前须核对**:`libraries/AP_Compass/AP_Compass_Calibration.cpp`——start 会保存 `COMPASS_LEARN=0`(隐式写参);report 到达后飞控**不改参数**;accept 命令让飞控原子写 offsets/diagonals/offdiagonals/scale(可能含 orientation)。

**Produces:**
```ts
class MagCalibration {
  constructor(session, paramStore, opts?)
  start(): Promise<void>   // 自请求 MAG_CAL_PROGRESS(191)+MAG_CAL_REPORT(192) 的 message interval(EXTRA3,非 Dashboard 流);
                           // DO_START_MAG_CAL autosave=0(不自动保存,等审查);告知用户 COMPASS_LEARN 将置 0
  cancel(): Promise<void>  // DO_CANCEL_MAG_CAL(42426)
  onProgress(cb: (p: { compassId: number; completionPct: number; calStatus: number; attempt: number; direction: ... }) => void): () => void  // 字段按 ardupilotmega.xml,非"samples"
  onReport(cb: (r: MagCalReport) => void): () => void   // fitness, ofs/diag/offdiag/scale, compass_id, cal_status;每 compass_id 一份
  buildReview(report: MagCalReport): Promise<CompassDiff[]>  // 对比 ParamStore 现值,展示将变更的磁参(offsets 及 report 携带的其余)
  accept(): Promise<void>  // DO_ACCEPT_MAG_CAL(42425) — 飞控原子写;成功后从 ParamStore 回读确认新值
  undo(prevValues: CompassParamSnapshot): Promise<void>  // 用 accept 前快照 ParamStore.set 回写
  stopStreams(): Promise<void>  // 结束时把 191/192 interval 置 -1
  dispose(): void
}
```
- **审查门核心**:report → 不自动写(autosave=0)→ buildReview 对比现值 → UI 展示 before/after → 用户确认 → accept(飞控写)→ 回读确认 → 记日志(before 值持久留存)。undo 用 accept 前快照回写。
- **COMPASS_LEARN=0 隐式写**:start 时显式告知 + 记日志(诚实,非"零写入")
- 多罗盘:progress/report 带 compass_id,fan-out 每罗盘一份数据结构 + 一行 review(基础支持)
- fitness 低于阈值:report 携带 fitness/cal_status,UI 给"poor fitness"警示
- Commit

### Task 8.3: 校准页 UI

**Files:** Create: `src/features/calibration/{CalibrationPage.tsx, AccelCard.tsx, CompassCard.tsx, CompassReviewTable.tsx, OrientationNote.tsx}`

- 按设计稿:加速度计卡(六面/旋转示意/逐面进度段/capture/abandon)、罗盘卡(进度环/completion_pct/cancel)、罗盘审查态(before/after diff 表 + Write(=accept)/Discard)、已写态(undo/recalibrate)、中断横幅(诚实文案,见 8.1)
- **补设计稿缺口**:显示当前 AHRS_ORIENTATION(只读);COMPASS_LEARN=0 变更在启动时明示;多罗盘每罗盘一环/一行
- 持久审查原则条
- 测试:加速度面推进(脚本化入站 42429)/断连诚实提示;罗盘 progress→report→审查→accept→回读→undo;COMPASS_LEARN 告知;fitness 低警示;方向展示;多罗盘
- Commit

## Phase 9 — 电机测试 + 安全联锁

### Task 9.1: 安全联锁引擎 `motorSafety.ts`(纯逻辑,极高覆盖)

**Files:** Create: `src/features/motors/motorSafety.ts`;Test(注入 clock + 事件,要求分支全覆盖)

**Produces:**
```ts
type SafetyState = 'locked'|'counting'|'ready'|'testing'
class MotorSafety {
  constructor(opts: { now; onStop: (reason: string) => void; onRenew: (activeMotors) => void; countdownMs?; idleLockMs?; spinIdleMs?; renewMs? })
  propsConfirmed: boolean
  confirmProps(v: boolean): void      // 取消确认且非 locked → stop('Prop confirmation revoked')
  enable(): void                       // 需 propsConfirmed;locked→counting(3s)→ready
  tick(): void                         // spinning 5s 无输入→stop;armed 30s 空闲→stop;**testing 中按 renewMs 触发 onRenew 续期飞控命令**
  noteActivity(): void
  setSpinning(any: boolean, activeMotors): void   // ready⇄testing
  stop(reason: string): void           // 清零→locked→onStop(reason)(页面据此发飞控停止命令)
  readonly state; readonly countdown; readonly idleLeft; readonly stopLeft
}
```
- 六重急停 + 两超时逐一测试(快进 5s/30s 边界);拆桨门;倒计时;**新增 onRenew**:testing 中周期性回调,页面据此对活跃电机重发短超时测试命令(短超时续期模型的 UI 侧)
- 100% 分支覆盖 + 每个 kill-switch 独立测试
- Commit

### Task 9.2: 电机测试命令 `motorTest.ts`

**Files:** Create: `src/features/motors/motorTest.ts`;Test(MockTransport)

**Produces:** `runMotorTest(session, { motorSeq, throttlePercent, timeoutS }): Promise<CommandAck>`
- **DO_MOTOR_TEST(209):throttle_type=0(percent,修正)**;param1 = **1-based 电机序号(test order,非 SERVO 通道)**,命名与文档写清;throttlePercent 上限 30 硬夹;**timeoutS 默认 0.5–1s(短超时续期)**
- `stopMotorTest(session)`:best-effort 发 percent=0、timeout=0 停止;ACK 超时按"可能已生效"返回(不抛)
- 209 已在 DANGEROUS_COMMANDS(retries=0);上限在此再夹一次
- 测试:命令编码(throttle_type=0、motorSeq、上限夹紧、短超时);stop 编码;ACK 超时不抛
- Commit

### Task 9.3: 全局安全横幅 + 电机测试页

**Files:** Create: `src/features/motors/{MotorTestPage.tsx, MotorLayout.tsx, SafetyGate.tsx, MotorSliders.tsx, ManualMapGuide.tsx}`;Modify: `src/App.tsx`(全局红/琥珀横幅,auto 行,安全态驱动)

- 按设计稿:三步安全进度条、机架布局图(联动 Setup 机架)、拆桨门卡、逐电机滑块(0–30% 上限,disabled 除非 ready/testing)、序列测试、全局横幅(MOTOR TEST ACTIVE / MOTOR OUTPUTS ENABLED + 自动停倒计时 + STOP/LOCK)
- **急停接线**:window blur、visibilitychange hidden、Escape、离开页面(nav)、撤销拆桨、STOP 按钮 → MotorSafety.stop → **页面据 onStop 发 stopMotorTest 到飞控**;200ms tick;onRenew → 对活跃电机重发短超时命令
- **自动映射降级(Codex)**:M2 做 `ManualMapGuide`——逐电机测试 + 引导用户在布局图核对/手动指认顺序,**不自动写 SERVOx_FUNCTION**。若后续要自动改参另开任务(需真机)。
- 测试:安全门 gating、滑块上限、序列、六急停各路径(jsdom 事件)+ 每次 stop 发飞控停止命令、续期重发、横幅态、手动指认引导
- Commit

## Phase 10 — 装机引导抽屉

### Task 10.1: Setup Guide 抽屉

**Files:** Create: `src/features/guide/{SetupGuideDrawer.tsx, guideSteps.ts}`;Modify: `src/layout/Sidebar.tsx`、`src/App.tsx`

- 右侧滑入抽屉(scrim 关闭),5 步只读检测:①连接&拉参 ②机架&ESC ③校准(accelDone&&compassApplied)④电机测试 ⑤失控保护;进度条 N/5;"Open page"路由(不强制线性);Skip/×/scrim 关闭
- 完成检测:②用 setupStore 的机架/ESC touched 标志(修正设计稿 connected 占位);⑤fsTouched。全只读,引导绝不改参(页脚声明)
- 测试:各步派生、路由、关闭
- Commit

## Phase 11 — M2 验收

- [ ] `npm test` 全绿;`tsc`/`lint`/`build` 干净
- [ ] `SITL=1 npm test`:遥测流请求后 ATTITUDE/SYS_STATUS 到达;Setup 写回读;**罗盘 start→report(参数未变)→accept(参数变)→undo**(ArduPilot autotest 已有该流程可对照);电机测试命令 ACK(disarmed 下验证 throttle_type/motorSeq 编码与 ACK,不实际转桨)
- [ ] 真机 AF-F4 nano 新增清单:Dashboard 实时遥测、Setup 写参、加速度计六面(入站 42429 驱动)、罗盘审查门 + COMPASS_LEARN 告知、**电机测试六重急停逐一实测 + 拆桨 + 验证 stop 真达飞控 + 续期**、装机引导
- [ ] 最终全分支审查(最强模型),重点电机急停真达飞控 + 罗盘 accept 边界 + 加速度计入站驱动
- [ ] superpowers:verification-before-completion 复核

## 后续(不在本计划)

日志/地图/图表/RTK/PX4/Betaflight、3D 姿态、pdef 元数据、自动映射自动写参(需真机)、控制台完整版、自托管字体、LGPL 公开发布签核(人工)。
