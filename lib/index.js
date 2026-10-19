/**
 * dsh-tidewatch 宿主插件。
 *
 * 职责只有一个：注册 `costUsage` 会话投影——从会话事件流（request/header、
 * assistant/message）收集每次模型调用的 usage 块，按事件时刻（event.time）
 * 在三段价格时代中选档，逐次计费，产出 token 桶与美元成本。
 * 前端（lib/client.js）经 useProjection('costUsage') 读取，按可配汇率换算
 * 人民币显示。
 *
 * 计费事件源（2026-09-27 随 DSH 0.1.7-rc.2 收敛）：
 *   - `assistant/message` 是**唯一**携带 usage 的事件
 *     （dsh-session `SessionEventMap['assistant/message'].usage?: TokenUsage`）；
 *   - `assistant/chunk` 自会话格式 v3 起已被折叠（迁移实测：升到 v3 后该类型
 *     行数为 0），现代 agent loop 只 append `assistant/attempt`
 *     （`{ turn, step, stream }`，payload 里没有 usage 字段），故该分支是死代码；
 *   - 失败/被重试的 `assistant/attempt` 不计费——与官方 token-meter 口径一致
 *     （它同样只认 assistant/message 的 usage）。这是口径上限，不是遗漏。
 *
 * 投影工厂结构借鉴自 dsh-cost-meter（MIT License），按精简目标改写：
 * 无账本、无 RPC、无配置，峰谷恒启用（官方 2026-08-17 起两档方案已即时生效）。
 */

import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { costOf, isPricedModel, priceEntryFor } from './pricing.js'

/**
 * provider 是否属于 DeepSeek。官方分时定价只适用于 DeepSeek 自家的模型；其他提供商
 * （Claude / GPT / Kimi 等）没有峰谷之分，按 flash 价计价会得出与真实账单无关的数字。
 * provider 通常是 `deepseek`，也可能带中转或自建网关前缀，故用包含判断。
 * @param provider - 请求头里的 provider id。
 * @returns 属于 DeepSeek 时为 true。
 */
function isDeepSeekProvider(provider) {
  return typeof provider === 'string' && provider.toLowerCase().includes('deepseek')
}

export const name = 'tidewatch'

const bucketSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
})

// 投影内部状态 schema（session-projection 新版接口：stateSchema 在持久化缓存
// 恢复前校验 state；state 必须是 plain JSON）。
const costUsageStateSchema = z.object({
  provider: z.string(),
  model: z.string(),
  totals: bucketSchema,
  byModel: z.record(z.string(), bucketSchema),
  last: z.union([
    z.null(),
    z.object({ key: z.string(), model: z.string(), buckets: bucketSchema, cost: z.number() }),
  ]),
})

// 客户端 wire 载荷 schema（view 输出，随 session/projection 帧推送给浏览器）。
/**
 * 从一次 assistant 结算里取用量，与 DSH 官方 token-meter 的 usageOf 完全同构：
 * 1. `event.data.usage`（直接字段）；
 * 2. 回退到 `event.data.stream` 里最后一条 `{ type: 'chunk', chunk: { type: 'usage' } }`。
 *
 * 两个来源事件都要看：`assistant/message` 与 `assistant/attempt`。账号内置通道
 * （provider `deepseek-account`）的用量常挂在 attempt 的流记录上，只读 message 会一无所获。
 * 「一次调用恰好一笔」由折叠时的 (turn, step) 替换与 llm/retry-started 清槽共同保证。
 *
 * @param event - 会话事件。
 * @returns 用量对象；两条路都取不到时为 null。
 */
export function usageOfEvent(event) {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
  if (event.data?.usage !== undefined) return event.data.usage
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    const chunk = record?.chunk
    if (record?.type === 'chunk' && chunk?.type === 'usage' && chunk.usage !== undefined) return chunk.usage
  }
  return null
}

/** 仅供 test/verify.mjs 断言；运行时不使用。 */
/**
 * 诊断计数：本进程内实际收到的结算事件数、其中带用量的条数。
 * 只用于面板显示与排障，不参与任何计费判断；重放会话时会再次累加，故只当「是否为零」看。
 */
