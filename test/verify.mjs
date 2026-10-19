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
  isPeakHour, peakPhaseAt, costOf, priceEntryFor, isPricedModel, isAllDayOffPeak,
  DEFAULT_PEAK_WINDOWS, DEFAULT_PRICE_TABLE, LEGACY_BASE_BOUNDARY, FLASH_REPRICE_BOUNDARY,
  V4_PRO_RETIRE_BOUNDARY, MODEL_ALIASES, CN_PUBLIC_HOLIDAYS, BEIJING_OFFSET_MS,
} from '../lib/pricing.js'
import { makeCostUsageProjection } from '../lib/index.js'
import { costTextOf, loadClientPlugin, runOwnershipChecks } from './client-fixture.mjs'
import { __testables } from '../lib/index.js'

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
ok('client BEIJING_OFFSET_MS 与 pricing BEIJING_OFFSET_MS 一致', () => {
  assert.equal(extractClientConst('BEIJING_OFFSET_MS'), BEIJING_OFFSET_MS)
})
ok('北京偏移 = UTC+8（无夏令时）', () => {
  assert.equal(BEIJING_OFFSET_MS, 8 * 3600 * 1000)
})
ok('client DISPLAY_PRICES 的 rmb 与 pricing 条目的 rmb 一致（官方中文页数字）', () => {
  const display = extractClientConst('DISPLAY_PRICES')
  const billing = DEFAULT_PRICE_TABLE.models
  for (const [id, entry] of Object.entries(display)) {
    const model = Object.keys(billing).find(k => k.includes(id) || id.includes(k))
    assert.ok(model !== undefined, `client 价格表出现 pricing 没有的模型 ${id}`)
    assert.deepEqual(entry.rmb, billing[model].rmb, `模型 ${id} 的人民币数字不一致`)
  }
})
ok('人民币数字与官方中文页一致（flash 谷 0.02/1/4、峰 0.04/2/8）', () => {
  const rmb = DEFAULT_PRICE_TABLE.models['deepseek-flash'].rmb
  assert.deepEqual(rmb.offPeak, { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  assert.deepEqual(rmb.peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 })
})
ok('人民币数字与官方中文页一致（pro 谷 0.15/4.5/13.5、峰 0.3/9/27）', () => {
  const rmb = DEFAULT_PRICE_TABLE.models['deepseek-v4-pro'].rmb
  assert.deepEqual(rmb.offPeak, { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 })
  assert.deepEqual(rmb.peak, { cacheHit: 0.3, cacheMiss: 9, output: 27 })
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

// ── 周末规则（官方 2026-08-23 00:00 北京起：周六/周日全天谷期；周几按北京自然日）──
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
ok('无生效分界：2026-06-19（端午，周五）峰窗时刻按谷计——节假日口径无条件适用', () => {
  assert.equal(isPeakHour(Date.parse('2026-06-19T07:00:00Z')), false)
})
ok('无生效分界：2026-02-17（春节，周二）峰窗时刻按谷计——节假日口径无条件适用', () => {
  assert.equal(isPeakHour(Date.parse('2026-02-17T07:00:00Z')), false)
})
ok('无生效分界：2026-01-01（元旦，周四）峰窗时刻按谷计', () => {
  assert.equal(isPeakHour(Date.parse('2026-01-01T07:00:00Z')), false)
})
ok('节假日全天空闲：2026-05-01（劳动节，周五）任意钟点均为谷', () => {
  for (let h = 0; h < 24; h += 1) {
    const at = Date.parse('2026-05-01T' + String(h).padStart(2, '0') + ':00:00Z')
    assert.equal(isPeakHour(at), false, 'UTC ' + h + ':00 应为谷')
  }
})
ok('调休上班日 2026-10-10（周六）仍为谷期（官方周末口径）', () => {
  assert.equal(isPeakHour(Date.parse('2026-10-10T07:00:00Z')), false)
})
ok('调休上班日 2026-09-20（周日）整点全段仍为谷期（官方周末口径）', () => {
  for (let h = 0; h < 24; h += 1) {
    assert.equal(isPeakHour(Date.parse('2026-09-20T' + String(h).padStart(2, '0') + ':00:00Z')), false, 'UTC ' + h + ':00 应为谷期')
  }
})
// 周几按北京自然日：日界两侧各取一刻，验证判定归属的是北京那一天。
// 北京周一 09:00 = 北京周一的峰时首刻；北京周日 23:00 与次日北京周一 00:30
// 均为谷期（前者是周末、后者未进窗口），两者都不依赖 UTC 星期。
ok('北京周一 09:00（UTC 周一 01:00）进入峰时', () => {
  assert.equal(isPeakHour(Date.parse('2026-10-12T01:00:00Z')), true)
})
ok('北京周一 08:59（UTC 周一 00:59）仍为谷期（窗口外）', () => {
  assert.equal(isPeakHour(Date.parse('2026-10-12T00:59:00Z')), false)
})
ok('北京周日 09:00（UTC 周日 01:00）为谷期（周末，尽管落在窗口内）', () => {
  assert.equal(isPeakHour(Date.parse('2026-10-11T01:00:00Z')), false)
})
ok('北京周六 14:00（UTC 周六 06:00）为谷期（周末，尽管落在窗口内）', () => {
  assert.equal(isPeakHour(Date.parse('2026-10-10T06:00:00Z')), false)
})
ok('北京周五 18:00（UTC 周五 10:00）退出峰时（半开区间端点）', () => {
  assert.equal(isPeakHour(Date.parse('2026-10-09T10:00:00Z')), false)
})
ok('北京周二 14:00（UTC 周二 06:00）为峰时（工作日下午窗口）', () => {
  assert.equal(isPeakHour(Date.parse('2026-10-13T06:00:00Z')), true)
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

// ── 非 DeepSeek 模型：不按 flash 价兜底（投影 v6 口径）────────────────────
//
// 官方峰谷分时定价只适用于 DeepSeek 自家模型。其他提供商（Claude / GPT / Kimi…）
// 若按 flash 价兜底，会得出一个与真实账单无关的数字，比不显示更容易误导。故：
// 宿主侧不计价（cost 记 0），视图暴露 provider 供前端显示「不适用」。

ok('已收录模型判定：DeepSeek 家族（含别名）为 true', () => {
  for (const m of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro']) {
    assert.equal(isPricedModel(m), true, `${m} 应命中价目`)
  }
})
ok('已收录模型判定：其他提供商的模型与空值为 false', () => {
  for (const m of ['claude-sonnet-4-5', 'gpt-5-codex', 'kimi-k2', 'glm-4.6', '', null, undefined]) {
    assert.equal(isPricedModel(m), false, `${m} 不该命中价目`)
  }
})
ok('已收录模型判定与 priceEntryFor 的兜底口径对齐', () => {
  const fallback = DEFAULT_PRICE_TABLE.default
  const samples = [
    'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash',
    'claude-sonnet-4', 'gpt-5', 'kimi-k2', 'some-relay/deepseek-flash',
  ]
  for (const m of samples) {
    assert.equal(isPricedModel(m), priceEntryFor(m, AT) !== fallback, `${m} 两处判据不一致`)
  }
})
ok('投影：非 DeepSeek provider 的调用不计费（token 仍照实累计）', () => {
  const view = projectCost([
    { ...requestHeader, data: { header: { config: { provider: 'anthropic', model: 'claude-sonnet-4-5' } } } },
    messageEvent,
  ])
  assert.equal(view.cost, 0)
  assert.equal(view.input + view.output + view.cacheRead, 3_100_000)
})
ok('投影：view 暴露 provider 与 model（前端据此判定是否适用）', () => {
  const view = projectCost([requestHeader, messageEvent])
  assert.equal(view.provider, 'deepseek-official')
  assert.equal(view.model, 'deepseek-flash')
})
ok('投影：中转 provider 但模型名可识别时照常计费', () => {
  const view = projectCost([
    { ...requestHeader, data: { header: { config: { provider: 'my-relay', model: 'deepseek-flash' } } } },
    messageEvent,
  ])
  assert.ok(Math.abs(view.cost - CALL_COST) < 1e-9, `实得 ${view.cost}`)
})

ok('客户端上报的版本号与 package.json 一致', () => {
  // clientVersion() 是浏览器 bundle 里唯一的版本字面量（无法在运行时读 package.json），
  // 发版时容易漏改。这条断言把它钉在 package.json 的 version 上。
  const src = readFileSync(join(libDir, 'client.js'), 'utf8')
  const m = /function clientVersion\(\)[\s\S]{0,400}?return '([0-9]+\.[0-9]+\.[0-9]+)'/.exec(src)
  assert.ok(m !== null, 'client.js 未找到 clientVersion 的版本字面量')
  const pkg = JSON.parse(readFileSync(join(libDir, '..', 'package.json'), 'utf8'))
  assert.equal(m[1], pkg.version, `clientVersion=${m[1]}，package.json=${pkg.version}`)
})

// ── 用量读取：账号内置通道（provider deepseek-account）下 data.usage 可能为空，需回退到流记录 ──
{
  const usageOfEvent = __testables.usageOfEvent

  ok('用量：优先取 data.usage', () => {
    const usage = { inputTokens: 10, outputTokens: 5 }
    assert.equal(usageOfEvent({ type: 'assistant/message', data: { usage } }), usage)
  })

  ok('用量：data.usage 缺失时回退到流里的 usage 块', () => {
    const usage = { inputTokens: 7, outputTokens: 3 }
    const event = {
      type: 'assistant/message',
      data: {
        stream: [
          { type: 'chunk', chunk: { type: 'text' } },
          { type: 'chunk', chunk: { type: 'usage', usage } },
        ],
      },
    }
    assert.equal(usageOfEvent(event), usage)
  })

  ok('用量：回退时取流里最后一条 usage 块', () => {
    const earlier = { inputTokens: 1, outputTokens: 1 }
    const latest = { inputTokens: 9, outputTokens: 9 }
    const event = {
      type: 'assistant/message',
      data: {
        stream: [
          { type: 'chunk', chunk: { type: 'usage', usage: earlier } },
          { type: 'chunk', chunk: { type: 'usage', usage: latest } },
        ],
      },
    }
    assert.equal(usageOfEvent(event), latest)
  })

  ok('用量：assistant/attempt 的流记录也会被读到（账号通道的用量常挂在这里）', () => {
    const usage = { inputTokens: 5, outputTokens: 5 }
    const event = {
      type: 'assistant/attempt',
      data: { stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] },
    }
    assert.equal(usageOfEvent(event), usage)
  })

  ok('用量：与 assistant 无关的事件一律返回 null', () => {
    assert.equal(usageOfEvent({ type: 'user/message', data: { usage: { inputTokens: 1 } } }), null)
    assert.equal(usageOfEvent({ type: 'llm/retry-started', data: { usage: { inputTokens: 1 } } }), null)
  })

  ok('用量：两条路都取不到时返回 null', () => {
    assert.equal(usageOfEvent({ type: 'assistant/message', data: {} }), null)
    assert.equal(usageOfEvent({ type: 'assistant/message' }), null)
    assert.equal(usageOfEvent({ type: 'assistant/message', data: { stream: [] } }), null)
  })
}

// ── 用量缺失标记：置真之后必须能被后续带用量的事件清掉 ──
{
  ok('缺失标记：先无用量后有用量时能清掉', async () => {
    let definition = null
    const indexModule = await import('../lib/index.js')
    indexModule.apply({
      logger: { debug() {} },
      inject(_deps, run) {
        run({
          sessionProjections: { register(def) { definition = def }, snapshot: () => ({ values: {} }) },
          on() {},
        })
      },
    })
    const at = Date.parse('2026-08-20T05:00:00Z')
    let state = definition.init()
    state = definition.apply(state, { type: 'assistant/message', data: { turn: 1, step: 1 }, time: at })
    assert.equal(state.usageMissed, true, '没有 usage 时应置真')
    state = definition.apply(state, {
      type: 'assistant/message',
      data: { turn: 1, step: 2, usage: { inputTokens: 1000000, outputTokens: 500000 } },
      time: at,
    })
    const view = definition.wire.view(state)
    assert.equal(view.usageMissed, false, '拿到 usage 后应清除标记')
    assert.equal(view.input, 1000000, '输入 token 应准确')
    assert.equal(view.output, 500000, '输出 token 应准确')
    assert.ok(Math.abs(view.cost - 0.45) < 1e-9, '谷时 100万×0.15 + 50万×0.6 = 0.45 美元')
  })
}

// ── 桥订阅：v1.9.1 曾误删这行，导致挂件永远停在初始的空值上（金额一直为零）──
{
  ok('挂件必须订阅桥：桥写入后重渲染出新值', () => {
    const { TideCard, Probe } = loadClientPlugin()
    const usage = {
      provider: 'deepseek', model: 'deepseek-v4-flash', cost: 0.432,
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      byModel: {}, usageMissed: false, diag: { message: 1, attempt: 0, usageFound: 1 }, official: null,
    }
    const props = {
      useProjection: key => (key === 'costUsage' ? usage : undefined),
      useSessions: sel => sel({ phase: 'ready', byId: { 'sess-1': { blank: false } } }),
      account: undefined,
    }
    // 先渲染挂件（此时桥为空），再让探针写桥，最后重渲染应拿到新值
    const before = costTextOf(TideCard(props))
    Probe({ sessionId: 'sess-1', useProjection: props.useProjection })
    const after = costTextOf(TideCard(props))
    assert.notEqual(after, before, '桥写入后金额应变化（' + before + ' → ' + after + '）')
    assert.equal(after, '¥2.88', '0.432 USD 应显示 ¥2.88')
  })
}

// ── 余额差值估算：账号内置通道不提供 usage 时的兜底（只在余额下降时累加）──
{
  const { testables } = loadClientPlugin()
  const makeTracker = testables.makeBalanceTracker

  ok('余额估算：只在余额下降时累加消耗', () => {
    const tracker = makeTracker()
    tracker.observe(50)
    tracker.observe(47.5)
    assert.equal(tracker.value, 2.5, '50 → 47.5 应记 2.5 元')
  })

  ok('余额估算：充值上涨不抵消已有消耗', () => {
    const tracker = makeTracker()
    tracker.observe(50)
    tracker.observe(45)
    tracker.observe(100)   // 充值
    assert.equal(tracker.value, 5, '充值只更新基准，不应把消耗冲成负数')
    tracker.observe(98)
    assert.equal(tracker.value, 7, '充值后再消耗 2 元，总计 7 元')
  })

  ok('余额估算：首次读数只建立基准', () => {
    const tracker = makeTracker()
    assert.equal(tracker.primed, false, '未读数为未就绪')
    tracker.observe(30)
    assert.equal(tracker.value, 0, '首次读数不该凭空产生消耗')
    assert.equal(tracker.primed, true, '读过后就绪')
  })

  ok('余额估算：非法读数被忽略', () => {
    const tracker = makeTracker()
    tracker.observe(20)
    tracker.observe(undefined)
    tracker.observe('abc')
    assert.equal(tracker.value, 0, '非法值不应改变结果')
  })
}

// ── 端到端：账号内置通道的用量走「宿主采样官方投影 → 前端计价」这条新链路 ──
{
  const handlers = []
  const officialTokens = { uncachedInputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 }
  let definition = null
  const indexModule = await import('../lib/index.js')
  indexModule.apply({
    logger: { debug() {} },
    inject(_deps, run) {
      run({
        sessionProjections: {
          register(def) { definition = def },
          snapshot: (session, keys) => (keys !== undefined && keys.includes('tokenUsage') ? { values: { tokenUsage: officialTokens } } : { values: {} }),
        },
        on(name, fn) { handlers.push({ name, fn }) },
      })
    },
  })

  ok('端到端：宿主注册了 session/event 监听', () => {
    assert.ok(handlers.some(h => h.name === 'session/event'), '应监听会话事件')
    assert.ok(definition !== null, '应注册投影')
  })

  ok('端到端：结算事件后官方 token 进入投影视图', () => {
    const handler = handlers.find(h => h.name === 'session/event')
    handler.fn({ id: 'sess-1' }, { type: 'assistant/message', data: { turn: 1, step: 1 } })
    const state = definition.apply(definition.init(), { type: 'assistant/message', data: { turn: 1, step: 1 }, time: Date.parse('2026-08-20T05:00:00Z') })
    const view = definition.wire.view(state)
    assert.equal(view.official.uncachedInputTokens, 1_000_000, '未命中输入应透传')
    assert.equal(view.official.outputTokens, 500_000, '输出应透传')
  })

  ok('端到端：前端用官方 token 算出金额（¥3.04）', () => {
    const state = definition.apply(definition.init(), { type: 'assistant/message', data: { turn: 1, step: 1 }, time: Date.parse('2026-08-20T05:00:00Z') })
    const view = definition.wire.view(state)
    const { TideCard, Probe } = loadClientPlugin()
    const useProjection = key => (key === 'costUsage' ? view : undefined)
    Probe({ sessionId: 'sess-1', useProjection })
    const tree = TideCard({
      useProjection,
      useSessions: sel => sel({ phase: 'ready', byId: { 'sess-1': { blank: false } } }),
      account: undefined,
    })
    // 组件计价用实时时钟，峰谷倍率不同（峰时是谷时的两倍），故按当前时段推期望值。
    const utcMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes()
    const inPeakNow = (utcMinutes >= 60 && utcMinutes < 240) || (utcMinutes >= 360 && utcMinutes < 600)
    const expected = inPeakNow ? '¥6.08' : '¥3.04'
    assert.equal(costTextOf(tree), expected,
      '官方 token 101.98M×' + (inPeakNow ? '0.3' : '0.15') + ' + 1.16M×' + (inPeakNow ? '1.2' : '0.6')
      + ' + 397.97M×' + (inPeakNow ? '0.006' : '0.003') + ' ≈ ' + (inPeakNow ? '¥6.08' : '¥3.04'))
  })
}

// ── 挂件钳位与气泡模板（纯函数；全屏 ↔ 小窗后挂件跑出视口是本项的存在理由）──
{
  const { testables } = loadClientPlugin()
  const clamp = testables.clampToViewport
  const fill = testables.fillTemplate
  const pickVariant = testables.pickVariant

  ok('钳位：窗口变小后右下角坐标被拉回视口内', () => {
    const r = clamp({ left: 1700, top: 900 }, { width: 1200, height: 800 }, { width: 92, height: 92 })
    assert.equal(r.left, 1200 - 92 - 12, 'left 应贴到右边缘内 12px')
    assert.equal(r.top, 800 - 92 - 12, 'top 应贴到底边缘内 12px')
  })

  ok('钳位：负坐标被拉回到内边距', () => {
    const r = clamp({ left: -50, top: -80 }, { width: 1200, height: 800 }, { width: 92, height: 92 })
    assert.equal(r.left, 12)
    assert.equal(r.top, 12)
  })

  ok('钳位：视口足够大时合法坐标原样保留', () => {
    const r = clamp({ left: 300, top: 200 }, { width: 1920, height: 1080 }, { width: 92, height: 92 })
    assert.deepEqual(r, { left: 300, top: 200 })
  })

  ok('钳位：视口比挂件还小时仍给出非负坐标', () => {
    const r = clamp({ left: 500, top: 500 }, { width: 60, height: 60 }, { width: 92, height: 92 })
    assert.equal(r.left, 12, 'left 应退到内边距而不是负数')
    assert.equal(r.top, 12)
  })

  ok('随机并列：不含 || 的行走原样返回', () => {
    assert.equal(pickVariant('余额 {balance}'), '余额 {balance}')
  })

  ok('随机并列：含 || 时只返回其中一段', () => {
    const candidates = ['现在便宜', '谷期省钱', '放开用']
    for (let i = 0; i < 30; i += 1) {
      const picked = pickVariant(candidates.join(' || '))
      assert.ok(candidates.includes(picked), '抽到了段落外的内容: ' + picked)
    }
  })

  ok('随机并列：并列的每一段都可能被抽到', () => {
    const seen = new Set()
    for (let i = 0; i < 120; i += 1) seen.add(pickVariant('A || B || C'))
    assert.equal(seen.size, 3, '三段并列应都能被抽到')
  })

  ok('模板：占位符替换为实时值，未知占位符原样保留', () => {
    assert.equal(fill('余额 {balance} · 未定义 {nope}', { balance: '¥16.71' }), '余额 ¥16.71 · 未定义 {nope}')
  })
}

// ── 归属判据回归（加载真实 lib/client.js，驱动会话切换序列）──────────────
const ownership = runOwnershipChecks()
for (const [status, name] of ownership.results) {
  if (status === 'PASS') passed += 1
  console.log('  ' + (status === 'PASS' ? '✓' : '✗') + ' ' + name)
}
const ownershipFailures = ownership.results.filter(([status]) => status !== 'PASS')

console.log(`[dsh-tidewatch] verify: ${passed} passed${ownershipFailures.length > 0 ? `，${ownershipFailures.length} failed` : ''}`)
if (ownershipFailures.length > 0) process.exitCode = 1


// 断言执行完毕后显式退出：加载 lib/client.js 会在假环境里留下组件 effect 的定时器，
// 没有这一步，`node test/verify.mjs` 会跑完却挂住（进程不退出）。
process.exit(process.exitCode ?? 0)
