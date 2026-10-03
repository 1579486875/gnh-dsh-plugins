#!/usr/bin/env node
/**
 * classify-data.mjs — 模组分类器只读后端
 *
 * 用法: node classify-data.mjs <action> ['base64:<json-args>' | '<json-args>']
 * 输出: 单行 JSON  { ok: true, data: {...} }  或  { ok: false, error: "..." }
 *
 * action:
 *   scan     全库扫描归类（规则计算 → 分组方案）
 *   check    内容校验（模组描述 vs 所在组主题词）
 *   explain  单模组诊断
 *   rules    分类规则维护（读写 rules.json）
 *
 * 设计原则：对 RimCrow / RimWorld 数据**全程只读**；唯一会写的是本插件自带的
 * rules/rules.json（分类规则表），它不属于 RimCrow 数据。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RULES_PATH = join(ROOT, 'rules', 'rules.json')

// ---------------------------------------------------------------- 路径发现
const HOME_CANDIDATES = [
  process.env.RIMCROW_HOME,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'RimCrow') : null,
  process.env.APPDATA ? join(process.env.APPDATA, 'RimCrow') : null,
].filter(Boolean)

function firstExisting(list, probe) {
  for (const c of list) {
    try { if (existsSync(probe(c))) return c } catch { }
  }
  return null
}

const HOME = firstExisting(HOME_CANDIDATES, (c) => join(c, 'data', 'mod_manager.db')) ?? HOME_CANDIDATES[0]
const DATA = join(HOME, 'data')

// ---------------------------------------------------------------- 小工具
function clip(s, n) {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return t.length > n ? t.slice(0, n) + '…' : t
}

function openDb(file) {
  if (!existsSync(file)) return null
  try {
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    try { return new DatabaseSync(file) } catch { return null }
  }
}

function jparse(s, fallback) {
  if (s === null || s === undefined || s === '') return fallback
  try { return JSON.parse(s) } catch { return fallback }
}

// ---------------------------------------------------------------- 规则
function loadRules() {
  return JSON.parse(readFileSync(RULES_PATH, 'utf8'))
}

function saveRules(r) {
  r.updatedAt = new Date().toISOString()
  writeFileSync(RULES_PATH, JSON.stringify(r, null, 1), 'utf8')
}

/** 规则表里出现的分组顺序（决定输出顺序）。 */
function ruleGroupOrder(rules) {
  const order = []
  for (const r of rules.rules) if (!order.includes(r.group)) order.push(r.group)
  for (const g of Object.values(rules.overrides)) if (!order.includes(g)) order.push(g)
  order.push('（未归类）')
  return order
}

/**
 * 单个模组的归类计算：精确覆盖 > 关键词规则（顺序即优先级）。
 * @returns {{group: string|null, why: string|null, detail: string|null}}
 */
function classifyOne(mod, rules) {
  const id = String(mod.package_id || '')
  const lower = id.toLowerCase()
  for (const k of Object.keys(rules.overrides)) {
    if (k.toLowerCase() === lower) {
      return { group: rules.overrides[k], why: 'override', detail: '精确覆盖：' + k }
    }
  }
  const hay = (id + ' | ' + (mod._alias || '') + ' | ' + (mod.name || '')).toLowerCase()
  for (const r of rules.rules) {
    if (r.fn === 'separator') {
      const label = String(mod._alias || mod.name || '').trim()
      if (/^\s*(?:={3,}|\/{3,}|\*{3,}|-{5,})/.test(label)) return { group: r.group, why: 'separator', detail: '分隔符标记（' + clip(label, 24) + '）' }
      continue
    }
    for (const k of (r.keys || [])) {
      if (hay.includes(k)) return { group: r.group, why: k, detail: '关键词「' + k + '」' }
    }
  }
  return { group: null, why: null, detail: null }
}

