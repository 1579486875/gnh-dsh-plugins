#!/usr/bin/env node
/**
 * rimcrow-data.mjs — RimCrow / RimWorld 只读数据查询后端
 *
 * 用法: node rimcrow-data.mjs <action> ['<json-args>']
 * 输出: 单行 JSON  { ok: true, data: {...} }  或  { ok: false, error: "..." }
 *
 * 设计原则: 全程只读 —— 不写入、不修改任何 RimCrow / RimWorld 文件。
 */
import { existsSync, statSync, readFileSync, openSync, readSync, closeSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// ---------------------------------------------------------------- 路径发现
const HOME_CANDIDATES = [
  process.env.RIMCROW_HOME,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'RimCrow') : null,
  process.env.APPDATA ? join(process.env.APPDATA, 'RimCrow') : null,
].filter(Boolean)

const USER_DIR_CANDIDATES = [
  process.env.RIMWORLD_USER_DIR,
  process.env.USERPROFILE
    ? join(process.env.USERPROFILE, 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios')
    : null,
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
function jparse(s, fallback) {
  if (s === null || s === undefined || s === '') return fallback
  try { return JSON.parse(s) } catch { return fallback }
}

function authorsOf(raw) {
  const v = jparse(raw, null)
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string')
  if (typeof v === 'string' && v) return [v]
  return []
}

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

function config() {
  return jparse(readFileSync(join(DATA, 'config.json'), 'utf8'), {})
}

let _userDir = null
function userDir() {
  if (_userDir) return _userDir
  try {
    const profiles = join(DATA, 'profiles')
    if (existsSync(profiles)) {
      const cfg = config()
      const pid = cfg.current_profile_id || 'default'
      const p = join(profiles, pid, 'profile.json')
      if (existsSync(p)) {
        const j = jparse(readFileSync(p, 'utf8'), {})
        if (j.user_data_path && existsSync(j.user_data_path)) { _userDir = j.user_data_path; return _userDir }
      }
    }
  } catch { }
  _userDir = firstExisting(USER_DIR_CANDIDATES, (c) => join(c, 'Config', 'ModsConfig.xml')) ?? USER_DIR_CANDIDATES[0]
  return _userDir
}

function readTailText(file, maxBytes) {
  const size = statSync(file).size
  const start = Math.max(0, size - maxBytes)
  const len = size - start
  const buf = Buffer.alloc(len)
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
  let text = buf.toString('utf8')
  if (start > 0) {
    const i = text.indexOf('\n')
    text = i >= 0 ? text.slice(i + 1) : ''
  }
  return text
}

function paged(rows, offset, limit) {
  const total = rows.length
  const off = Math.max(0, Math.min(offset || 0, total))
  const lim = Math.max(1, Math.min(limit || 50, 500))
  return { total, offset: off, limit: lim, slice: rows.slice(off, off + lim) }
}

// ---------------------------------------------------------------- 各 action
const actions = {}
/** 1. 当前启用列表 —— ModsConfig.xml 的 activeMods（游戏侧权威顺序） */
actions.get_active_mod_list = (args) => {
  const ud = userDir()
  const file = join(ud, 'Config', 'ModsConfig.xml')
  if (!existsSync(file)) throw new Error('未找到 ModsConfig.xml: ' + file)

  const xml = readFileSync(file, 'utf8')
  const version = (/<version>([^<]*)<\/version>/.exec(xml) || [])[1] || ''
  const block = (/<activeMods>([\s\S]*?)<\/activeMods>/.exec(xml) || [])[1] || ''
  const known = (/<knownExpansions>([\s\S]*?)<\/knownExpansions>/.exec(xml) || [])[1] || ''
  const active = [...block.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1].trim())
  const expansions = [...known.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1].trim())

  const db = openDb(join(DATA, 'mod_manager.db'))
  const meta = new Map()
  const alias = new Map()
  if (db) {
    for (const r of db.prepare('SELECT package_id, name, author, workshop_id, source, store, disabled FROM modasset').all()) {
      meta.set(String(r.package_id).toLowerCase(), r)
    }
    try {
      for (const r of db.prepare('SELECT mod_id, alias_name FROM usermoddata').all()) {
        if (r.alias_name) alias.set(String(r.mod_id).toLowerCase(), r.alias_name)
      }
    } catch { }
    db.close()
  }

  const q = String(args.query || '').trim().toLowerCase()
  let rows = active.map((id, i) => {
    const m = meta.get(id.toLowerCase())
    return {
      order: i + 1,
      packageId: id,
      name: m ? m.name : null,
      alias: alias.get(id.toLowerCase()) || null,
      author: m ? authorsOf(m.author).join(', ') : null,
      workshopId: m ? m.workshop_id : null,
      source: m ? m.source : 'unknown',
      store: m ? m.store : null,
      installed: Boolean(m),
    }
  })
  if (q) {
    rows = rows.filter((r) =>
      r.packageId.toLowerCase().includes(q) ||
      (r.name || '').toLowerCase().includes(q) ||
      (r.alias || '').toLowerCase().includes(q) ||
      (r.author || '').toLowerCase().includes(q))
  }

  const page = paged(rows, Number(args.offset) || 0, Number(args.limit) || 50)
  const missing = rows.filter((r) => !r.installed).length
  const lines = [
    '当前启用模组列表（来源 ModsConfig.xml，游戏版本 ' + (version || '未知') + '）',
    '启用总数: ' + rows.length + (q ? '（已按 "' + args.query + '" 过滤）' : '') + ' ｜ 其中无元数据记录: ' + missing + ' ｜ 官方内容: ' + expansions.length + ' 项',
    '本页显示第 ' + (page.offset + 1) + '-' + Math.min(page.offset + page.limit, page.total) + ' 条:',
  ]
  for (const r of page.slice) {
    lines.push('[' + r.order + '] ' + (r.alias ? r.alias + ' / ' : '') + (r.name || '(未知名称)') + ' — ' + r.packageId +
      (r.author ? ' ｜ ' + r.author : '') + (r.workshopId ? ' ｜ 工坊 ' + r.workshopId : '') + (r.installed ? '' : ' ｜ ! 元数据缺失'))
  }
  if (page.offset + page.limit < page.total) lines.push('（还有 ' + (page.total - page.offset - page.limit) + ' 条，可用 offset 参数继续查看）')

  return {
    text: lines.join('\n'),
    gameVersion: version,
    totalActive: rows.length,
    offset: page.offset,
    limit: page.limit,
    knownExpansions: expansions,
    mods: page.slice,
  }
}

