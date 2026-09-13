# dsh-tidewatch

**DeepSeek 峰谷时刻悬浮徽章**：一张悬浮在输入框旁的潮汐卡，告诉你此刻是峰期还是谷期、距下一阶段还有多久、本次会话花了多少钱。

- 状态点：**峰期橙红 / 谷期蓝绿**，一眼可辨
- 折叠态：`● 峰期 距谷期 03:33 · ¥0.12`
- 展开态（点击展开）：官方峰谷时段表（北京时间）、当前档位价格、本次会话 Token 明细、汇率设置
- 计费：官方峰谷两档价格（美元口径；含 基础价 / 首版峰谷价 / V4.1 Flash 新价 三段历史档），按每次调用**实际发生时刻**的档位计价，缓存命中/未命中分开
- 币种：默认人民币显示（固定汇率 6.67，与官方人民币标价一致），展开面板可一键切换美元（4 位小数）
- 跟随 GUI 亮/暗主题（`--dsw-*` 变量）

## 峰谷时段（官方依据）

DeepSeek 官方自 2026-08-17 起实施峰谷分时定价：

| 时段（UTC） | 北京时间 | 档位 |
|---|---|---|
| 01:00 – 04:00 | 09:00 – 12:00 | 峰 |
| 04:00 – 06:00 | 12:00 – 14:00 | 谷 |
| 06:00 – 10:00 | 14:00 – 18:00 | 峰 |
| 10:00 – 次日 01:00 | 18:00 – 次日 09:00 | 谷 |

谷期价格为峰期的一半。徽章按 UTC 窗口判定当前档位（官方口径），时段表展示按北京时间。

**周末规则（2026-08-23 起）**：周六/周日（UTC 自然日）全天按谷期计价，无峰谷切换；下一阶段切换点为下周一首次进入峰时。

## 计费口径

- 价格单位：美元 / 1M tokens（官方定价页口径），成本 = 输入未命中 × cacheMiss + 输出 × output + (缓存读 + 缓存写) × cacheHit；其中「输出」已含推理 token
- **三段价格时代**，按调用发生时刻选档（历史正确性；档位顺序为 缓存命中 / 输入未命中 / 输出）：

  | 时代 | 时间范围（UTC） | deepseek-flash 档位 |
  |---|---|---|
  | 基础价 | 2026-08-16 16:00 之前 | 0.0028 / 0.14 / 0.28 |
  | 首版峰谷价 | 2026-08-16 16:00 ~ 2026-09-10 04:00 | 峰 0.014 / 0.44 / 1.32，谷为峰的一半 |
  | V4.1 Flash 新价 | 2026-09-10 04:00 起 | 峰 0.006 / 0.3 / 1.2，谷为峰的一半 |

- 每次调用的费用按**事件发生时刻**的档位计算，跨峰谷切换与跨调价均不漂移
- 账本金额以美元存储，显示时按固定汇率 6.67 换算人民币（默认）或直接显示美元

## 安装

> 需求：Node.js ≥ 20 + 带 `dsh plugin` 命令的 DeepSeek Harness。

```sh
# 方式一：从 GitHub 直装（推荐，跟随 main 最新）
dsh plugin --profile web add github:KhalilYamber/dsh-tidewatch

# 方式二：从 Release 的 tgz 安装（可固定版本、可离线）
#   先到 Releases 页面下载 dsh-tidewatch-<版本>.tgz，然后：
dsh plugin --profile web add ./dsh-tidewatch-1.1.1.tgz

# 本地目录（开发调试）
dsh plugin --profile web add link:/path/to/dsh-tidewatch
```

> **npm 渠道已暂停**：npm 上仅有一个 2026-08-22 发布的旧版本（1.0.6），其价格与规则均已过时。请勿安装该版本，也不要据它判断当前计价——以上面两种方式为准。

安装后重启 `dsh web` 生效，输入框右侧会出现潮汐徽章。

### 升级与卸载

```sh
dsh plugin --profile web update dsh-tidewatch    # 或重新执行上面的 add
dsh plugin --profile web list dsh-tidewatch      # 查看已安装版本
dsh plugin --profile web remove dsh-tidewatch    # 卸载
```

