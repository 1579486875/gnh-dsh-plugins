/**
 * dsh-self-heal 契约自检（需要本机装有 DSH，找不到就自动跳过）。
 *
 * 为什么要有这个东西：
 *   本插件挂在 DSH 的三个官方扩展点上，还调用了两个官方服务。这些接口一旦
 *   在 DSH 升级后改名或改形状，插件**不会在加载时报错**，而是在真实对话里
 *   静默失效 —— 那是最难查的一类故障。所以这里用「真实的 DSH 包」来验证：
 *
 *     A. 我们依赖的包、事件名、服务方法都还在；
 *     B. 我们伪造的终止分片能被**官方组装器**接受；
 *     C. 我们注入的提醒消息能被**官方会话**接受；
 *     D. 我们的熔断 code 与官方默认重试白名单确实没有交集。
 *
 * 运行：node test/contract-check.mjs
 * 指定安装位置：DSH_PACKAGES=<...>/node_modules/@deepseek-ai
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CODES, apply, createNoticeMessage, resolveConfig } from '../lib/index.js'

/** 本机 DSH 内部包的默认位置（Windows 下 npm 全局安装）。 */
const DEFAULT_ROOT = join(
  process.env.APPDATA ?? '',
  'npm',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'node_modules',
  '@deepseek-ai',
)

const ROOT = process.env.DSH_PACKAGES ?? DEFAULT_ROOT

let passed = 0
let failed = 0
let skipped = 0

/** 记一条通过的检查。 @param {string} label - 检查项。 */
function ok(label) {
  passed += 1
  console.log('  ✔ ' + label)
}

/** 记一条失败的检查。 @param {string} label - 检查项。 @param {unknown} detail - 失败详情。 */
function bad(label, detail) {
  failed += 1
  console.log('  ✖ ' + label)
  if (detail !== undefined) console.log('      ' + String(detail))
}

/** 记一条跳过的检查。 @param {string} label - 检查项。 */
function skip(label) {
  skipped += 1
  console.log('  ○ 跳过：' + label)
}

/**
 * 跑一个检查函数，把抛出的异常记成失败。
 * @param {string} label - 检查项名字。
 * @param {() => void|Promise<void>} run - 检查体（用 assert 断言）。
 * @returns {Promise<void>}
 */
async function check(label, run) {
  try {
    await run()
    ok(label)
  } catch (error) {
    bad(label, error instanceof Error ? error.message : error)
  }
}

