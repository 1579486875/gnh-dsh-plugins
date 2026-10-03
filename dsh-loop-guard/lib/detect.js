/**
 * dsh-loop-guard —— 纯检测内核。
 *
 * 本模块不依赖任何外部包、不产生副作用：所有函数都是纯函数，或只持有显式
 * 状态的轻量对象。因此它可以脱离 DSH 运行时被单独导入和测试。
 *
 * 阈值取向刻意偏保守：真正的循环会让账单指数级膨胀，而一次误熔断最多让
 * 用户重发一次请求。所以要求「足够长的输出 + 足够完整的周期 + 足够多的
 * 重复次数」，但不做可能让真循环溜过去的宽容式豁免。
 *
 * @module dsh-loop-guard/detect
 */

/** 字符级复读检测的默认参数。 */
export const REPEAT_DEFAULTS = Object.freeze({
  enabled: true,
  /** 输出累计到这么多字符后才开始判定，短回答完全不受影响。 */
  minChars: 4000,
  /** 每新增这么多字符才做一次检测（节流，避免逐 delta 计算）。 */
  checkEveryChars: 2000,
  /**
   * 保留的尾部窗口大小。
   *
   * 这个数字必须同时喂饱两条检测线：字符级最坏需要
   * maxPeriod × minRepeats = 256 × 12 = 3072 字符；行级最坏需要
   * maxPeriodLines × minRepeats = 24 × 5 = 120 行，按每行 60~100 字符算是
   * 7000~12000 字符。16384 给两者都留了余量，也让「18 行循环体重复 6 次」
   * 这种真实事故（约 6000 字符）完整落在窗口内。
   */
  windowChars: 16384,
  /** 循环体的最短长度：太短的周期容易和排版噪声混淆。 */
  minPeriod: 8,
  /** 循环体的最长长度。 */
  maxPeriod: 256,
  /** 循环体至少连续重复多少次才判定为复读。 */
  minRepeats: 12,
  /** 循环体内至少要有多少种不同字符（滤掉低信息量周期）。 */
  minPatternDistinct: 4,
  /**
   * 允许的末尾偏移上限（字符）。
   *
   * 流式输出很少恰好停在周期边界上：末尾可能是半句话、一个结束标记、或者被
   * 截断的残句。只认「末尾对齐」的周期会把这些情况全部漏掉 —— 所以从末尾
   * 往回尝试若干偏移再判定。这个偏移只放宽起点，不放宽「连续 N 段完全相同」
   * 的要求，因此不会明显抬高误报。
   */
  maxOffsetChars: 64,
})

/** 行级复读检测的默认参数：捕获循环体远超字符窗口的多行循环。 */
export const LINE_DEFAULTS = Object.freeze({
  enabled: true,
  /** 参与判定的最近非空行数：至少容纳 maxPeriodLines × minRepeats 并留余量。 */
  windowLines: 240,
  /**
   * 以「行」为单位的循环体最大行数。
   *
   * 取值与 windowChars 联动：24 × 5 = 120 行是判定门槛，必须能被 16384
   * 字符的窗口装下。真实事故里「十几行英文推理反复念」正好落在这个区间，
   * 而正常代码/文档里连续 5 次逐行完全相同的行块几乎不存在。
   */
  maxPeriodLines: 24,
  /** 同一个行块至少重复多少次。 */
  minRepeats: 5,
  /** 短于这个长度的行不参与判定（避免把空行、单括号当成循环体）。 */
  minLineChars: 4,
  /**
   * 允许的末尾偏移上限（行）。与 maxOffsetChars 同理，但按行计。
   *
   * 必须 ≥ maxPeriodLines - 1 才能覆盖全部相位：流式检查点落在周期的哪个
   * 位置是随机的，只覆盖前几行会让「周期 15 而检查点恰好偏 12 行」这类情况
   * 整个漏掉。行级比较很便宜（每轮至多多出千余次行比较），所以这里给足。
   */
  maxOffsetLines: 24,
})

/** 只含可打印 ASCII 的快速路径，用于跳过逐字符的宽窄判定。 */
const ASCII_ONLY = /^[\x20-\x7E\r\n\t]*$/

