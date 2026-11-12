---
type: spec
status: active
updated: 2026-11-12
---

# 文档模型 v0

本篇规范约束 Space 文档的权威内容表示：单一 `alter-doc/1` 格式的顶层信封、Block/Inline 节点、
Marks、Schema Registry、v0 节点类型与 Markdown 投影规则。它是所有 Space note 正文的读写、校验与
投影的实施基准；任何正文写入都必须走 [document-operations-v0.md](document-operations-v0.md)
定义的 Operation 通道。

## 1. 目标与非目标

目标：

- 文档**权威存储为 JSON AST**：类型化节点树、稳定 block id、可校验、可协作演进。
- **AI 读 Markdown 投影**：按块/范围读取、带定位信息、有 token 预算。
- **AI 写 Document Operations**：精确、原子、可校验、可审计、可撤销；内容生成允许用 Markdown，
  但只解析为「明确目标位置的新节点」。
- **Document as Content 与 Document as Application 分离**：交互组件有独立 schema 与运行时，
  不混进正文语义。
- 文档页内核（AST 原生 Tiptap）与 AI 工具共享同一节点契约（registry 为事实源，AST↔内核映射
  以往返测试校验对齐），避免定义漂移。

v0 非目标：

- 不做实时协作/CRDT；revision 与 op 设计保留演进空间。
- 不做任意 AI 生成代码的执行；代码组件走后续审核通道。
- 不做 Markdown 全量回写解析（禁止整篇 Markdown → AST）。
- 不改 `vendor/protocol` 实体结构；新能力通过 `content` 字符串 + 插件自有侧表承载。

## 2. 顶层信封与单一格式

所有 Space note 正文只有 `alter-doc/1` 一种格式：`SpaceNode.content` 保存序列化后的 `AlterDoc`
JSON 字符串；没有 `contentFormat` 之类的格式标记字段，也不存在其他正文格式或双格式路由。

```jsonc
{
  "format": "alter-doc/1",
  "schemaVersion": 1,
  "revision": 12,              // 每成功 apply 一次 +1；CAS 依据
  "blocks": [ /* Block[]，顺序即文档顺序 */ ]
}
```

约束：

- 新建文档即为 revision 1 的 AST 文档：空文档 `blocks: []`，`generate` 新文档在同一事务写入初始内容；
  revision 单调递增、不回退，恢复历史版本也 +1。
- 正文写入只经 Document Operations（`applyOps` / `generate` / `undo` / `restoreVersion`）；
  `space.saveNode` 只更新标题等元数据，不接受正文。
- 文档级大小上限：序列化后 ≤ 512 KiB（可配置）；超限以 `doc/too-large` 拒绝写入。
- 结构上限：单文档 block 数 ≤ 5000、树深 ≤ 50；超限以 `doc/schema-invalid` 拒绝。
- 禁止在 `content` 中放二进制或大 payload；图片与文件走资产、思维导图/组件走对象侧表。
- 节点模型不兼容变更时升 `schemaVersion`；读取只接受与当前实现一致的 `schemaVersion`，
  不一致以 `doc/schema-invalid` 拒绝（v0 不提供自动迁移）。
- 文本抽取按 AST 块树提取纯文本（text 节点与 attrs 中的 alt/caption/title/description/name），
  搜索、概览与新文档判断都不把 AST JSON 当正文。

## 3. Block 节点

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

- `content` 与 `children` 按节点类型二选一或都无，由 registry 的 `contentModel` 决定。
- 未知属性写入前按 registry 校验/拒绝；未知节点类型**不可写入**，读取时按 `opaque` 降级渲染。
- 节点 id 由服务端在插入时分配；客户端可携带候选 id，冲突则重新分配。
- 删除即从树中移除；op log 记录 inverse 用于撤销，v0 不需要 tombstone 表。

## 4. InlineNode 与 Marks

```ts
type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }   // 相邻同 marks 的文本必须合并（canonical）
  | { type: 'hardBreak' };

interface Mark {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight' | 'link';
  attrs?: { href?: string };   // link 必填 href
}
```

v0 行内子集与投影：

