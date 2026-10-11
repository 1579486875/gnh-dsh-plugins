/**
 * dsh-self-heal 集成自测（二）：熔断之后的恢复，以及「只想不说」的补救。
 *
 * 这里验证的是插件真正的价值所在 —— 不是「拦住」，而是「救回来」：
 *
 *   熔断（复读 / 墙钟超时）
 *     → `agent/request-error` 里先压缩历史
 *     → 返回 `{ kind: 'retry' }` 让 agent 循环用压缩后的历史重发
 *     → 同一轮对话有次数上限，绝不无限重试
 *
 *   一轮即将结束、模型的话没说完（一个字没说，或者说了半截）
 *     → `agent/turn-stopping` 里**先压缩上下文腾地方**
 *     → 再注入一条提醒，让本轮继续跑一步把话说完
 *     → 压缩不成也照样继续；同样有次数上限与时效限制
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { CODES } from '../lib/index.js'
import { drain, fakeAgent, fakeCompaction, fenceStraddlingReport, liveSignal, mount, streamOf, textDeltas, variedCodeLines } from './harness.mjs'

/**
 * 造一段「严格复读、但不会被短句打转那条线抢先」的样本。
 *
 * 短句打转检测的启动门槛只有 1000 字符（比复读的 4000 低），且专盯「平均行长
 * 很短」的形态；所以要让本文件精确地测「复读 → 熔断」链路，样本必须是长行重复。
 *
 * @param {number} times - 重复多少行。
 * @returns {string} 样本文本。
 */
function longLineLoop(times) {
  const line = '这是一段刻意写得很长的重复内容，用来把平均行长拉到预检门槛之上，只让复读检测那条线负责抓它。'
  return Array.from({ length: times }, () => line).join('\n')
}

/** 造一条「只思考、不说话」的模型流。 */
function reasoningOnly(text) {
  return [
    ...textDeltas(text, 40).map((chunk) => ({ ...chunk, type: 'reasoning-delta' })),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 让某次调用在记账表里留下「说了正文」的记录。 */
async function recordVisibleText(mounted, agent, options = {}) {
  const chunks = [...textDeltas('这是真正的正文内容。', 5), { type: 'finish', reason: { kind: 'stop' } }]
  const stream = mounted.stream({ sessionId: agent.session.id, ...options }, () => streamOf(chunks).source)
  await drain(stream)
}

/** 让某次调用在记账表里留下「只思考没正文」的记录。 */
async function recordSilentThought(mounted, agent, options = {}) {
  const stream = mounted.stream(
    { sessionId: agent.session.id, ...options },
    () => streamOf(reasoningOnly('让我先想一想这个问题，我需要仔细分析一下。'.repeat(20))).source,
  )
  await drain(stream)
}

/** 造一次熔断失败的载荷。 */
function tripPayload(agent, overrides = {}) {
  return {
    agent,
    turn: 1,
    step: 0,
    provider: 'deepseek-official',
    failure: { message: '检测到持续性复读', code: CODES.repeat },
    retryPolicy: undefined,
    signal: liveSignal(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// A. 熔断恢复：压缩 + 重试
// ---------------------------------------------------------------------------

test('恢复：压缩让历史变短 → 接管并返回 retry', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: (target) => target.touch(1) })
  const app = mount({}, { compaction })

  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')

  assert.deepEqual(action, { kind: 'retry' }, '必须接管并让 agent 循环重发')
  assert.equal(compaction.calls.length, 1, '必须真的调用过压缩')
  assert.equal(compaction.calls[0].trigger, 'context-overflow', '要用强制压缩这一档')
  assert.equal(compaction.calls[0].agent, agent)
})

test('恢复：压缩只剪枝了内容（没换节点）也算有进展 → retry', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: (target) => target.touch(0, 1) })
  const app = mount({}, { compaction })

  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' })
})

test('恢复：压缩毫无进展时，默认仍给一次重试机会', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction() // 什么都不做
  const app = mount({}, { compaction })

  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' }, '默认配置下「没压动也重试」')
})

test('恢复：关掉 retryWithoutCompaction 后，无进展就不重试', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction()
  const app = mount({ recover: { retryWithoutCompaction: false } }, { compaction })

  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.equal(action, 'terminal', '历史没变就不该重发')
  assert.equal(compaction.calls.length, 1, '但仍然尝试过压缩')
})

test('恢复：压缩过程抛错也不能把对话弄坏', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ error: new Error('摘要模型超时') })
  const app = mount({}, { compaction })

  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' }, '压缩失败不该阻断恢复（默认配置）')
  assert.ok(
    app.logs.some((entry) => entry.message.includes('压缩失败')),
    '必须留下一条可排查的日志',
  )
})

test('恢复：压缩抛出的不是 Error（例如字符串）也不能崩', async () => {
  const agent = fakeAgent()
  const compaction = {
    async compactIfNeeded() {
      throw 'nope'
    },
  }
  const app = mount({}, { compaction })
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' })
})

test('恢复：组合里没有压缩服务时优雅降级', async () => {
  const agent = fakeAgent()
  const app = mount({}, {})

  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' }, '拿不到压缩服务也要救一次')
  assert.ok(
    app.logs.some((entry) => entry.message.includes('找不到压缩服务')),
    '必须留下诊断日志',
  )
})

test('恢复：没有压缩服务且禁止无压缩重试时不接管', async () => {
  const agent = fakeAgent()
  const app = mount({ recover: { retryWithoutCompaction: false } }, {})
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.equal(action, 'terminal')
})

