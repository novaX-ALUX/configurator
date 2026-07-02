# novaX Configurator M1 实施计划(rev2,已按 Codex 评审修订)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 novaX Configurator 的 M1:浏览器端 MAVLink 核心栈 + 连接顶栏(含 STATUSTEXT/heartbeat 调试面板)+ 参数表 + 固件更新页(串口正常更新 + F4 DFU 救砖),外加 flight_controller 侧 manifest 生成。完整 MAVLink 控制台移至 M2(与 spec 里程碑对齐)。

**Context:** 依据已批准 spec(`GC/docs/superpowers/specs/2026-07-02-novax-configurator-design.md`)与 Codex 计划评审(2026-07-02,session `019f20fc-...674f`)。工作量校准:单人全职约 8–12 周;若需压缩,砍的顺序见"M1 明确不做"。

**Architecture:** React 18 + Vite + TS SPA;core(transport / mavlink / firmware)与 features 分层;消息定义 provider 由 Phase 0 spike 锁定(mavgen TS 优先,mavlink-mappings 锁版本备胎);固件 manifest 由 flight_controller release 流水线生成。**执行顺序(Codex 建议):脚手架 → spikes 并锁定决策 → manifest 数据契约 → MAVLink core → 功能页。**

**Tech Stack:** React 18, Vite, TypeScript, Zustand, Tailwind CSS, i18next(en 全量,zh/ko/ja 只保证 key 存在), Vitest;Node SITL 桥;Python(gen_manifest.py)。

## Global Constraints(摘自 spec,每任务默认遵守)

- 浏览器 runtime 禁用 Node 专属 API(`Uint8Array/DataView`,不用 `Buffer`);不引入 `node-mavlink` runtime
- 参数写入必须 `PARAM_VALUE` 回读确认;危险命令不盲目重传
- 擦除前硬门:bootloader board_id == `.apj` board_id 且 sha256 通过;`AUTOPILOT_VERSION` 仅展示,**不用于任何门禁或列表过滤**(AF-F4_T10 不回该消息)
- 软件进 DFU 仅 F4 系 novaX 板;DFU 全片擦除前必须过 chip guard(容量/家族)
- 破坏性流程(erase/program)封装在状态机内,公开 API 不可绕过 guard
- 深色主题、桌面 1280px;页面先按线框实现,视觉规格待并行 UI/UX 设计稿
- npm、Vitest、conventional commits

**M1 明确不做**(Codex 砍单):完整 MAVLink 控制台、PWA 安装打磨、zh/ko/ja 完整翻译、按组件的精细丢包统计、虚拟滚动消息浏览器、参数元数据(pdef)。

---

## Phase 0 — 脚手架 + 风险打样(结论是后续阶段的硬门)

### Task 0.1: Vite + React + TS 脚手架与布局壳

