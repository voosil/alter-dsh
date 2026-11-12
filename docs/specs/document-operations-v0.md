---
type: spec
status: active
updated: 2026-11-12
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
  "idempotencyKey": "turn-…",  // 可选，同 key 重放返回原结果
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
- **单批上限 8192 个 operation**：覆盖单文档最大顶层块数的全量替换、清空与版本恢复（一次保存
  可能等于「删除全部顶层块 + 插入全部新块」）；超限返回 `op/invalid`。
- 所有 op 的 target 必须是当前文档内存在的 block id（或明确的父/锚点），不做模糊文本定位。
- 服务端执行顺序：resolve → validate（schema/权限/大小）→ 计算 diff → 事务写入 AST →
  追加 op log → revision+1 → 返回。
- 并发：`baseRevision` 不匹配直接返回 `doc/conflict`，不做自动 merge；调用方应重新
  outline/read 后重试。
- `idempotencyKey` 重放返回原结果；同 key 内容不同返回 `idempotency/conflict`（当前实现不做过期裁剪）。
- `dryRun` 只返回 diff 与校验结果：不写 AST、不追加 op log、不递增 revision。
- **评论级联在同一事务内**：写入提交时，`open` 且 `quote` 非空的评论，若其 `quote` 在新正文扁平文本中
  不再出现，同一事务内被软删除（`status='deleted'`，进「历史评论」）。判据与触发细节见
  [space-comment-v0.md](space-comment-v0.md)；`dryRun` 不触发，`undo` 只回滚正文、不恢复评论。

## 3. Operation 集 v0

| op | 参数 | 语义 |
| --- | --- | --- |
| `insert_blocks` | `parent?: id \| null`, `after?: id`, `index?: number`, `markdown?`, `blocks?` | 在 parent 下、after 之后插入；`markdown` 走投影解析，`blocks` 走 schema 校验 |
| `replace_block` | `target`, `markdown?`, `blocks?` | 整块替换；新块类型必须与原类型一致（换类型用 `transform_block`）；`markdown` 与 `blocks` 二选一 |
| `update_text` | `target`, `edits: [{ oldText, newText, replaceAll? }]` | 在 textblock 的纯文本上精确替换；`oldText` 必须唯一（或 replaceAll）；替换范围继承首个字符的 marks；跨界 mark 会被裁剪（文档化为限制） |
| `update_attrs` | `target`, `attrs` | 按 registry 补丁式更新属性；`null` 删除可选属性；不允许改 `objectId` |
| `move_block` | `target`, `parent?`, `after?`, `index?` | 移动节点（含子树）；目标不得在自身子树内 |
| `delete_block` | `target`, `mode?: 'remove' \| 'unwrap'` | 删除（默认 remove；unwrap 仅对容器块） |
| `transform_block` | `target`, `to`, `attrs?` | 类型转换，必须命中 registry 的转换白名单；同内容模型保留 payload；inline→blocks 把正文包成唯一 paragraph 子块（id 由父 id 派生），blocks→inline 把后代文本按换行展平，不得静默丢正文 |
| `update_object` | `target`（block id）, `payload` | 为 structured/application 块生成新不可变对象并更新 `objectId`（同一事务） |
| `insert_markdown` | `parent?`, `after?`, `markdown` | `insert_blocks` 的便利别名（仅新内容） |

v0 限制：

- 不提供任意路径寻址（如 `blocks[2].children[0]`），只认 block id + 相对锚点。
- 不提供 range/mark 级编辑；需要改格式用 `replace_block`，或 `update_text` + 明确说明。
- `update_text` 只作用于 textblock；改 codeBlock 内容用 `replace_block`。
- Agent 工具层的单块纯文本编辑（`space_doc_patch`）是单次 `update_text` 的封装；工具契约见
  [agent-tools-v1.md](agent-tools-v1.md)，本篇只定义 Operation 语义。

## 4. 撤销与审计

- 每次 apply 写一条 `doc_ops`：`{ id, docId, revision, actor, ops, inverseOps, createdAt, idempotencyKey? }`。
- `undo`：应用最近一次事务的 inverseOps，revision+1；作为新操作记录，不删除历史。
- 撤销以 apply 批次为单位：`undo_token` 对应一条 `doc_ops`；多次 apply 需分别撤销（不按 Agent turn
  自动归组）；用户撤销与 AI 撤销分别标 actor。
- op log 是审计与 undo 依据；版本历史仍用快照，两者并存（见 §7）。

## 5. 错误码

