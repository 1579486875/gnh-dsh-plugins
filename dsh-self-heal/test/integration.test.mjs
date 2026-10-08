/**
 * dsh-self-heal 集成自测（一）：流包装契约。
 *
 * 把插件挂到一个假 Cordis 上下文上，走完整的
 * `llm/stream` 监听 → 包装流 → 熔断收尾链路。
 *
 * 这里验证的不是检测算法（那由 detect.test.mjs 覆盖），而是插件自身的契约：
 *   - 正常流逐块原样放行，不改写、不吞块、不替换对象的引用；
 *   - **没有输出上限**：正常的长输出必须完整放行（这是新版刻意删掉的能力）；
 *   - 触发检测时发出的是终止 finish 分片，而不是抛异常；
 *   - failure.code 用自定义前缀（不会落进 dsh-llm-retry 的可重试白名单）；
 *   - 熔断后上游被显式关闭，不会继续在后台烧 token。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { CODES, DEFAULT_CONFIG, resolveConfig } from '../lib/index.js'
import { drain, mount, streamOf, textDeltas } from './harness.mjs'

const OPTIONS = { provider: 'deepseek-official', model: 'deepseek-v4-flash', sessionId: 'session-1' }

/** 生成一段「每一行都不同」的正常中文长文本。 */
function variedProse(count) {
  const out = []
  for (let i = 1; i <= count; i += 1) {
    out.push('第 ' + i + ' 项数据的状态是 ' + ((i * 7) % 2311) + '，负责人编号 ' + ((i * 13) % 997) + '。')
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------

test('集成：正常流逐块原样放行，并保留提供方自己的 finish', async () => {
  const body = '这是一个正常的回答。'.repeat(40)
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...textDeltas(body, 17),
    { type: 'block-end', index: 0, block: { type: 'text', text: body } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { stream } = mount({})
  const { source } = streamOf(chunks)
  const seen = await drain(stream(OPTIONS, () => source))

  assert.equal(seen.length, chunks.length, 'chunk 数量必须一模一样')
  assert.equal(seen[seen.length - 1].reason.kind, 'stop', '提供方的 finish 必须原样保留')
  for (let i = 0; i < chunks.length; i += 1) {
    assert.equal(seen[i], chunks[i], '第 ' + i + ' 个 chunk 必须是同一个对象引用')
  }
})

test('集成：没有单次输出上限 —— 40 万字符的正常中文输出必须完整放行', async () => {
  // 旧版这里有一道 300000 token 的硬上限；中文按 1 字符 ≈ 1 token 估算，
  // 所以这段输出在旧版必被腰斩。新版不该有任何总量限制。
  const body = variedProse(14000)
  assert.ok(body.length > 400000, '样本应超过 40 万字符，实际 ' + body.length)
  const chunks = [...textDeltas(body, 64), { type: 'finish', reason: { kind: 'stop' } }]
  const { stream } = mount({})
  const { source, state } = streamOf(chunks)
  const seen = await drain(stream(OPTIONS, () => source))

  assert.equal(seen.length, chunks.length, '长输出必须一块不少地放行')
  assert.equal(seen[seen.length - 1].reason.kind, 'stop', '必须是提供方自己的正常收尾')
  // 读完整条流是「没被熔断」的硬证据：熔断会提前 break，上游根本读不完。
  // （上游最终都会被关闭一次，那是收尾清理，不是熔断。）
  assert.equal(state.pulled, chunks.length, '正常结束时上游必须被读到最后一块')

})

test('集成：复读触发 SELF_HEAL_REPEAT 并关闭上游', async () => {
  // 必须越过 minChars 门槛（默认 4000 字符），否则检测器按设计根本不会启动 ——
  // 短输出即使重复也无所谓，不值得为它打断一次正常回答。
  const loop = Array.from({ length: 800 }, () => 'Let me run.').join('\n')
  assert.ok(loop.length > 4000, '样本必须超过复读检测的启动门槛，当前 ' + loop.length)
  const chunks = textDeltas(loop, 32)
  const { stream } = mount({})
  const { source, state } = streamOf(chunks)
  const seen = await drain(stream(OPTIONS, () => source))

  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'error', 'reason.kind 必须是 error，才能通过流协议不变式')
  assert.equal(last.reason.failure.code, CODES.repeat)
  assert.equal(state.closed, true, '熔断后必须关闭上游')
  assert.ok(state.pulled < chunks.length, '不应把上游全部读完')
})

test('集成：思考内容不得掩盖正文复读（实测漏网的根因）', async () => {
  // 复现真实场景：推理流先灌满检测门槛，正文循环跟在后面。
  // 修复前两者共用同一个缓冲 —— 推理文本先触发 armed，那一刀切下去时正文
  // 还没攒够行数，相位也乱了，整个循环因此漏网。现在两条流各自计数。
  const reasoning = Array.from(
    { length: 200 },
    (_, i) => '第 ' + i + ' 步推理：先确认 ' + ((i * 7) % 97) + ' 号文件的字段含义，再决定是否继续。',
  ).join('\n')
  const loop = Array.from({ length: 400 }, () => 'Let me run.').join('\n')
  assert.ok(reasoning.length > 4000, '思考样本应超过启动门槛，当前 ' + reasoning.length)
  assert.ok(loop.length > 4000, '正文样本应超过启动门槛，当前 ' + loop.length)

  const chunks = [
    ...textDeltas(reasoning, 32).map((chunk) => ({ ...chunk, type: 'reasoning-delta' })),
    ...textDeltas(loop, 32),
  ]
  const { stream } = mount({})
  const { source } = streamOf(chunks)
  const seen = await drain(stream(OPTIONS, () => source))

  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish', '正文复读必须被拦下，不能被思考流掩盖')
  assert.equal(last.reason.failure.code, CODES.repeat)
})

test('集成：思考流自己的复读同样会被拦下', async () => {
  const loop = Array.from({ length: 600 }, () => '让我再确认一下这个字段的含义。').join('\n')
  const chunks = textDeltas(loop, 32).map((chunk) => ({ ...chunk, type: 'reasoning-delta' }))
  const { stream } = mount({})
  const seen = await drain(stream(OPTIONS, () => streamOf(chunks).source))

  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.failure.code, CODES.repeat)
})

test('集成：墙钟超时触发 SELF_HEAL_TIMEOUT', async () => {
  const chunks = textDeltas('y'.repeat(200), 20)
  const { stream } = mount({ maxDurationMs: 1, repeat: { enabled: false } })
  const seen = await drain(stream(OPTIONS, () => streamOf(chunks, { delayMs: 8 }).source))

  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.failure.code, CODES.timeout)
})