/** 读取一个包内文件的内容；不存在返回 undefined。 */
function readPackageFile(pkg, relative) {
  const path = join(ROOT, pkg, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** 动态导入一个包内文件（绝对路径，绕开 package exports 限制）。 */
function importPackageFile(pkg, relative) {
  return import(pathToFileURL(join(ROOT, pkg, relative)).href)
}

console.log('dsh-self-heal 契约自检')
console.log('DSH 包目录：' + ROOT)

if (!existsSync(ROOT)) {
  console.log('\n找不到 DSH 安装位置，整组跳过（插件本身不依赖它，属正常情况）。')
  console.log('可用 DSH_PACKAGES 环境变量指定：<...>/node_modules/@deepseek-ai')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// A. 依赖的包 / 事件名 / 服务方法还在不在
// ---------------------------------------------------------------------------

console.log('\nA. 接口存在性')

const REQUIRED_PACKAGES = [
  'dsh-llm',
  'dsh-session',
  'dsh-agent',
  'dsh-agent-loop',
  'dsh-agent-preset-registry',
  'dsh-compaction',
  'dsh-llm-retry',
]

for (const pkg of REQUIRED_PACKAGES) {
  await check('包存在：' + pkg, () => {
    if (!existsSync(join(ROOT, pkg, 'package.json'))) throw new Error('缺少 ' + join(ROOT, pkg))
  })
}

/** 在源码里找一个字符串字面量，找不到就报错。 */
function expectInSource(pkg, relative, needle, why) {
  const text = readPackageFile(pkg, relative)
  if (text === undefined) throw new Error('读不到 ' + pkg + '/' + relative)
  if (!text.includes(needle)) throw new Error('在 ' + pkg + '/' + relative + ' 里找不到 ' + needle + '（' + why + '）')
}

await check('事件 llm/stream 仍然存在', () => {
  expectInSource('dsh-llm', join('lib', 'index.js'), '"llm/stream"', '本插件的主检测入口')
})

await check('事件 agent/request-error 仍然存在', () => {
  expectInSource('dsh-agent-loop', join('lib', 'index.js'), '"agent/request-error"', '熔断后的恢复入口')
})

await check('事件 agent/turn-stopping 仍然存在', () => {
  expectInSource('dsh-agent-loop', join('lib', 'index.js'), '"agent/turn-stopping"', '只想不说的补救入口')
})

await check('agent/request-error 仍然支持 { kind: "retry" } 让循环重发', () => {
  expectInSource('dsh-agent-loop', join('lib', 'index.js'), 'action?.kind !== "retry"', '恢复逻辑的返回值语义')
})

await check('服务入口 agentPresets.serviceFor(agent, name) 仍然存在', () => {
  expectInSource('dsh-agent-preset-registry', join('lib', 'types', 'mount.js'), 'export function serviceForAgent', '按 agent 取预设内服务')
})

await check('事件 tools/post-execute 仍然存在，且派发时以 exec.agent 定作用域', () => {
  expectInSource('dsh-tools', join('lib', 'index.js'), '"tools/post-execute"', '工具执行后的介入点')
  expectInSource('dsh-scope', join('lib', 'invariant.js'), '"tools/post-execute"', '官方作用域不变式里也认这个事件')
})

await check('工具执行的载荷仍带 agent / name / arguments，注入通道仍是 additionalContexts', () => {
  // 这三个字段名与注入通道，我们都是照着官方 dsh-repeat-tool-reminder 的用法来的；
  // 官方自己改了字段名，这条检查会跟着失败 —— 这正是我们要的早期报警。
  expectInSource('dsh-repeat-tool-reminder', join('lib', 'index.js'), 'exec.agent', '按 agent 记状态')
  expectInSource('dsh-repeat-tool-reminder', join('lib', 'index.js'), 'exec.name', '工具名')
  expectInSource('dsh-repeat-tool-reminder', join('lib', 'index.js'), 'exec.arguments', '工具参数')
  expectInSource('dsh-repeat-tool-reminder', join('lib', 'index.js'), 'additionalContexts', '把提醒交给下一步的通道')
})

await check('压缩服务 compactIfNeeded(agent, trigger, signal) 仍然存在', () => {
  const text = readPackageFile('dsh-compaction', join('lib', 'types', 'index.d.ts'))
  if (text === undefined) throw new Error('读不到 dsh-compaction 的类型定义')
  if (!text.includes('compactIfNeeded')) throw new Error('压缩服务的入口没了')
  if (!text.includes("'context-overflow'")) throw new Error('context-overflow 这一档 trigger 没了')
})

await check('用户消息的 source 采用自由 kind（插件可自报家门）', () => {
  const text = readPackageFile('dsh-llm', join('lib', 'types', 'message.d.ts'))
  if (text === undefined) throw new Error('读不到消息类型定义')
  if (!text.includes('MessageSourceMap')) throw new Error('消息来源类型没了')
})

// ---------------------------------------------------------------------------
// B. 我们伪造的终止分片，能不能过官方组装器
// ---------------------------------------------------------------------------

console.log('\nB. 熔断分片的协议合法性（用官方 BlockAssembler 实测）')

const assemblerModule = await importPackageFile('dsh-llm', join('lib', 'types', 'assembler.js'))
const BlockAssembler = assemblerModule.BlockAssembler

await check('块还没闭合就收到熔断 finish：官方组装器必须能收下', () => {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 0, text: '正在说话说到一半' })
  assembler.push({
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: '检测到复读', code: CODES.repeat },
    },
  })
  const blocks = assembler.blocks()
  if (assembler.finish.kind !== 'error') throw new Error('finish 没有被识别为 error')
  if (blocks.length !== 1 || blocks[0].type !== 'text') throw new Error('未闭合的正文块没有按增量组装出来')
  const interrupted = assembler.interruptedBlocks()
  if (interrupted.length !== 1) throw new Error('中断路径拿不到已完成的内容')
})

