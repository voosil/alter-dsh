---
type: spec
status: active
updated: 2026-11-11
---

# Agent 文档工具 v0

本篇规范约束模型可调用的文档工具与控制面工具契约（`space_*`）、投影预算与裁剪、质量验收基线，
是 Agent 文档能力的实施基准。工具读写的底层语义由 [document-model-v0.md](document-model-v0.md)
与 [document-operations-v0.md](document-operations-v0.md) 定义，本篇不重复。

## 1. 通用约定

- 命名沿用产品前缀 `space_*`；读工具 `isConcurrencySafe: true`，写工具为 false。
- **命名风格**：工具顶层输入参数与输出 JSON 统一用 snake_case（`doc_id`、`total_blocks`），与 Host 注册的
  JSON Schema 一致，不得混用；Operation 载荷内的字段遵循
  [document-operations-v0.md](document-operations-v0.md)（如 `edits:[{oldText,newText,replaceAll}]`），两者不混用。
- 文档级工具输出带 `revision`，供后续 ops 的 CAS 使用；对象读取工具返回对象本身，revision 需由
  调用方另行读取文档获得。工具输出不重复回传 `doc_id`（调用方已知）；新建文档的 `generate` 返回新
  `doc_id`，对象工具返回 `object_id`。
- **patch-first**：单处纯文本修改优先用 `space_doc_patch`（一次 `update_text`）；只有多操作或结构
  性变更才用 `space_doc_ops`。禁止用 `generate`/整块替换来重写整篇文档。
- 所有 Space note 正文只有 `alter-doc/1` 一种格式；工具不感知也不接受其他正文格式，非法存储内容
  以 `doc/schema-invalid` 报错。
- 未知/不可写节点在结果中以占位出现，并附 `unsupported` 说明。
- 工具错误使用 [document-operations-v0.md](document-operations-v0.md) §5 的错误码；对象读取的
  `object/not-found` 是工具层补充码。写工具能力受 registry `ai.ops` 与全局写策略约束。
- 工具对所有 Agent（含子 Agent）可见，插件配置门禁（`agentTools.enabled`、写策略与只读开关）
  是唯一范围控制；后续按 preset 或插件作用域收窄。
- DSH 工具框架只做 JSON 解析，参数校验与错误映射必须在工具实现内手写，错误用稳定错误码字符串返回。
- 文档写入必须在 store 的单写者事务回调（`transactDocument`）内完成；不要在该回调内 await 同一个
  store 的其他更新（单写者队列会自锁）。
- 失败要可操作：冲突时返回当前 revision，让模型重读后重试；不允许部分成功却不报错。

## 2. 工具契约

### 2.1 `space_doc_outline`

```
输入：{ doc_id: string }
输出：{ revision, title, total_blocks, outline: [{ id, type, preview, child_count }] }
```

- 只返回结构摘要，不返回正文；`preview` ≤ 80 字；最多返回 200 个顶层块，超出按 200 截断
  （截断与否由 `total_blocks` 与 `outline` 长度推断）；总输出 ≤ 2k tokens。
- 用于先建立全局认知、获取 block id。

### 2.2 `space_doc_read`

```
输入：{ doc_id, blocks?: string[], after?: string, limit?: number, max_chars?: number }
输出：{ revision, markdown, blocks: [{ id, type }], truncated, next?: string }
```

- 默认读全部（受 `max_chars` 限制，1000–40000，默认 12000；`limit` 为顶层块上限，最大 500）；
  推荐按 `after` 分页或按 `blocks` 定向读。
- `markdown` 带块锚点注释；`blocks` 是「本次投影中包含的块」索引，供后续 op 定位。
- 单次默认 12k 字符、最大 40k；超限必须截断并在 `next` 给出续读锚点。

### 2.3 `space_doc_search`

```
输入：{ doc_id?, space_id?, query: string, limit?: number }
输出：{ query, hits: [{ doc_id, block_id, type, preview }], truncated }
```

- 按标题/正文纯文本检索，返回块级命中（`block_id` 可直接用于 ops 或定向 read）。
- 长文档定位、跨文档查找都用它；结果 `preview` ≤ 60 字，默认 20 条、最多 50 条。

### 2.4 `space_doc_ops`

```
输入：{ doc_id, base_revision, ops: Operation[], dry_run?: boolean, idempotency_key?: string }
输出：{ revision, changed_block_ids, diff, warnings, undo_token? }
```

