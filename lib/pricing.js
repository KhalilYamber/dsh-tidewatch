/**
 * dsh-tidewatch 计费与峰谷数学（纯函数，宿主与移植共用）。
 *
 * 峰谷依据：DeepSeek 官方 2026-08-17 生效的峰谷分时定价（官方公告原文
 * 「闲时价格为高峰时段价格的一半」，见 news260813）。现行为官网 2026-10-10
 * 核对口径（中文页与英文页表述等价，仅计价单位与时区书写不同）：
 *   峰时段（UTC 小时，半开区间）：01:00–04:00、06:00–10:00
 *   （即北京时间 09:00–12:00、14:00–18:00），仅周一至周五；
 *   其余时间为空闲（谷）时段，谷时价 = 峰时价的一半。
 *   官网中文页把周几锚在「北京时间周一至周五」自然日上；英文页把窗口按 UTC
 *   小时书写（Monday through Friday 对应窗口所在的那一日）。两读法在本文件
 *   的窗口取值下等价：两个窗口各 3 小时、4 小时，均落在同一个北京自然日内
 *   （01:00 UTC = 北京 09:00，10:00 UTC = 北京 18:00，不跨日界），且不成对
 *   跨越 UTC 日界（01–04 与 06–10 之间的 04:00–06:00 是谷段，不构成跨日连线）。
 *   故判定周几时以北京自然日为准（见 isAllDayOffPeak 与 BEIJING_OFFSET_MS）。
 *   中国法定节假日全天按空闲时段计费，**无生效时间、不设分界**（官网说明：
 *   「调休上班的周末、中国法定节假日全天均按空闲时段计费」）。
 *   周末（2026-08-23 00:00 北京起）与中国法定节假日、以及调休上班的周末
 *   （官网 2026-09-19 说明：调休上班的周末与中国法定节假日全天均按空闲时段
 *   计费）全天按谷期计价，见 isAllDayOffPeak。
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
 * 计费口径：美元 / 1M tokens（官方英文定价页口径，本文件的唯一计费基准），成本 =
 *   input × cacheMiss + output × output + (cacheRead + cacheWrite) × cacheHit
 *   (+ reasoning × reasoningPrice，当价格条目提供 reasoning 价时)。
 *   官方中文定价页以人民币标价（flash 每档为美元数字的 6.67 倍，pro 为 6.82 倍，
 *   隐含汇率按模型各自取整，并不统一）。故条目另存 rmb 一份官方人民币数字，供
 *   界面原样展示；计费数学仍走美元精确值，不做跨币种来回换算。
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
 * 北京时区偏移（UTC+8，无夏令时）。周几与自然日均按北京时间判定——官网中文页
 * 的口径锚在「北京时间周一至周五」；英文页按 UTC 小时书写的读法在本窗口取值下
 * 与之等价（见文件头说明）。调休上班的周末照旧按周末处理。
 */
export const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/**
 * 中国法定节假日表（北京时间自然日，含调休连休日；不含调休上班的周末——
 * 官方口径下周末全天空闲，与是否调休上班无关）。
 * 依据：《国务院办公厅关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7号）：
 *   元旦 1/1~1/3；春节 2/15~2/23；清明 4/4~4/6；劳动节 5/1~5/5；
 *   端午 6/19~6/21；中秋 9/25~9/27；国庆 10/1~10/7（共 33 天）。
 * 2027 年安排官方发布后需手动同步本表（与 lib/client.js 的同名常量两处）。
 */
export const CN_PUBLIC_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])

