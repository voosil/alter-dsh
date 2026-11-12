---
type: acceptance
status: active
updated: 2026-11-12
---

# Agent 文档工具 v0 · 验收记录

验收对象：`@alter-dsh/space` 的 Host 文档工具面在真实 DSH desktop profile 中的注册与读写链路。
结论：**PASS（安装 / 工具注册 / 端到端读写）**。当前工具面为 11 个文档工具（控制面工具
`space_settings` / `space_migrate` 的验收见 [dual-mode.md](dual-mode.md)）；契约与质量基线见
[agent-tools-v1.md](../specs/agent-tools-v1.md)。文档前端已按产品要求与冻结 UI 保持 parity；
唯一内核为 AST 原生 Tiptap，经 `@alter-space/document-runtime` 接 AST。前端验收见
[editor-experience-p0-p6.md](editor-experience-p0-p6.md)。

## 工具面

`space_doc_outline` / `space_doc_read` / `space_doc_search` / `space_doc_ops` / `space_doc_patch` /
`space_doc_generate` / `space_doc_undo`、`space_asset_import`、`space_component_catalog`、
`space_object_get` / `space_object_update`。

## 已验证

| 项 | 结论 |
| --- | --- |
| 构建与测试 | `pnpm check` 全绿（build + verify + docs:check + typecheck + test）。 |
| 安装与注册 | `remove_bundle` → `install_bundle`：`application: applied`，warnings 空；Host `Tool.listTools` 出现全部 11 个文档工具。 |
| 生成 | `space_doc_generate` 在 `sp-inbox` 创建 AST 文档：revision=1；新建文档即 revision 1 的 `alter-doc/1` AST 文档（空文档 `blocks: []`）；`space.saveNode` 只更新标题等元数据，不接受正文写入。 |
| 读取 | `space_doc_read` 返回带 `<!-- blk:… -->` 锚点的 Markdown，callout/mindmap 指令、代码块与 GFM 表格均正确投影；超限截断与 `next` 续读锚点有测试覆盖。 |
| 精确修改 | `space_doc_ops` + `update_text`：`oldText` 必须用投影纯文本（`**` 不计入）；`space_doc_patch` 单块纯文本替换为默认编辑路径，错误带下一步动作。 |
| 并发 | 用旧 revision 重放同一批 ops → `doc/conflict`，未落盘。 |
| 检索 | `space_doc_search` 命中被编辑的 paragraph 块 id；嵌套（callout 内）命中时 preview 返回命中上下文而不是父块标题。 |
| 对象 | `space_object_update` 生成新 `obj_…`，旧对象不再被引用；`space_object_get` 回读 payload，`provenance.generatedBy=alter`；组件实例按目录 schema fail-closed 校验。 |
| 归属 | 工具写入按 `alter` 归属，版本/op log 随事务写入；浏览器写入强制为用户，不信任请求体 actor（集成用例覆盖）。 |
| 完整 AST 读取 | `doc.get` 返回 revision/title/doc 块树；`tests/integration/document/service.test.ts` 与 `tests/integration/host/apply.test.ts` 集成用例覆盖。 |
| 撤销 | `doc.undo` / `space_doc_undo` 应用 op log 的 inverseOps：revision+1、旧内容恢复；过期 base 报 `doc/conflict`，未知 token 报 `op/invalid`。 |
| 资产 | `space_asset_import` + 内容寻址资产表/文件：去重、mime/大小校验、`GET /api/alter-space/asset` 读取；客户端图片块用该 URL 渲染，失败回退占位。 |
| 评论与历史 | 评论列表/发布/解决/删除（软删除墓碑，`listComments` 仍返回，供「历史评论」查看）；正文写入让评论 quote 消失时在同一事务链式软删除；版本列表、差异预览与「恢复此版本」。恢复走 `doc.restoreVersion`（delete+insert Operations，revision+1，不倒退 revision）；版本历史全部为 AST 快照，恢复只接受 AST。 |
| 对象/资产 GC | 启动时扫描当前文档与保留版本的引用，删除未引用对象与资产元数据/字节；版本中仍引用的对象保留。 |
| 资产备份 | 每日快照同时生成 `space-YYYYMMDD.assets.tar.gz`（无资产跳过），二者按同一 keep 策略保留；恢复流程同时覆盖。 |
| AST 文本抽取 | 全局搜索、概览活动与新文档内容判断按 AST 块树提取正文纯文本（含对象 alt/caption/title），不命中 JSON 字段。 |

