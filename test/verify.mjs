/**
 * dsh-tidewatch 纯模块自检（node test/verify.mjs）。
 *
 * 三段：
 *   ① 定价与峰谷数学（固定示例时刻，与真实时钟无关）；
 *   ② 双份常量一致性（lib/client.js 的展示常量必须与 lib/pricing.js 的
 *      计费常量一致，防官方调价/改窗口/改节假日表时只改一处造成的静默漂移）；
 *   ③ 计费口径回归（DSH 0.1.7-rc.2 适配）：直接折叠**真实投影**，断言
 *      「一次调用 = 恰好一笔费用」；并加载 lib/client.js，驱动会话切换序列，
 *      断言金额归属与存活校验。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isPeakHour, peakPhaseAt, costOf, priceEntryFor, isAllDayOffPeak,
  DEFAULT_PEAK_WINDOWS, DEFAULT_PRICE_TABLE, LEGACY_BASE_BOUNDARY, FLASH_REPRICE_BOUNDARY,
  V4_PRO_RETIRE_BOUNDARY, MODEL_ALIASES, CN_PUBLIC_HOLIDAYS, HOLIDAY_RULE_BOUNDARY,
} from '../lib/pricing.js'
import { makeCostUsageProjection } from '../lib/index.js'
import { runOwnershipChecks } from './client-fixture.mjs'

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

/**
 * 从 client.js 源码提取常量字面量并求值（常量均为纯对象字面量）。
 * 正则取 `const <name> = ...` 到下一个空行为止（常量内部不出现空行）。
 */
function extractClientConst(name) {
  const src = readFileSync(join(libDir, 'client.js'), 'utf8')
  const re = new RegExp('const ' + name + ' = ([\\s\\S]*?)\\r?\\n\\r?\\n')
  const m = re.exec(src)
  assert.ok(m !== null, `client.js 中未找到常量 ${name}`)
  // eslint-disable-next-line no-new-func
  return Function('return (' + m[1] + ')')()
}

let passed = 0
const ok = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name) }

console.log('[dsh-tidewatch] verify:')

// ── 双份常量一致性（防官方调价/改窗口时只改一处）──
ok('client PEAK_WINDOWS 与 pricing DEFAULT_PEAK_WINDOWS 一致', () => {
  assert.deepEqual(extractClientConst('PEAK_WINDOWS'), DEFAULT_PEAK_WINDOWS)
})
ok('client DISPLAY_PRICES 与 pricing DEFAULT_PRICE_TABLE 各档价格一致', () => {
  const display = extractClientConst('DISPLAY_PRICES')
  const billing = DEFAULT_PRICE_TABLE.models
  const keys = ['offPeak', 'peak']
  for (const [id, entry] of Object.entries(display)) {
    const model = Object.keys(billing).find(k => k.includes(id) || id.includes(k))
    assert.ok(model !== undefined, `client 价格表出现 pricing 没有的模型 ${id}`)
    for (const tier of keys) {
      assert.deepEqual(entry[tier], billing[model][tier], `模型 ${id} 的 ${tier} 档不一致`)
    }
  }
  assert.deepEqual(Object.keys(display).sort(), Object.keys(billing).sort(), '模型集合不一致')
})
ok('client MODEL_ALIASES 与 pricing MODEL_ALIASES 一致', () => {
  assert.deepEqual(extractClientConst('MODEL_ALIASES'), MODEL_ALIASES)
})
ok('client CN_PUBLIC_HOLIDAYS 与 pricing CN_PUBLIC_HOLIDAYS 一致', () => {
  assert.deepEqual([...extractClientConst('CN_PUBLIC_HOLIDAYS')].sort(), [...CN_PUBLIC_HOLIDAYS].sort())
})
ok('client HOLIDAY_RULE_BOUNDARY_AT 与 pricing HOLIDAY_RULE_BOUNDARY 一致', () => {
  assert.equal(extractClientConst('HOLIDAY_RULE_BOUNDARY_AT'), Date.parse(HOLIDAY_RULE_BOUNDARY))
})

// ── isPeakHour（UTC 峰时段 01:00-04:00 / 06:00-10:00）──
ok('UTC 07:00 在峰时段（06:00-10:00）', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T07:00:00Z')), true)
})
ok('UTC 05:00 在空闲时段', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T05:00:00Z')), false)
})
ok('UTC 12:00 在空闲时段', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T12:00:00Z')), false)
})
ok('UTC 01:30 在峰时段（01:00-04:00）', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T01:30:00Z')), true)
})
ok('UTC 03:59 在峰时段（半开区间端点）', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T03:59:59Z')), true)
})
ok('UTC 04:00 不在峰时段（半开区间端点）', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T04:00:00Z')), false)
})

