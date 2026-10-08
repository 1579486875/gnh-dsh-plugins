/**
 * dsh-self-heal —— 纯检测内核（复读识别）。
 *
 * 这个文件只做一件事：**在一段文本的尾部，判断模型是不是在「原地打转」**。
 * 它不联网、不依赖 DSH 运行时、不产生副作用 —— 所有函数都是纯函数，或者只
 * 持有自己内部状态的轻量对象。因此可以脱离 DSH 单独导入、单独测试。
 *
 * 为什么要专门做这件事：
 *   模型一旦陷入推理循环，会一直吐字、永不空闲，于是「流空闲超时」永远不会
 *   触发；它每秒钟都在产生真实的输出 token，账单会指数级膨胀。唯一能在早期
 *   识别的特征就是——**尾部开始出现稳定的重复周期**。
 *
 * 阈值的取向刻意偏保守：
 *   真正的循环会让账单失控，而一次误判最多让用户重发一次请求。所以要求
 *   「足够长的输出 + 足够完整的周期 + 足够多的重复次数」，宁可晚一点发现，
 *   也不要打断正常的排版重复（例如表格线、代码缩进）。
 *
 * @module dsh-self-heal/detect
 */

/**
 * 字符级复读检测的默认参数。
 *
 * 「字符级」指：把输出当成一串字符，看末尾是不是某个固定长度的片段反复出现。
 * 它抓的是「同一句话反复念」这种短周期循环。
 */
export const REPEAT_DEFAULTS = Object.freeze({
  enabled: true,
  /** 输出累计到这么多字符后才开始判定；短回答完全不受影响。 */
  minChars: 4000,
  /** 每新增这么多字符才做一次检测（节流）。检测本身不贵，但没必要每个字都算。 */
  checkEveryChars: 2000,
  /**
   * 保留的尾部窗口大小（字符）。
   *
   * 这个数字必须同时喂饱两条检测线：
   *   字符级最坏需要 maxPeriod × minRepeats = 256 × 12 = 3072 字符；
   *   行级最坏需要 maxPeriodLines × minRepeats = 24 × 5 = 120 行，按每行
   *   60~100 字符算是 7000~12000 字符。
   * 16384 给两者都留了余量，也让「18 行循环体重复 6 次」这种真实事故
   * （约 6000 字符）完整落在窗口内。
   */
  windowChars: 16384,
  /** 循环体的最短长度：太短的周期容易和正常的排版噪声混淆。 */
  minPeriod: 8,
  /** 循环体的最长长度。 */
  maxPeriod: 256,
  /** 循环体至少连续重复多少次才判定为复读。 */
  minRepeats: 12,
  /** 循环体内至少要有多少种不同字符（滤掉「=====」这种低信息量周期）。 */
  minPatternDistinct: 4,
  /**
   * 允许的末尾偏移上限（字符）。
   *
   * 流式输出很少恰好停在周期边界上：末尾可能是半句话、一个结束标记、或者被
   * 截断的残句。只认「末尾正好对齐」的周期会把这些情况全部漏掉 —— 所以从末尾
   * 往回尝试若干偏移再判定。这个偏移只放宽起点，不放宽「连续 N 段完全相同」
   * 的要求，因此不会明显抬高误报。
   */
  maxOffsetChars: 64,
})

/**
 * 行级复读检测的默认参数。
 *
 * 「行级」指：先按行切开，再看末尾是不是某个「行块」反复出现。它抓的是那种
 * 循环体很长（几十行、远超 256 字符）的多行循环 —— 单靠字符级抓不到。
 */
export const LINE_DEFAULTS = Object.freeze({
  enabled: true,
  /** 参与判定的最近非空行数：至少容纳 maxPeriodLines × minRepeats 并留余量。 */
  windowLines: 240,
  /**
   * 以「行」为单位的循环体最大行数。
   *
   * 取值与 windowChars 联动：24 × 5 = 120 行是判定门槛，必须能被 16384 字符
   * 的窗口装下。真实事故里「十几行英文推理反复念」正好落在这个区间，而正常
   * 代码或文档里连续 5 次逐行完全相同的行块几乎不存在。
   */
  maxPeriodLines: 24,
  /** 同一个行块至少重复多少次。 */
  minRepeats: 5,
  /** 短于这个长度的行不参与判定（避免把空行、单个括号当成循环体）。 */
  minLineChars: 4,
  /**
   * 允许的末尾偏移上限（行）。与 maxOffsetChars 同理，但按行计。
   *
   * 必须 ≥ maxPeriodLines - 1 才能覆盖全部相位：流式检查点落在周期的哪个位置
   * 是随机的，只覆盖前几行会让「周期 15 但检查点恰好偏 12 行」这类情况整个
   * 漏掉。行级比较很便宜（每轮至多多出千余次行比较），所以这里给足。
   */
  maxOffsetLines: 24,
})

