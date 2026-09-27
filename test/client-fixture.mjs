/**
 * dsh-tidewatch 前端测试夹具（test/verify.mjs 与诊断脚本共用）。
 *
 * 在一个极小的 Node 环境里按**真实加载路径**跑起 lib/client.js：
 *   window.__ModuleLoader__.load({id, factory}) → factory(require) → exports.apply(ctx)
 * 于是拿到的是插件真正注册给壳层的 Probe 与 TideCard，不是照抄的一份逻辑。
 *
 * 替身只覆盖插件实际用到的面：React 的 createElement / cloneElement /
 * Fragment / useState / useEffect / useCallback / useRef，以及 window /
 * document / MutationObserver / ResizeObserver / requestAnimationFrame /
 * localStorage。假 React 不做调和，只按函数组件签名逐层展开，并把
 * setState 记为「需要重渲染」。
 *
 * 导出：
 *   loadClientPlugin()      → { Probe, TideCard, render }
 *   listState()             → 造一个真实形状的 SessionListState（无 current 字段）
 *   renderTideCard(state)   → 渲染一帧，返回元素树
 *   costTextOf(tree)        → 从元素树里读出折叠态金额文本
 *   runOwnershipChecks()    → 跑归属判据全部用例，返回 ['PASS'|'FAIL', 名称][] 与细节
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

// ── 假 React（含最小钩子实现与重入保护）──────────────────────────────────
let hooks = []
const pendingCleanups = []
function mkHook(init) {
  const record = { value: typeof init === 'function' ? init() : init, cleanup: null, depsKey: undefined }
  hooks.push(record)
  return record
}
let rerenderTarget = null
let rerenderProps = null
let rendering = false
let rerenderQueued = false
function rerender() {
  if (rerenderTarget === null) return
  // 插件可能在渲染过程中同步 setState（rAF 存根会立刻回调 measure）；
  // 登记待重渲染、由外层 render 收尾时补一次，避免无限递归。
  if (rendering) { rerenderQueued = true; return }
  render(rerenderTarget, rerenderProps)
}
function render(Component, props) {
  const savedHooks = hooks
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
    hooks = savedHooks
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
    return [record.value, next => {
      record.value = typeof next === 'function' ? next(record.value) : next
      rerender()
    }]
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
  useRef: init => mkHook({ current: init }).value,
}

const moduleTable = {
  'react': FakeReact,
  'react-dom': { createPortal: node => node },
}

/** 浏览器最小面：插件在会话确有 token 统计前找不到 [data-composer-stats]，走浮动定位兜底分支。 */
function installBrowserStubs() {
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: { load: registration => { globalThis.__REGISTRATION__ = registration } },
  }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, textContent: '' }),
    head: { appendChild() {} },
    body: {},
    addEventListener() {},
    removeEventListener() {},
  }
  class NoopObserver { observe() {} disconnect() {} takeRecords() { return [] } }
  globalThis.MutationObserver = NoopObserver
  globalThis.ResizeObserver = NoopObserver
  globalThis.requestAnimationFrame = fn => { fn(); return 0 }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.localStorage = { getItem: () => null, setItem() {} }
}

/**
 * 按真实路径加载 lib/client.js，返回它注册的两个组件。
 * @returns {{ Probe: Function, TideCard: Function }} 插槽组件。
 */
export function loadClientPlugin() {
  installBrowserStubs()
  const src = readFileSync(join(libDir, 'client.js'), 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', src)(globalThis.window)
  const registration = globalThis.__REGISTRATION__
  if (registration === undefined) throw new Error('client.js 未注册 __ModuleLoader__')
  const pluginModule = registration.factory(id => {
    if (Object.prototype.hasOwnProperty.call(moduleTable, id)) return moduleTable[id]
    throw new Error('unexpected require: ' + id)
  })
  const entries = new Map()
  pluginModule.apply({
    remote: undefined,
    get: key => (key === 'slots'
      ? {
          inject: (name, register) => { entries.set(name, register()) },
          register: (options, Component) => Component,
        }
      : undefined),
  })
  const Probe = entries.get('conversation.composer.dock')
  const TideCard = entries.get('shell.overlay')
  if (typeof Probe !== 'function' || typeof TideCard !== 'function') {
    throw new Error('lib/client.js 未注册预期的 Probe / TideCard（插槽名或注册路径变了）')
  }
  return { Probe, TideCard }
}

/** 真实形状的 SessionListState（字段取自 dsh-api-session-controller 的 service.ts）。 */
export function listState(ids, byId, phase) {
  return { ids, byId, phase, projectionsBySession: {} }
}

/** 渲染一帧 TideCard（注入 useSessions 标准钩子）。 */
export function renderTideCard(TideCard, state) {
  return render(TideCard, { useSessions: selector => selector(state) })
}

/**
 * 从元素树里读折叠态金额文本。插件把胶囊包在自己的 Tip 组件里，遇到函数型
 * 节点就把它的 props 当组件 props 渲染一层（原生标签的类型是字符串，可辨认）。
 * @returns 金额文本，找不到返回 null。
 */
export function costTextOf(node) {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = costTextOf(child); if (hit !== null) return hit }
    return null
  }
  if (typeof node !== 'object' || node.$el !== true) return null
  if (node.type === 'span' && node.props.className === 'tw-cost') return node.children[0]
  const children = typeof node.type === 'function' ? [render(node.type, node.props)] : node.children
  for (const child of children) { const hit = costTextOf(child); if (hit !== null) return hit }
  return null
}