test('恢复：同一轮对话最多恢复 maxAttempts 次，到顶后交还错误', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: (target) => target.touch(1) })
  const app = mount({ recover: { maxAttempts: 3 } }, { compaction })

  for (let i = 1; i <= 3; i += 1) {
    const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
    assert.deepEqual(action, { kind: 'retry' }, '第 ' + i + ' 次应当恢复')
  }
  const fourth = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.equal(fourth, 'terminal', '第 4 次必须停下来')
  assert.equal(compaction.calls.length, 3, '到顶后不该再压缩')
})

test('恢复：换一轮对话后计数清零', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: (target) => target.touch(1) })
  const app = mount({ recover: { maxAttempts: 1 } }, { compaction })

  assert.deepEqual(
    await app.waterfall('agent/request-error', tripPayload(agent, { turn: 1 }), () => 'terminal'),
    { kind: 'retry' },
  )
  assert.equal(
    await app.waterfall('agent/request-error', tripPayload(agent, { turn: 1 }), () => 'terminal'),
    'terminal',
  )
  assert.deepEqual(
    await app.waterfall('agent/request-error', tripPayload(agent, { turn: 2 }), () => 'terminal'),
    { kind: 'retry' },
    '新一轮应当重新获得恢复额度',
  )
})

test('恢复：turn 已被取消时不重试', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: (target) => target.touch(1) })
  const app = mount({}, { compaction })
  const aborted = new AbortController()
  aborted.abort()

  const action = await app.waterfall(
    'agent/request-error',
    tripPayload(agent, { signal: aborted.signal }),
    () => 'terminal',
  )
  assert.equal(action, 'terminal')
  assert.equal(compaction.calls.length, 0, '取消后连压缩都不该做')
})

test('恢复：压缩把 turn 弄取消了（signal 中途 abort）也不重试', async () => {
  const agent = fakeAgent()
  const controller = new AbortController()
  const compaction = fakeCompaction({
    effect: (target) => {
      target.touch(1)
      controller.abort()
    },
  })
  const app = mount({}, { compaction })

  const action = await app.waterfall(
    'agent/request-error',
    tripPayload(agent, { signal: controller.signal }),
    () => 'terminal',
  )
  assert.equal(action, 'terminal')
})

test('恢复：别人的失败 code 一概不接管', async () => {
  const agent = fakeAgent()
  const app = mount({}, { compaction: fakeCompaction() })
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'TIMEOUT', 'AUTH', undefined]) {
    const action = await app.waterfall(
      'agent/request-error',
      tripPayload(agent, { failure: { message: 'x', code } }),
      () => 'terminal',
    )
    assert.equal(action, 'terminal', 'code=' + String(code) + ' 不该被接管')
  }
})

test('恢复：超时熔断与复读熔断都被接管', async () => {
  const agent = fakeAgent()
  const app = mount({}, { compaction: fakeCompaction({ effect: (target) => target.touch(1) }) })
  for (const code of [CODES.repeat, CODES.timeout]) {
    const action = await app.waterfall(
      'agent/request-error',
      tripPayload(agent, { failure: { message: 'x', code }, turn: code === CODES.repeat ? 1 : 2 }),
      () => 'terminal',
    )
    assert.deepEqual(action, { kind: 'retry' }, code + ' 应当被接管')
  }
})

test('恢复：recover.enabled=false 时完全不介入', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: (target) => target.touch(1) })
  const app = mount({ recover: { enabled: false } }, { compaction })
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.equal(action, 'terminal')
  assert.equal(compaction.calls.length, 0)
})

test('极端：载荷残缺（没有 agent / 没有 session / 没有 surface）也不得抛错', async () => {
  const app = mount({}, { compaction: fakeCompaction({ effect: (target) => target.touch(1) }) })
  const brokenAgents = [undefined, {}, { session: {} }, { session: { surface: undefined } }]
  for (const agent of brokenAgents) {
    const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
    assert.equal(action, 'terminal')
  }
  // 载荷本身是 undefined 的极端情况
  const action = await app.waterfall('agent/request-error', undefined, () => 'terminal')
  assert.equal(action, 'terminal')
})

test('极端：压缩服务是 null（服务存在但未填充）时降级', async () => {
  const agent = fakeAgent()
  const app = mount({}, { compaction: null })
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' })
})

test('恢复：三条取压缩服务的路径都要能用', async () => {
  const agent = fakeAgent()

  // 路径一：官方 agentPresets.serviceFor
  const viaPreset = fakeCompaction({ effect: (target) => target.touch(1) })
  agent.presetServices.compaction = viaPreset
  const appA = mount({}, {})
  assert.deepEqual(await appA.waterfall('agent/request-error', tripPayload(agent, { turn: 11 }), () => 'terminal'), {
    kind: 'retry',
  })
  assert.equal(viaPreset.calls.length, 1)
  delete agent.presetServices.compaction

  // 路径二：agent 自己的作用域上下文
  const viaAgent = fakeCompaction({ effect: (target) => target.touch(1) })
  agent.ctx = { get: (name) => (name === 'compaction' ? viaAgent : undefined) }
  const appB = mount({}, {})
  assert.deepEqual(await appB.waterfall('agent/request-error', tripPayload(agent, { turn: 12 }), () => 'terminal'), {
    kind: 'retry',
  })
  assert.equal(viaAgent.calls.length, 1)
  delete agent.ctx

  // 路径三：host 平面的 ctx.get
  const viaHost = fakeCompaction({ effect: (target) => target.touch(1) })
  const appC = mount({}, { compaction: viaHost })
  assert.deepEqual(await appC.waterfall('agent/request-error', tripPayload(agent, { turn: 13 }), () => 'terminal'), {
    kind: 'retry',
  })
  assert.equal(viaHost.calls.length, 1)
})

