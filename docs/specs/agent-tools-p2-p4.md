---
type: spec
status: active
updated: 2026-11-12
---

# Agent 空间工具 P2–P4

本篇规范覆盖 P1 之后新增的领域工具：评论、版本历史、随想、空间治理、协作者与目录、hub 已实现
部分、文件资产导入，以及控制面工具 `space_settings` 的扩展。通用约定（命名、身份绑定、错误码、
台账与 parity 门禁）以 [agent-tools-v1.md](agent-tools-v1.md) 为准，本篇只写增量契约，不重复。
P2–P4 采用「一个工具多个 action」的形状，action 枚举与 `host/authority/capabilities.ts` 逐字一致，
由 parity 门禁强制。

## 1. 增量工具清单

| 工具 | 端点 | action | 读/写 |
| --- | --- | --- | --- |
| `space_comments` | `space.listComments` / `addComment` / `updateComment` / `addCommentSupplement` / `deleteComment` / `resolveComment` | `list` / `add` / `update` / `supplement` / `delete` / `resolve` | 读 + 写（delete 破坏性） |
| `space_versions` | `space.listVersions`；`doc.restoreVersion` | `list` / `restore` | 读 + 写（restore 破坏性） |
| `space_thoughts` | `space.listThoughts` / `createThought` / `updateThought` / `setThoughtArchived` / `deleteThought` / `restoreThought` / `moveThought` / `convertThought` | `list` / `create` / `update` / `archive` / `delete` / `restore` / `move` / `convert` | 读 + 写（delete 为软删） |
| `space_governance` | `space.createSpace` / `updateSpace` / `archiveSpace` / `unarchiveSpace` / `deleteSpace` / `reorderSpaces` / `emptyTrash` | `create_space` / `update_space` / `archive_space` / `unarchive_space` / `delete_space` / `reorder_spaces` / `empty_trash` | 写（delete_space、empty_trash 破坏性） |
| `space_collaborators` | `space.listAgents` / `createAgent` / `listDirectories` | `list_agents` / `create_agent` / `list_directories` | 读 + 写 |
| `space_hub` | `hub.get` / `hub.summarize` / `hub.setPolicy` / `hub.setPluginEnabled` | `get` / `summarize` / `set_policy` / `set_plugin_enabled` | 读 + 写 |
| `space_import_file` | `doc.importFile` | — | 写 |
| `space_settings`（扩展） | `storage.estimate` / `sync.queue` / `sync.resolve` | `estimate` / `queue` / `resolve` | 读 + 控制面写 |

全部工具经 Host 的 alter 端点入口调用（`SpaceBackend.agentRpc`），与浏览器共用同一个权威栈服务；
工具只做参数校验、投影与错误映射，不维护第二份业务逻辑。读 action 的 `isConcurrencySafe: true`。

## 2. `space_comments`（评论）

```
输入：{ action, doc_id?, comment_id?, body?, quote?,
        anchor?: { block_id, offset, length } }
```

| action | 必填 | 语义 |
| --- | --- | --- |
| `list` | `doc_id` | 列出该文档评论（三态 `open/resolved/deleted` 都返回），≤ 50 条；正文裁剪 300 字 |
| `add` | `doc_id`、`body` | 新建评论；`quote`/`anchor` 可选，anchor 用作正文定位 |
| `update` | `comment_id` + 至少一个字段 | 改正文/引用/锚点 |
| `supplement` | `comment_id`、`body` | 追加补充 |
| `resolve` | `comment_id` | 标记已解决；已解决/已删除返回明确错误 |
| `delete` | `comment_id` | **破坏性**，须审批：软删除为墓碑（`status='deleted'`），随文档删除才真正消失 |

投影：`{ id, doc_id, author, status, quote, body, anchor, supplements_count, created_at, edited_at, resolved_at }`。
作者由 alter 栈派生（`author='alter'`），工具不接受作者参数。

## 3. `space_versions`（文档历史）

```
输入：{ action: 'list'|'restore', doc_id, version_id?, base_revision? }
```

- `list`：该文档的历史版本，≤ 30 条，投影 `{ id, title, author, at, bytes }`（不回传正文）。
- `restore`：**破坏性**，须审批。用 `doc.restoreVersion` + 当前 `base_revision` 把正文恢复为历史版本；
  恢复动作本身会先记录「恢复前」版本（版本裁剪语义见 document-operations-v0.md）。成功后返回新
  revision 与变更块，供后续 CAS。
- `space.restoreVersion`（legacy 内容字段）**不暴露**：AST 文档的唯一恢复路径是 `doc.restoreVersion`。

## 4. `space_thoughts`（随想）

```
输入：{ action, space_id?, thought_id?, target_space_id?, content?, include_archived?, archived? }
```

| action | 必填 | 语义 |
| --- | --- | --- |
| `list` | `space_id` | 随想列表，默认不含已归档；`include_archived` 可含；≤ 50 条，content 裁剪 200 字 |
| `create` | `space_id`、`content` | 新建，`creator='alter'` |
| `update` | `thought_id`、`content` | 改内容 |
| `archive` | `thought_id`、`archived` | 归档/取消归档 |
| `delete` | `thought_id` | 软删除进回收站 |
| `restore` | `thought_id` | 从回收站恢复 |
| `move` | `thought_id`、`target_space_id` | 移到另一个空间 |
| `convert` | `thought_id` | 转为文档（返回随想与新文档节点） |

## 5. `space_governance`（空间治理）

```
输入：{ action, space_id?, name?, goal?, directories?, space_ids? }
```

