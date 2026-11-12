---
type: spec
status: active
updated: 2026-11-12
---

# Agent 空间工具 v1

本篇规范约束模型可调用的全部 Space 工具（`space_*`）契约、能力台账与 parity 门禁、投影预算与裁剪、
质量验收基线，是 Agent 工具契约的**单一事实源**。底层读写语义由
[document-model-v0.md](document-model-v0.md) 与 [document-operations-v0.md](document-operations-v0.md)
定义，分层、归属守卫与持久化由 [system-architecture.md](system-architecture.md) 定义，本篇不重复。

## 1. 通用约定

- 命名沿用产品前缀 `space_*`；读工具 `isConcurrencySafe: true`，写工具为 false。
- **命名风格**：工具顶层输入参数与输出 JSON 统一 snake_case（`doc_id`、`parent_id`）；Operation 载荷
  内字段遵循 [document-operations-v0.md](document-operations-v0.md)（如 `edits:[{oldText,newText}]`）；
  控制面工具（`space_settings`/`space_migrate`）输入参数 snake_case、输出字段沿用 Host 控制面
  camelCase。各层不混用。
- **身份绑定**：工具写入绑定 `alter` 权威栈，浏览器 RPC 绑定 `user` 栈；入口只选栈、不接受身份参数。
  归属（creator、版本/评论作者、归档来源）由写入身份派生、写后不可变，持久化守卫在同一事务校验
  （见 [system-architecture.md](system-architecture.md) §3）。工具参数中的 `space_id`/`doc_id` 一律做
  存在性与一致性校验，由 id 反查归属，不信任模型输入。
- 文档级工具输出带 `revision` 供后续 ops 的 CAS；对象读取返回对象本身。输出不回传 `doc_id`（调用方已知）；
  新建返回新 id。
- **patch-first**：单处纯文本修改优先 `space_doc_patch`；多操作或结构性变更才用 `space_doc_ops`。
  禁止用 `generate`/整块替换重写整篇文档。
- 所有 Space note 正文只有 `alter-doc/1` 一种格式；非法存储内容以 `doc/schema-invalid` 报错。
  未知/不可写节点以占位出现并附 `unsupported` 说明。
- 错误使用 [document-operations-v0.md](document-operations-v0.md) §5 错误码，工具层另有两个补充码：
  `space/not-found`、`space/invalid-input`（结构工具）与 `space/invalid-args`（文档工具入参校验）；
  迁移冻结期的写入统一返回 `migration/read-only`。**失败要可操作**：冲突返回当前 revision，
  常见错误附下一步动作；不允许部分成功却不报错。
- 写工具能力受 registry `ai.ops` 与全局写策略约束；结构工具受同一写策略与迁移冻结约束。
- 工具对所有 Agent（含子 Agent）可见；插件配置门禁是唯一范围控制：当前只有 `documentTools` /
  `spaceTools` 两个布尔开关（控制面工具无开关，写入仍需审批）。写策略与只读开关属后续范围，未实现。
- DSH 工具框架只做 JSON 解析，参数校验与错误映射必须在工具实现内手写，错误用稳定错误码字符串返回。
- 文档写入必须在 store 的单写者事务回调（`transactDocument`）内完成；不得在回调内 await 同一 store 的
  其他更新（单写者队列自锁）。
- **Agent 写入强制版本**：`alter` 写入未触发版本记录（5 分钟节流窗口内）时，同一事务补记一条
  `author='alter'` 版本，受现有裁剪约束；`user` 写入保持节流。

## 2. 能力台账与 parity 门禁

- `host/authority/capabilities.ts` 是操作面单一事实源：每个端点一行，声明 `kind`
  （`read | write | destructive | control`）与 Agent 暴露面（`{tool, action?}` 或 `{excluded: 理由}`）。
  无 RPC 端点的发现工具（如 `space_component_catalog`）单独登记。