test('恢复：agentPresets.serviceFor 抛异常时自动退到下一条路', async () => {
  const agent = fakeAgent()
  const viaHost = fakeCompaction({ effect: (target) => target.touch(1) })
  const app = mount({}, { compaction: viaHost })
  app.ctx.agentPresets.serviceFor = () => {
    throw new Error('预设查询炸了')
  }
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(viaHost.calls.length, 1, '应当退到 host 平面的服务')
})

// ---------------------------------------------------------------------------
// A2. 重发不是盲目的：把「刚才为什么失败」写进历史
//
//     重复坍缩是近乎确定性的吸引子 —— 同样的上下文会再次滑进同一个循环。
//     压完就重发的盲目重试大概率原样再犯，所以重发前必须把病类告诉模型，
//     并给一句可执行的定向指令。
// ---------------------------------------------------------------------------

test('恢复：重发前把诊断写进会话历史（不是投收件箱）', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: (target) => target.touch(1) })
  const app = mount({}, { compaction })

  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')

  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(agent.appended.length, 1, '必须往历史里写一条诊断')
  const written = agent.appended[0]
  assert.equal(written.kind, 'user/message')
  assert.equal(written.options?.surfaceOp, 'append', '要用表面追加操作，才会立刻进历史')
  assert.equal(written.message.source.kind, 'self-heal')
  assert.ok(Object.isFrozen(written.message), '写进会话的消息必须已冻结')
  // 只说「你复读了」没有用，必须给方向。
  assert.ok(written.message.content[0].text.includes('复读'), '要点明病类')
  assert.ok(written.message.content[0].text.includes('不要重复'), '要给可执行的定向指令')
  assert.equal(agent.steered.length, 0, '这条链路不该用 steer（那要等下一步才进历史）')
})

test('恢复：诊断写在压缩之后（免得被这次压缩摘要掉）', async () => {
  const order = []
  const agent = fakeAgent()
  const compaction = fakeCompaction({
    effect: (target) => {
      order.push('compact')
      target.touch(1)
    },
  })
  const originalAppend = agent.session.append.bind(agent.session)
  agent.session.append = (...args) => {
    order.push('diagnose')
    return originalAppend(...args)
  }
  const app = mount({}, { compaction })

  await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(order, ['compact', 'diagnose'], '顺序反了的话，诊断会被压缩顺手摘要掉')
})

test('恢复：不同熔断给不同的定向指令', async () => {
  const cases = [
    [CODES.repeat, '不要重复'],
    [CODES.timeout, '直接给出结论'],
  ]
  for (const [code, needle] of cases) {
    const agent = fakeAgent()
    const app = mount({}, { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) })
    await app.waterfall(
      'agent/request-error',
      tripPayload(agent, { failure: { message: 'x', code } }),
      () => 'terminal',
    )
    assert.equal(agent.appended.length, 1, code + ' 应当写一条诊断')
    assert.ok(agent.appended[0].message.content[0].text.includes(needle), code + ' 的指令不对')
  }
})

test('恢复：短路打转的指令要它「立刻动手」，不是再解释一遍', async () => {
  const agent = fakeAgent()
  const app = mount({}, { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) })
  await app.waterfall(
    'agent/request-error',
    tripPayload(agent, { failure: { message: '短句打转', code: CODES.loop } }),
    () => 'terminal',
  )
  const text = agent.appended[0].message.content[0].text
  assert.ok(text.includes('调用工具'), '要指向「去调用工具」这个动作')
  assert.ok(text.includes('不要再用文字描述'), '要明确禁止继续复述计划')
})

test('恢复：关掉 explainFailure 后不再写诊断（重发照常）', async () => {
  const agent = fakeAgent()
  const app = mount(
    { recover: { explainFailure: false } },
    { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) },
  )
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(agent.appended.length, 0)
})

test('恢复：写诊断失败也不能挡住重发', async () => {
  const agent = fakeAgent()
  agent.session.append = () => {
    throw new Error('surface 拒绝写入')
  }
  const app = mount({}, { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) })
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' }, '诊断是锦上添花，不能拖垮恢复')
  assert.ok(app.logs.some((entry) => entry.message.includes('写说明消息失败')))
})

test('恢复：会话没有 append 能力时静默跳过诊断', async () => {
  const agent = fakeAgent()
  delete agent.session.append
  const app = mount({}, { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) })
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' })
})

// ---------------------------------------------------------------------------
// A3. 收尾：救不回来时给用户一句人话 + 自愈成功率
//
//     前者是「体验」：放弃之后这一轮会以 error 结束，用户不该只看到一行技术错误。
//     后者是「诚实」：没有它，我们只能看见熔断了几次，永远不知道救回来几次。
// ---------------------------------------------------------------------------

test('放弃：熔断救到底时会给用户留一句人话', async () => {
  const agent = fakeAgent()
  const app = mount(
    { recover: { maxAttempts: 1 } },
    { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) },
  )

  // 第一次：还能救 —— 写的是「给模型的诊断」。
  await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.equal(agent.appended.length, 1, '第一次恢复应当写一条给模型的诊断')

  // 第二次：到顶，放弃 —— 这时应当多一条「给用户」的说明。
  await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.equal(agent.appended.length, 2, '放弃时要给用户一个交代')

  const text = agent.appended[agent.appended.length - 1].message.content[0].text
  assert.ok(text.startsWith('（失控自愈）'), '要让用户看出这条不是真人说的：' + text)
  assert.ok(text.includes('连续 1 次'), '要说清救了几次')
  assert.ok(text.includes('复读'), '病类要用用户看得懂的说法')
  assert.ok(text.includes('拆小'), '要给出下一步建议')
})

