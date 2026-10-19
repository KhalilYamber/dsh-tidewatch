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
    const { useCallback, useMemo, useState, useEffect, useRef } = React
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
     * 节假日表覆盖到的最后一年（从本文件里的表推导，与 pricing.js 的同名值同源）。
     * 表只到 2026 年；2027 年的安排要等国办通知发布后手动补。
     */
    const HOLIDAY_TABLE_LAST_YEAR = [...CN_PUBLIC_HOLIDAYS]
      .reduce((latest, day) => Math.max(latest, Number(day.slice(0, 4)) || 0), 0)
    /**
     * 现在这一年的节假日表是否已经过期。过期后周一到周五一律按工作日走，
     * 法定节假日会被按峰期计价——数字看起来正常，其实是错的，所以要在界面上说。
     * @param atMs - 时刻（epoch ms）。
     * @returns 表已过期时为 true。
     */
    function holidayTableExpired(atMs) {
      if (!Number.isFinite(atMs)) return false
      const year = new Date(atMs + BEIJING_OFFSET_MS).getUTCFullYear()
      return year > HOLIDAY_TABLE_LAST_YEAR
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
      return '1.27.0'
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

    // 挂件形象（社区共创的 DeepSeek 娘「大肥鱼」立绘；原图见 lib/assets/mascot/）
    const MASCOT_SPRITES = {
      idle: 'data:image/png;base64,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',
      think: 'data:image/png;base64,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',
    }

    // ── 数字滚动 / 音效 / 余额预警 ───────────────────────────────────────────

    const SOUND_KEY = 'dsh-tidewatch.sound'
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

    /**
     * 合成提示音（WebAudio）。不依赖任何音频素材——零版权风险、零体积。
     * 浏览器的自动播放策略要求音频上下文由用户手势创建或恢复，故只在点击等
     * 真实手势里调用；拿不到音频能力时静默跳过，绝不影响功能。
     * 只做点击音：早期还带过一个余额预警音，预警功能已移除。
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
        beep(0, 1320, 1320, 0.05)
      } catch { /* 无音频权限或被禁用：静默跳过 */ }
    }

    /**
     * 会动一下的数字：文本本身直接渲染，值变化时重播一次上滑淡入。
     * 早先用「一列 0-9 + transform 定位」做逐位滚动，但 React 里数字是文本节点，
     * 子选择器裁不住、内联裁剪在 flex 容器中也会失效，十个数字摊开过一次。
     * 现在是纯文本，不可能再摊开。
     */
    function RollingNumber({ text }) {
      const [tick, setTick] = useState(0)
      const last = useRef(String(text))
      useEffect(() => {
        const next = String(text)
        if (last.current !== next) {
          last.current = next
          setTick(v => v + 1)
        }
      }, [text])
      return el('span', { key: tick, className: 'tw-num-roll' }, String(text))
    }

    // ── 气泡（漫画对话框 + 多页队列 + 占位符模板）─────────────────────────

    /** 气泡显示时长（毫秒），照参考插件的 5 秒节奏。 */
    const BUBBLE_MS = 5000
    const BUBBLE_CFG_KEY = 'dsh-tidewatch.bubbles'

    /**
     * 默认气泡页：每页是若干行模板，行内可用占位符。
     * 第 1 页看余额与峰谷，第 2 页看本次会话开销；点气泡翻页。
     */
    const DEFAULT_BUBBLE_PAGES = [
      ['{phase} · 距切换 {countdown}', '余额 {balance}', '充值 {paid} / 礼金 {bonus}'],
      ['本次会话 {cost}', '当前档位 {price}', '会话 token {tokens}', '诊断 {diag}'],
    ]

    /**
     * 余额差值追踪器：某条通道拿不到 usage 时，改用「账户余额下降了多少」估算。
     *
     * 输入是钱包表（按币种分组的 Map），只认人民币：跨币种相加没有意义，
     * 把美元钱包折成人民币又要引入第二个汇率。以前这里收的是 Map 却当成
     * 数字用，`Number(Map)` 得 NaN，于是既不建立基准也不累加——整条估算
     * 一直是死的，界面显示 ¥0.00。
     *
     * 只累加**下降**的部分 —— 充值会让余额上升，不能拿来抵消消耗。
     * 局限写在明处：余额是账户级的，多会话或多设备同时用会一起下降，
     * 因此这个数字是**估算**，界面必须标注。
     */
    function makeBalanceTracker() {
      let last = null
      let spent = 0
      return {
        /** 喂一次钱包表，返回累计估算消耗（元）。 */
        observe(wallets) {
          const value = wallets instanceof Map ? Number(wallets.get('CNY')) : NaN
          if (!Number.isFinite(value)) return spent
          if (last !== null && value < last) spent += last - value
          last = value
          return spent
        },
        /** 当前估算消耗（元；显示前要按 FIXED_FX 折成美元）。 */
        get value() { return spent },
        /** 是否已有过基准读数。 */
        get primed() { return last !== null },
      }
    }

    /** 读气泡页配置；缺失或损坏时回到默认两页。 */
    function loadBubblePages() {
      try {
        const raw = JSON.parse(localStorage.getItem(BUBBLE_CFG_KEY) ?? 'null')
        if (Array.isArray(raw) && raw.length > 0 && raw.every(
          page => Array.isArray(page) && page.every(line => typeof line === 'string'),
        )) return raw
      } catch { /* 配置损坏：回到默认 */ }
      return DEFAULT_BUBBLE_PAGES
    }

    /** 存气泡页配置。 */
    function saveBubblePages(pages) {
      try { localStorage.setItem(BUBBLE_CFG_KEY, JSON.stringify(pages)) } catch { /* 隐私模式：忽略 */ }
    }

    /** 行以该前缀开头时按图片渲染（支持 http(s) URL 与 data URI）。 */
    const IMAGE_PREFIX = 'img:'

    const MODULE_KEY = 'dsh-tidewatch.modules'

    /** 读模块库（收藏的常用行）。 */
    function loadModules() {
      try {
        const raw = JSON.parse(localStorage.getItem(MODULE_KEY) ?? 'null')
        if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) return raw
      } catch { /* 配置损坏：回到空库 */ }
      return []
    }

    /** 存模块库。 */
    function saveModules(list) {
      try { localStorage.setItem(MODULE_KEY, JSON.stringify(list)) } catch { /* 隐私模式：忽略 */ }
    }

    /**
     * 行内可用 `||` 并列多段，出泡时随机取一段。参考插件做的是 A/B 加权出泡，
     * 这里取等概率，语义更直白。
     * @param line - 可能含 `||` 的模板行。
     * @returns 抽中的那一段；不含 `||` 时原样返回。
     */
    function pickVariant(line) {
      const parts = String(line).split('||').map(part => part.trim()).filter(part => part.length > 0)
      if (parts.length <= 1) return line
      return parts[Math.floor(Math.random() * parts.length)]
    }

    /**
     * 把模板行里的 {占位符} 换成实时值；未知占位符原样保留，便于用户看出写错了。
     * @param line - 含占位符的模板文本。
     * @param values - 占位符名到当前值的映射。
     */
    function fillTemplate(line, values) {
      return line.replace(/\{(\w+)\}/g, (whole, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
      ))
    }

    // ── 挂件定位（拖拽 / 吸附 / 持久化）──────────────────────────────────

    const POS_KEY = 'dsh-tidewatch.pos'
    /** 挂件与视口边缘的安全距离（px）。 */
    const EDGE = 12
    /**
     * 把挂件坐标钳进视口。挂件存的是视口绝对坐标，窗口一变（全屏 ↔ 小窗）旧坐标就
     * 可能落在视野外，表现为「挂件消失了」。纯函数，便于自检断言。
     * @param pos - 目标坐标（视口坐标系）。
     * @param viewport - 视口宽高。
     * @param size - 挂件宽高。
     * @returns 钳制后的坐标。
     */
    function clampToViewport(pos, viewport, size) {
      return {
        left: Math.min(Math.max(pos.left, EDGE), Math.max(EDGE, viewport.width - size.width - EDGE)),
        top: Math.min(Math.max(pos.top, EDGE), Math.max(EDGE, viewport.height - size.height - EDGE)),
      }
    }

    /** 松手时距左右边缘多近才吸附（px）；超过这个距离就停在原地。 */
    const SNAP_PX = 48

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
      '.tw-dot{flex:none;width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 4px color-mix(in srgb,currentColor 18%,transparent)}',
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
      '.tw-total-label{display:inline-flex;align-items:center;gap:6px;flex:none;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,#c5c5c5)}',
      '.tw-total-arrow{flex:none;font-size:9px;color:var(--dsw-alias-label-tertiary,#9b9b9b);transition:transform .15s ease}',
      '.tw-total.open .tw-total-arrow{transform:rotate(90deg)}',
      '.tw-total-val{flex:none;white-space:nowrap;font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary,#e8e8e8);font-variant-numeric:tabular-nums}',
      '.tw-num-roll{display:inline-block;animation:tw-num-in .32s ease}',
      '@keyframes tw-num-in{from{opacity:.35;transform:translateY(.35em)}to{opacity:1;transform:none}}',
      // 账户余额区块：充值 / 礼金 / 合计三行 + 读数时刻小字。
      '.tw-balance{margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,#444)}',
      '.tw-balance-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0;font-size:12px}',
      '.tw-balance-label{color:var(--dsw-alias-label-secondary,#c5c5c5)}',
      '.tw-balance-val{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8);font-variant-numeric:tabular-nums}',
      '.tw-balance-sum{font-size:14px}',
      '.tw-balance-note{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      // 数字滚动：每位一列 0-9，靠 transform 纵向滚动到目标数字。
      // 不适用态（非 DeepSeek 模型）：胶囊与说明文字转中性色，避免被读成峰/谷档。
      // 形象挂件：图片 + 右下角金额角标。
      '.tw-mascot{position:relative;display:block;padding:0;border:0;background:transparent;cursor:grab}',
      '.tw-mascot-img{display:block;width:92px;height:auto;filter:drop-shadow(0 4px 10px rgba(0,0,0,.35));transition:transform .18s ease;user-select:none;-webkit-user-drag:none}',
      '.tw-mascot:hover .tw-mascot-img{transform:translateY(-2px) scale(1.04)}',
      '.tw-mascot.peak .tw-mascot-img{filter:drop-shadow(0 0 10px rgba(224,96,60,.55))}',
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
      '.tw-widget.tw-dragging{transition:none;cursor:grabbing}',
      '.tw-widget.tw-dragging .tw-mascot-img{transform:scale(1.04)}',
      '.tw-widget.tw-flip .tw-bubble-pop,.tw-widget.tw-flip .tw-panel-pop{right:auto;left:0}',
      // 胶囊形态：dock 行里的一枚小徽章，位置由官方布局决定，自己不定位。
      '.tw-capsule-wrap{position:relative;display:inline-flex;align-items:center}',
      '.tw-capsule{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border:1px solid var(--dsw-alias-border-l1,#444);border-radius:999px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,#c5c5c5);font:inherit;font-size:11px;line-height:18px;cursor:pointer}',
      '.tw-capsule:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.tw-capsule.peak{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#e0603c) 45%,transparent)}',
      '.tw-capsule-phase{font-weight:600}',
      '.tw-capsule-countdown{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '.tw-capsule-cost{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.tw-capsule-wrap .tw-panel-pop{right:0;bottom:calc(100% + 10px)}',
      // 轻量泡泡：比完整面板窄，行间留白，底部是详情入口。
      '.tw-panel-bar{display:flex;justify-content:flex-end;margin:-4px -4px 2px 0}',
      '.tw-panel-close{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9b9b9b);font:inherit;font-size:14px;line-height:20px;cursor:pointer}',
      '.tw-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.tw-panel-pop{position:absolute;right:0;bottom:calc(100% + 10px);width:320px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;padding:10px 12px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#1b1f30);border:1px solid var(--dsw-alias-border-l1,#3a4360);box-shadow:0 12px 32px rgba(0,0,0,.5);z-index:12;animation:tw-pop .18s ease}',
      '.tw-bubble-pop::after{content:\'\';position:absolute;right:41px;bottom:-5px;width:10px;height:10px;background:var(--dsw-alias-bg-layer-1,#1b1f30);border-right:1px solid var(--dsw-alias-border-l1,#3a4360);border-bottom:1px solid var(--dsw-alias-border-l1,#3a4360);transform:rotate(45deg)}',
      '.tw-widget.tw-flip .tw-bubble-pop::after{left:41px;right:auto}',
      '.tw-bubble-pop{position:absolute;right:0;bottom:calc(100% + 12px);width:210px;padding:12px 16px;border-radius:22px;background:var(--dsw-alias-bg-layer-1,#1b1f30);border:1px solid var(--dsw-alias-border-l1,#3a4360);box-shadow:0 10px 28px rgba(0,0,0,.5);z-index:10;cursor:pointer;transition:opacity .2s ease,transform .2s ease}',
      '.tw-bubble-out{opacity:0;transform:translateY(6px) scale(.97);pointer-events:none}',
      '.tw-bubble-line{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-primary,#e8e8e8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tw-bubble-line:first-child{font-weight:600}',
      '.tw-editor{margin-top:6px;display:flex;flex-direction:column;gap:6px}',
      '.tw-editor-page{border:1px solid var(--dsw-alias-border-l1,#3a4360);border-radius:8px;padding:6px}',
      '.tw-editor-head{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '.tw-mini{padding:0 6px;border:1px solid var(--dsw-alias-border-l1,#3a4360);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#c5c5c5);font:inherit;font-size:10px;line-height:16px;cursor:pointer}',
      '.tw-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15))}',
      '.tw-mini:disabled{opacity:.4;cursor:default}',
      '.tw-editor-row{display:flex;align-items:center;gap:4px;margin-top:4px}',
      '.tw-editor-row .tw-editor-input{margin-top:0;flex:1;min-width:0}',
      '.tw-grip{flex:none;cursor:grab;color:var(--dsw-alias-label-tertiary,#9b9b9b);font-size:11px;line-height:1;user-select:none}',
      '.tw-grip:active{cursor:grabbing}',
      '.tw-editor-head[draggable]:hover,.tw-editor-row[draggable]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
      '.tw-editor-input{width:100%;box-sizing:border-box;margin-top:4px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#3a4360);background:var(--dsw-alias-bg-layer-1,#161a2c);color:var(--dsw-alias-label-primary,#e8e8e8);font:inherit;font-size:11px;line-height:18px}',
      '.tw-editor-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4d9fff)}',
      '.tw-editor-actions{display:flex;gap:6px;margin-top:5px}',
      '.tw-bubble-img{display:block;max-width:100%;margin:4px 0;border-radius:8px}',
      '.tw-editor-modules{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;max-height:74px;overflow:auto}',
      '.tw-module-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 4px;border:1px solid var(--dsw-alias-border-l1,#3a4360);border-radius:6px;font-size:10px;color:var(--dsw-alias-label-secondary,#c5c5c5);max-width:100%}',
      '.tw-module-text{max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tw-editor-hint{margin-top:2px;font-size:10px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#9b9b9b)}',
      '@keyframes tw-pop{from{opacity:0;transform:translateY(4px) scale(.97)}to{opacity:1;transform:none}}',
      '.tw-bubble-diag{font-size:10px;color:var(--dsw-alias-label-tertiary,#9b9b9b);font-variant-numeric:tabular-nums}',
      '.tw-bubble-more{margin-top:4px;width:100%;padding:2px 0;border:0;border-top:1px solid var(--dsw-alias-border-l1,#444);background:transparent;color:var(--dsw-alias-state-business-primary,#4d9fff);font:inherit;font-size:11px;cursor:pointer;text-align:right}',
      '.tw-bubble-more:hover{text-decoration:underline}',
      // 锚定态：容器只有面板这一个绝对定位子元素（自身宽度为 0），面板须改以左缘
      // 对齐容器左缘——配合视口钳制，面板在窄屏（手机）也不会横向出界。
    ].join('\n')

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', CSS_TAG_ID)
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ── 数据探针（session 插槽）：订阅投影写入 bridge，渲染 null ────────────

    /**
     * 探针挂载序号。会话切换时新探针会拿到更大的号；
     * 只有号最大的那个有权写桥，旧会话的探针即使还在后台跑，
     * 它的投影更新也不会再把上一场的数字写回界面。
     */
    let latestProbeOrder = 0

    function Probe(props) {
      const sessionId = props.sessionId
      const usage = props.useProjection ? props.useProjection('costUsage') : undefined
      // 挂载时领一个序号；比它大的出现即意味着自己已不是当前会话。
      const orderRef = useRef(0)
      if (orderRef.current === 0) orderRef.current = ++latestProbeOrder
      // 会话插槽按 sessionId 作为 React key 渲染：会话切换 = 组件卸载重挂。
      //
      // 挂载时**无条件**把桥改写成「本会话」的值。旧写法只在「桥上那条已不属于
      // 任何活跃会话」时才清，于是新建会话时会跳过清桥：上一场的额度留在界面上，
      // 直到本会话产生第一次调用才被顶掉。用户看到的就是「空会话还显示上次的花费」。
      //
      // 改写而不是清空：新会话的投影值本来就是空的，写进去就等于清零，
      // 也不会误伤别的会话——各会话的探针只会写自己那一条。
      useEffect(() => {
        if (orderRef.current === latestProbeOrder) bridge.set({ sessionId, usage: usage ?? null })
      }, [])
      // 归属申报：本会话存活期间一直持有，卸载（会话切走）即撤回。
      useEffect(() => {
        claims.add(sessionId)
        return () => { claims.delete(sessionId) }
      }, [sessionId])
      // 依赖 sessionId + usage：两者任一变化都重写桥，并携带归属会话 id。
      // 诊断：把探针实际拿到的东西记下来。用法取不到投影时，这组字段能指明
      // 是 props 没这个钩子、钩子返回空、还是压根没挂载。
      const rawDiag = {
        hasHook: typeof props.useProjection === 'function',
        returned: usage === undefined ? 'undefined' : usage === null ? 'null' : 'value',
        props: Object.keys(props).slice(0, 8).join(','),
      }
      useEffect(() => {
        if (orderRef.current === latestProbeOrder) bridge.set({ sessionId, usage: usage ?? null, rawDiag })
      }, [sessionId, usage])
      return null
    }

    // ── 悬浮徽章（shell.overlay）：订阅 bridge 渲染 ─────────────────────────

    // ── 形态偏好：立绘挂件 / 胶囊徽章 ───────────────────────────────────────
    // 两种形态同时挂载，由这个偏好决定谁渲染内容。切换靠订阅即时生效，不用刷新；
    // 两种卡片都只在自己被选中时才跑余额轮询与计时器，避免双份开销。
    const FORM_KEY = 'dsh-tidewatch.form'
    let formValue = (() => {
      try { return localStorage.getItem(FORM_KEY) === 'capsule' ? 'capsule' : 'mascot' } catch { return 'mascot' }
    })()
    const formListeners = new Set()
    /** 当前形态。 */
    function currentForm() { return formValue }
    /** 切换形态并通知所有挂载中的卡片；同值不重复通知。 */
    function setForm(next) {
      const value = next === 'capsule' ? 'capsule' : 'mascot'
      if (value === formValue) return
      formValue = value
      try { localStorage.setItem(FORM_KEY, value) } catch { /* 隐私模式：只影响本次会话 */ }
      for (const fn of [...formListeners]) fn(value)
    }
    /** 订阅形态变化，返回退订函数。 */
    function subscribeForm(fn) {
      formListeners.add(fn)
      return () => { formListeners.delete(fn) }
    }

    function TideCard(props) {
      /** 'mascot'（立绘挂件）或 'capsule'（dock 行内胶囊徽章）。 */
      const variant = props.variant === 'capsule' ? 'capsule' : 'mascot'
      const isMascot = variant === 'mascot'
      const [form, setFormState] = useState(currentForm)
      const active = form === variant
      useEffect(() => subscribeForm(setFormState), [])
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
      /**
       * 官方 tokenUsage 投影的采样值（账号内置通道下这是唯一可用的用量来源）。
       * 由宿主侧监听到结算事件后采样，随投影视图下发；客户端订阅不到官方投影本身。
       */
      const official = usage !== null && usage.official != null ? usage.official : null
      /**
       * 诊断只在真出问题时露头：整场会话一条用量都没收到，才算异常。
       * 正常会话里有几十上百条事件不带 usage 属于常态，不该让排障信息常驻界面。
       */
      const diagWorthShowing = usage === null
        || (Number(usage.diag?.message) || 0) + (Number(usage.diag?.attempt) || 0) === 0
        || (Number(usage.diag?.usageFound) || 0) === 0
        // 桥里没有会话 id 却显示着金额：典型的「空会话残留上一场」
        || (bridgeSessionId === undefined && (Number(usage.cost) || 0) > 0)
      /**
       * 桥里那条会话 id 的短标识。新会话若仍显示上一场的额度，
       * 看这里就能分清：id 没变 = 探针没重挂/没改写桥；id 变了但金额没变 = 投影返回了旧值。
       */
      const bridgeIdShort = bridgeSessionId === undefined
        ? '无'
        : String(bridgeSessionId).slice(0, 6)
      /** 探针实况：用法取不到投影时靠它定位。 */
      const rawDiag = snap !== null ? (snap.rawDiag ?? null) : null
      // 订阅桥：会话侧探针写入后重渲染。
      // v1.9.1 重写拖拽时误删了这一行，此后挂件只在挂载时读一次桥的初始值，
      // 投影数据到达也不会重渲染，表现为金额与 token 一直是零。
      useEffect(() => bridge.subscribe(setSnap), [])

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
      /**
       * 余额差值追踪器：账号内置通道不提供 usage，改用「余额下降了多少」估算本会话消耗。
       * 用 ref 跨渲染存活；余额是账户级的，故结果只是估算（界面会标注）。
       */
      const balanceTracker = useRef(null)
      if (balanceTracker.current === null) balanceTracker.current = makeBalanceTracker()
      const rootRef = useRef(null)
      // 胶囊在官方 dock 插槽里行内渲染；chipWrapRef 是它的包裹元素（外点关闭的
      // 「内部」判定基准），inlinePos 是展开面板的锚定坐标。
      const chipWrapRef = useRef(null)

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
        // 只有当前形态在轮询：另一种形态同时挂着，不许它再来一份定时器。
        if (!active) return undefined
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
      }, [props.account, active])

      /** 音效总开关，持久化在 localStorage。 */
      const [soundOn, setSoundOn] = useState(() => loadFlag(SOUND_KEY, true))

      /** 挂件位置（视口坐标）；null = 首帧走默认右下角，之后由拖拽决定。 */
      const [pos, setPos] = useState(loadPos)
      /** 是否正在拖动：用于关掉位移过渡、切换光标。 */
      const [dragging, setDragging] = useState(false)
      /** 吸附到哪一侧：'left' 时内容镜像排列，读起来仍顺。 */
      const [snapped, setSnapped] = useState(null)
      /** 气泡页配置：可在编辑器里改，改完即持久化。 */
      const [bubblePages, setBubblePages] = useState(loadBubblePages)
      /** 编辑器是否展开。 */
      const [editing, setEditing] = useState(false)
      /** 模块库：收藏的常用行。 */
      const [modules, setModules] = useState(loadModules)
      /** 把一行收进模块库（重复的不收）。 */
      const addModule = line => {
        const text = String(line).trim()
        if (text.length === 0 || modules.includes(text)) return
        const next = [...modules, text]
        setModules(next)
        saveModules(next)
      }
      /** 从模块库移除一行。 */
      const removeModule = line => {
        const next = modules.filter(item => item !== line)
        setModules(next)
        saveModules(next)
      }
      /** 写入新配置并持久化：写盘做 300ms 防抖，避免每敲一个字都落一次 localStorage。 */
      const saveTimer = useRef(0)
      const updatePages = next => {
        setBubblePages(next)
        clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => saveBubblePages(next), 300)
      }
      /** 改某一页的某一行。 */
      const updateLine = (pageIndex, lineIndex, value) => updatePages(
        bubblePages.map((page, i) => (i !== pageIndex ? page : page.map((line, j) => (j === lineIndex ? value : line)))),
      )
      /** 该页加一行空模板。 */
      const addLine = pageIndex => updatePages(
        bubblePages.map((page, i) => (i !== pageIndex ? page : [...page, ''])),
      )
      /** 删掉该页最后一行（至少保留一行）。 */
      const removeLine = pageIndex => updatePages(
        bubblePages.map((page, i) => (i !== pageIndex || page.length <= 1 ? page : page.slice(0, -1))),
      )
      /** 追加一页。 */
      const addPage = () => updatePages([...bubblePages, ['{phase} · {countdown}', '{cost}']])
      /** 删掉某一页（至少保留一页）。 */
      const removePage = pageIndex => {
        if (bubblePages.length <= 1) return
        updatePages(bubblePages.filter((_, i) => i !== pageIndex))
        setBubbleIndex(0)
      }
      /** 上下移动某一页。 */
      const movePage = (pageIndex, delta) => {
        const to = pageIndex + delta
        if (to < 0 || to >= bubblePages.length) return
        const next = [...bubblePages]
        const moved = next[pageIndex]
        next[pageIndex] = next[to]
        next[to] = moved
        updatePages(next)
        setBubbleIndex(0)
      }
      /** 编辑器内拖拽排序的暂存：{ kind: 'page' | 'line', page, line }。 */
      const dragItemRef = useRef(null)
      /** 把某一页从 from 移到 to。 */
      const movePageTo = (from, to) => {
        if (from === null || from === to || from < 0 || to < 0) return
        if (from >= bubblePages.length || to >= bubblePages.length) return
        const next = [...bubblePages]
        const moved = next.splice(from, 1)[0]
        next.splice(to, 0, moved)
        updatePages(next)
        setBubbleIndex(0)
      }
      /** 把某一页里的某一行从 from 移到 to。 */
      const moveLineTo = (pageIndex, from, to) => {
        if (from === null || from === to) return
        updatePages(bubblePages.map((page, i) => {
          if (i !== pageIndex) return page
          if (from < 0 || from >= page.length || to < 0 || to >= page.length) return page
          const copy = [...page]
          const moved = copy.splice(from, 1)[0]
          copy.splice(to, 0, moved)
          return copy
        }))
      }
      /** 恢复内置默认两页。 */
      const resetPages = () => {
        updatePages(DEFAULT_BUBBLE_PAGES.map(page => [...page]))
        setBubbleIndex(0)
      }
      /** 当前显示第几页。 */
      const [bubbleIndex, setBubbleIndex] = useState(0)
      /** 页数镜像：拖拽 effect 只挂一次，翻页时要读最新页数。 */
      const bubbleCountRef = useRef(1)
      bubbleCountRef.current = Math.max(1, bubblePages.length)
      /** 气泡是否正在显示：点立绘出现，几秒后自动收起。 */
      const [bubbleShown, setBubbleShown] = useState(false)
      const bubbleTimer = useRef(0)
      /**
       * 点插件之外的地方就收起气泡。用捕获阶段监听，先于页面自身的处理，
       * 目标落在挂件（立绘或气泡）内则不动。
       */
      useEffect(() => {
        if (!bubbleShown) return undefined
        const onDocDown = event => {
          const target = event.target
          if (target !== null && typeof target.closest === 'function'
            && target.closest('.tw-widget') !== null) return
          clearTimeout(bubbleTimer.current)
          setBubbleShown(false)
        }
        document.addEventListener('pointerdown', onDocDown, true)
        return () => document.removeEventListener('pointerdown', onDocDown, true)
      }, [bubbleShown])

      /** 让气泡出现并重置自动收起计时。 */
      const showBubble = useCallback(() => {
        setBubbleIndex(0)
        setBubbleShown(true)
        clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setBubbleShown(false), BUBBLE_MS)
      }, [])
      /** 卸载时清掉计时器。 */
      useEffect(() => () => clearTimeout(bubbleTimer.current), [])
      /** 音效开关的 ref 镜像：拖拽 effect 只挂一次，需要读到最新值。 */
      const soundOnRef = useRef(soundOn)
      soundOnRef.current = soundOn
      /** 面板开合的 ref 镜像：同上，拖拽 effect 的闭包读不到新的 expanded。 */
      const expandedRef = useRef(expanded)
      expandedRef.current = expanded
      /**
       * 把位置钳进当前视口。挂件存的是视口绝对坐标，窗口一变（全屏 ↔ 小窗）旧坐标
       * 就可能落在视野外，表现为「挂件消失了」。null 表示还没拖过，走默认右下角。
       */
      const clampPos = useCallback(candidate => {
        if (candidate === null) return null
        const node = chipWrapRef.current
        return clampToViewport(
          candidate,
          { width: window.innerWidth, height: window.innerHeight },
          { width: node === null ? 92 : node.offsetWidth, height: node === null ? 92 : node.offsetHeight },
        )
      }, [])

      /** 窗口尺寸变化（含进出全屏）时重新钳位；挂载时也钳一次。 */
      useEffect(() => {
        const onResize = () => setPos(prev => clampPos(prev))
        window.addEventListener('resize', onResize)
        setPos(prev => clampPos(prev))
        return () => window.removeEventListener('resize', onResize)
      }, [clampPos])

      /**
       * 挂件拖拽。三个要点，都是手感问题换来的：
       * 1) pointermove / pointerup 挂在 window 上，鼠标移出立绘范围也不会断拖（也不用
       *    setPointerCapture —— 它会改掉之后 click 的 target，按钮就点不动了）；
       * 2) 拖动期间给挂件加 tw-dragging，关掉位移过渡，否则每帧都被 transition 拖慢；
       * 3) 松手只在距离左右边缘 SNAP_PX 以内才吸附，拖到中间就停在原地。
       * 位移小于 4px 视为点击。
       */
      useEffect(() => {
        // 只有立绘形态才能拖：胶囊徽章长在 dock 行里，位置由官方布局决定。
        if (!isMascot || !active) return undefined
        const node = chipWrapRef.current
        if (node === null) return undefined
        let dragging = false
        let moved = false
        let startX = 0
        let startY = 0
        let startLeft = 0
        let startTop = 0

        const detach = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }

        function onMove(e) {
          if (!dragging) return
          const dx = e.clientX - startX
          const dy = e.clientY - startY
          if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
          if (!moved) {
            moved = true
            setDragging(true)
          }
          const r = node.getBoundingClientRect()
          const maxLeft = Math.max(EDGE, window.innerWidth - r.width - EDGE)
          const maxTop = Math.max(EDGE, window.innerHeight - r.height - EDGE)
          setPos({
            left: Math.min(Math.max(startLeft + dx, EDGE), maxLeft),
            top: Math.min(Math.max(startTop + dy, EDGE), maxTop),
          })
        }

        function onUp(e) {
          if (!dragging) return
          dragging = false
          detach()
          setDragging(false)
          if (!moved) {
            const target = e === undefined ? null : e.target
            const closest = sel => (target !== null && typeof target.closest === 'function'
              ? target.closest(sel) : null)
            // 面板内部交给它自己的按钮。
            if (closest('.tw-panel-pop') !== null) return
            // 点气泡 = 翻页（「详情」按钮除外）。这里不走气泡的 onClick：
            // pointerdown 里的 preventDefault 会连带取消后续的 click 事件。
            if (closest('.tw-bubble-pop') !== null) {
              if (closest('.tw-bubble-more') !== null) return
              setBubbleIndex(index => (index + 1) % bubbleCountRef.current)
              clearTimeout(bubbleTimer.current)
              bubbleTimer.current = setTimeout(() => setBubbleShown(false), BUBBLE_MS)
              return
            }
            // 面板开着时，点立绘先收起面板（README 的使用说明如此承诺）；
            // 面板没开才呼叫气泡。气泡本身仍然「再点不收起」——那是 1.12.0 定的规则。
            if (expandedRef.current) {
              applyExpanded(false)
              return
            }
            if (soundOnRef.current) playTone('tap')
            showBubble()
            return
          }
          const r = node.getBoundingClientRect()
          let left = r.left
          let side = null
          if (r.left <= SNAP_PX) {
            left = EDGE
            side = 'left'
          } else if (window.innerWidth - r.right <= SNAP_PX) {
            left = Math.max(EDGE, window.innerWidth - r.width - EDGE)
            side = 'right'
          }
          const next = { left, top: r.top }
          setPos(next)
          setSnapped(side)
          savePos(next)
        }

        const onDown = e => {
          if (e.button !== 0) return
          // 面板内部放行：那里的 pointerdown 不能被 preventDefault 掉，
          // 否则会阻止编辑器里 draggable 元素的 HTML5 拖放启动（拖不动页与行）。
          const target = e.target
          if (target !== null && typeof target.closest === 'function'
            && target.closest('.tw-panel-pop') !== null) return
          e.preventDefault()
          const r = node.getBoundingClientRect()
          startX = e.clientX
          startY = e.clientY
          startLeft = r.left
          startTop = r.top
          moved = false
          dragging = true
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
          window.addEventListener('pointercancel', onUp)
        }

        node.addEventListener('pointerdown', onDown)
        return () => {
          node.removeEventListener('pointerdown', onDown)
          detach()
        }
      }, [isMascot, active])

      useEffect(() => {
        if (!active) return undefined
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
      }, [active])
      /** 展开态写入（含 localStorage 持久化）：手动切换与外点关闭共用。 */
      const applyExpanded = useCallback(next => {
        setExpanded(next)
        try { localStorage.setItem(EXPANDED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      }, [])
      // 外点关闭：官方 useDismissOnOutsidePointer（pointerdown）优先，
      // 原语不可用时降级到同签名的自研实现。胶囊与面板分处两个容器
      // （dock 插槽 / body），故把面板容器作为 portal 参数一并算作「内部」。
      useDismissOutside(chipWrapRef, expanded && active, applyExpanded, rootRef)
      const phase = nextPhase(now)
      const inPeak = phase !== null && phase.inPeak
      const countdown = phase === null ? 0 : Math.max(0, phase.nextAtMs - now)
      const nextLabel = phase === null ? '下一阶段' : (phase.nextIntoPeak ? '峰期' : '谷期')
      // 自有投影算出的金额；账号内置通道下它是 0，于是回退到 DSH 官方的 tokenUsage。
      const ownCost = Number(usage?.cost) || 0
      const officialBuckets = official === null ? null : {
        input: Number(official.uncachedInputTokens) || 0,
        output: Number(official.outputTokens) || 0,
        cacheRead: Number(official.cacheReadTokens) || 0,
        cacheWrite: Number(official.cacheWriteTokens) || 0,
      }
      const officialTokenTotal = officialBuckets === null ? 0
        : officialBuckets.input + officialBuckets.output + officialBuckets.cacheRead + officialBuckets.cacheWrite
      /** 自有金额为 0 而官方 token 有值时，改用官方 token 计价。 */
      const useOfficialTokens = ownCost === 0 && officialTokenTotal > 0
      /**
       * 官方 token × 本插件价目表折成美元（与宿主 costOf 同一套公式：
       * 未命中输入按 cacheMiss、输出按 output、缓存读写按 cacheHit）。
       * 官方 outputTokens 已含推理，故不另计 reasoning。
       */
      const officialCost = (() => {
        if (!useOfficialTokens) return 0
        const key = priceEntryForModel(usage?.model ?? '', now)
        const price = DISPLAY_PRICES[key]
        const tier = inPeak ? price.peak : price.offPeak
        return (officialBuckets.input / 1e6) * tier.cacheMiss
          + (officialBuckets.output / 1e6) * tier.output
          + ((officialBuckets.cacheRead + officialBuckets.cacheWrite) / 1e6) * tier.cacheHit
      })()
      /**
       * 账号内置通道 + 两条 token 路都空时，退到余额差值估算。
       * 只在这一种情形下启用，其余情况仍走 token × 价目表的精准计价。
       */
      const accountChannel = usage !== null && usage.provider === 'deepseek-account'
      const usingBalanceEstimate = accountChannel && ownCost === 0 && !useOfficialTokens
        && balanceTracker.current.primed
      // 追踪器记的是人民币，显示层统一收美元再乘 FIXED_FX；这里先折回美元，
      // 否则人民币估值会被当成美元，显示时再乘一次 6.67。
      const estimatedUsd = usingBalanceEstimate ? balanceTracker.current.value / FIXED_FX : 0
      const costUsd = useOfficialTokens
        ? officialCost
        : usingBalanceEstimate ? estimatedUsd : ownCost

      // 余额每次变化都喂给追踪器；只有下降才累加，充值不会被当成负消耗。
      // 传整张钱包表：追踪器自己按币种取数，调用方不必记住「只算人民币」。
      useEffect(() => {
        if (wallet === null || wallet.status !== 'ready') return
        balanceTracker.current.observe(wallet.total)
      }, [wallet])

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
      // 会话换成非 DeepSeek 模型后，前面已经计过价的调用仍然是真金白银：
      // 总额不能因为「最后一个模型不适用」就整块变成「不适用」。
      // 峰谷徽章与价目表仍按当前模型走（那是"此刻"的信息）。
      const hasPricedSpend = ownCost > 0
      const costShown = applies || hasPricedSpend
      const modelKey = priceEntryForModel(activeModel, now)
      const price = DISPLAY_PRICES[modelKey]
      const tier = inPeak ? price.peak : price.offPeak
      // 展示用人民币档：官方中文页数字；展示时不做汇率换算（与 pricing.js 同口径）。
      const tierRmb = price.rmb !== undefined ? (inPeak ? price.rmb.peak : price.rmb.offPeak) : undefined
      const slotIdx = beijingSlotIndex(now)
      const weekend = isWeekend(now)
      const holiday = isCnHolidayAt(now)
      const input = useOfficialTokens ? officialBuckets.input : (Number(usage?.input) || 0)
      const cache = useOfficialTokens
        ? officialBuckets.cacheRead + officialBuckets.cacheWrite
        : (Number(usage?.cacheRead) || 0) + (Number(usage?.cacheWrite) || 0)
      const output = useOfficialTokens ? officialBuckets.output : (Number(usage?.output) || 0)
      const reasoning = Number(usage?.reasoning) || 0

      // 折叠态胶囊：官方 Tooltip 包裹（原语缺失时 Tip 退化为原生 title）。
      // 不适用 DeepSeek 峰谷计价时收成「不适用 · —」：状态点转中性灰，不再显示峰谷与
      // 倒计时（这两项对非 DeepSeek 模型没有意义）。
      // 挂件本体：只有社区形象（峰期换一只），点一下出泡泡。
      // 金额不挂在形象上——它全在泡泡与面板里；title 里留一份，悬停可见，也供回归测试读取。
      // 折叠态：立绘形态是一只可拖拽的形象；胶囊形态是 dock 行里的一枚小徽章，
      // 点一下直接开面板（不走气泡——气泡是立绘的玩法）。
      const chip = isMascot
        ? el('button', {
          className: 'tw-mascot' + (inPeak ? ' peak' : ''),
          // 点击由挂件的 pointerup 处理（见拖拽 effect），这里不再挂 onClick。
          // data-cost 不显示：供回归测试与无障碍读取，金额本身在泡泡与面板里。
          'data-cost': costShown ? fmtMoney(costUsd, currency) : '—',
          title: costShown
            ? (applies
              ? (inPeak ? '峰期 · 距' + nextLabel + ' ' + fmtCountdown(countdown) : '谷期')
              : '当前模型不适用')
              + ' · ' + fmtMoney(costUsd, currency)
            : '不适用',
        },
          el('img', {
            className: 'tw-mascot-img',
            src: MASCOT_SPRITES[inPeak ? 'think' : 'idle'],
            alt: '潮汐挂件',
            draggable: false,
          }))
        : el('button', {
          className: 'tw-capsule' + (inPeak ? ' peak' : ''),
          'data-cost': costShown ? fmtMoney(costUsd, currency) : '—',
          title: costShown
            ? (applies
              ? (inPeak ? '峰期 · 距' + nextLabel + ' ' + fmtCountdown(countdown) : '谷期')
              : '当前模型不适用')
              + ' · ' + fmtMoney(costUsd, currency)
            : '不适用',
          onClick: () => applyExpanded(!expanded),
        },
          el(PhaseDot, { inPeak, size: 8, state: applies ? undefined : 'idle' }),
          el('span', { className: 'tw-capsule-phase' }, applies ? (inPeak ? '峰' : '谷') : '—'),
          applies ? el('span', { className: 'tw-capsule-countdown' }, fmtCountdown(countdown)) : null,
          el('span', { className: 'tw-capsule-cost' }, costShown ? fmtMoney(costUsd, currency) : '—'))

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
          // 表过期后数字仍然「看起来正常」，所以要主动说明，不能让人对着错的数用下去。
          holidayTableExpired(now) ? el('div', { className: 'tw-empty-note' },
            '节假日表只覆盖到 ' + HOLIDAY_TABLE_LAST_YEAR + ' 年：之后各年的法定节假日仍按工作日计价，'
            + '金额与倒计时都会偏，请更新插件') : null,
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
              el('span', { className: 'tw-total-val' }, costShown
          ? el(RollingNumber, { text: fmtMoney(costUsd, currency) + (usingBalanceEstimate ? '（估算）' : '') })
          : '不适用')),
          }),
          // 非 DeepSeek 模型：说清费用为什么不估算（否则「不适用」会被当成 0 元）。
          // 混合会话里已有计价金额时，说明这笔钱只覆盖 DeepSeek 那部分。
          applies ? null : el('div', { className: 'tw-na-note' },
            hasPricedSpend
              ? '当前模型不走 DeepSeek 峰谷定价；以上金额只含本会话里已计价的 DeepSeek 调用'
              : '当前会话的模型不走 DeepSeek 峰谷定价，费用不在此估算'),
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
          // 形态开关：两种形态同时挂载，这里选谁显示；点了立刻生效，不用刷新。
          el('div', { className: 'tw-currency' },
            el('span', null, '形态'),
            el('button', {
              className: 'tw-currency-btn' + (form === 'mascot' ? ' on' : ''),
              onClick: () => setForm('mascot'),
            }, '立绘挂件'),
            el('button', {
              className: 'tw-currency-btn' + (form === 'capsule' ? ' on' : ''),
              onClick: () => setForm('capsule'),
            }, '胶囊徽章')),
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
          // 气泡编辑器：增删页与行、改模板、调序、恢复默认。
          el('div', { className: 'tw-currency' },
            el('span', null, '气泡'),
            el('button', {
              className: 'tw-currency-btn' + (editing ? ' on' : ''),
              onClick: () => setEditing(v => !v),
            }, editing ? '收起编辑' : '编辑')),
          editing ? el('div', { className: 'tw-editor' },
            bubblePages.map((page, pageIndex) => el('div', { key: pageIndex, className: 'tw-editor-page' },
              el('div', {
                className: 'tw-editor-head',
                draggable: true,
                onDragStart: event => {
                  dragItemRef.current = { kind: 'page', page: pageIndex, line: null }
                  event.dataTransfer.effectAllowed = 'move'
                },
                onDragOver: event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' },
                onDrop: event => {
                  event.preventDefault()
                  const from = dragItemRef.current
                  dragItemRef.current = null
                  if (from !== null && from.kind === 'page') movePageTo(from.page, pageIndex)
                },
              },
                el('span', { className: 'tw-grip', title: '拖动排序' }, '⠿'),
                el('span', null, '第 ' + (pageIndex + 1) + ' 页'),
                el('button', {
                  className: 'tw-mini',
                  disabled: pageIndex === 0,
                  onClick: () => movePage(pageIndex, -1),
                }, '↑'),
                el('button', {
                  className: 'tw-mini',
                  disabled: pageIndex === bubblePages.length - 1,
                  onClick: () => movePage(pageIndex, 1),
                }, '↓'),
                el('button', {
                  className: 'tw-mini',
                  disabled: bubblePages.length <= 1,
                  onClick: () => removePage(pageIndex),
                }, '×')),
              page.map((line, lineIndex) => el('div', {
                key: lineIndex,
                className: 'tw-editor-row',
                draggable: true,
                onDragStart: event => {
                  dragItemRef.current = { kind: 'line', page: pageIndex, line: lineIndex }
                  event.dataTransfer.effectAllowed = 'move'
                  event.stopPropagation()
                },
                onDragOver: event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' },
                onDrop: event => {
                  event.preventDefault()
                  event.stopPropagation()
                  const from = dragItemRef.current
                  dragItemRef.current = null
                  if (from !== null && from.kind === 'line' && from.page === pageIndex) {
                    moveLineTo(pageIndex, from.line, lineIndex)
                  }
                },
              },
                el('span', { className: 'tw-grip', title: '拖动排序' }, '⠿'),
                el('input', {
                  className: 'tw-editor-input',
                  value: line,
                  placeholder: '例如 余额 {balance}；并列随机用 A || B；放图用 img:https://…',
                  onChange: event => updateLine(pageIndex, lineIndex, event.target.value),
                }),
                el('button', {
                  className: 'tw-mini',
                  title: '收进模块库',
                  onClick: () => addModule(line),
                }, '☆'))),
              el('div', { className: 'tw-editor-actions' },
                el('button', { className: 'tw-mini', onClick: () => addLine(pageIndex) }, '+ 行'),
                el('button', { className: 'tw-mini', onClick: () => removeLine(pageIndex) }, '− 行')))),
            el('div', { className: 'tw-editor-actions' },
              el('button', { className: 'tw-mini', onClick: addPage }, '+ 加一页'),
              el('button', { className: 'tw-mini', onClick: resetPages }, '恢复默认')),
            modules.length > 0 ? el('div', { className: 'tw-editor-modules' },
              modules.map(item => el('span', { key: item, className: 'tw-module-chip' },
                el('button', {
                  className: 'tw-mini',
                  title: '插入到最后一页',
                  onClick: () => addLine(bubblePages.length - 1, item),
                }, '+'),
                el('span', { className: 'tw-module-text', title: item }, item),
                el('button', { className: 'tw-mini', title: '从模块库移除', onClick: () => removeModule(item) }, '×'))))
              : null,
            el('div', { className: 'tw-editor-hint' },
              '占位符：{phase} 峰谷 · {countdown} 倒计时 · {cost} 会话费用 · {balance} 余额 · {paid} 充值 · {bonus} 礼金 · {price} 档位 · {tokens} token'),
            el('div', { className: 'tw-editor-hint' },
              '玩法：一行里用 A || B 并列随机；一行写成 img:https://… 就渲染成图片；点 ☆ 把该行收进模块库'))
            : null,
        // 用量诊断：排障用，只在异常时显示。
        diagWorthShowing && usage !== null && usage.diag !== undefined
          ? el('div', { className: 'tw-editor-hint' },
            '用量诊断：结算事件 ' + (usage.diag.message + usage.diag.attempt) + ' 条'
            + '（message ' + usage.diag.message + ' / attempt ' + usage.diag.attempt + '）· 带用量 '
            + usage.diag.usageFound + ' 条')
          : null,
        // 官方 tokenUsage 投影是否可用：仅在用量异常时一并显示。
        diagWorthShowing ? el('div', { className: 'tw-editor-hint' },
          '官方投影 tokenUsage：' + (official === null
            ? '未取到（说明客户端没有暴露该投影）'
            : '输入 ' + (Number(official.uncachedInputTokens) || 0)
              + ' / 输出 ' + (Number(official.outputTokens) || 0)
              + ' / 缓存读 ' + (Number(official.cacheReadTokens) || 0)
              + ' / 缓存写 ' + (Number(official.cacheWriteTokens) || 0))
          + (useOfficialTokens ? ' · 正按官方 token 计价' : '')) : null,
      ]
      const tipLabel = '点击展开 / 收起峰谷详情'

      // 立绘：视口固定定位，位置由拖拽决定（首帧默认右下角），吸附侧做镜像。
      // 胶囊：位置交给官方 dock 行，自己不定位。
      const widgetStyle = isMascot
        ? (pos === null ? { right: EDGE, bottom: 96 } : { left: pos.left, top: pos.top })
        : undefined
      const panelBody = el('div', { className: 'tw-panel-pop' },
        // 顶部一行：靠右的关闭按钮（点形象、按 Esc、点外部也都能收起）。
        el('div', { className: 'tw-panel-bar' },
          el('button', {
            className: 'tw-panel-close',
            title: '收起',
            onClick: () => applyExpanded(false),
          }, '✕')),
        ...panelContent)
      // 气泡：把当前页的模板行填上实时值；点气泡翻页，「详情」进完整面板。
      // 通道不返回用量时（例如账号内置通道）如实标注，不用 ¥0.00 冒充免费。
      // 只有「标记缺失」且真的算不出任何金额时，才显示「未提供」。
  const usageMissing = usage !== null && usage.usageMissed === true && !useOfficialTokens && costUsd === 0
      // 一次性把「用量到底有没有到达」摊在气泡里，省得再靠猜。
      const usageDiagText = usage === null
        ? (rawDiag === null
          ? '无投影值（探针未挂载）'
          : '无投影值 · 桥 ' + bridgeIdShort + ' · 钩子 ' + (rawDiag.hasHook ? '有' : '无')
            + ' · 返回 ' + rawDiag.returned + ' · props ' + (rawDiag.props || '空'))
        : '桥 ' + bridgeIdShort + ' · 事件 ' + (Number(usage.diag?.message) || 0) + '/' + (Number(usage.diag?.attempt) || 0)
          + ' · 带用量 ' + (Number(usage.diag?.usageFound) || 0)
          + ' · 官方 ' + (official === null ? '无' : '有')
      const bubbleValues = {
        diag: usageDiagText,
        phase: applies ? (inPeak ? '峰期' : '谷期') : '不适用',
        countdown: applies ? fmtCountdown(countdown) : '—',
        cost: usingBalanceEstimate
          ? fmtMoney(estimatedUsd, currency) + '（估算）'
          : usageMissing ? '未提供' : costShown ? fmtMoney(costUsd, currency) : '—',
        balance: wallet !== null && wallet.status === 'ready' ? fmtWallets(wallet.total) : '—',
        paid: wallet !== null && wallet.status === 'ready' ? fmtWallets(wallet.paid) : '—',
        bonus: wallet !== null && wallet.status === 'ready' ? fmtWallets(wallet.bonus) : '—',
        price: price.label,
        tokens: usageMissing ? '未提供' : fmtTokens(input + cache + output + reasoning),
      }
      // 随机并列的结果只在「出泡或翻页」时抽一次：倒计时每秒都触发重渲染，
      // 若每次渲染都重新抽，气泡里的随机行会一秒变一次。
      const bubbleVariants = useMemo(
        () => (bubblePages[bubbleIndex] ?? []).map(line => pickVariant(line)),
        [bubbleIndex, bubblePages, bubbleShown],
      )
      const bubbleLines = bubbleVariants.map(line => fillTemplate(line, bubbleValues))
      const bubbleBody = el('div', {
        className: 'tw-bubble-pop' + (bubbleShown ? '' : ' tw-bubble-out'),
        title: '点一下翻页',
      },
        bubbleLines.map((line, i) => (
          line.startsWith(IMAGE_PREFIX)
            ? el('img', {
              key: i,
              className: 'tw-bubble-img',
              src: line.slice(IMAGE_PREFIX.length).trim(),
              alt: '',
              draggable: false,
              onError: event => { event.currentTarget.style.display = 'none' },
            })
            : el('div', { key: i, className: 'tw-bubble-line' }, line)
        )),
        // 诊断行独立于气泡模板渲染。模板页存在 localStorage 里，老用户升级后会
        // 一直沿用旧存档，加在默认模板里的占位符根本不会出现（这坑吃过一次）。
        // 只在异常时显示，正常会话里不打扰。
        diagWorthShowing ? el('div', { className: 'tw-bubble-line tw-bubble-diag' }, '诊断 ' + usageDiagText) : null,
        el('button', {
          className: 'tw-bubble-more',
          onClick: event => { event.stopPropagation(); setBubbleShown(false); applyExpanded(true) },
        }, '详情 ›'))
      // 没被选中的那种形态整棵子树都不渲染，避免占位与多余开销。
      if (!active) return null
      return el(React.Fragment, null,
        // 泡泡挂在挂件内部做绝对定位：不测量、不 portal，随挂件一起移动，也绝不会跑到别处。
        el('div', {
          ref: chipWrapRef,
          className: isMascot
            ? 'tw-widget' + (snapped === 'left' ? ' tw-flip' : '') + (dragging ? ' tw-dragging' : '')
            : 'tw-capsule-wrap' + (expanded ? ' open' : ''),
          style: widgetStyle,
        },
          isMascot ? el(Tip, { label: tipLabel, node: chip }) : chip,
          isMascot && !expanded ? bubbleBody : null,
          expanded ? panelBody : null))
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
      // 两种形态同时注册，由「形态」偏好决定谁渲染：切换即时生效，不用刷新。
      // 同一个组件，靠 inject 传 variant 区分外观——不另造两个包装组件，
      // 测试也就能直接用 variant 渲染任意一种。
      // 没被选中的那个整棵子树返回 null，也不跑余额轮询与计时器。
      slots.inject('conversation.composer.dock', () => slots.register(
        {
          name: 'conversation.composer.dock',
          id: 'dsh-tidewatch-capsule',
          order: 100,
          inject: () => ({ account: ctx.remote.account, variant: 'capsule' }),
        },
        TideCard,
      ))
      // 潮汐挂件：根级框架悬浮层 —— 右下角常驻、可拖拽吸附的立绘。
      // 数据仍由上面那个 dock 探针经 bridge 提供（root 插槽没有投影席位）。
      slots.inject('shell.overlay', () => slots.register(
        {
          name: 'shell.overlay',
          id: 'dsh-tidewatch',
          order: 101,
          // 账户服务经 props 交给组件：组件不碰 ctx，余额查询走这个句柄。
          inject: () => ({ account: ctx.remote.account, variant: 'mascot' }),
        },
        TideCard,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    // 仅供 test/verify.mjs 断言的纯函数出口；运行时不使用。
    exports.__testables = {
      clampToViewport, fillTemplate, pickVariant, makeBalanceTracker, holidayTableExpired,
      currentForm, setForm,
    }
    return module.exports
  },
})
