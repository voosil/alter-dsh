---
type: research
status: active
updated: 2026-11-09
---

# 调研

本目录收外部事实、候选方案对比与证据，回答「有哪些选择、证据是什么」。调研有时效、允许过时：
结论一旦被采纳，就压缩为摘要并链接到[方案](../designs/README.md)与[规范](../specs/README.md)，
本目录不复述已定契约。

## 文档清单

| 文档 | 回答什么 | 状态 / 结论 |
| --- | --- | --- |
| [document-storage-options.md](document-storage-options.md) | 空间文档用什么权威格式与存储位置：HTML / Markdown / JSON AST / MDX 对比、数据库 vs 工作区文件、对 Agent 接口的影响 | 已收敛（结论见方案与规范） |
| [dsh-agent-creation.md](dsh-agent-creation.md) | Space 协作者是否、如何对接真实 DSH Agent 创建：现有插件与服务证据、社区方案、方案取舍 | 已采纳产品级自建（A），真实运行时接入（B）留待后续 |

## 维护规则

- 调研允许过时；结论被采纳后压缩为摘要，只保留仍影响决策的证据，其余删除，并链接对应的方案/规范。
- 被取代或不再影响决策的文档直接删除或合并，不设归档目录（git 保留历史）。
- 新增/删除/重命名文档时同步本清单与[文档规则](../README.md)的索引。
- 只写外部事实、候选对比与证据，不复制规范已定义的契约，也不写实现细节与源码说明。
- frontmatter、体量与命名遵循[文档规则](../README.md)。

## 相关文档

- [文档规则](../README.md)
- [方案索引](../designs/README.md)
- [规范索引](../specs/README.md)
- [验收索引](../acceptance/README.md)
