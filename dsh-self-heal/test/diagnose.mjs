/**
 * dsh-self-heal 诊断脚本（手工运行，不是单元测试）。
 *
 * 用途：当你想知道「这套检测在真实事故文本上到底什么时候才动手」「它每秒
 * 能处理多少字符」时，跑一下这里，比翻日志快得多。
 *
 * 运行：node test/diagnose.mjs
 */

import {
  LINE_DEFAULTS,
  REPEAT_DEFAULTS,
  UNFINISHED_DEFAULTS,
  createRepeatDetector,
  detectInTail,
  detectUnfinished,
} from '../lib/detect.js'
import { createTailBuffer } from '../lib/index.js'

/** 复现群友事故里的真实推理循环文本（15 行，逐字取自截图）。 */
const REAL_LOOP_BODY = [
  'Let me grep for 北蝉 and the rate computation.',
  'Let me run.',
  'Let me be token-efficient: single grep with context.',
  'Let me go.',
  "Actually, let me minimize by using grep to find line numbers, then read only what's needed, then edit.",
  'Let me grep.',
  "I'll use one grep call for both patterns.",
  'Let me do it.',
  'Let me proceed.',
  "Note: I should keep responses concise to save the user's quota. Let me do the work with minimal narration.",
  'Let me go.',
  'Let me grep for the section definition line and the adjRate computation.',
  'I\'ll grep "北蝉" in generate_preliminary_report.ps1.',
  'Let me run.',
  'Then read around it.',
]

/**
 * 按指定分片大小把文本喂进一个新的检测器，报告它在第几个字符上命中。
 * @param {string} text - 待喂文本。
 * @param {number} size - 分片大小。
 * @returns {{chars: number, hit: object}|null} 命中信息；未命中返回 null。
 */
function whenTrips(text, size) {
  const detector = createRepeatDetector()
  for (let i = 0; i < text.length; i += size) {
    const hit = detector.push(text.slice(i, i + size))
    if (hit !== null) return { chars: detector.chars(), hit }
  }
  return null
}

/**
 * 把一次测量的结果打印成一行。
 * @param {string} label - 场景名。
 * @param {object|null} result - whenTrips 的结果。
 * @param {string} unit - 「一遍」对应的字符数，用于换算。
 */
function report(label, result, unit) {
  if (result === null) {
    console.log('  ' + label.padEnd(28) + ' 未命中（会一直烧到墙钟超时才收手）')
    return
  }
  const copies = (result.chars / unit).toFixed(1)
  const detail =
    result.hit.kind === 'char-period'
      ? '字符级周期 ' + result.hit.period
      : '行级周期 ' + result.hit.periodLines + ' 行 × ' + result.hit.repeats + ' 次'
  console.log(
    '  ' + label.padEnd(28) + ' 第 ' + result.chars + ' 字符命中（约 ' + copies + ' 遍，' + detail + '）',
  )
}

console.log('='.repeat(78))
console.log('一、真实事故文本的触发点')
console.log('='.repeat(78))

const unit = REAL_LOOP_BODY.join('\n').length + 1
console.log('循环体：15 行英文推理，每遍约 ' + unit + ' 字符')
console.log('启动门槛：输出累计 ' + REPEAT_DEFAULTS.minChars + ' 字符后才开始判定')
console.log('')

const aligned = Array.from({ length: 12 }, () => REAL_LOOP_BODY.join('\n')).join('\n')
report('末尾正好对齐（按 16 字符喂）', whenTrips(aligned, 16), unit)

const trailing = aligned + '\nVERIFY-OK'
report('末尾多一句收尾语', whenTrips(trailing, 16), unit)

const halfLine = aligned + '\nLet me gre'
report('末尾停在半行', whenTrips(halfLine, 16), unit)

const tiny = Array.from({ length: 16 }, () => REAL_LOOP_BODY.join('\n')).join('\n')
report('按 7 字符的超小分片喂', whenTrips(tiny, 7), unit)

console.log('')
console.log('='.repeat(78))
console.log('二、正常长文本会不会误报（有则说明阈值需要重新调）')
console.log('='.repeat(78))

/** 造一段每行都不同的正常中文长文本。 */
function variedProse(count) {
  const out = []
  for (let i = 1; i <= count; i += 1) {
    out.push('第 ' + i + ' 项任务由第 ' + ((i * 7) % 97) + ' 组负责，状态 ' + ((i * 13) % 251) + '，用时 ' + ((i * 29) % 991) + ' 秒。')
  }
  return out.join('\n')
}

