/**
 * dsh-tidewatch 浏览器端 bundle（单文件，经 __ModuleLoader__ 加载）。
 *
 * 提供一张「峰谷时刻」悬浮徽章：fixed 悬浮在输入框右侧、与输入框卡片
 * 垂直居中对齐（自研锚定测量，不依赖任何其他插件）；窄窗口放不下时
 * 自动移到输入框上方，绝不遮挡输入框与下方的官方统计栏。视觉为
 * 浮动胶囊风格，与同层其他悬浮组件互不重叠。
 *
 *  - 折叠态：状态点（峰=橙红 / 谷=蓝绿）+ 当前档位 + 距下一阶段倒计时
 *    （小时:分钟，展开态提供秒级精度）+ 本次会话花费（¥，2 位小数）；
 *  - 展开态：官方峰谷时段表（北京时间）、当前档位价格、Token 明细
 *    （输入/缓存/输出/推理）与币种切换。
 *
 * 架构：双组件数据桥——
 *  - Probe（session 作用域插槽 conversation.composer.dock，渲染 null）：
 *    经 useProjection('costUsage') 订阅会话投影，写入模块级 bridge store；
 *  - TideCard（根级插槽 shell.overlay）：订阅 bridge 渲染悬浮徽章。
 *  （root 级插槽无 useProjection 席位，故需桥接。）
 *
 * 计价与显示：后端按官方美元价计费；前端以固定汇率 6.82（官方人民币
 * 标价与美元标价的隐含汇率）换算人民币显示，默认人民币、2 位小数；
 * 可切换美元显示、4 位小数。币种选择存 localStorage，仅影响显示。
 * 样式全部使用 --dsw-* 主题变量，跟随全局亮/暗主题。
 * 峰谷窗口/价格表常量与 lib/pricing.js 保持同步（官方 2026-08-17 峰谷定价）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-tidewatch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useRef } = React
    const el = React.createElement

    // ── 常量：官方峰谷窗口（UTC 小时，半开区间）与价格表（美元/1M tokens）──

    const PEAK_WINDOWS = [
      { start: 1, end: 4 },
      { start: 6, end: 10 },
    ]

    const DISPLAY_PRICES = {
      'deepseek-v4-flash': {
        label: 'V4-Flash',
        offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
        peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
      },
      'deepseek-v4-pro': {
        label: 'V4-Pro',
        offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
        peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      },
    }

    // 北京时间时段表（北京 = UTC+8，无夏令时）。
    const BEIJING_SLOTS = [
      { start: '09:00', end: '12:00', phase: 'peak', text: '峰' },
      { start: '12:00', end: '14:00', phase: 'offpeak', text: '谷' },
      { start: '14:00', end: '18:00', phase: 'peak', text: '峰' },
      { start: '18:00', end: '次日 09:00', phase: 'offpeak', text: '谷' },
    ]

    /** 固定汇率：官方人民币标价与美元标价的隐含汇率（¥4.50 ÷ $0.66 ≈ 6.82）。 */
    const FIXED_FX = 6.82
    const CURRENCY_KEY = 'dsh-tidewatch:currency'
    const EXPANDED_KEY = 'dsh-tidewatch:expanded'

    // ── 数据桥：会话投影 → 悬浮层（root 插槽无 useProjection 席位）──────────

    const bridge = {
      value: null,
      listeners: new Set(),
      set(value) {
        this.value = value
        for (const fn of [...this.listeners]) fn(value)
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
    }

    // ── 纯函数：峰谷判定 / 倒计时 / 格式化 ──────────────────────────────────

    function isPeakHourUTC(atMs) {
      const hour = new Date(atMs).getUTCHours()
      return PEAK_WINDOWS.some(w => hour >= w.start && hour < w.end)
    }

    /** 当前相位与下一次切换点（UTC）。 */
    function nextPhase(atMs) {
      const hourAt = (dayOffset, hour) => {
        const d = new Date(atMs)
        d.setUTCDate(d.getUTCDate() + dayOffset)
        d.setUTCHours(hour, 0, 0, 0)
        return d.getTime()
      }
      const points = []
      for (let day = -1; day <= 1; day += 1) {
        for (const w of PEAK_WINDOWS) {
          points.push({ at: hourAt(day, w.start), intoPeak: true })
          points.push({ at: hourAt(w.end <= w.start ? day + 1 : day, w.end), intoPeak: false })
        }
      }
      const inPeak = isPeakHourUTC(atMs)
      let prev = null
      let next = null
      for (const p of points) {
        if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p
        if (p.at > atMs && (next === null || next.at < next.at)) next = p
      }
      if (prev === null || next === null) return null
      return { inPeak, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
    }

    function fmtCountdown(ms) {
      const s = Math.max(0, Math.floor(ms / 1000))
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const sec = s % 60
      const p = n => String(n).padStart(2, '0')
      return p(h) + ':' + p(m) + ':' + p(sec)
    }

    /** 折叠态倒计时：小时:分钟（向上取整，避免每秒闪动；秒级精度在展开态提供）。 */
    function fmtCountdownShort(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000))
      const h = Math.floor(total / 3600)
      const m = Math.ceil((total % 3600) / 60)
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
    }

    /** 金额显示：人民币 2 位小数（× 固定汇率），美元 4 位小数（原始值）。 */
    function fmtMoney(usd, currency) {
      return currency === 'usd' ? '$' + usd.toFixed(4) : '¥' + (usd * FIXED_FX).toFixed(2)
    }

    function fmtTokens(n) {
      n = Math.max(0, Math.round(Number(n) || 0))
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K'
      if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'
      return String(n)
    }

    /** 模型名归一化匹配（与 lib/pricing.js 一致）。 */
    function priceEntryForModel(model) {
      const normalize = s => String(s ?? '').toLowerCase().replace(/[\s\-_.()（）]/g, '')
      const id = normalize(model)
      if (id.length > 0 && Object.prototype.hasOwnProperty.call(DISPLAY_PRICES, id)) return id
      for (const key of Object.keys(DISPLAY_PRICES)) {
        if (id.includes(normalize(key))) return key
      }
      return 'deepseek-v4-flash'
    }

    function beijingSlotIndex(atMs) {
      const h = (new Date(atMs).getUTCHours() + 8) % 24
      if (h >= 9 && h < 12) return 0
      if (h >= 12 && h < 14) return 1
      if (h >= 14 && h < 18) return 2
      return 3
    }

    function loadCurrency() {
      try {
        const v = localStorage.getItem(CURRENCY_KEY)
        if (v === 'usd' || v === 'cny') return v
      } catch { /* ignore */ }
      return 'cny'
    }

    // ── 样式（--dsw-* 主题变量，跟随亮/暗主题）─────────────────────────────

    const CSS_TAG_ID = 'dsh-tidewatch'
    const css = [
      '/* dsh-tidewatch: 峰谷时刻悬浮徽章 */',
      '.tw-root{position:fixed;z-index:1001;pointer-events:auto}',
      '.tw-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,var(--dsw-alias-border-l1,#444));background:var(--dsw-alias-button-floating-fill,var(--dsw-alias-bg-layer-2,#222));color:var(--dsw-alias-label-secondary,#8b8b8b);font-size:11px;line-height:24px;white-space:nowrap;cursor:pointer;user-select:none;box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.2));transition:background .15s ease,border-color .15s ease}',
      '.tw-chip:hover{background:var(--dsw-alias-button-floating-hover,var(--dsw-alias-bg-layer-2,#222));border-color:var(--dsw-alias-border-l3,#666)}',
      '.tw-dot{flex:none;width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 4px color-mix(in srgb,currentColor 18%,transparent)}',
      '.tw-chip.peak .tw-dot{background:var(--dsw-alias-state-warn-primary,#f59e0b);color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.tw-chip.offpeak .tw-dot{background:var(--dsw-alias-state-success-primary,#10b981);color:var(--dsw-alias-state-success-primary,#10b981)}',
      '.tw-phase{font-weight:600;font-variant-numeric:tabular-nums}',
      '.tw-chip.peak .tw-phase{color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.tw-chip.offpeak .tw-phase{color:var(--dsw-alias-state-success-primary,#10b981)}',
      '.tw-countdown{font-variant-numeric:tabular-nums}',
      '.tw-sep{flex:none;width:1px;height:12px;background:var(--dsw-alias-border-l1,#444)}',
      '.tw-cost{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8);font-variant-numeric:tabular-nums}',
      '.tw-panel{position:absolute;right:0;bottom:calc(100% + 10px);z-index:1002;width:320px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:12px 14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1,#444));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#1f1f1f));box-shadow:var(--dsw-shadow-lv2,0 14px 36px rgba(0,0,0,.24));font-size:12px;color:var(--dsw-alias-label-primary,#e8e8e8);text-align:left;white-space:normal}',
      '.tw-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}',
      '.tw-panel-phase{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:700}',
      '.tw-panel-phase .tw-dot{width:10px;height:10px}',
      '.tw-panel-phase.peak{color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.tw-panel-phase.offpeak{color:var(--dsw-alias-state-success-primary,#10b981)}',
      '.tw-panel-countdown{font-size:12px;color:var(--dsw-alias-label-tertiary,#9b9b9b);font-variant-numeric:tabular-nums}',
      '.tw-h{font-size:11px;font-weight:600;letter-spacing:.3px;color:var(--dsw-alias-label-tertiary,#9b9b9b);margin:10px 0 6px}',
      '.tw-h:first-of-type{margin-top:0}',
      '.tw-slots{display:flex;flex-direction:column;gap:3px}',
      '.tw-slot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 8px;border-radius:7px;font-variant-numeric:tabular-nums}',
      '.tw-slot.now{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.tw-slot .tw-slot-time{color:var(--dsw-alias-label-secondary,#c5c5c5)}',
      '.tw-slot .tw-slot-tag{flex:none;min-width:30px;text-align:center;font-weight:600;border-radius:999px;padding:0 8px;font-size:11px;line-height:18px}',
      '.tw-slot .tw-slot-tag.peak{color:var(--dsw-alias-state-warn-primary,#f59e0b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent)}',
      '.tw-slot .tw-slot-tag.offpeak{color:var(--dsw-alias-state-success-primary,#10b981);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 14%,transparent)}',
      '.tw-slot-now-tip{margin-left:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '.tw-prices{display:flex;flex-direction:column;gap:3px;font-variant-numeric:tabular-nums}',
      '.tw-price-row{display:flex;justify-content:space-between;gap:8px;padding:3px 8px}',
      '.tw-price-row .tw-price-label{color:var(--dsw-alias-label-secondary,#c5c5c5)}',
      '.tw-price-row .tw-price-val{color:var(--dsw-alias-label-primary,#e8e8e8);font-weight:600}',
      '.tw-tokens{display:grid;grid-template-columns:1fr 1fr;gap:3px 12px;font-variant-numeric:tabular-nums}',
      '.tw-token-row{display:flex;justify-content:space-between;gap:8px;padding:3px 8px}',
      '.tw-token-row .tw-token-label{color:var(--dsw-alias-label-secondary,#c5c5c5)}',
      '.tw-token-row .tw-token-val{color:var(--dsw-alias-label-primary,#e8e8e8);font-weight:600}',
      '.tw-total{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,#444)}',
      '.tw-total-label{font-size:12px;color:var(--dsw-alias-label-secondary,#c5c5c5)}',
      '.tw-total-val{font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary,#e8e8e8);font-variant-numeric:tabular-nums}',
      '.tw-currency{display:flex;align-items:center;gap:6px;margin-top:8px;padding:0 2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '.tw-currency-btn{font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary,#c5c5c5);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,#444);border-radius:6px;padding:1px 10px;cursor:pointer;line-height:18px}',
      '.tw-currency-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.tw-currency-btn.on{color:var(--dsw-alias-label-primary,#e8e8e8);border-color:var(--dsw-alias-state-business-primary,#4d9fff)}',
      '.tw-empty-note{padding:3px 8px;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
    ].join('\n')

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', CSS_TAG_ID)
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ── 悬浮定位：锚定输入框右侧、与卡片垂直居中；放不下移到输入框上方 ──────

    function usePlacement(rootRef) {
      const [pos, setPos] = useState({ right: 16, bottom: 96 })
      useEffect(() => {
        let raf = 0
        function setPosIfChanged(next) {
          setPos(prev => (prev.right === next.right && prev.bottom === next.bottom ? prev : next))
        }
        function measure() {
          cancelAnimationFrame(raf)
          raf = requestAnimationFrame(() => {
            const card = document.querySelector('[data-composer-card]')
            const GAP = 12
            const EDGE = 16
            const W = rootRef.current !== null ? rootRef.current.offsetWidth : 200
            const H = rootRef.current !== null ? rootRef.current.offsetHeight : 24
            if (!card) { setPosIfChanged({ right: EDGE, bottom: 96 }); return }
            const r = card.getBoundingClientRect()
            // 徽章左缘 = 卡片右缘 + GAP，即 right 必须同时减去 GAP 与徽章宽度 W：
            // 只对齐右缘会让宽 200px 的徽章向左展开、侵入输入框卡片内部
            // （此前「全屏下挡输入框区域」的根因）。
            const right = window.innerWidth - r.right - GAP - W
            // 徽章与输入框卡片垂直居中对齐：卡片中心高度就是徽章中心高度。
            // 官方统计栏渲染在卡片下方（conversation.composer.dock），徽章整体
            // 落在卡片垂直范围内，既不会压统计栏，也不遮挡输入框/发送按钮。
            const centerY = r.top + r.height / 2
            const verticalOK = H <= r.height + 1
              && centerY - H / 2 >= EDGE
              && centerY + H / 2 <= window.innerHeight - EDGE
            if (right >= EDGE && verticalOK) {
              // 水平放得下且垂直居中后徽章仍在视口内：贴卡片右侧、垂直居中
              // （不与同层其他悬浮组件重叠）。bottom = 视口高 - 徽章底边 y，
              // 徽章底边 y = 卡片中心 + 徽章半高。
              setPosIfChanged({ right, bottom: window.innerHeight - centerY - H / 2 })
            } else {
              // 放不下：移到输入框上方、贴视口右缘——不与同层其他悬浮组件
              // 的常见兜底位置（视口左侧）重叠，也不遮挡输入框。
              setPosIfChanged({ right: EDGE, bottom: Math.max(EDGE, window.innerHeight - r.top + GAP) })
            }
          })
        }
        measure()
        window.addEventListener('resize', measure)
        const ro = new ResizeObserver(measure)
        const overlayEl = document.querySelector('[data-shell-overlay]')
        const frameEl = overlayEl && overlayEl.parentElement
        if (frameEl && frameEl.firstElementChild) ro.observe(frameEl.firstElementChild)
        const mo = new MutationObserver(measure)
        mo.observe(document.body, { childList: true, subtree: true })
        return () => {
          cancelAnimationFrame(raf)
          window.removeEventListener('resize', measure)
          ro.disconnect()
          mo.disconnect()
        }
      }, [])
      return pos
    }

    // ── 数据探针（session 插槽）：订阅投影写入 bridge，渲染 null ────────────

    function Probe(props) {
      const usage = props.useProjection ? props.useProjection('costUsage') : undefined
      // 依赖 usage：投影值不变（引用稳定）时不重复写 bridge，避免无谓广播。
      useEffect(() => {
        bridge.set(usage ?? null)
      }, [usage])
      return null
    }

    // ── 悬浮徽章（shell.overlay）：订阅 bridge 渲染 ─────────────────────────

    function TideCard() {
      const [usage, setUsage] = useState(bridge.value)
      const [now, setNow] = useState(() => Date.now())
      const [expanded, setExpanded] = useState(() => {
        try { return localStorage.getItem(EXPANDED_KEY) === '1' } catch { return false }
      })
      const [currency, setCurrency] = useState(loadCurrency)
      const rootRef = useRef(null)

      useEffect(() => bridge.subscribe(setUsage), [])
      useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
      }, [])
      useEffect(() => {
        if (!expanded) return
        const onDown = e => {
          if (rootRef.current !== null && !rootRef.current.contains(e.target)) setExpanded(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [expanded])

      const pos = usePlacement(rootRef)
      const phase = nextPhase(now)
      const countdown = phase === null ? 0 : Math.max(0, phase.nextAtMs - now)
      const nextLabel = phase === null ? '下一阶段' : (phase.nextIntoPeak ? '峰期' : '谷期')
      const costUsd = Number(usage?.cost) || 0

      const toggle = () => {
        const v = !expanded
        setExpanded(v)
        try { localStorage.setItem(EXPANDED_KEY, v ? '1' : '0') } catch { /* ignore */ }
      }

      const setCurrencyPersist = next => {
        setCurrency(next)
        try { localStorage.setItem(CURRENCY_KEY, next) } catch { /* ignore */ }
      }

      // 当前模型：优先取投影 view 的 model（会话正在使用的模型，实时跟随
      // request/header 更新）；无请求历史时回退 byModel 首键，再无则 flash。
      const modelKeys = usage?.byModel !== undefined ? Object.keys(usage.byModel) : []
      const activeModel = typeof usage?.model === 'string' && usage.model.length > 0 ? usage.model : (modelKeys[0] ?? 'deepseek-v4-flash')
      const modelKey = priceEntryForModel(activeModel)
      const price = DISPLAY_PRICES[modelKey]
      const tier = (phase !== null && phase.inPeak) ? price.peak : price.offPeak
      const slotIdx = beijingSlotIndex(now)
      const input = Number(usage?.input) || 0
      const cache = (Number(usage?.cacheRead) || 0) + (Number(usage?.cacheWrite) || 0)
      const output = Number(usage?.output) || 0
      const reasoning = Number(usage?.reasoning) || 0

      return el('div', { ref: rootRef, className: 'tw-root', style: { right: pos.right, bottom: pos.bottom } },
        el('button', {
          className: 'tw-chip ' + (phase !== null && phase.inPeak ? 'peak' : 'offpeak') + (expanded ? ' open' : ''),
          onClick: toggle,
          title: '点击展开 / 收起峰谷详情',
        },
          el('span', { className: 'tw-dot' }),
          el('span', { className: 'tw-phase' }, phase !== null && phase.inPeak ? '峰期' : '谷期'),
          el('span', { className: 'tw-countdown' }, '距' + nextLabel + ' ' + fmtCountdownShort(countdown)),
          el('span', { className: 'tw-sep' }),
          el('span', { className: 'tw-cost' }, fmtMoney(costUsd, currency))),
        expanded ? el('div', { className: 'tw-panel' },
          // 头部：当前档位 + 倒计时
          el('div', { className: 'tw-panel-head' },
            el('span', { className: 'tw-panel-phase ' + (phase !== null && phase.inPeak ? 'peak' : 'offpeak') },
              el('span', { className: 'tw-dot' }),
              el('span', null, phase !== null && phase.inPeak ? '峰期进行中' : '谷期进行中')),
            el('span', { className: 'tw-panel-countdown' }, '距' + nextLabel + ' ' + fmtCountdown(countdown))),
          // 峰谷时段表（北京时间）
          el('div', { className: 'tw-h' }, '官方峰谷时段（北京时间）'),
          el('div', { className: 'tw-slots' },
            BEIJING_SLOTS.map((slot, i) => el('div', {
              key: slot.start + slot.end,
              className: 'tw-slot' + (i === slotIdx ? ' now' : ''),
            },
              el('span', { className: 'tw-slot-time' }, slot.start + ' – ' + slot.end),
              el('span', null,
                i === slotIdx ? el('span', { className: 'tw-slot-now-tip' }, '现在') : null,
                el('span', { className: 'tw-slot-tag ' + slot.phase }, slot.text))))),
          // 当前档位价格
          el('div', { className: 'tw-h' }, '当前档位 · ' + price.label + '（' + (phase !== null && phase.inPeak ? '峰时' : '谷时') + '）'),
          el('div', { className: 'tw-prices' },
            el('div', { className: 'tw-price-row' },
              el('span', { className: 'tw-price-label' }, '输入 · 未命中 / 缓存'),
              el('span', { className: 'tw-price-val' }, fmtMoney(tier.cacheMiss, currency) + ' / ' + fmtMoney(tier.cacheHit, currency) + ' /百万')),
            el('div', { className: 'tw-price-row' },
              el('span', { className: 'tw-price-label' }, '输出'),
              el('span', { className: 'tw-price-val' }, fmtMoney(tier.output, currency) + ' /百万'))),
          // Token 明细
          el('div', { className: 'tw-h' }, '本次会话 Token'),
          usage === undefined || (input + cache + output + reasoning) === 0
            ? el('div', { className: 'tw-empty-note' }, '会话尚无模型调用')
            : el('div', { className: 'tw-tokens' },
                el('div', { className: 'tw-token-row' },
                  el('span', { className: 'tw-token-label' }, '输入'),
                  el('span', { className: 'tw-token-val' }, fmtTokens(input))),
                el('div', { className: 'tw-token-row' },
                  el('span', { className: 'tw-token-label' }, '缓存(读+写)'),
                  el('span', { className: 'tw-token-val' }, fmtTokens(cache))),
                el('div', { className: 'tw-token-row' },
                  el('span', { className: 'tw-token-label' }, '输出'),
                  el('span', { className: 'tw-token-val' }, fmtTokens(output))),
                reasoning > 0 ? el('div', { className: 'tw-token-row' },
                  el('span', { className: 'tw-token-label' }, '推理'),
                  el('span', { className: 'tw-token-val' }, fmtTokens(reasoning))) : null),
          // 本次会话费用 + 币种切换
          el('div', { className: 'tw-total' },
            el('span', { className: 'tw-total-label' }, '本次会话费用'),
            el('span', { className: 'tw-total-val' }, fmtMoney(costUsd, currency))),
          el('div', { className: 'tw-currency' },
            el('span', null, '币种'),
            el('button', { className: 'tw-currency-btn' + (currency === 'cny' ? ' on' : ''), onClick: () => setCurrencyPersist('cny') }, '¥ 人民币'),
            el('button', { className: 'tw-currency-btn' + (currency === 'usd' ? ' on' : ''), onClick: () => setCurrencyPersist('usd') }, '$ 美元')))
          : null)
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────

    // 无 RPC：仅 UI + 会话投影，无需贡献描述符。
    const CONTRIBUTION = { package: 'dsh-tidewatch', descriptors: [] }
    const inject = ['remote']

    async function apply(ctx) {
      try {
        const remote = ctx.remote
        if (remote !== undefined && typeof remote.$mount === 'function') {
          const unmount = await remote.$mount(CONTRIBUTION)
          ctx.effect(() => () => { unmount() }, 'dsh-tidewatch: contribution unmount')
        }
      } catch (error) {
        console.warn('[dsh-tidewatch] contribution mount skipped:', error)
      }
      const slots = ctx.get('slots')
      if (slots === undefined) {
        console.warn('[dsh-tidewatch] slots unavailable, tide card not mounted')
        return
      }
      // 数据探针：会话作用域插槽（提供 useProjection 席位），渲染 null。
      // 经 slots.inject 等待宿主声明，宿主声明不可用时自动卸载。
      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'dsh-tidewatch-probe', order: 100, inject: () => ({}) },
        Probe,
      ))
      // 悬浮徽章：根级框架悬浮层（fixed 定位，自研锚定测量，与其他插件零耦合）。
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'dsh-tidewatch', order: 101 },
        TideCard,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