await check('墙钟熔断同样合法', () => {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
  assembler.push({ type: 'reasoning-delta', index: 0, text: '在想' })
  assembler.push({
    type: 'finish',
    reason: { kind: 'error', failure: { message: '超时', code: CODES.timeout } },
  })
  if (assembler.finish.kind !== 'error') throw new Error('finish 没有被识别为 error')
})

await check('带工具调用的流被熔断时也不炸', () => {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'tool-call' })
  assembler.push({ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '{"p":' })
  assembler.push({
    type: 'finish',
    reason: { kind: 'error', failure: { message: '复读', code: CODES.repeat } },
  })
  // 中断路径会丢掉未完成的工具调用（它没有被执行，留着反而需要伪造结果）。
  if (assembler.interruptedBlocks().length !== 0) throw new Error('未完成的工具调用不该进入中断内容')
})

// ---------------------------------------------------------------------------
// C. 我们注入的提醒消息，能不能过官方会话
// ---------------------------------------------------------------------------

console.log('\nC. 提醒消息的合法性（用官方 Session 实测）')

const sessionModule = await importPackageFile('dsh-session', join('lib', 'types', 'index.js'))
const Session = sessionModule.Session

await check('提醒消息可以正常写入会话的 surface', () => {
  const session = Session.create('contract-check-session')
  const message = createNoticeMessage('请把正文写出来。', '提醒测试')
  session.append('user/message', message, { surfaceOp: 'append' })
  if (session.surface.nodes.length !== 1) throw new Error('消息没有进入可见面')
})

await check('camelCase / 冻结的载荷不会破坏会话的深度校验', () => {
  const session = Session.create('contract-check-session-2')
  const message = createNoticeMessage('提醒正文', '摘要')
  // 官方会在 append 时对整个载荷做「可无损序列化 + 冻结」校验；
  // 我们的消息如果带 undefined、函数或循环引用，这里会直接抛错。
  session.append('user/message', message, { surfaceOp: 'append' })
})

await check('默认配置里的提醒文案可以直接构造成合法消息', () => {
  const cfg = resolveConfig({})
  const session = Session.create('contract-check-session-3')
  session.append('user/message', createNoticeMessage(cfg.unfinished.message, '默认文案'), { surfaceOp: 'append' })
})

await check('带提醒消息的会话能被重新恢复（重启 DSH 后必须还能读档）', () => {
  const original = Session.create('contract-check-session-4')
  original.append('user/message', createNoticeMessage('提醒正文', '恢复路径'), { surfaceOp: 'append' })
  const events = original.snapshotEvents()
  if (events.length === 0) throw new Error('没能取到事件')
  // 用同一批事件重建一个会话：这条路径就是「重启后从磁盘恢复」走的路径。
  const restored = Session.create('contract-check-session-4', events)
  if (restored.surface.nodes.length !== 1) throw new Error('恢复后提醒消息丢了')
})

// ---------------------------------------------------------------------------
// D. 熔断 code 与官方重试白名单没有交集
// ---------------------------------------------------------------------------

console.log('\nD. 与官方重试策略不冲突')

const retryModule = await importPackageFile('dsh-llm', join('lib', 'types', 'retry-policy.js'))

await check('官方默认重试白名单里没有我们的 code', () => {
  const policy = retryModule.resolveRetryPolicy(undefined, 'contract-check')
  if (policy.mode !== 'normal') throw new Error('官方默认策略不再是 normal 模式了，需重新确认')
  for (const code of Object.values(CODES)) {
    if (policy.retryableCodes.includes(code)) {
      throw new Error(code + ' 出现在官方默认可重试白名单里：' + policy.retryableCodes.join(', '))
    }
  }
})

await check('官方默认白名单本身仍然覆盖那五类瞬时故障（说明我们读的是同一份策略）', () => {
  const policy = retryModule.resolveRetryPolicy(undefined, 'contract-check')
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    if (!policy.retryableCodes.includes(code)) throw new Error('白名单里少了 ' + code + '，官方策略可能改了')
  }
})

// ---------------------------------------------------------------------------
// E. 真实 Cordis 运行时冒烟：把插件真的挂上去，真的分发三个事件
// ---------------------------------------------------------------------------

console.log('\nE. 真实 Cordis 运行时冒烟（不是假上下文）')

