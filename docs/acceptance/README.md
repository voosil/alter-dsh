---
type: acceptance
status: active
updated: 2026-11-10
---

# 验收

本目录收可执行的检查清单与一次性验证记录，只回答「是否验收、怎么验收」，不描述实现。
记录被再次验收取代或过期时删除或合并，历史交给 git。

## 文档清单

| 文档 | 验收对象 | 状态 / 结论 |
| --- | --- | --- |
| [space-workspace.md](space-workspace.md) | 空间 ↔ DSH 工作区映射：创建、改名、主目录变更、归档/恢复、删除、双向共存、数据与工程 | 已验收；依赖运行时联调项标 `[~]` |
| [agent-collaborators.md](agent-collaborators.md) | Space AI 协作者创建：`#/settings` 设置页复用、协作者创建/选择链路、安装与产物 | 已验证（浏览器点击链路未自动化） |
| [s0-document-tools.md](s0-document-tools.md) | 文档模型 S0/S1：工具面、Tiptap 编辑器、资产、评论/历史、撤销、GC、备份 | 已验收（真机 8/8；浏览器视觉待人工）；编辑器体验重建见 [editor-experience-p0-p6.md](editor-experience-p0-p6.md) |
| [document-editor-robustness.md](document-editor-robustness.md) | 即时编辑器健壮性：数据安全、并发恢复、输入保真、保存可行性与规模观测 | 部分落地（P0 保存生命周期、P2 评论/历史、P5 patch）；其余按清单推进 |
| [editor-experience-p0-p6.md](editor-experience-p0-p6.md) | 编辑器体验重建：旧 HTML 编辑器体验基线、单一 AST 不变量、P0–P6 分阶段验收与最终复验规则 | 进行中：P0/P1/P2/P5 主体完成（P0-4/P1-4/P2-3 待联调），P3/P4 部分，P6 未开始 |

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