**Files:** Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/layout/{Sidebar.tsx,TopBar.tsx}`, `src/i18n/{index.ts,en.json,zh.json,ko.json,ja.json}`, `src/types/webserial.d.ts`(Web Serial/WebUSB 类型声明), `.github/workflows/deploy.yml`, `.gitignore`, `eslint.config.js`

- [ ] Vite react-ts 模板 + Tailwind + Zustand + i18next + Vitest;GitHub Pages `base` 配置
- [ ] 布局壳:左侧图标导航(M1 三页 + 占位)+ 顶部连接栏占位;基础深色色板
- [ ] `npm run build`、`npm test` 绿;deploy.yml 部署成功;Commit

### Task 0.2: mavgen TypeScript 打样

**Files:** Create: `docs/notes/mavgen-spike.md`, `scripts/gen-mavlink.sh`

- [ ] 运行 mavgen TypeScript 生成器(dialect `ardupilotmega`),检查:无 Node 依赖、序列化 API 形态、**CRC_EXTRA 可编程获取**、体积
- [ ] 不可用则回退:锁 `mavlink-mappings@1.0.20`,只 import 所需模块,实测 bundle
- [ ] Commit

### Task 0.3: GitHub Releases CORS 验证

**Files:** Create: `docs/notes/releases-cors-spike.md`

- [ ] 浏览器 fetch Release 资产(跟随 objects.githubusercontent.com 重定向)与 `api.github.com` releases API,记录 CORS 行为
- [ ] 不通则回退:manifest+固件镜像进本站 `public/firmware/`
- [ ] Commit

### Task 0.4: 选型锁定记录(Phase 1+ 的硬门)

**Files:** Create: `docs/notes/decisions-m1.md`

- [ ] 锁定并记录:消息定义 provider 及其 API 形态、CRC_EXTRA 获取方式、bundle 预算、manifest URL 策略(直连 or 镜像)、fetchManifest 的最终 URL 规则
- [ ] **后续所有接口按此文件为准;未锁定不得进入 Phase 1**
- [ ] Commit

## Phase 1 — manifest 数据契约(先于 MAVLink core,Codex 建议)

### Task 1.1: flight_controller 侧 `gen_manifest.py`

**Files(flight_controller 仓库,单独提交):** Create: `scripts/gen_manifest.py`;Modify: `scripts/release.sh`

- [ ] 输入源:**`releases/<board>/ardupilot/manifest.txt` 与 `.apj` 文件本身**(`.apj` 内 `board_id` 为主,hwdef `APJ_BOARD_ID` 交叉校验,不一致即报错;**不读当前 `VERSION` 标旧产物**——现有 releases 目录就存在 VERSION=0.2.3 而产物是 0.2.0 的漂移)
- [ ] 输出 spec §7 schema:`boardName, apjBoardId, hwdefBoardId, mcuFamily, vehicle, version, gitHash, files[{kind, url, sha256, size}], method, softwareDfuAllowed(F4=true), dfuRecoveryAllowed`;**URL 必须复用 release.sh 的最终资产命名规则**(tag/board 重命名逻辑),生成确定的 download URL
- [ ] `release.sh`:在 upload 前调用生成器,`manifest.json` 加入同批 assets;`DRY_RUN=1` 验证
- [ ] 单测:对 releases/ 现有产物跑一遍,校验 sha256/URL/board_id 一致性;Commit

### Task 1.2: configurator 侧 `manifest.ts` 消费契约

**Files:** Create: `src/core/firmware/manifest.ts`;Test: `src/core/firmware/__tests__/manifest.test.ts`(fixture: Task 1.1 生成的真实 manifest.json)

**Produces:** `fetchManifest(): Promise<BoardFirmware[]>`、`matchBoards(manifest, bootloaderBoardId): BoardFirmware[]`
- [ ] 按 Task 0.4 锁定的 URL 策略实现;schema 校验;网络失败→缓存/降级为本地文件模式
- [ ] Commit

## Phase 2 — MAVLink core(TDD;fixture `.bin + expected.json` 入库,CI 不依赖 pymavlink)

### Task 2.1: transport 抽象

**Files:** Create: `src/core/transport/{types.ts,serial.ts,websocket.ts,mock.ts}`;Test: `src/core/transport/__tests__/`

**Produces:**
```ts
interface Transport {
  open(opts?: { signal?: AbortSignal }): Promise<void>
  close(): Promise<void>                                  // 幂等
  readonly readable: ReadableStream<Uint8Array>            // open 后可用的 one-shot 流,生命周期随连接
  write(data: Uint8Array): Promise<void>                   // close 后调用必须 reject
  onDisconnect(cb: (reason: string) => void): () => void   // 返回退订函数
}
class SerialTransport implements Transport { constructor(port: SerialPort, baud: number) }
class WebSocketTransport implements Transport { constructor(url: string) }
class MockTransport implements Transport { feed(bytes: Uint8Array): void; sent: Uint8Array[] }
```
- [ ] 契约测试套件对三个实现复用,覆盖:分片到达、close 后 stream 结束语义、读中途断连、write 拒绝、幂等 close、退订
- [ ] Commit

### Task 2.2: 帧层 `frame.ts`(defs 注入)

**Files:** Create: `src/core/mavlink/{frame.ts,crc.ts,decode.ts}`;Test: `__tests__/frame.test.ts`, `__tests__/decode.test.ts`;Create: `scripts/gen-fixtures.py`(pymavlink 生成 `.bin+expected.json`,产物入库)

**Produces:**
```ts
interface MavFrame { version: 1 | 2; sysid: number; compid: number; msgid: number; seq: number; payload: Uint8Array /* raw, 截断态 */; incompatFlags: number; signed: boolean }
class FrameParser {
  constructor(defs: { crcExtraForMsgId(msgid: number): number | undefined })
  push(bytes: Uint8Array): MavFrame[]
  readonly stats: { received: number; crcErrors: number; badMsgId: number; dropped: number }
}
function encodeFrame(defs, msg: { msgid: number; payload: Uint8Array }, seq: number, sysid: number, compid: number): Uint8Array  // 发送端截尾零
// decode.ts:补零发生在这里,不在 frame 层
function decodePayload(defs, frame: MavFrame): DecodedMessage
```
- [ ] TDD:CRC+CRC_EXTRA(未知 msgid 计 badMsgId 丢弃)、补零解码/首字节不裁、坏流重同步、signed incompat 丢弃、MAVLink1 兼容
- [ ] Commit

### Task 2.3: 路由 `router.ts`

**Files:** Create: `src/core/mavlink/router.ts`;Test: `__tests__/router.test.ts`

**Produces:**
```ts
class MavRouter {
  constructor(transport: Transport, defs: GeneratedDefs, opts: { sysid: number; compid: number })  // 源 ID 可配,默认 255/190
  subscribe(filter: { msgid?: number; sysid?: number; compid?: number }, cb: (msg: DecodedMessage, frame: MavFrame) => void): () => void
  send(msg: EncodableMessage): Promise<void>
  getComponents(): ReadonlyMap<string, ComponentInfo>     // 只读快照,heartbeat 注册表
  readonly linkState: 'idle' | 'connecting' | 'connected' | 'lost'
  onLinkState(cb: (s: LinkState) => void): () => void
}
```
- [ ] TDD:heartbeat→connected、超时→lost、多组件并存、退订;丢包统计只做全链路计数(按组件细分已砍)
- [ ] Commit

### Task 2.4: 命令层 `command.ts`

**Files:** Create: `src/core/mavlink/command.ts`;Test: `__tests__/command.test.ts`

**Produces:**
```ts
function sendCommand(router: MavRouter, target: { sysid: number; compid: number }, cmd: CommandLongSpec,
  opts?: { timeoutMs?: number; retries?: number; signal?: AbortSignal }): Promise<CommandAck>