test('集成：maxDurationMs=0 表示关闭墙钟检测', async () => {
  const chunks = [...textDeltas('正常的短回答。', 3), { type: 'finish', reason: { kind: 'stop' } }]
  const { stream } = mount({ maxDurationMs: 0 })
  const seen = await drain(stream(OPTIONS, () => streamOf(chunks, { delayMs: 2 }).source))
  assert.equal(seen[seen.length - 1].reason.kind, 'stop')
})

test('集成：所有熔断 code 都避开 dsh-llm-retry 的默认白名单', () => {
  const retryable = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
  for (const code of Object.values(CODES)) {
    assert.ok(!retryable.includes(code), code + ' 落进了可重试白名单，熔断会被重试放大')
    assert.ok(code.startsWith('SELF_HEAL_'), code + ' 应带统一前缀便于日志检索')
  }
})

test('集成：next() 返回非异步可迭代对象时原样透传，不报错', () => {
  const { stream } = mount({})
  const passthrough = { notAStream: true }
  assert.equal(stream(OPTIONS, () => passthrough), passthrough)
})

test('集成：enabled=false 时不注册任何监听器', () => {
  const { ctx } = mount({ enabled: false })
  assert.equal(ctx.listeners.length, 0)
})

test('集成：上游抛出的错误必须原样传给消费方，不能被吞掉', async () => {
  const boom = new Error('上游炸了')
  const { stream } = mount({})
  const failing = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw boom
        },
        async return() {
          return { done: true, value: undefined }
        },
      }
    },
  }
  await assert.rejects(() => drain(stream(OPTIONS, () => failing)), /上游炸了/)
})

// ---------------------------------------------------------------------------
// 极端输入
// ---------------------------------------------------------------------------

