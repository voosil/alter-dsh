---
type: spec
status: draft
updated: 2026-11-09
---

# 文档操作 v0

本篇规范约束对 `AlterDoc` 的写入契约：请求/响应信封、Operation 集、原子性与并发、撤销与审计、
错误码、对象与资产模型，以及版本/快照/备份行为。Host 端点与 Agent 工具对文档内容的任何修改
都必须经过本篇定义的 Operation 通道；文档表示本身见 [document-model-v0.md](document-model-v0.md)。

## 1. 请求与响应信封

```jsonc
// 请求
{
  "docId": "doc-…",
  "baseRevision": 12,          // 必须等于当前 revision；否则 doc/conflict
  "idempotencyKey": "turn-…",  // 可选，24h 内重放返回原结果
  "dryRun": false,             // true = 只返回 diff，不落盘
  "ops": [ /* Operation[]，顺序执行 */ ]
}

// 响应
{
  "revision": 13,
  "changedBlockIds": ["blk_…"],
  "diff": { "ops": [ /* 每 op 的变更摘要，供 UI/日志 */ ] },
  "undoToken": "undo_…",       // 可选，用于撤销本次事务
  "warnings": []
}
```

## 2. 执行语义与并发

- 批量**全有或全无**：任一 op 校验或执行失败 → 整个事务回滚，返回逐 op 错误数组
  `[{ index, code, message }]`。
- 所有 op 的 target 必须是当前文档内存在的 block id（或明确的父/锚点），不做模糊文本定位。
- 服务端执行顺序：resolve → validate（schema/权限/大小）→ 计算 diff → 事务写入 AST →
  追加 op log → revision+1 → 返回。
- 并发：`baseRevision` 不匹配直接返回 `doc/conflict`，不做自动 merge；调用方应重新
  outline/read 后重试。
- `idempotencyKey` 在 24h 内重放返回原结果；同 key 内容不同返回 `idempotency/conflict`。
- `dryRun` 只返回 diff 与校验结果：不写 AST、不追加 op log、不递增 revision。

## 3. Operation 集 v0

| op | 参数 | 语义 |
| --- | --- | --- |
| `insert_blocks` | `parent?: id \| null`, `after?: id`, `index?: number`, `markdown?`, `blocks?` | 在 parent 下、after 之后插入；`markdown` 走投影解析，`blocks` 走 schema 校验 |
| `replace_block` | `target`, `markdown?`, `blocks?` | 整块替换；新块类型必须与原类型一致（换类型用 `transform_block`）；`markdown` 与 `blocks` 二选一 |
| `update_text` | `target`, `edits: [{ oldText, newText, replaceAll? }]` | 在 textblock 的纯文本上精确替换；`oldText` 必须唯一（或 replaceAll）；替换范围继承首个字符的 marks；跨界 mark 会被裁剪（文档化为限制） |
| `update_attrs` | `target`, `attrs` | 按 registry 补丁式更新属性；`null` 删除可选属性；不允许改 `objectId` |
| `move_block` | `target`, `parent?`, `after?`, `index?` | 移动节点（含子树）；目标不得在自身子树内 |
| `delete_block` | `target`, `mode?: 'remove' \| 'unwrap'` | 删除（默认 remove；unwrap 仅对容器块） |
| `transform_block` | `target`, `to`, `attrs?` | 类型转换，必须命中 registry 的转换白名单；保留字段规则由 registry 声明 |
| `update_object` | `target`（block id）, `payload` | 为 structured/application 块生成新不可变对象并更新 `objectId`（同一事务） |
| `insert_markdown` | `parent?`, `after?`, `markdown` | `insert_blocks` 的便利别名（仅新内容） |

v0 限制：

- 不提供任意路径寻址（如 `blocks[2].children[0]`），只认 block id + 相对锚点。
- 不提供 range/mark 级编辑；需要改格式用 `replace_block`，或 `update_text` + 明确说明。
- `update_text` 只作用于 textblock；改 codeBlock 内容用 `replace_block`。

## 4. 撤销与审计

- 每次 apply 写一条 `doc_ops`：`{ id, docId, revision, actor, ops, inverseOps, createdAt, idempotencyKey? }`。
- `undo`：应用最近一次事务的 inverseOps，revision+1；作为新操作记录，不删除历史。
- AI 一次 turn 的多个 op batch 归组为一个 transaction，可整体撤销；用户撤销与 AI 撤销分别标 actor。
- op log 是审计与 undo 依据；版本历史仍用快照，两者并存（见 §7）。

## 5. 错误码

| code | 场景 |
| --- | --- |
| `doc/not-found` | 文档不存在/已删 |
| `doc/conflict` | `baseRevision` 不匹配 |
| `doc/too-large` | AST 序列化超上限 |
| `doc/schema-invalid` | AST 结构、`format`、`schemaVersion` 或 `revision` 不合法 |
| `doc/legacy-format` | 目标文档仍是旧 HTML 格式，暂不支持结构化读写 |
| `op/invalid` | op 参数非法/未知 op |
| `node/not-found` | target 不存在或已删除 |
| `node/schema-invalid` | 节点/属性不符合 registry |
| `node/unsupported-transform` | 类型转换不在白名单 |
| `node/not-writable` | AI 能力声明禁止 |
| `object/invalid` | 对象 payload 校验失败 |
| `parse/unsupported` | Markdown 含未知语法/指令 |
| `idempotency/conflict` | 同 key 内容不同 |