/**
 * 统计一个字符串里出现了多少种不同字符。
 *
 * 用途：排除「xxxxxxxx…」这类低信息量周期。它们虽然确实在重复，但更可能是
 * 分隔线、缩进或进度条，不值得因此打断一次回答。
 *
 * @param {string} text - 待统计文本。
 * @returns {number} 不同字符的数量。
 */
export function distinctChars(text) {
  return new Set(text).size
}

/**
 * 判断 `text[start, end)` 这一段里是否至少有 `need` 种不同字符。
 *
 * 为什么不用 `distinctChars(text.slice(...))`：那样每次都要建一个集合、把整个
 * 片段哈希一遍。而这段代码在一次判定里会被调用上千次 —— 实测正是它吃掉了
 * 单次检测 2.9 毫秒里的绝大部分。这里改成「够数就立刻收工」的写法：正常文本
 * 往往前几个字符就凑齐了不同的字符，于是成本降到常数级。
 *
 * 语义与 `distinctChars(...) >= need` 完全等价（没有任何近似）。
 *
 * @param {string} text - 源字符串（不切片，直接按下标读）。
 * @param {number} start - 起始下标（含）。
 * @param {number} end - 结束下标（不含）。
 * @param {number} need - 需要凑够的不同字符数。
 * @returns {boolean} 是否达标。
 */
function hasVariety(text, start, end, need) {
  let found = 0
  // 最多只需要记住 need 个字符，用一个定长小数组即可，不分配集合。
  const seen = new Array(need)
  for (let i = start; i < end; i += 1) {
    if (found >= need) return true
    const code = text.charCodeAt(i)
    let isNew = true
    for (let k = 0; k < found; k += 1) {
      if (seen[k] === code) {
        isNew = false
        break
      }
    }
    if (isNew) {
      seen[found] = code
      found += 1
    }
  }
  return found >= need
}

/**
 * 判断以 `from` 为终点、长度 `period` 的块，是否连续重复了 `minRepeats` 次。
 *
 * 这里用 `startsWith` 而不是「切片后比较」：两者结果一样，但前者不产生临时
 * 字符串，在每次检测要比较上千次的情况下能省掉大量内存分配。
 *
 * @param {string} text - 待检测文本。
 * @param {number} from - 判定终点（末尾，或末尾往回偏移若干字符处）。
 * @param {number} period - 候选周期长度。
 * @param {number} minRepeats - 要求的最少重复次数。
 * @param {string} pattern - 已知的周期内容（`text.slice(from - period, from)`）。
 * @returns {boolean} 是否构成重复。
 */
function tailRepeats(text, from, period, minRepeats, pattern) {
  for (let k = 1; k < minRepeats; k += 1) {
    const end = from - period * k
    if (end - period < 0) return false
    // 逐段向前比对：任何一段不同就说明不是稳定的周期，立刻退出。
    if (!text.startsWith(pattern, end - period)) return false
  }
  return true
}

/**
 * 判断文本的末尾是否由某个固定周期重复而成。
 *
 * 从最短周期向外枚举：只要末尾连续 `minRepeats` 段完全一致，就认定找到周期。
 * 自然文本几乎总在第一个候选周期上就失配，因此实际开销远低于最坏情况。
 *
 * @param {string} text - 待检测的尾部文本。
 * @param {object} [opts] - 见 {@link REPEAT_DEFAULTS}。
 * @returns {number} 命中的周期长度；未命中返回 0。
 */
export function findRepeatingPeriod(text, opts = {}) {
  const cfg = { ...REPEAT_DEFAULTS, ...opts }
  const n = text.length
  if (n === 0) return 0

  for (let period = cfg.minPeriod; period <= cfg.maxPeriod; period += 1) {
    const needed = period * cfg.minRepeats
    // 连「重复 minRepeats 次」都装不下，更长的周期只会更装不下，可以直接收工。
    if (needed > n) break

    // 末尾可能停在周期的任意位置，所以从末尾往回尝试若干偏移再判定。
    const maxOffset = Math.min(period - 1, cfg.maxOffsetChars, n - needed)
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const end = n - offset
      // ── 廉价预检（性能关键）────────────────────────────────────────────
      // 如果末尾真的是一段周期在重复，那么「末尾的几个字符」必然与「往前一个
      // 周期处同位置的几个字符」完全相同 —— 这是完全重复的必要条件，所以
      // 用它来排除候选**不会漏判任何真实复读**。
      //
      // 先用 O(1) 的字符比较把绝大多数候选（自然文本里的全部候选）挡掉，
      // 省下后面的切片与建集合。这一步把 40 万字符正常输出的检测开销从
      // 约 3 毫秒一次降到约 0.06 毫秒一次。
      const mirror = end - 1 - period
      if (mirror < 0) continue
      if (text.charCodeAt(mirror) !== text.charCodeAt(end - 1)) continue
      // 位置不足时只做已能做的部分比较：宁可多算，也绝不因为「比不了」而漏判。
      if (mirror >= 1 && text.charCodeAt(mirror - 1) !== text.charCodeAt(end - 2)) continue
      if (mirror >= 2 && text.charCodeAt(mirror - 2) !== text.charCodeAt(end - 3)) continue

      // 低信息量周期（例如一整排等号）直接跳过，避免误伤正常排版。
      if (!hasVariety(text, end - period, end, cfg.minPatternDistinct)) continue

      const pattern = text.slice(end - period, end)
      if (tailRepeats(text, end, period, cfg.minRepeats, pattern)) return period
    }
  }
  return 0
}

