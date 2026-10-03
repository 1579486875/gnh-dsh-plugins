/**
 * dsh-cherry-kb-bridge —— 把 Cherry Studio 本地知识库桥接为 DSH 模型工具
 *
 * 注册在宿主组合层（host composition），因此**所有预设、所有会话**都能按需调用：
 *   cherry_kb_list    列出 Cherry Studio 知识库（名称/文档数/切块配置/文件清单/遗留库）
 *   cherry_kb_query   在 Cherry 知识库全文检索（FTS5 trigram + BM25，短词回退 LIKE）
 *   cherry_kb_read    按文件路径读取知识库原文（分页）
 *
 * 全部**纯只读**：只读取 Cherry Studio 的 SQLite，不写入任何数据。
 *
 * 实现说明：与 dsh-rimcrow-tools 相同，本插件刻意只使用 node: 内置模块
 * （不 import 任何 @deepseek-ai/* 包）以避开外部 bundle 的模块解析问题；
 * 工具定义按 ToolRuntime.register 的契约手写。查询走独立后端子进程。
 *
 * @module dsh-cherry-kb-bridge
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 本插件根目录（…/dsh-cherry-kb-bridge）。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** 只读查询后端脚本。 */
const SCRIPT_PATH = join(ROOT, 'data', 'cherry-kb-data.mjs')

/** Cordis 插件名。 */
export const name = 'cherry-kb-bridge'
/** 硬依赖：工具注册表与子进程服务。 */
export const inject = ['tools', 'subprocess']

/** 描述片段：所有工具共享的只读说明。 */
const READ_ONLY = '纯只读，不会修改任何 Cherry Studio 数据。'

/** 3 个模型工具的声明。 */
const TOOLS = [
  {
    name: 'cherry_kb_list',
    action: 'list_kbs',
    description:
      '【Cherry Studio 知识库 · 列表】列出本机 Cherry Studio 的知识库：名称、id、文档数、切块配置、embedding 模型与维度，可选列出每个知识库的文件清单；同时报告旧版遗留向量库。典型用法：检索前先看有哪些知识库、叫什么名字。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        kb: { type: 'string', description: '可选：按知识库名字（模糊）或完整 id 过滤，省略则列出全部' },
        files: { type: 'boolean', description: '可选：true 时附带每个知识库的文件清单（relative_path）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cherry_kb_query',
    action: 'search',
    description:
      '【Cherry Studio 知识库 · 全文检索】在本机 Cherry Studio 知识库里检索文档内容（FTS5 trigram + BM25 相关度排序，中文免分词；查询词不足 3 字符或无结果时自动回退 LIKE 子串匹配）。返回命中的文本片段、来源文件与所在块号。典型用法：查资料、查设定、查手册内容。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（3 字符以上效果最佳）' },
        kb: { type: 'string', description: '可选：限定知识库（名字模糊或完整 id），省略则搜索全部知识库' },
        limit: { type: 'integer', description: '可选：返回条数上限，默认 8，最大 50' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'cherry_kb_read',
    action: 'read_material',
    description:
      '【Cherry Studio 知识库 · 读原文】按文件路径读取知识库中某个文件的原文内容（分页）。path 来自 cherry_kb_list 的 files 清单或 cherry_kb_query 的命中结果。典型用法：检索命中后读取完整上下文。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        kb: { type: 'string', description: '知识库（名字模糊或完整 id）' },
        path: { type: 'string', description: '文件相对路径（relative_path）' },
        start: { type: 'integer', description: '可选：起始字符下标，默认 0' },
        length: { type: 'integer', description: '可选：读取长度，默认 4000，最大 20000' },
      },
      required: ['kb', 'path'],
      additionalProperties: false,
    },
  },
]

/**
 * 把工具 spec 包装成交给 ctx.tools.register 的定义对象。
 * @param spec - 工具声明。
 * @param run - 后端调用函数。
 * @returns 交给 ctx.tools.register 的定义对象。
 */
function makeDefinition(spec, run) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    timeoutMs: 60000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const text = value && typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2)
        return [{ type: 'text', text: text }]
      },
    },
    async execute(args, exec) {
      return await run(spec.action, args, exec && exec.signal)
    },
  }
}

/**
 * 注册 Cherry Studio 知识库桥接工具集。
 * @param ctx - 宿主 Cordis 上下文（已注入 tools 与 subprocess）。
 */
export function apply(ctx) {
  const subprocess = ctx.subprocess

  /**
   * 调用只读查询后端，返回其结构化结果。
   * @param action - 后端 action 名。
   * @param args - 工具参数（lossless JSON）。
   * @param signal - 调用方取消信号。
   * @returns 后端的 data 字段。
   */
  async function query(action, args, signal) {
    const payload = 'base64:' + Buffer.from(JSON.stringify(args && typeof args === 'object' ? args : {}), 'utf8').toString('base64')
    let nodeExe = process.execPath
    try {
      nodeExe = await subprocess.resolveExecutable(process.execPath, undefined, signal)
    } catch {
      // 解析失败时直接使用当前 Node 可执行文件路径。
    }
    const handle = subprocess.spawn({
      argv: [nodeExe, SCRIPT_PATH, action, payload],
      cwd: ROOT,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8 * 1024 * 1024 },
        stderr: { maxBytes: 262144 },
      },
      graceMs: 5000,
      signal: signal,
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error('Cherry 知识库查询进程启动失败：' + String(error && error.message ? error.message : error))
    }
    const stdout = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderr = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    if (!stdout || !String(stdout).trim()) {
      throw new Error('Cherry 知识库查询后端无输出（退出码 ' + String(outcome && outcome.exitCode) + '）：' + String(stderr).slice(0, 400))
    }
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error('Cherry 知识库查询结果解析失败：' + String(stdout).slice(0, 300))
    }
    if (!parsed || parsed.ok !== true) {
      throw new Error('Cherry 知识库查询失败：' + String(parsed && parsed.error ? parsed.error : '未知错误'))
    }
    return parsed.data
  }

  for (const spec of TOOLS) {
    ctx.tools.register(makeDefinition(spec, query))
  }
}