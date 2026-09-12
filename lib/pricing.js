/**
 * dsh-tidewatch 计费与峰谷数学（纯函数，宿主与移植共用）。
 *
 * 峰谷依据：DeepSeek 官方 2026-08-17 生效的峰谷分时定价。
 *   峰时段（UTC 小时，半开区间）：01:00–04:00、06:00–10:00
 *   （即北京时间 09:00–12:00、14:00–18:00）；
 *   其余时间为空闲（谷）时段，谷时价 = 峰时价的一半。
 *
 * 模型定价：DeepSeek V4.1 Flash 于 2026-09-10 12:00（北京时间）上线，
 *   模型名由 deepseek-v4-flash 改为 deepseek-flash；旧名 deepseek-v4-flash、
 *   deepseek-v4-flash-vision-exp、deepseek-v4.1-flash 均可调用，均路由到
 *   V4.1 Flash 并按新价计费（见 MODEL_ALIASES）。deepseek-v4-pro 价格不变。
 *
 * 价格时代（三段，按调用发生时刻选档，保证历史正确性）：
 *   1. 2026-08-16 16:00 UTC 之前：旧基础价（legacyBase）；
 *   2. 2026-08-16 16:00 UTC ~ 2026-09-10 04:00 UTC：首版峰谷价
 *      （flash 峰值 cacheMiss 0.44 / output 1.32，见 priorPeak/priorOffPeak）；
 *   3. 2026-09-10 04:00 UTC 起：V4.1 Flash 新价（峰值 0.3 / 1.2）。
 *
 * 计费口径：美元 / 1M tokens（官方定价页口径），成本 =
 *   input × cacheMiss + output × output + (cacheRead + cacheWrite) × cacheHit
 *   (+ reasoning × reasoningPrice，当价格条目提供 reasoning 价时)。
 *
 * 本文件核心算法（isPeakHour / peakPhaseAt / tierFor / costOf / 价格表结构）
 * 借鉴自 dsh-cost-meter（MIT License, https://github.com/Han-1413141/dsh-cost-meter），
 * 按精简目标改写：无配置依赖，峰谷恒启用。
 */

/** 峰谷时代分界（2026-08-16 16:00 UTC）：此前的计费按当时的基础价执行（历史正确性）。 */
export const LEGACY_BASE_BOUNDARY = '2026-08-16T16:00:00Z'

/**
 * V4.1 Flash 换价分界（= 北京 2026-09-10 12:00，即 04:00 UTC）：
 * 分界之前的峰谷时代按首版峰谷价计费（priorPeak/priorOffPeak），
 * 之后的调用按 V4.1 Flash 新价计费。
 */
export const FLASH_REPRICE_BOUNDARY = '2026-09-10T04:00:00Z'

/** 峰时段窗口（UTC 小时，半开区间 [start, end)）。 */
export const DEFAULT_PEAK_WINDOWS = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
]

/**
 * 内置默认 DeepSeek 价格表（美元 / 1M tokens；与官方页面数字一致；基础档 = 空闲档）。
 * deepseek-flash 为 V4.1 Flash 新价（2026-09-10 12:00 北京时间起生效）；
 * deepseek-v4-pro 价格不变，2026-09-14 04:00 UTC（北京 12:00）起路由到
 * V4.1 Flash 按 Flash 价计费（见 V4_PRO_RETIRE_BOUNDARY）。
 */
