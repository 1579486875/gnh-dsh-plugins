# GNH · DSH 插件合集

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的一组自研 Host 插件。
每个插件都是**零依赖**（只用 Node 内置模块）的独立 bundle，可以单独安装，也可以整仓库取用。

| 插件 | 版本 | 作用 |
| --- | --- | --- |
| [dsh-loop-guard](dsh-loop-guard) | 0.1.0 | **防跑飞护栏**：单次请求输出上限、复读（思考循环）熔断、墙钟总时长超时 |
| [dsh-rimcrow-tools](dsh-rimcrow-tools) | 1.1.0 | 把 RimCrow 的 7 个模组工具注册为 DSH 模型工具（全程只读） |
| [dsh-mod-classifier](dsh-mod-classifier) | 1.0.0 | RimWorld 模组分类器：全库扫描归类、按内容校验、单模组诊断、规则维护 |
| [dsh-cherry-kb-bridge](dsh-cherry-kb-bridge) | 0.1.0 | 把 Cherry Studio 本地知识库桥接为 DSH 模型工具（只读，FTS5 全文检索） |
| [dsh-electron-env-fix](dsh-electron-env-fix) | 0.1.0 | 修掉 DSH 桌面端 `ELECTRON_RUN_AS_NODE` 环境污染，让「用外部应用打开」能启动 VS Code 等 |

## 安装

用 DSH 的 `plugin_manager` 以本地目录安装（把 `<插件目录>` 换成本仓库中对应插件的绝对路径）：

```
plugin_manager  action: install_bundle
                target: <插件目录>
```

或者手工登记为 profile 依赖：

```powershell
dsh plugin --profile <profile> add link:<插件目录>
```

安装后**需要重启 DSH Host** 才会加载插件代码。

## 环境变量

| 插件 | 变量 | 说明 |
| --- | --- | --- |
| dsh-rimcrow-tools / dsh-mod-classifier | `RIMCROW_HOME` | RimCrow 安装目录（默认按 `%LOCALAPPDATA%\RimCrow` 等常见位置探测） |
| dsh-rimcrow-tools | `RIMWORLD_USER_DIR` | RimWorld 用户目录（默认 `%USERPROFILE%\AppData\LocalLow\Ludeon Studios\...`） |
| dsh-cherry-kb-bridge | `CHERRY_KB_ROOT` | Cherry Studio 数据根目录（默认 `%APPDATA%\CherryStudio`） |

## 兼容性

这些插件针对 **DSH 0.2.0-rc.1** 开发（Host 插件导出 `apply` / `inject` / `name`，通过 `ctx.tools` 注册工具）。
DSH 版本升级后若出现 API 变化，可能需要同步调整 —— 各插件 README 里有更细的说明。

## 许可

[MIT](LICENSE)　·　作者：大赢经直插白皮赢道（GNH-CN-CYS）