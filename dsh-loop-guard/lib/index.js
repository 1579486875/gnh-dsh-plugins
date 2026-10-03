/**
 * dsh-loop-guard —— DSH 防跑飞护栏。
 *
 * 挂在 host 组合上，拦截每一次模型调用（`llm/stream` waterfall），在消费流的
 * 过程中施加三道与提供方无关的闸门：
 *
 *   1. 输出上限 —— 单次请求累计输出超过 `maxOutputTokens` 就中断。
 *      兜底 `maxTokens`：第三方网关常常直接忽略请求里的输出上限。
 *   2. 复读熔断 —— 尾部出现稳定的重复周期（字符级或行级）就中断。
 *      这是「思考打转」「Let me go / Let me run」那类失控的正主。
 *   3. 墙钟超时 —— 单次请求从开始到结束超过 `maxDurationMs` 就中断。
 *      兜底 `streamIdleTimeoutMs`：只要还在持续吐字，空闲超时永不触发。
 *
 * 熔断不抛异常，而是发出一个带自定义 failure code 的终止 `finish` 分片：
 *
 *   - 该 code 不在 `dsh-llm-retry` 的 `retryableCodes` 白名单里
 *     （默认只有 EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT），
 *     因此熔断不会被重试放大；
 *   - `reason.kind` 用 `'error'`，因此 `dsh-llm` 自身的流协议不变式照常通过
 *     （它允许 error/aborted 在块未闭合时终止）。
 *
 * @module dsh-loop-guard
 */

import { LINE_DEFAULTS, REPEAT_DEFAULTS, createRepeatDetector, estimateTokens } from './detect.js'

/** Cordis 插件名。 */
export const name = 'loop-guard'

/** 不依赖任何服务：护栏只消费 `llm/stream` 事件。 */
export const inject = []

/** 熔断代码。刻意全部避开 dsh-llm-retry 的默认可重试白名单。 */
export const CODES = Object.freeze({
  output: 'LOOP_GUARD_OUTPUT_LIMIT',
  repeat: 'LOOP_GUARD_REPEAT',
  timeout: 'LOOP_GUARD_TIMEOUT',
})

/**
 * 默认配置。
 *
 * `maxOutputTokens` 刻意略高于 `llm-deepseek` 自己的 256000 默认上限，
 * 这样在官方路由上由提供方先以 `max-tokens` 正常收尾，护栏只在下游忽略
 * 上限时才出手；`maxDurationMs` 取值宽松，避免误杀慢速路由上的长回答。
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  maxOutputTokens: 300000,
  maxDurationMs: 1800000,
  logTrips: true,
})

/**
 * 从一段 chunk 里取出「计入输出量的文本」。
 *
 * 工具参数增量同样计入 token 统计（它们确实是输出），但不参与复读判定 ——
 * 批量生成相似记录是合法用法，交给 token 上限兜底更合适。
 *
 * @param {object} chunk - 一个 StreamChunk。
 * @returns {string|null} 文本增量；该 chunk 不携带文本时返回 null。
 */
function outputTextOf(chunk) {
  if (chunk === null || typeof chunk !== 'object') return null
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' ? chunk.text : null
    case 'tool-call-delta':
      return typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : null
    default:
      return null
  }
}

/**
 * 从一段 chunk 里取出「参与复读判定的文本」——只取模型可见的正文与推理，
 * 不取工具参数。
 * @param {object} chunk - 一个 StreamChunk。
 * @returns {string|null} 文本增量；不参与判定时返回 null。
 */
function detectableTextOf(chunk) {
  if (chunk === null || typeof chunk !== 'object') return null
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return typeof chunk.text === 'string' ? chunk.text : null
  }
  return null
}

/**
 * 把一层配置对象合并到默认值上：只接受已知键且类型正确，其余静默忽略，
 * 这样一条写错的 YAML 不会让护栏带着 NaN 静默失效。
 * @param {object} base - 默认值。
 * @param {object} override - 用户覆盖。
 * @returns {object} 合并结果。
 */
function mergeConfig(base, override) {
  const out = { ...base }
  if (override === null || typeof override !== 'object') return out
  for (const key of Object.keys(base)) {
    const value = override[key]
    if (typeof base[key] === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    }
  }
  return out
}

/**
 * 归一化插件配置。
 * @param {unknown} config - 组合行传入的配置。
 * @returns {object} 生效配置。
 */
export function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const base = mergeConfig(DEFAULT_CONFIG, raw)
  return {
    ...base,
    repeat: mergeConfig(REPEAT_DEFAULTS, raw.repeat),
    lines: mergeConfig(LINE_DEFAULTS, raw.lines),
  }
}