test('放弃：关掉 reportGiveUp 之后不再打扰用户', async () => {
  const agent = fakeAgent()
  const app = mount(
    { recover: { maxAttempts: 1, reportGiveUp: false } },
    { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) },
  )
  await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  const before = agent.appended.length
  await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.equal(agent.appended.length, before, '关掉之后不该再写说明')
})

test('放弃：三种熔断给三种说法', async () => {
  for (const [code, needle] of [
    [CODES.repeat, '复读'],
    [CODES.loop, '短句打转'],
    [CODES.timeout, '超时'],
  ]) {
    const agent = fakeAgent()
    const app = mount(
      { recover: { maxAttempts: 0 } },
      { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) },
    )
    await app.waterfall(
      'agent/request-error',
      tripPayload(agent, { failure: { message: 'x', code } }),
      () => 'terminal',
    )
    const text = agent.appended[0]?.message?.content?.[0]?.text ?? ''
    assert.ok(text.includes(needle), code + ' 的说法不对：' + text)
  }
})

test('放弃：「没说完」催不动时也会给用户一个交代', async () => {
  const agent = fakeAgent()
  const app = mount({ unfinished: { maxAttempts: 1 } })

  for (let i = 0; i < 2; i += 1) {
    await recordHalfDone(app, agent, '这个函数的作用是把输入转换成输出，')
    await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  }

  const notice = agent.appended.find((item) => item.message.source.summary.includes('未完成'))
  assert.ok(notice !== undefined, '催不动时应当写一条说明')
  assert.ok(notice.message.content[0].text.includes('继续'), '要告诉用户可以回一句「继续」')
})

test('自愈统计：重发之后正常走完 → 记一次救回', async () => {
  const agent = fakeAgent()
  const app = mount({}, { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) })

  // 一次真的熔断（让 trips 有数）
  await drain(
    app.stream({ sessionId: agent.session.id }, () => streamOf(textDeltas(longLineLoop(150), 32)).source),
  )
  // 恢复：返回 retry，并记下「等着看这次行不行」
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' })
  // 重发之后正常走完 —— 这一次自愈就算成功
  await recordVisibleText(app, agent)

  const line = app.logs.find((entry) => entry.message.includes('自愈成功'))?.message
  assert.ok(line !== undefined, '正常走完应当结清这次自愈')
  assert.ok(line.includes('熔断 1 次'), line)
  assert.ok(line.includes('重发 1 次'), line)
  assert.ok(line.includes('救回 1 次'), line)
  assert.ok(line.includes('100%'), line)
})

test('自愈统计：重发之后又打转 → 不算救回（不能自欺）', async () => {
  const agent = fakeAgent()
  const app = mount({}, { compaction: fakeCompaction({ effect: (t) => t.touch(1) }) })

  await drain(
    app.stream({ sessionId: agent.session.id }, () => streamOf(textDeltas(longLineLoop(150), 32)).source),
  )
  await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  // 重发之后**又**熔断：那笔「等着看」应当作废
  await drain(
    app.stream({ sessionId: agent.session.id }, () => streamOf(textDeltas(longLineLoop(150), 32)).source),
  )
  // 之后再正常走完，也不能替它结账
  await recordVisibleText(app, agent)

  assert.ok(
    !app.logs.some((entry) => entry.message.includes('自愈成功')),
    '又一次熔断之后不该冒出成功记录 —— 否则成功率就是自欺',
  )
})

test('自愈统计：没有发生过熔断时不会有成功记录', async () => {
  const agent = fakeAgent()
  const app = mount({})
  await recordVisibleText(app, agent)
  assert.ok(!app.logs.some((entry) => entry.message.includes('自愈成功')))
})

// ---------------------------------------------------------------------------
// B. 「只想不说」的补救
// ---------------------------------------------------------------------------

test('空谈：只思考不输出正文 → 注入提醒并要求重新输出', async () => {
  const agent = fakeAgent()
  const app = mount({})
  await recordSilentThought(app, agent)

  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })

  assert.equal(agent.steered.length, 1, '必须投递一条提醒')
  const message = agent.steered[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'self-heal')
  assert.equal(message.source.form, 'notice')
  assert.ok(typeof message.source.summary === 'string' && message.source.summary.length > 0)
  assert.ok(typeof message.id === 'string' && message.id.length > 0, '必须带稳定身份 id')
  assert.ok(message.content[0].text.includes('继续完成'), '提醒正文要明确要求接着往下写完')
  assert.ok(message.content[0].text.includes('不要重复'), '要交代它别把已经写过的内容再写一遍')
  assert.ok(Object.isFrozen(message), '写进会话的消息必须已冻结')
})

test('空谈：说了正文就不干预', async () => {
  const agent = fakeAgent()
  const app = mount({})
  await recordVisibleText(app, agent)

  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0)
})

test('空谈：只调了工具（还没有正文）也不干预', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const chunks = [
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '{"path":"a"}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  await drain(app.stream({ sessionId: agent.session.id }, () => streamOf(chunks).source))

  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0, '模型正在干活，不该打断')
})

