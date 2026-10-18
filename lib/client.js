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
 *    经 useProjection('costUsage') 订阅会话投影，写入模块级 bridge store，
 *    并登记本会话的归属声明（claims）；
 *  - TideCard（根级插槽 shell.overlay）：订阅 bridge 渲染悬浮徽章，只认
 *    「归属声明里最新的那个会话」，并做会话存活校验。
 *  （root 级插槽既无 useProjection 也无会话状态，故需桥接。）
 *
 * 归属判据（2026-09-27 修，DSH 0.1.7-rc.2 适配）：壳层从不把「当前会话」交给
 * root 插槽——useSessions 交给组件的是 SessionListState（ids / byId / phase /
 * projectionsBySession），其中没有 current 字段。旧代码用
 * props.useSessions(s => s.current) 取当前会话，恒得 undefined，于是归属校验
 * 永不成立、金额被强制置 null（卡片一直显示 ¥0.00）。现改由 session 作用域的
 * Probe 申报归属（它的 props.sessionId 即权威值），壳层只做「桥归属仍在会话
 * 列表里」的存活校验。
 *
 * 计费事件源（2026-09-27 修）：宿主投影只从 assistant/message 的 usage 计费。
 * assistant/chunk 在会话格式 v3 起已被折叠、现代 Harness 不再产生它，留着的
 * 分支是死代码；详见 lib/index.js 顶部说明。
 *
 * 计价与显示：后端按官方美元价计费；前端以固定汇率 6.67（官方人民币
 * 标价与美元标价的隐含汇率，2026-09-10 随 V4.1 Flash 新价调整）换算
 * 人民币显示，默认人民币、2 位小数；
 * 可切换美元显示、4 位小数。币种选择存 localStorage，仅影响显示。
 * 样式全部使用 --dsw-* 主题变量，跟随全局亮/暗主题。
 * 峰谷窗口/价格表/节假日表常量与 lib/pricing.js 保持同步（官方 2026-08-17
 * 峰谷定价；2026-09-10 V4.1 Flash 新价，旧名经别名表路由到新价；周末与
 * 法定节假日全天谷期，节假日表依据国办发明电〔2025〕7号 2026 年安排）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-tidewatch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useState, useEffect, useRef } = React
    const el = React.createElement
    // portal 用于把展开面板挂到 body；胶囊本身在 dock 插槽里行内渲染。
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch { /* 无 react-dom：保持浮动定位 */ }
    if (typeof createPortal !== 'function') createPortal = null

    // ── 官方 UI 原语（shell 共享模块表中的 baseline 模块）────────────────────
    // @deepseek-ai/dsh-client-ui-primitives 由 web shell 静态加载并冻结进模块表，
    // 插件 require 到的是同一个实例（不会引入第二份 React，也不必声明依赖）。
    // 老版 shell 的模块表没有这一条，require 会抛错；此时整体退回本文件的自研
    // 样式与逻辑，插件照常可用——兼容性不因采用原语而收窄。
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch { /* 老版 shell 无共享原语：走下方自研实现 */ }
    const PrimStateDot = primitives !== null && typeof primitives.StateDot === 'function' ? primitives.StateDot : null
    const PrimTag = primitives !== null && typeof primitives.Tag === 'function' ? primitives.Tag : null
    const PrimTooltip = primitives !== null && typeof primitives.Tooltip === 'function' ? primitives.Tooltip : null
    const primDismiss = primitives !== null && typeof primitives.useDismissOnOutsidePointer === 'function'
      ? primitives.useDismissOnOutsidePointer
      : null

    /**
     * 状态点：官方 StateDot（峰=warning 琥珀 / 谷=done 绿 / 不适用=idle 灰，
     * 自带 aria-hidden）；原语不可用时退回自研 span.tw-dot。
     * @param inPeak - 是否峰期（state 未指定时据此选色）。
     * @param size - 直径（px）。
     * @param state - 显式状态；非 DeepSeek 模型传 'idle'。
     */
    function PhaseDot({ inPeak, size, state }) {
      if (PrimStateDot !== null) return el(PrimStateDot, { state: state ?? (inPeak ? 'warning' : 'done'), size })
      return el('span', { className: 'tw-dot' })
    }

    /**
     * 只读胶囊标签：官方 Tag（峰=warning / 谷=success / 模型=outline）；
     * 原语不可用时退回自研样式类。
     */
    function PhaseTag({ tone, fallbackClass, children }) {
      if (PrimTag !== null) return el(PrimTag, { tone }, children)
      return el('span', { className: fallbackClass }, children)
    }

    /**
     * 悬浮提示：官方 Tooltip（clone 锚元素，气泡可自适应视口）；
     * 原语不可用时给锚元素补一个原生 title。
     */
    function Tip({ label, node }) {
      if (PrimTooltip !== null) return el(PrimTooltip, { label, side: 'top' }, node)
      return React.cloneElement(node, { title: label })
    }

    /** 外点关闭：官方 hook 不可用时的同签名自研实现（mousedown + 包含判断）。 */
    function useFallbackDismiss(root, open, setOpen) {
      useEffect(() => {
        if (!open) return
        const onDown = e => {
          if (root.current !== null && !root.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [root, open, setOpen])
    }
    const useDismissOutside = primDismiss !== null ? primDismiss : useFallbackDismiss

    // ── 常量：官方峰谷窗口（UTC 小时，半开区间）与价格表（美元/1M tokens）──

    const PEAK_WINDOWS = [
      { start: 1, end: 4 },
      { start: 6, end: 10 },
    ]

    // 中国法定节假日表（北京时间自然日；国办发明电〔2025〕7号 2026 年安排，
    // 共 33 天）。官方口径（中文定价页 2026-10-10 核对）：高峰时段为北京时间
    // 周一至周五（不含中国法定节假日）；其余时段，包括周末及法定节假日全天均
    // 为空闲时段。官方 2026-09-19 另说明：调休上班的周末、中国法定节假日全天
    // 均按空闲时段计费——调休上班的周末仍按周末=谷期处理。
    // 2027 年安排发布后需与 lib/pricing.js 同步本表。
    const CN_PUBLIC_HOLIDAYS = new Set([
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
    ])

    /** 北京时区偏移（UTC+8，无夏令时；与 lib/pricing.js 的 BEIJING_OFFSET_MS 一致）。 */
    const BEIJING_OFFSET_MS = 8 * 3600 * 1000

    /**
     * 展示用价格表：美元数字与官方英文定价页一致（也是计费基准），rmb 为官方
     * 中文定价页数字（2026-10-10 核对）。人民币模式原样展示 rmb，美元模式换算；
     * 只有 offPeak / peak 两档会被展示，历史档不参与界面。
     */
    const DISPLAY_PRICES = {
      'deepseek-flash': {
        label: 'V4.1-Flash',
        offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
        peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
        rmb: {
          offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
          peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
        },
      },
      'deepseek-v4-pro': {
        label: 'V4-Pro',
        offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
        peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
        rmb: {
          offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
          peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
        },
      },
    }

    // 北京时间时段表（北京 = UTC+8，无夏令时）。周末（2026-08-23 00:00 北京起）
    // 与中国法定节假日、调休上班的周末全天按谷期计价（官方 2026-09-19 说明）。
    const BEIJING_SLOTS = [
      { start: '09:00', end: '12:00', phase: 'peak', text: '峰' },
      { start: '12:00', end: '14:00', phase: 'offpeak', text: '谷' },
      { start: '14:00', end: '18:00', phase: 'peak', text: '峰' },
      { start: '18:00', end: '次日 09:00', phase: 'offpeak', text: '谷' },
    ]
    /**
     * 周末判定：周几按北京时间自然日取（与官网中文页「北京时间周一至周五」一致）。
     * 当前窗口取值下与「UTC 周一至周五」等价（见 lib/pricing.js 文件头说明）；
     * 调休上班的周末照旧算周末（官方 2026-09-19 说明），故本表不含调休上班日。
     */
    function isWeekend(atMs) {
      const day = new Date(atMs + BEIJING_OFFSET_MS).getUTCDay()
      return day === 0 || day === 6
    }
    /** 北京时间自然日（YYYY-MM-DD）。 */
    function beijingDateString(atMs) {
      return new Date(atMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
    }
    /** 法定节假日判定（按北京自然日；用于区分面板提示行文案，不设生效时间）。 */
    function isCnHolidayAt(atMs) {
      return CN_PUBLIC_HOLIDAYS.has(beijingDateString(atMs))
    }
    /** 全天谷期判定：周末或法定节假日（与 lib/pricing.js 的 isAllDayOffPeak 一致）。 */
    function isAllDayOffPeakAt(atMs) {
      if (isWeekend(atMs)) return true
      return isCnHolidayAt(atMs)
    }

    /**
     * 展示用美元换算汇率（仅用于「USD」显示模式把人民币数字折成美元，以及
     * 无官方人民币数字时的兜底）。人民币模式直接展示价格条目里的官方 rmb 数字，
     * 不做换算——官网中文页按模型各自取整（flash 隐含 6.67、pro 6.82），
     * 统一汇率会让 pro 的元数字比官网低约 2%。
     */
    const FIXED_FX = 6.67
    /**
     * V4 Pro 换价时刻（哨兵值 = 未有生效日期）。官方定价页脚注(2)与更新日志
     * （2026-09-10）声明：2026-09-14 之后继续提供 V4 Pro 服务、计费方式不变，
     * 如有变动另行通知。故保持哨兵值，pro 恒按自身价目展示（与 pricing.js 对称）。
     */
    const V4_PRO_RETIRE_AT = Date.parse('9999-12-31T00:00:00Z')
    const CURRENCY_KEY = 'dsh-tidewatch:currency'
    const EXPANDED_KEY = 'dsh-tidewatch:expanded'

    // ── 数据桥：会话投影 → 悬浮层（root 插槽无 useProjection 席位）──────────

    /**
     * 归属声明：同一时刻每条活跃 Probe 报上自己的会话，最新报到的那个会话
     * 独占这张卡（这就是「当前会话」的判据）。
     *
     * 为什么不问框架：壳层从不把「当前会话」交给 root 插槽——useSessions 给的
     * state 是 SessionListState（ids / byId / phase / projectionsBySession），
     * 没有 current 这一项。「当前」在框架里是会话作用域的东西，作为 sessionId
     * 直接交给 session 作用域的组件。所以归属只能由会话侧自己申报：Probe 长在
     * conversation.composer.dock（session 作用域），它的 props.sessionId 就是
     * 权威答案，而 shell.overlay 拿不到会话状态。
     */
    const claims = new Set()
    /** 归属会话 id：最新报到的活跃会话；无活跃会话时 undefined。 */
    function currentSessionId() {
      return claims.size === 0 ? undefined : [...claims][claims.size - 1]
    }

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
      if (isAllDayOffPeakAt(atMs)) return false // 周末/法定节假日全天谷期
      const hour = new Date(atMs).getUTCHours()
      return PEAK_WINDOWS.some(w => hour >= w.start && hour < w.end)
    }

    /** 当前相位与下一次切换点（UTC）。全天谷期（周末/法定节假日）无切换点，
     *  下一时刻为下一个工作日首次进入峰时；收集范围前后各 14 天，覆盖春节
     *  9 天连休等最长连续段。 */
    function nextPhase(atMs) {
      const hourAt = (dayOffset, hour) => {
        const d = new Date(atMs)
        d.setUTCDate(d.getUTCDate() + dayOffset)
        d.setUTCHours(hour, 0, 0, 0)
        return d.getTime()
      }
      const points = []
      // 收集前后各 14 天：全天谷期的日子（周末/法定节假日）不产生窗口点，
      // 其 prev/next 落在相邻工作日。
      for (let day = -14; day <= 14; day += 1) {
        for (const w of PEAK_WINDOWS) {
          const startAt = hourAt(day, w.start)
          const endAt = hourAt(w.end <= w.start ? day + 1 : day, w.end)
          if (!isAllDayOffPeakAt(startAt)) points.push({ at: startAt, intoPeak: true })
          if (!isAllDayOffPeakAt(endAt)) points.push({ at: endAt, intoPeak: false })
        }
      }
      const inPeak = isPeakHourUTC(atMs)
      let prev = null
      let next = null
      for (const p of points) {
        if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p
        if (p.at > atMs && (next === null || p.at < next.at)) next = p
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

    /**
     * 折叠态倒计时：小时:分钟（向上取整，避免每秒闪动；秒级精度在展开态提供）。
     * 先向上取整到总分钟再拆分：对秒取模会让 59:59.x 进位成「00:60」而不是 01:00。
     */
    function fmtCountdownShort(ms) {
      const totalMin = Math.max(0, Math.ceil(ms / 60000))
      const h = Math.floor(totalMin / 60)
      const m = totalMin % 60
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
    }

    /** 金额显示：人民币 2 位小数（× 固定汇率），美元 4 位小数（原始值）。 */
    function fmtMoney(usd, currency) {
      return currency === 'usd' ? '$' + usd.toFixed(4) : '¥' + (usd * FIXED_FX).toFixed(2)
    }

    /**
     * 价目表金额显示：人民币模式取官方 rmb 数字原样展示，美元模式展示官方美元
     * 数字。两条路都直接落到官网数字，不做跨币种换算（官网中文页按模型各自取整，
     * 换算会引入偏差）。
     * @param usd - 该档的官方美元数字。
     * @param rmb - 该档的官方人民币数字。
     * @param digits - 展示小数位。
     * @param currency - 'cny' | 'usd'。
     */
    function fmtTierMoney(usd, rmb, digits, currency) {
      if (currency !== 'usd' && typeof rmb === 'number') return '¥' + rmb
      const v = currency === 'usd' ? usd : rmb
      return currency === 'usd' ? '$' + v.toFixed(digits) : '¥' + v.toFixed(digits)
    }

    function fmtTokens(n) {
      n = Math.max(0, Math.round(Number(n) || 0))
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K'
      if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'
      return String(n)
    }

    // ── 账户余额（宿主账户服务，官方通道）────────────────────────────────────

    /** 余额轮询间隔：可见时 30 秒；页面不可见时每 6 拍查一次（3 分钟）。 */
    const BALANCE_POLL_MS = 30000

    /**
     * 账户服务要的客户端版本号（不能为空）。优先取 DSH 注入的客户端版本，
     * 取不到时退回本插件版本 —— 与 package.json 的 version 保持一致。
     * @returns 版本字符串。
     */
    function clientVersion() {
      try {
        const injected = process.env === undefined ? undefined : process.env.DSH_CLIENT_VERSION
        if (typeof injected === 'string' && injected.length > 0) return injected
      } catch { /* 浏览器里没有 process：退回插件版本 */ }
      return '1.5.0'
    }

    /**
     * 钱包数组 → 按币种求和。跨币种不合并：符号不同的钱不能相加。
     * @param list - `[{ currency, balance }]`，balance 是十进制字符串。
     * @returns Map<币种, 金额>；输入无效时为空 Map。
     */
    function sumWallets(list) {
      const byCurrency = new Map()
      if (!Array.isArray(list)) return byCurrency
      for (const item of list) {
        const amount = Number(item === null || item === undefined ? NaN : item.balance)
        if (!Number.isFinite(amount)) continue
        const currency = typeof item.currency === 'string' && item.currency.length > 0 ? item.currency : 'CNY'
        byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount)
      }
      return byCurrency
    }

    /** 钱包合计的指纹：用来判断「数字有没有真的变过」，进而决定读数时刻是否刷新。 */
    function walletSignature(map) {
      return [...map.entries()].map(([cur, amount]) => cur + ':' + amount).sort().join('|')
    }

    /** 钱包金额文本：¥12.34 或 $5.00，多币种并列；空钱包显示破折号。 */
    function fmtWallets(map) {
      if (map === undefined || map.size === 0) return '—'
      return [...map.entries()]
        .map(([cur, amount]) => (cur === 'USD' ? '$' : '¥') + amount.toFixed(2))
        .join(' · ')
    }

    /** 时刻文本 HH:MM，用于说明余额读数的新鲜度。 */
    function clockOf(atMs) {
      if (!Number.isFinite(atMs)) return '—'
      const d = new Date(atMs)
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    // ── 数字滚动 / 音效 / 余额预警 ───────────────────────────────────────────

    const SOUND_KEY = 'dsh-tidewatch.sound'
    const ALERT_KEY = 'dsh-tidewatch.alert'
    /** 默认预警阈值（人民币元）；0 表示关闭。 */
    const DEFAULT_ALERT_CNY = 10

    /** 读布尔偏好，缺失时用 fallback。 */
    function loadFlag(key, fallback) {
      try {
        const raw = localStorage.getItem(key)
        return raw === null ? fallback : raw === '1'
      } catch { return fallback }
    }

    /** 存布尔偏好。 */
    function saveFlag(key, value) {
      try { localStorage.setItem(key, value ? '1' : '0') } catch { /* 隐私模式：忽略 */ }
    }

    /** 读预警阈值（元）；非数字或负数回落到默认值，0 表示关闭。 */
    function loadAlertThreshold() {
      try {
        const raw = Number(localStorage.getItem(ALERT_KEY))
        return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_ALERT_CNY
      } catch { return DEFAULT_ALERT_CNY }
    }

    /**
     * 合成提示音（WebAudio）。不依赖任何音频素材——零版权风险、零体积。
     * 浏览器的自动播放策略要求音频上下文由用户手势创建或恢复，故只在点击等
     * 真实手势里调用；拿不到音频能力时静默跳过，绝不影响功能。
     * @param kind - 'tap' 点击音；'alert' 预警音（下行两声）。
     */
    let audioCtx = null
    function playTone(kind) {
      try {
        const Ctor = window.AudioContext ?? window.webkitAudioContext
        if (typeof Ctor !== 'function') return
        audioCtx = audioCtx ?? new Ctor()
        if (audioCtx.state === 'suspended') void audioCtx.resume()
        const now = audioCtx.currentTime
        const beep = (at, from, to, vol) => {
          const osc = audioCtx.createOscillator()
          const gain = audioCtx.createGain()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(from, now + at)
          if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, now + at + 0.16)
          gain.gain.setValueAtTime(0.0001, now + at)
          gain.gain.exponentialRampToValueAtTime(vol, now + at + 0.012)
          gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.2)
          osc.connect(gain)
          gain.connect(audioCtx.destination)
          osc.start(now + at)
          osc.stop(now + at + 0.22)
        }
        if (kind === 'alert') {
          beep(0, 880, 660, 0.07)
          beep(0.16, 660, 495, 0.06)
        } else {
          beep(0, 1320, 1320, 0.05)
        }
      } catch { /* 无音频权限或被禁用：静默跳过 */ }
    }

    /**
     * 滚动的数字：按字符拆开，数字位纵向滚动到目标值，其余字符原样显示。
     * @param text - 数字文本（可含 ¥ / . / , 等非数字字符）。
     */
    function RollingNumber({ text }) {
      return el('span', { className: 'tw-roll-wrap' }, String(text).split('').map((ch, i) => (
        /[0-9]/.test(ch)
          ? el(RollingDigit, { key: i + ':' + ch, ch })
          : el('span', { key: i + ':' + ch, className: 'tw-roll-plain' }, ch)
      )))
    }

    /** 单个数字位：一列 0-9，靠 transform 滚到目标数字。 */
    function RollingDigit({ ch }) {
      return el('span', { className: 'tw-roll' },
        el('span', { className: 'tw-roll-col', style: { transform: 'translateY(-' + Number(ch) + 'em)' } },
          '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'))
    }

    // ── 挂件定位（拖拽 / 吸附 / 持久化）──────────────────────────────────

    const POS_KEY = 'dsh-tidewatch.pos'
    /** 挂件与视口边缘的安全距离（px）。 */
    const EDGE = 12

    /** 读挂件位置（视口坐标）；无记录或配置损坏时返回 null（走默认右下角）。 */
    function loadPos() {
      try {
        const raw = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null')
        if (raw !== null && typeof raw === 'object'
          && Number.isFinite(raw.left) && Number.isFinite(raw.top)) {
          return { left: raw.left, top: raw.top }
        }
      } catch { /* 配置损坏：回到默认位置 */ }
      return null
    }

    /** 存挂件位置。 */
    function savePos(pos) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* 隐私模式：忽略 */ }
    }

    // ── 轻量泡泡（点击挂件弹出，内容模块可各自开关）────────────────────────

    const BUBBLE_KEY = 'dsh-tidewatch.bubble'

    /** 读泡泡内容开关；缺省三块全开，配置损坏也回到全开。 */
    function loadBubbleModules() {
      try {
        const raw = JSON.parse(localStorage.getItem(BUBBLE_KEY) ?? 'null')
        if (raw !== null && typeof raw === 'object') {
          return { cost: raw.cost !== false, balance: raw.balance !== false, phase: raw.phase !== false }
        }
      } catch { /* 配置损坏：全开 */ }
      return { cost: true, balance: true, phase: true }
    }

    /** 存泡泡内容开关。 */
    function saveBubbleModules(value) {
      try { localStorage.setItem(BUBBLE_KEY, JSON.stringify(value)) } catch { /* 隐私模式：忽略 */ }
    }

    /** 旧模型名 → 现役模型 key（V4.1 Flash 2026-09-10 更名，旧名路由到新价）。 */
    const MODEL_ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
      'deepseek-v4.1-flash': 'deepseek-flash',
    }

    /** 模型名归一化匹配（与 lib/pricing.js 一致；旧名经别名表映射，pro 换价后路由 Flash 价）。 */
    function priceEntryForModel(model, atMs) {
      const normalize = s => String(s ?? '').toLowerCase().replace(/[\s\-_.()（）]/g, '')
      let id = normalize(model)
      for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
        if (id === normalize(alias)) {
          id = normalize(target)
          break
        }
      }
      // V4 Pro 换价路由：哨兵值下恒不触发，pro 按自身价目展示（与 pricing.js 对称）。
      if (id === normalize('deepseek-v4-pro') && Number.isFinite(atMs) && atMs >= V4_PRO_RETIRE_AT) {
        id = 'deepseekflash'
      }
      if (id.length > 0 && Object.prototype.hasOwnProperty.call(DISPLAY_PRICES, id)) return id
      for (const key of Object.keys(DISPLAY_PRICES)) {
        if (id.includes(normalize(key))) return key
      }
      return 'deepseek-flash'
    }

    /**
     * 模型名是否在展示价目表内（含别名归一化），与 lib/pricing.js 的 isPricedModel
     * 同构。用来区分「DeepSeek 家族模型」与「其他提供商的模型」：后者不走官方分时
     * 定价，金额要显示「不适用」，而不是兜底出来的 flash 估价。
     * @param model - 模型 id。
     * @returns 命中展示价目时为 true（不含 flash 兜底）。
     */
    function isKnownDisplayModel(model) {
      const normalize = s => String(s ?? '').toLowerCase().replace(/[\s\-_.()（）]/g, '')
      let id = normalize(model)
      for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
        if (id === normalize(alias)) {
          id = normalize(target)
          break
        }
      }
      if (id.length === 0) return false
      if (Object.prototype.hasOwnProperty.call(DISPLAY_PRICES, id)) return true
      for (const key of Object.keys(DISPLAY_PRICES)) {
        if (id.includes(normalize(key))) return true
      }
      return false
    }

    /** 北京时间时段表行号；全天谷期（周末/法定节假日）返 -1（无时段行可高亮）。 */
    function beijingSlotIndex(atMs) {
      if (isAllDayOffPeakAt(atMs)) return -1
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
      '.tw-total{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,#444);cursor:pointer;user-select:none;transition:background .15s ease}',
      '.tw-total:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.tw-total-label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#c5c5c5)}',
      '.tw-total-arrow{flex:none;font-size:9px;color:var(--dsw-alias-label-tertiary,#9b9b9b);transition:transform .15s ease}',
      '.tw-total.open .tw-total-arrow{transform:rotate(90deg)}',
      '.tw-total-val{font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary,#e8e8e8);font-variant-numeric:tabular-nums}',
      // 账户余额区块：充值 / 礼金 / 合计三行 + 读数时刻小字。
      '.tw-balance{margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,#444)}',
      '.tw-balance-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0;font-size:12px}',
      '.tw-balance-label{color:var(--dsw-alias-label-secondary,#c5c5c5)}',
      '.tw-balance-val{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8);font-variant-numeric:tabular-nums}',
      '.tw-balance-sum{font-size:14px}',
      '.tw-balance-note{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      // 数字滚动：每位一列 0-9，靠 transform 纵向滚动到目标数字。
      '.tw-roll-wrap{display:inline-flex;align-items:baseline}',
      '.tw-roll{display:inline-block;height:1em;overflow:hidden;vertical-align:baseline}',
      '.tw-roll-col{display:flex;flex-direction:column;transition:transform .42s cubic-bezier(.2,.8,.2,1)}',
      '.tw-roll-col>span{display:block;height:1em;line-height:1em}',
      '.tw-roll-plain{display:inline-block}',
      // 不适用态（非 DeepSeek 模型）：胶囊与说明文字转中性色，避免被读成峰/谷档。
      '.tw-chip.na{border-color:var(--dsw-alias-border-l2,#555);color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '.tw-chip.na .tw-phase,.tw-chip.na .tw-cost{color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '.tw-na-note{margin-top:6px;padding:0 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '.tw-models{margin-top:6px;padding:4px 10px 2px;display:flex;flex-direction:column;gap:2px}',
      '.tw-model-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0;font-size:12px}',
      '.tw-model-row + .tw-model-row{border-top:1px solid var(--dsw-alias-border-l1,#444)}',
      '.tw-model-label{color:var(--dsw-alias-label-secondary,#c5c5c5);display:inline-flex;align-items:center;gap:6px}',
      '.tw-model-tag{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;color:var(--dsw-alias-label-tertiary,#9b9b9b);background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l1,#444)}',
      '.tw-model-val{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8);font-variant-numeric:tabular-nums}',
      '.tw-currency{display:flex;align-items:center;gap:6px;margin-top:8px;padding:0 2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '.tw-currency-btn{font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary,#c5c5c5);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,#444);border-radius:6px;padding:1px 10px;cursor:pointer;line-height:18px}',
      '.tw-currency-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.tw-currency-btn.on{color:var(--dsw-alias-label-primary,#e8e8e8);border-color:var(--dsw-alias-state-business-primary,#4d9fff)}',
      '.tw-empty-note{padding:3px 8px;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      // 挂件：视口固定定位，可拖拽；吸附到左侧时镜像排列，观感朝内。
      '.tw-widget{position:fixed;z-index:1100;display:inline-flex;align-items:center;touch-action:none;cursor:grab;transition:left .18s ease,top .18s ease}',
      '.tw-widget:active{cursor:grabbing}',
      '.tw-widget.tw-flip .tw-chip{flex-direction:row-reverse}',
      // 轻量泡泡：比完整面板窄，行间留白，底部是详情入口。
      '.tw-bubble{width:196px;padding:6px 10px}',
      '.tw-bubble-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:3px 0;font-size:12px}',
      '.tw-bubble-label{color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '.tw-bubble-val{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8);font-variant-numeric:tabular-nums}',
      '.tw-bubble-more{margin-top:4px;width:100%;padding:2px 0;border:0;border-top:1px solid var(--dsw-alias-border-l1,#444);background:transparent;color:var(--dsw-alias-state-business-primary,#4d9fff);font:inherit;font-size:11px;cursor:pointer;text-align:right}',
      '.tw-bubble-more:hover{text-decoration:underline}',
      // 锚定态：容器只有面板这一个绝对定位子元素（自身宽度为 0），面板须改以左缘
      // 对齐容器左缘——配合视口钳制，面板在窄屏（手机）也不会横向出界。
      '.tw-anchored .tw-panel{right:auto;left:0}',
    ].join('\n')

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', CSS_TAG_ID)
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ── 数据探针（session 插槽）：订阅投影写入 bridge，渲染 null ────────────

    function Probe(props) {
      const sessionId = props.sessionId
      const usage = props.useProjection ? props.useProjection('costUsage') : undefined
      // 会话插槽按 sessionId 作为 React key 渲染：会话切换 = 组件卸载重挂。
      // 挂载时先清桥：本会话在产生第一条调用前投影无新值，不清会残留上一
      // 会话金额。清桥只在「桥上现有值已不属于任何活跃会话」时执行——若此刻
      // 已有别的活跃会话写入（会话刚切、新会话先挂载），清掉会抹掉有效值。
      useEffect(() => {
        if (bridge.value !== null && claims.has(bridge.value.sessionId)) return
        bridge.set({ sessionId: undefined, usage: null })
      }, [])
      // 归属申报：本会话存活期间一直持有，卸载（会话切走）即撤回。
      useEffect(() => {
        claims.add(sessionId)
        return () => { claims.delete(sessionId) }
      }, [sessionId])
      // 依赖 sessionId + usage：两者任一变化都重写桥，并携带归属会话 id。
      useEffect(() => {
        bridge.set({ sessionId, usage: usage ?? null })
      }, [sessionId, usage])
      return null
    }

    // ── 悬浮徽章（shell.overlay）：订阅 bridge 渲染 ─────────────────────────

    function TideCard(props) {
      const [snap, setSnap] = useState(bridge.value)
      // 归属校验：桥里那条 sessionId 由会话侧的 Probe 申报（见 claims），壳层
      // 只做「它还在会话列表里」的存活校验——会话被关闭/清空后不再展示残值。
      // 旧写法 props.useSessions(s => s.current) 恒得 undefined（SessionListState
      // 没有 current 字段），使归属校验永不成立、金额一律被置 null。
      // 列表尚未就绪（非 ready）时不做判断，避免启动瞬间误杀。
      const sessionList = props.useSessions ? props.useSessions(s => s) : undefined
      const listReady = sessionList !== undefined && sessionList.phase === 'ready'
      const bridgeSessionId = snap !== null ? snap.sessionId : undefined
      const ownerAlive = bridgeSessionId === undefined
        || !listReady
        || (Object.prototype.hasOwnProperty.call(sessionList.byId, bridgeSessionId)
          && sessionList.byId[bridgeSessionId].blank !== true)
      const usage = ownerAlive ? (snap !== null ? snap.usage : null) : null
      const [now, setNow] = useState(() => Date.now())
      const [expanded, setExpanded] = useState(() => {
        try { return localStorage.getItem(EXPANDED_KEY) === '1' } catch { return false }
      })
      const [currency, setCurrency] = useState(loadCurrency)
      const [costOpen, setCostOpen] = useState(false)
      /**
       * 账户余额读数。null = 尚无结果（含插件拿不到账户服务的情形）；
       * 其余为 { status, paid, bonus, total, sig, readAt, queriedAt } 或 { status }。
       */
      const [wallet, setWallet] = useState(null)
      const rootRef = useRef(null)
      // 胶囊在官方 dock 插槽里行内渲染；chipWrapRef 是它的包裹元素（外点关闭的
      // 「内部」判定基准），inlinePos 是展开面板的锚定坐标。
      const chipWrapRef = useRef(null)
      const [inlinePos, setInlinePos] = useState({ left: 12, bottom: 96 })

      /**
       * 账户余额轮询。数据取自 DSH 的账户服务（`ctx.remote.account.getBalance`）：
       * 宿主持有凭据并执行查询，本插件既不接触 API Key，也不直接发 HTTP 请求。
       * 返回 `{ ok, value }`，value 为 null（未登录）/ `{ status:'ready',
       * value:[充值钱包], bonusWallets:[礼金钱包] }` / `{ status:'failed' }`，
       * 钱包是 `{ currency, balance }`。充值余额与礼金互不重叠，相加才是钱包总额。
       * 前人实测：宿主对账号查询的缓存只在「凭证变化或销毁」时失效，监听账号事件
       * 重查拿到的仍是旧快照。时效只能靠轮询，故把读数时刻如实显示在面板里。
       */
      useEffect(() => {
        const account = props.account
        if (account === undefined || account === null || typeof account.getBalance !== 'function') return undefined
        let alive = true
        let ticks = 0
        const query = async () => {
          try {
            const result = await account.getBalance({
              version: clientVersion(),
              locale: 'zh_CN',
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            })
            if (!alive) return
            if (result === null || result === undefined || result.ok !== true) {
              setWallet(prev => ({ ...(prev ?? {}), status: 'network' }))
              return
            }
            const value = result.value
            if (value === null || value === undefined) {
              setWallet(prev => ({ ...(prev ?? {}), status: 'signed-out' }))
              return
            }
            if (value.status !== 'ready') {
              setWallet(prev => ({ ...(prev ?? {}), status: 'failed' }))
              return
            }
            const paid = sumWallets(value.value)
            const bonus = sumWallets(value.bonusWallets)
            const total = new Map(paid)
            for (const [cur, amount] of bonus) total.set(cur, (total.get(cur) ?? 0) + amount)
            const sig = walletSignature(paid) + '#' + walletSignature(bonus)
            const at = Date.now()
            setWallet(prev => (prev !== null && prev.status === 'ready' && prev.sig === sig
              // 数字没动：readAt 保持不变（它说的是「自此刻起这个数没再变过」），
              // 只刷新查询时刻。两个时刻含义不同，合并会掩盖读数的陈旧。
              ? { ...prev, total, queriedAt: at }
              : { status: 'ready', paid, bonus, total, sig, readAt: at, queriedAt: at }))
          } catch {
            if (alive) setWallet(prev => ({ ...(prev ?? {}), status: 'network' }))
          }
        }
        void query()
        const timer = setInterval(() => {
          ticks += 1
          // 页面不可见时降到 6 倍间隔：余额只用于显示，不参与任何计算。
          if (document.visibilityState !== 'visible' && ticks % 6 !== 0) return
          void query()
        }, BALANCE_POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [props.account])

      /**
       * 音效总开关与余额预警阈值都持久化在 localStorage。
       * 预警只在「跨过阈值」时响一次，回升到阈值以上后重新武装——否则每次轮询都会叫。
       */
      const [soundOn, setSoundOn] = useState(() => loadFlag(SOUND_KEY, true))
      const [alertBelow] = useState(loadAlertThreshold)
      const alertArmed = useRef(true)
      useEffect(() => {
        if (wallet === null || wallet.status !== 'ready') return
        if (alertBelow <= 0) {
          alertArmed.current = true
          return
        }
        const cny = wallet.total.get('CNY') ?? 0
        if (cny >= alertBelow) {
          alertArmed.current = true
          return
        }
        if (!alertArmed.current) return
        alertArmed.current = false
        if (soundOn) playTone('alert')
      }, [wallet, alertBelow, soundOn])

      /** 挂件位置（视口坐标）；null = 首帧走默认右下角，之后由拖拽决定。 */
      const [pos, setPos] = useState(loadPos)
      /** 吸附到哪一侧：'left' 时把胶囊内容镜像排列，读起来仍顺。 */
      const [snapped, setSnapped] = useState(null)
      /** 轻量泡泡是否打开：点挂件弹出，点「详情」才进完整面板。 */
      const [bubbleOpen, setBubbleOpen] = useState(false)
      /** 泡泡里显示哪几块内容（费用 / 余额 / 峰谷），可在面板里关掉。 */
      const [bubbleModules, setBubbleModules] = useState(loadBubbleModules)
      const dragRef = useRef(null)
      /**
       * 挂件拖拽：pointerdown 记录起点，pointermove 更新位置（位移超过 4px 才算拖，
       * 否则视为点击交给 onClick），松手时吸附到较近的一侧并持久化。
       */
      useEffect(() => {
        const node = chipWrapRef.current
        if (node === null) return undefined
        const onDown = e => {
          if (e.button !== 0) return
          const r = node.getBoundingClientRect()
          dragRef.current = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false }
          try { node.setPointerCapture(e.pointerId) } catch { /* 个别环境不支持指针捕获 */ }
        }
        const onMove = e => {
          const st = dragRef.current
          if (st === null) return
          const dx = e.clientX - st.x
          const dy = e.clientY - st.y
          if (!st.moved && Math.abs(dx) + Math.abs(dy) < 4) return
          st.moved = true
          const r = node.getBoundingClientRect()
          const maxLeft = Math.max(EDGE, window.innerWidth - r.width - EDGE)
          const maxTop = Math.max(EDGE, window.innerHeight - r.height - EDGE)
          setPos({
            left: Math.min(Math.max(st.left + dx, EDGE), maxLeft),
            top: Math.min(Math.max(st.top + dy, EDGE), maxTop),
          })
        }
        const onUp = () => {
          const st = dragRef.current
          dragRef.current = null
          if (st === null || !st.moved) return // 没拖动 = 点击
          const r = node.getBoundingClientRect()
          const side = (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right'
          const maxLeft = Math.max(EDGE, window.innerWidth - r.width - EDGE)
          const left = side === 'left' ? EDGE : maxLeft
          const next = { left: Math.min(Math.max(left, EDGE), maxLeft), top: r.top }
          setPos(next)
          setSnapped(side)
          savePos(next)
        }
        node.addEventListener('pointerdown', onDown)
        node.addEventListener('pointermove', onMove)
        node.addEventListener('pointerup', onUp)
        node.addEventListener('pointercancel', onUp)
        return () => {
          node.removeEventListener('pointerdown', onDown)
          node.removeEventListener('pointermove', onMove)
          node.removeEventListener('pointerup', onUp)
          node.removeEventListener('pointercancel', onUp)
        }
      }, [])

      useEffect(() => bridge.subscribe(setSnap), [])
      useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
      }, [])
      /** 展开态写入（含 localStorage 持久化）：手动切换与外点关闭共用。 */
      const applyExpanded = useCallback(next => {
        setExpanded(next)
        try { localStorage.setItem(EXPANDED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      }, [])
      // 外点关闭：官方 useDismissOnOutsidePointer（pointerdown）优先，
      // 原语不可用时降级到同签名的自研实现。胶囊与面板分处两个容器
      // （dock 插槽 / body），故把面板容器作为 portal 参数一并算作「内部」。
      useDismissOutside(chipWrapRef, expanded, applyExpanded, rootRef)
      // 面板 portal 到 body，据此把 fixed 容器锚到胶囊上方。
      // 关键：右缘对齐胶囊右缘后必须再把整块钳进视口——窄屏（手机）下胶囊
      // 可能落在靠左处，只对齐右缘会让面板左半块探出屏幕外。
      useEffect(() => {
        if (!expanded && !bubbleOpen) return
        const EDGE = 12
        const PANEL_W = 320
        const measure = () => {
          const node = chipWrapRef.current
          if (node === null) return
          const r = node.getBoundingClientRect()
          const width = Math.min(PANEL_W, window.innerWidth - EDGE * 2)
          const left = Math.min(
            Math.max(r.right - width, EDGE),
            Math.max(EDGE, window.innerWidth - width - EDGE),
          )
          const next = {
            left: Math.max(EDGE, left),
            bottom: Math.max(EDGE, window.innerHeight - r.top),
          }
          setInlinePos(prev => (prev.left === next.left && prev.bottom === next.bottom ? prev : next))
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [expanded, bubbleOpen])

      const phase = nextPhase(now)
      const inPeak = phase !== null && phase.inPeak
      const countdown = phase === null ? 0 : Math.max(0, phase.nextAtMs - now)
      const nextLabel = phase === null ? '下一阶段' : (phase.nextIntoPeak ? '峰期' : '谷期')
      const costUsd = Number(usage?.cost) || 0

      const toggle = () => applyExpanded(!expanded)

      const setCurrencyPersist = next => {
        setCurrency(next)
        try { localStorage.setItem(CURRENCY_KEY, next) } catch { /* ignore */ }
      }

      // 当前模型：优先取投影 view 的 model（会话正在使用的模型，实时跟随
      // request/header 更新）；无请求历史时回退 byModel 首键，再无则 flash。
      const modelKeys = usage?.byModel !== undefined ? Object.keys(usage.byModel) : []
      const activeModel = typeof usage?.model === 'string' && usage.model.length > 0 ? usage.model : (modelKeys[0] ?? 'deepseek-flash')
      // 是否适用 DeepSeek 的峰谷分时定价：provider 属于 DeepSeek，或模型名明确落在
      // 价目表里（中转 / 自建网关的 provider 常自起名字，模型仍是 deepseek-*）。
      // 不适用时宿主同样不计价，界面改为明确标注，避免给出与账单无关的数字。
      const provider = typeof usage?.provider === 'string' ? usage.provider : ''
      const providerIsDeepSeek = provider !== '' && provider.toLowerCase().includes('deepseek')
      const applies = isKnownDisplayModel(activeModel) || providerIsDeepSeek
      const modelKey = priceEntryForModel(activeModel, now)
      const price = DISPLAY_PRICES[modelKey]
      const tier = inPeak ? price.peak : price.offPeak
      // 展示用人民币档：官方中文页数字；展示时不做汇率换算（与 pricing.js 同口径）。
      const tierRmb = price.rmb !== undefined ? (inPeak ? price.rmb.peak : price.rmb.offPeak) : undefined
      const slotIdx = beijingSlotIndex(now)
      const weekend = isWeekend(now)
      const holiday = isCnHolidayAt(now)
      const input = Number(usage?.input) || 0
      const cache = (Number(usage?.cacheRead) || 0) + (Number(usage?.cacheWrite) || 0)
      const output = Number(usage?.output) || 0
      const reasoning = Number(usage?.reasoning) || 0

      // 折叠态胶囊：官方 Tooltip 包裹（原语缺失时 Tip 退化为原生 title）。
      // 不适用 DeepSeek 峰谷计价时收成「不适用 · —」：状态点转中性灰，不再显示峰谷与
      // 倒计时（这两项对非 DeepSeek 模型没有意义）。
      const chip = el('button', {
        className: 'tw-chip ' + (applies ? (inPeak ? 'peak' : 'offpeak') : 'na') + (expanded ? ' open' : ''),
        onClick: () => { if (soundOn) playTone('tap'); setBubbleOpen(v => !v) },
      },
        el(PhaseDot, { inPeak, size: 9, state: applies ? undefined : 'idle' }),
        el('span', { className: 'tw-phase' }, applies ? (inPeak ? '峰期' : '谷期') : '不适用'),
        applies ? el('span', { className: 'tw-countdown' }, '距' + nextLabel + ' ' + fmtCountdownShort(countdown)) : null,
        el('span', { className: 'tw-sep' }),
        el('span', { className: 'tw-cost' }, applies ? el(RollingNumber, { text: fmtMoney(costUsd, currency) }) : '—'))

      // 展开面板的内容：内联态 portal 到 body，兜底态作为浮动容器的子元素，
      // 两种承载方式共用同一份内容。
      const panelContent = [
          // 头部：当前档位 + 倒计时（非 DeepSeek 模型改为说明「不适用」）
          el('div', { className: 'tw-panel-head' },
            el('span', { className: 'tw-panel-phase ' + (applies ? (inPeak ? 'peak' : 'offpeak') : 'na') },
              el(PhaseDot, { inPeak, size: 10, state: applies ? undefined : 'idle' }),
              el('span', null, applies
                ? (inPeak ? '峰期进行中' : '谷期进行中')
                : '当前模型不适用峰谷计价 · ' + activeModel)),
            applies ? el('span', { className: 'tw-panel-countdown' }, '距' + nextLabel + ' ' + fmtCountdown(countdown)) : null),
          // 峰谷时段表（北京时间）；非 DeepSeek 模型保留查阅，但明确标注适用范围
          el('div', { className: 'tw-h' }, '官方峰谷时段（周末、法定节假日及调休上班的周末全天谷期）'
            + (applies ? '' : ' · 仅 DeepSeek 模型适用')),
          el('div', { className: 'tw-slots' },
            BEIJING_SLOTS.map((slot, i) => el('div', {
              key: slot.start + slot.end,
              className: 'tw-slot' + (i === slotIdx ? ' now' : ''),
            },
              el('span', { className: 'tw-slot-time' }, slot.start + ' – ' + slot.end),
              el('span', null,
                i === slotIdx ? el('span', { className: 'tw-slot-now-tip' }, '现在') : null,
                el(PhaseTag, {
                  tone: slot.phase === 'peak' ? 'warning' : 'success',
                  fallbackClass: 'tw-slot-tag ' + slot.phase,
                }, slot.text))))),
          holiday ? el('div', { className: 'tw-slot now' },
            el('span', { className: 'tw-slot-time' }, '法定节假日 · 00:00 – 24:00'),
            el('span', null,
              el('span', { className: 'tw-slot-now-tip' }, '现在'),
              el(PhaseTag, { tone: 'success', fallbackClass: 'tw-slot-tag offpeak' }, '谷'))) : null,
          !holiday && weekend ? el('div', { className: 'tw-slot now' },
            el('span', { className: 'tw-slot-time' }, '周六 / 周日 · 00:00 – 24:00'),
            el('span', null,
              el('span', { className: 'tw-slot-now-tip' }, '现在'),
              el(PhaseTag, { tone: 'success', fallbackClass: 'tw-slot-tag offpeak' }, '谷'))) : null,
          // 当前档位价格；非 DeepSeek 模型改为「参考价目」并注明不适用
          el('div', { className: 'tw-h' }, applies
            ? '当前档位 · ' + price.label + '（' + (inPeak ? '峰时' : '谷时') + '）'
            : 'DeepSeek 参考价目 · ' + price.label + '（当前模型不适用）'),
          el('div', { className: 'tw-prices' },
            el('div', { className: 'tw-price-row' },
              el('span', { className: 'tw-price-label' }, '输入 · 未命中 / 缓存'),
              el('span', { className: 'tw-price-val' }, fmtTierMoney(tier.cacheMiss, tierRmb !== undefined ? tierRmb.cacheMiss : undefined, 4, currency) + ' / ' + fmtTierMoney(tier.cacheHit, tierRmb !== undefined ? tierRmb.cacheHit : undefined, 4, currency) + ' /百万')),
            el('div', { className: 'tw-price-row' },
              el('span', { className: 'tw-price-label' }, '输出'),
              el('span', { className: 'tw-price-val' }, fmtTierMoney(tier.output, tierRmb !== undefined ? tierRmb.output : undefined, 4, currency) + ' /百万'))),
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
                  el('span', { className: 'tw-token-label' }, '输出（含推理）'),
                  el('span', { className: 'tw-token-val' }, fmtTokens(output))),
                reasoning > 0 ? el('div', { className: 'tw-token-row' },
                  el('span', { className: 'tw-token-label' }, '　其中推理'),
                  el('span', { className: 'tw-token-val' }, fmtTokens(reasoning))) : null),
          // 本次会话费用（可点击展开分模型明细）+ 币种切换
          el(Tip, {
            label: '点击展开 / 收起分模型花费',
            node: el('div', { className: 'tw-total' + (costOpen ? ' open' : ''), onClick: () => setCostOpen(v => !v) },
              el('span', { className: 'tw-total-label' },
                el('span', { className: 'tw-total-arrow' }, '▶'),
                el('span', null, '本次会话费用')),
              el('span', { className: 'tw-total-val' }, applies ? el(RollingNumber, { text: fmtMoney(costUsd, currency) }) : '不适用')),
          }),
          // 非 DeepSeek 模型：说清费用为什么不估算（否则「不适用」会被当成 0 元）
          applies ? null : el('div', { className: 'tw-na-note' },
            '当前会话的模型不走 DeepSeek 峰谷定价，费用不在此估算'),
          costOpen ? el('div', { className: 'tw-models' },
            Object.entries(usage?.byModel ?? {}).length === 0
              ? el('div', { className: 'tw-model-row' },
                  el('span', { className: 'tw-model-label' }, '会话尚无模型调用'),
                  el('span', { className: 'tw-model-val' }, fmtMoney(0, currency)))
              : Object.entries(usage.byModel)
                  .sort((a, b) => (b[1].cost ?? 0) - (a[1].cost ?? 0))
                  .map(([id, bucket]) => {
                    const known = isKnownDisplayModel(id)
                    const price = DISPLAY_PRICES[priceEntryForModel(id, now)]
                    // 未收录的模型直接显示模型名、金额显示破折号：它没有 DeepSeek 价目。
                    const label = known && price !== undefined ? price.label : id
                    return el('div', { key: id, className: 'tw-model-row' },
                      el('span', { className: 'tw-model-label' },
                        el(PhaseTag, { tone: 'outline', fallbackClass: 'tw-model-tag' }, label),
                        el('span', null, '输入 ' + fmtTokens(bucket.input) + ' · 输出 ' + fmtTokens(bucket.output))),
                      el('span', { className: 'tw-model-val' }, known ? fmtMoney(bucket.cost ?? 0, currency) : '—'))
                  })) : null,
          // 账户余额（DeepSeek 官网口径：充值 + 礼金，两者不相加时会漏算总额）。
          // 插件拿不到账户服务时 wallet 恒为 null，整块不出现，其余功能照常。
          wallet === null ? null : el('div', null,
            el('div', { className: 'tw-h' }, 'DeepSeek 账户余额'),
            wallet.status === 'ready'
              ? el('div', { className: 'tw-balance' },
                  el('div', { className: 'tw-balance-row' },
                    el('span', { className: 'tw-balance-label' }, '充值余额'),
                    el('span', { className: 'tw-balance-val' }, fmtWallets(wallet.paid))),
                  wallet.bonus.size > 0
                    ? el('div', { className: 'tw-balance-row' },
                        el('span', { className: 'tw-balance-label' }, '礼金余额'),
                        el('span', { className: 'tw-balance-val' }, fmtWallets(wallet.bonus)))
                    : null,
                  el('div', { className: 'tw-balance-row' },
                    el('span', { className: 'tw-balance-label' }, '合计'),
                    el('span', { className: 'tw-balance-val tw-balance-sum' }, el(RollingNumber, { text: fmtWallets(wallet.total) }))),
                  el('div', { className: 'tw-balance-note' },
                    '更新于 ' + clockOf(wallet.readAt) + ' · 受平台同步延迟影响，可能非实时值'))
              : el('div', { className: 'tw-balance-note' },
                  wallet.status === 'signed-out'
                    ? '未登录 DeepSeek 账号'
                    : wallet.status === 'failed' ? '余额暂不可用' : '余额查询失败')),
          el('div', { className: 'tw-currency' },
            el('span', null, '币种'),
            el('button', { className: 'tw-currency-btn' + (currency === 'cny' ? ' on' : ''), onClick: () => setCurrencyPersist('cny') }, '¥ 人民币'),
            el('button', { className: 'tw-currency-btn' + (currency === 'usd' ? ' on' : ''), onClick: () => setCurrencyPersist('usd') }, '$ 美元')),
          // 音效总开关：关掉后点击与预警都不发声（偏好持久化）。
          el('div', { className: 'tw-currency' },
            el('span', null, '音效'),
            el('button', {
              className: 'tw-currency-btn' + (soundOn ? ' on' : ''),
              onClick: () => {
                const next = !soundOn
                setSoundOn(next)
                saveFlag(SOUND_KEY, next)
                if (next) playTone('tap')
              },
            }, soundOn ? '开' : '关')),
          // 泡泡内容开关：决定点击挂件弹出的轻量泡泡里显示哪几块。
          el('div', { className: 'tw-currency' },
            el('span', null, '泡泡'),
            ['cost', 'balance', 'phase'].map(key => el('button', {
              key,
              className: 'tw-currency-btn' + (bubbleModules[key] ? ' on' : ''),
              onClick: () => {
                const next = { ...bubbleModules, [key]: !bubbleModules[key] }
                setBubbleModules(next)
                saveBubbleModules(next)
              },
            }, { cost: '费用', balance: '余额', phase: '峰谷' }[key]))),
      ]
      const tipLabel = '点击展开 / 收起峰谷详情'

      // 挂件：视口固定定位，位置由拖拽决定（首帧默认右下角），吸附侧做镜像。
      // 完整面板与轻量泡泡都 portal 到 body 并锚定挂件上方（面板宽度远超挂件本身）。
      const widgetStyle = pos === null
        ? { right: EDGE, bottom: 96 }
        : { left: pos.left, top: pos.top }
      const anchorStyle = { left: inlinePos.left, bottom: inlinePos.bottom, zIndex: 1200 }
      const panel = el('div', { ref: rootRef, className: 'tw-root tw-anchored', style: anchorStyle },
        el('div', { className: 'tw-panel' }, ...panelContent))
      // 轻量泡泡：三块摘要，各自可在面板里关掉；点「详情」进入完整面板。
      const bubbleRow = (label, value) => el('div', { className: 'tw-bubble-row' },
        el('span', { className: 'tw-bubble-label' }, label),
        el('span', { className: 'tw-bubble-val' }, value))
      const bubble = el('div', { className: 'tw-root tw-anchored', style: anchorStyle },
        el('div', { className: 'tw-panel tw-bubble' },
          bubbleModules.cost
            ? bubbleRow('本次会话', applies ? fmtMoney(costUsd, currency) : '不适用')
            : null,
          bubbleModules.balance
            ? bubbleRow('余额', wallet !== null && wallet.status === 'ready' ? fmtWallets(wallet.total) : '—')
            : null,
          bubbleModules.phase
            ? bubbleRow(applies ? (inPeak ? '峰期' : '谷期') : '不适用',
              applies ? '距' + nextLabel + ' ' + fmtCountdownShort(countdown) : '—')
            : null,
          el('button', {
            className: 'tw-bubble-more',
            onClick: () => { setBubbleOpen(false); applyExpanded(true) },
          }, '详情 ›')))
      return el(React.Fragment, null,
        el('span', {
          ref: chipWrapRef,
          className: 'tw-widget' + (snapped === 'left' ? ' tw-flip' : ''),
          style: widgetStyle,
        }, el(Tip, { label: tipLabel, node: chip })),
        bubbleOpen
          ? (createPortal !== null ? createPortal(bubble, document.body) : bubble)
          : null,
        expanded
          ? (createPortal !== null ? createPortal(panel, document.body) : panel)
          : null)
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────

    // 无 RPC：仅 UI + 会话投影，无需贡献描述符。
    const CONTRIBUTION = { package: 'dsh-tidewatch', descriptors: [] }
    // remote.account：DSH 的账户服务（余额查询由宿主执行，插件不接触凭据）。
    const inject = ['remote', 'remote.account']

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
      // 数据探针：会话作用域插槽（提供 useProjection 席位），渲染 null 并写入 bridge。
      // 经 slots.inject 等待宿主声明，宿主声明不可用时自动卸载。
      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'dsh-tidewatch-probe', order: 99, inject: () => ({}) },
        Probe,
      ))
      // 潮汐挂件：根级框架悬浮层 —— 右下角常驻、可拖拽吸附的独立挂件。
      // 数据仍由上面那个 dock 探针经 bridge 提供（root 插槽没有投影席位）。
      slots.inject('shell.overlay', () => slots.register(
        {
          name: 'shell.overlay',
          id: 'dsh-tidewatch',
          order: 101,
          // 账户服务经 props 交给组件：组件不碰 ctx，余额查询走这个句柄。
          inject: () => ({ account: ctx.remote.account }),
        },
        TideCard,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