// ── 周末规则（官方 2026-08-23 起：周六/周日 UTC 全天谷期）──
ok('周六 07:00 UTC（工作日是峰时）→ 谷期', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-22T07:00:00Z')), false)
})
ok('周日 07:00 UTC（工作日是峰时）→ 谷期', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-23T07:00:00Z')), false)
})
ok('周六 01:30 UTC（工作日是峰时）→ 谷期', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-22T01:30:00Z')), false)
})
ok('周一 07:00 UTC → 峰时（回到工作日窗口）', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-24T07:00:00Z')), true)
})
ok('周六 14:00 UTC 相位：谷期，下一切换点 = 下周一 01:00 进入峰', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-22T14:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-24T01:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})
ok('周日整天相位：谷期，下一切换点 = 下周一 01:00 进入峰', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-23T08:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-24T01:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})

// ── 法定节假日规则（官方定价页 2026-09-19 核对；国办发明电〔2025〕7号）──
ok('国庆 2026-10-01（周四）峰窗时刻 → 谷期', () => {
  assert.equal(isPeakHour(Date.parse('2026-10-01T07:00:00Z')), false)
})
ok('中秋 2026-09-25（周五）峰窗时刻 → 谷期', () => {
  assert.equal(isPeakHour(Date.parse('2026-09-25T01:30:00Z')), false)
})
ok('规则分界前（2026-06-19 端午，周五）峰窗时刻仍按峰计（历史口径）', () => {
  assert.equal(isPeakHour(Date.parse('2026-06-19T07:00:00Z')), true)
})
ok('规则分界前（2026-02-17 春节，周二）峰窗时刻仍按峰计（历史口径）', () => {
  assert.equal(isPeakHour(Date.parse('2026-02-17T07:00:00Z')), true)
})
ok('调休上班日 2026-10-10（周六）仍为谷期（官方周末口径）', () => {
  assert.equal(isPeakHour(Date.parse('2026-10-10T07:00:00Z')), false)
})
ok('北京日映射：UTC 2026-09-30 20:00 = 北京 10-01 05:00，全天谷期', () => {
  assert.equal(isAllDayOffPeak(Date.parse('2026-09-30T20:00:00Z')), true)
})
ok('isAllDayOffPeak：节假日为真、普通工作日为假', () => {
  assert.equal(isAllDayOffPeak(Date.parse('2026-10-01T07:00:00Z')), true)
  assert.equal(isAllDayOffPeak(Date.parse('2026-10-08T07:00:00Z')), false)
})
ok('国庆首日相位：谷期，下一切换点 = 10-08（周四）01:00 进入峰（跨 7 天连休）', () => {
  const ph = peakPhaseAt(Date.parse('2026-10-01T12:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-10-08T01:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})
ok('中秋假期末相位（周日兼节假日）：谷期，下一切换点 = 9-28（周一）01:00 进入峰', () => {
  const ph = peakPhaseAt(Date.parse('2026-09-27T20:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-09-28T01:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})
ok('节假日表天数 = 33（2026 年官方放假总天数）', () => {
  assert.equal(CN_PUBLIC_HOLIDAYS.size, 33)
})
ok('节假日峰窗时刻计费按谷价（国庆 10-01 → 0.75 USD）', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, priceEntryFor('deepseek-flash'), Date.parse('2026-10-01T07:00:00Z'))
  assert.ok(Math.abs(c - 0.75) < 1e-9)
})

// ── peakPhaseAt（当前相位 + 下一切换点）──
ok('07:00 UTC 相位与下一切换点（10:00 进入谷）', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-19T07:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, true)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-19T10:00:00Z'))
  assert.equal(ph.nextIntoPeak, false)
})
ok('05:00 UTC 相位与下一切换点（06:00 进入峰）', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-19T05:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-19T06:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})
ok('12:00 UTC 相位与下一切换点（次日 01:00 进入峰）', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-19T12:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-20T01:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})

// ── priceEntryFor（模型匹配）──
ok('deepseek-v4-flash 命中 flash 条目', () => {
  assert.equal(priceEntryFor('deepseek-v4-flash').offPeak.output, 0.6)
})
ok('deepseek-v4-flash-vision-exp 经别名命中 flash 条目', () => {
  assert.equal(priceEntryFor('deepseek-v4-flash-vision-exp').offPeak.output, 0.6)
})
ok('deepseek-v4.1-flash 经别名命中 flash 条目', () => {
  assert.equal(priceEntryFor('deepseek-v4.1-flash').offPeak.output, 0.6)
})
ok('deepseek-flash 直接命中 flash 条目', () => {
  assert.equal(priceEntryFor('deepseek-flash').offPeak.output, 0.6)
})
ok('deepseek-v4-pro 命中 pro 条目', () => {
  assert.equal(priceEntryFor('deepseek-v4-pro').offPeak.output, 1.98)
})
ok('官方声明前（2026-09-10）pro 按 pro 价', () => {
  assert.equal(priceEntryFor('deepseek-v4-pro', Date.parse('2026-09-10T00:00:00Z')).offPeak.output, 1.98)
})
ok('官方声明生效日（2026-09-14 04:00 UTC）pro 仍按 pro 价（计费方式不变）', () => {
  assert.equal(priceEntryFor('deepseek-v4-pro', Date.parse('2026-09-14T04:00:00Z')).offPeak.output, 1.98)
})
ok('远期（2027-01-01）pro 仍按 pro 价（待官方另行通知）', () => {
  assert.equal(priceEntryFor('deepseek-v4-pro', Date.parse('2027-01-01T00:00:00Z')).offPeak.output, 1.98)
})
ok('V4_PRO_RETIRE_BOUNDARY 为哨兵值（官方未给出换价日期）', () => {
  assert.equal(Date.parse(V4_PRO_RETIRE_BOUNDARY), Date.UTC(9999, 11, 31))
})
ok('未知模型回退 default（= flash 价）', () => {
  assert.equal(priceEntryFor('gpt-999').offPeak.output, 0.6)
})

// ── costOf（美元 / 1M tokens 口径）──
const flash = priceEntryFor('deepseek-flash')
const pro = priceEntryFor('deepseek-v4-pro')

// 现行价（2026-09-10 04:00 UTC 起）：峰 0.3/1.2，谷 0.15/0.6，缓存命中 0.003
ok('现行价峰期 1M 输入未命中 + 1M 输出 = 0.3 + 1.2 = 1.5 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-11T07:00:00Z'))
  assert.ok(Math.abs(c - 1.5) < 1e-9)
})
ok('现行价谷期 1M 输入未命中 + 1M 输出 = 0.15 + 0.6 = 0.75 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-11T05:00:00Z'))
  assert.ok(Math.abs(c - 0.75) < 1e-9)
})
ok('缓存读写按命中价计费（现行价 0.003）', () => {
  const c = costOf({ input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 }, flash, Date.parse('2026-09-11T05:00:00Z'))
  assert.ok(Math.abs(c - 0.003) < 1e-9)
})

