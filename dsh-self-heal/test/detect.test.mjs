/**
 * dsh-self-heal 检测内核自测（复读识别）。
 *
 * 运行：node --test test/
 *
 * 测试分四组：
 *   1. 不误报 —— 真实形态的正常长输出必须一次都不触发；
 *   2. 必触发 —— 各种形态的复读必须被抓到（含真实事故文本）；
 *   3. 边界与极端 —— 刚好在门槛上、超长单行、超大单块、空输入；
 *   4. 性能 —— 每个 token 级分片都要过一遍 push()，所以必须有速度保证。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LINE_DEFAULTS,
  REPEAT_DEFAULTS,
  SENTENCE_LOOP_DEFAULTS,
  TOOL_LOOP_DEFAULTS,
  UNFINISHED_DEFAULTS,
  createRepeatDetector,
  createSentenceLoopDetector,
  createToolLoopTracker,
  detectInTail,
  detectSentenceLoop,
  detectUnfinished,
  findRepeatingLineBlock,
  findRepeatingPeriod,
  significantLines,
} from '../lib/detect.js'
import { fenceStraddlingReport } from './harness.mjs'

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
  // 构造大量 "    }" / "  }" 交替 —— 这类低信息量周期必须被 minPatternDistinct 挡掉。
  const chunks = []
  for (let i = 0; i < 400; i += 1) {
    chunks.push('    ' + '}'.repeat(1 + (i % 3)))
    chunks.push('  }')
  }
  const text = chunks.join('\n')
  assert.ok(text.length > 3000, '样本应足够长，实际 ' + text.length)
  assert.equal(judge(text), null)
})

test('正常内容不误报：Markdown 分隔线与长等号线', () => {
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
  assert.notEqual(judge(text), null, '单行复读必须被识别')
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
// 3. 边界与极端
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

test('边界：reset() 之后重新开始攒门槛', () => {
  const detector = createRepeatDetector()
  const loop = Array.from({ length: 200 }, () => 'Let me run.').join('\n')
  detector.push(loop)
  assert.ok(detector.chars() > 0)
  detector.reset()
  assert.equal(detector.chars(), 0)
  // 复位后只喂一点点：不该判定（门槛要重新攒）。
  assert.equal(detector.push('Let me run.'.repeat(3)), null)
})

test('极端：单行超长（10 万字符）既不能崩，也不该被当成复读', () => {
  // 一整行里字符各不相同 —— 没有周期，必须放行。
  const huge = Array.from({ length: 100000 }, (_, i) => String.fromCharCode(0x4e00 + (i % 2000))).join('')
  const hit = judge(huge)
  assert.equal(hit, null, '无周期的超长单行不得判为复读')
})

test('极端：一次喂入 100 万字符的单个分片', () => {
  const detector = createRepeatDetector()
  const text = variedProse(20000)
  assert.ok(text.length > 900000, '样本应接近或超过 100 万字符，实际 ' + text.length)
  const hit = detector.push(text)
  assert.equal(hit, null, '正常长文本不得误判')
  assert.equal(detector.chars(), text.length)
})

test('极端：空输入与非法输入一律返回未命中', () => {
  const detector = createRepeatDetector()
  assert.equal(detector.push(''), null)
  assert.equal(detector.push(null), null)
  assert.equal(detector.push(undefined), null)
  assert.equal(detector.push(12345), null)
  assert.equal(detector.chars(), 0, '非法输入不得被计入字符数')
  assert.equal(findRepeatingPeriod(''), 0)
  assert.equal(judge(''), null)
})

test('极端：刚好等于最小周期长度的重复（边界内命中）', () => {
  const unit = 'abcdefgh' // 正好 minPeriod = 8
  const text = unit.repeat(REPEAT_DEFAULTS.minRepeats + 2)
  assert.ok(distinctEnough(unit), '样本周期需满足不同字符数下限')
  assert.ok(findRepeatingPeriod(text, REPEAT_DEFAULTS) > 0, '正好门槛长的周期也应命中')
})

test('极端：低信息量周期被刻意放过（不误伤分隔线）', () => {
  const text = '-'.repeat(REPEAT_DEFAULTS.minChars + 5000)
  assert.equal(judge(text), null, '纯分隔线不得触发熔断')
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

// ---------------------------------------------------------------------------
// 4. 未完成识别（「说了一半就停」）
//
//    这一组里**「不命中」比「命中」更重要**：误报会让正常回答被追着让模型继续说，
//    比原来的毛病更烦人。所以每条命中用例都配了对应的「正常情况必须放过」。
// ---------------------------------------------------------------------------

test('未完成：被长度上限截断 → 必报（不需要看正文）', () => {
  const hit = detectUnfinished('max-tokens', '')
  assert.equal(hit.reason, 'max-tokens')
  assert.equal(typeof hit.detail, 'string')
})

test('未完成：代码围栏没闭合 → 报', () => {
  const hit = detectUnfinished('stop', '下面给出改法：\n```js\nconst a = 1\n')
  assert.equal(hit.reason, 'open-code-fence')
})

test('未完成：代码围栏成对闭合 → 不报（这是最常见的正常收尾之一）', () => {
  assert.equal(detectUnfinished('stop', '下面给出改法：\n```js\nconst a = 1\n```\n'), null)
  // 两个代码块（4 个围栏）同样不报。
  assert.equal(detectUnfinished('stop', '```\na\n```\n```\nb\n```\n'), null)
})

test('未完成：停在逗号 / 冒号上 → 报', () => {
  assert.equal(detectUnfinished('stop', '这个函数的作用是把输入转换成输出，').reason, 'dangling-punctuation')
  assert.equal(detectUnfinished('stop', '结论如下：').reason, 'dangling-punctuation')
  assert.equal(detectUnfinished('stop', 'and then we need to,').reason, 'dangling-punctuation')
})

test('未完成：省略号与句号结尾都算正常收尾 → 不报', () => {
  assert.equal(detectUnfinished('stop', '大概就是这样吧…'), null, '省略号是正常语气收尾')
  assert.equal(detectUnfinished('stop', '以上就是全部改动，测试都通过了。'), null)
})

test('未完成：最后一句是自我承诺 → 报（真实事故原话）', () => {
  const screenshot = '先确认 README 第二节的真实设置项，避免我写的新表与它不符。'
  const hit = detectUnfinished('stop', screenshot)
  assert.equal(hit.reason, 'pending-promise')
  assert.ok(hit.detail.includes('先确认'), '说明里要带上那句原话，便于排查')
})

test('未完成：中英文承诺句式都要认', () => {
  for (const text of ['下一步我准备重构这一块。', 'Let me run the tests.', "I'll check the config first.", '让我先读一下这个文件。']) {
    const hit = detectUnfinished('stop', text)
    assert.equal(hit?.reason, 'pending-promise', '应当命中：' + text)
  }
})

test('未完成：对用户说「你可以先确认一下」→ 不报（那是在正常交代，不是没写完）', () => {
  assert.equal(detectUnfinished('stop', '你可以先确认一下配置。'), null)
  assert.equal(detectUnfinished('stop', '接下来你需要在设置里打开这一项。'), null)
})

test('未完成：以问句收尾 → 不报', () => {
  assert.equal(detectUnfinished('stop', '你觉得这样改行吗？'), null)
})

test('未完成：以表格 / 列表 / 短行收尾 → 不报（刻意不做「没句号就算没说完」）', () => {
  assert.equal(detectUnfinished('stop', '| 项目 | 结果 |\n| --- | --- |\n| A | 通过 |\n'), null)
  assert.equal(detectUnfinished('stop', '- 第一项\n- 第二项\n'), null)
  assert.equal(detectUnfinished('stop', 'done\n'), null)
})

test('未完成：只有 stop 才走启发式，aborted / error / 缺失一律不插手', () => {
  const half = '这个函数的作用是把输入转换成输出，'
  assert.equal(detectUnfinished('aborted', half), null)
  assert.equal(detectUnfinished('error', half), null)
  assert.equal(detectUnfinished(undefined, half), null, '没收到结束标记时无从判断，宁可漏')
})

test('未完成：空文本或纯空白 → 不报', () => {
  assert.equal(detectUnfinished('stop', ''), null)
  assert.equal(detectUnfinished('stop', undefined), null)
  assert.equal(detectUnfinished('stop', '   \n\n\t '), null)
})

test('未完成：promises 关掉后，只有「自我承诺」这一条失效，其余照常', () => {
  const opts = { detectPromises: false }
  assert.equal(detectUnfinished('stop', '先确认一下配置。', opts), null)
  assert.equal(detectUnfinished('stop', '下面给出改法：\n```js\nlet a = 1\n', opts).reason, 'open-code-fence')
  assert.equal(detectUnfinished('stop', '话说到一半，', opts).reason, 'dangling-punctuation')
  assert.equal(detectUnfinished('max-tokens', '', opts).reason, 'max-tokens')
})

test('未完成：标点与承诺句式只看尾部窗口，前面写得再长也不影响判定', () => {
  const long = variedProse(4000) // 远大于默认窗口
  assert.ok(long.length > UNFINISHED_DEFAULTS.tailChars, '样本必须超过窗口，否则测不到裁剪')
  // 正常收尾的长回答：哪怕正文有几十万字，也不该被判为没写完。
  assert.equal(detectUnfinished('stop', long + '以上，改动完成。'), null)
  // 半截收尾：窗口裁过之后，尾巴上的逗号仍然要能认出来。
  assert.equal(detectUnfinished('stop', long + '接下来还需要，').reason, 'dangling-punctuation')
  // 注意：**围栏判据不看窗口**，它必须从代码块之外数起 —— 见下面那组回归用例。
})

/** 数一段文本里 ``` 出现的次数（测试自己的小工具，不依赖被测代码）。 */
function fencesIn(text) {
  let count = 0
  let at = text.indexOf('```')
  while (at !== -1) {
    count += 1
    at = text.indexOf('```', at + 3)
  }
  return count
}

