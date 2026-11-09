---
type: spec
status: draft
updated: 2026-11-09
---

# Agent 文档工具 v0

本篇规范约束模型可调用的文档工具契约（`space_*`）、投影预算与裁剪、spike 验收标准，
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
- 未知/不可写节点在结果中以占位出现，并附 `unsupported` 说明。
- 工具错误使用 [document-operations-v0.md](document-operations-v0.md) §5 的错误码；写工具能力受
  registry `ai.ops` 与全局写策略约束。

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
  任一 op 校验失败时工具报错（错误码见 §5），不返回部分变更。
- 同一 `idempotency_key` 重放返回原结果（契约保留窗口 24h；当前实现未做过期裁剪）。
- `update_text` 的 `oldText` 使用 textblock 的**纯文本**（不含 `**`、`==` 等 Markdown marks），
  从 `space_doc_read` 的投影正文去掉行内标记即可得到。
- `dry_run` 用于预览：返回 diff，不落盘。
- 写工具能力受 registry `ai.ops` 与全局写策略约束；本仓库当前策略为默认直接执行、不弹审批。

### 2.5 `space_doc_generate`

```
输入：{ doc_id?, space_id?, title?, parent?: id, after?: id, markdown }
输出：{ doc_id, revision, changed_block_ids, title }
```

- 仅生成**新内容**：创建文档或向明确位置插入；内部使用 `insert_markdown` / `replace_block`，
  不触碰其他块。
- `markdown` 必须走投影解析（见 [document-model-v0.md](document-model-v0.md) §7.3）；未知语法报错，
  不静默降级。

### 2.6 对象工具

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `space_object_get` | `{ object_id }` | `{ type, schema_version, payload, provenance? }` |
| `space_object_update` | `{ doc_id, block_id, base_revision, payload }` | `{ revision, object_id, changed_block_ids }` |

- `space_object_update` 内部走 `update_object` op（同一事务创建新对象 + 替换引用）。
- 只有 registry 声明 `ai.writable` 的对象类型可用；application 组件只允许改 registry 暴露的
  props 子集。

### 2.7 资产工具（v0.1，规划中，尚未注册）

- `space_asset_import`：接收 DSH 附件/文件引用，返回 `asset_id`；或由外部上传后由工具校验。
- v0 不做模型直接上传大文件，先支持「引用已有附件」。

## 3. 预算与裁剪

- 7 个核心工具 schema 约 +1.2–1.6k tokens；读投影单次 ≤ 12k tokens / ≤ 40k 字符。
- 每个工具的输出 schema 只列模型真正需要消费的字段，不回传整篇文档或未变更内容。
- 读工具超限必须截断并在 `next` 给出续读锚点；写工具不因预算裁剪而改变语义。
- 结构摘要与检索结果有独立上限：outline ≤ 2k tokens，search 默认 20 条且 preview ≤ 60 字。

## 4. Spike 验收标准

用 10 篇真实文档（长文/代码/表格/图片/callout/mindmap 占位/component 占位）与 6 类 Agent 任务
（总结、精确改段、插 callout、生成新章节、改表格单元格、整理 mindmap）验收：

| 指标 | 目标 |
| --- | --- |
| 核心任务成功率 | ≥ 90% |
| 单任务工具调用 | ≤ 4 次（读 outline + 定向 read + ops 为主） |
| 单次读投影 | ≤ 12k tokens / ≤ 40k 字符 |
| 投影保真 | 文本/列表/表格/图片/callout 可读可定位；占位不丢失 |
| op 原子性 | 无效 op 整批回滚；冲突 `doc/conflict` 不落盘 |
| 撤销/审计 | 任意一次 apply 可撤销；op log 可还原 |
| 版本/资产 | 恢复旧版本后对象/资产仍可渲染 |
| 性能 | 单次 op apply（1 万块级文档）≤ 200ms（本机） |

Spike 不做：完整 Tiptap 编辑器、组件沙箱、存量批量迁移、实时协作。

## 5. 开放决策项

1. 投影锚点形式：HTML 注释（当前默认）vs 指令 attrs vs 仅返回侧索引。
2. `update_text` 的 mark 继承规则是否够用，还是 v0 就引入 range/mark op。
3. mindmap/component payload 的内联阈值（当前 v0：一律占位 + 工具读写）。
4. table 合并单元格、评论锚点、代码组件沙箱的 v1 方案。
5. `doc_ops` 是否作为版本历史主存储（当前：快照 + op log 并存）。
6. 版本预算（当前 10 版 / 64 KiB → 可配置累计字节）与备份资产目录的实施方案。
7. 列表/发现工具与评论工具是否纳入 v0.1（当前 7 个工具不含列表与评论能力）。

## 相关文档

- [document-model-v0.md](document-model-v0.md) — 文档权威表示与 Markdown 投影
- [document-operations-v0.md](document-operations-v0.md) — 写入契约与错误码
- [system-architecture.md](system-architecture.md) — 分层、传输与持久化约束
- [Agent 文档工具方案](../designs/agent-doc-tools.md) — 为什么用 Host 原生工具与写入三件套
- [文档知识库](../README.md) — 分类与写作规则