test('极端：一堆奇怪的分片（null / 数字 / 字符串 / 未知类型）不得让插件崩溃', async () => {
  const chunks = [
    null,
    42,
    '我是一个字符串',
    { type: 'unknown-future-chunk', payload: {} },
    { type: 'text-delta' }, // 缺 text 字段
    { type: 'text-delta', text: 123 }, // text 类型不对
    { type: 'block-end' }, // 缺 block
    { type: 'block-end', block: null },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { stream } = mount({})
  const seen = await drain(stream(OPTIONS, () => streamOf(chunks).source))
  assert.equal(seen.length, chunks.length, '奇怪分片也要原样放行')
})

test('极端：单个 100 万字符的分片', async () => {
  const huge = variedProse(33000)
  assert.ok(huge.length > 1000000, '样本应超过 100 万字符，实际 ' + huge.length)
  const chunks = [{ type: 'text-delta', index: 0, text: huge }, { type: 'finish', reason: { kind: 'stop' } }]
  const { stream } = mount({})
  const seen = await drain(stream(OPTIONS, () => streamOf(chunks).source))
  assert.equal(seen.length, 2)
  assert.equal(seen[1].reason.kind, 'stop')
})

test('极端：上游没有 finish 就结束（干涸）时，插件不得自己补一个 finish', async () => {
  const chunks = textDeltas('正常但中断的输出。', 4)
  const { stream } = mount({})
  const seen = await drain(stream(OPTIONS, () => streamOf(chunks).source))
  assert.equal(seen.length, chunks.length)
  assert.equal(seen[seen.length - 1].type, 'text-delta')
})

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

test('配置：只接受已知键且类型正确的覆盖', () => {
  const cfg = resolveConfig({
    maxDurationMs: 1234,
    unknownKey: 999,
    logTrips: 'yes',
    repeat: { minChars: 100, bogus: 1 },
  })
  assert.equal(cfg.maxDurationMs, 1234)
  assert.equal(cfg.logTrips, DEFAULT_CONFIG.logTrips, '类型错误的覆盖必须被忽略')
  assert.equal(cfg.unknownKey, undefined, '未知键必须被丢弃')
  assert.equal(cfg.repeat.minChars, 100)
  assert.equal(cfg.repeat.bogus, undefined)
  assert.equal(cfg.repeat.maxPeriod, 256, '未覆盖的字段必须保留默认值')
})

test('配置：null / undefined / 非对象一律落到默认值', () => {
  for (const input of [undefined, null, 42, 'x', []]) {
    const cfg = resolveConfig(input)
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.maxDurationMs, DEFAULT_CONFIG.maxDurationMs)
    assert.equal(cfg.recover.maxAttempts, DEFAULT_CONFIG.recover.maxAttempts)
  }
})

test('配置：分组配置的类型错误不得污染默认值', () => {
  const cfg = resolveConfig({ recover: 'nope', unfinished: { maxAttempts: 'x' } })
  assert.equal(cfg.recover.maxAttempts, DEFAULT_CONFIG.recover.maxAttempts)
  assert.equal(cfg.unfinished.maxAttempts, DEFAULT_CONFIG.unfinished.maxAttempts)
  assert.equal(typeof cfg.unfinished.message, 'string')
})

test('配置：旧名 silentThought 仍然生效（改名不能让老配置静默失效）', () => {
  const cfg = resolveConfig({
    silentThought: { enabled: false, maxAttempts: 5, maxAgeMs: 1000, message: '旧文案' },
  })
  assert.equal(cfg.unfinished.enabled, false)
  assert.equal(cfg.unfinished.maxAttempts, 5)
  assert.equal(cfg.unfinished.maxAgeMs, 1000)
  assert.equal(cfg.unfinished.message, '旧文案')
  // 新版才有的开关保持默认值（旧版没有这些概念，默认值就是当时的行为）。
  assert.equal(cfg.unfinished.compact, DEFAULT_CONFIG.unfinished.compact)
  assert.equal(cfg.unfinished.truncated, DEFAULT_CONFIG.unfinished.truncated)
})

test('配置：新旧名字同时出现时，以新名为准', () => {
  const cfg = resolveConfig({ unfinished: { maxAttempts: 7 }, silentThought: { maxAttempts: 1 } })
  assert.equal(cfg.unfinished.maxAttempts, 7)
})

test('配置：unfinished 组的开关与类型校验', () => {
  const cfg = resolveConfig({ unfinished: { compact: false, promises: false, tailChars: 2048, silent: 'yes' } })
  assert.equal(cfg.unfinished.compact, false)
  assert.equal(cfg.unfinished.promises, false)
  assert.equal(cfg.unfinished.tailChars, 2048)
  assert.equal(cfg.unfinished.silent, DEFAULT_CONFIG.unfinished.silent, '类型不对的值必须退回默认，而不是变成真值')
})