// 「窗口劈开代码块」的现场样本与链路测试共用一份（见 harness.mjs 的
// fenceStraddlingReport），避免测试与诊断脚本各写一份、慢慢跑偏。

test('未完成：★ 窗口劈开代码块时，闭合的报告绝不能被判成「没写完」（真实事故回归）', () => {
  const text = fenceStraddlingReport()
  assert.ok(text.length > UNFINISHED_DEFAULTS.tailChars, '样本必须超过判定窗口')
  assert.equal(fencesIn(text) % 2, 0, '样本全文必须是闭合的（偶数个围栏）')

  const window = text.slice(-UNFINISHED_DEFAULTS.tailChars)
  assert.equal(fencesIn(window) % 2, 1, '样本必须真的把一对围栏劈开，否则测不到这个 bug')

  assert.equal(detectUnfinished('stop', text), null, '闭合的完整报告不得被判为没写完')
})

test('未完成：真未闭合的代码块仍然要认（修完窗口劈开，别把功能修没了）', () => {
  const text = '下面给出改法。\n\n```js\n' + 'const a = 1\n'.repeat(400)
  assert.equal(fencesIn(text), 1, '样本只有一个围栏 —— 确实是开围栏没关')
  assert.equal(detectUnfinished('stop', text).reason, 'open-code-fence')
})

