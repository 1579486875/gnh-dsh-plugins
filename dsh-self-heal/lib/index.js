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
 *      —— **治好「没说完就停」**。两种情况都管：
 *         · 模型只输出了思考、没有输出任何给用户看的正文；
 *         · 模型说了一半就停（被长度上限截断 / 代码块没闭合 / 停在逗号上 /
 *           最后一句是「我先去确认一下 X」却没有下文）。
 *         命中后**先压缩上下文腾出空间，再补一句提醒**让它接着写 —— 因为
 *         说一半就停，多半就是上下文太满、没地方把话写完了。
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

import {
  LINE_DEFAULTS,
  REPEAT_DEFAULTS,
  SENTENCE_LOOP_DEFAULTS,
  TOOL_LOOP_DEFAULTS,
  UNFINISHED_DEFAULTS,
  createRepeatDetector,
  createSentenceLoopDetector,
  createToolLoopTracker,
  detectUnfinished,
} from './detect.js'

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
 *   2. 我们自己能凭这几个代码，在 `agent/request-error` 里一眼认出「这是我的
 *      熔断」，从而接管恢复流程。
 *
 * `repeat`（严格复读）与 `loop`（短句打转）走的是同一套恢复链路，分开只为
 * 了日志里能一眼看出是哪种毛病。
 */
export const CODES = Object.freeze({
  repeat: 'SELF_HEAL_REPEAT',
  loop: 'SELF_HEAL_LOOP',
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
    /**
     * 重发之前，把「你刚才为什么失败」写进会话告诉模型。
     *
     * 为什么值得做：重复坍缩是**近乎确定性的吸引子** —— 同样的上下文，会再次
     * 滑进同一个循环里。盲目重发（压完就重发）很可能原样再犯一次，只是白烧
     * 一遍 token。把病类说清楚、再给一句**定向指令**（「接着没写过的部分写」／
     * 「立刻执行你刚才说要做的动作」），才算是真的把它从吸引子里拽出来。
     *
     * 代价是一条百来字的 user 消息 —— 相比压缩省下来的空间可以忽略。
     */
    explainFailure: true,
    /**
     * 救不回来时，给用户留一句人话。
     *
     * 此时这一轮会以 `error` 结束，界面上原本只有一句技术错误
     * （「检测到短句打转（正文流）…」）。补一句「发生了什么 + 你可以怎么办」，
     * 用户才不至于对着一行异常发呆。
     */
    reportGiveUp: true,
  },
  /**
   * 「没说完就停」的补救。
   *
   * 两种表现合在一组配置里，因为它们本质是同一件事：
   *   · `silent`    —— 一个字没给用户看（只思考不说话）；
   *   · `truncated` —— 说了半截（被截断、代码块没闭合、停在逗号上）。
   * 提醒次数上限两者共享，用户只需要理解「同一轮最多提醒几次」。
   */
  unfinished: {
    enabled: true,
    /**
     * 命中后**先压缩上下文、再让它继续**。
     *
     * 为什么默认开：说一半就停，多半是上下文已经太满、模型没地方把话写完；
     * 不腾地方就催它继续，它往往再停一次。关掉就变成「直接催它继续」。
     * 注意压缩只是**腾地方的手段**：压缩服务不在、压缩报错、压缩没找到可压
     * 的区间时，都照常继续输出 —— 绝不能因为压不了就不救了。
     */
    compact: true,
    /** 情形一：只思考、没有正文。 */
    silent: true,
    /** 情形二：说了半截（截断 / 未闭合代码块 / 悬空标点）。 */
    truncated: true,
    /**
     * 情形二里最「软」的一条依据：最后一句是「我先去确认一下 X」这类承诺句式。
     * 它误报率相对高，怕吵可以单独关掉，其余判定不受影响。
     */
    promises: UNFINISHED_DEFAULTS.detectPromises,
    /** 同一轮对话里最多提醒几次（两种情形共享）。 */
    maxAttempts: 2,
    /** 记录的时效（毫秒）：超过这么久就不再据此干预，避免误伤下一轮。 */
    maxAgeMs: 300000,
    /** 判定用的尾部窗口（字符）；与检测内核的默认值保持同源，避免两处脱节。 */
    tailChars: UNFINISHED_DEFAULTS.tailChars,
    /**
     * 正文缓冲的大小（字符），必须 **大于** 判定窗口。
     *
     * 为什么不能直接用判定窗口：判定「代码块有没有闭合」要数 ``` 的奇偶，而
     * 数奇偶的前提是「从代码块之外开始数」。缓冲等于窗口时，窗口起点可能落在
     * 某个代码块内部，那个 ``` 其实是**闭围栏**，一数就把闭合的文档判成没写完
     * （真实事故：同一条会话连错 4 次）。
     *
     * 缓冲越长，能精确判定的正文越长；代价只是每轮多留几 KB 字符串。
     */
    bufferChars: UNFINISHED_DEFAULTS.bufferChars,
    /**
     * 提醒正文；会在会话里以一条 user 消息的形式出现。
     *
     * 文案刻意只说「怎么做」，不说「你被哪条规则判定为没写完」——后者是给
     * 日志看的，写进对话只会浪费 token 并干扰模型的注意力。
     */
    message:
      '[系统自动提醒] 你上一条消息停在中途：话没说完，也没有发起工具调用。' +
      '请接着上一条继续完成 —— 该调用工具的调用工具，该写完的继续写完；' +
      '不要重复已经写过的内容，也不要重新开始。',
    /**
     * 提醒次数用满、只能放行时，给用户留一句人话。
     *
     * 这时界面上是「模型说了半句就没下文了」——用户多半会以为是自己的问题。
     * 说明一句「我催过它，它没接着写」，比让用户对着半截回答发呆强。
     */
    reportGiveUp: true,
  },
  /**
   * 「短句打转」检测。
   *
   * 与 `repeat` / `lines` 的区别：那两条要求**严格重复**（同样的字符或同样的
   * 行块反复出现），只能抓「复读」。这里抓的是另一种失控 —— 同一批**超短句**
   * 反复出现，但每次措辞都略有不同，例如思考流里连着几百行：
   *
   *     好。
   *     行动。
   *     （调用。）
   *     NOW.
   *     我调用 write 工具。
   *     ……（嘴上一直说要调工具，始终没调）
   *
   * 严格周期在这里根本不存在，只能靠统计特征认（平均行长、短句密度、重复率
   * 三条同时成立）。判据细节与阈值来历见 `lib/detect.js` 第三部分。
   */
  loop: SENTENCE_LOOP_DEFAULTS,
  /**
   * 「工具调用打转」的提醒（动作层）。
   *
   * 与 DSH 自带的 `dsh-repeat-tool-reminder` 分工：它管「同一个工具、完全相同的
   * 参数连续调用 N 次」；这里管它覆盖不到的两种 —— 多工具形成的**环**
   * （A→B→C→A→B→C），以及参数**近似但不完全相同**的重复。
   *
   * **只提醒，不熔断**：动作层误判的代价比文本层更高 —— 一次误判会让模型丢掉
   * 正在推进的思路。所以这里只往下一步塞一句话，决策权仍然留给模型。
   */
  tools: {
    ...TOOL_LOOP_DEFAULTS,
    /**
     * 提醒正文；会作为**附加上下文**跟着工具结果一起交回给模型。
     *
     * 文案刻意只说「怎么做」：换办法，或者把卡点讲清楚 —— 这两条都能让它跳出
     * 原来的动作序列。
     */
    message:
      '[系统自动提醒] 你已经在重复同一套动作了（同样的几个工具、参数也几乎一样，已经走了好几遍）。' +
      '如果问题还没解决，说明这个思路走不通：请换一个办法，或者把当前卡在哪一步说清楚，不要再重复同样的调用。',
  },
})

