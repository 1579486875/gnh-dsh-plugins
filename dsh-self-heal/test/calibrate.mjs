/**
 * dsh-self-heal 阈值校准：把「宁可漏判，绝不误报」变成可检验的数字。
 *
 * 为什么要有这个脚本：
 *   本插件的每一次熔断都是**不可逆**的 —— 用户正看着回答，突然被掐断重来。
 *   所以「会不会误伤正常输出」必须是一个**能被量出来**的数，而不是一句口号。
 *   单元测试只能证明「我想到的那些反例没问题」，证明不了「误报率是多少」。
 *
 * 它做什么：
 *   1. 拿一批**正常样本**（长文 / 代码 / 表格 / 清单 / 对话 / JSON / 日志 /
 *      口头禅 / 中英混排 …）和一批**异常样本**（复读、短句打转）逐条过检测器；
 *   2. 报出当前参数下的混淆矩阵与检测延迟；
 *   3. 再扫一遍关键阈值的网格，给出「误报 ↔ 漏报 ↔ 延迟」的取舍曲线 ——
 *      想收紧或放松时，先看这张表再改配置。
 *
 * ⚠️ 诚实的边界：这是**合成语料**，不是真实流量。数字只对这批样本成立；
 *    它回答的是「这批正常输出会不会被误伤」，不是「线上误报率是多少」。
 *    要更可信，就往 `CLEAN_SAMPLES` 里加你自己的正常输出（脱敏后）。
 *
 * 运行：node test/calibrate.mjs
 */

import {
  LINE_DEFAULTS,
  REPEAT_DEFAULTS,
  SENTENCE_LOOP_DEFAULTS,
  createRepeatDetector,
  createSentenceLoopDetector,
} from '../lib/detect.js'

// ═══════════════════════════════════════════════════════════════════════════
// 一、样本集
// ═══════════════════════════════════════════════════════════════════════════

