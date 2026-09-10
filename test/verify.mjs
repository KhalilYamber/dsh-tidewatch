/**
 * dsh-tidewatch 纯模块验证（node test/verify.mjs）。
 * 所有时刻均为固定示例值，仅用于断言峰谷窗口与计费逻辑，与真实时钟无关。
 * 另含「双份常量一致性」校验：lib/client.js 的展示常量必须与 lib/pricing.js
 * 的计费常量一致，防止官方调价/改窗口时只改一处导致的静默漂移。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isPeakHour, peakPhaseAt, costOf, priceEntryFor,
  DEFAULT_PEAK_WINDOWS, DEFAULT_PRICE_TABLE, LEGACY_BASE_BOUNDARY,
  FLASH_V41_BOUNDARY, PRO_TO_FLASH_BOUNDARY,
} from '../lib/pricing.js'

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
ok('deepseek-flash 命中 flash 条目', () => {
  assert.equal(priceEntryFor('deepseek-flash').offPeak.output, 0.6)
})
ok('deepseek-v4-flash 旧名命中 flash 条目（新价）', () => {
  assert.equal(priceEntryFor('deepseek-v4-flash').offPeak.output, 0.6)
})
ok('deepseek-v4-flash-vision-exp 命中 flash 条目（新价）', () => {
  assert.equal(priceEntryFor('deepseek-v4-flash-vision-exp').offPeak.output, 0.6)
})
ok('deepseek-v4-pro 命中 pro 条目', () => {
  assert.equal(priceEntryFor('deepseek-v4-pro').offPeak.output, 1.98)
})
ok('未知模型回退 default（= V4.1-Flash 新价）', () => {
  assert.equal(priceEntryFor('gpt-999').offPeak.output, 0.6)
})

// ── costOf（美元 / 1M tokens 口径）──
const flash = priceEntryFor('deepseek-v4-flash')
ok('峰期 1M 输入未命中 + 1M 输出 = 0.44 + 1.32 = 1.76 USD（9/10 前旧 V4-Flash 价）', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-19T07:00:00Z'))
  assert.ok(Math.abs(c - 1.76) < 1e-9)
})
ok('谷期 1M 输入未命中 + 1M 输出 = 0.22 + 0.66 = 0.88 USD（9/10 前旧 V4-Flash 价）', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-19T05:00:00Z'))
  assert.ok(Math.abs(c - 0.88) < 1e-9)
})
ok('缓存读写按命中价计费（9/10 前旧 V4-Flash 价）', () => {
  const c = costOf({ input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 }, flash, Date.parse('2026-08-19T05:00:00Z'))
  assert.ok(Math.abs(c - 0.007) < 1e-9)
})
ok('峰谷时代前（2026-08-10）按 legacyBase 计费', () => {
  assert.ok(Date.parse('2026-08-10T00:00:00Z') < Date.parse(LEGACY_BASE_BOUNDARY))
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-10T00:00:00Z'))
  assert.ok(Math.abs(c - 0.14) < 1e-9)
})
ok('非负保护：负 token 按 0 计', () => {
  const c = costOf({ input: -5, output: -1, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-19T05:00:00Z'))
  assert.equal(c, 0)
})

// ── V4.1-Flash 价格时效（2026-09-10 / 2026-09-14 边界）──
ok('9/10 后 flash 谷期 1M miss + 1M out = 0.15 + 0.6 = 0.75 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-11T05:00:00Z'))
  assert.ok(Math.abs(c - 0.75) < 1e-9)
})
ok('9/10 后 flash 峰期 1M miss + 1M out = 0.3 + 1.2 = 1.5 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-11T07:00:00Z'))
  assert.ok(Math.abs(c - 1.5) < 1e-9)
})
ok('9/10 前 1ms 仍按旧 V4-Flash 峰价（边界左邻，时刻仍在峰窗）', () => {
  const justBefore = Date.parse(FLASH_V41_BOUNDARY) - 1
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, flash, justBefore)
  // 04:00 boundary − 1ms ≈ 03:59 UTC → peak window of the *old* V4-Flash table.
  assert.ok(Math.abs(c - 0.44) < 1e-9)
})
ok('9/10 当刻起按 V4.1-Flash 谷价（04:00 UTC 落在峰窗外）', () => {
  const justAt = Date.parse(FLASH_V41_BOUNDARY)
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, flash, justAt)
  assert.ok(Math.abs(c - 0.15) < 1e-9)
})
ok('9/14 前 pro 仍按 Pro 谷价（0.66 miss）', () => {
  const pro = priceEntryFor('deepseek-v4-pro')
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, pro, Date.parse('2026-09-13T05:00:00Z'))
  assert.ok(Math.abs(c - 0.66) < 1e-9)
})
ok('9/14 后 pro 路由到 Flash 谷价（0.15 miss）', () => {
  const pro = priceEntryFor('deepseek-v4-pro')
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, pro, Date.parse('2026-09-14T05:00:00Z'))
  assert.ok(Math.abs(c - 0.15) < 1e-9)
})
ok('9/14 当刻（04:00 UTC 谷期）pro 按 Flash 谷价（0.15 miss）', () => {
  const pro = priceEntryFor('deepseek-v4-pro')
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, pro, Date.parse(PRO_TO_FLASH_BOUNDARY))
  // 2026-09-14 is a Monday; 04:00 UTC is off-peak (peak windows are half-open).
  assert.ok(Math.abs(c - 0.15) < 1e-9)
})
ok('9/14 后 pro 峰期按 Flash 峰价（0.3 miss）', () => {
  const pro = priceEntryFor('deepseek-v4-pro')
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, pro, Date.parse('2026-09-15T07:00:00Z'))
  assert.ok(Math.abs(c - 0.3) < 1e-9)
})
ok('legacy 峰谷时代前的 flash 仍走 legacyBase，不受 Flash 新价影响', () => {
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-01T07:00:00Z'))
  assert.ok(Math.abs(c - 0.14) < 1e-9)
})

console.log(`[dsh-tidewatch] verify: ${passed} passed`)
