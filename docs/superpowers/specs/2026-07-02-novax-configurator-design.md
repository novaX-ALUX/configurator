# novaX Configurator 设计文档

日期:2026-07-02
状态:待用户评审
调研依据:MicoConfigurator 逆向调研 + Codex 两轮评审(架构 2026-07-02、MAVLink 栈选型 2026-07-02,session `019f20fc-c0a4-7772-afae-3f4683a6674f`)

## 1. 背景与目标

novaX 需要一个对标 [MicoConfigurator](https://micoair.com/configurator/) 的纯浏览器端飞控配置工具:浏览器通过 Web Serial 直连 USB 飞控讲 MAVLink,免安装、免驱动(正常更新路径),覆盖装机全流程(刷固件 → 机架/ESC 设置 → 校准 → 电机测试 → 参数)。

**产品定位**:通用 ArduPilot 配置器 + novaX 增强。连接、参数、校准、电机测试对任何 ArduPilot 飞控可用;在线固件列表、软件进 DFU 等增强功能仅对 novaX board ID(6200–6209)解锁。

**明确的非目标(首期后置)**:地图任务规划、日志下载/分析、实时图表、RTK 注入、PX4 支持、Betaflight(MSP)支持、3D 机身姿态、硬件导购页。

## 2. 与现有仓库的关系

- `flight_controller`:固件唯一事实源。其 `scripts/release.sh` 需新增生成 `manifest.json` 一并发布到 GitHub Releases(见 §7)。
- `marketing/parts-catalog`:仅作参考,继续独立维护。其 `/update` 页的刷写引擎(`serial-px4.ts`/`dfu.ts`/`apj.ts`/`intel-hex.ts` 及 `update.astro` 中的安全状态机)是本项目固件模块的参考实现与真机经验来源;本项目**重写**,不做共享包。
- 本仓库(`GC/`):novaX Configurator 独立仓库。

## 3. 首期功能范围

8 个页面 + 装机引导:

1. **连接**(全局顶栏):串口选择、连接状态、飞控识别(板型/固件版本/board ID)
2. **Dashboard**:2D 姿态仪、解锁状态、飞行模式、电压电流、GPS、RC 通道、电机输出
3. **设置(Setup)**:机架类型(图示)、ESC 协议、电池监控、失控保护(RC/电池/GCS);表单项显示对应 ArduPilot 参数名
4. **传感器校准**:加速度计六面校准、罗盘校准(进度反馈、中断恢复)
5. **电机测试**:布局图联动机架类型、逐电机测试、自动映射向导(安全门禁见 §7)
6. **参数表**:全量参数搜索/过滤/分组、diff 预览、批量写入回读确认
7. **固件更新**:"正常更新"(串口免驱动)与"DFU 救砖"两模式;在线列表(novaX 板)+ 本地文件拖拽(任意板)
8. **MAVLink 控制台**:消息流、STATUSTEXT 高亮、过滤

**装机引导(Setup Guide)**:参数初始化 → 机架 → 电机 → 校准 → 失控保护,逐步参数级完成度检测,可跳过。

## 4. 技术栈

- React 18 + Vite + TypeScript,Zustand 状态管理,Tailwind CSS
- i18next,四语首发:英/中/韩/日(UI 需容忍约 30% 文案膨胀)
- PWA(vite-plugin-pwa),浅色主题按设计稿(2026-07-04 设计稿定稿,以 docs/design/novaX-Configurator.dc.html 为准)
- 桌面浏览器(Chrome/Edge,Web Serial 限制);设计基准 1280px,降级至 1024px
- 部署:GitHub Pages,GitHub Actions 自动构建

## 5. 架构分层

```
src/core/transport/    连接抽象:Transport 接口
                       ├─ SerialTransport(Web Serial,生产)
                       └─ WebSocketTransport(开发/CI 连 SITL 桥)
src/core/mavlink/      defs.ts     mavlink-mappings 适配层(隔离 LGPL 依赖)
                       frame.ts    MAVLink2 帧解析/编码(Uint8Array/DataView,不用 Buffer)
                       router.ts   按 (sysid, compid, msgid) 分发;heartbeat/组件注册表
                       command.ts  COMMAND_LONG + ACK 的 promise/重试/超时
                       params.ts   参数协议状态机
                       ftp.ts      (二期,服务日志下载)
src/core/firmware/     PX4 serial bootloader 刷写、WebUSB STM32 DFU、apj/hex 解析、board_id 校验
src/features/          dashboard / setup / motors / calibration / params / console / firmware / guide
src/workers/           重计算(二期日志解析预留)
```

每层可独立测试;features 只依赖 core 的公开接口。

## 6. MAVLink 栈(Codex 评审结论)

**选型**:消息定义层用 **`mavlink-mappings@1.0.20-20240131-0`**(精确 pin,`minimal + common + ardupilotmega` 子集,只从 dialect 子模块直接导入,隔离在未来的 `src/core/mavlink/defs.ts` 适配层内,LGPL 许可证状态 PENDING-HUMAN sign-off);帧层/会话层自写(2026-07-02 spike 已定,详见 `docs/notes/decisions-m1.md` 决策 1/2)。官方 **mavgen 生成 TypeScript** 已于 2026-07-02 评估并 **REJECTED**:生成的消息类硬依赖 `node-mavlink`(源码依赖 Node `stream`/`crypto`/`Buffer`,不进浏览器 runtime),即便补装该依赖也仍是 metadata-only、无 pack/unpack。排除项不变:`node-mavlink` 本身仍不作运行时依赖,仅作参考实现。

**帧层实现要点**(自写,第一版含测试按 3–6 周计):

- MAVLink2 header 10 字节,msgid 24-bit LE;CRC 不含 magic、追加 CRC_EXTRA
- 签名帧为额外 13 字节(总开销 25 = header 10 + CRC 2 + 签名 13);不支持签名时遇 signed incompat flag 丢弃
- payload 发送端截尾零、接收端按定义补零;首字节不可截
- seq 0–255 回绕;丢包统计按来源组件分组
- 路由:sysid/compid 是发送者,目标看 payload 内 `target_system/target_component`
- COMMAND_LONG 重传按 `COMMAND_ACK.command/result/progress` 关联;危险命令(校准/重启/写参)走白名单 + UI interlock,不盲目重传

**参数协议**(首期标准协议,FTP param download 二期):

1. `PARAM_REQUEST_LIST` 全量拉取,按 `param_count/param_index` 建表,容忍乱序/重复
2. 静默窗口后对缺洞 `PARAM_REQUEST_READ(param_index)` 补传,多轮有限重试
3. 写参 `PARAM_SET` 必须等 `PARAM_VALUE` 回读确认;关键参数追加 `PARAM_REQUEST_READ` 校验
4. 缓存不宣称强一致

## 7. 固件更新链路

- **manifest**:`flight_controller/scripts/release.sh` 生成 `manifest.json` 随 GitHub Release 发布。字段:`boardName, boardId, mcuFamily, vehicle, version, gitHash, files[{kind(apj|with_bl_hex), url, sha256, size}], method, softwareDfuAllowed, dfuRecoveryAllowed`。
- **获取**:manifest.json 与固件二进制文件均镜像到本站点 `public/firmware/`,由 GitHub Pages 同源提供(2026-07-02 spike 已证实:`release-assets.githubusercontent.com` 对所有 release asset——含 `.apj`/`.hex`/`manifest.json`——均不带 `Access-Control-Allow-Origin`,浏览器 `fetch()` 直连不可行;WebUSB/PX4 serial 刷写又需要固件字节进内存 `ArrayBuffer`,原"固件文件仍指向 Releases"的 fallback 表述不成立。详见 `docs/notes/releases-cors-spike.md` 与 `docs/notes/decisions-m1.md` 决策 4/5)。同步机制:`scripts/sync-firmware.sh`(Task 1.2 相邻工作)用 gh CLI 从 `flight_controller` Releases 拉取资产写入 `public/firmware/`。
- **防刷错板硬门**:bootloader identify 返回的 board_id 必须等于 `.apj` 内 board_id 才允许擦除;`AUTOPILOT_VERSION` 仅作展示(novaX 自有固件 AF-F4_T10 已证明不能依赖该消息)。sha256 校验在下载后、擦除前完成。
- **正常更新**:MAVLink reboot-to-bootloader → PX4 serial bootloader 协议(GET_DEVICE 必须先查 INFO_BL_REV 再擦除——parts-catalog 真机验证的坑)→ 烧写 → CRC → 重启。
- **DFU 救砖**:WebUSB 连 STM32 ROM DFU(0483:DF11),刷 `_with_bl.hex` 全镜像;Windows 提示 Zadig/WinUSB。
- **软件进 DFU**:仅对 F4 系 novaX 板开放(H7 软件进 DFU 有硅级变砖问题,逐板真机验证前保持禁用)。

## 8. 安全 interlock

- 电机测试:显式"已拆桨"确认 → 解锁倒计时 → 测试中超时自动停 → 页面失焦/断连立即停
- 参数写入:全部回读确认;批量写入前 diff 预览;未保存修改醒目标识
- 校准:显式状态机,中断/断连有恢复路径
- 任何自动参数修改必须显式告知并可撤销(MicoConfigurator 罗盘事故教训)
- 断连是常态(刷固件重启、拔线):每个页面定义断连行为与重连恢复

## 9. 测试策略

- 协议层:录制真机帧作 fixture 的单元测试(frame/router/params)
- 集成:ArduPilot SITL + WebSocket↔TCP 桥,开发与 CI 全流程跑真协议(transport 抽象使此成为可能)
- 真机矩阵:AF-F4 nano 优先(唯一全流程已验证的家族);Chrome/Edge × Windows(Zadig)/Linux(udev)/macOS 权限逐项记录
- 固件刷写的破坏性路径只在真机上验证,CI 不模拟

## 10. 里程碑

- **M1**:仓库骨架、transport + mavlink core(帧/路由/命令/参数)、固件页(正常更新 + DFU)、参数表;`flight_controller` 侧 manifest 生成
- **M2**:传感器校准、电机测试+自动映射、设置页、Dashboard、控制台、装机引导、四语文案补全

## 11. 风险清单

1. H7/F7 软件进 DFU 变砖(硅级)——保持禁用,逐板真机验证后开放
2. ~~GitHub Releases 浏览器 CORS 未验证~~——**已于 2026-07-02 spike 验证并 RESOLVED**:asset 字节直连不可行,策略锁定为镜像到 `public/firmware/`(见 §7、`docs/notes/releases-cors-spike.md`、`docs/notes/decisions-m1.md` 决策 4/5)
3. MAVLink FTP 复杂度高——已整体移出首期
4. AP-RTK dual 走 CAN,浏览器无原生 CAN——不承诺其 web 更新
5. 数据源漂移(catalog/README/hwdef 规格不一致)——固件事实源统一为 flight_controller manifest;产品规格漂移另行修正,不阻塞本项目
6. ~~mavgen TypeScript 生成器成熟度~~——**已于 2026-07-02 spike 验证并 RESOLVED**:mavgen 生成类硬依赖 `node-mavlink`(Node stream/Buffer),REJECTED;`mavlink-mappings@1.0.20-20240131-0` 锁版本作为选型(见 §6)。残余风险:LGPL 许可证 sign-off 待人类决定、消息覆盖 272/325(缺 loweheiser/cubepilot/csAirLink vendor dialect)——详见 `docs/notes/decisions-m1.md` 决策 1/3/7