export const DEFAULT_PRICE_TABLE = {
  models: {
    'deepseek-flash': {
      cacheHit: 0.003,
      cacheMiss: 0.15,
      output: 0.6,
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
      // 首版峰谷价（2026-08-16 16:00 UTC ~ 2026-09-10 04:00 UTC）。
      priorOffPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
      priorPeak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
      // 峰谷时代之前的基础价（2026-08-16 16:00 UTC 之前）。
      legacyBase: { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
    },
    'deepseek-v4-pro': {
      cacheHit: 0.022,
      cacheMiss: 0.66,
      output: 1.98,
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
      peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      legacyBase: { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
    },
  },
  default: {
    cacheHit: 0.003,
    cacheMiss: 0.15,
    output: 0.6,
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  },
}

/**
 * 模型别名：旧模型名 / 过渡期名称 → 现役真实模型 key。
 * V4.1 Flash（2026-09-10 上线）更名后，旧名 deepseek-v4-flash、
 * deepseek-v4-flash-vision-exp 与社区沿用的 deepseek-v4.1-flash 均可调用，
 * 路由到 V4.1 Flash 并按新价计费（显式登记，避免依赖 default 兜底）。
 */
export const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
}

/**
 * V4 Pro 退休分界（= 北京 2026-09-14 12:00，04:00 UTC）：
 * 此日起 deepseek-v4-pro 路由到 V4.1 Flash 按 Flash 价计费。
 */
export const V4_PRO_RETIRE_BOUNDARY = '2026-09-14T04:00:00Z'

/**
 * 模型名归一化匹配：忽略大小写/空格/横杠/点号与括号附注；
 * 旧模型名先经 MODEL_ALIASES 映射到现役真实 key，再查价格表。
 * @param model - 请求中的模型 id。
 * @param atMs - 计费时刻（epoch ms，可选）；deepseek-v4-pro 在退休分界
 *   （V4_PRO_RETIRE_BOUNDARY）之后路由到 Flash 价；不传时行为不变。
 * @returns 命中价格表条目；未命中返回 default。
 */
export function priceEntryFor(model, atMs) {
  const normalize = s => String(s ?? '').toLowerCase().replace(/[\s\-_.()（）]/g, '')
  let id = normalize(model)
  // 别名归一化：旧模型名（如 V4.1 Flash 更名前的 deepseek-v4-flash）
  // 映射到现役真实 key，确保旧名命中新价。
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    if (id === normalize(alias)) {
      id = normalize(target)
      break
    }
  }
  // V4 Pro 退休路由：2026-09-14 04:00 UTC 起 pro 按 Flash 价计费
  // （不传 atMs 时行为完全不变，pro 仍命中 pro 条目）。
  if (id === normalize('deepseek-v4-pro') && Number.isFinite(atMs) && atMs >= Date.parse(V4_PRO_RETIRE_BOUNDARY)) {
    id = 'deepseekflash'
  }
  if (id.length > 0 && Object.prototype.hasOwnProperty.call(DEFAULT_PRICE_TABLE.models, id)) {
    return DEFAULT_PRICE_TABLE.models[id]
  }
  // 兜底：请求名包含表内模型名也命中（如路由前缀 provider/…）。
  for (const [key, entry] of Object.entries(DEFAULT_PRICE_TABLE.models)) {
    if (id.includes(normalize(key))) return entry
  }
  return DEFAULT_PRICE_TABLE.default
}

/**
 * 某一时刻是否处于峰时段。官方 2026-08-23 起：周六/周日（UTC 自然日）
 * 全天按谷期计价，无峰谷切换；工作日按峰时段窗口判定。
 * @param atMs - 时刻（epoch ms）。
 * @param windows - 峰时段窗口数组（缺省用官方默认窗口）。
 * @returns 峰时段返回 true；周末或窗口外返回 false。
 */
export function isPeakHour(atMs, windows = DEFAULT_PEAK_WINDOWS) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  const d = new Date(atMs)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false // 周末全天谷期（官方 2026-08-23 起）
  const hour = d.getUTCHours()
  return windows.some(w => {
    const start = Number(w?.start)
    const end = Number(w?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    if (start < end) return hour >= start && hour < end
    // 跨午夜窗口（本配置不会出现，兼容处理）。
    return hour >= start || hour < end
  })
}

/**
 * 某一时刻所处的峰谷相位与相邻相位切换点（供倒计时/进度条展示）。
 * 窗口为半开区间 [start, end)（UTC 小时），兼容跨午夜窗口（end <= start）。
 * 周末（UTC 周六/周日）无切换点：此时下一时刻为下一个工作日首次进入峰时；
 * 为覆盖周六 → 周一的跨度，切换点收集范围扩展到 -1 ~ +3 天。
 * @param atMs - 时刻（epoch ms）。
 * @param windows - 峰时段窗口数组。
 * @returns { inPeak, prevAtMs, nextAtMs, nextIntoPeak }，或 null（无有效窗口/时刻）。
 *   prevAtMs = 当前相位起点，nextAtMs = 下一次切换时刻，
 *   nextIntoPeak = 该次切换是否进入峰时段。
 */