- `create_space`：`name` 必填，`goal`/`directories` 可选；主目录映射与「一个目录只属于一个空间」的
  不变量由工作区桥接保持（见 system-architecture.md）。
- `update_space`：只传用户提供的字段；`archive_space`/`unarchive_space` 切换归档态。
- `reorder_spaces`：`space_ids` 为**全部**空间的新顺序（非空、无重复），失败不改任何顺序。
- `delete_space`：**破坏性**，须审批；路由层先做恢复点快照，快照失败即取消删除。
- `empty_trash`：**破坏性**，须审批；永久清空该空间回收站，不可恢复。

空间本身没有 creator 归属字段；工具不接受归属参数。

## 6. `space_collaborators`（协作者与目录）

- `list_agents`：全空间协作者列表（`id/name/role/description?/model?/created_at`）。
- `create_agent`：`name`、`role` 必填，`description`/`model` 可选；创建为空间协作者元数据。
- `list_directories`：`path` 必填，返回目录条目 `{ path, name }`，≤ 100 条；用于选择主目录/导入位置。

`listDirectories` 是只读目录浏览，不返回文件内容；越界路径由服务端拒绝。

## 7. `space_hub`（概览与配置）

只暴露 **已实现** 的 4 个 action：

- `get`：有界快照投影——`policy`、`onboarding`、`summary{content,updated_at}`、
  `plugins[{id,label,enabled,builtin,required}]`、事项/观察计数、`journey{vision,short_term,long_term}`（长文裁剪）。
- `summarize`：由 Host 组合最近记录生成概览总结，返回总结投影。
- `set_policy`：`policy ∈ ask|judge|autonomous`。
- `set_plugin_enabled`：`plugin_id` + `enabled`；required 内置插件不可禁用。

事项/旅程/观察的写入与插件发现/内容保存共 11 个端点仍是服务端未实现的 DEP-002 占位，**不暴露**
（见 §10）；`hub.remove` 是空间删除时的内部级联清理，不单独暴露。

## 8. `space_import_file`（文件资产导入）

```
输入：{ data_base64, mime, name? }      输出：{ asset_id, mime, bytes, name? }
```

- 导入通用文件资产（文件卡片引用），大小上限沿用 `MAX_FILE_BYTES`；图片仍用 `space_asset_import`
  （`doc.importAsset`，带宽高校验）。
- 载荷是 base64；工具不读 Host 文件系统，模型需先准备内容再上传。
- 返回的 `asset_id` 写入文档时通过 Document Operations（文件卡片块）引用。

## 9. `space_settings` 扩展

新增 3 个 action（原 `get/set/test/flush` 行为不变）：

- `estimate`：`history_limit?`/`snapshot_keep?` → 返回策略与占用估算（`settings` + `estimate`）；
  只读，不需要审批。
- `queue`：同步队列明细（服务端模式）；本地模式返回空数组。条目投影
  `{ doc_id, state, entries, base_revision, last_error?, updated_at }`。
- `resolve`：`doc_id` + `resolution ∈ retry|discard` 处置冲突/失败队列（服务端模式）；本地无队列，
  明确报错；迁移冻结期写入返回 `migration/read-only`。

## 10. 仍未暴露的端点（15）

| 端点 | 理由 |
| --- | --- |
| `space.recordOpen` | 不伪造用户活动度，永不暴露 |
| `doc.get` | 原始 AST；工具经 outline/read 投影读取 |
| `space.restoreVersion` | legacy 内容字段恢复；AST 文档恢复由 `doc.restoreVersion` 承担 |
| `hub.remove` | 空间删除的内部级联清理，不单独暴露 |
| `hub.createMatter` / `setMatterStatus` / `answerMatter` / `readMatter` | 服务未实现（DEP-002 占位） |
| `hub.saveJourney` / `introduce` / `skipIntroduction` | 服务未实现（DEP-002 占位） |
| `hub.acceptObservation` / `extractSkill` | 服务未实现（DEP-002 占位） |
| `hub.discoverPlugin` / `savePluginContent` | 服务未实现（DEP-002 占位） |

台账保留这些行的 `excluded` 理由；实现 DEP-002 后在同一变更里翻转为工具映射。

## 11. 预算、审批与投影

- 破坏性 action（`space_comments.delete`、`space_versions.restore`、`space_governance.delete_space`、
  `space_governance.empty_trash`）**必须先经 DSH 审批**；没有审批服务时 fail closed，绝不自行执行。
- 读投影全部有界：评论 ≤ 50 条 / 正文 300 字；版本 ≤ 30 条且无正文；随想 ≤ 50 条 / 200 字；
  目录 ≤ 100 条；hub 长文裁剪。写工具不因预算裁剪改变语义。
- schema 字节棘轮覆盖全部工具：22 个工具实测 12936 字节（P1 的 15 工具 7718 + 本批 7 工具
  5218），上限 13200（`SCHEMA_BYTE_BUDGET`）；上限调整必须同步
  [agent-tools-v1.md](agent-tools-v1.md) §6。

## 相关文档

- [agent-tools-v1.md](agent-tools-v1.md) — 通用约定、核心工具、台账与 parity 门禁
- [document-operations-v0.md](document-operations-v0.md) — 写入契约、版本与错误码
- [system-architecture.md](system-architecture.md) — 权威栈、归属守卫、迁移冻结与离线缓存
- [agent-doc-tools.md](../designs/agent-doc-tools.md) — 分期决策与理由
- [agent-tools-p2-p4.md](../acceptance/agent-tools-p2-p4.md) — 验收清单