test('空谈：正文只由 block-end 送达（没有 delta）也算说了话', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const chunks = [
    { type: 'block-end', index: 0, block: { type: 'text', text: '这是正文。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await drain(app.stream({ sessionId: agent.session.id }, () => streamOf(chunks).source))

  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0)
})

test('空谈：全是空白字符的正文视为没说', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const chunks = [...textDeltas('   \n\n\t  ', 3), { type: 'finish', reason: { kind: 'stop' } }]
  await drain(app.stream({ sessionId: agent.session.id }, () => streamOf(chunks).source))

  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1)
})

test('空谈：同一轮最多提醒 maxAttempts 次', async () => {
  const agent = fakeAgent()
  const app = mount({ unfinished: { maxAttempts: 2 } })

  for (let i = 0; i < 3; i += 1) {
    await recordSilentThought(app, agent)
    await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  }
  assert.equal(agent.steered.length, 2, '第三次必须放手')
})

test('空谈：换一轮后提醒次数重置', async () => {
  const agent = fakeAgent()
  const app = mount({ unfinished: { maxAttempts: 1 } })

  await recordSilentThought(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  await recordSilentThought(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1)

  await recordSilentThought(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 2, signal: liveSignal() })
  assert.equal(agent.steered.length, 2, '新一轮应当重新获得提醒额度')
})

test('空谈：提醒之后模型补出了正文 → 不再打扰', async () => {
  const agent = fakeAgent()
  const app = mount({})

  await recordSilentThought(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1)

  // 同一个 turn：模型这次说了正文。
  await recordVisibleText(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1, '说了正文就不该再提醒')
})

test('空谈：记录过期后不再据此干预', async () => {
  const agent = fakeAgent()
  const app = mount({ unfinished: { maxAgeMs: 0 } })
  await recordSilentThought(app, agent)
  // maxAgeMs=0 表示「只认同一毫秒内」；等到下一毫秒必然过期。
  await new Promise((resolve) => setTimeout(resolve, 5))

  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0)
})

test('空谈：这个会话根本没调过模型时不干预', async () => {
  const agent = fakeAgent({ id: 'never-called' })
  const app = mount({})
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0)
})

test('空谈：辅助调用（生成标题 / 压缩摘要）不参与记账', async () => {
  const agent = fakeAgent()
  const app = mount({})
  for (const purpose of ['compaction', 'session-title']) {
    const stream = app.stream(
      { sessionId: agent.session.id, purpose },
      () => streamOf(reasoningOnly('摘要模型只是想了想。')).source,
    )
    await drain(stream)
  }
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0, '辅助调用不该触发「只想不说」的补救')
})

test('空谈：被熔断的调用不参与记账（它走的是错误恢复那条路）', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const loop = Array.from({ length: 600 }, () => 'Let me run.').join('\n')
  const stream = app.stream({ sessionId: agent.session.id }, () => streamOf(textDeltas(loop, 32)).source)
  await drain(stream)

  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0)
})

test('空谈：unfinished.enabled=false 时完全不介入', async () => {
  const agent = fakeAgent()
  const app = mount({ unfinished: { enabled: false } })
  await recordSilentThought(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0)
})

test('空谈：steer 本身抛错也不能崩（本轮照常结束）', async () => {
  const agent = fakeAgent()
  agent.steer = () => {
    throw new Error('inbox 拒绝')
  }
  const app = mount({})
  await recordSilentThought(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.ok(
    app.logs.some((entry) => entry.message.includes('未完成补救失败')),
    '必须把失败记下来而不是抛出',
  )
})

test('极端：turn-stopping 载荷残缺也不得抛错', async () => {
  const app = mount({})
  await app.emit('agent/turn-stopping', {})
  await app.emit('agent/turn-stopping', undefined)
  // 没崩就算过。
  assert.ok(true)
})

// ---------------------------------------------------------------------------
// B2. 「说了半截」的判定，以及「先压缩、再继续」的顺序
//
//     顺序是本功能的要害：说一半就停，多半是上下文太满、没地方把话写完，
//     所以要先压缩腾地方、再提醒它继续。顺序反了（先提醒后压缩）等于白压。
// ---------------------------------------------------------------------------

/** 让某次调用在记账表里留下「正文说了半截」的记录。 */
async function recordHalfDone(mounted, agent, text, finishKind = 'stop') {
  const chunks = [...textDeltas(text, 12), { type: 'finish', reason: { kind: finishKind } }]
  const stream = mounted.stream({ sessionId: agent.session.id }, () => streamOf(chunks).source)
  await drain(stream)
}

/**
 * 造一个会记下「压缩」与「提醒」先后顺序的测试环境。
 *
 * @param {object} [config] - 插件配置。
 * @param {'ok'|'noop'|'error'|'none'} [mode] - 压缩服务的行为：
 *   ok=压缩且历史真的变短；noop=压缩过但历史没变；error=压缩抛错；none=没有压缩服务。
 * @returns {object} `{ agent, app, order, compaction }`。
 */
function orderedEnv(config = {}, mode = 'ok') {
  const order = []
  const agent = fakeAgent()
  const originalSteer = agent.steer.bind(agent)
  agent.steer = (message) => {
    order.push('steer')
    originalSteer(message)
  }

  const services = {}
  let compaction
  if (mode !== 'none') {
    const raw = fakeCompaction({
      error: mode === 'error' ? new Error('摘要模型超时') : undefined,
      effect: (target) => {
        if (mode === 'ok') target.touch(1)
      },
    })
    // 包一层：无论压缩成功还是抛错，都要把「调用过压缩」这件事记进顺序里 ——
    // 直接挂在 effect 上的话，抛错那条路径根本走不到 effect。
    compaction = {
      calls: raw.calls,
      compactIfNeeded(agent, trigger, signal) {
        order.push('compact')
        return raw.compactIfNeeded(agent, trigger, signal)
      },
    }
    services.compaction = compaction
  }
  return { agent, app: mount(config, services), order, compaction }
}

test('未完成：命中后先压缩、再提醒（顺序不能颠倒）', async () => {
  const { agent, app, order, compaction } = orderedEnv()
  await recordHalfDone(app, agent, '先确认 README 第二节的真实设置项，避免我写的新表与它不符。')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })

  assert.deepEqual(order, ['compact', 'steer'], '必须先压缩腾地方，再提醒它继续')
  assert.equal(compaction.calls.length, 1, '压缩只做一次')
  assert.equal(compaction.calls[0].trigger, 'context-overflow', '要用强制压缩这一档')
  assert.equal(agent.steered.length, 1)
})

