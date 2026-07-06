# 功能状态与对标 MicoConfigurator 的差距

本文件记录 novaX Configurator 已完成的功能,以及对照直接同类产品 [MicoConfigurator](https://micoair.com/configurator/)(ArduPilot/PX4 浏览器配置器)尚未实现的功能。用于路线图排期。

> **状态前提**:下列"已完成"项均已实现并经单元测试 + ArduPilot SITL 验证,但**尚未真机验证、尚未部署上线**。MicoConfigurator 是已发布的成品。
>
> **范围前提**:本工具仅支持 ArduPilot(MAVLink)。不支持 PX4,也不支持 Betaflight(MSP)——后者两边都不支持,不算对 Mico 的差距。

对标基准:MicoConfigurator 的 11 个侧边栏页面 = Dashboard / 设置 / 传感器 / 参数 / 控制台 / 地图 / 日志 / 图表 / 固件 / 硬件 / RTK,外加装机引导与 PX4 支持。

---

## 一、已完成(全部)

### 连接(全局顶栏)
- Web Serial 串口选择、波特率、连接/断开、链路状态(idle/connecting/connected/lost)
- 飞控识别(板型 / 固件版本 / board ID,仅展示,不作门禁)
- 断连/拔线 toast + 各页一致的空状态

### Dashboard
- 2D 人工地平线(roll/pitch + 航向带)
- 解锁状态、飞行模式(custom_mode 解码)、预解锁提示
- 电压/电流/电量(优先 `battery_remaining`;未知则只显电压,不用固定电压区间伪造百分比)
- GPS(fix 类型配色 / 卫星数 / HDOP)、RC 8 通道条 + 原始 PWM、电机输出条

### 设置(Setup)——做了 4 块
- 机架:`FRAME_CLASS` + `FRAME_TYPE`(图示 tile:四/六/八轴)
- ESC 协议:`MOT_PWM_TYPE`(PWM / OneShot125 / DShot150/300/600)
- 电池监控:`BATT_MONITOR`、`BATT_CAPACITY`、`BATT_LOW_VOLT`
- 失控保护:RC(`FS_THR_ENABLE`)、低电量(`BATT_FS_LOW_ACT`)、GCS(`FS_GCS_ENABLE`)
- 全部"暂存 → 审查 → 写入回读确认"模式;AP4.0+ 已移除的失控选项标注 legacy

### 传感器校准
- 加速度计六面(由飞控入站 `ACCELCAL_VEHICLE_POS` 驱动,非旧 ACK 路径)
- 罗盘校准 + **写入前 before/after diff 审查门**(`autosave=0` → 审查 → `DO_ACCEPT_MAG_CAL` 让飞控原子写,绝不手写偏移;`COMPASS_LEARN=0` 隐式写如实披露)
- 多罗盘 fan-out(按 `compass_id`)
- `AHRS_ORIENTATION` 只读展示
- 断连中断的诚实文案 + undo

### 电机测试
- 逐电机测试 + 序列测试(`DO_MOTOR_TEST`,throttle_type=percent,30% 硬上限)
- 拆桨确认门 + 解锁倒计时 + **六重急停**(失焦 / 标签隐藏 / ESC / 离开页 / 撤销拆桨 / STOP,每个都真发飞控停止命令)+ 两个空闲超时 + 卡顿检测
- 全局红/琥珀安全横幅
- 机架布局图(联动 Setup 机架)+ **手动指认引导**(逐电机测 + 核对,不自动改 `SERVOx_FUNCTION`)

### 参数表
- 全量拉取(补洞)、搜索 / 前缀分组、暂存编辑、diff 抽屉、批量写入逐行回读验证、失败保留标红、未保存离开警示

### 固件更新
- 在线列表(novaX 板,同源镜像)+ 本地 `.apj`/`.hex` 拖拽
- 正常更新(PX4 串口 bootloader,**免驱动**)+ DFU 救砖(WebUSB STM32)+ 软件进 DFU(仅 F4)
- 擦除前硬门:bootloader board_id == `.apj` board_id + SHA-256 校验;可取消点明确、断连引导

### 控制台(部分)
- STATUSTEXT 消息流(按 severity 着色)+ 链路统计(帧数 / CRC 错误 / 丢包)

### 装机引导
- 右侧抽屉,5 步只读检测清单(连接 → 机架&ESC → 校准 → 电机 → 失控保护),从不改参

### 底层(Mico 也有但不可见)
- 浏览器端自研 MAVLink2 栈、遥测流请求(`SET_MESSAGE_INTERVAL` + `REQUEST_DATA_STREAM` 回退)、四语 i18n(en/zh/ko/ja)、固件 manifest 生成与站内镜像

---

## 二、对比 MicoConfigurator 尚未完成(全部)

### A. 整页未做

1. **地图 + 任务规划** — 实时地图、航点、起飞/降落、测绘航线 + 相机触发、巡航/爬升速度、地形高程(opentopodata)、离线瓦片缓存、跟随/轨迹。整页空白。
2. **日志** — 通过 MAVLink FTP 浏览/下载/删除 SD 卡 dataflash 日志(`.BIN`/`.ulg`),浏览器内分析:多图表、FFT、GPS 轨迹、健康检查、CSV 导出、拖拽本地日志。整页空白。
3. **实时图表(Charts)** — 遥测实时绘图("实时日志查看器")。遥测流层已有,但未接图表。
4. **RTK** — RTCM 注入、基站串口接入、卫星状态、转发给飞控。
5. **硬件(Hardware)** — 厂商产品目录/导购(我们计划外链 parts-catalog,页面本身未做)。

### B. 页面已做、页内子功能仍缺

**设置(Setup):**
- **PID 调参**(整块,Mico 约 106 个相关项)—— 最大缺口
- **飞行模式配置**(飞行模式 ↔ 飞行档位)
- **RC 通道映射 / channel mapping**
- **EKF 数据源选择**(PosXY / PosZ / VelXY / VelZ / Yaw)
- **串口功能配置**(`SERIALx_PROTOCOL` 等)
- **ESC 直通**(BLHeli passthrough)、**电机方向反转**(DShot reverse)、**双向 DShot** 配置
- **电池校准系数**(`BATT_VOLT_MULT` / `BATT_AMP_PERVLT`)—— 只做了监控/容量/低压,未做分压与电流标定
- **严重低电量**(`BATT_CRT_VOLT` + 严重失控动作)—— 只做了 low,未做 critical
- **坠机检测、失控保护 options、最小/最大输出、disarmed 输出**等杂项

**传感器校准:**
- **空速校准**(整块,面向固定翼)
- **罗盘自动磁偏角**配置、完整的**罗盘优先级/顺序**配置(有多罗盘数据但无优先级 UI)

**Dashboard:**
- **3D 姿态可视化**(Mico 用 three.js;我们只做 2D)

**控制台:**
- **交互式 MAVLink 控制台 / 命令输入**(我们只有 STATUSTEXT 只读面板)

**固件页:**
- **PX4 固件支持**
- **多机型选择**(Copter / Plane / Rover / Sub / Heli / Tracker)+ **stable/beta/latest 通道** —— 我们只面向自家 Copter 板、镜像自家固件,不能下载任意 ArduPilot 机型固件

### C. 跨页面/整体缺

- **PX4 支持**(Mico 支持 ArduPilot + PX4;我们仅 ArduPilot)
- **电机自动映射自动改参**(我们降级为手动指认)
- **PWA / 离线安装**(Mico 是 PWA;M1 砍了)

---

## 三、补齐优先级(建议)

按"竞品最明显空缺 + 我们已有基础设施最好接"排序:

1. **实时图表(Charts)** —— 已有遥测流层,接图表最快,也是 Mico 社区口碑点。
2. **日志下载 + 分析** —— 需要 MAVLink FTP(M1 已列二期)+ dataflash 解析,价值高。
3. **PID 调参 + 飞行模式 + RC 映射** —— 补全设置页,从"能配"到"能调"。
4. **地图任务规划 / RTK / PX4 / 3D 姿态** —— 按需求再排。

---

## 四、我们相对 Mico 的差异化优势(已实现)

- **免驱动串口固件更新**(Mico 的 DFU 路径在 Windows 需 Zadig 装 WinUSB)
- **校准写入前审查门 + 全程写参回读确认**(对标竞品曾静默改乱用户罗盘配置的教训)
- **电机测试六重急停 + 真达飞控的停止命令**(不止 UI 状态机)
