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

import { CODES, DEFAULT_CONFIG, DIAGNOSIS_MESSAGES, createNoticeMessage, resolveConfig } from '../lib/index.js'
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

/**
 * 正常但「句句都短」的输出：每一句都不重复。
 *
 * 用途：证明短句打转那条线**不会**误伤这类输出 —— 它能通过平均行长预检、
 * 短句密度也是 100%，唯一缺的就是「重复」。
 *
 * @param {number} count - 生成多少轮。
 * @returns {string} 样本文本。
 */
function normalShortProse(count) {
  const out = []
  for (let i = 1; i <= count; i += 1) {
    out.push('第 ' + i + ' 项检查通过。')
    out.push('耗时 ' + ((i * 17) % 997) + ' 毫秒。')
  }
  return out.join('\n')
}

/**
 * 口头禅式输出：一句短口头禅反复出现，但正文主体是正常长句。
 * @param {number} count - 生成多少轮。
 * @returns {string} 样本文本。
 */
function catchphraseProse(count) {
  const out = []
  for (let i = 1; i <= count; i += 1) {
    out.push('好的。')
    out.push('第 ' + i + ' 个模块的检查结果是第 ' + ((i * 31) % 997) + ' 号状态，需要继续观察后续变化。')
  }
  return out.join('\n')
}

/**
 * 造一段「严格复读、但不会被短句打转那条线抢先」的样本。
 *
 * ⚠️ 为什么行必须写长：短句打转检测的启动门槛只有 1000 字符（比复读的 4000
 * 低），而且它专门盯「平均行长很短」的形态。若这里仍用 `Let me run.` 这种短行，
 * 两条线都能抓它，测试就分不清究竟是谁在动手了。长行的平均行长超过预检门槛，
 * 短句打转那条线根本不看它 —— 于是这个样本**只**考验复读。
 *
 * @param {number} times - 重复多少行。
 * @returns {string} 样本文本。
 */
function longLineLoop(times) {
  const line = '这是一段刻意写得很长的重复内容，用来把平均行长拉到预检门槛之上，只让复读检测那条线负责抓它。'
  return Array.from({ length: times }, () => line).join('\n')
}

/**
 * 造一段「短句打转」的样本：每次措辞都略有不同，但翻来覆去就是那几句超短句。
 * 原子取自真实事故截图（思考流里连着几百行）。
 *
 * @param {number} lines - 生成多少行。
 * @returns {string} 样本文本。
 */
function shortLoop(lines) {
  const atoms = [
    '好。',
    '行动。',
    '执行。',
    '写。',
    '我调用工具。',
    'Go.',
    '（真的调用了。）好。',
    'NOW.',
    '（调用。）',
    '我调用 write 工具。',
    '我调用。',
    'CALL.',
    'GO!',
    '（我停止循环。）',
    '好，调用。',
    '（调用 write。）',
    'CALLING.',
    'DONE.',
    '（我真的必须停止。直接调用 write 工具。）',
  ]
  const out = []
  let seed = 20261009
  for (let i = 0; i < lines; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const pick = seed / 2147483648
    // 「好。」在真实样本里占大头，这里也让它出现得更频繁。
    out.push(atoms[pick < 0.45 ? 0 : Math.floor(pick * atoms.length)])
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
  const loop = longLineLoop(200)
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
  const loop = longLineLoop(100)
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
  const loop = longLineLoop(150)
  const chunks = textDeltas(loop, 32).map((chunk) => ({ ...chunk, type: 'reasoning-delta' }))
  const { stream } = mount({})
  const seen = await drain(stream(OPTIONS, () => streamOf(chunks).source))

  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.failure.code, CODES.repeat)
})

test('集成：短句打转（措辞每次都在变）触发 SELF_HEAL_LOOP', async () => {
  // 真实事故现场：思考流里连着几百行「好。／行动。／（调用。）／NOW.」，
  // 每次措辞都略有不同 —— 严格周期不存在，只有「短句打转」这条线能抓。
  const loop = shortLoop(400)
  assert.ok(loop.length > 1000, '样本必须超过短句打转的启动门槛，当前 ' + loop.length)
  const chunks = textDeltas(loop, 16)
  const { stream } = mount({})
  const { source, state } = streamOf(chunks)
  const seen = await drain(stream(OPTIONS, () => source))

  const last = seen[seen.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'error')
  assert.equal(last.reason.failure.code, CODES.loop)
  assert.equal(state.closed, true, '熔断后必须关闭上游')
  assert.ok(state.pulled < chunks.length, '不应把上游全部读完')
})

test('集成：短句打转比复读更早动手（同一个毛病省下更多 token）', async () => {
  // 短行重复的样本两条线都能抓，但短句打转的门槛是 1500 字符、复读是 4000，
  // 所以先动手的是前者。这是有意为之：越早掐掉越省。
  const loop = Array.from({ length: 800 }, () => 'Let me run.').join('\n')
  const { stream } = mount({})
  const seen = await drain(stream(OPTIONS, () => streamOf(textDeltas(loop, 32)).source))
  assert.equal(seen[seen.length - 1].reason.failure.code, CODES.loop)
})

test('集成：短句很多但内容不同的正常输出，绝不能被打断', async () => {
  // 用户最担心的事：说到一半被掐断。这个样本「句句都短」（能通过平均行长预检、
  // 短句密度 100%），唯一缺的就是「重复」—— 所以必须原样放行到最后一块。
  const body = normalShortProse(300)
  const chunks = [...textDeltas(body, 16), { type: 'finish', reason: { kind: 'stop' } }]
  const { stream } = mount({})
  const { source, state } = streamOf(chunks)
  const seen = await drain(stream(OPTIONS, () => source))

  assert.equal(seen[seen.length - 1].reason.kind, 'stop', '必须是提供方自己的正常收尾')
  // 读完整条流是「没被熔断」的硬证据：熔断会提前 break，上游根本读不完。
  assert.equal(state.pulled, chunks.length, '上游必须被读到最后一块')
})

test('集成：口头禅式的正常输出也不能被打断', async () => {
  // 「好的。」重复 60 次、重复率 100% —— 只看重复率就会误报的形态。
  // 但它旁边全是正常长句，短句密度不够，必须放过。
  const body = catchphraseProse(80)
  const chunks = [...textDeltas(body, 16), { type: 'finish', reason: { kind: 'stop' } }]
  const { stream } = mount({})
  const { source, state } = streamOf(chunks)
  await drain(stream(OPTIONS, () => source))
  assert.equal(state.pulled, chunks.length, '口头禅是正常写法，上游必须被读完')
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

test('配置：每个熔断 code 都必须配一条诊断文案', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.recover.explainFailure, true, '默认应当开启「把失败原因告诉模型」')
  for (const code of Object.values(CODES)) {
    const text = DIAGNOSIS_MESSAGES[code]
    assert.equal(typeof text, 'string', code + ' 缺少诊断文案 —— 重发会退化成盲目重试')
    // 太短的文案起不到指路作用：必须说清「发生了什么」并给出方向。
    assert.ok(text.length > 40, code + ' 的诊断文案太短，模型看不出该往哪改')
  }
})

test('配置：诊断文案本身也要能构造成合法消息', () => {
  for (const code of Object.values(CODES)) {
    const message = createNoticeMessage(DIAGNOSIS_MESSAGES[code], '诊断')
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'self-heal')
    assert.ok(Object.isFrozen(message))
  }
})