- 与 [document-operations-v0.md](document-operations-v0.md) §1–§3 一一对应；批量 op 整批全有或全无，
  任一 op 校验失败时工具报错（错误码见 [document-operations-v0.md](document-operations-v0.md) §5），不返回部分变更。
- 同一 `idempotency_key` 重放返回原结果（当前实现不做过期裁剪）。
- `update_text` 的 `oldText` 使用 textblock 的**纯文本**（不含 `**`、`==` 等 Markdown marks），
  从 `space_doc_read` 的投影正文去掉行内标记即可得到。
- `dry_run` 用于预览：返回 diff，不落盘。
- 写工具能力受 registry `ai.ops` 与全局写策略约束；本仓库当前策略为默认直接执行、不弹审批。

### 2.5 `space_doc_patch`

```
输入：{ doc_id, base_revision, block_id, old_text, new_text, replace_all?, dry_run?, idempotency_key? }
输出：{ revision, changed_block_ids, diff, undo_token?, dry_run? }
```

- 单个 textblock 的精确纯文本替换：内部固定为一次 `update_text` Operation。`old_text` 非空且必须在
  该块纯文本中唯一（重复出现时设 `replace_all: true`）；`new_text` 可为空字符串（删除文本）。
- 面向 Agent 的一等编辑路径：先 `space_doc_read`（或 `space_doc_outline`）取 block id 与 revision，
  再 patch 目标块；只改目标文本，**不整篇重写**。多操作/结构性修改仍用 `space_doc_ops`。
- `dry_run` 只返回 diff，不落盘、不递增 revision；`idempotency_key` 重放返回原结果；
  `undo_token` 交给 `space_doc_undo` 撤销本次 patch。
- 错误带下一步动作：`doc/conflict` → 重新 read/outline 后重试；`old_text` 未命中 → 重新读取目标块
  纯文本；`old_text` 不唯一 → 更长 `old_text` 或 `replace_all`；`node/not-found` → 重新读取 blocks。

### 2.6 `space_doc_undo`

```
输入：{ doc_id, base_revision, undo_token? }
输出：{ revision, changed_block_ids, diff, warnings, undo_token? }
```

- 应用一次已提交批次的反向操作（`inverseOps`），省略 `undo_token` 时撤销最近一次批次。
- 撤销同样产生新 revision 与 op log 记录（撤销本身可再撤销）。

### 2.7 `space_doc_generate`

```
输入：{ doc_id?, space_id?, title?, parent?: id, after?: id, markdown }
输出：{ doc_id, revision, changed_block_ids, title }
```

- 仅生成**新内容**：创建文档或向明确位置插入；内部只使用 `insert_markdown`（新文档在同一事务写入
  初始块），不触碰已有块。
- 不传 `doc_id` 时新建 revision 1 的 AST 文档，并在同一事务写入本次生成内容（无内容时为空文档）。
- `markdown` 必须走投影解析（见 [document-model-v0.md](document-model-v0.md) §7.3）；未知语法报错，
  不静默降级。

### 2.8 对象工具

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `space_component_catalog` | `{}` | `{ components: [{ id, name, description, version, props, defaults, ai_writable }] }` |
| `space_object_get` | `{ object_id }` | `{ type, schema_version, payload, provenance? }` |
| `space_object_update` | `{ doc_id, block_id, base_revision, payload }` | `{ revision, object_id, changed_block_ids }` |

- `space_component_catalog` 是只读发现工具：返回内置声明式组件目录（稳定 id、props schema、
  默认值与 AI 可写 props）；`props` 字段用 snake_case（`max_length` / `max_items` /
  `item_max_length`）。组件只保存实例，不携带可执行代码。
- 组件实例 payload 固定为 `{ format: "alter-component/1", componentId, componentVersion, props }`；
  `space_object_update` 写入前按目录 schema 校验，未知组件、未知 props、类型/必填/长度/范围/
  列表项越界一律 fail-closed（`object/invalid`）。
- `space_object_update` 内部走 `update_object` op（同一事务创建新对象 + 替换引用）。
- 写入能力受 registry `ai.writable` / `ai.ops` 约束；组件实例 props 必须通过组件目录 schema 校验
  （fail-closed），目录同时以 `ai_writable` 标注推荐给 Agent 的 props 范围。

### 2.9 `space_asset_import`

```
输入：{ mime, data_base64, name? }
输出：{ asset_id, mime, bytes, name? }
```

