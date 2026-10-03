/**
 * dsh-loop-guard 集成自测：把插件挂到一个假 Cordis 上下文上，走完整的
 * `llm/stream` 监听 → 包装流 → 熔断收尾链路。
 *
 * 这里验证的不是检测算法（那由 detect.test.mjs 覆盖），而是插件自身的契约：
 *   - 正常流逐块原样放行，不改写、不吞块；
 *   - 触发闸门时发出的是终止 finish 分片，而不是抛异常；
 *   - failure.code 用自定义前缀（不会落进 dsh-llm-retry 的可重试白名单）；
 *   - 熔断后上游被显式关闭，不会继续在后台烧 token。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { CODES, DEFAULT_CONFIG, apply, resolveConfig } from '../lib/index.js'

/** 构造一个只记录监听器的假 Cordis 上下文。 */
function fakeCtx() {
  const listeners = []
  return {
    logger: { info() {}, warn() {} },
    on(event, listener, options) {
      listeners.push({ event, listener, options })
    },
    listeners,
  }
}

/** 把一段 chunk 列表变成 AsyncIterable，并记录它是否被关闭。 */
function streamOf(chunks) {
  const state = { closed: false, pulled: 0 }
  const source = {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i >= chunks.length) return { done: true, value: undefined }
          state.pulled += 1
          return { done: false, value: chunks[i++] }
        },
        async return() {
          state.closed = true
          return { done: true, value: undefined }
        },
      }
    },
  }
  return { source, state }
}

/** 挂载插件并拿到包装后的流。 */
function mount(config) {
  const ctx = fakeCtx()
  apply(ctx, config)
  const entry = ctx.listeners.find((l) => l.event === 'llm/stream')
  assert.ok(entry, '必须注册 llm/stream 监听器')
  assert.equal(entry.options?.global, true, '必须用 global 监听，否则覆盖不到所有会话')
  return { ctx, entry }
}

/** 消费一条流，返回全部 chunk。 */
async function drain(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** 生成 N 个正文增量分片。 */
function textDeltas(text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) {
    out.push({ type: 'text-delta', index: 0, text: text.slice(i, i + size) })
  }
  return out
}

const OPTIONS = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

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
  const { entry } = mount({})
  const { source } = streamOf(chunks)
  const seen = await drain(entry.listener(OPTIONS, () => source))

  assert.equal(seen.length, chunks.length, 'chunk 数量必须一模一样')
  assert.equal(seen[seen.length - 1].reason.kind, 'stop', '提供方的 finish 必须原样保留')
  for (let i = 0; i < chunks.length; i += 1) {
    assert.equal(seen[i], chunks[i], '第 ' + i + ' 个 chunk 必须是同一个对象引用')
  }
})

test('集成：输出量超限时发出 LOOP_GUARD_OUTPUT_LIMIT 并关闭上游', async () => {
  // 上限压到 50 tokens，喂 4000 个 ASCII 字符（约 1000 tokens）。
  const chunks = textDeltas('x'.repeat(4000), 40)
  const { entry } = mount({ maxOutputTokens: 50, maxDurationMs: 0 })
  const { source, state } = streamOf(chunks)
  const seen = await drain(entry.listener(OPTIONS, () => source))

  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'error', 'reason.kind 必须是 error，才能通过流协议不变式')
  assert.equal(last.reason.failure.code, CODES.output)
  assert.equal(state.closed, true, '熔断后必须关闭上游')
  assert.ok(state.pulled < chunks.length, '不应把上游全部读完')
})

test('集成：复读触发 LOOP_GUARD_REPEAT', async () => {
  // 必须越过 minChars 门槛（默认 4000 字符），否则检测器按设计根本不会启动 ——
  // 短输出即使重复也无所谓，不值得为它打断一次正常回答。
  const loop = Array.from({ length: 800 }, () => 'Let me run.').join('\n')
  assert.ok(loop.length > 4000, '样本必须超过复读检测的启动门槛，当前 ' + loop.length)
  const chunks = textDeltas(loop, 32)
  const { entry } = mount({ maxOutputTokens: 0, maxDurationMs: 0 })
  const { source, state } = streamOf(chunks)
  const seen = await drain(entry.listener(OPTIONS, () => source))

  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'error')
  assert.equal(last.reason.failure.code, CODES.repeat)
  assert.equal(state.closed, true)
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
  const { entry } = mount({ maxOutputTokens: 0, maxDurationMs: 0 })
  const { source } = streamOf(chunks)
  const seen = await drain(entry.listener(OPTIONS, () => source))

  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish', '正文复读必须被拦下，不能被思考流掩盖')
  assert.equal(last.reason.failure.code, CODES.repeat)
})

test('集成：墙钟超时触发 LOOP_GUARD_TIMEOUT', async () => {
  const chunks = textDeltas('y'.repeat(200), 20)
  const { entry } = mount({ maxOutputTokens: 0, maxDurationMs: 1, repeat: { enabled: false } })

  const slow = {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          await new Promise((resolve) => setTimeout(resolve, 8))
          if (i >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: chunks[i++] }
        },
        async return() {
          return { done: true, value: undefined }
        },
      }
    },
  }

  const seen = await drain(entry.listener(OPTIONS, () => slow))
  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.failure.code, CODES.timeout)
})

test('集成：所有熔断 code 都避开 dsh-llm-retry 的默认白名单', () => {
  const retryable = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
  for (const code of Object.values(CODES)) {
    assert.ok(!retryable.includes(code), code + ' 落进了可重试白名单，熔断会被重试放大')
    assert.ok(code.startsWith('LOOP_GUARD_'), code + ' 应带统一前缀便于日志检索')
  }
})

test('集成：next() 返回非异步可迭代对象时原样透传，不报错', () => {
  const { entry } = mount({})
  const passthrough = { notAStream: true }
  assert.equal(entry.listener(OPTIONS, () => passthrough), passthrough)
})

test('集成：enabled=false 时不注册任何监听器', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(ctx.listeners.length, 0)
})

// ---------------------------------------------------------------------------

test('配置：只接受已知键且类型正确的覆盖', () => {
  const cfg = resolveConfig({
    maxOutputTokens: 1234,
    maxDurationMs: 'not-a-number',
    unknownKey: 999,
    repeat: { minChars: 100, bogus: 1 },
  })
  assert.equal(cfg.maxOutputTokens, 1234)
  assert.equal(cfg.maxDurationMs, DEFAULT_CONFIG.maxDurationMs, '类型错误的覆盖必须被忽略')
  assert.equal(cfg.unknownKey, undefined, '未知键必须被丢弃')
  assert.equal(cfg.repeat.minChars, 100)
  assert.equal(cfg.repeat.bogus, undefined)
  assert.equal(cfg.repeat.maxPeriod, 256, '未覆盖的字段必须保留默认值')
})

test('配置：null / undefined / 非对象一律落到默认值', () => {
  for (const input of [undefined, null, 42, 'x', []]) {
    const cfg = resolveConfig(input)
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens)
  }
})
