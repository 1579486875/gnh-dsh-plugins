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
 * 生成一批**互不相同**的代码行，用来把正文撑过判定窗口。
 *
 * ⚠️ 每行必须不同。若图省事写成 `'const a = 1\n'.repeat(400)`，在**链路测试**里
 * 会先被复读检测熔断（那是另一条链路，而被熔断的调用根本不记账），于是围栏判据
 * 压根轮不到执行 —— 测试会因为「没提醒」而**假通过**。
 *
 * @param {number} count - 行数。
 * @returns {string} 代码文本。
 */
export function variedCodeLines(count) {
  let out = ''
  for (let i = 0; i < count; i += 1) {
    out += 'const v' + String(i) + ' = ' + String(i * 7 + 3) + '; // 第 ' + String(i) + ' 行\n'
  }
  return out
}

/**
 * 造一份「判定窗口正好把一对代码围栏劈开」的完整报告。
 *
 * 现场还原（2026-10-11 真实事故）：一份 5 千多字符的完整报告，中间有若干代码块，
 * 末尾正常收尾，却被判成「代码块没有写完」。根因是判定窗口（最后 4096 字符）的
 * 起点落在**某对围栏内部** —— 窗口里那个 ``` 其实是**闭围栏**，只数窗口内奇偶
 * 就会读成「开围栏没关」。同一条会话里连错 4 次，四次的全文围栏数都是偶数
 * （2 / 14 / 4 / 8 个），全是窗口劈开代码块所致。
 *
 * @returns {string} 一份闭合的、但窗口内围栏数为奇数的报告。
 */
export function fenceStraddlingReport() {
  return (
    '先给结论。\n\n```js\n' + // 开围栏在位置 7 —— 必须落在判定窗口之外
    variedCodeLines(400) + // 足够长：把窗口起点推到闭围栏之前
    '\n```\n\n' + // 闭围栏落在判定窗口之内
    '以上是全部改动，测试都通过了。'
  )
}

/**
 * 造一份「多代码块的长报告」—— 真实助手回复最常见的形态。
 *
 * 它也刻意超过判定窗口（最后 4096 字符），因此和 {@link fenceStraddlingReport}
 * 一样是一道回归防线：窗口劈开代码块的 bug 一旦回来，这份样本会被误判。
 *
 * @returns {string} 一份闭合的、含 6 个代码块的长报告。
 */
export function multiBlockReport() {
  let text = '# 结论\n\n先说结论：改动很小，但边界条件补齐了。\n\n'
  for (let i = 1; i <= 6; i += 1) {
    text += '## 第 ' + i + ' 节\n\n这一节说明改动的内容与理由，以及它为什么不会影响其它路径。\n\n'
    text += '```js\n' + variedCodeLines(80) + '```\n\n'
  }
  return text + '以上是全部改动，测试都通过了。'
}

/**
 * 造一个假 agent（只保留插件会用到的字段）。
 *
 * @param {object} [opts] - `{ id, replace, content }`；replace/content 用来模拟压缩后的代数变化。
 * @returns {object} 假 agent。
 */
export function fakeAgent(opts = {}) {
  const steered = []
  const appended = []
  const surface = {
    replaceGeneration: opts.replace ?? 0,
    contentGeneration: opts.content ?? 0,
  }
  return {
    session: {
      id: opts.id ?? 'session-1',
      surface,
      /**
       * 记录「被直接写进会话历史」的消息。
       *
       * 与 steer 的区别：steer 是投进收件箱（要等下一步被领取才进历史），
       * append 是**立刻进历史** —— 熔断诊断走的就是这条路，为的是让紧接着
       * 那次重发一定能看到它。
       */
      append(kind, message, options) {
        appended.push({ kind, message, options })
      },
    },
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    presetServices: {},
    steered,
    appended,
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