- 仅图片（`image/png|jpeg|webp|gif`），解码后 ≤ 4 MiB；内容寻址去重，重复导入返回同一 `asset_id`。
- 生成/编辑图片块时把返回的 `asset_id` 写入 `image.attrs.assetId`；渲染 URL 由客户端拼
  `GET /api/alter-space/asset?id=…`。
- 浏览器上传走同源 RPC `doc.importAsset` / `doc.importFile`，与本工具共用同一内容寻址资产存储。

### 2.10 `space_settings`

```
输入：{ action: 'get'|'set'|'test'|'flush', mode?, server_url?, token?, clear_token?, history_limit?, snapshot_keep? }
输出：{ mode, serverUrl, tokenConfigured, updatedAt, connection, capabilities, storage: { historyLimit, snapshotKeep } | null }
```

- 控制面工具：字段沿用 Host 控制面（`settings.*` / `sync.*`）的 camelCase 命名，不混入文档工具
  的 snake_case 规则；`token` 只写不读。
- `set` 中涉及服务器地址/token/切到服务端的写入必须经审批（无审批服务即失败关闭），并写入
  `connection-audit.jsonl`；`test` 探测非当前配置地址同样需要审批，且不隐式携带已存 token。

### 2.11 `space_migrate`

```
输入：{ action: 'preflight'|'start'|'status'|'cancel', direction: 'to-server'|'from-server', overwrite?, trim_history? }
输出：预检结果或任务状态（phase/transferredBytes/counts/backup 等）
```

- `start` 必须经审批；方向必须与当前权威匹配（to-server 要求本地模式，from-server 要求服务端模式）。
- 迁移会替换整库并切换权威；必须先用 `preflight` 说明影响，不得在未确认覆盖时启动。

## 3. 预算与裁剪

- 11 个文档工具 schema 约 +2.2–2.6k tokens；两个控制面工具见 §2.10/§2.11。读投影按字符预算：
  单次默认 12k 字符、最大 40k 字符。
- 每个工具的输出 schema 只列模型真正需要消费的字段，不回传整篇文档或未变更内容。
- 读工具超限必须截断并在 `next` 给出续读锚点；写工具不因预算裁剪而改变语义。
- 结构摘要与检索结果有独立上限：outline ≤ 2k tokens，search 默认 20 条且 preview ≤ 60 字。

## 4. 质量验收基线

用 10 篇真实文档（长文/代码/表格/图片/callout/mindmap 占位/component 占位）与 6 类 Agent 任务
（总结、精确改段、插 callout、生成新章节、改表格单元格、整理 mindmap）验收：

| 指标 | 目标 |
| --- | --- |
| 核心任务成功率 | ≥ 90% |
| 单任务工具调用 | ≤ 4 次（读 outline + 定向 read + patch 为主） |
| 单次读投影 | 默认 12k / 最大 40k 字符 |
| 投影保真 | 文本/列表/表格/图片/callout 可读可定位；占位不丢失 |
| op 原子性 | 无效 op 整批回滚；冲突 `doc/conflict` 不落盘 |
| 撤销/审计 | 任意一次 apply 可撤销；op log 可还原 |
| 版本/资产 | 恢复旧版本后对象/资产仍可渲染 |
| 性能 | 单次 op apply（1 万块级文档）≤ 200ms（本机） |

基线不含：组件沙箱、实时协作。

## 5. 开放决策项

1. `update_text` 的 mark 继承规则是否够用，还是 v0 就引入 range/mark op。
2. mindmap/component payload 的内联阈值（当前 v0：一律占位 + 工具读写）。
3. table 合并单元格与代码组件沙箱的后续方案。
4. `doc_ops` 是否作为版本历史主存储（当前：快照 + op log 并存）。
5. 版本预算（当前 10 版 / 64 KiB → 可配置累计字节）与备份资产目录的实施方案。
6. 列表/发现工具与评论工具是否纳入 v0.1（当前 11 个文档工具含组件目录发现，不含文档列表与评论能力）。

## 相关文档

- [document-model-v0.md](document-model-v0.md) — 文档权威表示与 Markdown 投影
- [document-operations-v0.md](document-operations-v0.md) — 写入契约与错误码
- [system-architecture.md](system-architecture.md) — 分层、传输与持久化约束
- [Agent 文档工具方案](../designs/agent-doc-tools.md) — 为什么用 Host 原生工具与写入三件套
- [文档知识库](../README.md) — 分类与写作规则