export function peakPhaseAt(atMs, windows = DEFAULT_PEAK_WINDOWS) {
  if (!Array.isArray(windows) || windows.length === 0 || !Number.isFinite(atMs)) return null
  const hourAt = (dayOffset, hour) => {
    const date = new Date(atMs)
    date.setUTCDate(date.getUTCDate() + dayOffset)
    date.setUTCHours(hour, 0, 0, 0)
    return date.getTime()
  }
  // 收集前两天到后三天的全部切换点，保证任意时刻都能取到前后相邻切换点
  // （周末无窗口点：周六/周日的 prev 落在周五，next 落在下周一）。
  const points = []
  for (let day = -2; day <= 3; day += 1) {
    const d = new Date(hourAt(day, 0))
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue // 周末无峰谷切换
    for (const w of windows) {
      const start = Number(w?.start)
      const end = Number(w?.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      points.push({ at: hourAt(day, start), intoPeak: true })
      // 跨午夜窗口的结束点落在次日。
      points.push({ at: hourAt(end <= start ? day + 1 : day, end), intoPeak: false })
    }
  }
  const inPeak = isPeakHour(atMs, windows)
  let prev = null
  let next = null
  for (const p of points) {
    if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p
    if (p.at > atMs && (next === null || p.at < next.at)) next = p
  }
  if (prev === null || next === null) return null
  return { inPeak, prevAtMs: prev.at, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
}

/**
 * 为一次用量挑选价格档位，按调用时刻在三段价格时代中选档：
 *   峰谷时代前（2026-08-16 16:00 UTC 之前）→ legacyBase；
 *   首版峰谷时代（至 2026-09-10 04:00 UTC）→ priorPeak / priorOffPeak（条目提供时）；
 *   现行峰谷时代 → peak / offPeak。
 * @param entry - 模型价格记录。
 * @param atMs - 计费时刻。
 * @returns 三档价格 { cacheHit, cacheMiss, output, reasoning? }。
 */
export function tierFor(entry, atMs) {
  const base = entry ?? { cacheHit: 0, cacheMiss: 0, output: 0 }
  const asTier = price => price?.reasoning === undefined
    ? { cacheHit: price?.cacheHit ?? 0, cacheMiss: price?.cacheMiss ?? 0, output: price?.output ?? 0 }
    : { cacheHit: price.cacheHit, cacheMiss: price.cacheMiss, output: price.output, reasoning: price.reasoning }
  // 峰谷时代之前：按当时的基础价计费（历史正确性）。
  if (Number.isFinite(atMs) && atMs < Date.parse(LEGACY_BASE_BOUNDARY)) {
    const lb = base.legacyBase
    return lb === undefined ? asTier(base) : asTier(lb)
  }
  const peak = isPeakHour(atMs)
  // 换价分界之前：按首版峰谷价计费。仅条目提供 prior 档时生效；
  // deepseek-v4-pro 在该窗口价格未变，无 prior 档，落到现行峰谷价。
  if (Number.isFinite(atMs) && atMs < Date.parse(FLASH_REPRICE_BOUNDARY)) {
    const prior = peak ? base.priorPeak : base.priorOffPeak
    if (prior !== undefined) return asTier(prior)
  }
  if (peak) {
    const p = base.peak
    return p === undefined ? asTier(base) : asTier(p)
  }
  const off = base.offPeak
  return off === undefined ? asTier(base) : asTier(off)
}

/**
 * 一次调用的美元成本。
 * @param tokens - { input, output, cacheRead, cacheWrite, reasoning? } 各桶 token 数。
 * @param entry - 模型价格记录。
 * @param atMs - 计费时刻。
 * @returns 美元成本（非负）。
 */
export function costOf(tokens, entry, atMs) {
  const tier = tierFor(entry, atMs)
  const input = Math.max(0, Number(tokens?.input) || 0)
  const output = Math.max(0, Number(tokens?.output) || 0)
  const cacheRead = Math.max(0, Number(tokens?.cacheRead) || 0)
  const cacheWrite = Math.max(0, Number(tokens?.cacheWrite) || 0)
  const reasoning = Math.max(0, Number(tokens?.reasoning) || 0)
  const reasoningPrice = typeof tier.reasoning === 'number' ? tier.reasoning : 0
  return (input * tier.cacheMiss
    + output * tier.output
    + (cacheRead + cacheWrite) * tier.cacheHit
    + reasoning * reasoningPrice) / 1e6
}
