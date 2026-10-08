/**
 * dsh-self-heal 测试脚手架。
 *
 * 这里造的是一个「假 DSH」：只保留插件真正用到的那几个接口，用来在**不启动
 * 真实 DSH** 的前提下，把插件的每一条逻辑链路走通。
 *
 * 为什么值得单独写一层脚手架而不是在每个测试里各造一遍：
 *   - 事件分发（emit / waterfall）的语义只有一处实现，测试之间不会走样；
 *   - 以后 DSH 的接口有变，只需要改这一个文件就能暴露影响面。
 *
 * @module test/harness
 */

import { apply } from '../lib/index.js'

/**
 * 造一个假 Cordis 上下文。
 *
 * @param {object} [services] - 可被 `ctx.get(name)` 取到的服务（例如 compaction）。
 * @returns {object} 假上下文（额外带 `logs` 与 `listeners` 便于断言）。
 */
export function fakeCtx(services = {}) {
  const listeners = []
  const logs = []
  const ctx = {
    logs,
    listeners,
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    on(event, listener, options) {
      listeners.push({ event, listener, options })
      return () => {
        const at = listeners.findIndex((l) => l.listener === listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    get(name) {
      return services[name]
    },
    // 官方「按 agent 取预设内服务」的入口；测试里直接映射到同一张表。
    agentPresets: {
      serviceFor(agent, name) {
        return agent?.presetServices?.[name] ?? services[name]
      },
    },
  }
  return ctx
}

/**
 * 挂载插件并返回一组便于触发事件的辅助函数。
 *
 * @param {unknown} [config] - 插件配置。
 * @param {object} [services] - 可被 ctx.get 取到的服务。
 * @returns {object} 挂载结果。
 */
export function mount(config = {}, services = {}) {
  const ctx = fakeCtx(services)
  apply(ctx, config)
  const of = (event) => ctx.listeners.filter((l) => l.event === event)
  /** 只取某一个事件的监听器（多用于断言数量）。 */
  const one = (event) => {
    const found = of(event)
    if (found.length !== 1) throw new Error('期望恰好 1 个 ' + event + ' 监听器，实际 ' + found.length)
    return found[0].listener
  }
  return {
    ctx,
    logs: ctx.logs,
    of,
    one,
    /** 调用 llm/stream 监听器，返回它包装出来的流。 */
    stream(options, makeSource) {
      return one('llm/stream')(options, makeSource)
    },
    /** 触发 emit / serial 类事件（无返回值语义）。 */
    emit(event, payload) {
      return Promise.all(of(event).map((l) => l.listener(payload)))
    },
    /**
     * 触发瀑布式（waterfall）事件：监听器按注册顺序依次调用，谁先返回值谁说了算。
     * 全部都不接管时，落到 fallback（真实 DSH 里的默认行为）。
     */
    waterfall(event, payload, fallback = () => undefined) {
      const chain = of(event)
      let index = -1
      const next = () => {
        index += 1
        const entry = chain[index]
        if (entry === undefined) return Promise.resolve(fallback())
        return Promise.resolve(entry.listener(payload, next))
      }
      return next()
    },
  }
}

/**
 * 把一段分片列表变成异步可迭代对象，并记录它有没有被关闭。
 * @param {object[]} chunks - 分片数组。
 * @param {object} [opts] - `{ delayMs }`：每个分片之间等待多久（用于测超时）。
 * @returns {{source: object, state: object}} 流与它的状态。
 */
export function streamOf(chunks, opts = {}) {
  const delayMs = opts.delayMs ?? 0
  const onNext = opts.onNext
  const state = { closed: false, pulled: 0 }
  const source = {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
          if (i >= chunks.length) return { done: true, value: undefined }
          state.pulled += 1
          const value = chunks[i]
          i += 1
          if (onNext !== undefined) onNext(value, state.pulled)
          return { done: false, value }
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

/**
 * 消费一条流，返回全部收到的分片。
 * @param {AsyncIterable<object>} stream - 待消费的流。
 * @returns {Promise<object[]>} 收到的分片。
 */
export async function drain(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/**
 * 把一段文本切成指定大小的分片。
 * @param {string} text - 文本。
 * @param {number} size - 每片大小。
 * @returns {object[]} text-delta 分片数组。
 */
export function textDeltas(text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) {
    out.push({ type: 'text-delta', index: 0, text: text.slice(i, i + size) })
  }
  return out
}

/**
 * 造一个假 agent（只保留插件会用到的字段）。
 *
 * @param {object} [opts] - `{ id, replace, content }`；replace/content 用来模拟压缩后的代数变化。
 * @returns {object} 假 agent。
 */
export function fakeAgent(opts = {}) {
  const steered = []
  const surface = {
    replaceGeneration: opts.replace ?? 0,
    contentGeneration: opts.content ?? 0,
  }
  return {
    session: { id: opts.id ?? 'session-1', surface },
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    presetServices: {},
    steered,
    /** 记录被投递的 steering（提醒）消息。 */
    steer(message) {
      steered.push(message)
    },
    /** 供测试模拟「压缩真的改了历史」。 */
    touch(replaceDelta, contentDelta = 0) {
      surface.replaceGeneration += replaceDelta
      surface.contentGeneration += contentDelta
    },
  }
}

/**
 * 造一个假压缩服务。
 *
 * @param {object} [opts] - `{ effect, error }`：
 *   `effect(agent, callIndex)` 在每次调用时执行（用来改 agent 的历史代数）；
 *   `error` 非空时每次调用都抛这个错。
 * @returns {object} 假压缩服务（带 `calls` 记录）。
 */
export function fakeCompaction(opts = {}) {
  const calls = []
  return {
    calls,
    async compactIfNeeded(agent, trigger, signal) {
      calls.push({ agent, trigger, signal })
      if (opts.error !== undefined) throw opts.error
      if (opts.effect !== undefined) opts.effect(agent, calls.length)
      return null
    },
  }
}

/** 一个不会 abort 的信号。 */
export function liveSignal() {
  return new AbortController().signal
}