- **四处一致**：RPC 白名单、读写分类（`READ_ENDPOINTS` 从台账派生）、浏览器映射、工具注册必须与台账
  一致，由 `tests/integration/contract/` 的 parity 测试强制（含工具 action 枚举与 schema 字节预算棘轮）。
- **新操作同变更声明**：新增端点必须在同一变更里于台账声明暴露面——暴露（工具/action）或排除（理由）。
  排除是一等决策（如 `recordOpen` 永不暴露：不伪造用户活动度）；未实现占位功能不暴露。
- 工具只做薄适配：与浏览器 RPC 调用同一权威栈服务方法，不维护第二份操作逻辑；破坏性操作
  （`emptyTrash`、`deleteSpace`、`restoreVersion`、删除评论）落地时必须接审批。
- schema 字节预算上限调整必须同步本篇 §6。

## 3. 文档工具（11 个）

### 3.1 `space_doc_outline`

```
输入：{ doc_id: string }
输出：{ revision, title, total_blocks, outline: [{ id, type, preview, child_count }] }
```

只返回结构摘要；`preview` ≤ 80 字；最多 200 个顶层块（截断由 `total_blocks` 推断）；总输出 ≤ 2k tokens。

### 3.2 `space_doc_read`

```
输入：{ doc_id, blocks?: string[], after?: string, limit?: number, max_chars?: number }
输出：{ revision, markdown, blocks: [{ id, type }], truncated, next?: string }
```

默认读全部（`max_chars` 1000–40000，默认 12000；`limit` 顶层块上限 500）；推荐 `after` 分页或 `blocks`
定向读。`markdown` 带块锚点注释；超限必须截断并给 `next` 续读锚点。

### 3.3 `space_doc_search`

```
输入：{ doc_id?, space_id?, query: string, limit?: number }
输出：{ query, hits: [{ doc_id, block_id, type, preview }], truncated }
```

标题/正文纯文本检索，块级命中；`preview` ≤ 60 字，默认 20 条、最多 50 条。

### 3.4 `space_doc_ops`

```
输入：{ doc_id, base_revision, ops: Operation[], dry_run?: boolean, idempotency_key?: string }
输出：{ revision, changed_block_ids, diff, warnings, undo_token? }
```

与 [document-operations-v0.md](document-operations-v0.md) §1–§3 一一对应；整批全有或全无。同一
`idempotency_key` 重放返回原结果。`update_text` 的 `oldText` 用 textblock **纯文本**（不含 Markdown
marks）。`dry_run` 返回 diff 不落盘。

### 3.5 `space_doc_patch`

```
输入：{ doc_id, base_revision, block_id, old_text, new_text, replace_all?, dry_run?, idempotency_key? }
输出：{ revision, changed_block_ids, diff, undo_token?, dry_run? }
```

单 textblock 精确纯文本替换（内部一次 `update_text`）。`old_text` 非空且须唯一（重复设 `replace_all`）；
`new_text` 可为空。Agent 一等编辑路径：先 read/outline 取 block id 与 revision 再 patch。错误附下一步：
`doc/conflict`→重读重试；未命中→重读目标块纯文本；不唯一→更长 `old_text` 或 `replace_all`。

### 3.6 `space_doc_undo`

```
输入：{ doc_id, base_revision, undo_token? }
输出：{ revision, changed_block_ids, diff, warnings, undo_token? }
```

应用已提交批次的反向操作；省略 token 撤销最近批次。撤销产生新 revision，可再撤销。

### 3.7 `space_doc_generate`

```
输入：{ doc_id?, space_id?, title?, parent?: id, after?: id, markdown }
输出：{ doc_id, revision, changed_block_ids, title }
```

仅生成新内容（新建文档或明确位置插入），内部只用 `insert_markdown`，不触碰已有块。不传 `doc_id` 新建
revision 1 文档并同事务写入内容。Markdown 走投影解析，未知语法报错不降级。

