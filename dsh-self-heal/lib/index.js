/**
 * dsh-self-heal —— DSH「失控自愈」插件。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 一句话说明
 * ─────────────────────────────────────────────────────────────────────────
 * 当一次模型调用跑飞（复读打转 / 迟迟不结束）、或者模型「只想不说」时，
 * 它不是简单地把请求掐掉，而是**把对话救回来**：压缩历史、重发请求、
 * 提醒模型把正文写出来。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 它挂在哪儿、为什么
 * ─────────────────────────────────────────────────────────────────────────
 * 挂在 host 组合上（覆盖所有会话 × 所有子代理 × 所有辅助模型调用）。它监听
 * 三个官方扩展点，各管一件事：
 *
 *   1. `llm/stream`（瀑布式事件，模型流的必经之路）
 *      —— **发现失控**。这里能看到模型的每一个输出分片，所以能实时判断
 *         「是不是在原地打转」和「这一次调用是不是超时了」。
 *
 *   2. `agent/request-error`（瀑布式事件，一次请求失败后的恢复点）
 *      —— **把对话救回来**。熔断之后，先让压缩服务把过长的历史压成摘要，
 *         然后返回 `{ kind: 'retry' }` 让 agent 循环**重新发一次请求**。
 *         重发时请求是按压缩后的历史重新拼出来的，所以这一次有希望正常收尾。
 *
 *   3. `agent/turn-stopping`（顺序事件，一轮对话即将结束前的最后时刻）
 *      —— **治好「只想不说」**。如果这一轮模型只输出了思考、没有输出任何
 *         给用户看的正文，就在这里补一句提醒，让这一轮继续跑一步、把正文
 *         真正写出来。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么不用抛异常
 * ─────────────────────────────────────────────────────────────────────────
 * 熔断时插件**不抛异常**，而是补一个带自定义 failure code 的终止 `finish`
 * 分片：
 *
 *   - `reason.kind` 用 `'error'`，因此 `dsh-llm` 自己的流协议不变式照常通过
 *     （它允许 error / aborted 在内容块还没闭合时终止）。
 *   - `failure.code` 用 `SELF_HEAL_*` 前缀，**刻意避开** `dsh-llm-retry` 的
 *     默认可重试白名单（EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT /
 *     TRANSPORT），所以「官方重试」不会把一次熔断放大成五倍账单；重试与否
 *     由本插件自己的「压缩 + 重试」逻辑决定。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么不再有「单次输出上限」
 * ─────────────────────────────────────────────────────────────────────────
 * 早期版本还有一道「单次请求输出超过 N token 就掐断」的硬闸门。它的问题是
 * 一刀切：合法的超长输出（批量生成、大段代码、长表格）也会被杀掉，而用户
 * 真正想要的只是「别跑飞」。现在改成**只在识别出失控特征时才介入**：
 * 复读（尾部稳定重复）与墙钟超时（迟迟不结束）。正常的长输出不再受任何限制。
 *
 * @module dsh-self-heal
 */

import { randomUUID } from 'node:crypto'

import { LINE_DEFAULTS, REPEAT_DEFAULTS, createRepeatDetector } from './detect.js'

/** Cordis 插件名（组合行里的标识，与 npm 包名 `dsh-self-heal` 不同）。 */
export const name = 'self-heal'

/**
 * 本插件不注入任何服务。
 *
 * 原因：压缩服务被隔离在「每个会话各自的预设（agent preset）」里，而不是
 * host 平面；而插件在启动时还没有任何会话，注入也拿不到。所以压缩服务是
 * **运行时按 agent 去取**的（见 {@link compactionFor}），拿不到就优雅降级。
 */
export const inject = []

/**
 * 熔断代码。
 *
 * 刻意全部避开 `dsh-llm-retry` 的默认可重试白名单，好处有两个：
 *   1. 官方重试不会把一个已经失控的请求再放大五遍；
 *   2. 我们自己能凭这两个代码，在 `agent/request-error` 里一眼认出「这是我的
 *      熔断」，从而接管恢复流程。
 */
