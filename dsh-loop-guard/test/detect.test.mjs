/**
 * dsh-loop-guard 检测内核自测。
 *
 * 运行：node --test test/
 *
 * 测试分三组：
 *   1. 不误报 —— 真实形态的正常长输出必须一次都不触发；
 *   2. 必触发 —— 各种形态的复读必须被抓到（含真实事故文本）；
 *   3. 参数自洽 —— 窗口尺寸必须喂得饱两条检测线。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LINE_DEFAULTS,
  REPEAT_DEFAULTS,
  createRepeatDetector,
  detectInTail,
  estimateTokens,
  findRepeatingLineBlock,
  findRepeatingPeriod,
  significantLines,
} from '../lib/detect.js'

/** 用真实的默认参数对一段文本做一次判定（等价于流末尾的那次检查）。 */
function judge(text) {
  const tail = text.slice(-REPEAT_DEFAULTS.windowChars)
  return detectInTail(tail, REPEAT_DEFAULTS, LINE_DEFAULTS)
}

// ---------------------------------------------------------------------------
// 正常样本构造器：每一行都不同，但整体结构高度规整 —— 这是最容易误报的形态。
// ---------------------------------------------------------------------------

/** 中文任务清单：结构一致、只有数字与枚举值变化。 */
function variedProse(count) {
  const states = ['已完成', '排队中', '已取消', '重试中', '已归档']
  const owners = ['张工', '李工', '王工', '赵工', '陈工']
  const out = []
  for (let i = 1; i <= count; i += 1) {
    out.push(
      '第 ' + i + ' 项任务由' + owners[i % owners.length] + '负责，当前状态为' +
      states[i % states.length] + '，预计工时 ' + (((i * 7) % 23) + 1) +
      ' 小时，依赖项 ' + ((i * 13) % 17) + ' 个。',
    )
  }
  return out.join('\n')
}

/** Python 代码：块间结构相同，块内每行都有差异。 */
function variedCode(count) {
  const out = []
  for (let i = 0; i < count; i += 1) {
    out.push('def handler_' + i + '(event, context):')
    out.push('    """处理第 ' + i + ' 类事件。"""')
    out.push('    logger.info("handling %s", event.get("id"))')
    out.push('    if event.get("retry") > ' + (i % 5) + ':')
    out.push('        return context.respond(' + (i * 3) + ', status="degraded")')
    out.push('    return context.respond(' + (i * 3) + ')')
    out.push('')
  }
  return out.join('\n')
}

/** Markdown 表格：含分隔行与大量同构数据行。 */
function variedTable(rows) {
  const out = ['| 字段 | 类型 | 必填 | 说明 |', '|---|---|---|---|']
  for (let i = 1; i <= rows; i += 1) {
    out.push(
      '| field_' + i + ' | string | 否 | 第 ' + i + ' 个字段，用于承载' +
      (i % 2 === 0 ? '扩展' : '基础') + '信息 |',
    )
  }
  return out.join('\n')
}

