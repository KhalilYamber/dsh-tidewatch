# dsh-tidewatch

**DeepSeek 峰谷时刻悬浮徽章**：一张悬浮在输入框旁的潮汐卡，告诉你此刻是峰期还是谷期、距下一阶段还有多久、本次会话花了多少钱。

- 状态点：**峰期橙红 / 谷期蓝绿**，一眼可辨
- 折叠态：`● 峰期 距谷期 03:33 · ¥0.12`
- 展开态（点击展开）：官方峰谷时段表（北京时间）、当前档位价格、本次会话 Token 明细、汇率设置
- 计费：官方峰谷两档价格，按每次调用**实际发生时刻**的档位计价，缓存命中/未命中分开
- 汇率：美元账本 → 人民币显示，汇率可调（默认 7.2，localStorage 持久化）
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

## 计费口径

- 价格单位：美元 / 1M tokens（官方定价页口径），成本 = 输入未命中 × cacheMiss + 输出 × output + (缓存读 + 缓存写) × cacheHit
- 峰谷时代之前（2026-08-16 16:00 UTC）的调用按当时的基础价计费（历史正确性）
- 每次调用的费用按**事件发生时刻**的档位计算，跨峰谷切换不漂移
- 账本金额以美元存储，显示时按可配汇率换算人民币

## 安装

> 需求：Node.js ≥ 20 + DeepSeek Harness（带 `dsh plugin` 命令的版本）。

```sh
# npm 包安装（发布后可用）
dsh plugin --profile web add dsh-tidewatch

# 或本地目录（开发调试）
dsh plugin --profile web add link:./dsh-tidewatch
```

安装后重启 `dsh web` 生效。

## 使用

- 徽章悬浮在输入框右侧、与输入框垂直居中对齐；窄窗口放不下时自动移到输入框上方，不遮挡输入框与官方统计栏
- 点击徽章展开/收起详情面板：时段表、当前档位价格、Token 明细、汇率设置
- 汇率修改即时生效并记住

## 文件结构

```
dsh-tidewatch
├── package.json          # dsh.bundle.patch + dsh.client.platform 声明
├── cordis.patch.yml      # 装配行
├── scripts/build.sh      # 构建：语法检查 + zod junction
├── lib/
│   ├── pricing.js        # 纯函数：峰谷窗口、isPeakHour/peakPhaseAt、价格表、costOf
│   ├── index.js          # 宿主：costUsage 会话投影（按事件时刻计费）
│   └── client.js         # 前端：悬浮徽章（__ModuleLoader__ bundle）
├── docs/PORTING.md       # 移植到其他宿主的适配说明
└── test/verify.mjs       # 纯模块自检（node test/verify.mjs，19 项）
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
node test/verify.mjs                                       # 峰谷数学与计费自检（19 项，含双份常量一致性）
```

## 已知限制

- 价格表内置（V4-Flash / V4-Pro 官方 2026-08-17 价）。**官方调价后需手动同步** `lib/pricing.js`（计费）与 `lib/client.js` 的 `DISPLAY_PRICES`（展示）两处常量
- 时段判定固定按 UTC（官方口径），时段表展示按北京时间（UTC+8）
- 花费为美元账本 × 汇率换算；汇率默认 7.2，可在展开面板调整

## 借鉴与许可

峰谷数学（isPeakHour / peakPhaseAt / tierFor / costOf）与会话投影结构借鉴自 [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)（MIT License），按精简目标改写。

[MIT](LICENSE) © 2026 KhalilYamber