### 3.8 对象工具

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `space_component_catalog` | `{}` | `{ components: [{ id, name, description, version, props, defaults, ai_writable }] }` |
| `space_object_get` | `{ object_id }` | `{ type, schema_version, payload, provenance? }` |
| `space_object_update` | `{ doc_id, block_id, base_revision, payload }` | `{ revision, object_id, changed_block_ids }` |

组件目录是只读发现工具（props 用 snake_case）。实例 payload 固定
`{ format: "alter-component/1", componentId, componentVersion, props }`；写入按目录 schema fail-closed
校验（`object/invalid`），内部走 `update_object` op。能力受 registry `ai.writable`/`ai.ops` 约束。

### 3.9 `space_asset_import`

```
输入：{ mime, data_base64, name? }
输出：{ asset_id, mime, bytes, name? }
```

仅图片（png/jpeg/webp/gif），解码后 ≤ 4 MiB，内容寻址去重。`asset_id` 写入 `image.attrs.assetId`；
渲染 URL 由客户端拼 `GET /api/alter-space/asset?id=…`。与浏览器上传共用同一资产存储。

## 4. 空间结构工具（2 个）

### 4.1 `space_browse`（读）

```
输入：{ action: 'spaces'|'archived_spaces'|'space'|'tree'|'node'|'overview'|'search'|'trash',
        space_id?, node_id?, query?, include_archived?, limit? }
```

| action | 语义与输出投影 |
| --- | --- |
| `spaces` / `archived_spaces` | 空间列表：`{ spaces: [{ id, name, goal, directories, is_default, order }] }` |
| `space` | 单空间元数据（同上字段） |
| `tree` | 空间树：`{ space_id, total, truncated, nodes: [节点元数据] }`；≤ 500 节点，超出截断 |
| `node` | 单节点元数据 |
| `overview` | 概览投影：最近文档元数据 ≤ 10、活动日计数、最近事件 ≤ 20（含来源）、任务/里程碑有界摘要 |
| `search` | 空间级检索：`{ query, hits: [{ id, type, space_id, title, excerpt, creator }], truncated }`；excerpt ≤ 60 字，默认 20 最多 50 |
| `trash` | 回收站：节点元数据 + 随想预览（≤ 80 字） |

节点元数据固定为 `{ id, kind, title, parent_id, pinned, archived, creator, updated_at }`，**绝不回传
正文**；正文读取走文档工具。`tree` 默认不含已归档节点（`include_archived: true` 包含）。读路径不
`recordOpen`、不改变活动度与未读。

### 4.2 `space_tree`（写）

```
输入：{ action: 'create'|'rename'|'move'|'pin'|'archive'|'delete'|'restore', ... }
```

| action | 参数 | 结果 |
| --- | --- | --- |
| `create` | `space_id, kind: 'folder'\|'note', title?, parent_id?` | 新节点元数据 |
| `rename` | `node_id, title` | 节点元数据 |
| `move` | `node_id, parent_id: string\|null, space_id?, order?` | 节点元数据 |
| `pin` | `node_id, pinned` | 节点元数据 |
| `archive` | `node_id, archived` | 节点元数据 |
| `delete` | `node_id` | 软删除进回收站（可 restore） |
| `restore` | `node_id` | 节点元数据 |

- `create` 的 note 是空文档；正文经 `space_doc_generate`/`space_doc_ops` 写入。`rename` 只改元数据，
  不接受正文（正文写入只经 Document Operations）。
- 归属：新建 `creator='alter'`；归档 `archivedBy='agent'`；已有节点归属不变。
- 结构操作不做 undo：恢复靠回收站（delete/restore）与版本历史；非法移动（如移入自身子孙）拒绝。
- 创建暂无幂等键：重试前先 browse/search 确认（P4 补 `client_request_id`）。
- 读 action 会触发产品既有的闲置自动归档 sweep（写入 `archivedBy='system'`）：不 `recordOpen`、
  不改活动度与未读，但不是无副作用读。
