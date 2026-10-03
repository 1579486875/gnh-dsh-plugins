# dsh-cherry-kb-bridge

把 **Cherry Studio 本地知识库**桥接为 DeepSeek Harness 模型工具：让 DSH agent 直接检索你在 Cherry Studio 里维护的知识库。

## 工具

- `cherry_kb_list` —— 列出 Cherry Studio 的知识库（名称/文档数/切块配置），可带文件清单；同时报告旧版遗留向量库。
- `cherry_kb_query` —— 在 Cherry 知识库全文检索（FTS5 trigram + BM25，中文免分词；短词自动回退 LIKE）。
- `cherry_kb_read` —— 按文件路径读取知识库原文内容（分页）。

## 原理

只读打开 Cherry Studio 的数据目录：

- `%APPDATA%\CherryStudio\Data\cherrystudio.sqlite` —— 知识库元数据（`knowledge_base` 表）
- `%APPDATA%\CherryStudio\Data\KnowledgeBase\<id>\.cherry\index.sqlite` —— 切块与 FTS5 索引
- `%APPDATA%\CherryStudio\Data\KnowledgeBase\<id>\raw\` —— 原始文件

**纯只读**：所有连接以 `readOnly: true` 打开，不修改、不迁移、不锁定 Cherry Studio 的任何数据。

## 安装

```sh
dsh plugin --profile web add link:dsh-cherry-kb-bridge
```

可选：环境变量 `CHERRY_KB_ROOT` 覆盖 Cherry Studio 数据根目录（默认 `%APPDATA%\CherryStudio`）。