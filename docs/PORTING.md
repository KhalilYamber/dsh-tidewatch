# dsh-tidewatch 移植说明（非 DeepSeek Harness 适配）

> 目标：在其他 agent / 宿主里复刻「峰谷时刻 + 会话花费」卡片。
> 核心设计原则：**计费与峰谷数学全部在纯函数里，宿主只负责喂 usage 事件。**

## 一、核心可移植单元：lib/pricing.js（零依赖）

整个插件的「大脑」不依赖 cordis / DSH 任何运行时：

| 导出 | 作用 |
|---|---|
| `isPeakHour(atMs)` | 某时刻是否峰时段（UTC 窗口；周末全天谷期） |
| `peakPhaseAt(atMs)` | 当前相位 + 下一次切换点（倒计时数据源） |
| `tierFor(entry, atMs)` | 按时刻在三段价格时代中选档：基础价（legacyBase）/ 首版峰谷价（priorPeak、priorOffPeak）/ 现行峰谷价（peak、offPeak） |
| `costOf(tokens, entry, atMs)` | 一次调用的美元成本 |
| `priceEntryFor(model, atMs)` | 模型名归一化匹配 + 别名表（MODEL_ALIASES）→ 价目；未命中回退 default |
| `DEFAULT_PEAK_WINDOWS` | 峰时段窗口（UTC 小时，半开区间） |
| `DEFAULT_PRICE_TABLE` | 官方价目（改价只动这里） |
| `MODEL_ALIASES` | 旧模型名 / 过渡期名称 → 现役模型 key |
| `LEGACY_BASE_BOUNDARY` | 峰谷时代起点（此前按 legacyBase 计费） |
| `FLASH_REPRICE_BOUNDARY` | V4.1 Flash 换价分界（此前用 prior 档） |
| `V4_PRO_RETIRE_BOUNDARY` | V4 Pro 换价分界，现为哨兵值（官方声明计费方式不变） |

任何宿主只需做到「**按调用时刻取价目，再算成本**」：

```js
const entry = priceEntryFor(model, event.time)   // 模型 → 价目（含历史档）
const usd = costOf({ input, output, cacheRead, cacheWrite, reasoning }, entry, event.time)
```

就得到与官方账单口径一致的美元成本。

## 二、三种适配深度

### 1. 最轻：纯前端复刻（不接宿主数据）
- 复制 `client.js` 里的 `isPeakHourUTC` / `nextPhase` / 时段表常量到任意 Web 界面
- 峰谷卡片立即可用（倒计时、时段表、档位价格）
- 会话花费留空（`usage` 为 `undefined` 时显示 ¥0.00）

### 2. 标准：宿主提供 usage 流（对应 DSH 的会话投影）
- 宿主侧实现一个「会话 token 累加器」：从流式响应收 usage 块，累加桶
- 计费在宿主侧做（保留每次调用时刻，跨峰谷切换与跨调价才准确）
- 前端订阅累加结果渲染（对应 DSH 的 `useProjection('costUsage')`）

### 3. 完整：按 DSH 原样
- host：`ctx.inject(['sessionProjections'])` 注册 `costUsage` 投影（lib/index.js）
- client：**两个插槽席位，职责不同**——
  - `conversation.composer.dock`（session 作用域）挂数据探针 `Probe`，渲染 null，
    只为拿到 `useProjection` 席位并把投影值写进模块级 bridge；
  - `shell.overlay`（root 作用域）挂悬浮徽章 `TideCard`，从 bridge 读值渲染
    （root 级插槽没有投影席位，这是需要两个组件的原因）。
- client 可选增强：优先 `require('@deepseek-ai/dsh-client-ui-primitives')`
  （shell 共享模块表中的 baseline 模块）取 `StateDot` / `Tag` / `Tooltip` /
  `useDismissOnOutsidePointer`，拿不到时自动退回内置实现。

## 三、DSH 特有接口速查（其他宿主请替换）

| DSH 概念 | 作用 | 移植替代 |
|---|---|---|
| `sessionProjections.register` | 会话级事件折叠（request/header、assistant/chunk usage） | 宿主自己的流式事件钩子 |
| `useProjection('costUsage')` | 前端订阅投影视图 | 状态管理 / 订阅式 store |
| `conversation.composer.dock` / `shell.overlay` 插槽 | 数据探针位 / 根级浮层位 | 输入区附近的容器节点 + 全局浮层 |
| `@deepseek-ai/dsh-client-ui-primitives` | 官方共享 UI 原语（模块表 baseline） | 宿主自有控件库，或本插件的内置实现 |
| `--dsw-*` CSS 变量 | 主题跟随 | 宿主主题变量或硬编码双主题 |

## 四、注意事项

- **时段判定用 UTC**：官方峰谷窗口按 UTC 定义（01:00–04:00、06:00–10:00），不要在客户端用本地时区判定；展示层再转换成本地时段表
- **计费时刻**：用每次调用事件自带的时刻，不要用「当前时刻」回算历史调用，否则跨峰谷切换与跨调价时金额都会漂移
- **缓存桶**：DeepSeek usage 的 `cacheReadTokens`/`cacheWriteTokens` 按命中价计费，别并进未命中输入桶
- **半开区间**：窗口为 `[start, end)`，04:00:00 整点属于谷期
- **周末规则**：2026-08-23 起周六/周日（UTC 自然日）全天谷期，切换点计算须跳过周末
- **改价**：官方调价后同步 `pricing.js`（计费）与 `client.js` 的 `DISPLAY_PRICES`（展示），
  并为被替换的旧价**补一段历史档**（`priorPeak` / `priorOffPeak` 的成例）；否则历史会话
  重放时会按新价计算，静默低估

## 五、验证清单（node test/verify.mjs，39 项）

- 峰谷窗口边界（01:00 / 04:00 / 06:00 / 10:00 整点归属）与周末规则
- 下一切换点计算（跨午夜窗口、周末 → 下周一）
- 三段价格时代（基础价 / 首版峰谷价 / 现行价）与换价分界前后一刻
- 模型别名命中、未知模型回退 default
- pro 换价分界哨兵值（当前不触发，pro 恒按自身价目）
- 缓存读写按命中价计费、负 token 非负保护
- 双份常量一致性（client 的 `PEAK_WINDOWS` / `DISPLAY_PRICES` / `MODEL_ALIASES` 与 pricing 对齐）