// ---------------------------------------------------------------- 数据读取
function loadMods() {
  const file = join(DATA, 'mod_manager.db')
  const db = openDb(file)
  if (!db) throw new Error('无法打开 RimCrow 数据库：' + file)
  const mods = db.prepare('SELECT package_id, package_id_raw, name, author, description, workshop_id, source, store, state, disabled, mod_type FROM modasset').all()
  const alias = new Map()
  try {
    for (const r of db.prepare('SELECT mod_id, alias_name FROM usermoddata').all()) {
      if (r.alias_name) alias.set(String(r.mod_id).toLowerCase(), r.alias_name)
    }
  } catch { }
  db.close()
  for (const m of mods) m._alias = alias.get(String(m.package_id).toLowerCase()) || null
  return mods
}

function loadCurrentGroups() {
  const db = openDb(join(DATA, 'mod_manager.db'))
  if (!db) throw new Error('无法打开 RimCrow 数据库')
  const groups = db.prepare('SELECT group_id, name, color, sort_index FROM groupdata ORDER BY sort_index').all()
  const members = db.prepare('SELECT group_id, mod_id, sort_index FROM groupmod ORDER BY sort_index').all()
  db.close()
  const map = new Map()
  for (const g of groups) map.set(g.group_id, { name: g.name, color: g.color, sortIndex: g.sort_index, mods: [] })
  for (const m of members) {
    const g = map.get(m.group_id)
    if (g) g.mods.push(String(m.mod_id))
  }
  return { groups: [...map.values()], byMod: (() => {
    const mm = new Map()
    for (const g of map.values()) for (const id of g.mods) mm.set(id.toLowerCase(), g.name)
    return mm
  })() }
}

// ---------------------------------------------------------------- actions
const actions = {}