/** 2. 模组元数据 —— modasset 表 + 用户数据 */
actions.get_mod_info = (args) => {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('请提供 query 参数（packageId、工坊 ID 或名称关键词）')
  const db = openDb(join(DATA, 'mod_manager.db'))
  if (!db) throw new Error('无法打开 mod_manager.db')
  const like = '%' + query.replace(/[%_]/g, (m) => '\\' + m) + '%'
  const rows = db.prepare("SELECT * FROM modasset WHERE package_id = ?1 OR package_id_raw = ?1 OR workshop_id = ?1 OR package_id LIKE ?2 ESCAPE '\\' OR name LIKE ?2 ESCAPE '\\' ORDER BY name LIMIT 12").all(query, like)
  const users = new Map()
  for (const r of db.prepare('SELECT * FROM usermoddata').all()) users.set(String(r.mod_id).toLowerCase(), r)
  db.close()

  if (!rows.length) {
    return { text: '未找到与 "' + query + '" 匹配的模组元数据（modasset 表）。', matches: [] }
  }

  const brief = Boolean(args.brief)
  const out = []
  const lines = ['模组元数据查询 "' + query + '" — 命中 ' + rows.length + ' 条']
  for (const r of rows) {
    const u = users.get(String(r.package_id).toLowerCase())
    const deps = jparse(r.dependencies_mods, [])
    const after = jparse(r.load_after_mods, [])
    const before = jparse(r.load_before_mods, [])
    const incomp = jparse(r.incompatible_mods, [])
    const item = {
      packageId: r.package_id,
      packageIdRaw: r.package_id_raw,
      name: r.name,
      alias: u ? u.alias_name : null,
      author: authorsOf(r.author),
      version: r.version || null,
      workshopId: r.workshop_id,
      source: r.source,
      store: r.store,
      state: r.state,
      disabled: r.disabled === 1,
      path: r.path,
      url: r.url,
      modType: r.mod_type,
      fileSizeMB: r.file_size ? Math.round(r.file_size / 1048576 * 10) / 10 : null,
      supportedVersions: jparse(r.supported_versions, []),
      dependencies: deps.map((d) => d.package_id || d),
      loadAfter: after.map((d) => d.package_id || d),
      loadBefore: before.map((d) => d.package_id || d),
      incompatible: incomp.map((d) => d.package_id || d),
      notes: u ? u.notes : null,
      tags: jparse(u ? u.tags : null, []),
      ignoredIssues: jparse(u ? u.ignored_issues : null, []),
      description: clip(r.description, brief ? 200 : 700),
    }
    out.push(item)
    lines.push(
      '',
      '● ' + (item.alias ? item.alias + ' / ' : '') + item.name + '  [' + item.packageId + ']',
      '  作者: ' + (item.author.join(', ') || '未知') + ' ｜ 来源: ' + item.source + '/' + item.store + ' ｜ 类型: ' + item.modType + ' ｜ 状态: ' + item.state + (item.disabled ? '（已停用）' : ''),
      '  工坊ID: ' + (item.workshopId || '无') + ' ｜ 版本: ' + (item.version || '未标注') + ' ｜ 支持: ' + (item.supportedVersions.join(', ') || '?') + ' ｜ 体积: ' + (item.fileSizeMB || '?') + ' MB',
      '  路径: ' + item.path,
      '  依赖: ' + (item.dependencies.join(', ') || '无'),
      '  须后置(loadAfter): ' + (item.loadAfter.slice(0, 12).join(', ') || '无') + (item.loadAfter.length > 12 ? ' …共' + item.loadAfter.length + '项' : ''),
      '  须前置(loadBefore): ' + (item.loadBefore.slice(0, 8).join(', ') || '无') + (item.loadBefore.length > 8 ? ' …共' + item.loadBefore.length + '项' : ''),
      '  不兼容: ' + (item.incompatible.join(', ') || '无'),
      item.notes ? '  用户备注: ' + clip(item.notes, 300) : '',
      item.tags.length ? '  用户标签: ' + item.tags.join(', ') : '',
      item.description ? '  简介: ' + item.description : '',
    )
  }
  return { text: lines.filter((x) => x !== '').join('\n'), matches: out }
}
/** 3. 模组规则 —— 社区规则 + 用户规则 + 元数据内规则 */
actions.get_mod_rules = (args) => {
  const q = String(args.query || args.packageId || '').trim()
  const cPath = join(DATA, 'rules', 'communityRules.json')
  const uPath = join(DATA, 'rules', 'user_rules.json')
  const community = existsSync(cPath) ? jparse(readFileSync(cPath, 'utf8'), null) : null
  const user = existsSync(uPath) ? jparse(readFileSync(uPath, 'utf8'), null) : null
  const rules = (community && community.rules) ? community.rules : {}
  const ids = Object.keys(rules)

  if (!q) {
    const kinds = { loadAfter: 0, loadBefore: 0, other: 0 }
    for (const id of ids) {
      const e = rules[id] || {}
      if (e.loadAfter) kinds.loadAfter++
      if (e.loadBefore) kinds.loadBefore++
      for (const k of Object.keys(e)) if (k !== 'loadAfter' && k !== 'loadBefore') kinds.other++
    }
    const lines = [
      '模组规则库概览',
      '社区规则: ' + ids.length + ' 条（loadAfter ' + kinds.loadAfter + ' / loadBefore ' + kinds.loadBefore + (kinds.other ? ' / 其他 ' + kinds.other : '') + '）',
      '来源文件: ' + cPath,
      '用户自定义规则: ' + (user ? JSON.stringify(user).length : 0) + ' 字节 — ' + uPath,
      '社区规则更新时间: ' + (community && community.timestamp ? new Date(community.timestamp * 1000).toLocaleString('zh-CN') : '未知'),
      '',
      '提示: 传入 query（packageId 或名称）可查看某个模组的完整规则与反向引用。',
      '规则覆盖示例: ' + ids.slice(0, 15).join(', ') + ' …',
    ]
    return { text: lines.join('\n'), communityRuleCount: ids.length, kinds, userRules: user || null }
  }

  const key = ids.find((id) => id.toLowerCase() === q.toLowerCase())
  const db = openDb(join(DATA, 'mod_manager.db'))
  let asset = null
  if (db) {
    asset = db.prepare('SELECT package_id, name, load_after_mods, load_before_mods, incompatible_mods, dependencies_mods FROM modasset WHERE package_id = ? OR package_id_raw = ? OR name LIKE ? LIMIT 1').get(q, q, '%' + q + '%')
    db.close()
  }
  const reverse = []
  for (const id of ids) {
    const e = rules[id] || {}
    for (const kind of ['loadAfter', 'loadBefore']) {
      if (e[kind] && Object.keys(e[kind]).some((t) => t.toLowerCase() === q.toLowerCase())) {
        reverse.push({ from: id, kind })
      }
    }
  }
  const lines = ['模组规则查询 "' + q + '"']
  if (key) {
    const e = rules[key]
    lines.push('社区规则命中: ' + key)
    for (const kind of Object.keys(e)) {
      const items = Object.keys(e[kind] || {})
      lines.push('  ' + kind + ' (' + items.length + '): ' + items.slice(0, 20).join(', ') + (items.length > 20 ? ' …' : ''))
    }
  } else {
    lines.push('社区规则库中无此模组的直接条目。')
  }
  if (asset) {
    lines.push(
      '元数据记录: ' + asset.name + ' [' + asset.package_id + ']',
      '  loadAfter : ' + (jparse(asset.load_after_mods, []).map((d) => d.package_id || d).join(', ') || '无'),
      '  loadBefore: ' + (jparse(asset.load_before_mods, []).map((d) => d.package_id || d).join(', ') || '无'),
      '  不兼容    : ' + (jparse(asset.incompatible_mods, []).map((d) => d.package_id || d).join(', ') || '无'),
      '  依赖      : ' + (jparse(asset.dependencies_mods, []).map((d) => d.package_id || d).join(', ') || '无'),
    )
  } else {
    lines.push('本地 modasset 中无此模组。')
  }
  lines.push(reverse.length
    ? '被其他规则引用 ' + reverse.length + ' 次: ' + reverse.slice(0, 15).map((r) => r.from + '(' + r.kind + ')').join(', ')
    : '没有被其他社区规则引用。')

  return {
    text: lines.join('\n'),
    query: q,
    communityRule: key ? Object.assign({ id: key }, rules[key]) : null,
    localMetadata: asset ? {
      packageId: asset.package_id,
      name: asset.name,
      loadAfter: jparse(asset.load_after_mods, []),
      loadBefore: jparse(asset.load_before_mods, []),
      incompatible: jparse(asset.incompatible_mods, []),
      dependencies: jparse(asset.dependencies_mods, []),
    } : null,
    reverseReferences: reverse,
    userRules: user || null,
  }
}