/** 执行「旧会话卸载清理」——对应 React 卸载组件时跑它在册的 effect 清理函数。 */
export function runPendingCleanups() {
  for (const record of pendingCleanups) {
    if (typeof record.cleanup === 'function') { record.cleanup(); record.cleanup = null }
  }
}

/** 清空「在册探针」清单：让下面执行的清理只代表指定的那一个会话。 */
export function resetPendingCleanups() {
  pendingCleanups.length = 0
}

/**
 * 归属判据全套用例（会话切换序列 + 存活校验 + 未就绪不误杀）。
 * @returns {{ results: [string, string][], render: Function }} results 为 ['PASS'|'FAIL', 名称]。
 */
export function runOwnershipChecks() {
  const { Probe, TideCard } = loadClientPlugin()
  const renderTree = state => renderTideCard(TideCard, state)
  const cost = state => costTextOf(renderTree(state))

  const sessA = { id: 'sess-A', blank: false, updatedAt: 1 }
  const sessB = { id: 'sess-B', blank: false, updatedAt: 2 }
  const readyA = listState(['sess-A'], { 'sess-A': sessA }, 'ready')
  const readyAB = listState(['sess-A', 'sess-B'], { 'sess-A': sessA, 'sess-B': sessB }, 'ready')
  const onlyA = listState(['sess-A'], { 'sess-A': sessA }, 'ready')

  const results = []
  const check = (name, fn) => {
    try { fn(); results.push(['PASS', name]) } catch (error) { results.push(['FAIL', name + ' :: ' + error.message]) }
  }
  const assertEqual = (actual, expected, label) => {
    if (actual !== expected) throw new Error(label + '：预期 ' + JSON.stringify(expected) + '，实得 ' + JSON.stringify(actual))
  }

  // ① 会话 A 挂载：桥值归属 A、金额可见。夹具只留 A 这一个在册探针，
  //   以便下面单独执行它的卸载清理。
  resetPendingCleanups()
  render(Probe, { sessionId: 'sess-A', useProjection: () => ({ cost: 0.432 }) })
  check('归属：会话 A 挂载后显示 A 的 0.432 USD（¥2.88）', () => {
    assertEqual(cost(readyA), '¥2.88', 'A 的金额')
  })

  // ② 切到会话 B（React 在 keyed 插槽里的真实顺序：B 先挂载、A 后卸载）
  render(Probe, { sessionId: 'sess-B', useProjection: () => ({ cost: 0.100 }) })
  check('归属：会话 B 挂载后金额切到 B（¥0.67）', () => {
    assertEqual(cost(readyAB), '¥0.67', 'B 的金额')
  })

  // ③ 旧会话 A 的 effect 清理随后执行：不许清掉 B 刚写进去的桥值
  runPendingCleanups()
  check('归属：旧会话卸载不抹掉新会话的桥值（仍 ¥0.67）', () => {
    assertEqual(cost(readyAB), '¥0.67', '清理后的金额')
  })

  // ④ 归属会话被关闭（从列表消失）：存活校验把残值挡下
  check('归属：会话从列表消失后金额归零（存活校验生效）', () => {
    assertEqual(cost(onlyA), '¥0.00', '残值')
  })

  // ⑤ 归属会话仍在列表（只是不再是最新报到者）：照常展示
  check('归属：会话仍在列表时照常展示（¥0.67）', () => {
    assertEqual(cost(readyAB), '¥0.67', '在列金额')
  })

  // ⑥ 会话列表未就绪（phase !== ready）：不做存活判断，桥值照常展示
  check('归属：列表未就绪时不误杀（保留 ¥0.67）', () => {
    assertEqual(cost(listState([], {}, 'pending')), '¥0.67', '未就绪金额')
  })

  return { results, render: renderTree }
}
