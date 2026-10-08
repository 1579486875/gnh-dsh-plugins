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
  UNFINISHED_DEFAULTS,
  createRepeatDetector,
  detectInTail,
  detectUnfinished,
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

test('未完成：只看尾部窗口，前面写得再长也不影响判定', () => {
  const long = variedProse(4000) // 远大于默认窗口
  assert.ok(long.length > UNFINISHED_DEFAULTS.tailChars, '样本必须超过窗口，否则测不到裁剪')
  // 正常收尾的长回答：哪怕正文有几十万字，也不该被判为没写完。
  assert.equal(detectUnfinished('stop', long + '以上，改动完成。'), null)
  // 半截收尾：窗口裁过之后，尾巴上的逗号仍然要能认出来。
  assert.equal(detectUnfinished('stop', long + '接下来还需要，').reason, 'dangling-punctuation')
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
})

// ---------------------------------------------------------------------------
// 5. 性能
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