/** 4. 搜索模组 —— 工坊索引 + 本地已装 */
actions.search_mods = (args) => {
  const q = String(args.query || '').trim()
  if (!q) throw new Error('请提供 query 参数（模组名称、packageId 或工坊 ID 关键词）')
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100))
  const scope = String(args.scope || 'all')
  const like = '%' + q.replace(/[%_]/g, (m) => '\\' + m) + '%'
  const results = []

  const installed = new Map()
  const mgr = openDb(join(DATA, 'mod_manager.db'))
  if (mgr) {
    for (const r of mgr.prepare('SELECT package_id, name, workshop_id, disabled, source FROM modasset').all()) {
      installed.set(String(r.package_id).toLowerCase(), r)
    }
    if (scope !== 'workshop') {
      for (const r of mgr.prepare("SELECT package_id, name, author, workshop_id, source, store, disabled, supported_versions FROM modasset WHERE name LIKE ?1 ESCAPE '\\' OR package_id LIKE ?1 ESCAPE '\\' OR workshop_id LIKE ?1 ESCAPE '\\' ORDER BY name LIMIT ?2").all(like, limit)) {
        results.push({
          origin: 'installed',
          packageId: r.package_id,
          name: r.name,
          author: authorsOf(r.author).join(', '),
          workshopId: r.workshop_id,
          source: r.source,
          store: r.store,
          enabled: r.disabled !== 1,
          versions: jparse(r.supported_versions, []),
        })
      }
    }
    mgr.close()
  }

  if (scope !== 'installed' && results.length < limit) {
    const wc = openDb(join(DATA, 'workshop_cache.db'))
    if (wc) {
      for (const r of wc.prepare("SELECT workshop_id, package_id, name, author, game_versions, dependencies_mods FROM workshopmanifest WHERE name LIKE ?1 ESCAPE '\\' OR package_id LIKE ?1 ESCAPE '\\' OR workshop_id LIKE ?1 ESCAPE '\\' LIMIT ?2").all(like, limit * 3)) {
        const key = String(r.package_id || '').toLowerCase()
        if (installed.has(key)) continue
        results.push({
          origin: 'workshop',
          packageId: r.package_id,
          name: r.name,
          author: authorsOf(r.author).join(', '),
          workshopId: r.workshop_id,
          versions: jparse(r.game_versions, []),
          dependencyCount: jparse(r.dependencies_mods, []).length,
        })
        if (results.length >= limit) break
      }
      wc.close()
    }
  }

  const lines = ['搜索模组 "' + q + '" — 命中 ' + results.length + ' 条（范围: ' + scope + '，最多 ' + limit + ' 条）']
  for (const r of results) {
    lines.push('● ' + r.name + '  [' + r.packageId + ']' + (r.workshopId ? ' ｜ 工坊 ' + r.workshopId : '') +
      ' ｜ ' + (r.author || '未知作者') + ' ｜ ' + (r.origin === 'installed' ? (r.enabled ? '已安装·启用中' : '已安装·已停用') : '工坊条目·未安装') +
      (r.versions && r.versions.length ? ' ｜ 版本 ' + r.versions.join('/') : ''))
  }
  if (!results.length) lines.push('没有匹配结果。可尝试更短的关键词，或用 scope:"workshop" 只搜创意工坊索引。')

  return { text: lines.join('\n'), query: q, scope, count: results.length, results }
}
/** 5. 分组模组 —— groupdata + groupmod */
actions.get_group_mods = (args) => {
  const db = openDb(join(DATA, 'mod_manager.db'))
  if (!db) throw new Error('无法打开 mod_manager.db')
  const groups = db.prepare('SELECT * FROM groupdata ORDER BY sort_index').all()
  const members = db.prepare('SELECT * FROM groupmod ORDER BY sort_index').all()
  const names = new Map()
  for (const r of db.prepare('SELECT package_id, name FROM modasset').all()) names.set(String(r.package_id).toLowerCase(), r.name)
  db.close()

  const q = String(args.query || '').trim().toLowerCase()
  const filtered = q ? groups.filter((g) => String(g.name || '').toLowerCase().includes(q) || String(g.group_id).toLowerCase().includes(q)) : groups

  if (!groups.length) {
    return {
      text: '当前 RimCrow 中没有创建任何模组分组（groupdata 表为空）。\n分组需要在 RimCrow 界面里创建并拖入模组；创建后本工具即可读取。',
      groups: [],
      totalGroups: 0,
    }
  }
  const lines = ['模组分组 — 共 ' + groups.length + ' 个分组' + (q ? '（按 "' + args.query + '" 过滤后 ' + filtered.length + ' 个）' : '')]
  const out = []
  for (const g of filtered) {
    const ids = members.filter((m) => m.group_id === g.group_id).map((m) => m.mod_id)
    out.push({
      groupId: g.group_id,
      name: g.name,
      color: g.color,
      sortIndex: g.sort_index,
      modCount: ids.length,
      mods: ids.map((id) => ({ packageId: id, name: names.get(String(id).toLowerCase()) || null })),
    })
    lines.push('● ' + g.name + '（' + g.group_id + '）颜色 ' + (g.color || '默认') + ' ｜ ' + ids.length + ' 个模组')
    for (const id of ids.slice(0, 30)) lines.push('    - ' + (names.get(String(id).toLowerCase()) || '(未知)') + ' [' + id + ']')
    if (ids.length > 30) lines.push('    …还有 ' + (ids.length - 30) + ' 个')
  }
  return { text: lines.join('\n'), groups: out, totalGroups: groups.length }
}