> **v1.1.1 升级提示**
> **v1.1.2 计价修正**：官方定价页脚注(2)与更新日志（2026-09-10）已声明 —— 2026-09-14 之后继续提供 V4 Pro API 服务、**计费方式保持不变**，如有变动另行通知。此前版本依据新闻发布页的旧口径，把 `deepseek-v4-pro` 从 2026-09-14 04:00 UTC 起路由到 Flash 价，会**低估** pro 调用（缓存未命中约 4.4 倍、缓存命中约 7.3 倍、输出约 3.3 倍）。本版把换价分界 `V4_PRO_RETIRE_BOUNDARY` 恢复为哨兵值，pro 恒按自身价目计费；路由分支保留，将来接到官方通知把日期填回即可。影响仅限 pro 调用，flash 与其它模型不受影响；本次不改 stateVersion，历史会话无需重放。：该版本把计价口径改为「按调用时刻在三段价格时代中选档」，并把 `costUsage` 投影版本提升到 stateVersion 4。升级后已持久化的历史会话会重放一次，2026-08-16 ~ 2026-09-10 窗口的费用会恢复为**当时**的首版峰谷价（此前按新价计算，偏低）。实时计费不受影响。

## 使用

- 徽章悬浮在输入框右侧、与输入框垂直居中对齐；窄窗口放不下时自动移到输入框上方，不遮挡输入框与官方统计栏
- 点击徽章展开/收起详情面板：时段表、当前档位价格、Token 明细、币种切换（¥ / $）
- 点击「本次会话费用」行可展开**分模型花费明细**（各模型的 token 与花费分别列出，合计 = 分模型之和）
- 币种选择即时生效并记住；人民币 2 位小数，美元 4 位小数

## 文件结构

```
dsh-tidewatch
├── package.json          # dsh.bundle.patch + dsh.client.platform 声明
├── cordis.patch.yml      # 装配行
├── scripts/build.sh      # 构建：语法检查 + zod junction
├── lib/
│   ├── pricing.js        # 纯函数：峰谷窗口、isPeakHour/peakPhaseAt、三段价格时代、costOf
│   ├── index.js          # 宿主：costUsage 会话投影（按事件时刻计费）
│   └── client.js         # 前端：悬浮徽章（__ModuleLoader__ bundle）
├── docs/PORTING.md       # 移植到其他宿主的适配说明
└── test/verify.mjs       # 纯模块自检（node test/verify.mjs，38 项）
```

## 数据流

```
模型调用 usage 块（assistant/chunk、assistant/message 事件）
        │  lib/index.js：costUsage 会话投影（zod schema 校验）
        ▼
  token 桶 + 美元成本（按事件时刻峰谷档位）
        │  useProjection('costUsage')（浏览器端）
        ▼
  lib/client.js：悬浮徽章渲染（秒级倒计时 + 汇率换算显示）
```

## 开发与验证

```sh
DSH_CHECKOUT=<harness 源码根目录> bash scripts/build.sh   # 语法检查 + zod junction
node test/verify.mjs                                       # 峰谷数学与计费自检（38 项，含双份常量一致性）
```

## 已知限制

- 价格表内置，含三段价格时代（基础价 / 首版峰谷价 / V4.1 Flash 新价）；V4-Pro 为官方 2026-08-17 价；官方定价页脚注(2)与更新日志（2026-09-10）声明 2026-09-14 之后继续提供 V4 Pro 服务、**计费方式保持不变**（如有变动另行通知），故 pro 恒按自身价目计费，换价分界 `V4_PRO_RETIRE_BOUNDARY` 保持哨兵值待官方通知。**官方调价后需手动同步** `lib/pricing.js`（计费）与 `lib/client.js` 的 `DISPLAY_PRICES`（展示）两处常量，并为旧价补一段历史档
- 模型名映射：现役 `deepseek-flash`（V4.1 Flash）；别名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4.1-flash` 均按现役 flash 价计费（见 `MODEL_ALIASES`）
- 时段判定固定按 UTC（官方口径），时段表展示按北京时间（UTC+8）
- 花费为美元账本 × 固定汇率 6.67 换算人民币（与官方人民币标价一致）；展开面板可切换美元显示

## 借鉴与许可

峰谷数学（isPeakHour / peakPhaseAt / tierFor / costOf）与会话投影结构借鉴自 [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)（MIT License），按精简目标改写。

[MIT](LICENSE) © 2026 KhalilYamber