export const CODES = Object.freeze({
  repeat: 'SELF_HEAL_REPEAT',
  timeout: 'SELF_HEAL_TIMEOUT',
})

/**
 * 默认配置。
 *
 * `maxDurationMs` 取值宽松（30 分钟），因为「慢」和「失控」不是一回事：
 * 慢速路由上的长回答本来就要跑很久，只有真的迟迟不结束时才该动手。
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** 单次模型调用的墙钟上限（毫秒）。0 表示关闭这项检测。 */
  maxDurationMs: 1800000,
  /** 是否在每次介入时往日志写一行诊断。 */
  logTrips: true,
  /** 熔断之后如何恢复（压缩 + 重发）。 */
  recover: {
    enabled: true,
    /** 同一轮对话里最多恢复几次；到顶后就老实把错误报给上层。 */
    maxAttempts: 3,
    /**
     * 压缩没能让历史变短时，是否仍然重发一次请求。
     *
     * 设为 true 的理由：超时和复读常常只是「这一次不走运」。历史里没有可压缩
     * 的区间时（例如对话还很短），重发一次的成本很低，而救回来的价值很高。
     */
    retryWithoutCompaction: true,
  },
  /** 「只想不说」的补救。 */
  silentThought: {
    enabled: true,
    /** 同一轮对话里最多提醒几次。 */
    maxAttempts: 2,
    /** 记录的时效（毫秒）：超过这么久就不再据此干预，避免误伤下一轮。 */
    maxAgeMs: 300000,
    /** 提醒正文；会在会话里以一条 user 消息的形式出现。 */
    message:
      '[系统自动提醒] 你上一轮只产生了思考内容，没有输出任何给用户看的正文。' +
      '请立刻把结论写出来：不要再展开分析，不要重复思考过程，直接从结论或结果开始输出正文。',
  },
})

/** 「说没说正文」记账表的最大条数（防止长期运行时无限增长）。 */
const MAX_ATTEMPT_ENTRIES = 512

/**
 * 判断一个值是不是「可以当对象用」的东西。
 *
 * 说明：`typeof null === 'object'`，这是个经典的坑；这里只需要区分「能不能
 * 安全地取属性」，所以数组也放行。
 * @param {unknown} value - 待判断的值。
 * @returns {boolean} 是否为非 null 的对象。
 */
function isObject(value) {
  return value !== null && typeof value === 'object'
}

/**
 * 把一层配置对象合并到默认值上。
 *
 * 规则：**只接受已知键，而且类型必须对得上**，其余全部静默忽略并保留默认值。
 * 这样即使 profile 里写错一行 YAML，插件也不会带着 `NaN` 或 `undefined`
 * 静默失效 —— 它会继续用默认值工作。
 *
 * @param {object} base - 默认值（键名就是允许出现的键名）。
 * @param {object} override - 用户写的覆盖值。
 * @returns {object} 合并后的配置。
 */
function mergeConfig(base, override) {
  const out = { ...base }
  if (!isObject(override)) return out
  for (const key of Object.keys(base)) {
    const fallback = base[key]
    const value = override[key]
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
    } else if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    } else if (typeof fallback === 'string') {
      if (typeof value === 'string' && value.trim() !== '') out[key] = value
    }
    // 其它类型（对象等）由调用方分组处理；这里不动，避免被半截对象覆盖。
  }
  return out
}

/**
 * 归一化插件配置：把外层与各分组一起补齐成「一定是完整、类型正确」的对象。
 * @param {unknown} config - 组合行传进来的原始配置。
 * @returns {object} 生效配置。
 */