// DANGEROUS_COMMANDS(校准、PREFLIGHT_REBOOT_SHUTDOWN 等)强制 retries=0,编译期集合
```
- [ ] TDD:ACK 按 command 字段关联、IN_PROGRESS 续等、超时重传、危险命令不重传、Abort
- [ ] Commit

### Task 2.5: 参数协议 `params.ts`

**Files:** Create: `src/core/mavlink/params.ts`;Test: `__tests__/params.test.ts`

**Produces:**
```ts
class ParamStore {
  constructor(router: MavRouter, target: { sysid: number; compid: number })
  fetchAll(opts?: { signal?: AbortSignal; onProgress?: (got: number, total: number) => void }): Promise<void>
  get(name: string): Param | undefined
  set(name: string, value: number, opts?: { signal?: AbortSignal }): Promise<Param>
  readonly all: ReadonlyMap<string, Param>   // Param 含 param_type;param_id 按 16 字节规则编解码
  onChange(cb: (p: Param) => void): () => void
}
```
- [ ] TDD:乱序/重复/补洞多轮限次、param_count 变化容错、set 回读(float tolerance 比较;飞控 clamp→reject 携带实际值)、被动 PARAM_VALUE 更新
- [ ] Commit

### Task 2.6: SITL 桥(手动/夜间 gate,CI 主验证靠 fixture)

**Files:** Create: `tools/sitl-bridge.mjs`, `docs/notes/sitl.md`;Test: `src/core/__tests__/sitl.integration.test.ts`(`SITL=1` 启用)

- [ ] ws↔tcp:5760 透传;文档写清用 flight_controller 子模块起 SITL
- [ ] 集成测试:连接→heartbeat→fetchAll→**保存旧值→写参→回读→恢复旧值**(不污染 SITL 状态)
- [ ] Commit

## Phase 3 — M1 功能页

### Task 3.1: 连接顶栏 + STATUSTEXT 调试面板

**Files:** Create: `src/store/connection.ts`, `src/layout/TopBar.tsx`(实装), `src/features/debug/StatusPanel.tsx`

- [ ] 顶栏:requestPort(filter VID 0x1209,允许无 filter 手选)、波特率、连接/断开、linkState 徽标、识别信息(AUTOPILOT_VERSION,**仅展示;收不到就显示"未知板型"不阻塞任何功能**)
- [ ] StatusPanel:仅 STATUSTEXT 流(severity 着色)+ heartbeat/链路统计;完整控制台在 M2
- [ ] 断连 toast 与各页空状态;SITL + 真机各验一次;Commit

### Task 3.2: 参数表页

**Files:** Create: `src/features/params/{ParamsPage.tsx,ParamRow.tsx,DiffDrawer.tsx}`

- [ ] 拉取进度、搜索/前缀分组、diff 抽屉、批量写入逐个回读显示、失败标红保留、未保存离开警示
- [ ] 普通表格分页/截断即可(虚拟滚动已砍);Commit

### Task 3.3: 固件引擎(重写,保留 parts-catalog 全部真机验证行为)

**Files:** Create: `src/core/firmware/{apj.ts,intelhex.ts,px4bl.ts,dfu.ts}`;Test: 各自 `__tests__`(apj/hex 纯函数全测;px4bl 用 MockTransport 测协议序列;dfu 用 mock USBDevice)

**Produces:**
```ts
function parseApj(buf: ArrayBuffer): { boardId: number; image: Uint8Array; imageSize: number; ... }
function parseIntelHex(text: string): { segments: { addr: number; data: Uint8Array }[] }
class Px4Flasher {   // 状态机:idle→identified→verified→erasing→programming→verifying→done/failed
  constructor(transport: Transport)
  identify(): Promise<{ boardId: number; flashSize: number; blRev: number }>   // 必须先 INFO_BL_REV(真机验证的顺序坑)
  flash(apj: ParsedApj, onProgress: Progress): Promise<void>
  // flash() 内部前置断言 identify 完成且 apj.boardId === identified.boardId 且镜像 ≤ flashSize;guard 之外无 erase 入口
}
class Stm32Dfu {     // WebUSB 0483:DF11,DfuSe 协议
  flashInfo(): Promise<{ family: 'F4'|'F7'|'H7'|'unknown'; flashKB: number; sectors: Sector[] }>  // layout 不可得时读字符串描述符回退
  flash(segments: HexSegments, onProgress: Progress): Promise<void>  // 前置 chip guard:family/容量必须与所选固件匹配;全片擦除;自适应 chunk 回退
}
```
- [ ] 参考(只读):`marketing/parts-catalog/src/scripts/update/*.ts` + `update.astro` 状态机;保留:reboot-to-bootloader MAVLink 帧、软件进 DFU magic(42/24/71/99,仅 F4)、WebUSB fresh-gesture 两步授权、erase 前先关串口
- [ ] sha256(WebCrypto)在解析后、任何破坏性操作前;Commit(每模块单独)

### Task 3.4: 固件更新页

**Files:** Create: `src/features/firmware/{FirmwarePage.tsx,FlashLog.tsx,DfuRecovery.tsx}`

- [ ] 两 Tab:正常更新 / DFU 救砖(F4-only 软件进 DFU + BOOT0 指引 + Zadig 提示)
- [ ] 在线列表:**默认全部列出可手选**;若 identify/AUTOPILOT_VERSION 可得则高亮推荐项,绝不据此隐藏或阻断——唯一硬门在 Px4Flasher/Stm32Dfu 内部
- [ ] 本地 .apj/.hex 拖拽;步骤可视化 + 日志流;板型不匹配时引擎报错→页面解释原因;Commit

## Phase 4 — 验收

- [ ] `npm test` 全绿(纯 fixture,无外部依赖)
- [ ] `SITL=1 npm test`:连接/参数全量/写回读(含恢复)
- [ ] 真机 AF-F4 nano:连接识别 → STATUSTEXT → 参数改写回读 → 在线正常更新(降级 v0.2.2→升回)→ 软件进 DFU → DFU 救砖 `_with_bl.hex` → 拔线恢复;Linux + Windows(Zadig)各一遍
- [ ] GitHub Pages 可访问
- [ ] superpowers:verification-before-completion 复核后宣告 M1 完成

## 后续(不在本计划)

M2:完整 MAVLink 控制台、传感器校准、电机测试+自动映射、设置页、Dashboard、装机引导、四语翻译补全、参数 pdef 元数据、PWA 打磨。日志/地图/图表/RTK 见 spec 后置清单。