| code | 场景 |
| --- | --- |
| `doc/not-found` | 文档不存在/已删 |
| `doc/conflict` | `baseRevision` 不匹配 |
| `doc/too-large` | AST 序列化或文件资产超上限 |
| `doc/schema-invalid` | AST 结构、`format`、`schemaVersion`、`revision` 或存储内容不合法 |
| `op/invalid` | op 参数非法/未知 op |
| `node/not-found` | target 不存在或已删除 |
| `node/schema-invalid` | 节点/属性不符合 registry |
| `node/unsupported-transform` | 类型转换不在白名单 |
| `node/not-writable` | AI 能力声明禁止 |
| `object/invalid` | 对象 payload 或资产内容校验失败 |
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
  }
}
```

约束：payload 只有 `root` 树（`id` + `text` + 可选 `children`），不存布局/主题等渲染参数；
节点数 ≤ 500；单节点文本 ≤ 500 字。

### 6.3 组件 payload v1（声明式目录）

```jsonc
{
  "format": "alter-component/1",
  "componentId": "builtin/progress",   // 内置目录 id（编译进协议包）
  "componentVersion": 1,
  "props": { "label": "任务进度", "value": 60 }
}
```

- 组件目录（协议包 `vendor/protocol`）声明 id、props schema、默认值与 `aiWritable`；
  Host 按目录校验 `componentId/version/props`，未知组件或 props、类型/必填/长度/范围越界一律
  `object/invalid`（fail-closed）。AI 先查 `space_component_catalog`，写入走 `update_object`。
- 文档只保存 `{ objectId, title? }`，不保存渲染器实现；渲染由客户端静态 registry 按目录 id 选择，
  **不执行任意代码**。v1 未实现内容寻址 specHash、bindings 与持久化实例状态（checklist 勾选仅本地）；
  代码组件（sandbox + 审核通道）留后续版本。

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
  `${dataDir}/assets/<sha[0:2]>/<sha256>.<ext>`（0600，未知 mime 用 `bin`），DB 只存元数据。
- 图片资产：png/jpeg/webp/gif，单资产 ≤ 4 MiB；Agent 工具 `space_asset_import` 与浏览器 RPC
  `doc.importAsset`（`{ mime, dataBase64, name? }` → `{ assetId, mime, bytes, width?, height? }`）
  接收 base64，解码后校验 mime/大小并去重；编辑器图片上传走后者。
- 文件资产：白名单内 mime（图片四类、`application/pdf`、`text/plain`、`text/markdown`、`text/csv`、
  `application/json`、`application/zip` 与 Office Open XML docx/xlsx/pptx）原样保存；白名单外——包括
  浏览器对大量扩展名上报的空串/未知类型（如 .sketch/.heic/.log）——一律以 `application/octet-stream`
  存储并保留原始 `name` 作为下载文件名，HTML/SVG/JS 等可内联执行类型同样降级，绝不以原 mime 返回。
  单文件 ≤ 8 MiB；空内容/超限仍报中文可读错误。浏览器 RPC `doc.importFile`
  （`{ mime, dataBase64, name? }` → `{ assetId, mime, bytes, name? }`）接收 base64；文件卡以
  `attrs.assetId` 引用资产（GC 依据）。
- 读取：Host 注册 `GET /api/alter-space/asset?id=<assetId>`（Connection 鉴权）返回原始字节；
  图片以 `content-type` inline 返回供 `<img>` 渲染，非图片返回 `content-disposition: attachment`
  （文件名做 CRLF/引号转义），两者均带 `x-content-type-options: nosniff` 与 immutable 缓存；
  `space-asset://` 只是 Markdown 投影里的引用写法。
- 备份：资产目录必须纳入备份/恢复流程（见 §7）。每日快照会同时生成资产归档。

## 7. 版本、快照与备份

- **文档 revision**：每次成功 apply/undo/restore +1；是 CAS 与乐观并发的基础。
- **快照版本**：内容为规范化（键序稳定、紧凑 JSON）的 AST 序列化；写入时按「revision 每 N 次
  或每次内容变化」生成，沿用现有每 5 分钟最多一版的节流。
- **op log**（`doc_ops`）：审计/撤销依据；与快照并存。
- **对象/资产**：不重复进快照，只存引用；Host 启动时按「当前文档 + 保留版本」引用做 GC。
- **版本预算**：当前「每篇 10 版 / 64 KiB」由存储设置控制、在写入事务内从最旧裁剪；
  AST 快照更大，预算重估仍开放（见 [agent-tools-v1.md](agent-tools-v1.md)）。
- **恢复**：restore 历史快照 = 通过 delete+insert Operations 重放该 AST、revision+1、追加 op log；
  旧对象/资产按引用保活；版本历史全部为 AST 快照，恢复只接受 AST。
- **备份**：数据库快照 + `assets/` 归档（`space-YYYYMMDD.assets.tar.gz`）成对生成与保留；恢复流程同时覆盖两者。

## 8. RPC 暴露

- 对应端点：`doc.get` / `doc.outline` / `doc.read` / `doc.search` / `doc.applyOps` / `doc.undo` / `doc.restoreVersion` / `doc.generate` / `doc.importAsset` / `doc.importFile` / `doc.updateObject` / `object.get`；
  其中 `doc.applyOps` / `doc.generate` / `doc.undo` / `doc.restoreVersion` / `doc.updateObject` 是正文写入入口，
  `doc.importAsset` / `doc.importFile` 是资产上传入口，其余端点只读；
  `doc.get` 返回完整 AST（编辑器加载用），`doc.undo` 应用一次 op log 的 `inverseOps`；
  浏览器文档页（内核 + `@alter-space/document-runtime`）加载 AST、编辑后在客户端做 block 级 diff
  生成 Operation 批次再提交，不整篇覆盖；
  新增端点必须同时加入 Host 路由白名单与浏览器客户端映射（约束见 [system-architecture.md](system-architecture.md)）。
- 端点参数/结果沿用本规范 §1 信封与 §5 错误码；Agent 工具契约见 [agent-tools-v1.md](agent-tools-v1.md)。

## 相关文档

- [document-model-v0.md](document-model-v0.md) — 文档权威表示与 Markdown 投影
- [agent-tools-v1.md](agent-tools-v1.md) — 模型可调用工具与预算
- [system-architecture.md](system-architecture.md) — 分层、传输与 SQLite 持久化约束
- [文档内容架构](../designs/document-content-architecture.md) — 设计与取舍
- [文档知识库](../README.md) — 分类与写作规则
