/**
 * dsh-tidewatch x DSH 0.1.7-rc.2 计费口径回归（宿主侧）。
 *
 * 目的：用「当前 DSH 真实存在的事件形状」喂插件真实的 costUsage 投影，
 * 断言「一次调用 = 恰好一笔费用」这一目标态不被改回去。
 * 目标态四行见文件末尾「目标态」段；本脚本以退出码表态（0 = FIXED）。
 *
 * 取证（全部来自 DSHAR工作目录/deepseek-harness-src）：
 *   - packages/core/session/src/types.ts:341  'assistant/message' 携带 usage?: TokenUsage
 *   - packages/core/session/src/types.ts:355  'assistant/attempt' = { turn, step, stream }，无 usage
 *   - packages/core/agent-loop/src/agent.ts:451-475  现行 loop append 的是 'assistant/attempt'
 *   - packages/core/session/lib/types/types.js:54   SESSION_FORMAT_VERSION = 4
 *   - packages/session/session-format-v2-to-v3/tests/migration.spec.ts:196
 *       'assistant/chunk' 行在升到 v3 后数量为 0（事件被折叠）
 *
 * 运行：node test/adapt-repro.mjs
 */
import {
  priceEntryFor, costOf, isPeakHour, peakPhaseAt,
} from '../lib/pricing.js'

// ── 用假 ctx 把插件真实的 costUsage 投影取出来（不改插件源码）─────────────
const plugin = await import('../lib/index.js')

const captured = []
const fakeProjectionCtx = {
  sessionProjections: { register: definition => { captured.push(definition); return () => {} } },
}
const fakeCtx = {
  inject(_deps, callback) { callback(fakeProjectionCtx) },
}
plugin.apply(fakeCtx)

if (captured.length !== 1) {
  console.error('[repro] 预期捕获 1 个投影，实得 ' + captured.length + ' 个——插件注册路径变了，本脚本失效')
  process.exit(2)
}
const projection = captured[0]
console.log('[repro] 捕获投影 key=' + JSON.stringify(projection.key) + ' stateVersion=' + projection.stateVersion)

// ── 构造真实事件（形状逐字取自 DSH 源码，非臆造）──────────────────────────
/** 计费时刻基准：UTC 2026-09-14 07:00（周一、峰时段 06:00-10:00、V4.1 Flash 现行价时代）。 */
const AT = Date.parse('2026-09-14T07:00:00Z')

const header = {
  type: 'request/header',
  time: AT,
  data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
}

/** 一次调用的 usage：input=100万未命中、output=10万、cacheRead=200万、reasoning=5万。 */
const USAGE = {
  inputTokens: 1000000,
  outputTokens: 100000,
  cacheReadTokens: 2000000,
  cacheWriteTokens: 0,
  reasoningTokens: 50000,
  totalTokens: 3150000,
}

/** 现行 loop 的事件：assistant/attempt（payload 里没有 usage 字段）。 */
const attemptEvent = time => ({
  type: 'assistant/attempt',
  time,
  data: {
    turn: 1,
    step: 1,
    stream: [
      { index: 0, time, chunk: { type: 'usage', usage: USAGE } },
      { index: 1, time, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ],
  },
})

/** 结算事件：assistant/message，usage 挂在 data 顶层。 */
const messageEvent = time => ({
  type: 'assistant/message',
  time,
  data: { turn: 1, step: 1, message: { id: 'm1' }, usage: USAGE },
})

/** 旧格式事件：assistant/chunk（v2 及以前；升到 v3 后被折叠掉）。 */
const chunkEvent = time => ({
  type: 'assistant/chunk',
  time,
  data: { turn: 1, step: 1, chunk: { type: 'usage', usage: USAGE } },
})

/** 把事件序列喂给插件投影，返回 { state, view }。 */
function fold(events) {
  let state = projection.init({}, 0)
  for (const event of events) state = projection.apply(state, event)
  return { state, view: projection.wire.view(state) }
}

// ── 参照值：用插件自己的 pricing 纯函数算「这一笔应该花多少」─────────────
const entry = priceEntryFor('deepseek-flash', AT)
const expected = costOf(
  { input: USAGE.inputTokens, output: USAGE.outputTokens, cacheRead: USAGE.cacheReadTokens, cacheWrite: USAGE.cacheWriteTokens, reasoning: USAGE.reasoningTokens },
  entry,
  AT,
)

console.log('')
console.log('[repro] 基准时刻 = ' + new Date(AT).toISOString() + '（UTC 小时 ' + new Date(AT).getUTCHours() + '）')
console.log('[repro] 当前是否峰时（官方窗口判定） = ' + isPeakHour(AT))
console.log('[repro] 该笔「应为」金额（pricing.costOf 独立计算） = ' + expected.toFixed(9) + ' USD')
console.log('')

const scenarios = [
  ['S1 仅 assistant/chunk（旧格式唯一事件）', [header, chunkEvent(AT)]],
  ['S2 仅 assistant/message（现行结算事件）', [header, messageEvent(AT)]],
  ['S3 chunk + message（双计现场）', [header, chunkEvent(AT), messageEvent(AT)]],
  ['S4 仅 assistant/attempt（现行流式事件）', [header, attemptEvent(AT)]],
]

const rows = []
for (const [label, events] of scenarios) {
  const { view } = fold(events)
  const usd = view.cost
  rows.push({ label, tokens: view.input + view.output + view.cacheRead, usd, ratio: usd / expected })
}

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('场景', 46) + pad('计费 token 桶', 16) + pad('金额(USD)', 16) + '相对基准')
console.log('-'.repeat(94))
for (const r of rows) {
  console.log(pad(r.label, 46) + pad(String(r.tokens), 16) + pad(r.usd.toFixed(9), 16) + r.ratio.toFixed(3) + 'x')
}

console.log('')
console.log('[repro] 目标态（DSH 0.1.7-rc.2 适配后应当如此）：')
console.log('  - S1 = 0        => 已死的 assistant/chunk 不再被计入（它不是现役事件）')
console.log('  - S2 = 1.000x   => 现行唯一带 usage 的 assistant/message 正常计费')
console.log('  - S3 = 1.000x   => 同一 (turn, step) 的流式与结算不翻倍（先减后加去重）')
console.log('  - S4 = 0        => 现行 assistant/attempt 不计费（与官方 token-meter 同口径）')

const s1 = rows[0].usd
const s2 = rows[1].usd
const s3 = rows[2].usd
const s4 = rows[3].usd
const near = (a, b) => Math.abs(a - b) < 1e-9
let verdict
if (near(s1, 0) && near(s2, expected) && near(s3, expected) && near(s4, 0)) {
  verdict = ['FIXED', '口径成立：一次调用 = 恰好一笔费用（S2、S3 均为 1.000x），死事件与失败尝试都不进账。']
} else {
  verdict = ['DRIFT', '实际 S1=' + s1 + ' S2=' + s2 + ' S3=' + s3 + ' S4=' + s4 + '，与目标态不符——计费口径漂了，先查清原因。']
}
console.log('')
console.log('[repro] 结论：' + verdict[0] + ' — ' + verdict[1])

const phase = peakPhaseAt(AT)
console.log('[repro] 顺带：peakPhaseAt(' + new Date(AT).toISOString() + ') -> inPeak=' + phase.inPeak + '，下一切换点=' + new Date(phase.nextAtMs).toISOString() + ' 入峰=' + phase.nextIntoPeak)

process.exit(verdict[0] === 'FIXED' ? 0 : 1)