const prose = variedProse(20000)
const proseHit = detectInTail(prose.slice(-REPEAT_DEFAULTS.windowChars), REPEAT_DEFAULTS, LINE_DEFAULTS)
console.log('  正常中文 ' + prose.length + ' 字符：' + (proseHit === null ? '未命中（正确）' : '误报！' + JSON.stringify(proseHit)))

const code = []
for (let i = 0; i < 1200; i += 1) {
  code.push('def handler_' + i + '(event, context):')
  code.push('    return context.respond(' + i * 3 + ')')
}
const codeText = code.join('\n')
const codeHit = detectInTail(codeText.slice(-REPEAT_DEFAULTS.windowChars), REPEAT_DEFAULTS, LINE_DEFAULTS)
console.log('  正常代码 ' + codeText.length + ' 字符：' + (codeHit === null ? '未命中（正确）' : '误报！' + JSON.stringify(codeHit)))

console.log('')
console.log('='.repeat(78))
console.log('三、性能')
console.log('='.repeat(78))

/**
 * 测量一段操作耗时。
 * @param {string} label - 场景名。
 * @param {() => void} run - 被测操作。
 * @param {number} chars - 操作处理的字符数（用于算吞吐）。
 */
function bench(label, run, chars) {
  run() // 预热，避免把 JIT 编译时间算进去
  const startedAt = process.hrtime.bigint()
  run()
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
  const mchars = chars / 1e6
  console.log(
    '  ' + label.padEnd(34) + ms.toFixed(1).padStart(8) + ' ms   ' +
      (ms > 0 ? (mchars / (ms / 1000)).toFixed(1) : '∞').padStart(8) + ' M字符/秒',
  )
}

const small = variedProse(6000) // 约 40 万字符
bench('小分片（8 字符）× 5 万次', () => {
  const detector = createRepeatDetector()
  for (let i = 0; i < small.length; i += 8) detector.push(small.slice(i, i + 8))
}, small.length)

bench('中分片（64 字符）× 6 千次', () => {
  const detector = createRepeatDetector()
  for (let i = 0; i < small.length; i += 64) detector.push(small.slice(i, i + 64))
}, small.length)

const loopText = Array.from({ length: 400 }, () => REAL_LOOP_BODY.join('\n')).join('\n')
bench('复读文本（会在中途熔断）', () => {
  const detector = createRepeatDetector()
  for (let i = 0; i < loopText.length; i += 32) {
    if (detector.push(loopText.slice(i, i + 32)) !== null) return
  }
}, loopText.length)

console.log('')
console.log('说明：检测器只保留尾部 ' + REPEAT_DEFAULTS.windowChars + ' 字符的窗口，')
console.log('      所以单条流的额外内存是固定的，不随输出总长增长。')

console.log('')
console.log('='.repeat(78))
console.log('四、未完成识别：哪些会被接上、哪些不会')
console.log('='.repeat(78))
console.log('上半是「说了一半就停」的典型形态（会被接上），下半是正常收尾（不许打扰）：')
console.log('')

/**
 * 打印一条未完成判定样例。
 * @param {string} label - 场景名。
 * @param {string} finishKind - 流的结束方式。
 * @param {string} text - 正文尾部。
 */
function unfinishedCase(label, finishKind, text) {
  const hit = detectUnfinished(finishKind, text)
  const verdict = hit === null ? '不管（视为正常收尾）' : '接上（' + hit.reason + '）'
  console.log('  ' + label.padEnd(24) + verdict)
}

unfinishedCase('被长度上限截断', 'max-tokens', '写到一半的正文')
unfinishedCase('代码块没闭合', 'stop', '改法如下：\n```js\nconst a = 1\n')
unfinishedCase('停在逗号上', 'stop', '这个函数的作用是把输入转换成输出，')
unfinishedCase('停在冒号上', 'stop', '结论如下：')
unfinishedCase('「我先去确认一下」', 'stop', '先确认 README 第二节的真实设置项，避免我写的新表与它不符。')
unfinishedCase('英文 Let me …', 'stop', 'Let me run the tests.')
console.log('  ' + '-'.repeat(46))
unfinishedCase('句号正常收尾', 'stop', '以上就是全部改动，测试都通过了。')
unfinishedCase('完整代码块收尾', 'stop', '```js\nlet a = 1\n```\n')
unfinishedCase('表格收尾', 'stop', '| 项目 | 结果 |\n| --- | --- |\n| A | 通过 |\n')
unfinishedCase('对用户交代下一步', 'stop', '你可以先确认一下配置。')
unfinishedCase('省略号收尾', 'stop', '大概就是这样吧…')
unfinishedCase('被中断（aborted）', 'aborted', '这个函数的作用是把输入转换成输出，')