test('未完成：max-tokens 截断 → 提醒接着写完', async () => {
  const { agent, app } = orderedEnv({}, 'none')
  await recordHalfDone(app, agent, '这是一段被长度上限截断的正文', 'max-tokens')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1)
  assert.ok(app.logs.some((entry) => entry.message.includes('被长度上限截断')))
})

test('未完成：压缩服务不在时照样提醒（压缩是腾地方，不是前提）', async () => {
  const { agent, app, order } = orderedEnv({}, 'none')
  await recordHalfDone(app, agent, '这个函数的作用是把输入转换成输出，')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })

  assert.deepEqual(order, ['steer'])
  assert.equal(agent.steered.length, 1)
  assert.ok(app.logs.some((entry) => entry.message.includes('找不到压缩服务')))
})

test('未完成：压缩抛错也要继续提醒', async () => {
  const { agent, app, order } = orderedEnv({}, 'error')
  await recordHalfDone(app, agent, '这个函数的作用是把输入转换成输出，')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })

  assert.deepEqual(order, ['compact', 'steer'])
  assert.ok(app.logs.some((entry) => entry.message.includes('压缩失败')))
})

test('未完成：压缩没找到可压的区间，仍然提醒', async () => {
  const { agent, app, order } = orderedEnv({}, 'noop')
  await recordHalfDone(app, agent, '这个函数的作用是把输入转换成输出，')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })

  assert.deepEqual(order, ['compact', 'steer'])
  assert.ok(app.logs.some((entry) => entry.message.includes('没有可压缩的区间')))
})

test('未完成：compact=false 时跳过压缩，直接提醒', async () => {
  const { agent, app, order, compaction } = orderedEnv({ unfinished: { compact: false } })
  await recordHalfDone(app, agent, '这个函数的作用是把输入转换成输出，')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })

  assert.deepEqual(order, ['steer'])
  assert.equal(compaction.calls.length, 0, '关掉之后一次都不该压')
})

test('未完成：同一轮第二次命中只提醒、不再压缩（避免越压越薄）', async () => {
  const { agent, app, order, compaction } = orderedEnv({ unfinished: { maxAttempts: 2 } })
  await recordHalfDone(app, agent, '第一段没说完，')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  await recordHalfDone(app, agent, '第二段也没说完，')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })

  assert.deepEqual(order, ['compact', 'steer', 'steer'], '第二次只提醒，不再压缩')
  assert.equal(compaction.calls.length, 1)
  assert.ok(app.logs.some((entry) => entry.message.includes('已经压缩过一次')))
})

test('未完成：压缩期间用户按了停止 → 不再往对话里塞提醒', async () => {
  const controller = new AbortController()
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: () => controller.abort() })
  const app = mount({}, { compaction })

  await recordHalfDone(app, agent, '这个函数的作用是把输入转换成输出，')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: controller.signal })
  assert.equal(agent.steered.length, 0)
})

test('未完成：正在调工具时，即使被截断也不打断（那是正常的「先干活」）', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const chunks = [
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read_file', argumentsDelta: '{"path":"a"}' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  await drain(app.stream({ sessionId: agent.session.id }, () => streamOf(chunks).source))
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0)
})

test('未完成：正常收尾的回复绝不打扰（本功能最需要盯的误报）', async () => {
  const { agent, app } = orderedEnv({}, 'none')
  const normal = [
    '以上就是全部改动，测试都通过了。',
    '| 项目 | 结果 |\n| --- | --- |\n| A | 通过 |\n',
    '```js\nconst a = 1\n```\n',
    '你可以先确认一下配置。',
    '大概就是这样吧…',
  ]
  for (const text of normal) {
    await recordHalfDone(app, agent, text)
    await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  }
  assert.equal(agent.steered.length, 0, '正常收尾不得被追着让模型继续说')
})

test('未完成：★ 长报告被判定窗口劈开代码块时，绝不误报（真实事故回归）', async () => {
  // 现场（2026-10-11）：一份 5 千多字符的完整报告，中间有若干代码块，末尾正常收尾，
  // 却被判成「代码块没有写完」，白插一条提醒、还白压了一次上下文 —— 同一条会话连错 4 次。
  // 根因是判定窗口的起点落在某对围栏**内部**，窗口里那个 ``` 其实是闭围栏。
  const { agent, app } = orderedEnv({}, 'none')
  await recordHalfDone(app, agent, fenceStraddlingReport())
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0, '一份闭合的完整报告不得被追着让模型继续说')
})