- 迁移冻结期写返回 `migration/read-only`；服务端离线时结构写明确失败（`remote/unavailable`），不排队。

## 5. 控制面工具（2 个）

### 5.1 `space_settings`

```
输入：{ action: 'get'|'set'|'test'|'flush', mode?, server_url?, token?, clear_token?, history_limit?, snapshot_keep? }
输出：{ mode, serverUrl, tokenConfigured, updatedAt, connection, capabilities, storage: { historyLimit, snapshotKeep } | null }
```

字段沿用控制面 camelCase；`token` 只写不读。涉及服务器地址/token/切服务端的写入必须经审批
（无审批服务即失败关闭）并写 `connection-audit.jsonl`；`test` 探测非当前配置地址同样需审批，
不隐式携带已存 token。

### 5.2 `space_migrate`

```
输入：{ action: 'preflight'|'start'|'status'|'cancel', direction: 'to-server'|'from-server', overwrite?, trim_history? }
输出：预检结果或任务状态（phase/transferredBytes/counts/backup 等）
```

`start` 必须经审批；方向必须与当前权威匹配。迁移替换整库并切换权威，必须先 `preflight` 说明影响，
未确认覆盖不得启动。

## 6. 预算与裁剪

- 文档工具 schema 约 +2.2–2.6k tokens；全部工具（含结构工具）以台账 parity 测试的 schema 字节
  棘轮约束总量：15 工具实测 7718 字节，上限 7800（`SCHEMA_BYTE_BUDGET`）；上限调整必须同步本节。
  读投影按字符预算：单次默认 12k、最大 40k 字符。
- 输出 schema 只列模型真正消费的字段，不回传整篇文档或未变更内容；读超限必须截断并给续读锚点；
  写工具不因预算裁剪改变语义。
- 结构摘要与检索独立上限：outline ≤ 2k tokens；doc search 与 space search 默认 20 / 最多 50 条、
  preview/excerpt ≤ 60 字；tree ≤ 500 节点；overview 各段有界（§4.1）。

## 7. 质量验收基线

文档域：10 篇真实文档 × 6 类任务（总结、精确改段、插 callout、生成新章节、改表格单元格、整理 mindmap）：

| 指标 | 目标 |
| --- | --- |
| 核心任务成功率 | ≥ 90% |
| 单任务工具调用 | ≤ 4 次（outline + 定向 read + patch 为主） |
| 投影保真 / op 原子性 / 撤销审计 / 版本资产 | 见 [s0-document-tools.md](../acceptance/s0-document-tools.md) |
| 性能 | 单次 op apply（1 万块级文档）≤ 200ms（本机） |

结构域：归属矩阵、守卫拒绝、双入口一致性与双模式回归见
[s1-capability-alignment.md](../acceptance/s1-capability-alignment.md)。基线不含组件沙箱与实时协作。

## 8. 开放决策项

1. `update_text` 的 mark 继承规则是否够用，还是引入 range/mark op。
2. mindmap/component payload 的内联阈值（当前一律占位 + 工具读写）。
3. table 合并单元格与代码组件沙箱的后续方案。
4. `doc_ops` 是否作为版本历史主存储（当前快照 + op log 并存）。
5. 版本预算（当前 10 版 / 64 KiB → 可配置累计字节）与备份资产目录的实施方案。
6. P2/P3 工具排期：评论、版本列表与恢复、随想、附件、空间治理与协作者、hub 已实现部分。
7. 结构操作可选 CAS 与创建幂等键（P4）；工具可见范围的分域开关细化（读/写/结构/破坏性）。

## 相关文档

- [document-model-v0.md](document-model-v0.md) — 文档权威表示与 Markdown 投影
- [document-operations-v0.md](document-operations-v0.md) — 写入契约与错误码
- [system-architecture.md](system-architecture.md) — 分层、权威栈、归属守卫与持久化
- [Agent 空间工具方案](../designs/agent-doc-tools.md) — 决策与理由
- [文档知识库](../README.md) — 分类与写作规则