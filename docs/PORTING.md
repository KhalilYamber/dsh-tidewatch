# dsh-tidewatch 移植说明（非 DeepSeek Harness 适配）

> 目标：在其他 agent / 宿主里复刻「峰谷时刻 + 会话花费」卡片。
> 核心设计原则：**计费与峰谷数学全部在纯函数里，宿主只负责喂 usage 事件。**

## 一、核心可移植单元：lib/pricing.js（零依赖）

整个插件的「大脑」不依赖 cordis / DSH 任何运行时：

| 导出 | 作用 |
|---|---|
| `isPeakHour(atMs)` | 某时刻是否峰时段（UTC 窗口；周末与法定节假日全天谷期） |
| `peakPhaseAt(atMs)` | 当前相位 + 下一次切换点（倒计时数据源；跳过周末/节假日，扫描范围前后各 14 天） |
| `isAllDayOffPeak(atMs)` | 是否全天谷期（周末或法定节假日，规则无条件适用，不设生效时间） |
| `tierFor(entry, atMs)` | 按时刻在三段价格时代中选档：基础价（legacyBase）/ 首版峰谷价（priorPeak、priorOffPeak）/ 现行峰谷价（peak、offPeak） |
| `costOf(tokens, entry, atMs)` | 一次调用的美元成本 |
| `priceEntryFor(model, atMs)` | 模型名归一化匹配 + 别名表（MODEL_ALIASES）→ 价目；未命中回退 default |
| `DEFAULT_PEAK_WINDOWS` | 峰时段窗口（UTC 小时，半开区间） |
| `DEFAULT_PRICE_TABLE` | 官方价目（改价只动这里） |
| `MODEL_ALIASES` | 旧模型名 / 过渡期名称 → 现役模型 key |
| `CN_PUBLIC_HOLIDAYS` | 中国法定节假日表（北京时间自然日；2027 年起需手动补新一年） |
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
- client：**两个插槽、各司其职**
  - `conversation.composer.dock`（session 作用域）：挂一个渲染 `null` 的数据探针 `Probe`，只负责把
    `useProjection('costUsage')` 的值写进模块级 bridge。之所以需要它，是因为根级插槽拿不到投影席位。
  - `shell.overlay`（根作用域）：挂 `TideCard`，从 bridge 读值渲染右下角挂件。
    - **形态**：立绘 + 秒级倒计时；可拖拽，松手吸附较近的左右边缘，位置存 localStorage，吸附左侧时内容镜像。
    - **浮层**：泡泡与完整面板都挂在挂件内部做绝对定位（`bottom: calc(100% + 10px)`），不 portal、不测量。
      portal 加位置测量的写法在测量时机不对时会把浮层渲染到屏幕外，这是踩过的坑。
    - **交互**：点击在 `pointerup` 里按位移判定（小于 4px 视为点击），不要依赖 `click`：
      `setPointerCapture` 会把它之后 click 的 target 改到被捕获元素，按钮的 `onClick` 就收不到点击了。
- client 可选增强：优先 `require('@deepseek-ai/dsh-client-ui-primitives')`
  （shell 共享模块表中的 baseline 模块）取 `StateDot` / `Tag` / `Tooltip` /
  `useDismissOnOutsidePointer`，拿不到时自动退回内置实现。
- client 余额：`ctx.remote.account.getBalance({ version, locale, timezoneOffsetSeconds })`，
  返回 `{ ok, value }`；value 为 null（未登录）、`{ status:'ready', value:[充值钱包],
  bonusWallets:[礼金钱包] }` 或 `{ status:'failed' }`，钱包是 `{ currency, balance }`。
  充值余额与礼金互不重叠，相加才是钱包总额（官网口径）。宿主对账号查询带缓存，
  失效条件是「凭证变化或销毁」而非「有事件」，所以监听事件重查拿不到新值：本插件按
  30 秒轮询（页面不可见时降频），并把读数时刻如实显示在面板里。

## 三、DSH 特有接口速查（其他宿主请替换）

| DSH 概念 | 作用 | 移植替代 |
|---|---|---|
| `sessionProjections.register` | 会话级事件折叠（request/header、assistant/message 的 usage） | 宿主自己的流式事件钩子 |
| `useProjection('costUsage')` | 前端订阅投影视图 | 状态管理 / 订阅式 store |
| `conversation.composer.dock` 插槽 | 输入框下方停靠行（session 作用域，带投影席位） | 输入区下方的一条 flex 行 |
| `@deepseek-ai/dsh-client-ui-primitives` | 官方共享 UI 原语（模块表 baseline） | 宿主自有控件库，或本插件的内置实现 |
| `ctx.remote.account.getBalance` | 读取账户余额（充值 / 礼金 / 合计），**查询由宿主执行** | 宿主自有账户接口，或自行调用官方 `/user/balance`（此时密钥要自己管） |
| `--dsw-*` CSS 变量 | 主题跟随 | 宿主主题变量或硬编码双主题 |

## 四、注意事项

- **时段判定用 UTC**：官方峰谷窗口按 UTC 定义（01:00–04:00、06:00–10:00），不要在客户端用本地时区判定；展示层再转换成本地时段表
- **计费时刻**：用每次调用事件自带的时刻，不要用「当前时刻」回算历史调用，否则跨峰谷切换与跨调价时金额都会漂移
- **缓存桶**：DeepSeek usage 的 `cacheReadTokens`/`cacheWriteTokens` 按命中价计费，别并进未命中输入桶
- **半开区间**：窗口为 `[start, end)`，04:00:00 整点属于谷期
- **周末与节假日规则**：2026-08-23 起周六/周日（UTC 自然日）全天谷期；2026-09-19 核对的官方口径还包含法定节假日全天空闲。切换点计算须跳过这些整天；法定节假日按**北京时间自然日**判定（`beijingDateString`），连休最长 9 天（春节），切换点扫描范围已放宽到前后各 14 天
- **适用边界**：峰谷档位与金额只对 DeepSeek 自家模型成立。其他提供商的模型不走官方分时定价，
  插件一律不估价（宿主侧 cost 记 0），界面显示「不适用」。移植时同理：不要拿某个模型的单价
  去折算别的模型的 token，那会得到与账单无关的数字
- **改价**：官方调价后同步 `pricing.js`（计费）与 `client.js` 的 `DISPLAY_PRICES`（展示），
  并为被替换的旧价**补一段历史档**（`priorPeak` / `priorOffPeak` 的成例）；否则历史会话
  重放时会按新价计算，静默低估

## 五、验证清单（node test/verify.mjs，83 项；另有 test/ui-smoke.mjs 布局冒烟 10 项）

- 峰谷窗口边界（01:00 / 04:00 / 06:00 / 10:00 整点归属）、周末规则与法定节假日规则
- 下一切换点计算（跨午夜窗口、周末 → 下周一、节假日 → 下一个工作日，含 7 天连休）
- 三段价格时代（基础价 / 首版峰谷价 / 现行价）与换价分界前后一刻
- 模型别名命中；DeepSeek 家族未知模型回退 default；其他提供商的模型判定为不计价
- pro 换价分界哨兵值（当前不触发，pro 恒按自身价目）
- 缓存读写按命中价计费、负 token 非负保护
- 双份常量一致性（client 的 `PEAK_WINDOWS` / `DISPLAY_PRICES` / `MODEL_ALIASES` / `CN_PUBLIC_HOLIDAYS` 与 pricing 对齐）
- 布局冒烟（`test/ui-smoke.mjs`）：挂件可见、指针可点中、泡泡在形象上方、左侧吸附不溢出视口、金额单段渲染、倒计时为 `时:分:秒`