test('未完成：缓冲被截断时，围栏判据让位（开头在不在代码块里无从得知）', () => {
  const text = '下面给出改法。\n\n```js\n' + 'const a = 1\n'.repeat(400)
  // 缓冲装不下、前面已被丢弃时，「从代码块之外数起」这个前提不成立 —— 宁可漏判。
  assert.equal(detectUnfinished('stop', text, { bufferTruncated: true }), null)
  // 同一段文本，只要缓冲完整（= 有全文），就照常命中。
  assert.equal(detectUnfinished('stop', text).reason, 'open-code-fence')
})

test('未完成：超长的「承诺句」不参与判定（避免偶然用词误报）', () => {
  const promise = '让我去看一下配置文件'
  assert.equal(detectUnfinished('stop', '开头一句。' + promise).reason, 'pending-promise', '短句里的承诺应当命中')

  // 同样的句式，但这一句拖到 200 字符以上 —— 那更像整段论述里的偶然用词，不判。
  const longOne = '开头一句。' + promise + '，' + '细节'.repeat(120)
  assert.ok(longOne.length > 200, '样本必须超过承诺句长度上限')
  assert.equal(detectUnfinished('stop', longOne), null)
})

test('参数自洽：未完成识别的默认参数合理', () => {
  assert.ok(UNFINISHED_DEFAULTS.tailChars >= 1024, '窗口太小会看不到尾巴')
  assert.equal(UNFINISHED_DEFAULTS.detectPromises, true)
  assert.ok(
    UNFINISHED_DEFAULTS.bufferChars > UNFINISHED_DEFAULTS.tailChars,
    '缓冲必须比判定窗口长，否则围栏配对又会从窗口中间数起（真实事故的根因）',
  )
  assert.equal(UNFINISHED_DEFAULTS.bufferTruncated, false, '默认按「传进来的就是全文」处理')
})

