# dsh-rimcrow-tools

把 **RimCrow** 里的 7 个「AI 可用模组工具」搬进 DSH，注册为模型工具。
装在**宿主组合层**（host composition），因此**所有配置（预设）、所有会话**都能按需调用。

全部 **纯只读**：只读取 RimCrow / RimWorld 的文件与 SQLite，不写入、不修改任何数据。

## 安装位置

```
%USERPROFILE%\.dsh\external\dsh-rimcrow-tools\      ← 本插件（DSH 用户级扩展目录）
%USERPROFILE%\.dsh\profiles\web\package.json        ← 已登记为 web profile 的 bundle
```

`~/.dsh/external/` 是 DSH 放置本地/外部插件的目录，不受工作区清理影响，
也不会随 npx 缓存失效（npx 目录只是启动器缓存）。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `package.json` | 插件清单，`dsh.bundle.patch` 指向挂载声明 |
| `cordis.patch.yml` | bundle patch：向 profile 配置树 insert 一行 |
| `lib/index.js` | Cordis Host 插件：注册 7 个模型工具（仅用 node: 内置模块） |
| `data/rimcrow-data.mjs` | 只读查询后端：所有数据访问与文本渲染 |
| `backup/` | 安装前的 profile 清单备份 |

## 提供的工具

| 工具名 | 中文名 | 主要参数 | 数据来源 |
| --- | --- | --- | --- |
| `get_active_mod_list` | 当前启用列表 | `query` / `offset` / `limit` | `ModsConfig.xml` 的 `activeMods` + `modasset` |
| `get_mod_info` | 模组元数据 | `query`(必填) / `brief` | `mod_manager.db` → `modasset` + `usermoddata` |
| `get_mod_rules` | 模组规则 | `query` | `communityRules.json` / `user_rules.json` / `modasset` |
| `search_mods` | 搜索模组 | `query`(必填) / `limit` / `scope` | `modasset` + `workshop_cache.db`（约 5.7 万条工坊索引） |
| `get_group_mods` | 分组模组 | `query` | `groupdata` + `groupmod` |
| `get_mod_user_data` | 模组用户数据 | `query` / `offset` / `limit` | `usermoddata`（别名、备注、标签、忽略问题） |
| `get_log_context` | 日志上下文 | `mode` / `source` / `lines` / `level` / `pattern` / `includeDetails` / `groupBy` / `topN` / `since` / `until` / `bucket` / `maxScanMB` | `RimCrow_Realtime.log`、`data/logs/app.log` |

## 生效方式

装好后**重启一次 DSH** 即可全局生效（bundle 列表在启动时构建配置树）。
重启后新开任何配置（预设）的会话，都能直接使用这 7 个工具；无需逐个改预设。

## 管理命令

```powershell
# 卸载
node "$env:LOCALAPPDATA\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile web remove dsh-rimcrow-tools

# 查看组合后的配置树（确认插件行存在）
node "$env:LOCALAPPDATA\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile web --dump-config
```

## 路径发现

RimCrow 的数据目录**不固定在** `%LOCALAPPDATA%\RimCrow` —— 它可以装在任意位置
（本机就是 `桌面\其他杂项\游戏和模组启动器及管理工具\RimModManager`）。
因此后端按下面的顺序逐级探测，判定条件是**该目录下存在 `data\mod_manager.db`**：

1. `RIMCROW_HOME` 环境变量（显式指定，最高优先）
2. 缓存文件 `%USERPROFILE%\.dsh\rimcrow-tools\home.txt`（上次探测成功的结果，命中即返回）
3. 常见安装位：`%LOCALAPPDATA%\RimCrow`、`%APPDATA%\RimCrow`、
   `%LOCALAPPDATA%\Programs\RimCrow`、`%ProgramFiles%\RimCrow`、
   `%ProgramFiles%\RimModManager`、`%ProgramFiles(x86)%\RimCrow`
4. **正在运行的 `RimCrow` 进程**：取其可执行文件路径的父目录（最准，需要起一次 PowerShell，超时 6 秒）
5. `Desktop` / `OneDrive\Desktop` / `Public\Desktop` 下的浅层扫描（最多 3 层）