export function resolveConfig(config) {
  const raw = isObject(config) ? config : {}
  return {
    ...mergeConfig(DEFAULT_CONFIG, raw),
    recover: mergeConfig(DEFAULT_CONFIG.recover, raw.recover),
    silentThought: mergeConfig(DEFAULT_CONFIG.silentThought, raw.silentThought),
    repeat: mergeConfig(REPEAT_DEFAULTS, raw.repeat),
    lines: mergeConfig(LINE_DEFAULTS, raw.lines),
  }
}

/**
 * 递归冻结一个对象（连子对象一起冻住）。
 *
 * 为什么要冻：写进会话的消息必须是不可变的。DSH 内部自带一份 deepFreeze，
 * 但那个在内部包里；本插件不依赖 DSH 内部包（避免版本耦合），所以就地实现
 * 一个最小版本 —— 对我们自己构造的「字符串 + 数组 + 普通对象」完全够用。
 *
 * @param {unknown} value - 待冻结的值。
 * @returns {unknown} 同一个值（已冻结）。
 */
function deepFreeze(value) {
  if (!isObject(value) || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 造一条「用户消息」——用来把提醒说给模型听。
 *
 * 这是 DSH 里用户消息的最小形状：一个身份 id、角色 user、内容块数组，以及
 * 说明「这条是谁产生的」的 source。`source.kind` 用本插件自己的名字，界面
 * 上一眼就能看出这条提醒不是真人打的。
 *
 * 导出它是为了让「契约自检」能拿真实的 DSH 会话去验证这条消息确实合法
 * （见 test/contract-check.mjs）—— 这类形状如果写错，只会在运行时才炸。
 *
 * @param {string} text - 提醒正文。
 * @param {string} summary - 一句话摘要（列表里显示的短说明）。
 * @returns {object} 已冻结的用户消息。
 */
export function createNoticeMessage(text, summary) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'self-heal', form: 'notice', summary },
  })
}

/**
 * 从一段分片里取出「模型输出的正文或推理文本」。
 *
 * 工具参数增量不算：它们确实是输出，但属于结构化数据，不参与复读判定 ——
 * 批量生成相似记录是合法用法。
 *
 * @param {object} chunk - 一个流分片。
 * @returns {string|null} 文本增量；该分片不带文本时返回 null。
 */
function detectableTextOf(chunk) {
  if (!isObject(chunk)) return null
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return typeof chunk.text === 'string' ? chunk.text : null
  }
  return null
}

/**
 * 在「这次调用到底输出了什么」的记账本上打个勾。
 *
 * 只需要布尔值，而且两种标记都为真之后就可以彻底不再看后面的分片 —— 这样
 * 摊到每个分片上的成本几乎是零（一次布尔判断）。
 *
 * @param {{hasText: boolean, hasToolCall: boolean}} state - 记账本。
 * @param {object} chunk - 一个流分片。
 * @returns {void}
 */
function noteVisibility(state, chunk) {
  if (!isObject(chunk)) return
  if (state.hasText && state.hasToolCall) return
  switch (chunk.type) {
    case 'text-delta':
      // `trim()` 是为了把「只吐了一堆空格或换行」也视为没说正文。
      if (!state.hasText && typeof chunk.text === 'string' && chunk.text.trim() !== '') state.hasText = true
      return
    case 'tool-call-delta':
      state.hasToolCall = true
      return
    case 'block-end': {
      const block = chunk.block
      if (!isObject(block)) return
      if (block.type === 'tool-call') state.hasToolCall = true
      else if (block.type === 'text' && !state.hasText && typeof block.text === 'string' && block.text.trim() !== '') {
        state.hasText = true
      }
      return
    }
    default:
      // 其它类型（block-start / usage / finish …）与「说没说正文」无关。
      return
  }
}