export const __usageDiag = { message: 0, attempt: 0, usageFound: 0 }

/**
 * 官方 tokenUsage 投影的最近一次采样值。
 *
 * 为什么要绕这一道：账号内置通道（provider `deepseek-account`）不向本插件的投影
 * 提供 usage，但 DSH 官方的 `tokenUsage` 投影有数据（对话页底部那行 token 统计就是它）。
 * 投影之间不能互相读取，所以只能在宿主侧用 `sessionProjections.snapshot` 采样后存下来。
 *
 * 只保留最近一次：视图函数拿不到 sessionId，多会话并发时以最后活跃的那个为准。
 * 单会话场景下就是准确值，这也是本插件的主要用法。
 */
let lastOfficialTokens = null

/**
 * 排障用：把宿主侧看到的东西写到磁盘，这样不必让用户在界面上转述。
 * 只记结构化的计数与状态，不含任何会话内容。
 */
const diagState = { registered: false, registerError: null, schemaOk: false, schemaError: null, listenerOk: null, listenerError: null, keys: [], stateVersion: 0, events: 0, lastEventType: null }
function writeDiag(extra) {
  try {
    const payload = { at: new Date().toISOString(), version: '1.21.0', ...diagState, ...extra }
    writeFileSync(join(homedir(), '.dsh', 'tidewatch-diag.json'), JSON.stringify(payload, null, 2), 'utf8')
  } catch { /* 排障文件写不成不影响插件功能 */ }
}

/**
 * 采样一次官方投影。服务不可用或该投影未注册时静默跳过，前端会回退到自有投影。
 * @param ctx - 宿主上下文。
 * @param session - 要采样的会话。
 */
function sampleOfficialTokens(ctx, session) {
  try {
    const snapshot = ctx.sessionProjections?.snapshot?.(session, ['tokenUsage'])
    const value = snapshot?.values?.tokenUsage
    if (value === undefined || value === null) return
    lastOfficialTokens = {
      uncachedInputTokens: Number(value.uncachedInputTokens) || 0,
      outputTokens: Number(value.outputTokens) || 0,
      cacheReadTokens: Number(value.cacheReadTokens) || 0,
      cacheWriteTokens: Number(value.cacheWriteTokens) || 0,
    }
  } catch (error) {
    // 投影服务不可用（老版本宿主）：保持上一次的值，前端会自动回退到自有投影。
    if (typeof ctx.logger?.debug === 'function') ctx.logger.debug('tidewatch: tokenUsage 采样失败', error)
  }
}

export const __testables = { usageOfEvent }

const usageProjectionSchema = z.object({
  // 最近一次请求的 provider：前端据此判断峰谷与金额是否适用（非 DeepSeek 家族
  // 的模型不走官方分时定价，金额显示为「不适用」而不是 0）。
  provider: z.string(),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
  byModel: z.record(z.string(), bucketSchema),
  usageMissed: z.boolean(),
  diag: z.object({
    message: z.number(),
    attempt: z.number(),
    usageFound: z.number(),
  }),
  official: z.object({
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
  }).strict().nullable(),
})

/**
 * costUsage 会话投影工厂：闭包无状态（不依赖账本/配置），按事件时刻
 * (event.time) 用当时的价格档位逐次计费，保证会话徽章历史正确。
 * 导出给 test/verify.mjs 做计费口径回归（宿主装配路径不受影响）。
 */
