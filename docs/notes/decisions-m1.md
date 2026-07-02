# Task 0.4: M1 选型锁定记录(硬门)

日期:2026-07-02
状态:LOCKED(除 LGPL 一项为 PENDING-HUMAN)

**这份文件是 Phase 1 及以后所有接口的硬约束。后续任务(1.1/1.2 manifest 契约、2.2
帧层、3.3 固件引擎……)必须与本文件一致;若某接口与本文件冲突,先改本文件(走下面
"如何推翻"流程),不得在实现里悄悄绕过。**

依据:
- Task 0.2 spike — `docs/notes/mavgen-spike.md`
- Task 0.3 spike — `docs/notes/releases-cors-spike.md`
- 设计文档 §6/§7/§11 — `docs/superpowers/specs/2026-07-02-novax-configurator-design.md`

---

## 决策 1:消息定义 provider = `mavlink-mappings@1.0.20-20240131-0`(精确 pin)

**决策**:采用 npm 包 `mavlink-mappings`,精确版本 `1.0.20-20240131-0`(无 `^`),
**只允许**从各 dialect 子模块直接导入:

```ts
import * as minimal from 'mavlink-mappings/dist/lib/minimal'
import * as common from 'mavlink-mappings/dist/lib/common'
import * as ardupilotmega from 'mavlink-mappings/dist/lib/ardupilotmega'
```

**禁止**从包根导入(`import { ardupilotmega } from 'mavlink-mappings'`)——barrel
会拖入 `mavlink-mappings-gen`(`xml2js`/`sax`),Vite 需要 externalize Node 内建模
块,且实测体积暴涨(117.96 kB gzip vs 72.73 kB gzip)。

CRC_EXTRA 取值方式:每个消息类的静态 `MAGIC_NUMBER`。字段表取值方式:每个消息类
的静态 `FIELDS`(`MavLinkPacketField[]`,含预计算的 byte offset、size、
array length、extension flag)。三个 dialect 各自的 `REGISTRY` 需手动合并
(`{ ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY }`)——
每个 `REGISTRY` 只含该 XML **自己定义**的消息,不含 `<include>` 展开。

**证据**:`docs/notes/mavgen-spike.md` §"2. Fallback: mavlink-mappings (adopted)"
及其 (a)(b)(c)(d) 四条验证结果;官方 mavgen `--lang=TypeScript` 已在同一份 spike
的 §"1. mavgen TypeScript (rejected)" 中因硬依赖 `node-mavlink`(Node
`stream.Transform`/`Buffer`)而被否决。

**后续任务影响**:
- Task 2.2(帧层)必须基于 `crcExtraForMsgId(msgid)` / `fieldsForMsgId(msgid)`
  这个形状写 `FrameParser`,不得假设存在 pack/unpack 方法(两个候选方案都没有,
  是 metadata-only 设计,序列化要手写)。
- Task 1.1/1.2(manifest 契约)不直接依赖此决策,但 manifest 里如果引用消息名/
  msgid,应通过同一 registry 校验合法性。

**状态**:LOCKED

**如何推翻**:如果后续需要 CubePilot/csAirLink/Loweheiser 消息(见决策 7 的覆盖
缺口),或者 `mavlink-mappings` 停止维护/出现不可接受的 bug,重新跑一次等价的
spike(bundle size + strict TS + CRC_EXTRA 可达性),对比官方 mavgen 或自写
XML 解析器,更新本节并同步通知 Task 2.2 owner。

---

## 决策 2:隔离要求 — `mavlink-mappings` 只能在 `src/core/mavlink/defs.ts` 中导入

**决策**:全仓库只有一个文件允许 `import ... from 'mavlink-mappings/dist/lib/*'`
——`src/core/mavlink/defs.ts`。该文件是一个适配器(adapter),对外暴露:

```ts
interface GeneratedDefs {
  crcExtraForMsgId(msgid: number): number
  fieldsForMsgId(msgid: number): MavLinkPacketField[]
  messageName(msgid: number): string
  // ...
}
```

