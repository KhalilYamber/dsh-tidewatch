/**
 * dsh-tidewatch 计费与峰谷数学（纯函数，宿主与移植共用）。
 *
 * 峰谷依据：DeepSeek 官方 2026-08-17 生效的峰谷分时定价。
 *   峰时段（UTC 小时，半开区间）：01:00–04:00、06:00–10:00
 *   （即北京时间 09:00–12:00、14:00–18:00）；
 *   其余时间为空闲（谷）时段，谷时价 = 峰时价的一半。
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

/** 峰时段窗口（UTC 小时，半开区间 [start, end)）。 */
export const DEFAULT_PEAK_WINDOWS = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
]

/** 内置默认 DeepSeek 价格表（美元 / 1M tokens；与官方页面数字一致；基础档 = 空闲档）。 */
export const DEFAULT_PRICE_TABLE = {
  models: {
    'deepseek-v4-flash': {
      cacheHit: 0.007,
      cacheMiss: 0.22,
      output: 0.66,
      offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
      peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
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
    cacheHit: 0.007,
    cacheMiss: 0.22,
    output: 0.66,
    offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
    peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  },
}

/**
 * 模型名归一化匹配：忽略大小写/空格/横杠/点号与括号附注。
 * @param id - 请求中的模型 id。
 * @returns 命中价格表条目；未命中返回 default。
 */
export function priceEntryFor(model) {
  const normalize = s => String(s ?? '').toLowerCase().replace(/[\s\-_.()（）]/g, '')
  const id = normalize(model)
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
 * 某一时刻是否处于峰时段。
 * @param atMs - 时刻（epoch ms）。
 * @param windows - 峰时段窗口数组（缺省用官方默认窗口）。
 * @returns 峰时段返回 true；窗口外返回 false。
 */
export function isPeakHour(atMs, windows = DEFAULT_PEAK_WINDOWS) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  const hour = new Date(atMs).getUTCHours()
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
  // 收集前一天到后一天的全部切换点，保证任意时刻都能取到前后相邻切换点。
  const points = []
  for (let day = -1; day <= 1; day += 1) {
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
    if (p.at > atMs && (next === null || next.at < next.at)) next = p
  }
  if (prev === null || next === null) return null
  return { inPeak, prevAtMs: prev.at, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
}

/**
 * 为一次用量挑选价格档位：峰谷时代前（2026-08-16 16:00 UTC）→ 当时基础价；
 * 生效后峰时段 → peak；否则 → offPeak。
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
  if (isPeakHour(atMs)) {
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
