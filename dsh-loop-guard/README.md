# dsh-loop-guard

给 DSH 加一层「防跑飞」护栏。它补的是 DSH 现成配置**管不到**的三道口子。

## 它解决什么问题

翻车现场长这样：接了一个第三方中转模型进 DSH，让它统计个数据，结果模型陷进
推理循环，单次请求吐出几千万 token（截图里是 `2,587,940,600 / 47,049,847`，
485050 t/s），账号直接被刷到欠费。

DSH 原本已经有一些保护，但它们各自有明确的作用域：

| 层 | 机制 | 怎么被绕过去 |
|---|---|---|
| 单次请求输出 | `llm-deepseek.maxTokens`（默认 256000） | 第三方网关**直接忽略**请求里的上限字段 |
| 流空闲 | `streamIdleTimeoutMs`（默认 5 分钟） | 只判「不吐字」；持续吐字时永不触发 |
| 工具重复 | `dsh-repeat-tool-reminder`（3/5/8 次） | 只发**提醒**，模型不理它就继续转 |

于是剩下三件事没人管，本插件就管这三件：

1. **流内输出硬上限** —— 客户端自己数，不信服务端会守约；
2. **复读熔断** —— 正面对付「思考打转」，这是事故的正主；
3. **墙钟总时长超时** —— 兜底「一直吐字、永不空闲」这类卡死。

## 三道闸门

| 闸门 | 默认值 | 触发条件 | 熔断 code |
|---|---|---|---|
| 输出上限 | 300000 tokens | 单次请求累计输出（含推理与工具参数）超过阈值 | `LOOP_GUARD_OUTPUT_LIMIT` |
| 复读熔断 | 开 | 尾部出现稳定重复周期（字符级或行级） | `LOOP_GUARD_REPEAT` |
| 墙钟超时 | 1800000 ms（30 分钟） | 单次请求从开始到结束超过阈值 | `LOOP_GUARD_TIMEOUT` |

`maxOutputTokens` 刻意略高于 `llm-deepseek` 自己的 256000，这样在官方路由上
由提供方先以 `max-tokens` 正常收尾，护栏只在下游不守约时才出手。

### 复读检测怎么做的

两条线并行，任一命中即熔断：

- **字符级**：在尾部窗口内从短到长枚举候选周期，只要连续 `minRepeats`
  段完全一致就判命中。抓短周期复读（同一句话反复念）。
- **行级**：把尾部切成有效行，寻找最小的「行块周期」。抓循环体很长、
  字符窗口装不下的多行循环 —— 事故里那种 15~18 行的英文推理反复念，
  正好只能靠这条线抓到。

两条线都**不要求周期在末尾对齐**。这一点是必须的：流式输出常常停在半行或
半句话上，末尾也可能挂着一句收尾语（实测中子代理就诚实地在复读末尾加了一个
`VERIFY-OK` 标记）。只认「末尾对齐」会让这类循环整个漏掉，所以判定会从末尾
往回尝试若干偏移（`maxOffsetChars` / `maxOffsetLines`）。偏移只放宽起点，
不放宽「连续 N 段完全相同」这个要求，因此不会明显抬高误报。

> 这个对齐问题正是**端到端验证**抓出来的：单元测试当时的样本末尾恰好对齐，
> 27 个用例全绿；真实子代理的输出末尾多了一句收尾语，检测器就完全失灵。
> 现在有 4 个专门的回归用例钉住它。

检测只在输出累计超过 `minChars` 之后才启动，并且每新增 `checkEveryChars`
才判一次，因此在每个 token 级 delta 上调用也很便宜。

## 熔断时会发生什么

护栏**不抛异常**，而是把上游流关掉，然后补一个终止 `finish` 分片：

```js
{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }
```

两个刻意的选择：

- `reason.kind` 用 `'error'`，因此 `dsh-llm` 自己的流协议不变式照常通过
  （它允许 error/aborted 在块未闭合时终止）；
