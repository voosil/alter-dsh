# Alter Document Model v0 规范（Spec）

- 状态：v0 草案（实现/spike 基准，待评审）
- 日期：2026-11-09
- 上位文档：[research-document-storage-format.md](./research-document-storage-format.md) §11（终局架构：JSON AST 权威 + Markdown 投影 + Document Operations）
- 适用范围：Alter 产品文档模型（Space 文档）。实现落点：**`Alter-dsh` 单仓库**（上游 Alter 已废弃，本仓库为唯一事实源；`vendor/` 是自持基线，必要时可直接修改并在 `vendor/VENDOR.md` 登记）。
- 本规范冻结的内容：节点模型、ID/版本语义、Markdown 投影规则、Operation 集、对象/资产模型、Agent 工具契约、存储映射。**不包含**：完整编辑器实现、组件运行时沙箱细节、迁移脚本细节（各自另立文档）。

---

## 1. 目标与非目标

### 1.1 目标

- 文档**权威存储为 JSON AST**：类型化节点树、稳定 block id、可校验、可协作演进。
- **AI 读 Markdown 投影**：按块/范围读取、带定位信息、有 token 预算。
- **AI 写 Document Operations**：精确、原子、可校验、可审计、可撤销；内容生成允许用 Markdown 但只解析为「明确目标位置的新节点」。
- **Document as Content 与 Document as Application 分离**：交互组件有独立 schema/运行时，不混进正文语义。
- 人编辑器（Tiptap）与 AI 工具**共享同一 Schema Registry**，避免定义漂移。

### 1.2 非目标（v0）

- 不做实时协作/CRDT（但 revision/op 设计为可迁移）。
- 不做任意 AI 生成代码的执行（代码组件属后续审核通道）。
- 不做 Markdown 全量回写解析（禁止整篇 Markdown→AST）。
- 不改 `vendor/protocol` 实体结构（通过 `content` 字符串 + 插件自有旁表承载）。

---

## 2. 文档模型

### 2.1 顶层信封

`SpaceNode.content` 存储序列化后的 `AlterDoc` JSON 字符串；`contentFormat: "alter-doc/1"`。

```jsonc
{
  "format": "alter-doc/1",
  "schemaVersion": 1,
  "revision": 12,              // 每成功 apply 一次 +1；CAS 依据
  "blocks": [ /* Block[]，顺序即文档顺序 */ ]
}
```

约束：
- `revision` 从 0 开始，单调递增，不回退；恢复历史版本也 +1。
- 文档级大小上限 v0：序列化后 ≤ 512 KiB（可配置）；超限拒绝写入。
- 禁止在 `content` 里放二进制/大 payload（走对象/资产旁表）。

### 2.2 Block 节点

```ts
interface BlockNode {
  id: string;                 // "blk_" + ULID，全局唯一、永不复用
  type: string;               // Schema Registry 中的节点类型
  attrs: Record<string, JsonValue>;   // 类型化属性（可为空对象）
  content?: InlineNode[];     // textblock：行内内容
  children?: BlockNode[];     // 容器块：子块（顺序即渲染顺序）
}
```

规则：
- `content` 与 `children` 按节点类型二选一或都无（由 registry 的 `contentModel` 决定）。
- 未知属性写入前按 registry 校验/拒绝；未知节点类型**不可写入**（读取时按 `opaque` 降级渲染）。
- 节点 id 由服务端在插入时分配；客户端可携带候选 id，冲突则重新分配。
- 删除即从树中移除；op log 记录 inverse，用于撤销（不需要 tombstone 表，v0）。

### 2.3 InlineNode 与 Marks

```ts
type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }   // 相邻同 marks 的文本必须合并（canonical）
  | { type: 'hardBreak' };

interface Mark {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight' | 'link';
  attrs?: { href?: string };   // link 必填 href
}
```

