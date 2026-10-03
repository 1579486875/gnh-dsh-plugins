/**
 * dsh-mod-classifier —— 把 RimWorld 模组分类器注册为 DSH 模型工具
 *
 * 注册在宿主组合层（host composition），因此**所有预设、所有会话**都能按需调用：
 *   mod_classify_scan     全库扫描归类（规则计算，返回分组方案）
 *   mod_classify_check    内容校验（按模组描述核对现有分组是否名副其实）
 *   mod_classify_explain  单模组诊断（描述 / 当前组 / 命中规则 / 建议归属）
 *   mod_classify_rules    分类规则维护（读写插件自带的 rules.json）
 *
 * 数据访问**纯只读**：只读取 RimCrow 的 SQLite（mod_manager.db）与 RimWorld 配置，
 * 不写入任何 RimCrow / RimWorld 数据。真正改分组仍由 AI 调用官方 MCP 工具
 * （mcp__rimcrow__create_group / add_mods_to_group / remove_mods_from_group）完成。
 *
 * 实现说明：本插件刻意只使用 node: 内置模块（不 import 任何 @deepseek-ai/* 包），
 * 以避开外部 bundle 的模块解析问题；工具定义按 ToolRuntime.register 的契约手写。
 *
 * @module dsh-mod-classifier
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 本插件根目录（…/dsh-mod-classifier）。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** 只读后端脚本。 */
const SCRIPT_PATH = join(ROOT, 'data', 'classify-data.mjs')

/** Cordis 插件名。 */
export const name = 'mod-classifier'
/** 硬依赖：工具注册表与子进程服务。 */
export const inject = ['tools', 'subprocess']

/** 共享说明：读写边界。 */
const READ_ONLY = '【只读 RimCrow】不会修改 RimCrow 分组；实际写入请用 mcp__rimcrow__create_group / add_mods_to_group / remove_mods_from_group。'

/** 4 个模型工具的声明。 */
const TOOLS = [
  {
    name: 'mod_classify_scan',
    action: 'scan',
    description:
      '【模组分类器 · 扫描归类】读取 RimCrow 全库模组（含未启用），按 rules.json 的关键词规则 + 精确覆盖表，计算每个模组**应该**归属的分组，返回「组名 → 模组 id 清单」、每组数量、未归类项。典型用途：给新订阅的模组规划归类；与 RimCrow 当前分组比对找出偏差。纯计算，不写入。' +
      READ_ONLY,
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '可选：只看某个分组的结果（模糊匹配组名）' },
        unclassifiedOnly: { type: 'boolean', description: '可选：true 时只返回未归类（规则算不出归属）的模组' },
        query: { type: 'string', description: '可选：按 packageId / 名称 / 别名关键词过滤结果' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mod_classify_check',
    action: 'check',
    description:
      '【模组分类器 · 内容校验】按模组的**实际描述内容**核对其当前所属分组是否名副其实：取每个模组的 description，与该组主题词表（hints）比对，列出「描述与组主题零匹配」或「明显命中其他组强特征」的可疑项，并给出建议归属与理由。用于发现"名字像 A 类、内容其实是 B 类"的错放（例：温泉被归入能源）。纯只读。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '可选：只检查某个分组（模糊匹配组名）' },
        limit: { type: 'integer', description: '可选：最多返回多少条可疑项，默认 60' },
        minDescLen: { type: 'integer', description: '可选：描述长度低于该值的模组跳过（默认 25，描述太短无法判断）' },
        includeSuggestions: { type: 'boolean', description: '可选：是否附上建议归属（默认 true，会略慢）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mod_classify_explain',
    action: 'explain',
    description:
      '【模组分类器 · 单模组诊断】给定 packageId / 名称关键词 / 工坊 ID，返回该模组的详情：中文别名、描述摘要、当前在 RimCrow 里属于哪个分组、命中了哪条分类规则（或哪条精确覆盖）、按规则应该归到哪、以及同组邻居。用于逐个判断模组该放哪个类目。纯只读。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'packageId、名称/别名关键词或工坊 ID，例如 "otyyoty.sizedapparel"、"温泉"、"3807680874"' },
        neighbors: { type: 'integer', description: '可选：同组邻居返回条数，默认 8' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'mod_classify_rules',
    action: 'rules',
    description:
      '【模组分类器 · 规则维护】查看或修改分类规则表（插件自带 rules.json，与 RimCrow 数据无关、可随时改）。op=get 概览；op=list 列出规则匹配顺序；op=listKeys 列某组关键词；op=setKeys 整体替换某组关键词；op=addKey / op=removeKey 增删单个关键词；op=setOverride（需 id + group）维护精确覆盖；op=removeOverride（需 id）删除覆盖；op=hints 查看/设置某组的内容校验主题词（需 group，可选 keys）。修改后立即对后续 scan / check 生效。',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['get', 'list', 'listKeys', 'setKeys', 'addKey', 'removeKey', 'setOverride', 'removeOverride', 'hints', 'setHints'],
          description: '操作类型',
        },
        group: { type: 'string', description: '分组名（listKeys / setKeys / addKey / removeKey / hints / setHints 需要）' },
        key: { type: 'string', description: '单个关键词（addKey / removeKey 需要）' },
        keys: { type: 'array', items: { type: 'string' }, description: '关键词数组（setKeys / setHints 需要）' },
        id: { type: 'string', description: '模组 packageId（setOverride / removeOverride 需要）' },
      },
      required: ['op'],
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
 * 注册模组分类器工具集。
 * @param ctx - 宿主 Cordis 上下文（已注入 tools 与 subprocess）。
 */
export function apply(ctx) {
  const subprocess = ctx.subprocess

  /**
   * 调用只读后端，返回其结构化结果。
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
        stdout: { maxBytes: 16 * 1024 * 1024 },
        stderr: { maxBytes: 262144 },
      },
      graceMs: 8000,
      signal: signal,
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error('模组分类器进程启动失败：' + String(error && error.message ? error.message : error))
    }
    const stdout = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderr = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    if (!stdout || !String(stdout).trim()) {
      throw new Error('模组分类器后端无输出（退出码 ' + String(outcome && outcome.exitCode) + '）：' + String(stderr).slice(0, 400))
    }
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error('模组分类器结果解析失败：' + String(stdout).slice(0, 300))
    }
    if (!parsed || parsed.ok !== true) {
      throw new Error('模组分类器执行失败：' + String(parsed && parsed.error ? parsed.error : '未知错误'))
    }
    return parsed.data
  }

  for (const spec of TOOLS) {
    ctx.tools.register(makeDefinition(spec, query))
  }
}