/** 6. 模组用户数据 —— usermoddata 表 */
actions.get_mod_user_data = (args) => {
  const db = openDb(join(DATA, 'mod_manager.db'))
  if (!db) throw new Error('无法打开 mod_manager.db')
  const rows = db.prepare('SELECT * FROM usermoddata').all()
  const names = new Map()
  for (const r of db.prepare('SELECT package_id, name FROM modasset').all()) names.set(String(r.package_id).toLowerCase(), r.name)
  db.close()

  const q = String(args.query || '').trim().toLowerCase()
  let list = rows.map((r) => ({
    modId: r.mod_id,
    name: names.get(String(r.mod_id).toLowerCase()) || null,
    aliasName: r.alias_name || null,
    notes: r.notes || null,
    tags: jparse(r.tags, []),
    signColor: r.sign_color || null,
    userModType: r.user_mod_type || null,
    interlockId: r.interlock_id || null,
    ignoredIssues: jparse(r.ignored_issues, []),
  }))
  if (q) {
    list = list.filter((r) =>
      r.modId.toLowerCase().includes(q) ||
      (r.name || '').toLowerCase().includes(q) ||
      (r.aliasName || '').toLowerCase().includes(q) ||
      (r.notes || '').toLowerCase().includes(q) ||
      r.tags.join(',').toLowerCase().includes(q))
  }
  const withNotes = list.filter((r) => r.notes || r.aliasName || r.tags.length)
  const page = paged(withNotes, Number(args.offset) || 0, Number(args.limit) || 30)

  const lines = [
    '模组用户数据' + (q ? '（过滤 "' + args.query + '"）' : '') + ' — 全部记录 ' + rows.length + ' 条，其中有别名/备注/标签的 ' + withNotes.length + ' 条',
    '本页第 ' + (page.offset + 1) + '-' + Math.min(page.offset + page.limit, page.total) + ' 条:',
  ]
  for (const r of page.slice) {
    lines.push('● ' + (r.aliasName ? r.aliasName + ' / ' : '') + (r.name || '(未知)') + '  [' + r.modId + ']' +
      (r.tags.length ? ' ｜ 标签: ' + r.tags.join(', ') : '') + (r.userModType ? ' ｜ 类型: ' + r.userModType : '') +
      (r.ignoredIssues.length ? ' ｜ 忽略问题: ' + r.ignoredIssues.join(', ') : ''))
    if (r.notes) lines.push('    备注: ' + clip(r.notes, 400))
  }
  if (page.offset + page.limit < page.total) lines.push('（还有 ' + (page.total - page.offset - page.limit) + ' 条，可用 offset 继续）')

  return { text: lines.join('\n'), totalRecords: rows.length, withUserContent: withNotes.length, offset: page.offset, limit: page.limit, entries: page.slice }
}