/**
 * 记住一次普通对话调用的结果，供「一轮结束时」查用。
 *
 * 为什么按 `sessionId` 存：`llm/stream` 这一层只拿得到 sessionId；到了
 * `agent/turn-stopping` 那一层再用 agent 反查同一个 id 即可。
 *
 * 为什么要有条数上限：每个会话一条记录，正常也就几十条；但插件要能长期
 * 运行，所以给一个硬上限，超出时丢掉最早的一条（Map 保持插入顺序）。
 *
 * @param {Map<string, object>} table - 记账表。
 * @param {string} sessionId - 会话 id。
 * @param {object} info - 本次调用的结果。
 * @returns {void}
 */
function rememberAttempt(table, sessionId, info) {
  if (table.size >= MAX_ATTEMPT_ENTRIES && !table.has(sessionId)) {
    const oldest = table.keys().next().value
    if (oldest !== undefined) table.delete(oldest)
  }
  table.set(sessionId, info)
}

/**
 * 把一次介入写进日志。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {'info'|'warn'} level - 日志级别。
 * @param {string} message - 日志正文。
 * @returns {void}
 */
function logLine(ctx, cfg, level, message) {
  if (cfg.logTrips !== true) return
  try {
    ctx.logger?.[level]?.('self-heal: ' + message)
  } catch {
    // 日志失败绝不能影响正在进行的对话。
  }
}

/**
 * 包住一条上游模型流，实时检查「是不是跑飞了」。
 *
 * 两道检查：
 *   1. **复读**：正文流与思考流各自独立计数（两者混在一起会把行序列撑散，
 *      实测漏网过真实循环），尾部出现稳定重复周期就熔断。
 *   2. **墙钟超时**：从开始到现在的真实时间超过上限就熔断。它是「流空闲
 *      超时」的兜底 —— 只要模型还在持续吐字，空闲超时永远不会触发。
 *
 * 熔断时：先关掉上游（不让它在后台继续烧 token），再补一个终止 finish 分片。
 * 数据本身**原样放行**：触发熔断的那一块内容确实由模型产出，照常交给消费方。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {object} options - GenerateOptions（本次请求的全部参数）。
 * @param {AsyncIterable<object>} source - 上游流。
 * @param {Map<string, object>} attempts - 「说没说正文」的记账表。
 * @returns {AsyncIterable<object>} 受保护、并在正常结束时记账的流。
 */