v0 行内子集：
- `bold` → `**x**`；`italic` → `*x*`；`strike` → `~~x~~`；`code` → `` `x` ``；
- `highlight` → `==x==`（扩展语法）；`underline` → `<u>x</u>`（投影用内联 HTML，解析时仅接受 `<u>`）；
- `link` → `[x](href)`；只允许 `https?` / `mailto` / 站内相对路径。
- 评论锚点、颜色、字号 v0 不做（评论继续用 `Comment.quote`）；新增 mark 必须升 `schemaVersion`。

### 2.4 文档级元数据

文档标题仍用 `SpaceNode.title`；不在 AST 内重复。AST 只承载正文结构。

---

## 3. Schema Registry（唯一事实源）

所有消费方（存储校验、Tiptap node spec、AI 工具 JSON Schema、Markdown 投影、迁移、能力声明）都从同一份 registry 生成：

```ts
interface NodeTypeDefinition {
  type: string;
  schemaVersion: number;
  kind: 'content' | 'structured' | 'application';
  contentModel: 'inline' | 'blocks' | 'none' | 'table';
  attrs: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'json' | 'assetRef' | 'objectRef';
    required?: boolean;
    default?: JsonValue;
    enum?: JsonValue[];
  }>;
  allowedMarks?: MarkType[];           // textblock 可用 marks
  allowedChildren?: string[] | 'block+';
  ai: {
    readable: boolean;
    writable: boolean;                 // 是否允许 AI 操作
    preview: 'markdown' | 'directive' | 'placeholder';
    ops: OpName[];                     // 该类型允许的 op 子集
    describe?: boolean;                // application 节点是否暴露能力描述
  };
  markdown: {
    serialize(node: BlockNode, ctx: ProjectionContext): string;
    parse?(source: string, ctx: ParseContext): BlockNode | null; // 仅新内容解析
    anchors: 'comment' | 'none';
  };
  render: { editor: string; readOnly: string };  // node view / 只读渲染器 id
  migrate?(node: BlockNode, fromSchemaVersion: number): BlockNode;
}
```

v0 registry 规模建议 ≤ 20 个节点类型；新增类型必须同时提供 schema、投影、渲染、迁移与能力声明。

### 3.1 v0 节点类型

| type | kind | contentModel | attrs | AI 能力 | Markdown 投影 |
| --- | --- | --- | --- | --- | --- |
| `paragraph` | content | inline | — | 读写/全 op | 段落文本 |
| `heading` | content | inline | `level: 1..6` | 读写/全 op | `#`…`######` |
| `bulletList` | content | blocks | — | 读写/结构 op | `- ` 列表 |
| `orderedList` | content | blocks | `start?: number` | 读写/结构 op | `1. ` 列表 |
| `taskList` | content | blocks | — | 读写/结构 op | `- [ ]` / `- [x]` |
| `listItem` | content | blocks | `checked?: boolean` | 读写/结构 op | 由父列表决定 |
| `blockquote` | content | blocks | — | 读写/结构 op | `> ` |
| `codeBlock` | content | none | `lang?: string` | 读 + 整块替换 | 围栏代码块 |
| `divider` | content | none | — | 插入/删除 | `---` |
| `table` | content | table | `headerRows?: number` | 读 + 结构 op（v0 限制） | GFM 表格 |
| `tableRow` / `tableCell` | content | blocks / inline | — | 结构 op | GFM |
| `image` | content | none | `assetId`, `alt?`, `caption?`, `width?` | 读 + 替换/属性 | `![alt](space-asset://…)` |
| `callout` | content | blocks | `tone: info\|warn\|success\|danger`, `title?`, `icon?`, `collapsed?` | 读写/结构+属性 | `:::callout{…}` 指令 |
| `mindmap` | structured | none | `objectId`, `caption?` | 读占位 + `update_object` | `:::mindmap{objectId=…}` 占位 |
| `component` | application | none | `objectId`, `title?`, `description?` | 读 `describe` + `update_object`（仅 props） | `:::component{objectId=…}` 占位 |

- `image` 的 `space-asset://` URI 只由投影生成、不被 Markdown 解析器接受；插入图片必须用 `assetId`。
- table 在 v0 只支持矩形、无合并单元格；合并单元格 v1 再议。
- mindmap/component 的大 payload 永不进 Markdown；投影只给占位。

