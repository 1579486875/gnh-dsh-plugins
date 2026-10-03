/**
 * dsh-rimcrow-tools —— 把 RimCrow 的 AI 模组工具注册为 DSH 模型工具
 *
 * 注册在宿主组合层（host composition），因此**所有预设、所有会话**都能按需调用：
 *   get_active_mod_list  当前启用列表（ModsConfig.xml 的 activeMods）
 *   get_mod_info         模组元数据（mod_manager.db → modasset + usermoddata）
 *   get_mod_rules        模组规则（社区规则库 + 用户规则 + 元数据约束）
 *   search_mods          搜索模组（本地已装 + 创意工坊索引约 5.7 万条）
 *   get_group_mods       分组模组（groupdata + groupmod）
 *   get_mod_user_data    模组用户数据（usermoddata：别名/备注/标签/忽略问题）
 *   get_log_context      日志上下文（游戏实时日志 / RimCrow 应用日志）
 *
 * 全部**纯只读**：只读取 RimCrow / RimWorld 的文件与 SQLite，不写入任何数据。
 *
 * 实现说明：本插件刻意只使用 node: 内置模块（不 import 任何 @deepseek-ai/* 包），
 * 以避开外部 bundle 的模块解析问题；工具定义按 ToolRuntime.register 的契约手写，
 * 其中 parameters 与 output.schema 均为受支持子集内的标准 JSON Schema。
 *
 * @module dsh-rimcrow-tools
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 本插件根目录（…/dsh-rimcrow-tools）。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** 只读查询后端脚本。 */
const SCRIPT_PATH = join(ROOT, 'data', 'rimcrow-data.mjs')

/** Cordis 插件名。 */
export const name = 'rimcrow-tools'
/** 硬依赖：工具注册表与子进程服务。 */
export const inject = ['tools', 'subprocess']

/** 描述片段：所有工具共享的只读说明。 */
const READ_ONLY = '纯只读，不会修改任何 RimCrow / RimWorld 文件。'