/** 正常样本：每一类都对应一种「可能被误伤」的真实形态。 */
function cleanSamples() {
  const out = []

  // 1. 正常中文长文：结构规整、每行都不同（最容易误伤的长输出形态）
  {
    const lines = []
    for (let i = 1; i <= 3000; i += 1) {
      lines.push(
        '第 ' + i + ' 项任务由第 ' + ((i * 7) % 97) + ' 组负责，当前状态为『进行中』，' +
          '预计工时 ' + (((i * 11) % 23) + 1) + ' 小时。',
      )
    }
    out.push({ name: '中文长文（3000 行）', text: lines.join('\n') })
  }

  // 2. 正常英文技术文：长句为主
  {
    const lines = []
    for (let i = 1; i <= 600; i += 1) {
      lines.push(
        'The module ' + i + ' exposes a narrow interface that hides its internal cache, ' +
          'so callers never need to know whether the value came from disk or memory.',
      )
    }
    out.push({ name: '英文技术文（600 段）', text: lines.join('\n') })
  }

  // 3. 正常 JavaScript 代码：短行多、符号重复多
  {
    const lines = []
    for (let i = 0; i < 400; i += 1) {
      lines.push('function handler_' + i + '(req, res) {')
      lines.push('  // 处理第 ' + i + ' 类请求')
      lines.push('  if (!req.body) return res.status(400).end();')
      lines.push('  return res.json({ ok: true, id: ' + i + ' });')
      lines.push('}')
      lines.push('')
    }
    out.push({ name: 'JavaScript 代码', text: lines.join('\n') })
  }

  // 4. 正常 Python 代码：缩进重复、docstring 重复结构
  {
    const lines = []
    for (let i = 0; i < 300; i += 1) {
      lines.push('def handle_' + i + '(event, context):')
      lines.push('    """Handle event number ' + i + '."""')
      lines.push('    logger.info("handling %s", event.get("id"))')
      lines.push('    return context.respond(' + i * 3 + ')')
      lines.push('')
    }
    out.push({ name: 'Python 代码', text: lines.join('\n') })
  }

  // 5. Markdown 表格
  {
    const lines = ['| 模块 | 状态 | 耗时 | 备注 |', '| --- | --- | --- | --- |']
    for (let i = 1; i <= 400; i += 1) {
      lines.push('| 模块' + i + ' | 通过 | ' + (i * 7) + ' ms | 第 ' + i + ' 轮回归 |')
    }
    out.push({ name: 'Markdown 表格', text: lines.join('\n') })
  }

  // 6. 步骤清单（行短，但每行不同）
  {
    const lines = []
    for (let i = 1; i <= 400; i += 1) {
      lines.push(i + '. 打开第 ' + i + ' 个配置文件并检查端口 ' + (8000 + i) + ' 是否被占用')
    }
    out.push({ name: '步骤清单', text: lines.join('\n') })
  }

  // 7. 对话式短句：句句都短，但内容都不同
  {
    const lines = []
    for (let i = 1; i <= 300; i += 1) {
      lines.push('好，我来看第 ' + i + ' 个文件里的 ' + ((i * 37) % 991) + ' 行配置。')
      lines.push('这里的字段名和文档对不上第 ' + i + ' 处。')
      lines.push('改成 ' + ((i * 53) % 997) + ' 之后就能跑通了。')
    }
    out.push({ name: '对话式短句', text: lines.join('\n') })
  }

  // 8. 口头禅 + 长句（重复率陷阱：只看重复率就会误报）
  {
    const lines = []
    for (let i = 1; i <= 200; i += 1) {
      lines.push('好的。')
      lines.push('第 ' + i + ' 个模块的检查结果是第 ' + ((i * 31) % 997) + ' 号状态，需要继续观察后续变化。')
    }
    out.push({ name: '口头禅 + 长句', text: lines.join('\n') })
  }

  // 9. 短句多但各不同（短句密度 100% 的陷阱）
  {
    const lines = []
    for (let i = 1; i <= 300; i += 1) {
      lines.push('第 ' + i + ' 项检查通过。')
      lines.push('耗时 ' + ((i * 17) % 997) + ' 毫秒。')
    }
    out.push({ name: '短句多但各不同', text: lines.join('\n') })
  }

  // 10. JSON 输出：括号引号满天飞
  {
    const lines = ['{', '  "items": [']
    for (let i = 0; i < 400; i += 1) {
      lines.push('    { "id": ' + i + ', "name": "item-' + i + '", "enabled": true },')
    }
    lines.push('  ]', '}')
    out.push({ name: 'JSON 输出', text: lines.join('\n') })
  }

  // 11. 日志输出：时间戳与等级重复出现
  {
    const lines = []
    for (let i = 1; i <= 500; i += 1) {
      lines.push('2026-10-09 22:' + String(i % 60).padStart(2, '0') + ':00 INFO  任务 ' + i + ' 完成，耗时 ' + (i * 3) + ' ms')
    }
    out.push({ name: '日志输出', text: lines.join('\n') })
  }

  // 12. 中英混排：术语夹杂
  {
    const lines = []
    for (let i = 1; i <= 300; i += 1) {
      lines.push('第 ' + i + ' 步用 `git rebase` 把改动挪到 feature/issue-' + i + ' 分支上，然后跑 npm test。')
    }
    out.push({ name: '中英混排', text: lines.join('\n') })
  }

  // 13. 带重复前缀的列表
  {
    const lines = []
    for (let i = 1; i <= 300; i += 1) {
      lines.push('- [x] 完成第 ' + i + ' 项改造，涉及 ' + ((i * 13) % 89) + ' 个文件')
    }
    out.push({ name: '勾选清单', text: lines.join('\n') })
  }

  // 14. 很短的正常回复（远低于门槛）
  out.push({ name: '短回复', text: '好的。\n我看了一下配置文件。\n问题出在端口占用上。\n已经改好了。' })

  // 15. 正常的中文散文（段落长句）
  {
    const paras = []
    for (let i = 1; i <= 200; i += 1) {
      paras.push(
        '第 ' + i + ' 段：这次改造的重点不在于增加功能，而在于把边界条件一条一条钉死，' +
          '让每一种失败都有明确的归宿；只有把不确定的部分压缩到最小，系统才谈得上可靠。',
      )
    }
    out.push({ name: '中文散文', text: paras.join('\n') })
  }

  return out
}