---

## 4. Markdown 投影规范

### 4.1 投影原则

- 投影是**只读视图**，用于 AI 阅读与人工导出；**不是第二真源**。
- 默认开启块锚点（AI 视图）：每个顶层块前加 HTML 注释 `<!-- blk:blk_xxx -->`；导出/人类视图剥离。
- 投影必须有界：工具层按块/范围裁剪，单次 ≤ 12k tokens（见 §8）。
- 无法投影的 mark/节点：降级为可见占位，并在工具结果 `capabilities` 中说明；**不静默丢失**。

### 4.2 语法映射

| AST | Markdown |
| --- | --- |
| paragraph | 普通段落（块间空行） |
| heading | `#`…`######` |
| bulletList / orderedList / taskList | GFM 列表 / `- [ ]` |
| blockquote | `> ` 前缀 |
| codeBlock | 围栏代码块（三个反引号 + 语言标记） |
| divider | `---` |
| table | GFM 表格（首行表头） |
| image | `![alt](space-asset://asset_…)` |
| callout | `:::callout{tone="warn" title="…" #blk_id}` … `:::` |
| mindmap | `:::mindmap{objectId="obj_…" caption="…" #blk_id}` 空体 `:::` |
| component | `:::component{objectId="obj_…" title="…" #blk_id}` 空体 `:::` |
| 未知节点 | `:::opaque{type="…" #blk_id}` + 一行 `[unsupported node]` |

### 4.3 解析方向（仅新内容）

- 只允许在以下场景由 Markdown 生成节点：`insert_blocks` / `replace_block` / `space_generate`。
- 解析器只接受 §4.2 中的语法与已知指令；遇到未知指令、未知 HTML、无法表达的 attrs → **报错**（`parse/unsupported`），由调用方回退为结构化 op。
- 指令属性白名单：`tone/title/icon/collapsed/caption/level/start/lang`；id 只接受服务端分配，忽略外部传入。
- 图片的 `space-asset://` 在解析时校验存在性；不存在 → 报错，不落盘。

### 4.4 禁止事项

- 禁止「整篇 Markdown → AST」或「AI 输出全文再覆盖」。
- 禁止在 Markdown 中内联组件 payload/JSON（v0）；复杂对象只给占位 + 工具读写。
- 禁止把投影锚点写回存储（它是视图产物）。

---

## 5. Document Operations

### 5.1 请求 / 响应信封

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

语义：
- 批量**全有或全无**：任一 op 校验/执行失败 → 整个事务回滚，返回错误数组 `[{index, code, message}]`。
- 所有 op 的 target 必须是当前文档内存在的 block id（或明确的父/锚点），不做模糊文本定位。
- 服务端执行顺序：resolve → validate（schema/权限/大小）→ 计算 diff → 事务写入 AST → 追加 op log → revision+1 → 返回。
- 并发：`baseRevision` 不匹配直接 `doc/conflict`，调用方应重新 `outline/read` 后重试；不做自动 merge。

### 5.2 Operation 集 v0

| op | 参数 | 语义 |
| --- | --- | --- |
| `insert_blocks` | `parent?: id \| null`, `after?: id`, `index?: number`, `markdown?`, `blocks?` | 在 parent 下、after 之后插入；`markdown` 走 §4.3 解析；`blocks` 走 schema 校验 |
| `replace_block` | `target`, `markdown?`, `blocks?` | 整块替换，新块类型必须与原类型一致（换类型用 `transform_block`）；`markdown` 与 `blocks` 二选一 |
| `update_text` | `target`, `edits: [{oldText, newText, replaceAll?}]` | 在 textblock 的纯文本上精确替换；`oldText` 必须唯一（或 replaceAll）；替换范围继承首个字符的 marks；跨界 mark 会被裁剪（文档化为限制） |
| `update_attrs` | `target`, `attrs` | 按 registry 补丁式更新属性；`null` 删除可选属性；不允许改 `objectId` |
| `move_block` | `target`, `parent?`, `after?`, `index?` | 移动节点（含子树）；目标不得在自身子树内 |
| `delete_block` | `target`, `mode?: 'remove' \| 'unwrap'` | 删除（默认 remove；unwrap 仅对容器块） |
| `transform_block` | `target`, `to`, `attrs?` | 类型转换，必须命中 registry 的转换白名单；保留字段规则由 registry 声明 |
| `update_object` | `target`（block id）, `payload` | 为 structured/application 块生成新不可变对象并更新 `objectId`（同一事务） |
| `insert_markdown` | `parent?`, `after?`, `markdown` | `insert_blocks` 的便利别名（仅新内容） |