- `bold` → `**x**`；`italic` → `*x*`；`strike` → `~~x~~`；`code` → `` `x` ``。
- `highlight` → `==x==`（扩展语法）；`underline` → `<u>x</u>`（投影用内联 HTML，解析时仅接受 `<u>`）。
- `link` → `[x](href)`；href 只允许 `https?`、`mailto` 或站内相对路径。
- 评论以 `Comment.anchor = { blockId, offset, length }` 锚定到某个顶层块的展平文本（inline text 原样、
  hardBreak 记 `\n`、嵌套块之间以 `\n` 连接）；颜色、字号 v0 不做；新增 mark 必须升 `schemaVersion`。

评论的生命周期（三态、软删除墓碑、正文写入的级联删除）与客户端可见面见
[space-comment-v0.md](space-comment-v0.md)。

## 5. 文档级元数据

文档标题仍用 `SpaceNode.title`，不在 AST 内重复；AST 只承载正文结构。

## 6. Schema Registry（唯一事实源）

同一份节点契约服务所有消费方：存储校验、内核 schema 映射、AI 工具 JSON Schema、Markdown 投影、
schemaVersion 校验与能力声明都以 registry 为准（AST↔内核映射由往返测试校验对齐）：

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
    maxLength?: number;                // string 属性的长度上限
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
    directive?: string;                // 指令块名（callout/mindmap/component）
  };
  render: { editor: string; readOnly: string };  // node view / 只读渲染器 id
  transforms?: string[];               // transform_block 允许的目标类型
}
```

规则：

- v0 registry 规模 ≤ 20 个节点类型；新增类型必须同时提供 schema、投影、渲染与能力声明；
  不兼容变更升 `schemaVersion`，存量数据按升版处理（v0 无自动迁移）。
- `ai.writable` 与 `ai.ops` 是 Agent 写能力的唯一声明处，工具层不得硬编码节点类型特例。

### 6.1 v0 节点类型

| type | kind | contentModel | attrs | AI 能力 | Markdown 投影 |
| --- | --- | --- | --- | --- | --- |
| `paragraph` | content | inline | — | 读写/全 op | 段落文本 |
| `heading` | content | inline | `level: 1..6` | 读写/全 op | `#`…`######` |
| `bulletList` | content | blocks | — | 读写/结构 op | `- ` 列表 |
| `orderedList` | content | blocks | `start?: number` | 读写/结构 op | `1. ` 列表 |
| `taskList` | content | blocks | — | 读写/结构 op | `- [ ]` / `- [x]` |
| `listItem` | content | blocks | `checked?: boolean` | 读写/结构 op | 由父列表决定 |
| `blockquote` | content | blocks | — | 读写/结构 op | `> ` |
| `codeBlock` | content | inline（纯文本，无 marks） | `lang?: string` | 读 + 整块替换 | 围栏代码块 |
| `divider` | content | none | — | 插入/删除 | `---` |
| `table` | content | table | `headerRows?: number` | 读 + 结构 op（v0 限制） | GFM 表格 |
| `tableRow` / `tableCell` | content | blocks / inline | `tableCell.colspan?/rowspan?: number`（1–50，>1 才落 attrs） | 结构 op | GFM（投影不表达合并，只保留文本） |
| `image` | content | none | `assetId`, `alt?`, `caption?`, `width?` | 读 + 替换/属性 | `![alt](space-asset://…)` |
| `file` | content | none | `assetId`, `name`, `mime`, `bytes?` | 读 + 替换/属性 | `[附件：name](space-asset://…)` |
| `bookmark` | structured | none | `url`, `title?`, `description?`, `icon?` | 读写/属性+替换 | `[title](url)`（无 title 用 url） |
| `docLink` | structured | none | `docId`, `title?` | 读写/属性+替换 | `[title](space-doc:<docId>)` |
| `callout` | content | blocks | `tone: info\|warn\|success\|danger`, `title?`, `icon?`, `collapsed?` | 读写/结构+属性 | `:::callout{…}` 指令 |
| `mindmap` | structured | none | `objectId`, `caption?` | 读占位 + `update_object` | `:::mindmap{objectId=…}` 占位 |
| `component` | application | none | `objectId`, `title?`, `description?` | 查组件目录 + `update_object`（仅目录可写 props） | `:::component{objectId=…}` 占位 |