/** JSON 记录数组：大量同构对象。 */
function variedJson(count) {
  const out = ['[']
  for (let i = 1; i <= count; i += 1) {
    out.push('  { "id": ' + i + ', "name": "item-' + i + '", "value": ' + ((i * 17) % 100) + ' },')
  }
  out.push(']')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 1. 不误报
// ---------------------------------------------------------------------------

test('正常内容不误报：中文任务清单', () => {
  const text = variedProse(220)
  assert.ok(text.length > 8000, '样本应足够长，实际 ' + text.length)
  assert.equal(judge(text), null)
})

test('正常内容不误报：Python 代码', () => {
  const text = variedCode(160)
  assert.ok(text.length > 20000, '样本应足够长，实际 ' + text.length)
  assert.equal(judge(text), null)
})

test('正常内容不误报：Markdown 表格', () => {
  const text = variedTable(200)
  assert.ok(text.length > 8000, '样本应足够长，实际 ' + text.length)
  assert.equal(judge(text), null)
})

test('正常内容不误报：JSON 记录数组', () => {
  const text = variedJson(240)
  assert.ok(text.length > 8000, '样本应足够长，实际 ' + text.length)
  assert.equal(judge(text), null)
})

test('正常内容不误报：代码里的深层缩进与重复括号', () => {
  // 构造大量 "    }" / "}" 交替 —— 这类低信息量周期必须被 minPatternDistinct 挡掉。
  const chunks = []
  for (let i = 0; i < 400; i += 1) {
    chunks.push('    ' + '}'.repeat(1 + (i % 3)))
    chunks.push('  }')
  }
  const text = chunks.join('\n')
  assert.ok(text.length > 3000, '样本应足够长，实际 ' + text.length)
  assert.equal(judge(text), null)
})

test('正常内容不误报：Markdown 分隔线', () => {
  const text = [
    '# 一级标题',
    '',
    '正文段落一，说明一些事情。',
    '',
    '---',
    '',
    '正文段落二，继续说明。',
    '',
    '***',
    '',
    '结尾段落。',
    '='.repeat(120),
  ].join('\n')
  assert.equal(judge(text), null)
})

// ---------------------------------------------------------------------------
// 2. 必触发
// ---------------------------------------------------------------------------

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

test('必触发：真实事故文本（15 行推理循环 × 6 次）', () => {
  const text = Array.from({ length: 6 }, () => REAL_LOOP_BODY.join('\n')).join('\n')
  const hit = judge(text)
  assert.notEqual(hit, null, '真实事故文本必须被识别')
  assert.equal(hit.kind, 'line-period')
})

test('必触发：单行英文重复 200 次', () => {
  const text = Array.from({ length: 200 }, () => 'Let me run.').join('\n')
  const hit = judge(text)
  assert.notEqual(hit, null, '单行复读必须被识别')
})

test('必触发：两行交替 120 轮', () => {
  const text = Array.from({ length: 240 }, (_, i) => (i % 2 === 0 ? 'Let me go.' : 'Let me run.')).join('\n')
  assert.notEqual(judge(text), null, '两行交替复读必须被识别')
})

test('必触发：中文短句重复 150 次', () => {
  const text = Array.from({ length: 150 }, () => '让我再确认一下这个字段的含义。').join('\n')
  assert.notEqual(judge(text), null, '中文复读必须被识别')
})

test('必触发：超长行循环（字符窗口装不下，靠行级检测）', () => {
  const longLine = Array.from({ length: 40 }, (_, i) => 'segment-' + i).join(' ')
  assert.ok(longLine.length > REPEAT_DEFAULTS.maxPeriod, '单行必须超过字符级周期上限')
  const text = Array.from({ length: 10 }, () => longLine).join('\n')
  const hit = judge(text)
  assert.notEqual(hit, null, '超长行循环必须由行级检测兜住')
  assert.equal(hit.kind, 'line-period')
})

test('必触发：流式分片喂入同样能识别', () => {
  const text = Array.from({ length: 8 }, () => REAL_LOOP_BODY.join('\n')).join('\n')
  const detector = createRepeatDetector()
  let hit = null
  for (let i = 0; i < text.length && hit === null; i += 7) {
    hit = detector.push(text.slice(i, i + 7))
  }
  assert.notEqual(hit, null, '按 7 字符分片喂入也必须识别')
})

// 下面这组是「末尾偏移」回归：检测器最初只认末尾对齐的周期，导致流式输出
// 停在半行、或末尾多一句收尾语时整个循环漏检。该缺陷由一次真实的端到端
// 验证（子代理按指令复读真实事故文本）暴露，单元测试当时因为样本末尾恰好
// 对齐而全部通过。任何一条都不能回退。

test('必触发：末尾带非周期收尾语（端到端暴露的回归）', () => {
  const text =
    Array.from({ length: 10 }, () => REAL_LOOP_BODY.join('\n')).join('\n') + '\nVERIFY-OK'
  const detector = createRepeatDetector()
  let hit = null
  for (let i = 0; i < text.length && hit === null; i += 16) {
    hit = detector.push(text.slice(i, i + 16))
  }
  assert.notEqual(hit, null, '末尾多一句非周期内容不得让循环漏检')
  assert.equal(hit.kind, 'line-period')
})

test('必触发：末尾停在半行（流被截断）', () => {
  const text =
    Array.from({ length: 10 }, () => REAL_LOOP_BODY.join('\n')).join('\n') + '\nLet me gre'
  const detector = createRepeatDetector()
  let hit = null
  for (let i = 0; i < text.length && hit === null; i += 16) {
    hit = detector.push(text.slice(i, i + 16))
  }
  assert.notEqual(hit, null, '末尾半行不得让循环漏检')
})

test('必触发：行级检测通过偏移命中，而不是靠末尾对齐', () => {
  const lines = []
  for (let i = 0; i < 10; i += 1) for (const line of REAL_LOOP_BODY) lines.push(line)
  lines.push('VERIFY-OK')
  const hit = findRepeatingLineBlock(lines, LINE_DEFAULTS)
  assert.notEqual(hit, null)
  assert.equal(hit.periodLines, REAL_LOOP_BODY.length)
  assert.ok(hit.offset >= 1, '应当靠偏移跳过收尾语后命中')
})

test('必触发：字符级检测同样容忍末尾偏移', () => {
  const unit = 'Let me run and check.\n'
  const text = unit.repeat(60) + 'TRAILING'
  const period = findRepeatingPeriod(text, REPEAT_DEFAULTS)
  assert.equal(period, unit.length, '末尾尾巴不得让字符级周期漏检')
})

// ---------------------------------------------------------------------------
// 3. 边界与参数自洽
// ---------------------------------------------------------------------------

test('边界：重复次数不足时不触发', () => {
  // 行级门槛是 5 次，这里只重复 3 次。
  const text = Array.from({ length: 3 }, () => REAL_LOOP_BODY.join('\n')).join('\n')
  assert.equal(judge(text), null)
})

test('边界：短输出即使高度重复也不判定', () => {
  const short = Array.from({ length: 20 }, () => 'Let me run.').join('\n')
  assert.ok(short.length < REPEAT_DEFAULTS.minChars)
  const detector = createRepeatDetector()
  detector.push(short)
  assert.equal(detector.chars(), short.length, '字符数应被统计')
})

test('边界：detector 在输出量达标后开始判定', () => {
  const detector = createRepeatDetector()
  const filler = 'a'.repeat(REPEAT_DEFAULTS.minChars)
  detector.push(filler)
  // 达标之后继续喂循环文本，应当被抓到。
  const loop = Array.from({ length: 60 }, () => REAL_LOOP_BODY.join('\n')).join('\n')
  let hit = null
  for (let i = 0; i < loop.length && hit === null; i += 64) {
    hit = detector.push(loop.slice(i, i + 64))
  }
  assert.notEqual(hit, null)
})

test('参数自洽：窗口尺寸喂得饱两条检测线', () => {
  assert.ok(
    REPEAT_DEFAULTS.maxPeriod * REPEAT_DEFAULTS.minRepeats <= REPEAT_DEFAULTS.windowChars,
    '字符级：maxPeriod × minRepeats 必须 ≤ windowChars',
  )
  assert.ok(
    LINE_DEFAULTS.maxPeriodLines * LINE_DEFAULTS.minRepeats <= LINE_DEFAULTS.windowLines,
    '行级：maxPeriodLines × minRepeats 必须 ≤ windowLines',
  )
  assert.ok(REPEAT_DEFAULTS.minChars < REPEAT_DEFAULTS.windowChars, '检测门槛应低于窗口容量')
})

test('工具函数：significantLines 会丢掉空行与过短行', () => {
  const lines = significantLines('ok\n\n   \n},\nlet me run.\n', 4)
  assert.deepEqual(lines, ['let me run.'])
})

test('工具函数：estimateTokens 对宽窄字符给出保守估算', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abc'), 1)
  assert.equal(estimateTokens('hello world'), 3)
  assert.equal(estimateTokens('你好世界'), 4)
  assert.ok(estimateTokens('你好世界') > estimateTokens('abcd'), '同长度的中文必须比英文贵')
})
