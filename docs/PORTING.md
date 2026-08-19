# dsh-tidewatch 移植说明（非 DeepSeek Harness 适配）

> 目标：在其他 agent / 宿主里复刻「峰谷时刻 + 会话花费」卡片。
> 核心设计原则：**计费与峰谷数学全部在纯函数里，宿主只负责喂 usage 事件。**

## 一、核心可移植单元：lib/pricing.js（零依赖）

整个插件的「大脑」不依赖 cordis / DSH 任何运行时：

| 导出 | 作用 |
|---|---|
| `isPeakHour(atMs)` | 某时刻是否峰时段（UTC 窗口） |
| `peakPhaseAt(atMs)` | 当前相位 + 下一切换点（倒计时数据源） |
| `tierFor(entry, atMs)` | 按时刻挑价格档（峰/谷/峰谷时代前 legacyBase） |
| `costOf(tokens, entry, atMs)` | 一次调用的美元成本 |
| `priceEntryFor(model)` | 模型名归一化匹配，未命中回退 default |
| `DEFAULT_PEAK_WINDOWS` / `DEFAULT_PRICE_TABLE` | 官方常量（改价只动这里） |

任何宿主只需做到：**把每次模型调用的 `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, model, time }` 交给 `costOf`**，就得到与官方账单口径一致的美元成本。

## 二、三种适配深度

### 1. 最轻：纯前端复刻（不接宿主数据）
- 复制 `client.js` 里的 `isPeakHourUTC` / `nextPhase` / 时段表常量到任意 Web 界面
- 峰谷卡片立即可用（倒计时、时段表、档位价格）
- 会话花费留空（`usage` 为 `undefined` 时显示 ¥0.00）

### 2. 标准：宿主提供 usage 流（对应 DSH 的会话投影）
- 宿主侧实现一个「会话 token 累加器」：从流式响应收 usage 块，累加桶
- 计费建议在宿主侧做（保留每次调用时刻，跨峰谷切换才准确）
- 前端订阅累加结果渲染（对应 DSH 的 `useProjection('costUsage')`）

### 3. 完整：按 DSH 原样
- host：`ctx.inject(['sessionProjections'])` 注册 `costUsage` 投影（lib/index.js）
- client：`slots.register({ name: 'conversation.composer.dock' }, TideCard)`（lib/client.js）

## 三、DSH 特有接口速查（其他宿主请替换）

| DSH 概念 | 作用 | 移植替代 |
|---|---|---|
| `sessionProjections.register` | 会话级事件折叠（request/header、assistant/chunk usage） | 宿主自己的流式事件钩子 |
| `useProjection('costUsage')` | 前端订阅投影视图 | 状态管理 / 订阅式 store |
| `conversation.composer.dock` 插槽 | 输入区下方渲染位 | 宿主输入框附近的容器节点 |
| `--dsw-*` CSS 变量 | 主题跟随 | 宿主主题变量或硬编码双主题 |

## 四、注意事项

- **时段判定用 UTC**：官方峰谷窗口按 UTC 定义（01:00–04:00、06:00–10:00），不要在客户端用本地时区判定；展示层再转换成本地时段表
- **计费时刻**：用每次调用完成/事件到达的时刻，不要用「当前时刻」回算历史调用，否则跨峰谷切换时金额会漂移
- **缓存桶**：DeepSeek usage 的 `cacheReadTokens`/`cacheWriteTokens` 按命中价计费，别并进未命中输入桶
- **半开区间**：窗口为 `[start, end)`，04:00:00 整点属于谷期
- **改价**：官方调价后同步 `pricing.js`（计费）与 `client.js` 的 `DISPLAY_PRICES`（展示）两处常量

## 五、验证清单（node test/verify.mjs）

- 峰谷窗口边界（01:00/04:00/06:00/10:00 整点归属）
- 下一切换点计算（跨午夜窗口）
- 峰/谷两档价格与 legacyBase 历史价
- 缓存读写按命中价计费
- 未知模型回退 default