/**
 * 估算一段文本消耗的输出 token 数。
 *
 * 护栏用途的粗估，不追求与提供方分词器一致：宽字符（CJK、全角标点、假名、
 * 谚文）按 1 字符 1 token 计，窄字符按 4 字符 1 token 计。误差方向偏保守
 * （宁可高估），因为低估会让熔断来得太晚。
 *
 * @param {string} text - 增量文本。
 * @returns {number} 估算的 token 数；输入非字符串或为空时返回 0。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  if (ASCII_ONLY.test(text)) return Math.ceil(text.length / 4)
  let wide = 0
  let narrow = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp >= 0x2e80) wide += 1
    else narrow += 1
  }
  return wide + Math.ceil(narrow / 4)
}

/**
 * 统计一个字符串里出现了多少种不同字符。
 * @param {string} text - 待统计文本。
 * @returns {number} 不同字符的数量。
 */
export function distinctChars(text) {
  return new Set(text).size
}
/**
 * 判断 text 的末尾是否由某个固定周期重复而成。
 *
 * 从最短周期向外枚举：只要末尾 minRepeats 段完全一致，就认定找到周期。
 * 自然文本几乎总在第一个候选周期上失配，因此实际开销远低于最坏情况。
 *
 * @param {string} text - 待检测尾部文本。
 * @param {object} [opts] - 见 REPEAT_DEFAULTS。
 * @returns {number} 命中的周期长度；未命中返回 0。
 */
export function findRepeatingPeriod(text, opts = {}) {
  const cfg = { ...REPEAT_DEFAULTS, ...opts }
  const n = text.length
  if (n === 0) return 0

  for (let period = cfg.minPeriod; period <= cfg.maxPeriod; period += 1) {
    const needed = period * cfg.minRepeats
    if (needed > n) break
    // 末尾可能停在周期的任意位置，所以从末尾往回尝试若干偏移再判定。
    const maxOffset = Math.min(period - 1, cfg.maxOffsetChars, n - needed)
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const end = n - offset
      const pattern = text.slice(end - period, end)
      if (distinctChars(pattern) < cfg.minPatternDistinct) continue
      if (tailRepeats(text, end, period, cfg.minRepeats)) return period
    }
  }
  return 0
}

/**
 * 判断以 `from` 为终点、长度 period 的块，是否连续重复了 minRepeats 次。
 * @param {string} text - 待检测文本。
 * @param {number} from - 判定终点（末尾，或末尾往回偏移若干字符处）。
 * @param {number} period - 候选周期长度。
 * @param {number} minRepeats - 要求的最少重复次数。
 * @returns {boolean} 是否构成重复。
 */
function tailRepeats(text, from, period, minRepeats) {
  const pattern = text.slice(from - period, from)
  for (let k = 1; k < minRepeats; k += 1) {
    const end = from - period * k
    if (end - period < 0) return false
    if (text.slice(end - period, end) !== pattern) return false
  }
  return true
}

/**
 * 把文本切成参与行级判定的行：去空白、丢空行、丢过短行。
 * @param {string} text - 待切分文本。
 * @param {number} minLineChars - 行的最短有效长度。
 * @returns {string[]} 有效行数组。
 */
export function significantLines(text, minLineChars) {
  const out = []
  for (const raw of text.split(String.fromCharCode(10))) {
    const line = raw.trim()
    if (line.length >= minLineChars) out.push(line)
  }
  return out
}

/**
 * 在最近的行序列里寻找最小行周期。
 *
 * 这是字符级检测的补充：一个每行 200 字符、共 10 行的循环体远超 256 字符的
 * 字符窗口，但按行看只有 10 行的周期，同样会被抓住。
 *
 * @param {string[]} lines - 有效行序列。
 * @param {object} [opts] - 见 LINE_DEFAULTS。
 * @returns {{periodLines: number, repeats: number}|null} 命中信息；未命中返回 null。
 */