v0 限制：
- 不提供任意路径寻址（如 `blocks[2].children[0]`），只认 block id + 相对锚点。
- 不提供 range/mark 级编辑；需要改格式用 `replace_block` 或 `update_text` + 明确说明。
- `update_text` 只作用于 textblock；对 codeBlock 用 `replace_block`。

### 5.3 撤销与审计

- 每次 apply 写一条 `doc_ops`：`{id, docId, revision, actor, ops, inverseOps, createdAt, idempotencyKey?}`。
- `undo`：应用最近一次事务的 inverseOps，revision+1（作为新操作记录，不删除历史）。
- AI 一次 turn 的多个 op batch 归组为一个 transaction，可整体撤销；用户撤销与 AI 撤销分别标 actor。
- op log 是审计与 undo 依据；版本历史仍用快照（两者并存，见 §7）。

### 5.4 错误码

| code | 场景 |
| --- | --- |
| `doc/not-found` | 文档不存在/已删 |
| `doc/conflict` | `baseRevision` 不匹配 |
| `doc/too-large` | AST 序列化超上限 |
| `op/invalid` | op 参数非法/未知 op |
| `node/not-found` | target 不存在或已删除 |
| `node/schema-invalid` | 节点/属性不符合 registry |
| `node/unsupported-transform` | 类型转换不在白名单 |
| `node/not-writable` | AI 能力声明禁止 |
| `object/invalid` | 对象 payload 校验失败 |
| `parse/unsupported` | Markdown 含未知语法/指令 |
| `idempotency/conflict` | 同 key 内容不同 |

---

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

- 对象**不可变**：修改 = 生成新 id，`update_object` 在同一事务内替换 block 的 `objectId`；旧对象保留给历史版本。
- GC：仅清理「无任何版本引用 + 超过保留期」的对象。
- 校验：对象类型有独立 JSON Schema（与 node registry 解耦，便于组件独立演进）。

### 6.2 mindmap payload v0

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

### 6.3 component payload v0（声明式）

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
- 文档只保存 `{objectId, title?}`，不保存渲染器实现。

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

- 内容寻址：同字节只存一份；二进制放 `${dataDir}/assets/<sha[0:2]>/<sha256>.<ext>`，DB 只存元数据。
- URI 形式：`space-asset://asset_<id>`；只允许图片（v0：png/jpeg/webp/gif）与受支持的附件类型。
- 上传：由 Host 校验 mime/尺寸/大小后写入资产表；Markdown 投影只输出 URI，不输出 base64。
- 备份：资产目录必须纳入备份/恢复流程（见 §7）。

---

## 7. 版本、快照与备份

- **文档 revision**：每次成功 apply/undo/restore +1；是 CAS 与乐观并发的基础。
- **快照版本**（现有 `DocVersion`）：内容为序列化后的 AST（规范化：键序稳定、紧凑 JSON）；建议在写入时按「revision 每 N 次或每次内容变化」生成，沿用现有 5 分钟节流可调整。
- **op log**（`doc_ops`）：审计/撤销；与快照并存。
- **对象/资产**：不重复进快照，只存引用；GC 按引用与保留期。
- **版本预算**：AST 快照比 HTML/Markdown 大；当前「10 版 / 64 KiB 每篇」需重估（建议按篇累计字节上限可配置，默认提高到 256 KiB，版本数保持 10–20）。
- **恢复**：restore 一个历史快照 = 写入其 AST、revision+1、追加 op（事件），旧对象/资产按引用保活。
- **备份**：SQLite 快照 + `assets/` 目录 +（可选）`objects/` 导出清单；恢复流程必须同时覆盖三者。

