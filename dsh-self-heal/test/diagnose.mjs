/**
 * dsh-self-heal 诊断脚本（手工运行，不是单元测试）。
 *
 * 用途：当你想知道「这套检测在真实事故文本上到底什么时候才动手」「它每秒
 * 能处理多少字符」时，跑一下这里，比翻日志快得多。
 *
 * 运行：node test/diagnose.mjs
 */

import { LINE_DEFAULTS, REPEAT_DEFAULTS, createRepeatDetector, detectInTail } from '../lib/detect.js'

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