/** 7 个模型工具的声明。 */
const TOOLS = [
  {
    name: 'get_active_mod_list',
    action: 'get_active_mod_list',
    description:
      '【RimCrow 工具 · 当前启用列表】读取 RimWorld 当前启用的模组列表（来自 ModsConfig.xml 的 activeMods，保留真实加载顺序），并关联 RimCrow 元数据给出中文别名、作者、创意工坊 ID、来源。支持 query 关键词过滤与 offset/limit 分页。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：按名称/别名/packageId/作者关键词过滤，例如 "ratkin" 或 "harmony"' },
        offset: { type: 'integer', description: '可选：分页起始下标，默认 0' },
        limit: { type: 'integer', description: '可选：本页返回条数，默认 50，最大 500' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_mod_info',
    action: 'get_mod_info',
    description:
      '【RimCrow 工具 · 模组元数据】查询模组的完整元数据：名称/中文别名、作者、版本、创意工坊 ID、来源与安装路径、支持版本、依赖、loadAfter/loadBefore 约束、不兼容项、体积、简介以及用户备注。query 可传 packageId、工坊 ID 或名称关键词。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'packageId、创意工坊 ID 或名称关键词，例如 "brrainz.harmony" 或 "鼠族"' },
        brief: { type: 'boolean', description: '可选：true 时简介截断到 200 字，便于快速浏览' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_mod_rules',
    action: 'get_mod_rules',
    description:
      '【RimCrow 工具 · 模组规则】读取 RimCrow 的社区规则库与用户自定义规则：某模组的 loadAfter/loadBefore 社区约定、本地元数据中的排序与不兼容约束，以及“哪些模组在规则里引用了它”的反向引用。不传 query 时返回规则库概览。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：packageId 或名称关键词，例如 "brrainz.harmony"；省略则返回规则库统计概览' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_mods',
    action: 'search_mods',
    description:
      '【RimCrow 工具 · 搜索模组】在本地已安装模组库与 RimCrow 创意工坊索引（约 5.7 万条）中，按名称、packageId 或工坊 ID 搜索模组，返回是否已安装/启用、作者、支持版本、工坊 ID。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，例如 "ratkin"、"rim.job.world" 或工坊 ID 片段' },
        limit: { type: 'integer', description: '可选：返回条数上限，默认 20，最大 100' },
        scope: {
          type: 'string',
          enum: ['all', 'installed', 'workshop'],
          description: '可选：搜索范围。all=本地+工坊（默认），installed=仅本地已装，workshop=仅工坊索引',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_group_mods',
    action: 'get_group_mods',
    description:
      '【RimCrow 工具 · 分组模组】读取 RimCrow 中创建的模组分组，以及每个分组包含的模组清单（含中文名）。若尚未创建分组则明确返回空状态。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：按分组名称或分组 ID 过滤' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_mod_user_data',
    action: 'get_mod_user_data',
    description:
      '【RimCrow 工具 · 模组用户数据】读取用户在 RimCrow 中为模组记录的个人数据：中文别名、备注说明、标签、标记颜色、自定义类型、被忽略的问题（如 missing_dependency）。支持关键词过滤与分页。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：按模组名/别名/备注/标签关键词过滤，例如 "RJW"' },
        offset: { type: 'integer', description: '可选：分页起始下标，默认 0' },
        limit: { type: 'integer', description: '可选：本页条数，默认 30，最大 500' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_log_context',
    action: 'get_log_context',
    description:
      '【RimCrow 工具 · 日志上下文】读取 RimWorld 实时日志（RimCrow Companion 采集的 JSON 日志）或 RimCrow 应用日志。mode="recent"（默认）返回最近若干条，可按级别/关键词过滤并附带堆栈；mode="aggregate" 会全量扫描整份日志，按「时间段 / 错误模式 / 模组归属」分组统计，并给出每条模式的高频取值（具体是哪些 Def、哪些文件），适合一次性看清所有红字、各由哪些模组引起、集中在什么时候。用于排查模组报错。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['recent', 'aggregate'],
          description: '可选：recent=返回最近若干条（默认）；aggregate=全量扫描并分组统计',
        },
        source: { type: 'string', enum: ['game', 'app'], description: '可选：game=游戏实时日志（默认），app=RimCrow 应用日志' },
        lines: { type: 'integer', description: 'recent 专用：返回最近多少条，默认 60，最大 500' },
        level: {
          type: 'string',
          enum: ['all', 'info', 'warning', 'error'],
          description: '可选：级别过滤。recent 默认 all，aggregate 默认 error；warning 会同时包含 error',
        },
        pattern: { type: 'string', description: '可选：按消息/堆栈关键词过滤，例如某个模组名或异常类型' },
        includeDetails: { type: 'boolean', description: 'recent 专用：true 时附带异常堆栈详情的前 600 字' },
        groupBy: {
          type: 'string',
          enum: ['all', 'pattern', 'mod', 'time', 'level'],
          description: 'aggregate 专用：分组维度，默认 all。pattern=错误模式、mod=模组归属、time=时间段、level=级别计数',
        },
        topN: { type: 'integer', description: 'aggregate 专用：每个分组返回条数，默认 20，最大 100' },
        since: { type: 'string', description: 'aggregate 专用：起始时间，格式 "YYYY-MM-DD HH:MM"，如 "2026-09-16 19:00"' },
        until: { type: 'string', description: 'aggregate 专用：截止时间，格式同上' },
        bucket: { type: 'string', enum: ['hour', 'minute', 'day'], description: 'aggregate 专用：时间段粒度，默认 hour' },
        maxScanMB: { type: 'integer', description: 'aggregate 专用：只扫描日志尾部多少 MB，0=全量（默认）。日志很大时可用它加速' },
      },
      additionalProperties: false,
    },
  },
]

/**
 * 构建一个可注册的 ToolDefinition。
 * @param spec - 工具声明（name / description / parameters / action）。
 * @param run - 执行后端查询的函数 (action, args, signal) => Promise<object>。
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
 * 注册 RimCrow 工具集。
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
      throw new Error('RimCrow 查询进程启动失败：' + String(error && error.message ? error.message : error))
    }
    const stdout = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderr = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    if (!stdout || !String(stdout).trim()) {
      throw new Error('RimCrow 查询后端无输出（退出码 ' + String(outcome && outcome.exitCode) + '）：' + String(stderr).slice(0, 400))
    }
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error('RimCrow 查询结果解析失败：' + String(stdout).slice(0, 300))
    }
    if (!parsed || parsed.ok !== true) {
      throw new Error('RimCrow 查询失败：' + String(parsed && parsed.error ? parsed.error : '未知错误'))
    }
    return parsed.data
  }

  for (const spec of TOOLS) {
    ctx.tools.register(makeDefinition(spec, query))
  }
}
