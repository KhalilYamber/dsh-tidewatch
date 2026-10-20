/**
 * 生成英文版插件包目录（en-dist/）。
 *
 *   node scripts/build-en.mjs          # 生成
 *   cd en-dist && npm pack             # 产出 dsh-tidewatch-en-<版本>.tgz
 *
 * 做法：读中文 lib/client.js，用一个极小的扫描器找出**真正的字符串字面量**
 * （跳过 `//` 与块注释，正确处理转义），把其中的中文按 scripts/en-dict.mjs
 * 精确替换成英文；index/pricing/assets 原样复制；package.json 与
 * cordis.patch.yml 换成英文包的元数据（包名 dsh-tidewatch-en、patch 行 id
 * tidewatch-en，与中文版并存时不会互相覆盖）。
 *
 * 门禁：出现含中文的字符串字面量却没有对应译文时直接报错退出（并指出是哪句），
 * 避免发出中英混杂的英文包。
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EN_DICT, EN_PACKAGE } from './en-dict.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'en-dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const CJK = /[\u4e00-\u9fff]/
const src = readFileSync(join(root, 'lib/client.js'), 'utf8')

/**
 * 扫描源码，返回全部字符串字面量（含中文的）。
 * @param code - 源码文本。
 * @returns {{ start: number, end: number, quote: string, value: string, line: number }[]}
 */
function cjkStringLiterals(code) {
  const out = []
  let i = 0
  let line = 1
  let state = 'code' // code | line | block | sq | dq | tpl
  let litStart = 0
  let quote = ''
  let value = ''
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (state === 'code') {
      if (c === '\n') { line += 1; i += 1; continue }
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') {
        state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl'
        quote = c
        litStart = i
        value = ''
        i += 1
        continue
      }
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; line += 1 }
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue }
      if (c === '\n') line += 1
      i += 1
      continue
    }
    // 字符串内部
    if (c === '\\') {
      const esc = code.slice(i, i + 2)
      value += esc
      i += 2
      continue
    }
    if (c === quote) {
      if (CJK.test(value)) {
        out.push({ start: litStart, end: i + 1, quote, value, line })
      }
      state = 'code'
      i += 1
      continue
    }
    if (c === '\n') line += 1
    value += c
    i += 1
  }
  return out
}

const dict = new Map(EN_DICT)
const literals = cjkStringLiterals(src)
const unknown = []
const edits = []
for (const lit of literals) {
  if (!dict.has(lit.value)) {
    unknown.push({ value: lit.value, line: lit.line })
    continue
  }
  const zh = lit.value
  const en = dict.get(zh)
  if (zh === en) continue
  // 按原引号类型转义：单引号串里转义 '，双引号串里转义 "，模板串转义 ` 与 ${。
  let body = en.replace(/\\/g, '\\\\')
  if (lit.quote === "'") body = body.replace(/'/g, "\\'")
  if (lit.quote === '"') body = body.replace(/"/g, '\\"')
  if (lit.quote === '`') body = body.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  edits.push({ start: lit.start, end: lit.end, text: lit.quote + body + lit.quote })
}

if (unknown.length > 0) {
  console.error('[build-en] 这些中文字面量还没有译文（scripts/en-dict.mjs）：')
  for (const item of unknown) console.error('  line ' + item.line + ': ' + JSON.stringify(item.value))
  process.exit(1)
}

// 从后往前替换，避免前面的编辑改变后面的偏移。
let out = src
for (const edit of edits.sort((a, b) => b.start - a.start)) {
  out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
}

// ── 目录与文件 ────────────────────────────────────────────────────────────
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'lib'), { recursive: true })
writeFileSync(join(outDir, 'lib/client.js'), out)
for (const file of ['lib/index.js', 'lib/pricing.js']) {
  cpSync(join(root, file), join(outDir, file))
}
cpSync(join(root, 'lib/assets'), join(outDir, 'lib/assets'), { recursive: true })

const enPkg = {
  ...pkg,
  name: EN_PACKAGE.name,
  description: EN_PACKAGE.description,
  dshhub: {
    ...pkg.dshhub,
    displayName: EN_PACKAGE.displayName,
    summary: EN_PACKAGE.summary,
  },
}
writeFileSync(join(outDir, 'package.json'), JSON.stringify(enPkg, null, 2) + '\n')

// patch 行 id 与包名都换成英文版，避免和中版同时安装时互相覆盖。
writeFileSync(
  join(outDir, 'cordis.patch.yml'),
  '# dsh-tidewatch-en bundle patch: English UI edition of dsh-tidewatch.\n'
  + '# Install either the Chinese or the English package, not both (each mounts one widget).\n'
  + '- insert:\n'
  + '    - id: ' + EN_PACKAGE.patchId + '\n'
  + '      name: ' + EN_PACKAGE.name + '\n',
)

for (const doc of ['LICENSE', 'README.en.md']) {
  if (existsSync(join(root, doc))) {
    cpSync(join(root, doc), join(outDir, doc === 'LICENSE' ? 'LICENSE' : 'README.md'))
  }
}

console.log('[build-en] en-dist/ 就绪（v' + pkg.version + '，替换 ' + edits.length + ' 个字面量）')
console.log('[build-en] 打包：cd en-dist && npm pack')