/** 「说没说正文」记账表的最大条数（防止长期运行时无限增长）。 */
const MAX_ATTEMPT_ENTRIES = 512

/**
 * 「一次自愈算不算成功」的时间窗（毫秒）。
 *
 * 重发之后如果隔了太久才有下一次正常调用，中间多半夹了别的事情，说不清到底
 * 是不是这一救起了作用 —— 那种一律不算成功，宁可把成功率算低。
 */
const RECOVERY_WINDOW_MS = 600000

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
 * 把旧版配置名 `silentThought` 翻译成新版 `unfinished`。
 *
 * 背景：早期版本这一组叫 `silentThought`（只治「光想不说」），后来并入
 * `unfinished`（把「说了一半就停」也一起管）。老用户 profile 里如果还写着
 * 旧名字，这里照旧读进来，**不会因为改名而静默失效** —— 配置写错却不报错、
 * 悄悄退回默认值，是这类插件最难查的一类毛病。
 *
 * 只搬运两边都有的四个键；新版新增的 `compact` / `silent` / `truncated` /
 * `promises` 用新版默认值（旧版没有这些概念，而默认值就是当时的行为）。
 *
 * @param {object} raw - 原始配置。
 * @returns {object|undefined} 翻译后的覆盖值；用户没写旧配置时返回 undefined。
 */
