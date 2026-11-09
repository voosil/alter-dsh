---
type: design
status: active
updated: 2026-11-09
---

# 方案（designs）

本目录回答「为什么这样设计」：记录方向、取舍与已采纳/已废弃的决策摘要。**这里不是规范**，
契约以 [docs/specs/](../specs/README.md) 为准；两者冲突时以 spec 为准。文档规则见
[docs/README.md](../README.md)。

## 本目录定位

- **非规范**：为 spec 提供理由与边界讨论，不定义接口、字段或协议。
- **只写当前有效内容**：被取代的决策只保留「结论 + 理由」摘要，不保留旧方案全文（历史交给 git）。
- **不堆实现**：不复述 spec 细节、不贴代码骨架、不逐文件讲源码实现。
- **决策变化先改 spec**：契约变化在 spec 落地后，再同步这里的理由说明。

## 文档清单

| 文档 | 回答什么 | 状态 |
| --- | --- | --- |
| [document-content-architecture.md](document-content-architecture.md) | 文档正文为什么以 JSON AST 为权威、Markdown 投影与 Operations 如何分工、富对象与组件边界、本仓库映射与待拍板项 | active |
| [agent-doc-tools.md](agent-doc-tools.md) | Agent 读写空间文档为什么用 Host 原生工具、写入安全三件套、首期边界、阶段与风险 | active |

## 维护规则

- 新增/删除/重命名文档时，同步更新本索引与 [docs/README.md](../README.md) 的索引。
- 体量预算与写作规则以 [docs/README.md](../README.md) 为准；接近预算先拆分或下沉细节，不压缩到不可读。
- 链接一律用相对路径，只链接仍存在的文档；被删除文档的引用要同步清理。
- 保持单一主题：一篇文档只回答一个问题；跨主题内容用链接，不复制。

## 相关文档

- [docs/README.md](../README.md) — 分类、体量、写作与变更规则
- [specs/README.md](../specs/README.md) — 当前必须遵守的契约
- [research/README.md](../research/README.md) — 外部事实与候选方案
- [acceptance/README.md](../acceptance/README.md) — 验收清单与验证记录