// ── 首版峰谷价（2026-08-16 16:00 UTC ~ 2026-09-10 04:00 UTC，历史正确性）──
ok('首版峰期 1M 输入未命中 + 1M 输出 = 0.44 + 1.32 = 1.76 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-19T07:00:00Z'))
  assert.ok(Math.abs(c - 1.76) < 1e-9)
})
ok('首版谷期 1M 输入未命中 + 1M 输出 = 0.22 + 0.66 = 0.88 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-19T05:00:00Z'))
  assert.ok(Math.abs(c - 0.88) < 1e-9)
})
ok('换价前一刻（2026-09-10 03:59:59 UTC，峰期）仍按首版峰价 1.76', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-10T03:59:59Z'))
  assert.ok(Math.abs(c - 1.76) < 1e-9)
})
ok('换价时刻（2026-09-10 04:00:00 UTC，谷期）起按新谷价 0.75', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-10T04:00:00Z'))
  assert.ok(Math.abs(c - 0.75) < 1e-9)
})
ok('换价分界常量 = 北京 2026-09-10 12:00', () => {
  assert.equal(Date.parse(FLASH_REPRICE_BOUNDARY), Date.parse('2026-09-10T04:00:00Z'))
})
ok('pro 在首版峰谷窗口无 prior 档，仍按 pro 现行价（峰期 1.32 + 3.96 = 5.28）', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, pro, Date.parse('2026-08-19T07:00:00Z'))
  assert.ok(Math.abs(c - 5.28) < 1e-9)
})