// ---------------------------------------------------------------------------
// 5. 短句打转（「好。／行动。／（调用。）／NOW.」几百行）
//
//    与上一组同样的取向：**「不许误报」比「必须命中」更重要**。
//    打断一次正常输出是不可逆的（用户正看着回答就被掐断重来），所以下面这些
//    正常样本一个都不许被误判。**用户明确要求过：宁可漏判，也别打断。**
// ---------------------------------------------------------------------------

/**
 * 真实事故形态：每次措辞略有不同，但翻来覆去就是那几句超短句。
 * 原子取自真实截图（思考流里连着几百行）。
 */
function shortLoop(lines) {
  const atoms = [
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
  const out = []
  let seed = 20261009
  for (let i = 0; i < lines; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const pick = seed / 2147483648
    // 真实样本里「好。」占大头，这里也让它更频繁。
    out.push(atoms[pick < 0.45 ? 0 : Math.floor(pick * atoms.length)])
  }
  return out.join('\n')
}

/** 正常的对话式回复：短句很多，但每句内容都不同。 */
function chitChat() {
  const out = []
  for (let i = 1; i <= 80; i += 1) {
    out.push('好，我来看第 ' + i + ' 个文件里的 ' + ((i * 37) % 991) + ' 行配置。')
    out.push('这里的字段名和文档对不上第 ' + i + ' 处。')
    out.push('改成 ' + ((i * 53) % 997) + ' 之后就能跑通了。')
  }
  return out.join('\n')
}

/** 正常的步骤清单（行都很短）。 */
function checklist() {
  const out = []
  for (let i = 1; i <= 60; i += 1) {
    out.push(i + '. 打开第 ' + i + ' 个配置文件并检查端口 ' + (8000 + i) + ' 是否被占用')
  }
  return out.join('\n')
}

/** 正常代码（短行多、符号重复多）。 */
function sampleCode() {
  const out = []
  for (let i = 0; i < 200; i += 1) {
    out.push('function handler_' + i + '(req, res) {')
    out.push('  // 处理第 ' + i + ' 类请求')
    out.push('  if (!req.body) return res.status(400).end();')
    out.push('  return res.json({ ok: true, id: ' + i + ' });')
    out.push('}')
    out.push('')
  }
  return out.join('\n')
}

/** 正常表格。 */
function sampleTable() {
  const out = ['| 模块 | 状态 | 备注 |', '| --- | --- | --- |']
  for (let i = 1; i <= 60; i += 1) {
    out.push('| 模块' + i + ' | 通过 | 第 ' + i + ' 轮回归 |')
  }
  return out.join('\n')
}

/** 正常报告：短句多，但每句内容都不同。 */
function shortReport() {
  const out = []
  for (let i = 1; i <= 60; i += 1) {
    out.push('第 ' + i + ' 项通过。')
    out.push('耗时 ' + i * 7 + ' 毫秒。')
  }
  return out.join('\n')
}

/**
 * 口头禅型：同一句短句反复出现，但正文主体是正常长句。
 *
 * ⚠️ 这是第一版判据栽过的地方：只统计短句、把长句当分母丢掉的话，
 * 这条样本的「重复率」会算成 100%，直接误报。现在靠「短句密度」拦住它。
 */
function withCatchphrases() {
  const out = []
  for (let i = 1; i <= 60; i += 1) {
    out.push('好的。')
    out.push('第 ' + i + ' 个模块的检查结果是第 ' + ((i * 31) % 997) + ' 号状态，需要继续观察。')
  }
  return out.join('\n')
}

test('短句打转：真实形态必命中（400 行 / 800 行）', () => {
  for (const lines of [400, 800]) {
    const text = shortLoop(lines)
    const hit = detectSentenceLoop(text)
    assert.ok(hit !== null, lines + ' 行的短句打转必须被认出来（样本 ' + text.length + ' 字符）')
    assert.ok(hit.repeatRatio >= SENTENCE_LOOP_DEFAULTS.minRepeatRatio)
  }
})

test('短句打转：真实抄录片段（72 行，逐字）必命中', () => {
  const snippet = `好。
行动。
执行。
好。
我调用工具。
好。
Go.
（真的调用了。）好。
NOW.
（调用。）
好。
CALL.
我调用 write 工具写简体脚本。
好。
行动。
（调用。）
好。
我调用。
好。
（调用 write。）
好。
NOW!
（我停止循环。）
好，调用。
好。
行动。
我调用。
好。
（调用 write。）
好。
GO!
好。
（调用。）
好。
我调用 write 工具。
好。
行动。
（调用。）
好。
NOW.
好。
我调用。
（调用 write 工具。）
好。
CALLING.
好。
行动。
（调用。）
好。
我调用 write。
好。
（调用。）
好。
GO.
好，我调用工具。
好。
行动。
（调用。）
好。
NOW!
好。
（我直接调用 write 工具。）
好。
行动。
（调用。）
好。
CALL.
好。
行动。
（调用。）
好。
我调用 write 工具写脚本。`
  const hit = detectSentenceLoop(snippet)
  assert.ok(hit !== null, '逐字抄录的真实片段也必须命中')
  assert.ok(hit.topCount >= 10, '最高频句应当出现很多次，实际 ' + hit.topCount)
})

test('短句打转：正常输出一律放过（这是最重要的一组）', () => {
  assert.equal(detectSentenceLoop(variedProse(400)), null, '正常中文叙述')
  assert.equal(detectSentenceLoop(chitChat()), null, '短句很多的正常对话')
  assert.equal(detectSentenceLoop(checklist()), null, '步骤清单')
  assert.equal(detectSentenceLoop(sampleCode()), null, '代码')
  assert.equal(detectSentenceLoop(sampleTable()), null, '表格')
  assert.equal(detectSentenceLoop(shortReport()), null, '短句很多但各不相同的报告')
})

test('短句打转：口头禅不许误报（第一版判据的翻车点）', () => {
  assert.equal(
    detectSentenceLoop(withCatchphrases()),
    null,
    '「一句口头禅 + 一堆长句」是正常写法：短句密度不够，必须放过',
  )
})

test('短句打转：太短的输出根本不判', () => {
  assert.equal(detectSentenceLoop('好的。\n我看了一下。\n问题在配置里。\n已经修好了。'), null)
  assert.equal(detectSentenceLoop(''), null)
  assert.equal(detectSentenceLoop(undefined), null)
})

test('短句打转：关掉开关后完全不判', () => {
  assert.equal(detectSentenceLoop(shortLoop(400), { enabled: false }), null)
})

test('短句打转：必须连续两次判定都命中才动手（单次波动一律放过）', () => {
  // 只出现一小段重复、随后立刻恢复正常 —— 不允许打断。
  const brief = shortLoop(160) + '\n' + variedProse(200)
  const detector = createSentenceLoopDetector()
  let hitAt = 0
  for (let i = 0; i < brief.length; i += 16) {
    if (detector.push(brief.slice(i, i + 16)) !== null) {
      hitAt = detector.chars()
      break
    }
  }
  assert.equal(hitAt, 0, '短暂重复几句之后恢复正常，绝不能被打断')
})

test('短句打转：持续打转必须能在合理范围内被抓住', () => {
  const text = shortLoop(600)
  const detector = createSentenceLoopDetector()
  let hitAt = 0
  for (let i = 0; i < text.length; i += 16) {
    if (detector.push(text.slice(i, i + 16)) !== null) {
      hitAt = detector.chars()
      break
    }
  }
  assert.ok(hitAt >= SENTENCE_LOOP_DEFAULTS.minChars, '不该在门槛之前动手')
  assert.ok(hitAt < text.length, '持久打转必须被抓住（实际在 ' + hitAt + ' 字符处）')
})

test('短句打转：非法输入一律返回未命中', () => {
  const detector = createSentenceLoopDetector()
  assert.equal(detector.push(''), null)
  assert.equal(detector.push(null), null)
  assert.equal(detector.push(undefined), null)
  assert.equal(detector.push(12345), null)
  assert.equal(detector.chars(), 0, '非法输入不得计入字符数')
})

test('短句打转：门槛与确认轮数必须足够保守', () => {
  assert.ok(
    SENTENCE_LOOP_DEFAULTS.minChars < REPEAT_DEFAULTS.minChars,
    '短句打转的启动门槛应低于复读（否则同样的毛病要晚三千字符才被抓）',
  )
  assert.ok(SENTENCE_LOOP_DEFAULTS.confirmRounds >= 2, '至少要连续确认两次才允许打断用户')
  assert.ok(SENTENCE_LOOP_DEFAULTS.minShortRatio >= 0.8, '短句密度门槛必须够高，否则口头禅会误报')
  assert.ok(SENTENCE_LOOP_DEFAULTS.minRepeat >= 4, '同一句只说两三次不算打转')
  assert.ok(SENTENCE_LOOP_DEFAULTS.windowChars >= 4096, '窗口太小会看不到足够多的句子')
})

// ---------------------------------------------------------------------------
// 6. 工具调用打转（动作层）
//
//    这一层比文本层更容易误伤：「读文件 → 改文件 → 跑测试」本来就是正常的
//    干活方式。所以下面「参数不同就必须放过」的用例，比「必须命中」更重要。
// ---------------------------------------------------------------------------

/**
 * 把一串 `[工具名, 参数]` 依次喂进追踪器，返回最后一次命中（没有则 null）。
 * @param {Array} plan - 调用计划。
 * @param {object} [opts] - 阈值覆盖。
 * @returns {object|null} 命中描述。
 */
function feedTools(plan, opts) {
  const tracker = createToolLoopTracker(opts)
  let hit = null
  for (const [tool, args] of plan) hit = tracker.push({ tool, args }) ?? hit
  return hit
}

/** 造「重复 n 遍的两工具环」。 */
function twoToolCycle(n, path = 'src/a.js') {
  const plan = []
  for (let i = 0; i < n; i += 1) {
    plan.push(['read_file', { path }])
    plan.push(['edit_file', { path, from: 'x', to: 'y' }])
  }
  return plan
}

test('工具打转：同样的两工具环走三遍 → 提醒', () => {
  const hit = feedTools(twoToolCycle(3))
  assert.ok(hit !== null, '同样的工具、几乎同样的参数走了三遍，必须提醒')
  assert.equal(hit.kind, 'tool-cycle')
  assert.deepEqual(hit.cycle, ['read_file', 'edit_file'])
  assert.equal(hit.repeats, 3)
})

test('工具打转：三工具环（A→B→C）同样能认出来', () => {
  const plan = []
  for (let i = 0; i < 3; i += 1) {
    plan.push(['read_file', { path: 'a.js' }])
    plan.push(['edit_file', { path: 'a.js', from: 'x', to: 'y' }])
    plan.push(['bash', { command: 'npm test' }])
  }
  const hit = feedTools(plan)
  assert.ok(hit !== null)
  assert.deepEqual(hit.cycle, ['read_file', 'edit_file', 'bash'])
})

test('工具打转：参数每次都不一样 → 绝不提醒（这才是正常干活）', () => {
  const plan = []
  for (let i = 0; i < 5; i += 1) {
    plan.push(['read_file', { path: 'file-' + i + '.js' }])
    plan.push(['edit_file', { path: 'file-' + i + '.js', line: i * 10, from: 'aaa' + i, to: 'bbb' + i }])
  }
  assert.equal(
    feedTools(plan),
    null,
    '「读不同文件、改不同地方」是推进而不是卡住 —— 只看工具名就会在这里误报',
  )
})

test('工具打转：参数只差几个斜杠仍算同一件事（手滑不该算推进）', () => {
  const plan = []
  // 归一化只合并「连续斜杠」这类明显手滑的差异；对象参数本身会被 JSON.stringify
  // 规范化，所以这里用字符串参数来检验归一化确实生效。
  const variants = [{ path: 'src/a.js' }, { path: 'src//a.js' }, { path: 'src///a.js' }]
  for (let i = 0; i < 3; i += 1) {
    plan.push(['read_file', variants[i]])
    plan.push(['bash', { command: 'npm test' }])
  }
  assert.ok(feedTools(plan) !== null, '几乎一样的参数反复用，属于打转')
})

test('工具打转：两个目标严格交替三遍，也算环（同一个工具也一样）', () => {
  // ⚠️ 这条是**有意的**：`f0 → f1 → f0 → f1 → f0 → f1` 是一个真实的周期模式，
  // 哪怕工具名一直是 read_file。真正「读不同文件」的长这样：f0 → f1 → f2 → …
  // （见上一条用例，那种必须放过）。
  const plan = []
  for (let i = 0; i < 3; i += 1) {
    plan.push(['read_file', { path: 'file-0.js' }])
    plan.push(['read_file', { path: 'file-1.js' }])
  }
  const hit = feedTools(plan)
  assert.ok(hit !== null, '严格交替本身就是周期')
  assert.equal(hit.cycle.length, 2)
  assert.equal(hit.repeats, 3)
})

test('工具打转：只走两遍不提醒（还没到「卡住」的程度）', () => {
  assert.equal(feedTools(twoToolCycle(2)), null)
})

test('工具打转：同一个工具用不同参数连续调用不算环', () => {
  const plan = []
  for (let i = 0; i < 6; i += 1) plan.push(['read_file', { path: 'f' + i + '.js' }])
  assert.equal(feedTools(plan), null)
})

test('工具打转：提醒次数有上限（提醒本身会打断思路）', () => {
  const tracker = createToolLoopTracker()
  let count = 0
  const plan = []
  for (let i = 0; i < 20; i += 1) plan.push(...twoToolCycle(1))
  for (const [tool, args] of plan) if (tracker.push({ tool, args }) !== null) count += 1
  assert.equal(count, TOOL_LOOP_DEFAULTS.maxReminders, '最多提醒 maxReminders 次')
})

test('工具打转：关掉开关后完全不判', () => {
  assert.equal(feedTools(twoToolCycle(3), { enabled: false }), null)
})

test('工具打转：没有工具名的调用不参与判定', () => {
  const tracker = createToolLoopTracker()
  assert.equal(tracker.push({ args: { a: 1 } }), null)
  assert.equal(tracker.push({}), null)
  assert.equal(tracker.push(null), null)
  assert.equal(tracker.size(), 0, '无名调用不该占窗口')
})

test('工具打转：reset 之后重新开始', () => {
  const tracker = createToolLoopTracker()
  for (const [tool, args] of twoToolCycle(3)) tracker.push({ tool, args })
  tracker.reset()
  assert.equal(tracker.size(), 0)
  // 重置后再走两遍（不够三遍）不该提醒。
  let hit = null
  for (const [tool, args] of twoToolCycle(2)) hit = tracker.push({ tool, args }) ?? hit
  assert.equal(hit, null)
})

// ---------------------------------------------------------------------------
// 7. 性能
// ---------------------------------------------------------------------------

test('性能：10 万次小分片 push 必须很快（每个 token 级分片都会调它）', () => {
  const detector = createRepeatDetector()
  const piece = '这是一段正常的中文输出片段。'
  const rounds = 100000
  const startedAt = Date.now()
  for (let i = 0; i < rounds; i += 1) detector.push(piece)
  const elapsed = Date.now() - startedAt
  // 真实耗时在几十毫秒量级；3 秒是给慢机器留的极宽松上限。
  assert.ok(elapsed < 3000, '10 万次 push 耗时 ' + elapsed + 'ms，超出预期')
  assert.equal(detector.chars(), piece.length * rounds)
})

test('性能：判定一次的代价不随输出总长度增长（只看尾部窗口）', () => {
  const detector = createRepeatDetector()
  // 先灌一大段正常文本（几十万字符），再看 push 的边际耗时是否稳定。
  detector.push(variedProse(5000))
  const piece = '后续的补充说明文字，用于测量边际成本。'
  const startedAt = Date.now()
  for (let i = 0; i < 50000; i += 1) detector.push(piece)
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 3000, '5 万次 push 耗时 ' + elapsed + 'ms，超出预期')
})

/** 判断一个周期片段的不同字符数是否达到默认下限（供用例自检）。 */
function distinctEnough(text) {
  return new Set(text).size >= REPEAT_DEFAULTS.minPatternDistinct
}