/** 北京时间自然日（YYYY-MM-DD；北京 = UTC+8，无夏令时）。 */
export function beijingDateString(atMs) {
  if (!Number.isFinite(atMs)) return ''
  return new Date(atMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 某一时刻所在日是否全天谷期。周几按**北京自然日**判定（官网中文页口径：
 * 「北京时间周一至周五」为工作日；英文页按 UTC 小时书写的读法在本窗口取值
 * 下与之等价，见文件头说明），周六与周日全天不区分峰谷；中国法定节假日
 * （北京时间自然日）全天空闲，不设生效时间。
 *
 * 调休上班的周末仍按周末处理（官方 2026-09-19 说明：调休上班的周末、中国
 * 法定节假日全天均按空闲时段计费），故本表不含调休上班日——周末口径与是否
 * 调休上班无关。
 * @param atMs - 时刻（epoch ms）。
 * @returns 全天谷期返回 true。
 */
export function isAllDayOffPeak(atMs) {
  if (!Number.isFinite(atMs)) return false
  const day = new Date(atMs + BEIJING_OFFSET_MS).getUTCDay()
  if (day === 0 || day === 6) return true
  return CN_PUBLIC_HOLIDAYS.has(beijingDateString(atMs))
}

/**
 * 内置默认 DeepSeek 价格表（美元 / 1M tokens；基础档 = 空闲档）。
 *   美元数字与官方英文定价页逐项一致（2026-10-10 核对）；
 *   rmb 为官方中文定价页的人民币数字，原样存放供界面展示——两个模型的隐含
 *   汇率并不相同（flash 6.67、pro 6.82），故不做汇率换算，避免界面数字与
 *   官网不一致。计费数学只走美元精确值。
 * deepseek-flash 为 V4.1 Flash 新价（2026-09-10 12:00 北京时间起生效）；
 * deepseek-v4-pro 价格不变：官方定价页脚注(2)与更新日志（2026-09-10）均声明
 * 2026-09-14 之后继续提供 V4 Pro API 服务、计费方式保持不变，如有变动另行
 * 通知（见 V4_PRO_RETIRE_BOUNDARY，现为哨兵值）。
 */
export const DEFAULT_PRICE_TABLE = {
  models: {
    'deepseek-flash': {
      cacheHit: 0.003,
      cacheMiss: 0.15,
      output: 0.6,
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
      // 官方中文定价页数字（元 / 1M tokens）：谷 0.02 / 1 / 4，峰 0.04 / 2 / 8。
      rmb: {
        offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      },
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
      // 官方中文定价页数字（元 / 1M tokens）：谷 0.15 / 4.5 / 13.5，峰 0.30 / 9 / 27。
      rmb: {
        offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
        peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
      },
      legacyBase: { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
    },
  },
  // 兜底条目 = flash 现行价（含人民币数字，未知模型外观与 flash 一致）。
  default: {
    cacheHit: 0.003,
    cacheMiss: 0.15,
    output: 0.6,
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    rmb: {
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    },
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
 * V4 Pro 换价分界（哨兵值 = 未有生效日期）。
 *
 * 官方依据（2026-09-13 核对三处官方页面，口径一致）：
 *   - 英文定价页脚注(2)：决定在 2026-09-14 之后继续提供 V4 Pro API 服务，
 *     billing method remaining unchanged；
 *   - 中文定价页脚注(2)：「计费方式保持不变；如有变动，我们将另行通知」；
 *   - 更新日志 2026-09-10 条目：同一段声明完整重复。
 * 旧口径「2026-09-14 起按 V4.1-Flash 费率计费」仅见于新闻发布页 news260910
 * 正文，已被上述三处追认修正，故不作为计费依据。
 *
 * 因此本分界保持哨兵值：在官方给出新日期之前，pro 恒按 pro 自身价目
 * （offPeak / peak）计费。将来官方通知换价时，把此常量改为生效时刻即可
 * 恢复路由，priceEntryFor 的分支无需改动。
 */
export const V4_PRO_RETIRE_BOUNDARY = '9999-12-31T00:00:00Z'

/**
 * 模型名归一化匹配：忽略大小写/空格/横杠/点号与括号附注；
 * 旧模型名先经 MODEL_ALIASES 映射到现役真实 key，再查价格表。
 * @param model - 请求中的模型 id。
 * @param atMs - 计费时刻（epoch ms，可选）；deepseek-v4-pro 在换价分界
 *   （V4_PRO_RETIRE_BOUNDARY，现为哨兵值）生效后才路由到 Flash 价。
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
  // V4 Pro 换价路由：仅在 V4_PRO_RETIRE_BOUNDARY 生效后按 Flash 价计费。
  // 该常量现为哨兵值（官方声明计费方式不变），故当前恒不触发，pro 走自身价目。
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
 * 模型名是否落在内置 DeepSeek 价目表里（含别名映射与路由前缀兜底）。
 *
 * 用途：把「DeepSeek 家族的模型」与「其他提供商的模型」分开。后者不遵循
 * DeepSeek 的峰谷分时定价，按 flash 价硬算会得出与账单无关的数字，所以
 * 调用方在计价前先用本判据筛一次。
 *
 * 归一化与 priceEntryFor 保持一致；两处判据是否对齐由 test/verify.mjs 的
 * 「已收录模型判定」段落兜住，任一处漂移都会打红。
 * @param model - 请求中的模型 id。
 * @returns 命中内置价目（不含 default 兜底）时为 true。
 */
export function isPricedModel(model) {
  const normalize = s => String(s ?? '').toLowerCase().replace(/[\s\-_.()（）]/g, '')
  let id = normalize(model)
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    if (id === normalize(alias)) {
      id = normalize(target)
      break
    }
  }
  if (id.length === 0) return false
  if (Object.prototype.hasOwnProperty.call(DEFAULT_PRICE_TABLE.models, id)) return true
  for (const key of Object.keys(DEFAULT_PRICE_TABLE.models)) {
    if (id.includes(normalize(key))) return true
  }
  return false
}

/**
 * 某一时刻是否处于峰时段。窗口位置按 UTC 小时判定（官方英文页即按 UTC 小时
 * 书写），周几与节假日按北京自然日判定——在本窗口取值下两者等价（见文件头
 * 说明）。周末、中国法定节假日与调休上班的周末全天按谷期计价，无峰谷切换，
 * 且不设生效时间（官网表述为无条件口径）。
 * @param atMs - 时刻（epoch ms）。
 * @param windows - 峰时段窗口数组（缺省用官方默认窗口）。
 * @returns 峰时段返回 true；周末/节假日或窗口外返回 false。
 */
export function isPeakHour(atMs, windows = DEFAULT_PEAK_WINDOWS) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  if (isAllDayOffPeak(atMs)) return false // 周末/法定节假日全天谷期
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
 * 全天谷期的日子（周末或法定节假日）无切换点：此时下一时刻为下一个
 * 工作日首次进入峰时。全天谷期连续段最长约 10 天（春节 9 天连休 + 衔接
 * 周末），故切换点收集范围扩展到前后各 14 天，保证任意时刻都能取到
 * 前后相邻切换点。
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
  // 收集前后各 14 天的切换点；全天谷期的日子（周末/法定节假日）不产生
  // 窗口点（其 prev/next 落在相邻工作日），跨午夜窗口的结束点落在次日。
  const points = []
  for (let day = -14; day <= 14; day += 1) {
    for (const w of windows) {
      const start = Number(w?.start)
      const end = Number(w?.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      const startAt = hourAt(day, start)
      const endAt = hourAt(end <= start ? day + 1 : day, end)
      if (!isAllDayOffPeak(startAt)) points.push({ at: startAt, intoPeak: true })
      if (!isAllDayOffPeak(endAt)) points.push({ at: endAt, intoPeak: false })
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
