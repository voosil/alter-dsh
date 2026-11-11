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
| [s0-document-tools.md](s0-document-tools.md) | 文档模型 S0/S1：Host 工具面、资产、评论/历史 API、撤销、GC、备份 | 已验收（真机 8/8；浏览器视觉待人工）；编辑器前端还原与适配见 [editor-experience-p0-p6.md](editor-experience-p0-p6.md) |
| [dual-mode.md](dual-mode.md) | 本地/自部署服务端双模式、bridge 队列、设置与迁移的验收项 | draft |
| [document-editor-robustness.md](document-editor-robustness.md) | 旧编辑器的健壮性：数据安全、并发恢复、输入保真、保存可行性与规模观测 | A–G 自动化+真实浏览器验收基本通过；D1/A2/G3 的真实 IME/强杀/断网以等价方式覆盖并如实标注 |
| [editor-experience-p0-p6.md](editor-experience-p0-p6.md) | 编辑器前端 1:1 还原与 AST 适配：外观冻结约束、旧体验行为、适配数据链路、已知缺口与复验规则 | 1:1 还原与 AST 适配已完成并通过自动化+真实浏览器验收；对象卡人工入口等限制见清单 |

## 维护规则

- 状态标记统一为：`[x]` 自动化覆盖；`[~]` 已实现、依赖运行时未联调；`[ ]` 未做。
  单个清单如有额外口径，须在文首声明。
- 新增/删除/重命名文档时同步本清单与[文档规则](../README.md)的索引。
- 只写可复现的结论与验收入口，不复述实现；一次性叙事、踩坑过程与临时数字不保留。
- 完成项改状态标记，不追加历史记录；清单落定后按
  [生命周期规则](../README.md#生命周期与自动归档)退场（一次性记录直接删除，长期证据才归档）。
- frontmatter、体量与命名遵循[文档规则](../README.md)。

## 相关文档

- [文档规则](../README.md)
- [调研索引](../research/README.md)
- [方案索引](../designs/README.md)
- [规范索引](../specs/README.md)