补充约束：

- `image` 的 `space-asset://` URI 只由投影生成、不被 Markdown 解析器接受；插入图片必须用 `assetId`。
- `file` 的 `space-asset://` URI 同样只由投影生成、不被 Markdown 解析器接受；插入文件必须用
  `assetId`，`name` / `mime` / `bytes` 只用于卡片展示与下载。
- `bookmark` / `docLink` 是结构化卡片：目标由 `url` / `docId` 属性承载，投影只输出链接，不内联网页内容。
  只读渲染只把 `http(s)` URL 渲染为可点击链接，其余形式降级为纯文本。
- table 在 v0 只支持矩形、无合并单元格；合并单元格 v1 再议。
- mindmap/component 的大 payload 永不进 Markdown，投影只给占位。
- `component` 的实例 payload、内置声明式组件目录与 fail-closed 校验以
  [document-operations-v0.md](document-operations-v0.md) §6.3 为准；渲染是客户端静态 registry，
  **不执行任意代码**。

## 7. Markdown 投影规范

### 7.1 投影原则

- 投影是**只读视图**，用于 AI 阅读与人工导出；**不是第二真源**。
- 默认开启块锚点（AI 视图）：每个顶层块前加 HTML 注释 `<!-- blk:blk_xxx -->`；导出/人类视图剥离。
- 投影必须有界：工具层按块/范围裁剪，单次读默认 12k 字符、最大 40k 字符（见 [agent-tools-v1.md](agent-tools-v1.md)）。
- 无法投影的 mark/节点降级为可见占位，并在工具结果 `capabilities` 中说明；**不静默丢失**。

### 7.2 语法映射

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
| file | `[附件：name](space-asset://asset_…)` |
| bookmark | `[title](url)`（无 title 时用 url 作标题） |
| docLink | `[title](space-doc:<docId>)`（无 title 时用 docId） |
| callout | `:::callout{tone="warn" title="…" #blk_id}` … `:::` |
| mindmap | `:::mindmap{objectId="obj_…" caption="…" #blk_id}` 空体 `:::` |
| component | `:::component{objectId="obj_…" title="…" #blk_id}` 空体 `:::` |
| 未知节点 | `:::opaque{type="…" #blk_id}` + 一行 `[unsupported node]` |

表中 `file` / `bookmark` / `docLink` 的链接与附件形式只用于阅读与导出，不参与 Markdown 回写解析。

### 7.3 解析方向（仅新内容）

- 只允许在 `insert_blocks` / `replace_block` / `space_doc_generate` 场景由 Markdown 生成节点。
- 解析器只接受 §7.2 的语法与已知指令；未知指令、未知 HTML、无法表达的 attrs → 报错
  `parse/unsupported`，由调用方回退为结构化 op。
- 指令属性白名单：`tone/title/icon/collapsed/caption/level/start/lang`；id 只接受服务端分配，
  忽略外部传入。
- 解析方向只覆盖文本类节点、图片与 callout/mindmap/component 指令；`file` / `bookmark` / `docLink`
  只能由结构化 `blocks` 写入，投影中的链接/附件形式不回写解析。
- 图片的 `space-asset://` 在解析时校验存在性；不存在 → 报错，不落盘。

### 7.4 禁止事项

- 禁止「整篇 Markdown → AST」或「AI 输出全文再覆盖」。
- 禁止在 Markdown 中内联组件 payload/JSON（v0）；复杂对象只给占位 + 工具读写。
- 禁止把投影锚点写回存储（它是视图产物）。

## 相关文档

- [document-operations-v0.md](document-operations-v0.md) — 写入契约：信封、Operation 集、错误码、对象/资产
- [space-comment-v0.md](space-comment-v0.md) — 评论生命周期：软删除墓碑与正文级联删除
- [agent-tools-v1.md](agent-tools-v1.md) — 模型可调用工具、投影预算与质量验收基线
- [system-architecture.md](system-architecture.md) — 分层、持久化与传输约束
- [文档内容架构](../designs/document-content-architecture.md) — 为什么选择 JSON AST + Markdown 投影
- [文档存储格式调研](../research/document-storage-options.md) — 候选方案对比与证据
- [文档知识库](../README.md) — 分类与写作规则
