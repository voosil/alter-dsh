---
type: spec
status: active
updated: 2026-11-10
---

# 规范（Specs）

本目录存放 Alter-dsh 的**规范性文档**：当前必须遵守的契约与约束，是实施与验收的基准。
与代码不一致时，要么修正实现，要么升版规范；解释「为什么这样设计」的内容去
[方案](../designs/README.md)，外部事实与候选方案去 [调研](../research/README.md)。

## 文档

| 文档 | 回答什么 | 状态 |
| --- | --- | --- |
| [document-model-v0.md](document-model-v0.md) | 文档权威表示：单一 `alter-doc/1` 格式、顶层信封与创建/写入约束、Block/Inline 节点、Marks、Schema Registry、v0 节点类型、Markdown 投影规则 | draft |
| [document-operations-v0.md](document-operations-v0.md) | 写入契约：请求/响应信封、Operation 集、原子性与并发、撤销与审计、错误码、对象与资产、版本/快照/备份 | draft |
| [agent-doc-tools-v0.md](agent-doc-tools-v0.md) | 模型可调用的文档工具契约、投影预算与裁剪、spike 验收标准、开放决策项 | draft |
| [system-architecture.md](system-architecture.md) | 分层与数据所有权、RPC 传输约束、SQLite 持久化与恢复、构建自包含、空间 ↔ 工作区映射不变量、已知边界 | active |

## 维护规则

- **规范与实现同变更**：行为或契约变化时，同一变更里修改代码、测试与本目录规范；方向或取舍变化时
  同步更新对应的 [方案](../designs/README.md) 文档。规范先行时保持 `status: draft`，实现落地并
  验收后改 `active`。
- **单一事实源**：数据模型、Operations、Agent 工具契约、系统架构与持久化各只有一篇规范；
  其他文档只链接，不复制细节。
- **索引同步**：新增/删除/重命名文档必须同步本索引与 [文档知识库](../README.md)。
- **升版而非改写历史**：不兼容变更发布新版规范（新文件名，如 `-v1`）；旧版在迁移完成后删除，
  不设归档目录（历史见 git）。
- 分类、体量/数量预算、frontmatter 与写作规则以 [文档知识库](../README.md) 为准，本文件不重复。

## 相关文档

- [文档知识库](../README.md) — 分类、预算与写作规则（唯一事实源）
- [方案索引](../designs/README.md) — 设计理由、方向与取舍
- [调研索引](../research/README.md) — 外部事实与候选方案
- [验收索引](../acceptance/README.md) — 可执行检查清单与验证记录