export function makeCostUsageProjection() {
  const zeroBuckets = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 })
  return {
    key: 'costUsage',
    stateSchema: costUsageStateSchema,
    // v4：补首版峰谷价档（2026-08-16 16:00Z ~ 2026-09-10 04:00Z）并显式登记
    // V4.1 Flash 更名别名，修正换价窗口内的计价口径。ver=3 缓存行由旧代码
    // fold（其换价窗口内金额按当时价计，重放结果与之一致），此处 bump 只为
    // 让口径统一到「按事件时刻三段选档」，代价是一次全量重放。
    // v5：计费事件源收敛到 assistant/message（assistant/chunk 分支删除，
    // 该事件在现代会话格式里已不存在）。历史缓存行的 ver 与 5 不匹配即被
    // 弃用重放；本投影按事件时刻即时计费，重放本就必须发生才准。
    // v6：非 DeepSeek 家族的模型不再进账（此前按 flash 价兜底，得出与账单无关
    // 的数字）。历史缓存里若含这类调用，其金额会在重放后被修正为 0，故 bump。
    stateVersion: 10,
    init: () => ({ provider: 'deepseek', model: 'default', totals: zeroBuckets(), byModel: {}, last: null, usageMissed: false }),
    apply(state, event) {
      if (event.type === 'request/header') {
        const model = event.data?.header?.config?.model
        const provider = event.data?.header?.config?.provider
        const nextModel = typeof model === 'string' && model.length > 0 ? model : 'default'
        const nextProvider = typeof provider === 'string' && provider.length > 0 ? provider : 'deepseek'
        return nextModel === state.model && nextProvider === state.provider ? state : { ...state, model: nextModel, provider: nextProvider }
      }
      // 现行 DSH 只在这一个事件上携带 usage（见文件头「计费事件源」）。
      // 同一步骤流内可能出现多条（重试/中断后重新结算），下方用 (turn, step)
      // 做「先减后加」替换，保证每一步骤只记最后一笔。
      // 用量两条路：data.usage 优先，取不到再回退到 data.stream 里的 usage 块
      // （账号内置通道 provider `deepseek-account` 下直接字段可能为空）。
      // 重试开始：清空最后一条样本槽，让重试后的新 attempt 独立累计（照官方口径）。
      if (event.type === 'llm/retry-started') {
        const lastTurn = state.last?.turn
        const lastStep = state.last?.step
        return lastTurn === event.data?.turn && lastStep === event.data?.step
          ? { ...state, last: null }
          : state
      }
      if (event.type === 'assistant/message') __usageDiag.message += 1
      if (event.type === 'assistant/attempt') __usageDiag.attempt += 1
      const usage = usageOfEvent(event)
      if (usage !== null) __usageDiag.usageFound += 1
      if (usage === null) {
        // 收到过结算事件却拿不到用量：多半是该 provider 不返回 usage
        // （账号内置通道 deepseek-account 即如此）。记住这件事，界面据此如实标注，
        // 而不是把「没有数据」显示成 ¥0.00 让人误以为免费。
        return state.usageMissed ? state : { ...state, usageMissed: true }
      }
      const cleared = state.usageMissed ? { ...state, usageMissed: false } : state
      const turn = event.data.turn
      const step = event.data.step
      const buckets = {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        reasoning: usage.reasoningTokens ?? 0,
      }
      const key = `${turn}:${step}`
      const prev = cleared.last !== null && cleared.last.key === key ? cleared.last : null
      if (prev !== null && prev.provider === state.provider && prev.model === state.model
        && prev.buckets.input === buckets.input && prev.buckets.output === buckets.output
        && prev.buckets.cacheRead === buckets.cacheRead && prev.buckets.cacheWrite === buckets.cacheWrite
        && prev.buckets.reasoning === buckets.reasoning) {
        // 事件与上次相同：状态不变，但仍要把「用量缺失」标记清掉（cleared 已处理）。
        return cleared
      }
      // 按事件时刻计费（历史正确）：基础价 → 首版峰谷价 → 现行峰谷价，三段选档。
      // 非 DeepSeek 家族的模型不进账：它不遵循官方分时定价，按 flash 价硬算得到的
      // 数字与账单无关，比不显示更容易误导。前端据 provider 与是否已收录显示「不适用」。
      const atMs = Number.isFinite(Number(event.time)) && Number(event.time) > 0 ? Number(event.time) : Date.now()
      const priced = isDeepSeekProvider(state.provider) || isPricedModel(state.model)
      const billed = priced ? costOf(buckets, priceEntryFor(state.model, atMs), atMs) : 0
      // 同一 (turn, step) 的最终样本替换流式样本，先减后加，避免重复计数。
      const totals = { ...state.totals }
      const byModel = { ...state.byModel }
      const shift = (model, bucket, cost, sign) => {
        totals.input += sign * bucket.input
        totals.output += sign * bucket.output
        totals.cacheRead += sign * bucket.cacheRead
        totals.cacheWrite += sign * bucket.cacheWrite
        totals.reasoning += sign * bucket.reasoning
        totals.cost += sign * cost
        const current = byModel[model] ?? zeroBuckets()
        byModel[model] = {
          input: current.input + sign * bucket.input,
          output: current.output + sign * bucket.output,
          cacheRead: current.cacheRead + sign * bucket.cacheRead,
          cacheWrite: current.cacheWrite + sign * bucket.cacheWrite,
          reasoning: current.reasoning + sign * bucket.reasoning,
          cost: current.cost + sign * cost,
        }
      }
      if (prev !== null) shift(prev.model, prev.buckets, prev.cost, -1)
      shift(state.model, buckets, billed, 1)
      return { provider: state.provider, model: state.model, totals, byModel, last: { key, model: state.model, buckets, cost: billed }, usageMissed: state.usageMissed, diag: { ...__usageDiag }, official: lastOfficialTokens }
    },
    // 客户端可见视图：缺失 wire 会令该投影成为 host-only，浏览器端
    // useProjection 永远读不到——这是 DSH 升级后消费恒为 0 的根因。
    wire: {
      viewSchema: usageProjectionSchema,
      view(state) {
        return {
          // 当前会话正在使用的模型与 provider（最近一次请求头；无请求时为 default/deepseek）。
          provider: state.provider,
          model: state.model,
          input: state.totals.input,
          output: state.totals.output,
          cacheRead: state.totals.cacheRead,
          cacheWrite: state.totals.cacheWrite,
          reasoning: state.totals.reasoning,
          cost: state.totals.cost,
          byModel: state.byModel,
          usageMissed: state.usageMissed === true,
          diag: state.diag ?? { message: 0, attempt: 0, usageFound: 0 },
          official: lastOfficialTokens,
        }
      },
    },
  }
}