- `failure.code` 用 `LOOP_GUARD_*` 前缀，**刻意避开** `dsh-llm-retry` 的默认
  可重试白名单（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`），
  所以熔断不会被重试放大成 5 倍账单。

同时按 `logTrips` 往日志写一行诊断，包含路由、原因、已输出量、耗时。

## 安装位置与挂载层

- 插件本体：`%USERPROFILE%\.dsh\external\dsh-loop-guard`
- 通过 junction 挂进 `profiles/web/node_modules/dsh-loop-guard`
- 登记为 profile 的 bundle（`profiles/web/package.json` 的
  `dependencies` + `dsh.profile.bundles`）

**挂在 host 平面是有意为之**：护栏要覆盖「所有会话 × 所有子代理 × 所有辅助
模型调用（标题生成、压缩摘要）」的每一次模型请求，这正是 host 组合的职责。
放进 agent 预设的话每个会话各拿一份实例，既覆盖不全，也会在第二次挂载冲突。

## 配置

默认走插件自带值，不用配。要调就在 `profiles/web/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: loop-guard
  config:
    enabled: true
    maxOutputTokens: 120000
    maxDurationMs: 900000
    logTrips: true
    repeat:
      minChars: 4000
      checkEveryChars: 2000
      windowChars: 16384
      minPeriod: 8
      maxPeriod: 256
      minRepeats: 12
      minPatternDistinct: 4
    lines:
      enabled: true
      windowLines: 240
      maxPeriodLines: 24
      minRepeats: 5
      minLineChars: 4
```

注意 patch 语义是**整体替换 config**（不是深合并），所以要重述每一项想保留的
字段。只接受已知键且类型正确的覆盖，写错的项会被静默忽略并保留默认值 ——
这是有意的，免得一条坏 YAML 让护栏带着 `NaN` 静默失效。

设 `enabled: false` 可以整体关掉。

## 已知盲区

诚实列出边界，避免把它当万能保险：

1. **只做精确重复匹配。** 措辞略变的循环（每轮换几个字）会绕过检测。
   这类只能靠输出上限和时长兜底。
2. **低信息量周期被刻意放过。** 循环体内不同字符少于 `minPatternDistinct`
   （默认 4）时跳过，例如连续几百个 `=` 或 `-`。这是为了不误伤 Markdown
   分隔线和代码缩进。
3. **输出短于 `minChars`（默认 4000 字符）完全不检测。** 短回答即使重复也
   不值得打断 —— 几千 token 的损失可以接受，误熔断的干扰不能接受。
4. **工具参数不参与复读判定**（仍计入 token 上限）。批量生成同构记录是合法
   用法，交给输出上限兜底更合适。
5. **没有跨轮会话预算。** 每次模型请求独立计数；多轮慢慢烧不在本插件的
   覆盖范围内。

阈值取向是「宁可放过一句废话，不可放过一次复读」：真循环会让账单指数级膨胀，
而一次误熔断最多让你重发一次请求。

## 自测

```powershell
cd %USERPROFILE%\.dsh\external\dsh-loop-guard
node --test test/detect.test.mjs test/integration.test.mjs
```

31 个用例，分四组：

- **不误报**：中文任务清单、Python 代码、Markdown 表格、同构 JSON 数组、
  深层缩进括号、分隔线 —— 都必须一次都不触发；
- **必触发**：真实事故文本（15 行推理循环 × 6）、单行重复、两行交替、中文
  复读、超长行循环、7 字符分片流式喂入 —— 都必须抓到；
- **末尾偏移回归**：收尾语尾巴、半行截断、行级靠偏移命中、字符级容忍偏移；
- **契约**：正常流逐块原样放行、熔断后上游被关闭、所有 code 避开重试白名单、
  配置只接受已知键。

想看检测器在**真实循环文本**上的触发点，跑诊断脚本：

```powershell
node test/diagnose.mjs
```

它会打印「多少遍 / 多少字符时熔断」，并对比「末尾正好对齐」与「末尾多一句
收尾语」两种情况 —— 后者曾经会让检测整个失灵。

## 排查

启动日志里看到这行就说明插件已加载：

```
loop-guard: 护栏已就位（输出上限 300000 tokens，墙钟上限 1800s，复读检测 开）。
```

看不到就重启一次 DSH（新插件的包实体通常不在热重载范围内）。

验证组合是否包含本插件：

```powershell
node '%USERPROFILE%\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile web --dump-config | Select-String loop-guard
```

## 卸载

1. 从 `profiles/web/cordis.patch.yml` 删掉相关配置块；
2. 从 `profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles`
   里移除 `dsh-loop-guard`；
3. 删掉 `profiles/web/node_modules/dsh-loop-guard` 这个 junction
   （注意删链接，别删到 external 里的源码）。