/**
 * 把文本切成「有效行」：去掉首尾空白、丢掉空行、丢掉过短的行。
 *
 * 之所以不把空行和短行算进来：空行在正常文本里也是成片出现的，把它们当成
 * 循环体的一部分会让判定变得非常容易误报。
 *
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
 * 比较 `lines[start .. start+pattern.length)` 是否与 `pattern` 逐行相等。
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
 * 在最近的行序列里寻找最小行周期。
 *
 * 这是字符级检测的补充：一个每行 200 字符、共 10 行的循环体远超 256 字符的
 * 字符窗口，但按行看只有 10 行的周期，同样会被抓住。
 *
 * @param {string[]} lines - 有效行序列。
 * @param {object} [opts] - 见 {@link LINE_DEFAULTS}。
 * @returns {{periodLines: number, repeats: number, offset: number}|null} 命中信息；未命中返回 null。
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
      // ── 廉价预检（性能关键）────────────────────────────────────────────
      // 与字符级同样的道理：若末尾真的是一段行块在重复，那么「最后一个有效行」
      // 必然等于「往前一个周期处的有效行」。V8 比较两个长度不同的字符串是
      // O(1)，所以这一行能把绝大多数候选直接排除，省下后面成百上千次逐行比较。
      const mirror = end - 1 - period
      if (mirror >= 0 && lines[end - 1] !== lines[mirror]) continue

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
 * 在一个尾部缓冲上跑完整检测（先字符级，再行级）。
 *
 * 顺序很重要：字符级便宜，先跑；它命中就直接返回，不浪费时间去切行。
 *
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
 * 用法：每收到一小段输出就 `push(文本)`，它会自己攒缓冲、自己决定什么时候
 * 真正做一次判定。因为它会在每个 token 级分片上都可能被调用，所以「不判定」
 * 那条路径必须极快：只有一次字符串拼接和几个数字比较。
 *
 * @param {object} [repeatOpts] - 字符级配置覆盖。
 * @param {object} [lineOpts] - 行级配置覆盖。
 * @returns {{push: (text: string) => object|null, chars: () => number, reset: () => void}} 检测器。
 */
export function createRepeatDetector(repeatOpts, lineOpts) {
  const repeatCfg = { ...REPEAT_DEFAULTS, ...repeatOpts }
  const lineCfg = { ...LINE_DEFAULTS, ...lineOpts }
  // 缓冲上限：既要装得下字符级窗口，也要装得下「最长周期 × 最少重复」。
  const maxTail = Math.max(repeatCfg.windowChars, repeatCfg.maxPeriod * repeatCfg.minRepeats)

  let tail = ''
  /** 已收到、但还没并进判定窗口的片段。 */
  const pending = []
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
      pending.push(text)

      if (!armed) {
        // 还没攒够启动门槛：只记账，不判定。
        if (total < repeatCfg.minChars) return null
        armed = true
      } else if (total - lastCheck < repeatCfg.checkEveryChars) {
        // 节流：距离上次检测还没走满间隔，直接跳过。
        return null
      }
      lastCheck = total

      // ── 只在真正要判定时才搬运字符串（性能关键）────────────────────────
      // 判定窗口有 16KB。如果每个 token 级分片都去「拼接 + 截断」一次，
      // 40 万字符的输出会额外产生几百 MB 的内存搬运 —— 实测能把一次正常回答
      // 拖慢十倍。所以这里先把小片段攒着，到该判定的那一刻再一次性合并。
      if (pending.length > 0) {
        tail = tail + pending.join('')
        pending.length = 0
        if (tail.length > maxTail) tail = tail.slice(-maxTail)
      }
      return detectInTail(tail, repeatCfg, lineCfg)
    },

    /** @returns {number} 累计喂入的字符数。 */
    chars() {
      return total
    },

    /** 清空累计状态（换一条流时用）。 */
    reset() {
      tail = ''
      pending.length = 0
      total = 0
      lastCheck = 0
      armed = false
    },
  }
}