test('未完成：真未闭合的代码块在链路里仍然要提醒（修误报别把功能修没了）', async () => {
  const { agent, app } = orderedEnv({}, 'none')
  // 唯一的开围栏落在判定窗口之外 —— 旧逻辑只数窗口会漏掉它，新逻辑数整个缓冲才认得出。
  await recordHalfDone(app, agent, '下面给出改法。\n\n```js\n' + variedCodeLines(400))
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1, '真的没写完还是要催')
  assert.ok(
    app.logs.some((entry) => entry.message.includes('代码块没有写完')),
    '日志里要能看出是围栏这条判据',
  )
})

test('未完成：truncated=false 时不管「说了半截」，但「一个字没说」照管', async () => {
  const agent = fakeAgent()
  const app = mount({ unfinished: { truncated: false } })

  await recordHalfDone(app, agent, '这个函数的作用是，')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0, '关掉之后不该管说了半截')

  await recordSilentThought(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1, '「一个字没说」是另一个开关，仍然要管')
})

test('未完成：promises=false 时，「我先去确认一下」不再触发；其他判定不受影响', async () => {
  const agent = fakeAgent()
  const app = mount({ unfinished: { promises: false } })

  await recordHalfDone(app, agent, '先确认 README 第二节的真实设置项，避免我写的新表与它不符。')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0)

  await recordHalfDone(app, agent, '下面给出改法：\n```js\nlet a = 1\n')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1, '未闭合代码块属于另一条判据，不受 promises 开关影响')
})

test('未完成：提醒次数用满后就放手（不会变成新的死循环）', async () => {
  const { agent, app } = orderedEnv({ unfinished: { maxAttempts: 2 } }, 'none')
  for (let i = 0; i < 4; i += 1) {
    await recordHalfDone(app, agent, '第 ' + i + ' 段没说完，')
    await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  }
  assert.equal(agent.steered.length, 2, '超过上限必须收手')
  assert.ok(app.logs.some((entry) => entry.message.includes('已达到提醒上限')))
})

test('未完成：提醒之后再说话就正常了 → 不再打扰', async () => {
  const { agent, app } = orderedEnv({}, 'none')
  await recordHalfDone(app, agent, '这个函数的作用是，')
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1)

  await recordVisibleText(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 1, '这次说完了就别再打扰')
})

// ---------------------------------------------------------------------------
// C. 多会话隔离与完整链路
// ---------------------------------------------------------------------------

test('多会话：两个会话各自记账，互不干扰', async () => {
  const silent = fakeAgent({ id: 'session-silent' })
  const talking = fakeAgent({ id: 'session-talking' })
  const app = mount({})

  await recordSilentThought(app, silent)
  await recordVisibleText(app, talking)

  await app.emit('agent/turn-stopping', { agent: talking, turn: 1, signal: liveSignal() })
  assert.equal(talking.steered.length, 0, '说了正文的那个不该被提醒')

  await app.emit('agent/turn-stopping', { agent: silent, turn: 1, signal: liveSignal() })
  assert.equal(silent.steered.length, 1, '只说思考的那个必须被提醒')
})

test('完整链路：熔断 → 压缩 → 重试 → 这次正常收尾', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: (target) => target.touch(1) })
  const app = mount({}, { compaction })

  // 1) 第一次请求：复读，被熔断。
  const loop = longLineLoop(150)
  const seen = await drain(
    app.stream({ sessionId: agent.session.id }, () => streamOf(textDeltas(loop, 32)).source),
  )
  assert.equal(seen[seen.length - 1].reason.failure.code, CODES.repeat)

  // 2) 熔断失败进入恢复点：压缩 + 重试。
  const action = await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal')
  assert.deepEqual(action, { kind: 'retry' })

  // 3) 重试后正常收尾：正文完整，且不会再触发「只想不说」的提醒。
  await recordVisibleText(app, agent)
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0)
})

test('完整链路：连续熔断到上限后老实交还错误', async () => {
  const agent = fakeAgent()
  const compaction = fakeCompaction({ effect: (target) => target.touch(1) })
  const app = mount({ recover: { maxAttempts: 2 } }, { compaction })

  const results = []
  for (let i = 0; i < 4; i += 1) {
    results.push(await app.waterfall('agent/request-error', tripPayload(agent), () => 'terminal'))
  }
  assert.deepEqual(results, [{ kind: 'retry' }, { kind: 'retry' }, 'terminal', 'terminal'])
  assert.equal(compaction.calls.length, 2, '到顶后不再做无谓的压缩')
})

test('极端：100 个会话同时记账，互不串台', async () => {
  const app = mount({})
  const agents = []
  for (let i = 0; i < 100; i += 1) {
    const agent = fakeAgent({ id: 'session-' + i })
    agents.push(agent)
    if (i % 2 === 0) await recordSilentThought(app, agent)
    else await recordVisibleText(app, agent)
  }
  for (let i = 0; i < 100; i += 1) {
    await app.emit('agent/turn-stopping', { agent: agents[i], turn: 1, signal: liveSignal() })
    assert.equal(agents[i].steered.length, i % 2 === 0 ? 1 : 0, '第 ' + i + ' 个会话的判定串台了')
  }
})

test('极端：记账表有上限，最老的会话会被淘汰（内存不随会话数无限增长）', async () => {
  const app = mount({})
  const oldest = fakeAgent({ id: 'session-oldest' })
  await recordSilentThought(app, oldest)

  // 再灌 600 个会话的记录，远超内部上限（512 条）。
  for (let i = 0; i < 600; i += 1) {
    await recordVisibleText(app, fakeAgent({ id: 'filler-' + i }))
  }

  await app.emit('agent/turn-stopping', { agent: oldest, turn: 1, signal: liveSignal() })
  assert.equal(oldest.steered.length, 0, '最老的记录应已被淘汰，不再据此干预')
})