第 4、5 步命中后会写回缓存文件，之后每次调用直接命中，单次约 70–120 ms。
若 RimCrow 换了位置，把 `home.txt` 删掉或改内容即可，下次自动重新探测；
也可以用 `RIMCROW_HOME` 或 `RIMCROW_HOME_CACHE` 两个环境变量覆盖。

RimWorld 用户目录（`ModsConfig.xml` 与实时日志所在处）：
`RIMWORLD_USER_DIR` → 档案 `profile.json` 里的 `user_data_path`
→ 默认 `%USERPROFILE%\AppData\LocalLow\Ludeon Studios\RimWorld by Ludeon Studios`。

SQLite 一律以 `readOnly: true` 打开；若 WAL 模式下只读打开不可用会退化为普通连接（仍不执行任何写操作）。

## 已知数据口径

- `modasset` 里同一 `packageId` 可能有多条记录（本地副本 / 工坊 / 多个版本目录），
  `search_mods` 按 `packageId` 去重后再输出。
- 「启用中 / 已停用」以 `ModsConfig.xml` 的 `activeMods` 为准，**不是** `modasset.disabled`
  （后者实测恒为 0，不可用于判断）。读不到 `ModsConfig.xml` 时才退回 `disabled`。

## 性能

单次查询约 70–120 ms（Node 启动 + 只读 SQLite 查询 + 文本渲染）。
列表类工具默认分页（启用列表 50 条/页、搜索 20 条、用户数据 30 条）。

## 设计说明

插件刻意**只使用 `node:` 内置模块**，不 import 任何 `@deepseek-ai/*` 包：
外部 bundle 的模块解析依赖 profile 的 module fallback，零依赖可完全规避该类风险。
工具定义按 `ToolRuntime.register` 的契约手写，`parameters` 与 `output.schema`
均为受支持子集内的标准 JSON Schema（已用真实 `assertSupportedJsonSchema` 校验通过）。

## 日志聚合模式（v1.1 新增）

`get_log_context` 现在支持两种模式：

| 模式 | 说明 | 典型用途 |
| --- | --- | --- |
| `mode: "recent"`（默认） | 读取尾部约 4 MB，返回最近 N 条，可带堆栈 | 看"刚刚发生了什么" |
| `mode: "aggregate"` | **全量扫描整份日志**并分组统计 | 一次性看清所有红字、谁引起的、集中在何时 |

### 聚合维度（`groupBy`，默认 `all`）

- `pattern` —— 错误**模式**分组：抹掉数字/引号/长标识符后归并同类，给出次数、首末时间、样本、**高频取值**
- `mod` —— **模组归属**分组：从堆栈命名空间、`Mod X has multiple`、`file:` 路径（自动识别 `工坊 <ID>` 与本地模组目录名）、日志的 `relatedModIds` 归因
- `time` —— **时间段**分布（`bucket`: `hour` / `minute` / `day`）
- `level` —— 级别计数

### 其它过滤与调优参数

- `level`（聚合默认 `error`，`warning` 会包含 error）、`pattern`（关键词，匹配消息/堆栈/上下文）
- `since` / `until` —— 时间段，格式 `"YYYY-MM-DD HH:MM"`
- `topN` —— 每个分组返回条数（默认 20，最大 100）
- `maxScanMB` —— 只扫描尾部多少 MB，`0`=全量（默认）

### 调用示例

```
get_log_context { "mode": "aggregate" }                                  # 全貌
get_log_context { "mode": "aggregate", "groupBy": "mod", "topN": 30 }    # 谁在报错
get_log_context { "mode": "aggregate", "since": "2026-09-16 20:00", "until": "2026-09-16 21:00" }
get_log_context { "mode": "aggregate", "level": "warning", "groupBy": "pattern" }
get_log_context { "mode": "aggregate", "pattern": "miho", "topN": 5 }    # 只关心某个模组
```

### 性能

全量扫描 51.8 MB / 12653 条记录约 **400 ms**；指定 `maxScanMB` 可进一步加速。

### 输出要点

每条模式除了次数与样本，还会给出：

- **归属** —— 该模式下出现过的模组命名空间 / 工坊 ID
- **出错文件** —— 从 `file:` 提取的真实文件路径
- **高频取值** —— 被归一化抹掉的具体值（例如重复的 Def 类型、缺失的 Def 名），这是定位根因最直接的线索