async function* healStream(ctx, cfg, options, source, attempts) {
  const startedAt = Date.now()
  // 思考流与正文流各自独立计数，理由见上面第 1 点。
  const detectors = new Map([
    ['text-delta', createRepeatDetector(cfg.repeat, cfg.lines)],
    ['reasoning-delta', createRepeatDetector(cfg.repeat, cfg.lines)],
  ])
  const iterator = source[Symbol.asyncIterator]()

  /** 本次调用「说没说正文 / 干没干活」，供一轮结束时判断是否补救。 */
  const visibility = { hasText: false, hasToolCall: false }

  let outChars = 0
  let trip = null
  let upstreamClosed = false
  /** 上游是「自然走完」还是「被我们或消费方中途打断」。 */
  let upstreamDrained = false

  const closeUpstream = async () => {
    if (upstreamClosed) return
    upstreamClosed = true
    try {
      await iterator.return?.()
    } catch {
      // 关不掉上游不掩盖熔断原因，也不改变已经发出的 finish。
    }
  }

  try {
    while (trip === null) {
      if (cfg.maxDurationMs > 0 && Date.now() - startedAt >= cfg.maxDurationMs) {
        trip = {
          code: CODES.timeout,
          message: '单次请求超过墙钟上限 ' + String(cfg.maxDurationMs) + 'ms，判定为失控。',
        }
        break
      }

      const step = await iterator.next()
      if (step.done === true) {
        upstreamDrained = true
        break
      }

      const chunk = step.value
      const text = detectableTextOf(chunk)
      if (text !== null) outChars += text.length
      noteVisibility(visibility, chunk)

      // 原样放行，再判定。
      yield chunk

      if (isObject(chunk) && chunk.type === 'finish') {
        upstreamDrained = true
        break
      }

      if (text !== null) {
        const bucket = detectors.get(chunk.type)
        const hit = bucket === undefined ? null : bucket.push(text)
        if (hit !== null) {
          const where = chunk.type === 'reasoning-delta' ? '思考流' : '正文流'
          trip = {
            code: CODES.repeat,
            message: '检测到持续性复读（' + where + '），判定为思考循环。',
            detail:
              hit.kind === 'char-period'
                ? '(字符级周期 ' + String(hit.period) + ' 字符)'
                : '(行级周期 ' + String(hit.periodLines) + ' 行 × ' + String(hit.repeats) + ' 次)',
          }
          break
        }
      }
    }
  } finally {
    await closeUpstream()
  }

  // 记账：只记「完整走完」的普通对话调用。
  //   - 被熔断的调用会直接走错误恢复那条路，根本到不了「一轮结束」，不必记；
  //   - 带 purpose 的是辅助调用（生成标题、压缩摘要），不是对话本身，不记。
  if (trip === null && upstreamDrained && options?.purpose === undefined) {
    const sessionId = options?.sessionId
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      rememberAttempt(attempts, sessionId, {
        at: Date.now(),
        hasText: visibility.hasText,
        hasToolCall: visibility.hasToolCall,
        chars: outChars,
      })
    }
  }

  if (trip !== null) {
    const route = String(options?.provider ?? '?') + '/' + String(options?.model ?? '?')
    const detail = trip.detail === undefined ? '' : ' ' + trip.detail
    logLine(
      ctx,
      cfg,
      'warn',
      '已熔断一次失控调用 [' + trip.code + ']' +
        ' | 路由 ' + route +
        ' | 原因 ' + trip.message + detail +
        ' | 已输出 ' + String(outChars) + ' 字符' +
        ' | 耗时 ' + String(Math.round((Date.now() - startedAt) / 1000)) + 's',
    )
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: trip.message, code: trip.code },
      },
    }
  }
}

/**
 * 会话里有没有「这次调用没说正文」的记账？（有的话，一轮结束时才好补救。）
 * @param {Map<string, object>} attempts - 记账表。
 * @param {object} agent - 目标 agent。
 * @returns {object|undefined} 记账内容。
 */
function attemptOf(attempts, agent) {
  const sessionId = agent?.session?.id
  if (typeof sessionId !== 'string') return undefined
  return attempts.get(sessionId)
}

/**
 * 取「这个 agent 所在预设里部署的压缩服务」。
 *
 * 为什么要绕这一圈：压缩（`ctx.compaction`）被刻意 `isolate` 在**每个会话
 * 各自挂载的预设**里，host 平面直接 `ctx.get('compaction')` 很可能什么都
 * 拿不到。官方为此提供了按 agent 取预设内服务的入口
 * （`agentPresets.serviceFor`）。这里按可靠性从高到低三条路依次尝试，
 * 全失败就返回 undefined —— 调用方会优雅降级成「不压缩，直接重试」。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} agent - 目标 agent。
 * @returns {object|undefined} 压缩服务。
 */
function compactionFor(ctx, agent) {
  try {
    const viaPreset = ctx?.agentPresets?.serviceFor?.(agent, 'compaction')
    if (viaPreset !== undefined && viaPreset !== null) return viaPreset
  } catch {
    // 拿不到就试下一条路。
  }
  try {
    const viaAgent = agent?.ctx?.get?.('compaction')
    if (viaAgent !== undefined && viaAgent !== null) return viaAgent
  } catch {
    // 同上。
  }
  try {
    const viaHost = ctx?.get?.('compaction')
    if (viaHost !== undefined && viaHost !== null) return viaHost
  } catch {
    // 同上。
  }
  return undefined
}

/**
 * 判断一次失败是不是「本插件给出的熔断」。
 * @param {unknown} failure - 失败信息。
 * @returns {boolean} 是否为本插件的熔断 code。
 */