test('极端：同一次调用的记录会被下一次调用覆盖（不会拿旧结论说事）', async () => {
  const agent = fakeAgent()
  const app = mount({})

  await recordSilentThought(app, agent) // 先只说思考
  await recordVisibleText(app, agent) // 下一次调用说了正文

  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: liveSignal() })
  assert.equal(agent.steered.length, 0, '应当以最近一次调用的结论为准')
})

// ---------------------------------------------------------------------------
// D. 工具调用打转：挂在 tools/post-execute 上，靠附加上下文提醒
//
//    为什么不用 steer：工具刚跑完，把提醒作为附加上下文交给下一步，
//    模型的下一次请求就会看到它 —— 与 DSH 自带的 repeat-tool-reminder 同一机制。
// ---------------------------------------------------------------------------

/**
 * 依次触发若干次工具执行。
 * @param {object} app - 挂载结果。
 * @param {object} agent - 目标 agent。
 * @param {Array} plan - `[工具名, 参数]` 数组。
 * @param {object} [downstream] - 下游返回值。
 * @returns {Promise<object>} 最后一次的返回值。
 */
async function runTools(app, agent, plan, downstream = {}) {
  const listener = app.one('tools/post-execute')
  let out = downstream
  for (const [name, args] of plan) {
    out = await listener({ agent, name, arguments: args }, {}, () => downstream)
  }
  return out
}

/** 造「同样的两工具环走 n 遍」。 */
function toolCycle(n) {
  const plan = []
  for (let i = 0; i < n; i += 1) {
    plan.push(['read_file', { path: 'src/a.js' }])
    plan.push(['edit_file', { path: 'src/a.js', from: 'x', to: 'y' }])
  }
  return plan
}

test('工具打转：命中后把提醒挂进附加上下文', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const out = await runTools(app, agent, toolCycle(3))

  assert.ok(Array.isArray(out.additionalContexts), '必须挂上附加上下文')
  const notice = out.additionalContexts[0]
  assert.equal(notice.source.kind, 'self-heal')
  assert.equal(notice.role, 'user')
  assert.ok(notice.content[0].text.includes('重复同一套动作'), '文案要说明发生了什么')
  assert.ok(notice.content[0].text.includes('换一个办法'), '文案要给出方向')
  assert.ok(
    app.logs.some((entry) => entry.message.includes('工具调用打转')),
    '应当留一条可排查的日志',
  )
})

test('工具打转：不覆盖下游已经放进去的附加上下文', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const existing = { id: 'other-notice', role: 'user', content: [{ type: 'text', text: '别人的提醒' }] }
  const out = await runTools(app, agent, toolCycle(3), { additionalContexts: [existing] })

  assert.equal(out.additionalContexts.length, 2, '我们的提醒要加进去，不能顶掉别人的')
  assert.equal(out.additionalContexts[1], existing)
})

test('工具打转：下游是 block 时保留 feedback', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const out = await runTools(app, agent, toolCycle(3), { kind: 'block', feedback: '被沙箱拦下了' })

  assert.equal(out.kind, 'block')
  assert.equal(out.feedback, '被沙箱拦下了')
  assert.ok(Array.isArray(out.additionalContexts) && out.additionalContexts.length === 1)
})

test('工具打转：参数在变的正常多步任务绝不打扰', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const plan = []
  for (let i = 0; i < 8; i += 1) {
    plan.push(['read_file', { path: 'file-' + i + '.js' }])
    plan.push(['edit_file', { path: 'file-' + i + '.js', line: i }])
  }
  const out = await runTools(app, agent, plan)
  assert.equal(out.additionalContexts, undefined, '在推进就不该被打扰')
})

test('工具打转：用户插了新话之后，旧账清零', async () => {
  const agent = fakeAgent()
  const app = mount({})

  // 先走两遍（不够三遍，还没到提醒线）。
  await runTools(app, agent, toolCycle(2))

  // 用户说话了 → 这是新的意图，之前的动作序列不该再算数。
  const preStep = app.one('agent/pre-step')
  await preStep({ agent, messages: [{ source: { kind: 'user' } }] }, () => undefined)

  // 再走两遍：如果没清零，四遍就该提醒了；清零之后不该。
  const out = await runTools(app, agent, toolCycle(2))
  assert.equal(out.additionalContexts, undefined, '新意图之后不该拿旧账判它')
})

test('工具打转：自己注入的提醒不会被当成用户消息（否则永远清零）', async () => {
  const agent = fakeAgent()
  const app = mount({})
  const notice = { source: { kind: 'self-heal' } }
  const preStep = app.one('agent/pre-step')
  await preStep({ agent, messages: [notice] }, () => undefined)

  // 没被清零 → 三遍仍能命中。
  const out = await runTools(app, agent, toolCycle(3))
  assert.ok(Array.isArray(out.additionalContexts))
})

test('工具打转：exec 载荷残缺也不得抛错', async () => {
  const app = mount({})
  const listener = app.one('tools/post-execute')
  await listener({}, {}, () => ({}))
  await listener(undefined, {}, () => ({}))
  await listener({ agent: fakeAgent() }, {}, () => ({}))
  assert.ok(true, '没崩就算过')
})

test('工具打转：关掉开关后完全不介入', async () => {
  const agent = fakeAgent()
  const app = mount({ tools: { enabled: false } })
  const out = await runTools(app, agent, toolCycle(3))
  assert.equal(out.additionalContexts, undefined)
})