---

## 8. Agent 工具契约（模型可调用）

命名沿用产品前缀 `space_*`；读工具 `isConcurrencySafe: true`，写工具 false。

### 8.1 `space_doc_outline`

```
输入：{ doc_id: string }
输出：{ revision, title, total_blocks, outline: [{ id, type, preview, child_count, mark? }] }
```

- 只返回结构摘要，不返回正文；`preview` ≤ 80 字；总输出 ≤ 2k tokens（超出截断并标记）。
- 用于 AI 先建立全局认知、获取 block id。

### 8.2 `space_doc_read`

```
输入：{ doc_id, blocks?: string[], after?: string, limit?: number, max_chars?: number }
输出：{ revision, markdown, blocks: [{ id, type }], truncated, next?: string }
```

- 默认读全部（受 `max_chars`/`limit` 限制）；推荐按 `after` 分页或按 `blocks` 定向读。
- `markdown` 带块锚点注释；`blocks` 是「本次投影中包含的块」索引，供后续 op 定位。
- 单次默认 12k 字符、最大 40k；超限必须截断并在 `next` 给出续读锚点。

### 8.3 `space_doc_search`

```
输入：{ doc_id?, space_id?, query: string, limit?: number }
输出：{ hits: [{ doc_id, block_id, type, preview }], truncated }
```

- 按标题/正文纯文本检索，返回块级命中（`block_id` 可直接用于 ops / 定向 read）。
- 长文档定位、跨文档查找都用它；结果 preview ≤ 60 字，默认 20 条。

### 8.4 `space_doc_ops`

```
输入：{ doc_id, base_revision, ops: Operation[], dry_run?: boolean, idempotency_key?: string }
输出：{ revision, changed_block_ids, diff, undo_token?, warnings, errors? }
```

- 与 §5 一一对应；`errors` 为逐 op 错误数组（全有或全无）。
- `dry_run` 用于预览；返回 diff 不落盘。
- 写工具能力受 registry `ai.ops` 与全局写策略约束（本仓库评审结论：默认直接执行，不弹审批）。

### 8.5 `space_doc_generate`

```
输入：{ doc_id?, space_id?, title?, parent?: id, after?: id, markdown, max_chars? }
输出：{ doc_id, revision, changed_block_ids, title }
```

- 仅生成**新内容**：创建文档或向明确位置插入；内部使用 `insert_markdown` / `replace_block`，不触碰其他块。
- `markdown` 必须走 §4.3 解析；未知语法报错，不静默降级。

### 8.6 对象工具

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `space_object_get` | `{ object_id }` | `{ type, schema_version, payload, provenance }` |
| `space_object_update` | `{ doc_id, block_id, base_revision, payload }` | `{ revision, object_id, changed_block_ids }` |

- `space_object_update` 内部走 `update_object` op（同一事务创建新对象 + 替换引用）。
- 只有 registry 声明 `ai.writable` 的对象类型可用；application 组件只允许改 registry 暴露的 props 子集。

### 8.7 资产工具（v0.1）

- `space_asset_import`：接收 DSH 附件/文件引用，返回 `assetId`；或由外部上传后由工具校验。
- v0 先不做模型直接上传大文件，先支持「引用已有附件」。

### 8.8 工具预算与裁剪

- 7 个核心工具 schema 约 +1.2–1.6k tokens；读投影单次 ≤12k tokens。
- 工具返回统一带 `revision`，方便后续 ops CAS。
- 未知/不可写节点在工具结果中以占位出现，并附 `unsupported` 说明。

---

## 9. 存储映射（本仓库）

