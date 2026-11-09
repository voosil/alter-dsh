---
type: acceptance
status: active
updated: 2026-11-09
---

# 验收

本目录收可执行的检查清单与一次性验证记录，只回答「是否验收、怎么验收」，不描述实现。
记录被再次验收取代或过期时删除或合并，历史交给 git。

## 文档清单

| 文档 | 验收对象 | 状态 / 结论 |
| --- | --- | --- |
| [space-workspace.md](space-workspace.md) | 空间 ↔ DSH 工作区映射：创建、改名、主目录变更、归档/恢复、删除、双向共存、数据与工程 | 已验收；依赖运行时联调项标 `[~]` |
| [agent-collaborators.md](agent-collaborators.md) | Space AI 协作者创建：`#/settings` 设置页复用、协作者创建/选择链路、安装与产物 | 已验证（浏览器点击链路未自动化） |
| [s0-document-tools.md](s0-document-tools.md) | Agent 文档工具 v0：安装/注册、generate/read/ops/search/object 的真机端到端 | 已验收（9 步全部通过） |

## 维护规则

- 状态标记统一为：`[x]` 自动化覆盖；`[~]` 已实现、依赖运行时未联调；`[ ]` 未做。
  单个清单如有额外口径，须在文首声明。
- 新增/删除/重命名文档时同步本清单与[文档规则](../README.md)的索引。
- 只写可复现的结论与验收入口，不复述实现；一次性叙事、踩坑过程与临时数字不保留。
- 完成项改状态标记，不追加历史记录；清单被再次验收取代时直接删除或合并。
- frontmatter、体量与命名遵循[文档规则](../README.md)。

## 相关文档

- [文档规则](../README.md)
- [调研索引](../research/README.md)
- [方案索引](../designs/README.md)
- [规范索引](../specs/README.md)
