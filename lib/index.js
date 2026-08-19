/**
 * dsh-tidewatch 宿主插件。
 *
 * 职责只有一个：注册 `costUsage` 会话投影——从会话事件流（request/header、
 * assistant/chunk、assistant/message）收集每次模型调用的 usage 块，按事件
 * 时刻（event.time）用官方峰谷两档价格逐次计费，产出 token 桶与美元成本。
 * 前端（lib/client.js）经 useProjection('costUsage') 读取，按可配汇率换算
 * 人民币显示。
 *
 * 投影工厂结构借鉴自 dsh-cost-meter（MIT License），按精简目标改写：
 * 无账本、无 RPC、无配置，峰谷恒启用（官方 2026-08-17 起两档方案已即时生效）。
 */

import { z } from 'zod'
import { costOf, priceEntryFor } from './pricing.js'

export const name = 'tidewatch'

const bucketSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
})

const usageProjectionSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
  byModel: z.record(z.string(), bucketSchema),
})

/**
 * costUsage 会话投影工厂：闭包无状态（不依赖账本/配置），按事件时刻
 * (event.time) 用当时的价格档位逐次计费，保证会话徽章历史正确。
 */
function makeCostUsageProjection() {
  const zeroBuckets = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 })
  return {
    key: 'costUsage',
    schema: usageProjectionSchema,
    stateVersion: 1,
    init: () => ({ provider: 'deepseek', model: 'default', totals: zeroBuckets(), byModel: {}, last: null }),
    apply(state, event) {
      if (event.type === 'request/header') {
        const model = event.data?.header?.config?.model
        const provider = event.data?.header?.config?.provider
        const nextModel = typeof model === 'string' && model.length > 0 ? model : 'default'
        const nextProvider = typeof provider === 'string' && provider.length > 0 ? provider : 'deepseek'
        return nextModel === state.model && nextProvider === state.provider ? state : { ...state, model: nextModel, provider: nextProvider }
      }
      let usage = null
      let turn = 0
      let step = 0
      if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage' && event.data.chunk.usage !== undefined) {
        usage = event.data.chunk.usage
        turn = event.data.turn
        step = event.data.step
      } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
        usage = event.data.usage
        turn = event.data.turn
        step = event.data.step
      } else {
        return state
      }
      const buckets = {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        reasoning: usage.reasoningTokens ?? 0,
      }
      const key = `${turn}:${step}`
      const prev = state.last !== null && state.last.key === key ? state.last : null
      if (prev !== null && prev.provider === state.provider && prev.model === state.model
        && prev.buckets.input === buckets.input && prev.buckets.output === buckets.output
        && prev.buckets.cacheRead === buckets.cacheRead && prev.buckets.cacheWrite === buckets.cacheWrite
        && prev.buckets.reasoning === buckets.reasoning) {
        return state
      }
      // 按事件时刻计费（历史正确）：峰谷时代前用 legacyBase，之后按峰谷两档。
      const atMs = Number.isFinite(Number(event.time)) && Number(event.time) > 0 ? Number(event.time) : Date.now()
      const entry = priceEntryFor(state.model)
      const billed = costOf(buckets, entry, atMs)
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
      return { provider: state.provider, model: state.model, totals, byModel, last: { key, model: state.model, buckets, cost: billed } }
    },
    view(state) {
      return {
        input: state.totals.input,
        output: state.totals.output,
        cacheRead: state.totals.cacheRead,
        cacheWrite: state.totals.cacheWrite,
        reasoning: state.totals.reasoning,
        cost: state.totals.cost,
        byModel: state.byModel,
      }
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
    projectionCtx.sessionProjections.register(makeCostUsageProjection())
  })
}