| 层 | 落点 | 说明 |
| --- | --- | --- |
| 文档内容 | `SpaceNode.content`（字符串） | 存 `AlterDoc` JSON；`contentFormat: "alter-doc/1"`；与旧 HTML 共存 |
| 文档 revision | `AlterDoc.revision` | 或旁表；不入 `vendor` 实体 |
| 对象 | 新表 `doc_objects` | 插件自有侧表，`store.ts` `user_version` +1 |
| 资产 | 新表 `doc_assets` + `dataDir/assets/` | 二进制文件系统，DB 元数据 |
| op log | 新表 `doc_ops` | 审计/撤销 |
| 版本 | 现有 `versions` 表 | 内容改存 AST JSON；保留旧 HTML 版本按格式标记渲染 |
| RPC | `doc.outline` / `doc.read` / `doc.search` / `doc.applyOps` / `doc.generate` / `object.get` | 加入白名单与 `src/space-client.ts` 映射 |
| 搜索 | Host 侧 AST 文本提取 | 替换 `htmlToText` 假设；索引标题 + text 节点 |
| 归属 | 复用既有 `withWriteScope` | 文档 Service 在同一 `store.update` 事务内写入并打 `'alter'` |

迁移策略：双格式共存（`contentFormat` 标记），旧文档按需/批量转换；旧版本快照保留 HTML 渲染；转换不保像素只保语义。

### 9.1 单仓库策略（重要：上游 Alter 已废弃）

- **`Alter-dsh` 是唯一事实源**：上游 `Alter` 仓库不再维护，**没有 re-vendor 流程**；协议、服务、编辑器、UI、Host 全部闭合在本仓库实现。
- **`vendor/` 是自持基线**：最初从上游复制的快照，现归本项目所有。**可以修改**，但每次修改需在 `vendor/VENDOR.md` 的「本地变更记录」登记（日期/文件/原因）；能用 `host/`/`src/` 实现的不改 vendor。
- **实现落点**：
  - 协议类型：`vendor/protocol/src/space.ts` 小步扩展（如 `contentFormat`），保持旧 HTML 文档可读；
  - Host：新增 `host/document/`（Schema Registry、projection、ops、对象/资产、op log）+ `host/store.ts` 新表 + `host/rpc.ts` 新端点 + Agent 工具注册；
  - 客户端：新增 `src/document/`（Tiptap 编辑器与渲染器）；用 `build/build.mjs` 的模块覆盖把 vendored `DocumentView`/`Editor` 指向新模块（沿用 `DirectoryField` 覆盖模式，见 `VENDOR.md`「Build-time module override」），必要时再小范围修改 `vendor/ui-space` 的引用；
  - 构建：Tiptap/remark 等第三方库必须打进 client bundle（外置依赖仅 react 族）；Host 侧校验器可手写或加依赖，但**不要引入 `@deepseek-ai/*` 运行时依赖**（保持自包含）。
- **双格式过渡**：旧 HTML 文档继续可读；新文档 `contentFormat: 'alter-doc/1'`；Host 按格式路由读写/搜索/渲染；存量迁移脚本后续单独做。
- **建议同步更新仓库约定**：`AGENTS.md` 的「vendor 逐字节一致，不要直接改」与 `VENDOR.md` 的「Syncing from upstream / 待回灌上游」已与现实冲突，应改为「自持基线 + 本地变更记录」；否则后续协作者会按旧规则行事。

---

## 10. Spike 验收标准

用 10 篇真实文档（长文/代码/表格/图片/callout/mindmap 占位/component 占位）与 6 类 Agent 任务（总结、精确改段、插 callout、生成新章节、改表格单元格、整理 mindmap）：

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

---

## 11. 待评审的开放项

1. 投影锚点形式：HTML 注释（默认）vs 指令 attrs vs 仅返回侧索引。
2. `update_text` 的 mark 继承规则是否够用，还是 v0 就引入 range/mark op。
3. mindmap/component 的 payload 内联阈值（当前 v0：一律占位 + 工具）。
4. table 合并单元格、评论锚点、代码组件沙箱的 v1 方案。
5. `doc_ops` 是否作为版本历史主存储（当前：快照 + op log 并存）。
6. 版本预算（10 版 / 64 KiB → 可配置累计字节，默认 256 KiB）与备份资产目录的实施方案。