function isSelfHealTrip(failure) {
  if (!isObject(failure)) return false
  const code = failure.code
  return code === CODES.repeat || code === CODES.timeout
}

/**
 * 安装「熔断之后救回来」的恢复逻辑，挂在 `agent/request-error` 上。
 *
 * 完整流程：
 *   识别熔断 → 用一个「同一轮对话内的次数上限」防止死循环 → 让压缩服务强制
 *   做一次有用的缩减（这一步可能顺带剪枝过长的工具结果）→ 如果历史确实变了
 *   （或按配置允许「没变也重试」），就返回 `{ kind: 'retry' }`，让 agent 循环
 *   用**压缩后的历史**重新发一次请求。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @returns {void}
 */
function installRunawayRecovery(ctx, cfg) {
  /** agent → 本轮已恢复次数。用 WeakMap：agent 被回收时记录自动消失。 */
  const used = new WeakMap()

  ctx.on('agent/request-error', async (payload, next) => {
    const agent = payload?.agent
    if (cfg.recover.enabled !== true) return next()
    if (!isObject(agent) || !isSelfHealTrip(payload?.failure)) return next()

    try {
      const signal = payload?.signal
      const turn = payload?.turn
      if (signal?.aborted === true) return next()
      const surface = agent?.session?.surface
      if (!isObject(surface)) return next()

      const state = used.get(agent)
      const already = state !== undefined && state.turn === turn ? state.count : 0
      if (already >= cfg.recover.maxAttempts) {
        logLine(ctx, cfg, 'warn', '本轮已恢复 ' + String(already) + ' 次仍未成功，停止重试并把错误交还给上层。')
        return next()
      }

      const beforeReplace = surface.replaceGeneration
      const beforeContent = surface.contentGeneration

      const compaction = compactionFor(ctx, agent)
      if (compaction === undefined) {
        logLine(
          ctx,
          cfg,
          'warn',
          '找不到压缩服务，跳过压缩；' + (cfg.recover.retryWithoutCompaction === true ? '直接重试一次。' : '放弃恢复。'),
        )
      } else {
        try {
          await compaction.compactIfNeeded(agent, 'context-overflow', signal)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logLine(ctx, cfg, 'warn', '压缩失败（' + message + '），继续按原历史重试一次。')
        }
        if (signal?.aborted === true) return next()
      }

      // 「有进展」的判据：历史被替换（压缩成摘要）**或**内容被改写（工具结果剪枝）。
      // 两者都让下一次请求变小，都值得重发。
      const replaced = typeof beforeReplace === 'number' && surface.replaceGeneration > beforeReplace
      const shrunk = typeof beforeContent === 'number' && surface.contentGeneration > beforeContent
      const progressed = replaced || shrunk

      if (!progressed && cfg.recover.retryWithoutCompaction !== true) {
        logLine(ctx, cfg, 'warn', '压缩没有让历史变短，按配置不再重试。')
        return next()
      }

      used.set(agent, { turn, count: already + 1 })
      logLine(
        ctx,
        cfg,
        'info',
        '已从熔断中恢复：' +
          (progressed ? '历史已压缩，' : '历史没有可压缩的区间，') +
          '重新发送请求（本轮第 ' + String(already + 1) + ' 次）。',
      )
      return { kind: 'retry' }
    } catch (error) {
      // 任何意外都必须退回「不接管」，绝不能让恢复逻辑本身把对话弄坏。
      const message = error instanceof Error ? error.message : String(error)
      logLine(ctx, cfg, 'warn', '恢复流程自身出错（' + message + '），交还原始错误。')
      return next()
    }
  })
}

