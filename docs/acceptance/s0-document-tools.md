---
type: acceptance
status: active
updated: 2026-11-10
---

# Agent 文档工具 v0 · 真机验收记录

验收对象：`@alter-dsh/space` 的 Host 文档模型工具（`space_doc_*` / `space_object_*`）在真实
DSH desktop profile 中的注册与读写链路。结论：**PASS（安装 / 工具注册 / 9 步端到端读写）**。
本记录是 S0 阶段的功能验收快照，覆盖 Host 工具面、资产、评论/历史与备份；当前工具面为 11 个
（新增 `space_doc_patch` / `space_component_catalog`）。文档前端已按产品要求还原为旧 UI 并经
legacy adapter 接 AST，前端验收见 [editor-experience-p0-p6.md](editor-experience-p0-p6.md)。

## 已验证

| 项 | 结论 |
| --- | --- |
| 构建与测试 | `pnpm check` 全绿（build + verify + docs:check + typecheck + test）。 |
| 安装与注册 | `remove_bundle` → `install_bundle`：`application: applied`，warnings 空；Host `Tool.listTools` 出现 9 个工具：`space_doc_outline/read/search/ops/undo/generate`、`space_object_get/update`、`space_asset_import`。 |
| 生成 | `space_doc_generate` 在 `sp-inbox` 创建 title=「S0 验收测试（可删除）」的 AST 文档：revision=1，18 个块 / 7 个顶层块。 |
| 新建文档 | 新建文档即 revision 1 的 `alter-doc/1` AST 文档（空文档 `blocks: []`）；`space.saveNode` 只更新标题等元数据，不接受正文写入。 |
| 读取 | `space_doc_read` 返回带 `<!-- blk:… -->` 锚点的 Markdown，callout/mindmap 指令、代码块与 GFM 表格均正确投影。 |
| 精确修改 | `space_doc_ops` + `update_text`：revision 1→2；`oldText` 必须用投影纯文本（`**` 不计入）。 |
| 并发 | 用旧 revision 重放同一批 ops → `doc/conflict`（当前 revision=2，提交基于 1），未落盘。 |
| 检索 | `space_doc_search` 命中被编辑的 paragraph 块 id。 |
| 对象 | `space_object_update` 生成新 `obj_…`（revision=3），旧占位对象不存在；`space_object_get` 回读 payload，`provenance.generatedBy=alter`；重读投影中的 `objectId` 已替换。 |
| 归属 | 工具写入按 `alter` 归属；版本/op log 随事务写入。 |
| 完整 AST 读取 | `doc.get` 返回 revision/title/doc 块树；`tests/document/service.test.ts` 与 `tests/host/apply.test.ts` 集成用例覆盖。 |
| 撤销 | `doc.undo` 应用 op log 的 inverseOps：revision+1、旧内容恢复；过期 base 报 `doc/conflict`，未知 token 报 `op/invalid`。 |
| 撤销工具 | `space_doc_undo`：按 `undo_token` 或最近一次 batch 应用 `inverseOps`，生成新 revision 与 op log；冲突/未知 token 错误码覆盖。 |
| 资产 | `space_asset_import` + 内容寻址资产表/文件：去重、mime/大小校验、`GET /api/alter-space/asset` 读取；客户端图片块用该 URL 渲染，失败回退占位。 |
| 评论与历史 | 评论列表/发布/解决；版本列表、差异预览与「恢复此版本」。恢复走 `doc.restoreVersion`（delete+insert Operations，revision+1，不倒退 revision）；版本历史全部为 AST 快照，恢复只接受 AST。 |
| 对象/资产 GC | 启动时扫描当前文档与保留版本的引用，删除未引用对象与资产元数据/字节；版本中仍引用的对象保留。 |
| 资产备份 | 每日快照同时生成 `space-YYYYMMDD.assets.tar.gz`（无资产跳过），二者按同一 keep 策略保留；恢复流程同时覆盖。 |
| AST 文本抽取 | 全局搜索、概览活动与新文档内容判断按 AST 块树提取正文纯文本（含对象 alt/caption/title），不命中 JSON 字段。 |

真机测试文档：`doc-b16dc506-1186-45ab-bcf9-59e98291a2a4`（「S0 验收测试（可删除）」）。
v0 没有删除工具，需在空间面板中手动删除。

| 真机 v1 复验 | 真实 Agent 8/8 步通过：资产导入去重、generate/read（图片 URI/粗体/callout）、update_text、`space_doc_undo` 恢复、search 命中、outline 计数；最终 revision=3。 |
| 搜索预览 | 嵌套（callout 内）命中时 preview 返回命中上下文而不是父块标题；工具/服务测试覆盖。 |

## 浏览器视觉验收限制

- DSH Web GUI 需要 `dsh web` 打印的鉴权 URL；独立浏览器（agent-browser）直接访问会得到
  `dsh web authentication required`，无法复用桌面 App 已登录会话，因此**未做真实浏览器点击/截图**。
- 替代证据：jsdom 组件挂载测试 + 构建产物断言 + RPC/服务集成测试 + 真机 Agent 端到端。
- 样式回归、拖拽/选区、真实图片加载仍需人工在面板中目验。

## 验收产生的测试文档（需手动删除）

- `doc-b16dc506-1186-45ab-bcf9-59e98291a2a4`「S0 验收测试（可删除）」
- `doc-6bb3649d-7635-4403-85c2-f79180345e22`「Agent v1 冒烟（可删除）」
- 资产 `asset_431ced6916a2a21a156e38701afe55bb`（随文档删除后可被 GC 回收）

## 复跑方式

1. `pnpm check`；`plugin_manager` 重新安装本仓库到 desktop profile。
2. 让 Agent 按本清单调用 `space_doc_generate → outline → read → ops(update_text) → 旧 revision 重放 → search → object_update → object_get`。
3. 删除本次测试创建的文档。

## 当前完成度

S0 Host 工具面、评论/历史、资产、撤销、GC、备份与 AST 搜索结果均已实现并有测试覆盖；正文只有 `alter-doc/1` AST 一种格式。剩余仅上节的浏览器视觉验收与人工目验。

## 限制

- 所有 note 正文都是 AST，工具按 AST 读写；文档前端为旧 UI 还原（见编辑器前端验收），资产、对象 GC 与资产备份已覆盖。
- `space_doc_outline` 的 `total_blocks` 计入嵌套块（示例 18），`outline` 只列顶层块（示例 7）。
- 组件运行时、`space_doc_patch` 与组件目录工具不在本切片。

## 相关文档

- [document-model-v0](../specs/document-model-v0.md)
- [document-operations-v0](../specs/document-operations-v0.md)
- [agent-doc-tools-v0](../specs/agent-doc-tools-v0.md)
- [编辑器前端还原与 AST 适配验收](editor-experience-p0-p6.md)
- [验收索引](README.md)