/** 7a. 日志上下文（最近 N 条） */
actions._log_recent = (args) => {
  const source = String(args.source || 'game')
  const linesWanted = Math.max(1, Math.min(Number(args.lines) || 60, 500))
  const level = String(args.level || 'all').toUpperCase()
  const pattern = String(args.pattern || '').trim().toLowerCase()
  const withDetails = Boolean(args.includeDetails)

  const ud = userDir()
  const candidates = source === 'app'
    ? [join(DATA, 'logs', 'app.log')]
    : [
        join(ud, 'RimCrow_Realtime.log'),
        join(ud, 'RimCrow_Realtime-prev.log'),
        join(ud, 'Player.log'),
      ]
  const files = candidates.filter((f) => existsSync(f))
  if (!files.length) throw new Error('未找到日志文件，尝试过: ' + candidates.join(' ; '))

  const file = files[0]
  const raw = readTailText(file, 4 * 1024 * 1024)
  const entries = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t[0] !== '{') continue
    const j = jparse(t, null)
    if (j) entries.push(j)
  }
  const counts = { INFO: 0, WARNING: 0, ERROR: 0, OTHER: 0 }
  for (const e of entries) {
    const lv = String(e.level || '').toUpperCase()
    if (lv in counts) counts[lv]++; else counts.OTHER++
  }
  let filtered = entries
  if (level === 'ERROR') filtered = filtered.filter((e) => String(e.level).toUpperCase() === 'ERROR')
  else if (level === 'WARNING' || level === 'WARN') filtered = filtered.filter((e) => ['WARNING', 'ERROR'].indexOf(String(e.level).toUpperCase()) >= 0)
  if (pattern) {
    filtered = filtered.filter((e) =>
      String(e.message || '').toLowerCase().includes(pattern) ||
      String(e.details || '').toLowerCase().includes(pattern) ||
      JSON.stringify(e.context || {}).toLowerCase().includes(pattern))
  }
  const slice = filtered.slice(-linesWanted)

  const lines = [
    '日志上下文 — ' + (source === 'app' ? 'RimCrow 应用日志' : 'RimWorld 实时日志（RimCrow Companion 采集）'),
    '文件: ' + file,
    '尾部读取 ' + entries.length + ' 条记录 ｜ 级别统计 INFO=' + counts.INFO + ' WARNING=' + counts.WARNING + ' ERROR=' + counts.ERROR +
      (level !== 'ALL' ? ' ｜ 过滤级别=' + level : '') + (pattern ? ' ｜ 关键词="' + args.pattern + '"' : ''),
    '显示最近 ' + slice.length + ' 条:',
  ]
  for (const e of slice) {
    const lv = String(e.level || 'LOG')
    const mark = lv === 'ERROR' ? '✖' : lv === 'WARNING' ? '▲' : '·'
    lines.push(mark + ' [' + e.timestamp + '] ' + lv + ': ' + clip(e.message, 400))
    const rel = e.context && e.context.relatedModIds
    if (Array.isArray(rel) && rel.length) lines.push('      相关模组: ' + rel.join(', '))
    if (withDetails && e.details) lines.push('      堆栈: ' + clip(e.details, 600))
  }
  if (!slice.length) lines.push('（没有符合过滤条件的日志记录）')

  return {
    text: lines.join('\n'),
    file: file,
    source: source,
    counts: counts,
    filteredCount: filtered.length,
    shown: slice.length,
    entries: slice.map((e) => ({
      timestamp: e.timestamp,
      level: e.level,
      message: e.message,
      count: e.count || 1,
      relatedModIds: (e.context && e.context.relatedModIds) || [],
      details: withDetails ? clip(e.details, 800) : undefined,
    })),
  }
}

