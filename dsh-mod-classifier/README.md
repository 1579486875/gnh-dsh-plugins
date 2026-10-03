# dsh-mod-classifier

把 **RimWorld 模组分类器**装进 DSH，注册为模型工具，**所有预设、所有会话**都能调用。
用来干三件事：给模组规划归类、按**内容**校验归类对不对、维护分类规则。

对 RimCrow / RimWorld 数据**全程只读**；唯一会写的是本插件自带的 `rules/rules.json`（分类规则表）。
真正改分组仍走官方 MCP 工具（`mcp__rimcrow__create_group` / `add_mods_to_group` / `remove_mods_from_group`）。

## 安装位置

```
%USERPROFILE%\.dsh\external\dsh-mod-classifier\      ← 本插件（DSH 用户级扩展目录，不受工作区清理影响）
%USERPROFILE%\.dsh\profiles\web\package.json         ← 已登记为 web profile 的 bundle
```

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `package.json` | 插件清单，`dsh.bundle.patch` 指向挂载声明 |
| `cordis.patch.yml` | bundle patch：向 profile 配置树 insert 一行 |
| `lib/index.js` | Cordis Host 插件：注册 4 个模型工具（仅用 node: 内置模块） |
| `data/classify-data.mjs` | 只读后端：读 RimCrow SQLite + 跑分类规则 + 校验 |
| `rules/rules.json` | **分类规则表**：关键词规则（按顺序命中）、精确覆盖表、内容校验主题词 |

## 提供的工具

| 工具名 | 作用 | 数据来源 |
| --- | --- | --- |
| `mod_classify_scan` | 全库扫描归类：按规则算出「组名 → 模组清单」、每组数量、未归类项 | `modasset` |
| `mod_classify_check` | **内容校验**：拿模组描述与所在组主题词比对，列出"名不副实"的可疑项与建议归属 | `modasset` + `groupdata`/`groupmod` |
| `mod_classify_explain` | 单模组诊断：描述、当前组、命中规则、建议归属、同组邻居 | 同上 |
| `mod_classify_rules` | 规则维护：查看/增删关键词、维护精确覆盖与主题词表 | `rules/rules.json` |

## 规则表怎么工作

`rules.json` 三块内容：

1. **`rules`** —— 有序规则块，**顺序即优先级，先命中先赢**。每块是 `{ group, keys: [...] }`，
   用关键词匹配「packageId + 中文别名 + 英文名」的小写拼接串；另有 `{ fn: "separator" }` 这类特殊规则，
   用正则识别分隔符模组（`=====`、`/*****`、`-----` 开头的标题）。
2. **`overrides`** —— 精确覆盖表（`packageId → 组名`），优先级最高，用于关键词规则抓不准的特例。
3. **`hints`** —— 每组的内容校验主题词，供 `mod_classify_check` 判断"描述与类目是否对得上"。

调整建议：**优先改 `overrides`**（精确、无副作用）；只有某类模组成批归错时才动 `rules`，
因为关键词是子串匹配，放宽容易连带误伤（历史上的"温泉 → 能源"就是这么来的）。

## 生效方式

装好后**重启一次 DSH**（bundle 列表在启动时构建配置树）。
之后新开任何预设的会话都能直接调用这 4 个工具，无需逐个改预设。

## 管理命令

```powershell
# 查看组合后的配置树（确认插件行存在）
dsh --profile web --dump-config

# 卸载
dsh plugin --profile web remove dsh-mod-classifier
```

## 路径发现

`mod_manager.db` 按以下顺序定位，可用环境变量 `RIMCROW_HOME` 覆盖：

1. `RIMCROW_HOME`
2. `<RimCrow 安装目录>`
3. `<RimCrow 安装目录>`
4. `%LOCALAPPDATA%\RimCrow`、`%APPDATA%\RimCrow`

判定条件：目录下存在 `data\mod_manager.db`。SQLite 一律以 `readOnly: true` 打开。

## 设计说明

- 刻意**只使用 `node:` 内置模块**（`node:sqlite`、`node:fs`、`node:path`），不 import 任何 `@deepseek-ai/*` 包，
  以规避外部 bundle 的模块解析问题。
- 工具定义按 `ToolRuntime.register` 契约手写，`parameters` 与 `output.schema` 均为标准 JSON Schema。
- 分组数据始终以 RimCrow 为唯一真源：本插件只读，写入交给官方 MCP，桌面端与 AI 不会各说各话。
