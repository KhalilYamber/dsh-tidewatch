/**
 * dsh-tidewatch x DSH 0.1.7-rc.2 归属判据回归（前端侧）。
 *
 * 背景：旧代码用 props.useSessions(s => s.current) 取「当前会话」，而壳层交给
 * root 插槽的 state 是 SessionListState（ids / byId / phase / projectionsBySession），
 * 其中没有 current 字段 —— 判据恒为 undefined，金额一律被强制置 null，卡片
 * 长期显示 ¥0.00。
 *
 * 做法：不靠肉眼比对源码，直接在一个极小的 Node 环境里加载 lib/client.js
 * （假 window + 假 React 渲染器），抓出它真正注册的 Probe / TideCard 组件，
 * 亲手驱动「会话切换」序列，断言：
 *   ① 桥值归属取到的是活跃会话；
 *   ② 会话切换时旧会话卸载不许清掉新会话刚写进去的桥值；
 *   ③ 归属会话从列表消失后，金额被存活校验挡下；
 *   ④ 列表未就绪时不误杀。
 *
 * 运行：node test/ownership-repro.mjs（退出码 0 = FIXED）
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const src = readFileSync(join(libDir, 'client.js'), 'utf8')

// ── 极小的宿主替身：window + 假 React 渲染器（只实现插件用到的那几个 API）──
let hooks = []
const pendingCleanups = []
function mkHook(init) {
  const record = {
    value: typeof init === 'function' ? init() : init,
    cleanup: null,
    depsKey: undefined,
  }
  hooks.push(record)
  return record
}
let rerenderTarget = null
let rerenderProps = null
let rendering = false
let rerenderQueued = false
function rerender() {
  if (rerenderTarget === null) return
  // 插件可能在渲染过程中同步 setState（如 rAF 存根立即回调 measure）；
  // 这里登记待重渲染、由外层 render 收尾时补一次，避免无限递归。
  if (rendering) { rerenderQueued = true; return }
  render(rerenderTarget, rerenderProps)
}
function render(Component, props) {
  const saved = hooks
  const savedTarget = rerenderTarget
  const savedProps = rerenderProps
  hooks = []
  rerenderTarget = Component
  rerenderProps = props
  rendering = true
  try {
    return Component(props)
  } finally {
    rendering = false
    hooks = saved
    rerenderTarget = savedTarget
    rerenderProps = savedProps
    if (rerenderQueued) { rerenderQueued = false; rerender() }
  }
}

const FakeReact = {
  createElement: (type, props, ...children) => ({ $el: true, type, props: props ?? {}, children }),
  cloneElement: (node, extra) => ({ ...node, props: { ...node.props, ...extra } }),
  Fragment: Symbol('Fragment'),
  useState: init => {
    const record = mkHook(init)
    return [record.value, next => { record.value = typeof next === 'function' ? next(record.value) : next; rerender() }]
  },
  useEffect: (fn, deps) => {
    const record = mkHook(undefined)
    const key = JSON.stringify(deps ?? null)
    const firstRun = record.depsKey === undefined
    if (!firstRun && record.depsKey === key) return
    record.depsKey = key
    if (typeof record.cleanup === 'function') record.cleanup()
    const cleanup = fn()
    record.cleanup = typeof cleanup === 'function' ? cleanup : null
    if (firstRun) pendingCleanups.push(record)
  },
  useCallback: fn => fn,
  useRef: init => {
    const record = mkHook({ current: init })
    return record.value
  },
}

const moduleTable = {
  'react': FakeReact,
  'react-dom': { createPortal: (node, host) => node },
}
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load: registration => { globalThis.__REGISTRATION__ = registration } },
}

// 浏览器最小面：插件在会话确有 token 统计前找不到 [data-composer-stats]，
// 于是走兜底的浮动定位分支——本脚本正是要验这个分支与归属判据的配合。
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, textContent: '' }),
  head: { appendChild() {} },
  body: {},
  addEventListener() {},
  removeEventListener() {},
}
class NoopObserver {
  observe() {}
  disconnect() {}
  takeRecords() { return [] }
}
globalThis.MutationObserver = NoopObserver
globalThis.ResizeObserver = NoopObserver
globalThis.requestAnimationFrame = fn => { fn(); return 0 }
globalThis.cancelAnimationFrame = () => {}
globalThis.localStorage = { getItem: () => null, setItem() {} }

// 加载插件（factory 只执行一次，产出 exports 并吞掉 CSS 注入等模块级副作用）
const pluginModule = (() => {
  // eslint-disable-next-line no-new-func
  new Function('window', src)(globalThis.window)
  const registration = globalThis.__REGISTRATION__
  if (registration === undefined) throw new Error('client.js 未注册 __ModuleLoader__')
  return registration.factory(id => {
    if (Object.prototype.hasOwnProperty.call(moduleTable, id)) return moduleTable[id]
    throw new Error('unexpected require: ' + id)
  })
})()

// ── 取出插件真正注册进去的两个组件 ────────────────────────────────────────
const entries = new Map()
pluginModule.apply({
  remote: undefined,
  get: key => (key === 'slots' ? {
    inject: (name, register) => { entries.set(name, register()) },
    register: (options, Component) => Component,
  } : undefined),
})

const Probe = entries.get('conversation.composer.dock')
const TideCard = entries.get('shell.overlay')
if (typeof Probe !== 'function' || typeof TideCard !== 'function') {
  console.error('[owner] 未取到 Probe / TideCard —— client.js 的注册路径变了，脚本失效')
  process.exit(2)
}

const listState = (ids, byId, phase) => ({ ids, byId, phase, projectionsBySession: {} })
const sessA = { id: 'sess-A', blank: false, updatedAt: 1 }
const sessB = { id: 'sess-B', blank: false, updatedAt: 2 }
const readyA = listState(['sess-A'], { 'sess-A': sessA }, 'ready')
const readyAB = listState(['sess-A', 'sess-B'], { 'sess-A': sessA, 'sess-B': sessB }, 'ready')
/** 归属会话 B 已从列表消失（被关闭）——只剩 A 在列。 */
const onlyA = listState(['sess-A'], { 'sess-A': sessA }, 'ready')