function legacyUnfinished(raw) {
  const old = raw?.silentThought
  if (!isObject(old)) return undefined
  const out = {}
  if (typeof old.enabled === 'boolean') out.enabled = old.enabled
  if (typeof old.maxAttempts === 'number' && Number.isFinite(old.maxAttempts)) out.maxAttempts = old.maxAttempts
  if (typeof old.maxAgeMs === 'number' && Number.isFinite(old.maxAgeMs)) out.maxAgeMs = old.maxAgeMs
  if (typeof old.message === 'string' && old.message.trim() !== '') out.message = old.message
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
    unfinished: mergeConfig(
      DEFAULT_CONFIG.unfinished,
      isObject(raw.unfinished) ? raw.unfinished : legacyUnfinished(raw),
    ),
    repeat: mergeConfig(REPEAT_DEFAULTS, raw.repeat),
    loop: mergeConfig(SENTENCE_LOOP_DEFAULTS, raw.loop),
    tools: mergeConfig(DEFAULT_CONFIG.tools, raw.tools),
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
 * 造一个「只保留最近 N 个字符」的尾巴缓冲。
 *
 * 用途：一轮对话结束时，要看看正文的**尾巴**长什么样（是不是停在逗号上、
 * 代码块有没有闭合）。正文可能有几十万字，但我们只关心最后几千字。
 *
 * ⚠️ 为什么不用最直观的写法 `tail = (tail + text).slice(-N)`：
 * 那一句每次都要把整个窗口重新拼一遍、再复制一遍，而它会被**每个 token 级
 * 分片**调用 —— 一次 40 万字符的回答就是几万次复制。上一轮正是删掉同类写法
 * 之后，检测开销降到了原来的 1/29。
 *
 * 这里的做法是「先攒、后并」：
 *   · 每个小分片只 push 进数组（O(1)，不碰已有内容）；
 *   · 只有攒够一整个窗口的量（或者真的要读尾巴）时，才合并一次并截到窗口大小。
 * 于是合并次数从「每个分片一次」降到「每 N 个字符一次」，内存也有硬上限
 * （最多约 2 个窗口），长期运行不会慢慢涨。
 *
 * @param {number} limitChars - 窗口大小（字符）。传非法值时退回 4096。
 * @returns {{push: (text: string) => void, text: () => string, chars: () => number}} 缓冲对象。
 */
export function createTailBuffer(limitChars) {
  const limit =
    typeof limitChars === 'number' && Number.isFinite(limitChars) && limitChars > 0 ? Math.floor(limitChars) : 4096

  /** 还没合并的文本片段。 */
  let pieces = []
  /** 自上次合并以来新攒了多少个字符，用来决定什么时候值得合并一次。 */
  let pending = 0
  /** 累计被截掉的字符数。>0 意味着缓冲里已经不是「从头开始」的文本。 */
  let dropped = 0

  /**
   * 把数组里的片段合并成一段，只保留尾巴，并重置计数。
   * @returns {string} 合并后的尾部文本。
   */
  const compactNow = () => {
    pending = 0
    if (pieces.length === 0) return ''
    // 只有一段、而且没超过窗口：无需任何复制，直接用。
    if (pieces.length === 1 && pieces[0].length <= limit) return pieces[0]
    let joined = pieces.length === 1 ? pieces[0] : pieces.join('')
    if (joined.length > limit) {
      dropped += joined.length - limit
      joined = joined.slice(-limit)
    }
    pieces = [joined]
    return joined
  }

  return {
    /**
     * 追加一段增量文本。
     * @param {string} text - 增量文本；空串或非字符串会被忽略。
     * @returns {void}
     */
    push(text) {
      if (typeof text !== 'string' || text.length === 0) return
      pieces.push(text)
      pending += text.length
      // 攒够一个窗口才合并一次：既保证内存不涨，又把复制成本摊薄。
      if (pending >= limit) compactNow()
    },

    /**
     * 读出当前的尾部文本（最多 limit 个字符）。
     * @returns {string} 尾部文本。
     */
    text() {
      return compactNow()
    },

    /**
     * 当前缓冲里保存了多少个字符（只给诊断脚本用）。
     * @returns {number} 字符数。
     */
    chars() {
      let total = 0
      for (const piece of pieces) total += piece.length
      return total
    },

    /**
     * 累计被丢掉了多少个字符（缓冲装不下、从头截掉的量）。
     *
     * 用途只有一个但很关键：判定「代码块有没有闭合」必须从**确定位于代码块
     * 之外**的位置开始数围栏。返回值大于 0 就说明缓冲里已经不是从头开始的
     * 文本，那个前提不成立 —— 这时宁可漏判，也不能把闭围栏当成开围栏
     * （真实事故：窗口起点落在代码块内部，一份闭合的完整报告被判成「没写完」，
     * 同一条会话里连错 4 次）。
     *
     * @returns {number} 被丢弃的字符数；从未丢弃过则为 0。
     */
    droppedChars() {
      return dropped
    },
  }
}

/**
 * 结清一次悬着的自愈：这次调用正常走完了，说明那次重发确实救回来了。
 *
 * 为什么要单独立一个函数：**这是「自愈」这个词唯一可被证伪的依据**。
 * 没有它，我们只能看见「熔断了 12 次」，永远不知道其中几次真的救回来了 ——
 * 那「自愈」就只是一句自我表扬。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {object} runtime - 运行期共享状态。
 * @param {string} sessionId - 会话 id。
 * @returns {void}
 */
function settleRecovery(ctx, cfg, runtime, sessionId) {
  const pending = runtime.pending.get(sessionId)
  if (pending === undefined) return
  runtime.pending.delete(sessionId)

  // 太老的不算：中间可能已经夹了别的调用，说不清到底是谁救的。
  // 宁可少记一次成功（成功率偏保守），也不要记一次假成功。
  if (typeof pending.at === 'number' && Date.now() - pending.at > RECOVERY_WINDOW_MS) return

  runtime.stats.recovered += 1

  const { trips, retries, recovered } = runtime.stats
  const rate = retries === 0 ? 0 : Math.round((recovered / retries) * 100)
  logLine(
    ctx,
    cfg,
    'info',
    '自愈成功：重发之后这次没有再打转' +
      (typeof pending.code === 'string' ? '（上次是 ' + pending.code + '）' : '') +
      '。累计：熔断 ' + String(trips) + ' 次 / 重发 ' + String(retries) +
      ' 次 / 救回 ' + String(recovered) + ' 次（成功率 ' + String(rate) + '%）。',
  )
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
 * @param {object} runtime - 运行期共享状态（记账表 / 待验证的自愈 / 统计）。
 * @param {object} options - GenerateOptions（本次请求的全部参数）。
 * @param {AsyncIterable<object>} source - 上游流。
 * @returns {AsyncIterable<object>} 受保护、并在正常结束时记账的流。
 */
async function* healStream(ctx, cfg, runtime, options, source) {
  const attempts = runtime.attempts
  const startedAt = Date.now()
  // 思考流与正文流各自独立计数，理由见上面第 1 点。
  // 每条流上挂两条检测线：严格复读（字符级 / 行级）+ 短句打转。
  const makeDetectors = () => ({
    repeat: createRepeatDetector(cfg.repeat, cfg.lines),
    loop: createSentenceLoopDetector(cfg.loop),
  })
  const detectors = new Map([
    ['text-delta', makeDetectors()],
    ['reasoning-delta', makeDetectors()],
  ])
  const iterator = source[Symbol.asyncIterator]()

  /** 本次调用「说没说正文 / 干没干活」，供一轮结束时判断是否补救。 */
  const visibility = { hasText: false, hasToolCall: false }

  /**
   * 正文的尾部缓冲，供「是不是说了一半」的判定使用。
   *
   * 只收正文（`text-delta`），**不收思考内容**：用户看不到思考，思考写到一半
   * 不算「没说完」。补救功能关掉时连缓冲都不建，一分钱开销都不花。
   */
  const collectTail = cfg.unfinished.enabled === true
  const tailBuffer = collectTail ? createTailBuffer(bufferCharsOf(cfg)) : null

  /** 这次流是怎么结束的（`stop` / `max-tokens` / `error` …），取自末尾的 finish 分片。 */
  let finishKind

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
      // 只把正文喂给尾部缓冲；思考内容不参与「说没说完」的判定。
      if (tailBuffer !== null && isObject(chunk) && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        tailBuffer.push(chunk.text)
      }

      // 原样放行，再判定。
      yield chunk

      if (isObject(chunk) && chunk.type === 'finish') {
        upstreamDrained = true
        // 记下「这次是怎么结束的」：被长度上限截断时，补救要靠它认出来。
        const reason = chunk.reason
        finishKind = isObject(reason) && typeof reason.kind === 'string' ? reason.kind : undefined
        break
      }

      if (text !== null) {
        const bucket = detectors.get(chunk.type)
        if (bucket !== undefined) {
          const where = chunk.type === 'reasoning-delta' ? '思考流' : '正文流'

          // 第一道：严格复读 —— 同样的字符或同样的行块反复出现。
          const hit = bucket.repeat.push(text)
          if (hit !== null) {
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

          // 第二道：短句打转 —— 措辞每次都略变，但翻来覆去就是那几句超短句。
          const loopHit = bucket.loop.push(text)
          if (loopHit !== null) {
            trip = {
              code: CODES.loop,
              message: '检测到短句打转（' + where + '）：同一批超短句反复出现，判定为卡住。',
              detail:
                '(' + String(loopHit.short) + ' 个短句里有 ' + String(loopHit.repeated) +
                ' 个是重复句，最高频「' + loopHit.top + '」×' + String(loopHit.topCount) + ')',
            }
            break
          }
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
        // 下面两项供「说了一半就停」的判定使用（一轮结束时才读）。
        finishKind,
        tailText: tailBuffer === null ? '' : tailBuffer.text(),
        // 缓冲装不下时前面已被丢弃 —— 围栏配对的前提（从头数起）不成立，如实标记。
        bufferTruncated: tailBuffer !== null && tailBuffer.droppedChars() > 0,
      })
      // 这次调用正常走完了 —— 如果它是一次熔断之后的「重发」，那一次自愈就算成功。
      settleRecovery(ctx, cfg, runtime, sessionId)
    }
  }

  if (trip !== null) {
    runtime.stats.trips += 1
    // 又熔断了：上一次那笔「等着看这次行不行」作废 —— 它显然没被救回来。
    // 少了这一步，后面某次正常调用会替它结账，成功率就成了假的。
    const trippedId = options?.sessionId
    if (typeof trippedId === 'string') runtime.pending.delete(trippedId)
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
 * 本插件的全部熔断代码。
 *
 * 直接由 {@link CODES} 派生：以后新增一种熔断只要往 CODES 里加一项，
 * 下面的判断会自动跟上 —— 少写一处就会「熔断了却没人接手恢复」，很难查。
 */
const TRIP_CODES = new Set(Object.values(CODES))

/**
 * 判断一次失败是不是「本插件给出的熔断」。
 * @param {unknown} failure - 失败信息。
 * @returns {boolean} 是否为本插件的熔断 code。
 */
function isSelfHealTrip(failure) {
  if (!isObject(failure)) return false
  return TRIP_CODES.has(failure.code)
}

/**
 * 记下「压缩之前」的历史版本号。
 *
 * 会话历史被压缩成摘要时 `replaceGeneration` 会前进；工具结果被剪枝时
 * `contentGeneration` 会前进。压缩前后各取一次，就能知道它到底有没有干活 ——
 * 这是判断「这次压缩值不值得继续」的唯一依据。
 *
 * @param {object} surface - 会话的 surface 对象（`agent.session.surface`）。
 * @returns {{replace: number|undefined, content: number|undefined}} 版本号快照。
 */
function historyMark(surface) {
  return {
    replace: isObject(surface) ? surface.replaceGeneration : undefined,
    content: isObject(surface) ? surface.contentGeneration : undefined,
  }
}

/**
 * 压缩有没有真的让历史发生变化（被替换成摘要，或工具结果被剪枝）。
 *
 * 两个版本号任何一个前进都算「有进展」：都意味着下一次请求会比原来小。
 *
 * @param {object} surface - 会话的 surface 对象。
 * @param {{replace: number|undefined, content: number|undefined}} mark - 压缩前的快照。
 * @returns {boolean} 历史是否发生了变化。
 */
function historyChanged(surface, mark) {
  if (!isObject(surface) || !isObject(mark)) return false
  const replaced = typeof mark.replace === 'number' && surface.replaceGeneration > mark.replace
  const shrunk = typeof mark.content === 'number' && surface.contentGeneration > mark.content
  return replaced || shrunk
}

/**
 * 熔断诊断文案：按「刚才出了什么毛病」给模型一句可执行的指令。
 *
 * 每一条都刻意包含两件事：**发生了什么** + **接下来具体怎么做**。
 * 只说「你复读了」没有用 —— 模型需要知道的是往哪个方向改。
 *
 * 导出它是为了让测试能钉住「每个熔断 code 都必须有文案」—— 以后新增一种
 * 熔断却忘了写文案，会导致重发退化成盲目重试，而这种退化在运行时是静默的。
 */
export const DIAGNOSIS_MESSAGES = Object.freeze({
  [CODES.repeat]:
    '[系统自动提醒] 你刚才陷入了复读：同一段内容被反复写了很多遍。系统已中断那次输出，并把上文压缩过了。' +
    '请接着往下写还没写过的部分 —— 不要重复已经出现过的内容，也不要从头重来。',
  [CODES.loop]:
    '[系统自动提醒] 你刚才卡在了「反复复述同一批短句」上（例如一直说要去调用工具，却始终没有真的调用）。' +
    '请立刻执行你刚才说过要做的那个动作：该调用工具就直接调用，不要再用文字描述计划，也不要重复已经说过的话。',
  [CODES.timeout]:
    '[系统自动提醒] 上一次输出耗时过长，被判定为失控并中断了。系统已压缩上文。' +
    '请直接给出结论或下一步动作，不要再展开长篇推演。',
})

/**
 * 把一条提醒**直接写进会话历史**（而不是投进收件箱）。
 *
 * 为什么不用 `agent.steer`：steer 只是把消息放进收件箱，要等下一步被领取才会
 * 进入历史；而我们的目的是让**紧接着那次重发**就能看到它。直接写进 surface，
 * 重发时重建请求必然带上它。
 *
 * @param {object} agent - 目标 agent。
 * @param {object} message - 已冻结的消息（见 {@link createNoticeMessage}）。
 * @returns {boolean} 是否写入成功。
 */
function appendToHistory(agent, message) {
  const session = agent?.session
  if (!isObject(session) || typeof session.append !== 'function') return false
  session.append('user/message', message, { surfaceOp: 'append' })
  return true
}

/**
 * 熔断 code → 给用户看的中文说法。
 *
 * 界面上不该出现 `SELF_HEAL_LOOP` 这种东西 —— 用户需要知道的是「出了什么事」。
 */
const TRIP_LABELS = Object.freeze({
  [CODES.repeat]: '复读（同一段内容被反复写）',
  [CODES.loop]: '短句打转（反复复述同一批短句）',
  [CODES.timeout]: '超时（一次输出迟迟不结束）',
})

/**
 * 往会话历史里写一条本插件的说明消息。
 *
 * 所有「写消息」的动作都走这里，好处是失败处理只有一处：写不进去就记一行日志、
 * 返回 false，**绝不让说明消息本身把主流程带崩**。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {object} agent - 目标 agent。
 * @param {string} text - 说明正文。
 * @param {string} summary - 一句话摘要。
 * @returns {boolean} 是否写入成功。
 */
function appendNotice(ctx, cfg, agent, text, summary) {
  try {
    return appendToHistory(agent, createNoticeMessage(text, summary))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logLine(ctx, cfg, 'warn', '写说明消息失败（' + message + '），照常继续。')
    return false
  }
}

/**
 * 熔断救不回来时，给用户留一句人话。
 *
 * 为什么需要：放弃之后这一轮会以 `error` 结束，界面上原本只有一句技术错误
 * （「检测到短句打转（正文流）…」）。用户需要的是「发生了什么 + 我能做什么」。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {object} agent - 目标 agent。
 * @param {number} attempts - 一共救了几次。
 * @param {unknown} failure - 最后一次的失败信息。
 * @returns {boolean} 是否写入成功。
 */
function reportTripGiveUp(ctx, cfg, agent, attempts, failure) {
  if (cfg.recover.reportGiveUp !== true) return false
  const why = isObject(failure) && typeof failure.code === 'string' ? TRIP_LABELS[failure.code] : undefined
  const text =
    '（失控自愈）模型连续 ' + String(attempts) + ' 次陷入' + (why ?? '失控') +
    '，已停止本次输出。可以试试把任务拆小一点，或者换个说法再问一次 —— ' +
    '重复问同样的问题，很可能还会卡在同一处。'
  return appendNotice(ctx, cfg, agent, text, '自愈放弃：给用户的说明')
}

/**
 * 「没说完就停」催不动时，给用户留一句人话。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {object} agent - 目标 agent。
 * @param {number} attempts - 一共提醒了几次。
 * @returns {boolean} 是否写入成功。
 */
function reportUnfinishedGiveUp(ctx, cfg, agent, attempts) {
  if (cfg.unfinished.reportGiveUp !== true) return false
  const text =
    '（失控自愈）模型连续 ' + String(attempts) + ' 次没把话说完，已放行本次结束。' +
    '可以回一句「继续」让它接着写，或者把问题拆小一点再问。'
  return appendNotice(ctx, cfg, agent, text, '未完成补救放弃：给用户的说明')
}

/**
 * 把「刚才为什么失败」告诉模型，让这次重发不是盲目的。
 *
 * 任何一步失败都只是「这次不带诊断」，绝不影响重发本身 —— 诊断是锦上添花，
 * 不能让它的异常把恢复链路带崩。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {object} agent - 目标 agent。
 * @param {unknown} failure - 失败信息（含本插件的熔断 code）。
 * @returns {boolean} 是否成功写入了诊断。
 */
function explainFailure(ctx, cfg, agent, failure) {
  if (cfg.recover.explainFailure !== true) return false
  const text = isObject(failure) ? DIAGNOSIS_MESSAGES[failure.code] : undefined
  if (typeof text !== 'string') return false
  return appendNotice(ctx, cfg, agent, text, '熔断诊断：告诉模型刚才发生了什么')
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
function installRunawayRecovery(ctx, cfg, runtime) {
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
        // 到此为止了：这一轮会以 error 结束，给用户留一句人话再走。
        reportTripGiveUp(ctx, cfg, agent, already, payload?.failure)
        return next()
      }

      const mark = historyMark(surface)

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
      // 两者都让下一次请求变小，都值得重发。判据本身在 historyChanged 里，
      // 与「没说完就继续」那条链路共用，避免两处各写一份、日后改歪一处。
      const progressed = historyChanged(surface, mark)

      if (!progressed && cfg.recover.retryWithoutCompaction !== true) {
        logLine(ctx, cfg, 'warn', '压缩没有让历史变短，按配置不再重试。')
        return next()
      }

      // ★ 把「刚才为什么失败」写进历史，让这次重发不盲目。
      //   顺序刻意放在压缩**之后**：这样诊断不会被这次压缩顺手摘要掉，
      //   紧接着的那次重发一定看得到它。
      const explained = explainFailure(ctx, cfg, agent, payload?.failure)

      used.set(agent, { turn, count: already + 1 })

      // 记一笔「等着看这次行不行」：下一次调用**正常走完**就算救回来了。
      // 这是「自愈成功率」唯一的数据来源 —— 没有它，我们只能看见熔断了几次，
      // 永远不知道到底救回来几次。
      runtime.stats.retries += 1
      const sessionId = agent?.session?.id
      if (typeof sessionId === 'string') {
        runtime.pending.set(sessionId, {
          code: isObject(payload?.failure) ? payload.failure.code : undefined,
          at: Date.now(),
        })
      }

      logLine(
        ctx,
        cfg,
        'info',
        '已从熔断中恢复：' +
          (progressed ? '历史已压缩，' : '历史没有可压缩的区间，') +
          (explained ? '已把失败原因告诉模型，' : '') +
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
 * 算出正文缓冲该留多长。
 *
 * 两个约束：① 不短于判定窗口 —— 否则窗口取不满，悬空标点与承诺句式两条判据
 * 会退化；② 尽量长 —— 围栏配对要从代码块之外数起（见配置里 `bufferChars`
 * 的说明）。用户把两个值配反了也不会出问题，这里取较大者兜住。
 *
 * @param {object} cfg - 生效配置。
 * @returns {number} 缓冲字符数。
 */
export function bufferCharsOf(cfg) {
  const pick = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  const window = pick(cfg?.unfinished?.tailChars, UNFINISHED_DEFAULTS.tailChars)
  const want = pick(cfg?.unfinished?.bufferChars, UNFINISHED_DEFAULTS.bufferChars)
  return Math.max(want, window)
}

/**
 * 判断「这一次调用算不算没说完」。返回 null 表示正常收尾，不用管。
 *
 * 顺序很重要，从「明确」排到「含糊」：
 *   1. 有工具调用   → 它在干活，只是还没轮到输出正文，不管；
 *   2. 一个字没说   → 光想不说（受 `silent` 开关控制）；
 *   3. 说了半截     → 交给检测内核判定（受 `truncated` / `promises` 开关控制）。
 *
 * @param {object} info - 本次调用的记账（见 {@link healStream}）。
 * @param {object} cfg - 生效配置。
 * @returns {{kind: string, detail: string}|null} 命中描述；正常收尾返回 null。
 */
function unfinishedOf(info, cfg) {
  // 正在调工具：这是正常的「先干活，稍后再汇报」，不能打断。
  if (info.hasToolCall === true) return null

  // 情形一：一个字都没给用户看。
  if (info.hasText !== true) {
    if (cfg.unfinished.silent !== true) return null
    return { kind: 'no-content', detail: '只产生了思考内容，没有输出任何给用户看的正文' }
  }

  // 情形二：说了半截。判据放在纯函数里（便于单测），两个开关一并传进去。
  if (cfg.unfinished.truncated !== true) return null
  const hit = detectUnfinished(info.finishKind, info.tailText, {
    tailChars: cfg.unfinished.tailChars,
    detectPromises: cfg.unfinished.promises,
    // 缓冲被截断时「开头在不在代码块里」就无从得知，围栏判据必须让位。
    bufferTruncated: info.bufferTruncated === true,
  })
  if (hit === null) return null
  return { kind: hit.reason, detail: hit.detail }
}

/**
 * 命中「没说完」之后，先想办法给上下文腾地方。
 *
 * 为什么先压缩再继续：说一半就停，多半是上下文已经太满、模型没地方把话写完；
 * 不腾地方就催它继续，它往往再停一次。这与「熔断之后先压缩再重发」是同一个
 * 套路，两处的判据也共用 {@link historyChanged}。
 *
 * ⚠️ 但压缩只是**腾地方的手段，不是继续输出的前提**：压缩服务不在、压缩报错、
 * 压缩找不到可压的区间，这三种情况都照常往下走（各自返回一句说明供日志记录）。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {object} agent - 目标 agent。
 * @param {AbortSignal|undefined} signal - 本轮的中断信号。
 * @param {number} already - 本轮此前已经提醒过几次（第 2 次起不再压缩）。
 * @returns {Promise<string>} 一句话说明这次压缩的结果，写进日志用。
 */
async function compactBeforeContinue(ctx, cfg, agent, signal, already) {
  if (cfg.unfinished.compact !== true) return '未开启压缩（compact=false），直接继续'
  // 同一轮里第二次命中就不再压了：连着压会把上下文越压越薄，得不偿失。
  if (already > 0) return '本轮已经压缩过一次，直接继续'

  const compaction = compactionFor(ctx, agent)
  if (compaction === undefined) return '找不到压缩服务，直接继续'

  const surface = agent?.session?.surface
  const mark = historyMark(surface)
  try {
    await compaction.compactIfNeeded(agent, 'context-overflow', signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return '压缩失败（' + message + '），直接继续'
  }
  return historyChanged(surface, mark) ? '已压缩上下文（历史已变短）' : '压缩过，但这次没有可压缩的区间'
}

/**
 * 安装「没说完就继续」的补救，挂在 `agent/turn-stopping` 上。
 *
 * 时机正好：这个事件在一轮对话即将结束、且模型已经不欠任何工具调用时触发。
 * 此时如果最近这次调用「一个字没说」或者「说了一半就停」，用户就只能自己再
 * 补一句「继续」—— 本函数替他补。完整动作是：
 *
 *   先压缩上下文腾地方 → 再投一条提醒（steering）→ 这一轮会再跑一步。
 *
 * ⚠️ 这个事件是**顺序派发**的，派发方会 `await` 处理器返回的 Promise，所以本
 * 函数写成 async 并 await 压缩：压缩没做完，这一轮就不会急着结束 —— 正是我们
 * 想要的效果，否则提醒会在压缩之前落到历史里，等于白压。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @param {Map<string, object>} attempts - 「这次调用输出了什么」的记账表。
 * @returns {void}
 */
function installUnfinishedRescue(ctx, cfg, runtime) {
  const attempts = runtime.attempts
  /** agent → 本轮已提醒次数。 */
  const strikes = new WeakMap()

  ctx.on('agent/turn-stopping', async (payload) => {
    if (cfg.unfinished.enabled !== true) return
    try {
      const agent = payload?.agent
      const turn = payload?.turn
      // 载荷异常（理论上不会发生）时什么都不做，绝不抛错打断对话。
      if (!isObject(agent)) return
      const info = attemptOf(attempts, agent)
      if (info === undefined) return
      // 记录太老说明它已经不是「刚刚这次」的结果，宁可不干预也不误伤。
      if (typeof info.at !== 'number' || Date.now() - info.at > cfg.unfinished.maxAgeMs) return

      const hit = unfinishedOf(info, cfg)
      if (hit === null) return

      const state = strikes.get(agent)
      const already = state !== undefined && state.turn === turn ? state.count : 0
      if (already >= cfg.unfinished.maxAttempts) {
        logLine(
          ctx,
          cfg,
          'warn',
          '模型连续没把话说完（判定依据 ' + hit.kind + '），已达到提醒上限，放行结束本轮。',
        )
        // 催不动了：这一轮会「正常结束」在半截话上，给用户留一句人话。
        reportUnfinishedGiveUp(ctx, cfg, agent, already)
        return
      }
      strikes.set(agent, { turn, count: already + 1 })

      // ★ 先压缩、再继续（为什么这么排，见 compactBeforeContinue 的说明）。
      const compactNote = await compactBeforeContinue(ctx, cfg, agent, payload?.signal, already)
      // 压缩期间用户可能已经按了停止：那就什么都别做了。
      if (payload?.signal?.aborted === true) return

      // 用掉这条记录：提醒之后会再跑一步，新的调用会重新记账。
      attempts.delete(agent.session.id)
      agent.steer(createNoticeMessage(cfg.unfinished.message, '输出未完成，要求接着写完'))
      logLine(
        ctx,
        cfg,
        'info',
        '本轮输出未完成（' +
          hit.detail +
          '）：' +
          compactNote +
          '，已注入提醒要求接着写完（本轮第 ' +
          String(already + 1) +
          ' 次）。',
      )
    } catch (error) {
      // 补救失败就算了：绝不能让「让它把话说完」这件事本身打断对话。
      const message = error instanceof Error ? error.message : String(error)
      logLine(ctx, cfg, 'warn', '未完成补救失败（' + message + '），本轮照常结束。')
    }
  })
}

/**
 * 安装「工具调用打转」的提醒，挂在 `tools/post-execute` 上。
 *
 * 为什么挂在这里而不是 steer：工具刚执行完，把这条提醒作为**附加上下文**交给
 * 下一步，模型的下一次请求就会看到它 —— 这正是 DSH 自带 `dsh-repeat-tool-reminder`
 * 用的机制（我们与它**同一机制、不同判据**），而且比 steer 更贴合时机。
 *
 * ⚠️ 只提醒、不熔断：动作层误判的代价比文本层更高，一次误判会让模型丢掉正在
 * 推进的思路。所以这里只往上下文里塞一句话，怎么走仍然由模型决定。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 生效配置。
 * @returns {void}
 */
function installToolLoopRescue(ctx, cfg) {
  /** agent → 追踪器。用 WeakMap：agent 被回收时记录自动消失。 */
  const trackers = new WeakMap()

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    // 先让下游把这一环走完，再决定要不要往里加东西 —— 绝不改写别人的语义。
    const downstream = await next()
    if (cfg.tools.enabled !== true) return downstream
    try {
      const agent = exec?.agent
      if (!isObject(agent)) return downstream

      let tracker = trackers.get(agent)
      if (tracker === undefined) {
        tracker = createToolLoopTracker(cfg.tools)
        trackers.set(agent, tracker)
      }

      const hit = tracker.push({ tool: exec.name, args: exec.arguments })
      if (hit === null) return downstream

      const notice = createNoticeMessage(
        cfg.tools.message,
        '工具调用打转：' + hit.cycle.join(' → ') + ' × ' + String(hit.repeats),
      )
      logLine(
        ctx,
        cfg,
        'info',
        '工具调用打转：' + hit.cycle.join(' → ') + ' 已重复 ' + String(hit.repeats) + ' 遍，已注入提醒。',
      )

      // 原样保持下游返回值的形状：block 分支要把 feedback 一起带上。
      const existing = Array.isArray(downstream?.additionalContexts) ? downstream.additionalContexts : []
      const merged = [notice, ...existing]
      if (downstream?.kind === 'block') {
        return { kind: 'block', feedback: downstream.feedback, additionalContexts: merged }
      }
      return isObject(downstream) ? { ...downstream, additionalContexts: merged } : { additionalContexts: merged }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logLine(ctx, cfg, 'warn', '工具打转提醒失败（' + message + '），照常继续。')
      return downstream
    }
  })

  // 用户插了新话 → 这是一次新的意图，历史清零，别拿旧账判它。
  // （我们自己的提醒 source.kind 是 'self-heal'，不会被误当成用户消息。）
  ctx.on('agent/pre-step', (payload, next) => {
    const agent = payload?.agent
    const messages = payload?.messages
    if (isObject(agent) && Array.isArray(messages) && messages.some((message) => message?.source?.kind === 'user')) {
      const tracker = trackers.get(agent)
      if (tracker !== undefined) tracker.reset()
    }
    return next()
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

  /**
   * 运行期共享状态。
   *
   * 打包成一个对象在几条链路之间传，而不是散着传三四个 Map —— 否则每加一项
   * 统计就要改一圈函数签名，容易漏改。
   */
  const runtime = {
    /** 「最近一次普通对话调用说没说正文」，按 sessionId 记账。 */
    attempts: new Map(),
    /** 「刚重发过、等着看这次行不行」：sessionId → { code, at }。 */
    pending: new Map(),
    /** 跨会话累计的介入统计 —— 自愈成功率的唯一来源。 */
    stats: { trips: 0, retries: 0, recovered: 0 },
  }

  ctx.on(
    'llm/stream',
    (options, next) => {
      const source = next()
      // 不是异步可迭代对象（下游没给流）就原样透传，绝不改写别人的返回值。
      if (!isObject(source) || typeof source[Symbol.asyncIterator] !== 'function') return source
      return healStream(ctx, cfg, runtime, options, source)
    },
    { global: true },
  )

  installRunawayRecovery(ctx, cfg, runtime)
  installUnfinishedRescue(ctx, cfg, runtime)
  installToolLoopRescue(ctx, cfg)

  logLine(
    ctx,
    cfg,
    'info',
    '自愈已就位（墙钟上限 ' +
      (cfg.maxDurationMs > 0 ? String(Math.round(cfg.maxDurationMs / 1000)) + 's' : '关') +
      '，复读检测 ' +
      (cfg.repeat.enabled || cfg.lines.enabled ? '开' : '关') +
      '，短句打转检测 ' +
      (cfg.loop.enabled ? '开' : '关') +
      '，工具调用打转提醒 ' +
      (cfg.tools.enabled ? '开' : '关') +
      '，熔断后压缩并重试 ' +
      (cfg.recover.enabled ? '开' : '关') +
      '，没说完就继续的补救 ' +
      (cfg.unfinished.enabled ? '开（' + (cfg.unfinished.compact ? '命中后先压缩、再继续' : '直接继续') + '）' : '关') +
      '）。',
  )
}
