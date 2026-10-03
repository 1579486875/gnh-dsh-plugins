/**
 * cherry-kb-data.mjs —— Cherry Studio 知识库只读查询后端。
 *
 * CLI 契约（与 dsh-rimcrow-tools 一致）：
 *   node cherry-kb-data.mjs <action> base64:<json>
 * stdout 输出 { ok: true, data } 或 { ok: false, error }。
 *
 * 动作：
 *   list_kbs       列出知识库（可带文件清单）
 *   search         全文检索（FTS5 trigram + BM25，短词回退 LIKE）
 *   read_material  读取某文件的原文内容（分页）
 *
 * 全程只读：所有 SQLite 连接均 readOnly / immutable，绝不写入 Cherry Studio 数据。
 */

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { existsSync, statSync, readdirSync } from 'node:fs'

/** Cherry Studio 数据根目录（可用环境变量 CHERRY_KB_ROOT 覆盖）。 */
const CHERRY_ROOT = process.env.CHERRY_KB_ROOT || join(process.env.APPDATA || '', 'CherryStudio')
const DATA_DIR = join(CHERRY_ROOT, 'Data')
const KB_DIR = join(DATA_DIR, 'KnowledgeBase')

function main() {
  const action = process.argv[2]
  const raw = process.argv[3] || ''
  const json = raw.startsWith('base64:') ? Buffer.from(raw.slice(7), 'base64').toString('utf8') : raw
  const args = json ? JSON.parse(json) : {}
  let data
  switch (action) {
    case 'list_kbs':
      data = listKbs(args)
      break
    case 'search':
      data = search(args)
      break
    case 'read_material':
      data = readMaterial(args)
      break
    default:
      throw new Error('未知 action: ' + String(action))
  }
  process.stdout.write(JSON.stringify({ ok: true, data }))
}

/**
 * 只读打开 SQLite。
 * WAL 库在 -shm 附属文件缺失（干净关闭）时无法以纯只读方式打开，
 * 此时回退 file: URI + immutable=1 免锁打开（该状态下数据已完整 checkpoint）。
 */
function openDb(p) {
  let db = null
  try {
    db = new DatabaseSync(p, { readOnly: true })
    db.prepare('SELECT count(*) FROM sqlite_master').get()
    return db
  } catch {
    if (db) {
      try { db.close() } catch {}
    }
    const uri = 'file:' + p.replace(/\\/g, '/') + '?immutable=1'
    const alt = new DatabaseSync(uri, { readOnly: true })
    alt.prepare('SELECT count(*) FROM sqlite_master').get()
    return alt
  }
}

/** 打开 Cherry 主数据库（只读）。 */
function openMain() {
  const p = join(DATA_DIR, 'cherrystudio.sqlite')
  if (!existsSync(p)) throw new Error('未找到 Cherry Studio 主数据库：' + p)
  return openDb(p)
}

/** 把 kb 参数（名字模糊 / 完整 id）解析为知识库目标列表；空则全部。 */
function resolveKbs(kb) {
  const main = openMain()
  try {
    let rows = main.prepare('SELECT id, name FROM knowledge_base ORDER BY created_at').all()
    const q = String(kb || '').trim().toLowerCase()
    if (q) {
      rows = rows.filter((r) => String(r.id).toLowerCase() === q || String(r.name).toLowerCase().includes(q))
      if (rows.length === 0) {
        const all = main.prepare('SELECT name FROM knowledge_base ORDER BY created_at').all().map((r) => r.name).join(' / ')
        throw new Error('没有匹配的知识库 "' + kb + '"。现有知识库：' + (all || '（无）'))
      }
    }
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      indexPath: join(KB_DIR, String(r.id), '.cherry', 'index.sqlite'),
    }))
  } finally {
    main.close()
  }
}