/** 选择日志文件（游戏实时日志优先，回退历史/原版日志）。 */
function pickLogFile(source) {
  const ud = userDir()
  const candidates = source === 'app'
    ? [join(DATA, 'logs', 'app.log')]
    : [
        join(ud, 'RimCrow_Realtime.log'),
        join(ud, 'RimCrow_Realtime-prev.log'),
        join(ud, 'Player.log'),
      ]
  const files = candidates.filter((f) => existsSync(f))
  if (!files.length) throw new Error('未找到日志文件，尝试过: ' + candidates.join(' ; '))
  return files[0]
}

/** 日志级别过滤谓词。 */
function levelFilterOf(level) {
  const lv = String(level || 'all').toUpperCase()
  if (lv === 'ERROR') return (e) => String(e.level).toUpperCase() === 'ERROR'
  if (lv === 'WARNING' || lv === 'WARN') return (e) => ['WARNING', 'ERROR'].indexOf(String(e.level).toUpperCase()) >= 0
  if (lv === 'INFO') return (e) => String(e.level).toUpperCase() === 'INFO'
  return () => true
}

/** 关键词过滤谓词（消息 / 堆栈 / 上下文）。 */
function textFilterOf(pattern) {
  const p = String(pattern || '').trim().toLowerCase()
  if (!p) return () => true
  return (e) =>
    String(e.message || '').toLowerCase().includes(p) ||
    String(e.details || '').toLowerCase().includes(p) ||
    JSON.stringify(e.context || {}).toLowerCase().includes(p)
}

/**
 * 错误骨架：抹掉数量、引号内容与长标识符，让同类记录归并到同一个模式。
 * 同时收集被抹掉的高频取值（variants），用于还原「具体是哪个 Def / 哪个模组」。
 * @returns {{ key: string, variants: string[] }}
 */
function skeletonOf(msg) {
  const variants = []
  let s = String(msg)
  const modName = (/^Mod\s+(\S+)\s+has multiple/.exec(s) || [])[1] || null
  s = s.replace(/file:\s*[^\n]*/g, '')
  s = s.replace(/"([^"]*)"/g, (m, inner) => {
    if (inner && inner.length <= 48 && variants.length < 10) variants.push(inner)
    return '"∅"'
  })
  s = s.replace(/[A-Za-z0-9_./\\-]{18,}/g, (m) => {
    if (m === modName) return m
    const clean = m.replace(/\.+$/, '')
    if (clean && clean.length <= 64 && variants.length < 10) variants.push(clean)
    return '∅'
  })
  s = s.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 160)
  return { key: s, variants: variants }
}