console.log('')
console.log('='.repeat(78))
console.log('五、尾部缓冲的开销（每个 token 级分片都要过一遍）')
console.log('='.repeat(78))

bench('尾部缓冲（8 字符）× 5 万次', () => {
  const buffer = createTailBuffer(UNFINISHED_DEFAULTS.tailChars)
  for (let i = 0; i < small.length; i += 8) buffer.push(small.slice(i, i + 8))
}, small.length)

bench('对照：旧写法 (tail+text).slice(-N)', () => {
  let tail = ''
  for (let i = 0; i < small.length; i += 8) {
    tail = (tail + small.slice(i, i + 8)).slice(-UNFINISHED_DEFAULTS.tailChars)
  }
}, small.length)

console.log('')
console.log('说明：尾部缓冲最多占用约 2 个窗口（' + UNFINISHED_DEFAULTS.tailChars + ' 字符 × 2）的内存，')
console.log('      只有「攒够一个窗口」或「真要读尾巴」时才做一次合并 —— 这就是它比')
console.log('      每片都拼接截断快得多的原因。')

console.log('')
console.log('='.repeat(78))
console.log('七、完整链路：把插件挂在一整条流上要多久')
console.log('='.repeat(78))

const { drain, mount, streamOf } = await import('./harness.mjs')

/**
 * 把一段文本切成流分片（末尾补一个正常结束的 finish）。
 * @param {string} text - 文本。
 * @param {number} size - 每片字符数。
 * @returns {object[]} 分片数组。
 */
function makeChunks(text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) {
    out.push({ type: 'text-delta', index: 0, text: text.slice(i, i + size) })
  }
  out.push({ type: 'finish', reason: { kind: 'stop' } })
  return out
}

const benchChunks = makeChunks(small, 8) // 最碎的 token 级分片形态
const benchApp = mount({})
const benchAppNoTail = mount({ unfinished: { enabled: false } })

/** 跑一遍完整的 llm/stream 包装链路（复读检测 + 尾部缓冲 + 记账）。 */
async function throughPlugin(app) {
  await drain(app.stream({ sessionId: 'bench', provider: 'p', model: 'm' }, () => streamOf(benchChunks).source))
}

/** 跑一遍不经过插件的裸流，作为对照。 */
async function bare() {
  await drain(streamOf(benchChunks).source)
}

/** 计时跑一次异步操作。 @param {() => Promise<void>} run - 被测操作。 @returns {Promise<number>} 毫秒。 */
async function timeIt(run) {
  const startedAt = process.hrtime.bigint()
  await run()
  return Number(process.hrtime.bigint() - startedAt) / 1e6
}

/**
 * 跑若干次、取最快的一次。
 *
 * 为什么要取最小值：这类测量会被 GC 和系统调度打断，平均值只反映「附近有多吵」。
 * 最小值才最接近这段代码的真实成本。
 *
 * @param {number} times - 跑几次。
 * @param {() => Promise<void>} run - 被测操作。
 * @returns {Promise<number>} 最快一次的毫秒数。
 */
async function bestOf(times, run) {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < times; i += 1) best = Math.min(best, await timeIt(run))
  return best
}

// 预热，避免把 JIT 编译时间算进去。
await throughPlugin(benchApp)
await throughPlugin(benchAppNoTail)
await bare()

const bareMs = await bestOf(3, bare)
const noTailMs = await bestOf(3, () => throughPlugin(benchAppNoTail))
const withTailMs = await bestOf(3, () => throughPlugin(benchApp))

console.log('  样本 ' + small.length + ' 字符 / ' + benchChunks.length + ' 个分片（8 字符一片）')
console.log('  裸流（不经过插件）          ' + bareMs.toFixed(1).padStart(8) + ' ms')
console.log('  经过插件（不含尾部缓冲）      ' + noTailMs.toFixed(1).padStart(8) + ' ms')
console.log('  经过插件（含尾部缓冲）       ' + withTailMs.toFixed(1).padStart(8) + ' ms')
console.log('  ── 本次新增功能的净开销     ' + (withTailMs - noTailMs).toFixed(1).padStart(8) + ' ms')
console.log('')
console.log('说明：三个数字里绝大部分是「构造与消费几万个对象」的固有成本 —— 真正属于')
console.log('      检测的部分请看第三节与第五节。新增功能摊到每个分片上只有亚微秒级，')
console.log('      相对于一次真实模型调用的耗时（秒级）完全可以忽略。')