ok('峰谷时代前（2026-08-10）按 legacyBase 计费', () => {
  assert.ok(Date.parse('2026-08-10T00:00:00Z') < Date.parse(LEGACY_BASE_BOUNDARY))
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-10T00:00:00Z'))
  assert.ok(Math.abs(c - 0.14) < 1e-9)
})
ok('非负保护：负 token 按 0 计', () => {
  const c = costOf({ input: -5, output: -1, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-11T05:00:00Z'))
  assert.equal(c, 0)
})

// ── 计费口径回归（折叠真实投影；DSH 0.1.7-rc.2 适配）──────────────────────
//
// 现行 DSH 只在一个事件上携带 usage：assistant/message。（assistant/chunk
// 自会话格式 v3 起被折叠，agent loop 只 append assistant/attempt，而其
// payload 里没有 usage 字段。）这里断言「一次调用 = 恰好一笔费用」：
// 已死的流式事件不进账、同一 (turn, step) 不翻倍、失败尝试不进账。

const projection = makeCostUsageProjection()
/** 计费时刻：UTC 2026-09-14 07:00 —— 周一、峰时段（06:00–10:00）、现行价时代。 */
const AT = Date.parse('2026-09-14T07:00:00Z')
const CALL_USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 2_000_000,
  cacheWriteTokens: 0,
  reasoningTokens: 50_000,
  totalTokens: 3_150_000,
}
/**
 * 峰时现行价（2026-09-10 04:00 UTC 起的 deepseek-flash 峰档）：
 *   输入未命中 1M × 0.3 + 输出 0.1M × 0.6 + 缓存读 2M × 0.006 = 0.3 + 0.06 + 0.012 = 0.432 USD。
 * 时刻选在 UTC 07:00（周一、峰时段窗口 06:00–10:00 内），故按峰档计。
 */
const CALL_COST = 0.432

/** 把事件序列折进投影，返回其线上视图（wire view）。 */
function projectCost(events) {
  let state = projection.init({}, 0)
  for (const event of events) state = projection.apply(state, event)
  return projection.wire.view(state)
}
const requestHeader = {
  type: 'request/header',
  time: AT,
  data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
}
const messageEvent = {
  type: 'assistant/message',
  time: AT,
  data: { turn: 1, step: 1, message: { id: 'm1' }, usage: CALL_USAGE },
}
/** 已退出历史舞台的事件：会话格式 v2 的流式 usage 块。 */
const legacyChunkEvent = {
  type: 'assistant/chunk',
  time: AT,
  data: { turn: 1, step: 1, chunk: { type: 'usage', usage: CALL_USAGE } },
}
/** 现行 loop 的流式事件：payload 里没有 usage（失败/被重试的尝试走这里）。 */
const attemptEvent = {
  type: 'assistant/attempt',
  time: AT,
  data: { turn: 1, step: 1, stream: [{ index: 0, time: AT, chunk: { type: 'usage', usage: CALL_USAGE } }] },
}

ok('计费口径：assistant/message 的一次调用计费 = 0.432 USD，token 桶 310 万', () => {
  const view = projectCost([requestHeader, messageEvent])
  assert.ok(Math.abs(view.cost - CALL_COST) < 1e-9, `实得 ${view.cost}`)
  assert.equal(view.input + view.output + view.cacheRead, 3_100_000)
})
ok('计费口径：已死的 assistant/chunk 不再进账（0 USD）', () => {
  const view = projectCost([requestHeader, legacyChunkEvent])
  assert.equal(view.cost, 0)
  assert.equal(view.input + view.output + view.cacheRead, 0)
})
ok('计费口径：同一 (turn, step) 的流式 + 结算不翻倍（仍 0.432 USD）', () => {
  const view = projectCost([requestHeader, legacyChunkEvent, messageEvent])
  assert.ok(Math.abs(view.cost - CALL_COST) < 1e-9, `实得 ${view.cost}`)
})
ok('计费口径：现行的 assistant/attempt 不计费（与官方 token-meter 同口径）', () => {
  const view = projectCost([requestHeader, attemptEvent])
  assert.equal(view.cost, 0)
})
ok('计费口径：assistant/message 缺 usage 时不进账', () => {
  const view = projectCost([requestHeader, { ...messageEvent, data: { turn: 1, step: 1, message: { id: 'm2' } } }])
  assert.equal(view.cost, 0)
})

// ── 归属判据回归（加载真实 lib/client.js，驱动会话切换序列）──────────────
const ownership = runOwnershipChecks()
for (const [status, name] of ownership.results) {
  if (status === 'PASS') passed += 1
  console.log('  ' + (status === 'PASS' ? '✓' : '✗') + ' ' + name)
}
const ownershipFailures = ownership.results.filter(([status]) => status !== 'PASS')

console.log(`[dsh-tidewatch] verify: ${passed} passed${ownershipFailures.length > 0 ? `，${ownershipFailures.length} failed` : ''}`)
if (ownershipFailures.length > 0) process.exitCode = 1