/** 让 TideCard 以给定会话列表渲染一帧，读回它这一帧实际显示的金额文本。 */
function costAsRendered(state) {
  return findCost(render(TideCard, { useSessions: selector => selector(state) }))
}
/**
 * 在元素树里找折叠态的金额文本。插件把胶囊包在自己的 Tip 组件里，遇到函数
 * 型节点就把它的 props 当组件 props 渲染一层——只对插件自身的组件这样做
 * （原生标签从 'span'/'button' 这类字符串类型可以认出）。
 */
function findCost(node) {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findCost(child); if (hit !== null) return hit }
    return null
  }
  if (typeof node !== 'object' || node.$el !== true) return null
  if (node.type === 'span' && node.props.className === 'tw-cost') return node.children[0]
  const children = typeof node.type === 'function'
    ? [render(node.type, node.props)]
    : node.children
  for (const child of children) { const hit = findCost(child); if (hit !== null) return hit }
  return null
}

const checks = []
const check = (name, fn) => {
  try { fn(); checks.push(['PASS', name]) } catch (error) { checks.push(['FAIL', name + ' :: ' + error.message]) }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

// ① 会话 A 挂载：桥值归属 A、金额可见。夹具只保留 A 这一个「在册」探针，
//   以便下面单独执行它的卸载清理（React 卸载组件时会跑它自己的清理函数）。
pendingCleanups.length = 0
render(Probe, { sessionId: 'sess-A', useProjection: () => ({ cost: 0.432 }) })
check('① 会话 A 挂载后，卡片显示 A 的 0.432 USD（¥2.88）', () => {
  const cost = costAsRendered(readyA)
  assert(cost === '¥2.88', '预期 ¥2.88（0.432 × 6.67），实得 ' + JSON.stringify(cost))
})

// ② 切到会话 B：B 先挂载、A 后卸载（React 在 keyed 插槽上的真实顺序）
render(Probe, { sessionId: 'sess-B', useProjection: () => ({ cost: 0.100 }) })
check('② 会话 B 先挂载，桥值归属 B（¥0.67）', () => {
  const cost = costAsRendered(readyAB)
  assert(cost === '¥0.67', '预期 ¥0.67（0.100 × 6.67），实得 ' + JSON.stringify(cost))
})

// ③ 旧会话 A 的 effect 清理随后执行：不许清掉 B 刚写进去的桥值
for (const record of pendingCleanups) {
  if (typeof record.cleanup === 'function') { record.cleanup(); record.cleanup = null }
}
check('③ 旧会话 A 卸载后，桥值仍归属 B（未被清掉）', () => {
  const cost = costAsRendered(readyAB)
  assert(cost === '¥0.67', '预期仍为 ¥0.67，实得 ' + JSON.stringify(cost))
})

// ④ 归属会话 B 被关闭（从列表消失）：存活校验应把残值挡下
check('④ 归属会话从列表消失后，金额被存活校验挡下（¥0.00）', () => {
  const cost = costAsRendered(onlyA)
  assert(cost === '¥0.00', '预期 ¥0.00，实得 ' + JSON.stringify(cost))
})

// ⑤ 归属会话仍在列表里（只是不再是最新报到者）：照常展示，不做多余判断
check('⑤ 归属会话仍在列表时照常展示（¥0.67）', () => {
  const cost = costAsRendered(readyAB)
  assert(cost === '¥0.67', '预期 ¥0.67，实得 ' + JSON.stringify(cost))
})

// ⑥ 会话列表未就绪（phase !== ready）时不做存活判断，桥值照常展示
check('⑥ 列表未就绪时不误杀（保留桥值 ¥0.67）', () => {
  const cost = costAsRendered(listState([], {}, 'pending'))
  assert(cost === '¥0.67', '预期 ¥0.67，实得 ' + JSON.stringify(cost))
})

console.log('[owner] lib/client.js 已按真实路径加载，取到 Probe + TideCard')
console.log('')
for (const [status, name] of checks) console.log('  ' + (status === 'PASS' ? '✓' : '✗') + ' ' + name)
const failed = checks.filter(([status]) => status !== 'PASS')
console.log('')
console.log('[owner] 结论：' + (failed.length === 0
  ? 'FIXED — 归属由会话侧申报，金额随活跃会话切换，残值被挡下，未就绪时不误杀。'
  : 'DRIFT — ' + failed.length + ' 项未达成，先查清原因再动。'))
process.exit(failed.length === 0 ? 0 : 1)
