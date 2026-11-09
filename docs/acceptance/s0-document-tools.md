---
type: acceptance
status: active
updated: 2026-11-09
---

# Agent 文档工具 v0 · 真机验收记录

验收对象：`@alter-dsh/space` 的 Host 文档模型工具（`space_doc_*` / `space_object_*`）在真实
DSH desktop profile 中的注册与读写链路。结论：**PASS（安装 / 工具注册 / 9 步端到端读写）**。

## 已验证

| 项 | 结论 |
| --- | --- |
| 构建与测试 | `pnpm check` 全绿（build + verify + docs:check + typecheck + 19 文件 / 194 测试）。 |
| 安装与注册 | `remove_bundle` → `install_bundle`：`application: applied`，warnings 空；Host `Tool.listTools` 出现 7 个工具：`space_doc_outline/read/search/ops/generate`、`space_object_get/update`。 |
| 生成 | `space_doc_generate` 在 `sp-inbox` 创建 title=「S0 验收测试（可删除）」的 AST 文档：revision=1，18 个块 / 7 个顶层块。 |
| 读取 | `space_doc_read` 返回带 `<!-- blk:… -->` 锚点的 Markdown，callout/mindmap 指令、代码块与 GFM 表格均正确投影。 |
| 精确修改 | `space_doc_ops` + `update_text`：revision 1→2；`oldText` 必须用投影纯文本（`**` 不计入）。 |
| 并发 | 用旧 revision 重放同一批 ops → `doc/conflict`（当前 revision=2，提交基于 1），未落盘。 |
| 检索 | `space_doc_search` 命中被编辑的 paragraph 块 id。 |
| 对象 | `space_object_update` 生成新 `obj_…`（revision=3），旧占位对象不存在；`space_object_get` 回读 payload，`provenance.generatedBy=alter`；重读投影中的 `objectId` 已替换。 |
| 归属 | 工具写入按 `alter` 归属；版本/op log 随事务写入。 |

真机测试文档：`doc-b16dc506-1186-45ab-bcf9-59e98291a2a4`（「S0 验收测试（可删除）」）。
v0 没有删除工具，需在空间面板中手动删除。

## 复跑方式

1. `pnpm check`；`plugin_manager` 重新安装本仓库到 desktop profile。
2. 让 Agent 按本清单调用 `space_doc_generate → outline → read → ops(update_text) → 旧 revision 重放 → search → object_update → object_get`。
3. 删除本次测试创建的文档。

## 限制

- 旧 HTML 文档对工具返回 `doc/legacy-format`；AST 文档在 S1 编辑器接入前由旧 UI 打开会显示 JSON 原文。
- `space_doc_outline` 的 `total_blocks` 计入嵌套块（示例 18），`outline` 只列顶层块（示例 7）。
- 资产导入、undo 端点、对象 GC、组件运行时不在本切片。

## 相关文档

- [document-model-v0](../specs/document-model-v0.md)
- [document-operations-v0](../specs/document-operations-v0.md)
- [agent-doc-tools-v0](../specs/agent-doc-tools-v0.md)
- [验收索引](README.md)