const cordisModule = await importPackageFile('cordis', join('lib', 'index.js'))
const Context = cordisModule.Context

await check('插件能在真实 Cordis 上下文上完成安装（apply 不抛错）', () => {
  const ctx = new Context()
  apply(ctx, {})
})

await check('serial 派发会等待异步监听器（「先压缩、再继续」的立身之本）', async () => {
  const ctx = new Context()
  let finished = false
  ctx.on('probe/serial-waits', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    finished = true
  })
  await ctx.serial('probe/serial-waits', {})
  if (!finished) {
    throw new Error('Cordis 的 serial 不再等待异步监听器：压缩会在提醒之后才完成，顺序会失控')
  }
})

await check('llm/stream → agent/request-error → agent/turn-stopping 三条链路真跑一遍', async () => {
  const ctx = new Context()
  apply(ctx, {})

  // 1) 造一个「只思考不说话」的真实调用，走 llm/stream 瀑布。
  const sessionId = 'cordis-smoke-session'
  const chunks = [
    ...Array.from({ length: 20 }, (_, i) => ({
      type: 'reasoning-delta',
      index: 0,
      text: '第 ' + i + ' 步思考，先分析一下这个问题该怎么处理才稳妥。\n',
    })),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const source = {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          return i >= chunks.length ? { done: true, value: undefined } : { done: false, value: chunks[i++] }
        },
        async return() {
          return { done: true, value: undefined }
        },
      }
    },
  }
  const stream = ctx.waterfall(null, 'llm/stream', { provider: 'p', model: 'm', sessionId }, () => source)
  for await (const _chunk of stream) {
    // 只消费，不检查内容
  }

  // 2) 一轮即将结束：插件应当注入提醒。
  //
  //    派发方式必须用 `ctx.serial` —— 这正是 agent 循环真实的做法
  //    （dsh-agent-loop 里是 `await dispatch.serial("agent/turn-stopping", …)`），
  //    它会**等待异步监听器跑完**。本插件的补救逻辑是 async 的（要先压缩上下文
  //    再提醒），用不等待的 `ctx.emit` 测，只会测出「还没轮到它跑」。
  const steered = []
  const agent = {
    session: { id: sessionId, surface: { replaceGeneration: 0, contentGeneration: 0 } },
    options: { provider: 'p', model: 'm' },
    steer: (message) => steered.push(message),
  }
  await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  if (steered.length !== 1) throw new Error('期望注入 1 条提醒，实际 ' + steered.length)
  if (steered[0].source.kind !== 'self-heal') throw new Error('提醒的 source.kind 不对')

  // 3) 熔断恢复：给一个假压缩服务，验证 waterfall 真的返回 retry。
  const ctx2 = new Context()
  const compactions = []
  apply(ctx2, {})
  ctx2.provide('compaction', {
    async compactIfNeeded(target, trigger) {
      compactions.push(trigger)
      target.session.surface.replaceGeneration += 1
      return null
    },
  })
  const agent2 = {
    session: { id: 'cordis-smoke-2', surface: { replaceGeneration: 0, contentGeneration: 0 } },
    options: { provider: 'p', model: 'm' },
  }
  const action = await ctx2.waterfall(
    null,
    'agent/request-error',
    {
      agent: agent2,
      turn: 1,
      step: 0,
      provider: 'p',
      failure: { message: '复读', code: CODES.repeat },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    },
    () => undefined,
  )
  if (action === null || action?.kind !== 'retry') throw new Error('期望 {kind:"retry"}，实际 ' + JSON.stringify(action))
  if (compactions.length !== 1 || compactions[0] !== 'context-overflow') {
    throw new Error('压缩服务没有被正确调用：' + JSON.stringify(compactions))
  }
})

// ---------------------------------------------------------------------------

console.log('\n结果：通过 ' + passed + ' 项，失败 ' + failed + ' 项，跳过 ' + skipped + ' 项。')
if (failed > 0) {
  console.log('契约自检未通过 —— 很可能是 DSH 升级改了接口，请先核对再更新插件。')
  process.exit(1)
}
console.log('契约自检通过：本插件依赖的接口与数据形状在当前 DSH 版本上全部成立。')
