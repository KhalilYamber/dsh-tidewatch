# dsh-tidewatch

> DeepSeek Harness 的峰谷时刻挂件。一枚停在界面右下角的潮汐立绘，随时告诉你此刻是峰期还是谷期、距下一次切换还有多久、本次会话花了多少钱。

[![Release](https://img.shields.io/github/v/release/KhalilYamber/dsh-tidewatch)](https://github.com/KhalilYamber/dsh-tidewatch/releases)
[![License](https://img.shields.io/github/license/KhalilYamber/dsh-tidewatch)](LICENSE)

## 这是什么

DeepSeek 自 2026-08-17 起对 API 实行峰谷分时定价：峰期价目是谷期的两倍，周末与中国法定节假日全天按谷价。这意味着同样一次调用，落在不同钟点，账单可能差一倍。

`dsh-tidewatch` 把这件事摊开在你眼前：现在是什么档位、距离切换还有多久、这一场对话已经花了多少钱。金额按**每次调用实际发生的时刻**计价，回看历史会话也不会被当前价目重算。

它卖的是「口径可核对」：峰谷窗口、周末、法定节假日、调休、三段历史价格全部写在代码里，并配一条全年逐小时的口径比对脚本作为复核手段。

## 特性

| 分类 | 能力 |
|---|---|
| **峰谷** | 官方峰谷窗口判定；秒级倒计时到下一阶段；周末与法定节假日全天谷期；调休上班的周末同样全天谷期 |
| **计费** | 三段历史价格时代（基础价 / 首版峰谷价 / V4.1 Flash 新价）按调用时刻选档；缓存命中与未命中分开计价；输出含推理 token |
| **余额** | 读取 DeepSeek 账户余额（充值 / 礼金 / 合计）与读数时刻 |
| **挂件** | 右下角常驻立绘，可拖拽，松手吸附到较近的一侧，位置持久化；峰期与谷期换不同立绘 |
| **气泡** | 点立绘弹出漫画式对话气泡（大圆角 + 指向头顶的尖角）；**点气泡翻页**。收起只有两条路：约 5 秒后自己淡出，或点插件之外的任何地方 |
| **交互** | 点立绘出气泡、点气泡翻页；完整面板从气泡的「详情 ›」进入；面板右上角 `✕` 或点外部收起 |
| **编辑器** | 面板内置气泡编辑器：增删页与行、改模板文案、**拖拽排序**（也可点 ↑↓）、**模块库**（☆ 收藏常用行，一键插入）、一键恢复默认 |
| **泡泡玩法** | 一行内用 `A \|\| B` 并列随机、写成 `img:https://…` 渲染成图片（在线图与 data URI 均可） |
| **观感** | 跟随 GUI 亮暗主题（`--dsw-*` 变量）；复用 DSH 官方 UI 原语；合成提示音（无音频素材） |
| **账号通道** | DeepSeek 账号登录取不到 usage，改用**余额差值**估算本会话消耗，金额标「（估算）」；其余通道仍按 token 精准计价 |
| **诊断** | 用量异常时（一条结算事件都没收到，或有事件但一条不带用量）气泡底部出现一行排障信息；正常会话里不显示 |
| **不适用时** | 换成非 DeepSeek 模型时显示「不适用」，不拿 Flash 价硬凑数字 |

## 安装

### 前置条件

- Node.js ≥ 20
- 带 `dsh plugin` 命令的 DeepSeek Harness
- **桌面端**用户请把下文的 `--profile web` 换成 `--profile desktop`（桌面端读取的是 `desktop` profile）

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:KhalilYamber/dsh-tidewatch
```

### 从 Release 安装（可固定版本、可离线）

到 [Releases](https://github.com/KhalilYamber/dsh-tidewatch/releases) 下载最新的 `dsh-tidewatch-<版本>.tgz`，然后：

```sh
dsh plugin --profile web add ./dsh-tidewatch-1.23.3.tgz
```

### 本地链接安装（改源码即时生效）

```sh
dsh plugin --profile web add link:/path/to/dsh-tidewatch
```

安装后**重启 DSH**（桌面端需完整退出再打开，热重载刷新不到客户端 bundle），右下角会出现潮汐挂件。

### 升级与卸载

```sh
dsh plugin --profile web update dsh-tidewatch    # 或重新执行 add
dsh plugin --profile web list dsh-tidewatch      # 查看已安装版本
dsh plugin --profile web remove dsh-tidewatch    # 卸载
```

> **npm 渠道已暂停**：npm 上只有一个 2026-08-22 发布的旧版本，价格与规则均已过时，请勿安装，也不要据它判断当前计价。
>
> **本仓库只保留当前版本的 tgz**，历史版本在 GitHub Releases 里可以取到。

## 使用

- **点立绘** → 弹出气泡（再点不会收起，只会重置计时）；**点气泡** → 翻到下一页；约 5 秒后自己淡出，**点插件外任意位置**也会收起
- **气泡里的「详情 ›」** → 完整面板
- **点气泡里的「详情 ›」** → 展开完整面板：官方峰谷时段表（北京时间）、当前档位价格、Token 明细、账户余额、币种切换、气泡编辑器、音效开关
- **拖动挂件** → 移到任意位置；松手靠近左右边缘会自动吸附，位置记在 `localStorage`
- **点「本次会话费用」行** → 展开分模型花费明细（各模型 token 与花费，合计等于各项之和）
- **收起面板** → 点面板右上角 `✕`、点挂件本身、或点面板外部

币种选择即时生效并记住；人民币 2 位小数，美元 4 位小数。

## 两种形态

本插件提供两种界面形态，按需选择。

### 立绘挂件（v1.5.0 起，推荐）

右下角常驻立绘，可拖拽并吸附到左右边缘。点一下弹出漫画气泡，**再点一下翻页**看本次会话开销；面板里带气泡编辑器（增删页、改文案、拖拽排序、模块库）。当前版本即此形态。

### 胶囊徽章（v1.4.2，另一形态）

挂在官方输入框下方的统计行里，与官方统计条目并列，不占据屏幕空间：

```sh
# 下载后安装
dsh plugin --profile web add ./dsh-tidewatch-1.4.2.tgz
```

[dsh-tidewatch-1.4.2.tgz](https://github.com/KhalilYamber/dsh-tidewatch/releases/download/v1.4.2/dsh-tidewatch-1.4.2.tgz)

该版本提供峰谷倒计时、会话费用、账户余额与币种切换，**同样支持账号内置通道的余额差值估算**；**不含**气泡、编辑器、模块库与官方投影采样，也不含后续修掉的若干缺陷。

> 已知问题：胶囊形态的徽章挂在应用级浮层上，**在插件设置页也会显示**（即 [issue #3](https://github.com/KhalilYamber/dsh-tidewatch/issues/3) 报告的现象）。想要安静的徽章又要避开它，请用当前版本并把立绘拖到角落。

## 计费口径

### 峰谷时段（官方依据）

DeepSeek 官方自 2026-08-17 起实施峰谷分时定价：

| 时段（UTC） | 北京时间 | 档位 |
|---|---|---|
| 01:00 – 04:00 | 09:00 – 12:00 | 峰 |
| 04:00 – 06:00 | 12:00 – 14:00 | 谷 |
| 06:00 – 10:00 | 14:00 – 18:00 | 峰 |
| 10:00 – 次日 01:00 | 18:00 – 次日 09:00 | 谷 |

谷期价格为峰期的一半。本插件按 UTC 窗口判定当前档位（官方英文页即按 UTC 小时书写），周几与法定节假日按北京自然日判定（官方中文页把周期锚在「北京时间周一至周五」上）。两种读法在当前窗口取值下等价：窗口均落在同一北京自然日内，且不成对跨越 UTC 日界。时段表展示一律按北京时间。

### 三段价格时代

价格按**调用发生时刻**选档，历史会话回看不会被当前价目重算。档位顺序为 缓存命中 / 输入未命中 / 输出（美元 / 1M tokens）：

| 时代 | 时间范围（UTC） | deepseek-flash 档位 |
|---|---|---|
| 基础价 | 2026-08-16 16:00 之前 | 0.0028 / 0.14 / 0.28 |
| 首版峰谷价 | 2026-08-16 16:00 ~ 2026-09-10 04:00 | 峰 0.014 / 0.44 / 1.32，谷为峰的一半 |
| V4.1 Flash 新价 | 2026-09-10 04:00 起 | 峰 0.006 / 0.3 / 1.2，谷为峰的一半 |

成本 = 输入未命中 × cacheMiss + 输出 × output + (缓存读 + 缓存写) × cacheHit；「输出」已含推理 token。账本以美元存储。

人民币数字另存一份官方**中文**定价页的原样数字用于展示，不做汇率换算：官网两个模型的隐含汇率并不相同（flash 约 6.67、pro 约 6.82），统一换算会让 pro 的元数字比官网低约 2%。

### 周末与法定节假日

- **周六 / 周日**全天按谷期计价（官方公告：「周六、周日全天不再区分峰谷时段，统一按低谷时段价格收取调用费用」）
- **中国法定节假日**全天按谷期计价，无峰谷切换，也没有生效时间（官方定价页脚注：「高峰时段为北京时间周一至周五（不含中国法定节假日）……包括周末及中国法定节假日全天均为空闲时段」）
- **调休上班的周末**同样全天谷期（官方说明：「调休上班的周末、中国法定节假日全天均按空闲时段计费」）
- 下一阶段的切换点 = 下一个工作日首次进入峰时

节假日表依据《国务院办公厅关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号，共 33 天）：元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、劳动节 5/1–5/5、端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7。

## 兼容性

| 项目 | 说明 |
|---|---|
| DSH | 0.1.7-rc.2 及以上；已适配 0.2.0 |
| 模型 | 峰谷档位与金额只对 **DeepSeek 自家模型**成立。换用其他提供商时金额显示「不适用」 |
| 官方 UI 原语 | 优先使用 shell 模块表中的 `@deepseek-ai/dsh-client-ui-primitives`；模块表没有该包时自动降级到内置实现 |
| 主题 | 跟随 GUI 亮暗主题 |
| 数据边界 | 余额查询由 DSH 宿主执行；本插件不接触 API Key、不直接发 HTTP 请求、不落盘 |

模型名映射：现役 `deepseek-flash`（V4.1 Flash），别名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4.1-flash` 均按现役 Flash 价计费。

## 工作原理

```
assistant/message 与 assistant/attempt 事件里的 usage 块
        │  lib/index.js：costUsage 会话投影（zod schema 校验）
        ▼
  token 桶 + 美元成本（按事件发生时刻的峰谷档位）
        │  同一投影视图里还带两样东西：
        │    · official：宿主采样的官方 tokenUsage 投影（账号通道兜底）
        │    · diag：用量诊断计数
        │  useProjection('costUsage')（浏览器端）
        ▼
  lib/client.js：挂件渲染（立绘 + 气泡 + 秒级倒计时）
```

挂件注册在 DSH 的根级浮层插槽 `shell.overlay`；数据由注册在 `conversation.composer.dock` 的探针经模块级 bridge 提供（根级插槽没有投影席位）。

### 文件结构

```
dsh-tidewatch
├── lib/
│   ├── pricing.js        # 纯函数：峰谷窗口、三段价格时代、节假日表、costOf
│   ├── index.js          # 宿主：costUsage 会话投影
│   ├── client.js         # 前端：挂件与面板（__ModuleLoader__ bundle）
│   └── assets/mascot/    # 挂件立绘原图（压缩后内嵌进 bundle）
├── cordis.patch.yml      # 装配行
├── docs/PORTING.md       # 移植到其他宿主的适配说明
└── test/
    ├── verify.mjs        # 全套自检入口
    ├── client-fixture.mjs# 前端夹具：真实加载 lib/client.js 的假 React 环境
    ├── adapt-repro.mjs   # 宿主计费口径回归
    └── ownership-repro.mjs # 前端归属判据回归
```

## 开发与验证

```sh
# 构建（语法检查 + zod 依赖 junction）
DSH_CHECKOUT=<harness 源码根目录> bash scripts/build.sh

# 全套自检（105 项）：峰谷数学、双份常量一致性、计费口径回归、用量双路读取、挂件钳位、随机并列、归属判据回归
node test/verify.mjs

# 布局冒烟测试：用真实样式表在无头 Chrome 里渲染挂件/泡泡/面板并断言布局
# （无 Chrome 时自动跳过；这段覆盖纯逻辑测不到的层叠与定位问题）
node test/ui-smoke.mjs
```

`DSH_CHECKOUT` 在 Git Bash 下需用 **Windows 形式**路径（如 `D:/DeepSeek-Harness/DSHAR工作目录/deepseek-harness-src`）：传 `/d/...` 会被 Node 解析成 `D:\d\...`，生成悬空 junction；插件为 link 安装时，坏链接会让下次启动装配失败。脚本在替换链接之前校验解析结果，坏路径当场报错。

## 已知限制

- **价格表内置**，官方调价后需手动同步 `lib/pricing.js`（计费）与 `lib/client.js` 的 `DISPLAY_PRICES`（展示）两处常量，并为旧价补一段历史档
- **节假日表内置 2026 年**，2027 年安排公布后需手动同步 `CN_PUBLIC_HOLIDAYS`（同样两处）
- **V4 Pro 换价分界**目前是哨兵值：官方声明计费方式保持不变，如有变动需把日期填回 `V4_PRO_RETIRE_BOUNDARY`
- **失败或被重试的调用不计费**，与官方 token-meter 口径一致；这是口径上限
- **账号内置通道走余额差值估算**：该通道（provider `deepseek-account`）不向会话事件提供 usage，两条 token 路都会是空的。此时插件改用「账户余额下降了多少」估算本会话消耗，金额后标注「（估算）」。余额属于账户级，多会话或多设备同时使用会一起下降，估算因此偏大；只累加下降、充值不抵消消耗。这条估算只在账号通道且拿不到 token 时启用，其它通道仍按 token 精准计价
- **官方投影采样的两处取舍**：宿主侧用 `sessionProjections.snapshot(session, ['tokenUsage'])` 读取 DSH 官方的 `tokenUsage` 投影（对话页底部「351M tok · 缓存命中 97%」那行的来源），随视图下发供前端计价。官方投影只给累计总数，故这条路径按**当前**价目折算，无法精确到每次调用的历史档位；采样也只保留最近一次，多会话并发时以前台活跃的那个为准
- **用量缺失时如实标注**：拿不到任何用量又估算不出时，界面显示「未提供」而不是 `¥0.00`，避免把「没有数据」呈现成「免费」。用量的读取口径与 DSH 官方 `token-meter` 一致：同时读 `assistant/message` 与 `assistant/attempt`，按 `(turn, step)` 替换，重试清槽
- **不提供余额预警**：早期版本有一个「余额低于阈值响一声」的功能，阈值写死且不可配置，属于半成品；DeepSeek 控制台本身可能已有余额提醒，故移除，不做重复建设

## 致谢

这个插件站在其他人的肩上：

- **[dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)**（MIT）—— 峰谷数学（`isPeakHour` / `peakPhaseAt` / `tierFor` / `costOf`）与会话投影结构的出发点，本仓库按其精简目标重写。
- **[DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)**（MIT）—— 挂件的产品形态参考：右下角常驻、点击弹泡泡、提示音、余额预警这几项交互，是照着它做的。它的代码与本插件互相独立，未直接引入。
- **「大肥鱼」形象** —— DeepSeek 蓝鲸吉祥物的社区拟人化二创，最早自百度 deepseek 吧的社区共创扩散开来；原始 OC「溟月」由社区创作者「上善无形」确立，本项目所用立绘来自小红书作者，原图存于 `lib/assets/mascot/`。形象版权归各自创作者所有，**收到权利人要求将立即替换或移除**。
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —— 插件运行其上的宿主；状态点、标签、悬浮提示、外点关闭等控件复用其官方 UI 原语。

## 版本说明

历次变更见 [CHANGELOG.md](CHANGELOG.md)，当前版本 **1.23.3**。

## 许可

[MIT](LICENSE) © 2026 KhalilYamber