## 6. 对象与资产

### 6.1 不可变对象（`doc_objects`）

```jsonc
{
  "id": "obj_01HX…",
  "docId": "doc-…",
  "type": "mindmap" | "component",
  "schemaVersion": 1,
  "payload": { /* 类型化 JSON */ },
  "provenance": { "generatedBy": "alter", "model": "…", "promptRef": "…", "at": "…" },
  "createdAt": "…"
}
```

- 对象**不可变**：修改 = 生成新 id，`update_object` 在同一事务内替换 block 的 `objectId`；
  旧对象保留给历史版本。
- GC 只清理「无任何版本引用 + 超过保留期」的对象。
- 对象类型有独立 JSON Schema，与 node registry 解耦，便于组件独立演进。

### 6.2 思维导图 payload v0

```jsonc
{
  "root": {
    "id": "n1", "text": "项目目标",
    "children": [
      { "id": "n2", "text": "市场分析" },
      { "id": "n3", "text": "产品规划" }
    ]
  },
  "layout": { "type": "tree", "direction": "LR" },
  "theme": "default"
}
```

约束：节点数 ≤ 500；单节点文本 ≤ 500 字；不允许环。

### 6.3 组件 payload v0（声明式）

```jsonc
{
  "kind": "declarative",
  "renderer": "chart",           // 由组件 registry 注册的渲染器 id
  "props": { "type": "bar", "data": [/* … */] },
  "bindings": [{ "source": "doc", "query": "…" }],
  "state": null                  // 可选，实例状态；不进文档备份时可省略
}
```

- v0 **只允许声明式组件**；代码组件（sandbox iframe）在 v0.1+ 通过审核通道引入，存 `component_specs`。
- 文档只保存 `{ objectId, title? }`，不保存渲染器实现。

### 6.4 资产（`doc_assets`）

```jsonc
{
  "id": "asset_01HX…",
  "sha256": "…",
  "mime": "image/png",
  "bytes": 123456,
  "width": 1200, "height": 800,
  "name": "架构图.png",
  "createdAt": "…"
}
```

- 内容寻址：同字节只存一份；id 为 `asset_<sha256 前 32 位>`，二进制放
  `${dataDir}/assets/<sha[0:2]>/<sha256>.<ext>`（0600），DB 只存元数据。
- 只允许图片（png/jpeg/webp/gif），单资产 ≤ 4 MiB；导入时校验 mime/大小并去重。
- 导入：Agent 工具 `space_asset_import` 接收 base64（≤ 4 MiB 解码后）；浏览器/编辑器后续可直接上传。
- 读取：Host 注册 `GET /api/alter-space/asset?id=<assetId>`（Connection 鉴权）返回原始字节，
  客户端用该 URL 渲染 `<img>`；`space-asset://` 只是 Markdown 投影里的引用写法，不直接进 HTML。
- 备份：资产目录必须纳入备份/恢复流程（见 §7）。当前每日快照仍只覆盖 SQLite；资产备份为已知待补项。

## 7. 版本、快照与备份

- **文档 revision**：每次成功 apply/undo/restore +1；是 CAS 与乐观并发的基础。
- **快照版本**：内容为规范化（键序稳定、紧凑 JSON）的 AST 序列化；写入时按「revision 每 N 次
  或每次内容变化」生成，沿用现有每 5 分钟最多一版的节流。
- **op log**（`doc_ops`）：审计/撤销依据；与快照并存。
- **对象/资产**：不重复进快照，只存引用；GC 按引用与保留期。
- **版本预算**：当前「每篇 10 版 / 64 KiB」由存储设置控制、在写入事务内从最旧裁剪；
  AST 快照更大，预算重估仍开放（见 [agent-doc-tools-v0.md](agent-doc-tools-v0.md)）。
- **恢复**：restore 历史快照 = 通过 delete+insert Operations 重放该 AST、revision+1、追加 op log；
  旧对象/资产按引用保活；旧 HTML 历史版本对 AST 文档拒绝恢复（需先迁移）。
- **备份**：SQLite 快照 + `assets/` 目录 +（可选）`objects/` 导出清单；恢复流程必须同时覆盖三者。

## 8. RPC 暴露

- 对应端点：`doc.get` / `doc.outline` / `doc.read` / `doc.search` / `doc.applyOps` / `doc.undo` / `doc.restoreVersion` / `doc.generate` / `object.get`；
  `doc.get` 返回完整 AST（编辑器加载用），`doc.undo` 应用一次 op log 的 `inverseOps`；
  浏览器编辑器加载 AST、编辑后在客户端做 block 级 diff 生成 Operation 批次再提交，不整篇覆盖；
  新增端点必须同时加入 Host 路由白名单与浏览器客户端映射（约束见 [system-architecture.md](system-architecture.md)）。
- 端点参数/结果沿用本规范 §1 信封与 §5 错误码；Agent 工具契约见 [agent-doc-tools-v0.md](agent-doc-tools-v0.md)。

## 相关文档

- [document-model-v0.md](document-model-v0.md) — 文档权威表示与 Markdown 投影
- [agent-doc-tools-v0.md](agent-doc-tools-v0.md) — 模型可调用工具与预算
- [system-architecture.md](system-architecture.md) — 分层、传输与 SQLite 持久化约束
- [文档内容架构](../designs/document-content-architecture.md) — 设计与取舍
- [文档知识库](../README.md) — 分类与写作规则