export function findRepeatingLineBlock(lines, opts = {}) {
  const cfg = { ...LINE_DEFAULTS, ...opts }
  const n = lines.length

  for (let period = 1; period <= cfg.maxPeriodLines; period += 1) {
    const needed = period * cfg.minRepeats
    if (needed > n) break
    // 末尾常常停在半行、半块或一句收尾语上（例如一个 "VERIFY-OK" 标记），
    // 只认末尾对齐会让这类循环整个漏掉 —— 从末尾往回尝试若干偏移再判定。
    const maxOffset = Math.min(period - 1, cfg.maxOffsetLines, n - needed)
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const end = n - offset
      const pattern = lines.slice(end - period, end)
      let repeats = 1
      let cursor = end - period
      while (cursor - period >= 0 && sameLines(lines, cursor - period, pattern)) {
        repeats += 1
        cursor -= period
      }
      if (repeats >= cfg.minRepeats) return { periodLines: period, repeats, offset }
    }
  }
  return null
}

/**
 * 比较 lines[start .. start+pattern.length) 是否与 pattern 逐行相等。
 * @param {string[]} lines - 行序列。
 * @param {number} start - 起始下标。
 * @param {string[]} pattern - 参照行块。
 * @returns {boolean} 是否相同。
 */
function sameLines(lines, start, pattern) {
  if (start < 0) return false
  for (let i = 0; i < pattern.length; i += 1) {
    if (lines[start + i] !== pattern[i]) return false
  }
  return true
}

/**
 * 在一个尾部缓冲上跑完整检测。
 * @param {string} tail - 尾部文本。
 * @param {object} repeatCfg - 字符级配置。
 * @param {object} lineCfg - 行级配置。
 * @returns {object|null} 命中描述；未命中返回 null。
 */
export function detectInTail(tail, repeatCfg, lineCfg) {
  if (repeatCfg.enabled) {
    const period = findRepeatingPeriod(tail, repeatCfg)
    if (period > 0) return { kind: 'char-period', period }
  }
  if (lineCfg.enabled) {
    const lines = significantLines(tail, lineCfg.minLineChars)
    if (lines.length >= lineCfg.minRepeats) {
      const hit = findRepeatingLineBlock(lines, lineCfg)
      if (hit !== null) {
        return {
          kind: 'line-period',
          periodLines: hit.periodLines,
          repeats: hit.repeats,
          offset: hit.offset,
        }
      }
    }
  }
  return null
}

/**
 * 创建一个带节流的增量复读检测器。
 *
 * push() 只做「追加缓冲 + 偶尔判定」，因此在每个 token 级 delta 上调用也很便宜。
 *
 * @param {object} [repeatOpts] - 字符级配置覆盖。
 * @param {object} [lineOpts] - 行级配置覆盖。
 * @returns {{push: Function, chars: Function, reset: Function}} 检测器。
 */
export function createRepeatDetector(repeatOpts, lineOpts) {
  const repeatCfg = { ...REPEAT_DEFAULTS, ...repeatOpts }
  const lineCfg = { ...LINE_DEFAULTS, ...lineOpts }
  const maxTail = Math.max(repeatCfg.windowChars, repeatCfg.maxPeriod * repeatCfg.minRepeats)

  let tail = ''
  let total = 0
  let lastCheck = 0
  let armed = false

  return {
    /**
     * 追加一段增量文本，必要时做一次判定。
     * @param {string} text - 增量文本。
     * @returns {object|null} 命中描述；未命中返回 null。
     */
    push(text) {
      if (typeof text !== 'string' || text.length === 0) return null
      total += text.length
      const combined = tail + text
      tail = combined.length > maxTail ? combined.slice(-maxTail) : combined

      if (!armed) {
        if (total < repeatCfg.minChars) return null
        armed = true
      } else if (total - lastCheck < repeatCfg.checkEveryChars) {
        return null
      }
      lastCheck = total
      return detectInTail(tail, repeatCfg, lineCfg)
    },
    /** @returns {number} 累计喂入的字符数。 */
    chars() {
      return total
    },
    /** 清空累计状态。 */
    reset() {
      tail = ''
      total = 0
      lastCheck = 0
      armed = false
    },
  }
}