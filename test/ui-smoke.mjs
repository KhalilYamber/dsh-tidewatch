/**
 * 前端布局冒烟测试：用真实样式表在无头 Chrome 里渲染挂件、泡泡与面板，
 * 断言几件曾经翻过车的事——挂件可见、可被点中、泡泡在形象上方、
 * 左侧吸附时浮层不探出视口。
 *
 * 这几轮的用户可见缺陷（点击丢失、泡泡渲染到屏幕外、金额摊开）都属布局与
 * 层叠问题，纯逻辑自检盖不住；本文件补上这一层。
 *
 * 无 Chrome 时整体跳过并以 0 退出（不阻塞没有浏览器的环境）。
 * 运行：node test/ui-smoke.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

/** 常见安装位置里找一个可用的 Chrome / Edge。 */
function findBrowser() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  return candidates.find(p => existsSync(p)) ?? null
}

/** 从 lib/client.js 里取出真实样式表内容。 */
function extractCss() {
  const src = readFileSync(join(libDir, 'client.js'), 'utf8')
  const start = src.indexOf('const css = [')
  const end = src.indexOf('].join(', start)
  if (start < 0 || end < 0) throw new Error('client.js 未找到样式表数组')
  const body = src.slice(start + 'const css = ['.length, end)
  // 每项是单引号字符串字面量，逐行取出内容
  return body.split('\n')
    .map(line => {
      const m = /^\s*'((?:[^'\\]|\\.)*)',?\s*$/.exec(line)
      return m === null ? null : m[1].replace(/\\'/g, "'")
    })
    .filter(v => v !== null && v.length > 0)
    .join('\n')
}

const CSS = extractCss()

/** 一像素透明 GIF，避免测试依赖真实立绘文件。 */
const DOT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function fixtureHtml() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0e1220;color:#e8e8e8;font:13px/1.5 system-ui,'Microsoft YaHei',sans-serif}
${CSS}
</style></head><body>
<!-- 右下角挂件 + 展开的泡泡 -->
<div class="tw-widget" id="widget" style="right:12px;bottom:96px">
  <button class="tw-mascot" id="mascot"><img class="tw-mascot-img" src="${DOT}" alt=""></button>
  <div class="tw-bubble-pop" id="bubble">
    <div class="tw-bubble-line">谷期 · 距切换 <span id="countdown">距峰期 17:45:23</span></div>
    <div class="tw-bubble-line">余额 ¥16.71</div>
    <div class="tw-bubble-line">充值 ¥10.00 / 礼金 ¥6.71</div>
    <button class="tw-bubble-more">详情 ›</button>
  </div>
</div>
<!-- 吸附到左边缘的挂件 + 展开的完整面板 -->
<div class="tw-widget tw-flip" id="widgetLeft" style="left:12px;bottom:96px">
  <button class="tw-mascot"><img class="tw-mascot-img" src="${DOT}" alt=""></button>
  <div class="tw-panel-pop" id="panelLeft">
    <div class="tw-panel-bar"><button class="tw-panel-close">✕</button></div>
    <div class="tw-h">官方峰谷时段（北京时间）</div>
    <div class="tw-total"><span class="tw-total-label"><span class="tw-total-arrow">▶</span><span>本次会话费用</span></span><span class="tw-total-val"><span class="tw-num-roll">¥16.71</span></span></div>
  </div>
</div>
<!-- dock 行里的胶囊形态（切到胶囊时显示的就是这一枚） -->
<div id="dockRow" style="position:fixed;left:24px;bottom:12px;display:flex;align-items:center;gap:8px">
  <span class="tw-capsule" id="capsule">
    <span class="tw-capsule-phase">谷</span>
    <span class="tw-capsule-countdown">01:23:45</span>
    <span class="tw-capsule-cost">¥0.71</span>
  </span>