其余所有代码(frame.ts、router.ts、params.ts、features/*)只消费 `GeneratedDefs`
这个适配器接口,不直接 import `mavlink-mappings`。

**理由**:两个:(1) 可替换性——如果决策 1 未来被推翻(见决策 1 的"如何推翻"),
换掉底层 provider 只需重写这一个文件;(2) LGPL 隔离——把唯一的 LGPL 依赖锁在
单一文件里,降低法律面的接触面,也让"该不该在 bundle 里保留 LGPL 代码"这个问
题(决策 3)有一个明确的替换点。

**证据**:`docs/notes/mavgen-spike.md` "Recommendation" 一节给出的 API 形状
(`crcExtraForMsgId`/`fieldsForMsgId`)已经是这个适配器接口的原型。

**后续任务影响**:
- Task 2.2(帧层)：`FrameParser`/`router.ts`/`command.ts`/`params.ts` 一律
  `import type { GeneratedDefs } from '../mavlink/defs'`,不直接碰
  `mavlink-mappings`。
- Task 2.2 交付时需要连带交付决策 8 的 ESLint 规则,把这条隔离要求从"约定"
  变成"CI 强制"。

**状态**:LOCKED

**如何推翻**:如果适配器接口本身证明不够用(例如需要暴露 enum 定义、单位信息
等 `GeneratedDefs` 未覆盖的字段),扩展 `GeneratedDefs` 接口本身,而不是在
`defs.ts` 之外开新的导入点。

---

## 决策 3:LGPL 许可证状态 — PENDING HUMAN SIGN-OFF

**决策**:`mavlink-mappings` 的 `package.json` 声明 `"license": "LGPL"`。M1
开发阶段**可以使用**(不阻塞开发)。但在任何**公开发布**(GitHub Pages 上线、
对外分享链接)之前,人类必须二选一:

- (a) 签署 LGPL 接受决定,并在网站上新增一个 licenses 页面,列出该依赖及其
  许可证条款、获取源码的方式;或
- (b) 触发 fallback:放弃 `mavlink-mappings`,改用自写的生成器,从官方
  MAVLink XML(MIT 协议)生成等价的消息定义数据(即回到决策 1 被否决的
  mavgen 路线的"自己动手"版本,但产出 metadata-only 数据而非 mavgen 的
  Node-bound 代码)。

**证据**:`docs/notes/mavgen-spike.md` "Concerns to carry into Task 0.4" 第 1
条 — 详细说明了 LGPL 在 bundle 场景下"动态链接"认定的灰色地带,以及两个
不确定但值得权衡的缓解因素(数据而非算法逻辑;未修改包源码)。spike 明确指出
"go/no-go 属于 Task 0.4 和人类,不属于 spike"。

**后续任务影响**:
- Task 3.3(固件引擎)及所有面向公开发布的里程碑,在 ship 前必须检查这一项
  是否已经从 PENDING 变成 LOCKED(a) 或 LOCKED(b)。
- 若走 fallback (b),决策 1/2 的适配器文件路径不变,只是 `defs.ts` 内部实现
  换掉,这正是决策 2 隔离设计的目的。

**状态**:**PENDING-HUMAN**(owner = human,非 spike/controller 可自行决定)

**如何推翻**:不适用"推翻"——这是一个必须被人类显式关闭的开放项,不是可以被
后续 spike 自动 supersede 的技术决策。关闭方式见上面 (a)/(b)。

---

## 决策 4:固件分发策略 = MIRROR(镜像)

**决策**:固件二进制文件与 `manifest.json` 一律**镜像**到 GC 站点自身的
`public/firmware/`,由 GitHub Pages 同源提供(`${BASE}firmware/...`)。不再考虑
浏览器直接 `fetch()` GitHub Releases 的资产字节(方案已被 CORS 证据否决)。

**同步机制**(契约锁定,脚本本身不在本任务构建):`scripts/sync-firmware.sh`,
使用 `gh` CLI,按 tag 从 `novaX-ALUX/flight_controller` 的 GitHub Releases 拉取
资产,写入本仓库 `public/firmware/`。该脚本属于 Task 1.2 相邻工作,现在只锁定
"存在这样一个脚本、走 gh CLI、目标目录是 `public/firmware/`"这个契约,不在本
任务实现。

**证据**:`docs/notes/releases-cors-spike.md` — Hop 2 (`release-assets.
githubusercontent.com`) 在两个独立公开仓库、`.apj`/`.hex`/`.txt` 三种文件类型
上均确认**没有** `Access-Control-Allow-Origin` 响应头,浏览器 `fetch()` 会以
`TypeError: Failed to fetch` 失败。spike 的"Correction to the existing design
assumption"一节进一步指出:设计文档 §7 原先"固件文件仍指向 Releases"的表述
不成立,因为 WebUSB DFU / PX4 serial bootloader 刷写都需要把固件读进内存
`ArrayBuffer`,而不是浏览器原生下载到磁盘——直接 `fetch()` 不可行,`<a
href>` 下载也不满足需求。

**后续任务影响**:
- Task 1.1/1.2(manifest 契约)：manifest 里的 `files[].url` 必须是相对于
  `public/firmware/` 的同源路径,不能是 `github.com/.../releases/download/...`
  这种跨源 URL。
- Task 3.3(固件引擎)：`fetchFirmwareBytes()` 只对同源 URL 调用 `fetch()`,
  不含任何跨源 fallback 逻辑(见决策 5 的错误处理规则)。
- 需要在某个后续任务(未编号,Task 1.2 前后)决定 `public/firmware/` 的保留
  策略(全部历史版本 vs 仅最新 N 个),本文件不做该决定,只标记为遗留问题。

**状态**:LOCKED

**如何推翻**:如果 GitHub 未来给 `release-assets.githubusercontent.com` 加上
CORS 头(基础设施变更,不受本项目控制),或者改用 `raw.githubusercontent.com`
路线(spike 中"Not recommended, but noted as theoretically available"一节提到
的、把文件直接提交进 git 树的方案),需要重新做一次等价的 CORS header 验证,
更新本节并同步通知 Task 1.1/1.2/3.3 owner。

---

## 决策 5:`fetchManifest` URL 规则 = 同源相对路径

**决策**:

```ts
async function fetchManifest(boardId: string): Promise<Manifest> {
  const res = await fetch(`firmware/${boardId}/manifest.json`) // 相对路径,基于 Vite BASE_URL 解析
  if (!res.ok) throw new ManifestFetchError(res.status)
  return res.json()
}
```

`api.github.com` **仅**允许用于"有无新版本可用"这类**通知性**元数据查询(它确实
带 `Access-Control-Allow-Origin: *`),**永远不允许**用来获取固件字节或
`manifest.json` 本身——那条路径已被决策 4 的证据否决。404(镜像尚未同步完成)
时给用户明确的"固件暂不可用,请稍后重试"提示,**不**做跨源 fallback 到
`github.com/.../releases/download/...`(CORS 失败在浏览器 fetch API 里表现为无
区分信息的 `TypeError`,会把一个可诊断的"没同步"问题伪装成不可诊断的网络错误)。

**证据**:`docs/notes/releases-cors-spike.md` "Recommendation" 一节的
`fetchManifest()`/`fetchFirmwareBytes()` 契约草案,以及紧随其后的"Error/fallback
path"段落。

**后续任务影响**:
- Task 1.2(manifest 契约实现)直接落地这个函数签名。
- Task 3.3(固件引擎)复用同一"同源、无 fallback"规则实现
  `fetchFirmwareBytes(url)`。

**状态**:LOCKED

**如何推翻**:与决策 4 绑定,推翻方式相同。

---

## 决策 6:defs 层 bundle 预算 = ≤ 80 kB gzip

**决策**:`src/core/mavlink/defs.ts`(含其唯一允许的 `mavlink-mappings`
依赖)整体 gzip 后体积预算为 **≤ 80 kB**。实测三个 dialect(minimal + common +
ardupilotmega)直接子模块导入的 gzip 体积约 **73 kB**,留有余量。

**证据**:`docs/notes/mavgen-spike.md` (c) 小节的 Vite 构建实测表格 ——
`entry-ardu-direct.ts` 398.37 kB minified / **72.73 kB gzip**;对照组
barrel import 117.96 kB gzip(超预算,是禁止 barrel import 的另一个理由,
呼应决策 1)。

**后续任务影响**:
- Task 2.2 交付时应在 CI 里加一个 bundle-size 检查(或至少在 PR 描述里报告
  实测值),防止未来 `mavlink-mappings` 升级版本或新增 dialect 悄悄超预算。

**状态**:LOCKED

**如何推翻**:如果产品需求变化(例如需要引入更多 dialect,见决策 7),预算
可以上调,但必须在本文件里显式记录新预算值和触发原因,不能只在 CI 配置里
改数字。

---

## 决策 7:消息覆盖缺口(272/325)— M1 可接受的已知限制

**决策**:`mavlink-mappings` 的 `minimal + common + ardupilotmega` 合计 272 条
消息,少于上游 `mavlink/mavlink` 当前 `ardupilotmega.xml`(经
`<include>` 展开)的 325 条——缺口是 `loweheiser`/`cubepilot`/`csAirLink`
三个 vendor dialect(`mavlink-mappings` 完全不提供,包括其最新版本)。M1 范围
是纯 ArduPilot 通用配置器,不承诺这三个 vendor 的专有消息,**接受此缺口**。

**证据**:`docs/notes/mavgen-spike.md` (b) 小节及"Concerns"第 2 条 —— 消息数量
逐 dialect 列出(`ardupilotmega.REGISTRY` 64、`common.REGISTRY` 207、
`minimal.REGISTRY` 1),以及缺失 dialect 的清单。

**后续任务影响**:
- 若未来需要支持某个使用 CubePilot/csAirLink/Loweheiser vendor 消息的板卡,
  需要重新触发决策 1 的"如何推翻"流程(自写生成器或寻找替代 provider),
  而不是在 Task 2.2/3.3 里 hack 一个局部 workaround。

**状态**:LOCKED(作为"已知限制"记录,非阻塞项)

**如何推翻**:出现具体的、需要这些 vendor 消息的板卡需求时,重新评估。

---

## 决策 8:ESLint 强制 — 携带到 Task 2.2 的 TODO

**决策**:新增 ESLint 规则 `no-restricted-imports`,禁止在
`src/core/mavlink/defs.ts` 之外的任何文件里导入 `mavlink-mappings`(含其任意
子路径)。当前该约束只靠 `scripts/gen-mavlink.sh` 里的 grep 检查兜底,不是
CI 强制的 lint 规则,也不会在编辑器里给出即时反馈。

**证据**:`docs/notes/mavgen-spike.md` "Concerns" 第 4 条 —— "Import discipline
is load-bearing"。

**后续任务影响**:
- Task 2.2(帧层)落地 `src/core/mavlink/defs.ts` 时,必须同时把这条 ESLint
  规则加进项目的 lint 配置,作为该任务验收标准的一部分,而不是留给更晚的
  任务。

**状态**:LOCKED(作为 Task 2.2 的强制 TODO 项,非可选)

**如何推翻**:不适用——这是决策 2(隔离要求)的强制执行手段,只要决策 2 有效,
本条就有效。

---

## 附:未在上述编号决策中,但值得随本文件一起记录的开放项

- **`public/firmware/` 保留策略未定**(全部历史版本 vs 仅最新 N 个)——
  `docs/notes/releases-cors-spike.md` "Concerns" 第 3 条提出但未决,留给
  Task 1.1/1.2 或更晚。
- **`npm audit` 噪音**:`mavlink-mappings` 把 `xml2js`/`sax`/`ts-node`/
  `mavlink-mappings-gen` 错放进 `dependencies`(应为 `devDependencies`),
  `npm install` 会带进 3 条 moderate 级 `xml2js` prototype-pollution 告警。
  这些包在直接子模块导入路径下完全不参与运行时 bundle(已用 Vite 实测验证,
  见决策 1 证据),记为已知 false-positive,不追加升级动作。