/** 列出知识库（名称/配置/切块统计 + 可选文件清单 + 旧版遗留向量库）。 */
function listKbs(args) {
  const targets = resolveKbs(args.kb)
  const main = openMain()
  let metas = []
  try {
    metas = main.prepare(
      'SELECT id, name, dimensions, embedding_model_id, rerank_model_id, chunk_size, chunk_overlap, chunk_strategy, document_count, status FROM knowledge_base ORDER BY created_at'
    ).all()
  } finally {
    main.close()
  }
  const byId = new Map(metas.map((m) => [String(m.id), m]))
  const kbs = []
  for (const t of targets) {
    const meta = byId.get(t.id) || {}
    const entry = {
      id: t.id,
      name: t.name,
      dimensions: meta.dimensions ?? null,
      embeddingModel: meta.embedding_model_id ?? null,
      chunkSize: meta.chunk_size ?? null,
      chunkStrategy: meta.chunk_strategy ?? null,
      documentCount: meta.document_count ?? null,
      status: meta.status ?? null,
    }
    if (existsSync(t.indexPath)) {
      const db = openDb(t.indexPath)
      try {
        entry.fileCount = db.prepare('SELECT COUNT(*) AS n FROM material').get().n
        entry.unitCount = db.prepare('SELECT COUNT(*) AS n FROM search_unit').get().n
        if (args.files) {
          entry.files = db.prepare('SELECT relative_path AS path FROM material ORDER BY relative_path').all()
        }
      } finally {
        db.close()
      }
    } else {
      entry.fileCount = null
    }
    kbs.push(entry)
  }
  const legacy = legacyLibs()
  const lines = []
  lines.push('Cherry Studio 知识库共 ' + kbs.length + ' 个' + (legacy.length ? '（另有 ' + legacy.length + ' 个旧版遗留向量库）' : '') + '：')
  for (const k of kbs) {
    lines.push('- [' + k.name + '] id=' + k.id + ' · 文档 ' + k.documentCount + ' · 文件 ' + k.fileCount + ' · 切块 ' + k.unitCount + ' · chunk=' + k.chunkSize + '(' + k.chunkStrategy + ') · ' + k.dimensions + '维 · ' + (k.status || '?'))
    if (k.files) {
      for (const f of k.files) lines.push('    · ' + f.path)
    }
  }
  for (const l of legacy) {
    lines.push('- [旧版遗留] ' + l.id + ' · ' + (l.bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB · ' + (l.dimensions || '?') + '维向量库（旧版格式，桥接仅报告不检索）')
  }
  return { text: lines.join('\n'), kbs, legacy }
}

/** 旧版遗留单文件向量库（KB 根目录下的 SQLite 文件）。 */
function legacyLibs() {
  const out = []
  let names = []
  try {
    names = readdirSync(KB_DIR)
  } catch {
    return out
  }
  for (const n of names) {
    const p = join(KB_DIR, n)
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      const db = openDb(p)
      try {
        const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vectors'").get()
        if (!schema) continue
        const dim = /F32_BLOB\((\d+)\)/.exec(String(schema.sql))
        out.push({ id: n, bytes: st.size, dimensions: dim ? Number(dim[1]) : null })
      } finally {
        db.close()
      }
    } catch {
      // 非 SQLite 或无法打开：跳过。
    }
  }
  return out
}

/** 全文检索（FTS5 trigram + BM25；不足 3 字符或 FTS 异常/无结果时回退 LIKE）。 */
function search(args) {
  const q = String(args.query || '').trim()
  if (!q) throw new Error('query 不能为空')
  const lim = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 50)
  const targets = resolveKbs(args.kb)
  const rows = []
  for (const t of targets) {
    if (!existsSync(t.indexPath)) continue
    const db = openDb(t.indexPath)
    try {
      const joinSql =
        ' FROM search_text st JOIN search_unit su ON su.unit_id = st.target_id JOIN material m ON m.material_id = su.material_id '
      let hits = []
      if ([...q].length >= 3) {
        const phrase = '"' + q.replace(/"/g, '""') + '"'
        try {
          hits = db.prepare(
            'SELECT st.text AS text, su.title AS title, su.unit_index AS unit_index, m.relative_path AS relative_path' +
              ' FROM search_text_fts f JOIN search_text st ON st.fts_rowid = f.rowid' +
              ' JOIN search_unit su ON su.unit_id = st.target_id JOIN material m ON m.material_id = su.material_id' +
              ' WHERE search_text_fts MATCH ? ORDER BY bm25(search_text_fts) LIMIT ?'
          ).all(phrase, lim)
        } catch {
          hits = []
        }
      }
      if (hits.length === 0) {
        hits = db.prepare(
          'SELECT st.text AS text, su.title AS title, su.unit_index AS unit_index, m.relative_path AS relative_path' +
            joinSql +
            'WHERE st.text LIKE ? ESCAPE \'\\\' LIMIT ?'
        ).all('%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%', lim)
      }
      for (const h of hits) {
        rows.push({
          kb: t.name,
          path: String(h.relative_path),
          title: h.title ? String(h.title) : null,
          unit: h.unit_index,
          text: String(h.text).slice(0, 600),
        })
      }
    } finally {
      db.close()
    }
  }
  rows.length = Math.min(rows.length, lim)
  const lines = ['检索 "' + q + '" 命中 ' + rows.length + ' 条' + (args.kb ? '（知识库: ' + args.kb + '）' : '（全部知识库）') + '：']
  rows.forEach((r, i) => {
    lines.push('')
    lines.push('## ' + (i + 1) + '. [' + r.kb + '] ' + r.path + (r.title ? ' · ' + r.title : '') + ' · 块#' + r.unit)
    lines.push(r.text)
  })
  if (rows.length === 0) lines.push('（未命中。可换关键词，或用 cherry_kb_list 查看知识库与文件清单。）')
  return { text: lines.join('\n'), matched: rows.length, rows }
}

/** 读取原文（按 material 的当前内容，分页）。 */
function readMaterial(args) {
  const path = String(args.path || '').trim()
  if (!path) throw new Error('path 不能为空（文件相对路径，来自 cherry_kb_list 的 files）')
  const targets = resolveKbs(args.kb)
  const t = targets[0]
  if (!existsSync(t.indexPath)) throw new Error('知识库索引不存在：' + t.name)
  const db = openDb(t.indexPath)
  try {
    const m = db.prepare('SELECT material_id, current_content_hash FROM material WHERE relative_path = ?').get(path)
    if (!m) {
      const sample = db.prepare('SELECT relative_path AS p FROM material LIMIT 20').all().map((r) => r.p)
      throw new Error('未找到文件 "' + path + '"。该知识库文件示例：\n' + sample.join('\n'))
    }
    const c = db.prepare('SELECT text FROM content WHERE content_hash = ?').get(m.current_content_hash)
    const full = c ? String(c.text) : ''
    const start = Math.max(0, parseInt(args.start, 10) || 0)
    const len = Math.min(Math.max(parseInt(args.length, 10) || 4000, 1), 20000)
    const slice = full.slice(start, start + len)
    const head = '[' + t.name + '] ' + path + ' · 全文 ' + full.length + ' 字 · 显示 ' + start + '~' + (start + slice.length)
    return { text: head + '\n\n' + slice, kb: t.name, path, total: full.length, start }
  } finally {
    db.close()
  }
}

try {
  main()
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }))
}