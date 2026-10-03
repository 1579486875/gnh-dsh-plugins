/**
 * 复读检测触发点诊断。
 *
 * 用一小段真实事故文本做样本，演示检测器在不同的重复遍数下：
 *   - 何时才会启动判定（minChars 门槛）；
 *   - 一旦启动，能在第几个字符处抓到循环；
 *   - 末尾挂一句收尾语（非周期尾巴）时是否仍能命中。
 *
 * 用法：
 *   node test/diagnose.mjs
 *
 * 预期输出（当前参数下）：8 遍及以上一律在第 3984 字符附近熔断；6 遍因为总量
 * 没过 4000 字符的启动门槛而不触发 —— 这是刻意的取舍，短输出不值得打断。
 */

import { createRepeatDetector } from '../lib/detect.js'

/** 真实事故里的推理循环文本（15 行，逐字取自现场）。 */
const LOOP_BODY = [
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

const oneRound = LOOP_BODY.join('\n')
console.log('单遍：' + String(oneRound.length) + ' 字符 / ' + String(LOOP_BODY.length) + ' 行')

/** 按 16 字符的增量喂入，复现真实的流式到达方式。 */
function feed(text) {
  const detector = createRepeatDetector()
  for (let i = 0; i < text.length; i += 16) {
    const hit = detector.push(text.slice(i, i + 16))
    if (hit !== null) return { hit, at: i }
  }
  return { hit: null, at: -1 }
}

console.log('')
console.log('组 A：纯粹的循环（末尾正好对齐）')
for (const rounds of [6, 8, 10, 20]) {
  const text = Array.from({ length: rounds }, () => oneRound).join('\n')
  const { hit, at } = feed(text)
  console.log(
    '  ' + String(rounds).padStart(3) + ' 遍 | ' + String(text.length).padStart(6) + ' 字符 | ' +
    (hit === null ? '未触发' : '熔断于 ' + String(at) + '（' + hit.kind + '）'),
  )
}

console.log('')
console.log('组 B：末尾多一句收尾语（曾经会让检测整个失灵）')
for (const rounds of [6, 8, 10, 20]) {
  const text = Array.from({ length: rounds }, () => oneRound).join('\n') + '\nVERIFY-OK'
  const { hit, at } = feed(text)
  console.log(
    '  ' + String(rounds).padStart(3) + ' 遍 | ' + String(text.length).padStart(6) + ' 字符 | ' +
    (hit === null ? '未触发' : '熔断于 ' + String(at) + '（' + hit.kind + '）'),
  )
}