/** scan —— 全库扫描归类 */
actions.scan = (args) => {
  const rules = loadRules()
  const mods = loadMods()
  const only = args.group ? String(args.group).toLowerCase() : null
  const q = String(args.query || '').trim().toLowerCase()
  const buckets = new Map()
  const unclassified = []
  for (const m of mods) {
    if (q) {
      const hay = (String(m.package_id) + ' ' + String(m._alias || '') + ' ' + String(m.name || '')).toLowerCase()
      if (!hay.includes(q)) continue
    }
    const res = classifyOne(m, rules)
    if (!res.group) { unclassified.push(m); continue }
    if (!buckets.has(res.group)) buckets.set(res.group, [])
    buckets.get(res.group).push(m)
  }
  const order = ruleGroupOrder(rules)
  const names = [...buckets.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const lines = []
  const totalClassified = [...buckets.values()].reduce((a, v) => a + v.length, 0)
  lines.push('模组分类扫描（规则计算，未写入 RimCrow）')
  lines.push('全库 ' + mods.length + ' 个模组 ｜ 规则 ' + rules.rules.length + ' 条 + 精确覆盖 ' + Object.keys(rules.overrides).length + ' 条 ｜ 归类 ' + totalClassified + ' ｜ 未归类 ' + unclassified.length)
  lines.push('')
  const out = []
  if (args.unclassifiedOnly) {
    lines.push('未归类模组（' + unclassified.length + ' 个）：')
    for (const m of unclassified) lines.push('  ' + m.package_id + '  |  ' + (m._alias || m.name || ''))
    out.push({ group: '（未归类）', count: unclassified.length, mods: unclassified.map((m) => m.package_id) })
  } else {
    for (const g of names) {
      const list = buckets.get(g)
      if (only && !g.toLowerCase().includes(only)) continue
      lines.push('[' + g + '] ' + list.length + ' 个')
      if (only) {
        for (const m of list) lines.push('    ' + m.package_id + '  |  ' + (m._alias || m.name || ''))
      } else {
        lines.push('    ' + list.slice(0, 3).map((m) => m.package_id).join(' / ') + (list.length > 3 ? ' / …' : ''))
      }
      out.push({ group: g, count: list.length, mods: only ? list.map((m) => m.package_id) : undefined })
    }
    if (unclassified.length) {
      lines.push('')
      lines.push('[（未归类）] ' + unclassified.length + ' 个（规则表里没有匹配项）')
      for (const m of unclassified.slice(0, 40)) lines.push('    ' + m.package_id + '  |  ' + (m._alias || m.name || ''))
      out.push({ group: '（未归类）', count: unclassified.length, mods: unclassified.map((m) => m.package_id) })
    }
  }
  return {
    text: lines.join('\n'),
    totalMods: mods.length,
    classified: totalClassified,
    unclassifiedCount: unclassified.length,
    groupCount: buckets.size,
    groups: out,
  }
}

/** check —— 内容校验：描述 vs 所在组主题词 */
actions.check = (args) => {
  const rules = loadRules()
  const mods = loadMods()
  const cur = loadCurrentGroups()
  const only = args.group ? String(args.group).toLowerCase() : null
  const limit = Math.max(1, Math.min(Number(args.limit) || 60, 300))
  const minLen = Number(args.minDescLen) || 25
  const withSuggest = args.includeSuggestions !== false
  const rows = []
  let checked = 0
  let skippedShort = 0
  let skippedNoHints = 0
  let skippedLang = 0
  for (const m of mods) {
    if (String(m.mod_type) === 'LanguagePack') { skippedLang++; continue }
    const g = cur.byMod.get(String(m.package_id).toLowerCase())
    if (!g) continue
    if (only && !g.toLowerCase().includes(only)) continue
    const hints = rules.hints[g]
    if (!hints || !hints.length) { skippedNoHints++; continue }
    const desc = String(m.description || '')
    if (desc.length < minLen) { skippedShort++; continue }
    checked++
    const hay = (desc + ' ' + String(m._alias || '') + ' ' + String(m.name || '')).toLowerCase()
    if (hints.some((h) => hay.includes(h))) continue
    let best = null
    if (withSuggest) {
      for (const [gg, hs] of Object.entries(rules.hints)) {
        if (gg === g) continue
        const hit = hs.filter((h) => hay.includes(h))
        if (hit.length && (!best || hit.length > best.n)) best = { group: gg, n: hit.length, keys: hit.slice(0, 4) }
      }
    }
    rows.push({
      id: m.package_id,
      alias: m._alias,
      name: m.name,
      current: g,
      suggest: best,
      desc: clip(desc, 220),
    })
  }
  rows.sort((a, b) => (a.current < b.current ? -1 : a.current > b.current ? 1 : 0))
  const lines = []
  lines.push('模组内容校验 — 已校验 ' + checked + ' 个（跳过：描述过短 ' + skippedShort + '、所在组无主题词表 ' + skippedNoHints + '）')
  lines.push('可疑项 ' + rows.length + ' 个（描述与所在组主题零匹配' + (withSuggest ? '，附建议归属' : '') + '）')
  lines.push('')
  let lastGroup = null
  for (const r of rows.slice(0, limit)) {
    if (r.current !== lastGroup) { lines.push(''); lines.push('=== ' + r.current + ' ==='); lastGroup = r.current }
    lines.push('  ' + (r.alias || r.name || '') + '  [' + r.id + ']')
    lines.push('      描述: ' + r.desc)
    if (r.suggest) lines.push('      建议: ' + r.suggest.group + '（命中 ' + r.suggest.keys.join(', ') + '）')
  }
  if (rows.length > limit) lines.push('')
  if (rows.length > limit) lines.push('（还有 ' + (rows.length - limit) + ' 条未显示，可用 group / limit 参数缩小范围）')
  return {
    text: lines.join('\n'),
    checked,
    skippedLang,
    skippedShort,
    skippedNoHints,
    suspiciousCount: rows.length,
    suspicious: rows.slice(0, limit),
  }
}

/** explain —— 单模组诊断 */
actions.explain = (args) => {
  const q = String(args.query || '').trim()
  if (!q) throw new Error('请提供 query（packageId / 名称关键词 / 工坊 ID）')
  const rules = loadRules()
  const mods = loadMods()
  const cur = loadCurrentGroups()
  const lq = q.toLowerCase()
  let hits = mods.filter((m) =>
    String(m.package_id).toLowerCase() === lq ||
    String(m.package_id_raw || '').toLowerCase() === lq ||
    String(m.workshop_id || '') === q)
  if (!hits.length) {
    hits = mods.filter((m) =>
      String(m.package_id).toLowerCase().includes(lq) ||
      String(m.name || '').toLowerCase().includes(lq) ||
      String(m._alias || '').toLowerCase().includes(lq) ||
      String(m.workshop_id || '').includes(q))
  }
  if (!hits.length) throw new Error('未找到匹配 "' + q + '" 的模组')
  const n = Math.max(0, Math.min(Number(args.neighbors) || 8, 40))
  const lines = ['模组诊断 "' + q + '" — 命中 ' + hits.length + ' 条']
  const items = []
  for (const m of hits.slice(0, 6)) {
    const res = classifyOne(m, rules)
    const current = cur.byMod.get(String(m.package_id).toLowerCase()) || null
    const hints = current ? rules.hints[current] : null
    const desc = String(m.description || '')
    const hay = (desc + ' ' + String(m._alias || '') + ' ' + String(m.name || '')).toLowerCase()
    const ownHit = hints ? hints.filter((h) => hay.includes(h)) : []
    lines.push('')
    lines.push('— ' + (m._alias || m.name || '(无名称)') + '  [' + m.package_id + ']')
    lines.push('    工坊: ' + (m.workshop_id || '（本地模组）') + ' ｜ 来源: ' + (m.source || '?') + ' ｜ 类型: ' + (m.mod_type || '?') + ' ｜ 状态: ' + (m.state || '?') + (m.disabled ? ' ｜ 已禁用' : ''))
    lines.push('    当前分组: ' + (current || '（未分组）') + (ownHit.length ? '  ｜ 描述与组主题匹配: ' + ownHit.slice(0, 4).join(', ') : (hints ? '  ｜ ! 描述与组主题零匹配' : '')))
    lines.push('    规则建议: ' + (res.group || '（算不出，需人工指定或加规则）') + '  ｜ 依据: ' + (res.detail || '无'))
    if (current && n) {
      const g = cur.groups.find((x) => x.name === current)
      if (g) {
        const idx = g.mods.findIndex((id) => id.toLowerCase() === String(m.package_id).toLowerCase())
        const around = g.mods.slice(Math.max(0, idx - 2), idx + 1 + n)
        lines.push('    同组邻居（前 ' + Math.min(idx + 1, n) + ' 个）: ' + around.join(', '))
        lines.push('    分组规模: ' + g.mods.length + ' 个 ｜ 颜色: ' + (g.color || '无') + ' ｜ 排序位: ' + g.sortIndex)
      }
    }
    lines.push('    描述: ' + (clip(desc, 400) || '（无描述）'))
    items.push({ packageId: m.package_id, alias: m._alias, name: m.name, current, suggested: res.group, reason: res.detail, desc: clip(desc, 400) })
  }
  if (hits.length > 6) lines.push('')
  if (hits.length > 6) lines.push('（还有 ' + (hits.length - 6) + ' 条命中未显示，请用更精确的 query）')
  return { text: lines.join('\n'), matches: items }
}

/** rules —— 规则维护 */
actions.rules = (args) => {
  const op = String(args.op || 'get')
  const rules = loadRules()
  const lines = []
  const need = (v, msg) => { if (!v) throw new Error(msg); return String(v) }
  const findRule = (g) => {
    const r = rules.rules.find((x) => x.group === g)
    if (!r && op !== 'setKeys') throw new Error('规则表里没有分组「' + g + '」')
    return r
  }
  switch (op) {
    case 'get': {
      lines.push('分类规则表 rules.json')
      lines.push('  版本: ' + rules.version + ' ｜ 更新: ' + rules.updatedAt)
      lines.push('  规则块: ' + rules.rules.length + ' ｜ 关键词: ' + rules.rules.reduce((a, r) => a + ((r.keys && r.keys.length) || 0), 0) + ' ｜ 精确覆盖: ' + Object.keys(rules.overrides).length + ' ｜ 主题词表(hints): ' + Object.keys(rules.hints).length + ' 组')
      lines.push('  文件: ' + RULES_PATH)
      lines.push('  匹配顺序: 精确覆盖 → 之后按 list 的顺序逐个命中')
      break
    }
    case 'list': {
      lines.push('规则匹配顺序（先命中先赢）:')
      rules.rules.forEach((r, i) => {
        lines.push('  ' + String(i + 1).padStart(3) + '. ' + r.group + (r.fn ? '  [特殊:' + r.fn + ']' : '  (' + ((r.keys && r.keys.length) || 0) + ' 关键词)'))
      })
      break
    }
    case 'listKeys': {
      const g = need(args.group, 'listKeys 需要 group')
      const r = findRule(g)
      lines.push('[' + g + '] 关键词 ' + ((r.keys && r.keys.length) || 0) + ' 个:')
      lines.push('  ' + (r.keys || []).join(', '))
      break
    }
    case 'setKeys': {
      const g = need(args.group, 'setKeys 需要 group')
      if (!Array.isArray(args.keys)) throw new Error('setKeys 需要 keys 数组')
      const r = findRule(g)
      if (r) { r.keys = args.keys.slice() } else { rules.rules.push({ group: g, keys: args.keys.slice() }) }
      saveRules(rules)
      lines.push('已更新 [' + g + '] 的关键词为 ' + args.keys.length + ' 个')
      break
    }
    case 'addKey': {
      const g = need(args.group, 'addKey 需要 group')
      const k = need(args.key, 'addKey 需要 key')
      const r = findRule(g)
      r.keys = r.keys || []
      if (!r.keys.includes(k)) r.keys.push(k)
      saveRules(rules)
      lines.push('已为 [' + g + '] 添加关键词「' + k + '」，现共 ' + r.keys.length + ' 个')
      break
    }
    case 'removeKey': {
      const g = need(args.group, 'removeKey 需要 group')
      const k = need(args.key, 'removeKey 需要 key')
      const r = findRule(g)
      const before = (r.keys || []).length
      r.keys = (r.keys || []).filter((x) => x !== k)
      saveRules(rules)
      lines.push('已从 [' + g + '] 移除关键词「' + k + '」（' + before + ' → ' + r.keys.length + '）')
      break
    }
    case 'setOverride': {
      const id = need(args.id, 'setOverride 需要 id')
      const g = need(args.group, 'setOverride 需要 group')
      rules.overrides[id] = g
      saveRules(rules)
      lines.push('已设置精确覆盖：' + id + ' → ' + g)
      break
    }
    case 'removeOverride': {
      const id = need(args.id, 'removeOverride 需要 id')
      if (rules.overrides[id] === undefined) throw new Error('覆盖表里没有 ' + id)
      delete rules.overrides[id]
      saveRules(rules)
      lines.push('已删除精确覆盖：' + id)
      break
    }
    case 'hints': {
      const g = need(args.group, 'hints 需要 group')
      if (Array.isArray(args.keys)) {
        rules.hints[g] = args.keys.slice()
        saveRules(rules)
        lines.push('已更新 [' + g + '] 的主题词表为 ' + args.keys.length + ' 个')
      } else {
        lines.push('[' + g + '] 主题词表（' + ((rules.hints[g] || []).length) + ' 个）:')
        lines.push('  ' + ((rules.hints[g] || []).join(', ') || '（未设置，该组的内容校验会被跳过）'))
      }
      break
    }
    case 'setHints': {
      const g = need(args.group, 'setHints 需要 group')
      if (!Array.isArray(args.keys)) throw new Error('setHints 需要 keys 数组')
      rules.hints[g] = args.keys.slice()
      saveRules(rules)
      lines.push('已设置 [' + g + '] 的主题词表为 ' + args.keys.length + ' 个')
      break
    }
    default:
      throw new Error('未知 op：' + op)
  }
  return { text: lines.join('\n'), op, ok: true }
}

// ---------------------------------------------------------------- 入口
const [, , actionName, rawPayload] = process.argv
let args = {}
if (rawPayload) {
  try {
    args = rawPayload.startsWith('base64:')
      ? JSON.parse(Buffer.from(rawPayload.slice('base64:'.length), 'base64').toString('utf8'))
      : JSON.parse(rawPayload)
  } catch { args = {} }
}
try {
  const fn = actions[actionName]
  if (!fn) throw new Error('未知 action：' + String(actionName) + '（可用：' + Object.keys(actions).join(' / ') + '）')
  const data = fn(args)
  process.stdout.write(JSON.stringify({ ok: true, data }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }) + '\n')
  process.exitCode = 1
}