## 验收口径

状态标记：`[x]` 自动化或真机证据；`[~]` 部分落地或待专项/人工确认；`[ ]` 未做。

| # | 验收项 | 判定 | 状态 |
| --- | --- | --- | --- |
| A1 | 工具可见 | 安装后工具列表出现全部 11 个文档工具；`pnpm check` 通过 | [x] |
| A2 | 读准确 | outline/read 返回的 block id 与投影正文和 AST 一致；范围读可按续读锚点拼接 | [x] |
| A3 | 写归属 | Agent 新建/修改后节点 `creator='alter'`、新版本 `author='alter'` | [x] |
| A4 | 冲突不落盘 | 过期 `baseRevision` 调用 → 冲突错误，回读内容与版本均不变 | [x] |
| A5 | 可恢复 | Agent 写入后用户保存旧草稿，新内容仍可从版本历史恢复 | [~] 版本历史可恢复（5 分钟节流）；「强制版本」未实现，见方案待拍板 |
| A6 | 非法写入被拒 | 未知节点类型、非法 props、越界大小被拒绝且不落盘 | [x] |
| A7 | 读不改活动 | 连续读不改变 `activity`/`lastOpenCreditAt` | [~] 读工具不调用 `recordOpen`（实现约定），无专项断言 |
| A8 | 写入可见性（非实时） | Agent 改文档后重新进入/切空间/刷新页面即可看到最新内容，数据不丢 | [x] |
| A9 | 上下文预算 | 工具 schema 约 +2.2–2.6k tokens（估算）；单次读默认 12k / 最大 40k 字符，超限截断 | [x] |
| A10 | 原子与撤销 | 批量 ops 全有或全无；一次 apply 可撤销，op log 可还原 | [x] |

## 浏览器视觉验收限制

- DSH Web GUI 需要 `dsh web` 打印的鉴权 URL；独立浏览器直接访问会得到
  `dsh web authentication required`，无法复用桌面 App 已登录会话，因此**未做真实浏览器点击/截图**。
- 替代证据：jsdom 组件挂载测试 + 构建产物断言 + RPC/服务集成测试 + 真机 Agent 端到端。
- 样式回归、拖拽/选区、真实图片加载仍需人工在面板中目验。

## 复跑方式

1. `pnpm check`；`plugin_manager` 重新安装本仓库到 desktop profile。
2. 让 Agent 按本清单调用 `space_doc_generate → outline → read → patch（或 ops(update_text)）→
   旧 revision 重放 → search → object_update → object_get`。
3. 删除本次测试创建的文档（v0 没有删除工具，需在空间面板中手动删除）。

## 当前完成度与限制

S0 Host 工具面、评论/历史、资产、撤销、GC、备份与 AST 搜索结果均已实现并有测试覆盖；正文只有
`alter-doc/1` AST 一种格式。剩余：上节的浏览器视觉验收与人工目验；A5/A7 的专项补强。
`space_doc_outline` 的 `total_blocks` 计入嵌套块，`outline` 只列顶层块。组件运行时（渲染器与
人工编辑入口）不在本清单范围，见[编辑器还原验收](editor-experience-p0-p6.md)。

## 相关文档

- [document-model-v0](../specs/document-model-v0.md)
- [document-operations-v0](../specs/document-operations-v0.md)
- [agent-tools-v1](../specs/agent-tools-v1.md)
- [编辑器前端还原与 AST 适配验收](editor-experience-p0-p6.md)
- [验收索引](README.md)