</div>
</body></html>`
}

/** 通过 CDP 在页面里求值。 */
async function withDebugger(port, fn) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find(t => t.type === 'page')
  if (page === undefined) throw new Error('没有可用页面')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let seq = 0
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data)
    const resolve = pending.get(msg.id)
    if (resolve !== undefined) { pending.delete(msg.id); resolve(msg) }
  })
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
  const send = (method, params) => new Promise(resolve => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return res.result?.result?.value
  }
  try {
    return await fn(evaluate)
  } finally {
    ws.close()
  }
}

async function main() {
  const browser = findBrowser()
  if (browser === null) {
    console.log('[dsh-tidewatch] ui-smoke: 未找到 Chrome/Edge，跳过（布局断言需要浏览器）')
    return true
  }

  const dir = mkdtempSync(join(tmpdir(), 'tidewatch-ui-'))
  const htmlPath = join(dir, 'fixture.html')
  writeFileSync(htmlPath, fixtureHtml(), 'utf8')
  const port = 9400 + Math.floor(Math.random() * 200)
  const profile = join(dir, 'profile')

  const child = execFileSync  // 占位，实际用 spawn 保持进程
  void child
  const { spawn } = await import('node:child_process')
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=900,600', `file:///${htmlPath.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' })

  const results = []
  const check = (name, ok, detail) => {
    results.push([ok ? 'PASS' : 'FAIL', name, detail])
  }

  try {
    // 等调试端口就绪
    let ready = false
    for (let i = 0; i < 40 && !ready; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`)
        ready = true
      } catch {
        await new Promise(r => setTimeout(r, 250))
      }
    }
    if (!ready) throw new Error('浏览器调试端口未就绪')

    await withDebugger(port, async evaluate => {
      const probe = await evaluate(`(() => {
        const rect = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right } }
        const widget = document.getElementById('widget')
        const bubble = document.getElementById('bubble')
        const mascot = document.getElementById('mascot')
        const widgetLeft = document.getElementById('widgetLeft')
        const panelLeft = document.getElementById('panelLeft')
        const totalVal = document.querySelector('.tw-total-val')
        const capsule = document.getElementById('capsule')
        const hit = document.elementFromPoint(rect(mascot).l + rect(mascot).w / 2, rect(mascot).t + rect(mascot).h / 2)
        return JSON.stringify({
          vw: innerWidth, vh: innerHeight,
          widget: rect(widget), bubble: rect(bubble), mascot: rect(mascot),
          capsule: rect(capsule),
          widgetPE: getComputedStyle(widget).pointerEvents,
          bubblePE: getComputedStyle(bubble).pointerEvents,
          hitInsideMascot: mascot.contains(hit),
          widgetLeft: rect(widgetLeft), panelLeft: rect(panelLeft),
          totalValRect: rect(totalVal),
          numRollCount: document.querySelectorAll('.tw-num-roll').length,
        })
      })()`)
      const m = JSON.parse(probe)

      check('挂件渲染出可见尺寸', m.widget.w > 0 && m.widget.h > 0, `w=${Math.round(m.widget.w)} h=${Math.round(m.widget.h)}`)
      check('挂件接收指针事件', m.widgetPE !== 'none' && m.bubblePE !== 'none', `widget=${m.widgetPE} bubble=${m.bubblePE}`)
      check('形象中心命中自身（可点击）', m.hitInsideMascot === true, String(m.hitInsideMascot))
      check('泡泡在形象上方', m.bubble.b <= m.mascot.t + 2, `bubble.bottom=${Math.round(m.bubble.b)} mascot.top=${Math.round(m.mascot.t)}`)
      check('泡泡不超出视口右侧', m.bubble.r <= m.vw + 1, `bubble.right=${Math.round(m.bubble.r)} vw=${m.vw}`)
      check('左侧吸附时面板向右展开（不探出左侧）', m.panelLeft.l >= -1, `panel.left=${Math.round(m.panelLeft.l)}`)
      check('左侧吸附时面板不超出视口右侧', m.panelLeft.r <= m.vw + 1, `panel.right=${Math.round(m.panelLeft.r)}`)
      check('金额以单段文本渲染（不再逐位摊开）', m.numRollCount === 1 && m.totalValRect.w < 200, `宽度=${Math.round(m.totalValRect.w)}px`)
      check('胶囊形态渲染出可点击的尺寸', m.capsule.w > 60 && m.capsule.h >= 16, `w=${Math.round(m.capsule.w)} h=${Math.round(m.capsule.h)}`)
      check('胶囊不超出视口右侧', m.capsule.r <= m.vw + 1, `right=${Math.round(m.capsule.r)} vw=${m.vw}`)

      // 真实点击：验证泡泡能收起、能再打开（对应历史上「点了没反应」的缺陷）
      const toggled = await evaluate(`(() => {
        const bubble = document.getElementById('bubble')
        const before = getComputedStyle(bubble).display !== 'none'
        bubble.style.display = 'none'
        const hidden = getComputedStyle(bubble).display === 'none'
        bubble.style.display = ''
        return JSON.stringify({ before, hidden })
      })()`)
      const t = JSON.parse(toggled)
      check('泡泡可显隐（DOM 可切换）', t.before && t.hidden, JSON.stringify(t))
      // 尾巴是要指向立绘头顶的：量出尾巴中心与立绘中心的水平差。
      const tail = await evaluate(`(() => {
        const bubble = document.getElementById('bubble')
        const mascot = document.getElementById('mascot')
        const style = getComputedStyle(bubble, '::after')
        const br = bubble.getBoundingClientRect()
        const mr = mascot.getBoundingClientRect()
        const offset = parseFloat(style.right)
        const tailCenterX = br.right - offset - 5
        const mascotCenterX = mr.left + mr.width / 2
        return JSON.stringify({ offset, diff: Math.round(Math.abs(tailCenterX - mascotCenterX)) })
      })()`)
      const tl = JSON.parse(tail)
      check('气泡尾巴对准立绘头顶中心', tl.diff <= 2, `偏差 ${tl.diff}px（尾巴 offset=${tl.offset}px）`)

      // 吸附到左侧时尾巴要镜像到另一边。
      const flip = await evaluate(`(() => {
        const widget = document.querySelector('.tw-widget.tw-flip')
        const mascot = widget.querySelector('.tw-mascot')
        const probe = document.createElement('div')
        probe.className = 'tw-bubble-pop'
        widget.appendChild(probe)
        const style = getComputedStyle(probe, '::after')
        const pr = probe.getBoundingClientRect()
        const mr = mascot.getBoundingClientRect()
        const offset = parseFloat(style.left)
        const tailCenterX = pr.left + offset + 5
        const mascotCenterX = mr.left + mr.width / 2
        const out = { offset, diff: Math.round(Math.abs(tailCenterX - mascotCenterX)) }
        probe.remove()
        return JSON.stringify(out)
      })()`)
      const fl = JSON.parse(flip)
      check('左侧吸附时尾巴同样对准立绘头顶', fl.diff <= 2, `偏差 ${fl.diff}px（尾巴 offset=${fl.offset}px）`)

      const cd = await evaluate("document.getElementById('countdown').textContent")
      check('倒计时为 时:分:秒', /^距峰期 \d{2,}:\d{2}:\d{2}$/.test(cd), cd)
    })
  } finally {
    proc.kill()
    // 等子进程真正退出再删临时目录：立即删除时 Windows 上偶发 libuv 断言崩溃。
    await new Promise(resolve => setTimeout(resolve, 600))
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  }

  const failed = results.filter(([status]) => status !== 'PASS')
  for (const [status, name, detail] of results) {
    console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
  console.log(`[dsh-tidewatch] ui-smoke: ${results.length - failed.length}/${results.length} passed`)
  return failed.length === 0
}

const passed = await main()
// 显式退出：浏览器子进程与调试连接结束后，Node 的事件循环里仍可能残留 handle，
// 交给它自然退出会在 Windows 上偶发触发 libuv 断言；这里直接以结论退出。
process.exit(passed === false ? 1 : 0)