/**
 * 把一次熔断写进日志。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {object} options - GenerateOptions。
 * @param {object} trip - 熔断描述。
 * @param {object} stats - 统计。
 * @returns {void}
 */
function report(ctx, cfg, options, trip, stats) {
  if (cfg.logTrips !== true) return
  const route = String(options?.provider ?? '?') + '/' + String(options?.model ?? '?')
  const purpose = options?.purpose === undefined ? '' : ' purpose=' + String(options.purpose)
  const detail = trip.detail === undefined ? '' : ' ' + trip.detail
  const message =
    'loop-guard 已熔断一次失控的模型调用 [' + trip.code + ']' +
    ' | 路由 ' + route + purpose +
    ' | 原因 ' + trip.message + detail +
    ' | 已输出约 ' + String(stats.outTokens) + ' tokens (' + String(stats.outChars) + ' 字符)' +
    ' | 耗时 ' + String(Math.round(stats.elapsedMs / 1000)) + 's'
  try {
    ctx.logger?.warn?.(message)
  } catch {
    // 日志失败绝不能影响流的收尾。
  }
}

/**
 * 包装一条上游模型流，施加三道闸门。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {object} options - GenerateOptions。
 * @param {AsyncIterable<object>} source - 上游流。
 * @returns {AsyncIterable<object>} 受保护的流。
 */
async function* guardStream(ctx, cfg, options, source) {
  const startedAt = Date.now()
  // 思考流与正文流各自独立计数。
  //
  // 这一点是实测出来的：两者混在同一个缓冲里时，思考内容会把正文的行序列
  // 撑散 —— 一次真实复读中，推理文本先占掉了 minChars 门槛，导致 armed 那
  // 一刻正文只有二十来行，远不够行级判定所需的 75 行，于是整个循环漏网。
  // 分开之后，正文必须自己攒够 minChars 才判定，相位也就干净了。
  const detectors = new Map([
    ['text-delta', createRepeatDetector(cfg.repeat, cfg.lines)],
    ['reasoning-delta', createRepeatDetector(cfg.repeat, cfg.lines)],
  ])
  const iterator = source[Symbol.asyncIterator]()

  let outTokens = 0
  let outChars = 0
  let trip = null
  let upstreamClosed = false

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
          message: '单次请求超过墙钟上限 ' + String(cfg.maxDurationMs) + 'ms，判定为失控并中断。',
        }
        break
      }

      const step = await iterator.next()
      if (step.done === true) break

      const chunk = step.value
      const text = outputTextOf(chunk)
      if (text !== null) {
        outChars += text.length
        outTokens += estimateTokens(text)
      }

      // 原样放行，再判定：触发熔断的那一块内容确实由模型产出，照常交给消费方。
      yield chunk

      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') break

      if (text !== null && cfg.maxOutputTokens > 0 && outTokens > cfg.maxOutputTokens) {
        trip = {
          code: CODES.output,
          message: '单次请求输出超过上限 ' + String(cfg.maxOutputTokens) + ' tokens，判定为失控并中断。',
        }
        break
      }

      const detectable = detectableTextOf(chunk)
      if (detectable !== null) {
        const bucket = detectors.get(chunk.type)
        const hit = bucket === undefined ? null : bucket.push(detectable)
        if (hit !== null) {
          const where = chunk.type === 'reasoning-delta' ? '思考流' : '正文流'
          trip = {
            code: CODES.repeat,
            message: '检测到持续性复读（' + where + '），判定为思考循环并中断。',
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

  if (trip !== null) {
    report(ctx, cfg, options, trip, { outTokens, outChars, elapsedMs: Date.now() - startedAt })
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
 * 安装护栏。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} config - 组合行配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)

  if (cfg.enabled !== true) {
    ctx.logger?.info?.('loop-guard: enabled=false，未安装任何护栏。')
    return
  }

  ctx.on(
    'llm/stream',
    (options, next) => {
      const source = next()
      if (source === null || typeof source !== 'object' || typeof source[Symbol.asyncIterator] !== 'function') {
        return source
      }
      return guardStream(ctx, cfg, options, source)
    },
    { global: true },
  )

  ctx.logger?.info?.(
    'loop-guard: 护栏已就位（输出上限 ' + String(cfg.maxOutputTokens) + ' tokens，' +
      '墙钟上限 ' + String(Math.round(cfg.maxDurationMs / 1000)) + 's，' +
      '复读检测 ' + (cfg.repeat.enabled ? '开' : '关') + '）。',
  )
}