/** 从真实事故截图里摘出来的原子（措辞与顺序照原样）。 */
const LOOP_ATOMS = [
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

/**
 * 造一段「短句打转」：措辞每次略变，但翻来覆去就是那几句。
 * @param {number} lines - 行数。
 * @returns {string} 文本。
 */
function shortLoop(lines) {
  const out = []
  let seed = 20261009
  for (let i = 0; i < lines; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const pick = seed / 2147483648
    out.push(LOOP_ATOMS[pick < 0.45 ? 0 : Math.floor(pick * LOOP_ATOMS.length)])
  }
  return out.join('\n')
}

/** 异常样本：每一种都应该被抓到。 */
function corruptSamples() {
  const out = []

  // 1. 同一句短句反复念（字符级 / 行级都会命中）
  out.push({ name: '复读：短句 × 800', text: Array.from({ length: 800 }, () => 'Let me run.').join('\n') })

  // 2. 长行反复念（只有复读那条线能抓 —— 用来验证没有互相遮蔽）
  {
    const line = '这是一段刻意写得很长的重复内容，用来把平均行长拉到预检门槛之上，只让复读检测那条线负责抓它。'
    out.push({ name: '复读：长行 × 200', text: Array.from({ length: 200 }, () => line).join('\n') })
  }

  // 3. 多行块循环（真实事故形态：15 行推理反复念）
  {
    const body = [
      'Let me grep for the rate computation.',
      'Let me run.',
      'Let me be token-efficient: single grep with context.',
      'Let me go.',
      'Actually, let me minimize by using grep to find line numbers, then read only what is needed.',
      'Let me grep.',
      "I'll use one grep call for both patterns.",
      'Let me do it.',
      'Let me proceed.',
      'Note: I should keep responses concise to save the user quota.',
      'Let me go.',
      'Let me grep for the section definition line.',
      'I will grep the target file.',
      'Let me run.',
      'Then read around it.',
    ].join('\n')
    out.push({ name: '复读：15 行块 × 12 遍', text: Array.from({ length: 12 }, () => body).join('\n') })
  }

  // 4. 短句打转（400 行）
  out.push({ name: '短句打转 × 400', text: shortLoop(400) })

  // 5. 短句打转（800 行）
  out.push({ name: '短句打转 × 800', text: shortLoop(800) })

  // 6. 短句打转（更小规模：200 行，看还抓不抓得住）
  out.push({ name: '短句打转 × 200', text: shortLoop(200) })

  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、评测
// ═══════════════════════════════════════════════════════════════════════════

/** 喂分片的大小（模拟 token 级流式）。 */
const CHUNK = 16

/**
 * 让一条文本走一遍完整检测（与运行时同一条路径：复读 + 短句打转）。
 *
 * @param {string} text - 待测文本。
 * @param {object} overrides - `{ repeat, lines, loop }` 三组阈值覆盖。
 * @returns {{hit: boolean, by: string, at: number}} 命中信息；`at` 是命中时已输出的字符数。
 */
function judge(text, overrides = {}) {
  const repeat = createRepeatDetector(
    { ...REPEAT_DEFAULTS, ...(overrides.repeat ?? {}) },
    { ...LINE_DEFAULTS, ...(overrides.lines ?? {}) },
  )
  const loop = createSentenceLoopDetector({ ...SENTENCE_LOOP_DEFAULTS, ...(overrides.loop ?? {}) })

  for (let i = 0; i < text.length; i += CHUNK) {
    const piece = text.slice(i, i + CHUNK)
    if (repeat.push(piece) !== null) return { hit: true, by: 'repeat', at: repeat.chars() }
    if (loop.push(piece) !== null) return { hit: true, by: 'loop', at: loop.chars() }
  }
  return { hit: false, by: '', at: text.length }
}

/**
 * 跑一整轮评测。
 *
 * @param {object[]} clean - 正常样本。
 * @param {object[]} corrupt - 异常样本。
 * @param {object} overrides - 阈值覆盖。
 * @returns {{falsePositives: object[], misses: object[], delays: number[]}} 结果。
 */
function evaluate(clean, corrupt, overrides = {}) {
  const falsePositives = []
  const misses = []
  const delays = []

  for (const sample of clean) {
    const result = judge(sample.text, overrides)
    if (result.hit) falsePositives.push({ ...sample, by: result.by, at: result.at })
  }
  for (const sample of corrupt) {
    const result = judge(sample.text, overrides)
    if (result.hit) delays.push(result.at)
    else misses.push(sample)
  }

  return { falsePositives, misses, delays }
}

/** 取中位数。 @param {number[]} values - 数值数组。 @returns {number} 中位数。 */
function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 把一轮结果打印成一行。
 * @param {string} label - 配置名。
 * @param {object} result - evaluate 的结果。
 * @param {number} cleanCount - 正常样本数。
 * @param {number} corruptCount - 异常样本数。
 */
function printRow(label, result, cleanCount, corruptCount) {
  const fp = result.falsePositives.length
  const fn = result.misses.length
  const rate = ((fp / cleanCount) * 100).toFixed(0)
  console.log(
    '  ' + label.padEnd(34) +
      (fp + ' / ' + cleanCount).padStart(10) +
      (rate + '%').padStart(6) +
      (fn + ' / ' + corruptCount).padStart(10) +
      String(Math.round(median(result.delays))).padStart(12) + ' 字符',
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、跑
// ═══════════════════════════════════════════════════════════════════════════

const clean = cleanSamples()
const corrupt = corruptSamples()
const cleanChars = clean.reduce((sum, s) => sum + s.text.length, 0)

console.log('='.repeat(88))
console.log('一、语料')
console.log('='.repeat(88))
console.log('  正常样本 ' + clean.length + ' 条（共 ' + cleanChars + ' 字符）')
console.log('  异常样本 ' + corrupt.length + ' 条（共 ' + corrupt.reduce((s, x) => s + x.text.length, 0) + ' 字符）')
console.log('')
console.log('  ⚠️ 这是**合成语料**，不是真实流量：数字只对这批样本成立。')
console.log('     它回答的是「这批正常输出会不会被误伤」，不是「线上误报率是多少」。')

console.log('')
console.log('='.repeat(88))
console.log('二、当前默认参数')
console.log('='.repeat(88))
console.log('  ' + '配置'.padEnd(32) + '误报'.padStart(12) + '误报率'.padStart(8) + '漏报'.padStart(10) + '中位延迟'.padStart(14))

const baseline = evaluate(clean, corrupt, {})
printRow('当前默认', baseline, clean.length, corrupt.length)

if (baseline.falsePositives.length > 0) {
  console.log('')
  console.log('  ⚠️ 有正常样本被误判 —— 这是必须处理的问题：')
  for (const sample of baseline.falsePositives) {
    console.log('     · ' + sample.name + '（被 ' + sample.by + ' 在第 ' + sample.at + ' 字符处判为异常）')
  }
}
if (baseline.misses.length > 0) {
  console.log('')
  console.log('  ⚠️ 有异常样本没被抓到（可接受，但要知情为什么）：')
  for (const sample of baseline.misses) console.log(explainMiss(sample, {}))
}

/**
 * 打印一条漏报的原因（多半是样本太短、够不到启动门槛）。
 *
 * @param {object} sample - 样本。
 * @param {object} overrides - 本轮阈值覆盖。
 * @returns {string} 一行说明。
 */
function explainMiss(sample, overrides) {
  const loopMin = overrides.loop?.minChars ?? SENTENCE_LOOP_DEFAULTS.minChars
  const repeatMin = overrides.repeat?.minChars ?? REPEAT_DEFAULTS.minChars
  const below = []
  if (sample.text.length < loopMin) below.push('短句门槛 ' + loopMin)
  if (sample.text.length < repeatMin) below.push('复读门槛 ' + repeatMin)
  const reason =
    below.length > 0 ? '（样本只有 ' + sample.text.length + ' 字符，够不到 ' + below.join(' / ') + '）' : '（走完全程仍未命中）'
  return '     · ' + sample.name + ' ' + reason
}

console.log('')
console.log('='.repeat(88))
console.log('三、阈值网格')
console.log('='.repeat(88))
console.log('  ' + '配置'.padEnd(34) + '误报'.padStart(10) + '误报率'.padStart(6) + '漏报'.padStart(10) + '中位延迟'.padStart(12))

console.log('')
console.log('  ── A 组：候选档位（我们真的可能采用的设置）──')

const candidates = [
  ['复读 minRepeats=8（更灵敏）', { repeat: { minRepeats: 8 } }],
  ['复读 minRepeats=12（默认）', { repeat: { minRepeats: 12 } }],
  ['复读 minRepeats=16（更保守）', { repeat: { minRepeats: 16 } }],
  ['复读 minRepeats=20（最保守）', { repeat: { minRepeats: 20 } }],
  ['行级 minRepeats=5（默认）', { lines: { minRepeats: 5 } }],
  ['行级 minRepeats=8（更保守）', { lines: { minRepeats: 8 } }],
  ['短句 confirmRounds=1（更急）', { loop: { confirmRounds: 1 } }],
  ['短句 confirmRounds=2（默认）', { loop: { confirmRounds: 2 } }],
  ['短句 confirmRounds=3（更稳）', { loop: { confirmRounds: 3 } }],
  ['短句 minRepeatRatio=0.5（更松）', { loop: { minRepeatRatio: 0.5 } }],
  ['短句 minRepeatRatio=0.6（默认）', { loop: { minRepeatRatio: 0.6 } }],
  ['短句 minRepeatRatio=0.75（更严）', { loop: { minRepeatRatio: 0.75 } }],
  ['短句 minShortRatio=0.85（默认）', { loop: { minShortRatio: 0.85 } }],
  ['短句 minShortRatio=0.95（更严）', { loop: { minShortRatio: 0.95 } }],
  ['短句 minChars=3000（更晚动手）', { loop: { minChars: 3000 } }],
  ['复读 minChars=8000（更晚动手）', { repeat: { minChars: 8000 } }],
]

for (const [label, overrides] of candidates) {
  printRow(label, evaluate(clean, corrupt, overrides), clean.length, corrupt.length)
}

console.log('')
console.log('  ── B 组：对照档位（**故意放宽**，用来看每道闸门到底在挡什么）──')
console.log('     这一组的意义是：如果这里出现非零误报，说明默认值里那道闸是必需的，不是摆设。')

const loosened = [
  ['对照：只放宽短句密度到 0.5', { loop: { minShortRatio: 0.5 } }],
  ['对照：只放宽平均行长到 30', { loop: { maxAverageLineChars: 30 } }],
  ['对照：行长 30 + 密度 0.5', { loop: { maxAverageLineChars: 30, minShortRatio: 0.5 } }],
  ['对照：行长 30 + 密度 0.5 + 无确认', { loop: { maxAverageLineChars: 30, minShortRatio: 0.5, confirmRounds: 1 } }],
  ['对照：短句上限放到 60 字符', { loop: { maxSentenceChars: 60 } }],
  ['对照：启动门槛降到 300', { loop: { minChars: 300 } }],
  ['对照：复读 minRepeats=4（很松）', { repeat: { minRepeats: 4 } }],
  ['对照：复读 minChars=500（很早就判）', { repeat: { minChars: 500, checkEveryChars: 200 } }],
]

for (const [label, overrides] of loosened) {
  const result = evaluate(clean, corrupt, overrides)
  printRow(label, result, clean.length, corrupt.length)
  for (const sample of result.falsePositives) {
    console.log('       ↳ 误伤：' + sample.name + '（被 ' + sample.by + ' 在第 ' + sample.at + ' 字符处判为异常）')
  }
}

console.log('')
console.log('='.repeat(88))
console.log('四、怎么读这张表')
console.log('='.repeat(88))
console.log('  · A 组「误报」那一列必须永远是 0 —— 任何一格非零，说明那组参数会误伤正常输出，')
console.log('    不管它的漏报多低都不该采用。')
console.log('  · B 组是反向验证：那些非零行告诉你，默认值里的哪道闸是真的在干活。')
console.log('  · 「中位延迟」是抓到时已经吐了多少字符：越小越省钱，但也意味着越激进。')
console.log('  · 想调阈值时先跑这个脚本，把 A 组的误报列看一遍，再决定。')
console.log('  · 把自己的正常输出（脱敏后）加进 cleanSamples()，这张表才有你自己的意义。')