/**
 * 安装「只想不说」的补救，挂在 `agent/turn-stopping` 上。
 *
 * 时机正好：这个事件在一轮对话即将结束、且模型已经不欠任何工具调用时触发。
 * 此时如果最近这次调用「没有正文、也没有工具调用」，说明模型光想不说，
 * 用户什么都看不到 —— 于是投一条提醒（steering）进去，让这一轮再跑一步。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {Map<string, object>} attempts - 「说没说正文」的记账表。
 * @returns {void}
 */
function installSilentThoughtRescue(ctx, cfg, attempts) {
  /** agent → 本轮已提醒次数。 */
  const strikes = new WeakMap()

  ctx.on('agent/turn-stopping', (payload) => {
    if (cfg.silentThought.enabled !== true) return
    try {
      const agent = payload?.agent
      const turn = payload?.turn
      // 载荷异常（理论上不会发生）时什么都不做，绝不抛错打断对话。
      if (!isObject(agent)) return
      const info = attemptOf(attempts, agent)
      if (info === undefined) return
      // 说了正文，或者本来就该去调工具 —— 都是正常情况，不干预。
      if (info.hasText === true || info.hasToolCall === true) return
      // 记录太老说明它已经不是「刚刚这次」的结果，宁可不干预也不误伤。
      if (typeof info.at !== 'number' || Date.now() - info.at > cfg.silentThought.maxAgeMs) return

      const state = strikes.get(agent)
      const already = state !== undefined && state.turn === turn ? state.count : 0
      if (already >= cfg.silentThought.maxAttempts) {
        logLine(ctx, cfg, 'warn', '模型连续只思考不输出正文，已达到提醒上限，放行结束本轮。')
        return
      }

      strikes.set(agent, { turn, count: already + 1 })
      // 用掉这条记录：提醒之后会再跑一步，新的调用会重新记账。
      attempts.delete(agent.session.id)
      agent.steer(createNoticeMessage(cfg.silentThought.message, '只思考未输出正文，要求补出正文'))
      logLine(
        ctx,
        cfg,
        'info',
        '本轮模型只思考未输出正文（本次输出 ' +
          String(typeof info.chars === 'number' ? info.chars : 0) +
          ' 字符，全是思考），已注入提醒并要求重新输出（本轮第 ' +
          String(already + 1) +
          ' 次）。',
      )
    } catch (error) {
      // 补救失败就算了：绝不能让「治好只想不说」这件事本身打断对话。
      const message = error instanceof Error ? error.message : String(error)
      logLine(ctx, cfg, 'warn', '空谈补救失败（' + message + '），本轮照常结束。')
    }
  })
}

/**
 * 安装插件。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} config - 组合行配置（profile 的 cordis.patch.yml 里写的）。
 * @returns {void}
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)

  if (cfg.enabled !== true) {
    logLine(ctx, cfg, 'info', 'enabled=false，未安装任何自愈逻辑。')
    return
  }

  /** 「最近一次普通对话调用说没说正文」，按 sessionId 记账。 */
  const attempts = new Map()

  ctx.on(
    'llm/stream',
    (options, next) => {
      const source = next()
      // 不是异步可迭代对象（下游没给流）就原样透传，绝不改写别人的返回值。
      if (!isObject(source) || typeof source[Symbol.asyncIterator] !== 'function') return source
      return healStream(ctx, cfg, options, source, attempts)
    },
    { global: true },
  )

  installRunawayRecovery(ctx, cfg)
  installSilentThoughtRescue(ctx, cfg, attempts)

  logLine(
    ctx,
    cfg,
    'info',
    '自愈已就位（墙钟上限 ' +
      (cfg.maxDurationMs > 0 ? String(Math.round(cfg.maxDurationMs / 1000)) + 's' : '关') +
      '，复读检测 ' +
      (cfg.repeat.enabled || cfg.lines.enabled ? '开' : '关') +
      '，熔断后压缩并重试 ' +
      (cfg.recover.enabled ? '开' : '关') +
      '，只思考未输出正文的补救 ' +
      (cfg.silentThought.enabled ? '开' : '关') +
      '）。',
  )
}