/**
 * 挂载：注册 costUsage 会话投影。无其他宿主职责。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  console.log('[dsh-tidewatch] loaded (peak/off-peak tide card)')
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    // 第一步：注册投影。这一步失败就什么都不用谈了，单独记下来。
    try {
      projectionCtx.sessionProjections.register(makeCostUsageProjection())
      diagState.registered = true
    } catch (error) {
      diagState.registered = false
      diagState.registerError = error && error.message ? error.message : String(error)
      writeDiag()
      throw error
    }

    // 第二步：用初始状态验证 wire schema。校验不过时宿主不会推送这个 key。
    try {
      const probe = makeCostUsageProjection()
      const parsed = probe.wire.viewSchema.parse(probe.wire.view(probe.init()))
      diagState.schemaOk = true
      diagState.keys = Object.keys(parsed)
      diagState.stateVersion = probe.stateVersion
      writeDiag()
    } catch (error) {
      diagState.schemaOk = false
      diagState.schemaError = error && error.message ? error.message : String(error)
      writeDiag()
    }

    // 第三步：监听结算事件，采样官方 tokenUsage 投影。
    // 单独包 try：这一步若抛错会连累上面已完成的注册被回滚，
    // 表现为宿主日志 active、前端却拿不到任何投影值。
    try {
      projectionCtx.on('session/event', (session, event) => {
        if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
        diagState.events += 1
        diagState.lastEventType = event.type
        sampleOfficialTokens(projectionCtx, session)
        writeDiag({ official: lastOfficialTokens })
      })
      diagState.listenerOk = true
    } catch (error) {
      diagState.listenerOk = false
      diagState.listenerError = error && error.message ? error.message : String(error)
    }
    writeDiag()
  })
}