/** 引擎自带命名空间，归因时忽略。 */
const LOG_ENGINE_NS = /^(Verse|RimWorld|System|MonoMod|UnityEngine|Newtonsoft|HarmonyLib|Mono|RimCrow|RimCrowCompanion|Microsoft|JetBrains|LudeonTK|0Harmony|AssemblyCSharp|Unity)/

/** 从堆栈中提取非引擎命名空间（通常是模组程序集）。 */
function modsFromStack(details) {
  const out = new Set()
  for (const m of String(details || '').matchAll(/at ([A-Za-z_][\w.]*\.[\w`<>+_]+)/g)) {
    const parts = m[1].split('.')
    if (parts.length < 2) continue
    const ns = parts[0] + '.' + parts[1]
    if (LOG_ENGINE_NS.test(ns)) continue
    out.add(ns)
  }
  return out
}

/** 从 "file: <路径>" 提取模组身份（工坊 ID 或本地模组目录名）。 */
function modFromPath(p) {
  const s = String(p || '')
  const ws = /workshop[\\/]content[\\/]\d+[\\/](\d+)/i.exec(s)
  if (ws) return '工坊 ' + ws[1]
  const lm = /[\\/]Mods[\\/]([^\\/]+)/i.exec(s)
  if (lm) return lm[1]
  return null
}

/** 逐条产出日志记录：maxBytes>0 时只读尾部，否则全量流式读取。 */
async function* logEntries(file, maxBytes) {
  if (maxBytes > 0) {
    const text = readTailText(file, maxBytes)
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t[0] !== '{') continue
      const j = jparse(t, null)
      if (j) yield j
    }
    return
  }
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    const t = line.trim()
    if (!t || t[0] !== '{') continue
    const j = jparse(t, null)
    if (j) yield j
  }
}

/** 7b. 日志聚合分析 —— 按时间段 / 错误模式 / 模组归属分组统计。 */
async function aggregateLog(args) {
  const source = String(args.source || 'game')
  const file = pickLogFile(source)
  const keep = levelFilterOf(args.level || 'error')
  const textOk = textFilterOf(args.pattern)
  const since = String(args.since || '').trim()
  const until = String(args.until || '').trim()
  const topN = Math.max(1, Math.min(Number(args.topN) || 20, 100))
  const bucketName = String(args.bucket || 'hour').toLowerCase()
  const bucketLen = bucketName === 'minute' ? 16 : bucketName === 'day' ? 10 : 13
  const groupBy = String(args.groupBy || 'all').toLowerCase()
  const want = (k) => groupBy === 'all' || groupBy.split(/[,\s]+/).indexOf(k) >= 0
  const maxScanMB = Math.max(0, Number(args.maxScanMB) || 0)

  const counts = { INFO: 0, WARNING: 0, ERROR: 0, OTHER: 0 }
  const patterns = new Map()
  const mods = new Map()
  const timeBuckets = new Map()
  let scanned = 0
  let matched = 0
  let firstTs = null
  let lastTs = null

  for await (const e of logEntries(file, maxScanMB * 1048576)) {
    scanned++
    const lv = String(e.level || 'UNKNOWN').toUpperCase()
    if (lv in counts) counts[lv]++
    else counts.OTHER++
    const ts = String(e.timestamp || '')
    if (!firstTs) firstTs = ts
    lastTs = ts
    if (!keep(e)) continue
    if (since && ts < since) continue
    if (until && ts > until) continue
    if (!textOk(e)) continue
    matched++

    if (want('time')) {
      const key = ts.slice(0, bucketLen)
      timeBuckets.set(key, (timeBuckets.get(key) || 0) + 1)
    }

    const msg = String(e.message || '')
    const attach = new Set(modsFromStack(String(e.details || '')))
    const mm = /^Mod ([^\s]+) has multiple/.exec(msg)
    if (mm) attach.add(mm[1])
    const fm = /file:\s*([^\n]+)/.exec(msg)
    if (fm) {
      const mod = modFromPath(fm[1])
      if (mod) attach.add(mod)
    }
    for (const r of (e.context && e.context.relatedModIds) || []) attach.add(String(r))

    if (want('mod')) {
      for (const m of attach) {
        const cur = mods.get(m) || { count: 0, sample: msg.replace(/\s+/g, ' ').slice(0, 140) }
        cur.count++
        mods.set(m, cur)
      }
    }
    if (want('pattern')) {
      const sk = skeletonOf(msg)
      let p = patterns.get(sk.key)
      if (!p) {
        p = { key: sk.key, count: 0, first: ts, last: ts, sample: msg.replace(/\s+/g, ' ').slice(0, 240), mods: new Set(), files: new Set(), variants: new Map() }
        patterns.set(sk.key, p)
      }
      p.count++
      p.last = ts
      for (const m of attach) if (p.mods.size < 8) p.mods.add(m)
      if (fm && p.files.size < 4) p.files.add(fm[1].trim())
      for (const v of sk.variants) {
        if (p.variants.size < 40 || p.variants.has(v)) p.variants.set(v, (p.variants.get(v) || 0) + 1)
      }
    }
  }

  const timeRows = [...timeBuckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, c]) => ({ bucket: k, count: c }))
  const modRows = [...mods.entries()].sort((a, b) => b[1].count - a[1].count)
  const patternRows = [...patterns.values()].sort((a, b) => b.count - a.count)

  const lines = [
    '日志聚合分析 — ' + (source === 'app' ? 'RimCrow 应用日志' : 'RimWorld 实时日志（RimCrow Companion 采集）'),
    '文件: ' + file + (maxScanMB > 0 ? '（仅扫描尾部 ' + maxScanMB + ' MB）' : '（全量扫描）'),
    '扫描记录: ' + scanned + ' 条 ｜ 时间范围: ' + (firstTs || '-') + ' → ' + (lastTs || '-'),
    '级别统计: INFO=' + counts.INFO + ' WARNING=' + counts.WARNING + ' ERROR=' + counts.ERROR + (counts.OTHER ? ' OTHER=' + counts.OTHER : ''),
    '过滤条件: 级别=' + String(args.level || 'error').toUpperCase() +
      (args.pattern ? ' ｜ 关键词="' + args.pattern + '"' : '') +
      (since ? ' ｜ since=' + since : '') +
      (until ? ' ｜ until=' + until : '') +
      ' → 命中 ' + matched + ' 条',
  ]

  if (want('time') && timeRows.length) {
    lines.push('', '■ 时间段分布（按 ' + bucketName + '）')
    for (const r of timeRows) lines.push('  ' + r.bucket + '  ' + r.count)
  }

  if (want('level')) {
    lines.push('', '■ 级别总计')
    for (const [k, v] of Object.entries(counts)) lines.push('  ' + k + ': ' + v)
  }

  if (want('pattern') && patternRows.length) {
    lines.push('', '■ 模式 TOP ' + Math.min(topN, patternRows.length) + '（共 ' + patternRows.length + ' 种模式）')
    patternRows.slice(0, topN).forEach((p, i) => {
      lines.push('  #' + (i + 1) + '  ' + p.count + ' 次  [' + p.first + ' → ' + p.last + ']')
      lines.push('      ' + p.key)
      lines.push('      样本: ' + p.sample)
      if (p.mods.size) lines.push('      归属: ' + [...p.mods].join(', '))
      if (p.files.size) lines.push('      出错文件: ' + [...p.files].join(' | '))
      const vTop = [...p.variants.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      if (vTop.length) lines.push('      高频取值: ' + vTop.map(([k, v]) => k + '(' + v + ')').join(', '))
    })
  }

  if (want('mod') && modRows.length) {
    lines.push('', '■ 模组/来源归属 TOP ' + Math.min(topN, modRows.length) + '（共 ' + modRows.length + ' 个来源）')
    for (const [k, v] of modRows.slice(0, topN)) {
      lines.push('  ' + String(v.count).padStart(6) + '  ' + k)
      lines.push('          例: ' + v.sample)
    }
  }

  if (!matched) lines.push('', '（没有符合过滤条件的记录）')

  return {
    text: lines.join('\n'),
    mode: 'aggregate',
    file: file,
    scanned: scanned,
    matched: matched,
    counts: counts,
    timeRange: { from: firstTs, to: lastTs },
    patternTotal: patternRows.length,
    modTotal: modRows.length,
    groups: {
      time: want('time') ? timeRows : undefined,
      level: want('level') ? Object.entries(counts).map(([k, v]) => ({ key: k, count: v })) : undefined,
      pattern: want('pattern')
        ? patternRows.slice(0, topN).map((p) => ({
            key: p.key,
            count: p.count,
            first: p.first,
            last: p.last,
            sample: p.sample,
            mods: [...p.mods],
            files: [...p.files],
            variants: [...p.variants.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ value: k, count: v })),
          }))
        : undefined,
      mod: want('mod') ? modRows.slice(0, topN).map(([k, v]) => ({ key: k, count: v.count, sample: v.sample })) : undefined,
    },
  }
}

/** 7. 日志上下文 —— mode=recent（最近若干条，默认）/ mode=aggregate（分组统计）。 */
actions.get_log_context = async (args) => {
  const mode = String(args.mode || 'recent').toLowerCase()
  if (mode === 'aggregate' || mode === 'stats' || mode === 'summary') return await aggregateLog(args)
  return actions._log_recent(args)
}

function decodeArgs(raw) {
  if (raw.indexOf('base64:') === 0) {
    try { return jparse(Buffer.from(raw.slice(7), 'base64').toString('utf8'), {}) } catch { return {} }
  }
  return jparse(raw, {})
}
// ---------------------------------------------------------------- 入口
const action = process.argv[2]
const rawArgs = process.argv[3]

try {
  if (!action || !actions[action]) {
    throw new Error('未知 action: ' + String(action) + '（可用: ' + Object.keys(actions).join(', ') + '）')
  }
  const args = rawArgs ? decodeArgs(rawArgs) : {}
  const data = await actions[action](args)
  process.stdout.write(JSON.stringify({ ok: true, data: data, home: HOME, userDir: userDir() }))
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e), home: HOME, userDir: userDir() }))
}