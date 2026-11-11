---
type: design
status: active
updated: 2026-11-10
---

# 文档内容架构：JSON AST 权威 + Markdown 投影 + Document Operations

这篇方案回答「空间文档的正文以什么格式存储、AI 与编辑器怎样共用同一份内容、富对象放在哪里」。
实施契约见 [specs/document-model-v0.md](../specs/document-model-v0.md) 与
[specs/document-operations-v0.md](../specs/document-operations-v0.md)；本文件只记录方向、取舍与理由，
不重复规范细节。

## 1. 方向与取舍

**方向**：权威存储是类型化的 JSON AST（块树 + 行内 marks + 稳定 block id）；AI 读 Markdown
**投影**；AI 写 **Document Operations**；mindmap、交互组件与图片等富内容作为独立对象/资产存旁表，
正文只放引用。

选择理由：

- 产品已是块式编辑 UX（slash 菜单、标题/列表/引用/代码/表格/图片），未来还要 mindmap 与可交互
  组件。这些能力要求节点有类型、可校验、可引用，HTML 字符串无法承载。
- AI 是主要作者：读需要 Markdown 的 token 效率与可读性，写需要可定位、可校验、可撤销的粒度；
  整篇 HTML/Markdown 重写会让冲突与误改放大。
- 稳定 block id 同时服务评论锚点、跨文档引用、块级 diff 与未来的协作演进。

被否方案（各一句话）：

- **HTML 作为长期权威格式**：无类型、难校验、富对象无法表达，不作为存储或兼容格式保留。
- **纯 Markdown 权威**：富组件、块引用与协作上限低，编辑器最终仍要 AST 化，且 Markdown 与编辑器
  规范化之间的 round-trip 保真问题无法回避。
- **MDX**：可执行 JSX，把「用户/AI 随时编辑的文档」变成代码执行问题，安全与构建成本不可接受。

明确接受的代价：编辑器前端按产品要求 1:1 还原为重构前的旧 UI（DOM/CSS 不改），AST 读写需要
一层 HTML↔AST 适配（投影、解析、资产物化）；AST 快照比纯文本格式大（对象与资产外置、规范化
序列化缓解）；Agent 工具面比字符串编辑更大（靠统一投影与正交 op 集控制）。
**正文只有单一 AST 格式**：新建文档即 AST 空文档，正文写入只经 Document Operations；编辑器内部的
HTML 只是适配投影，不是持久化格式。

## 2. 分层图景

```text
AI Agent
  读：Markdown 投影 + 块索引
  写：Document Operations + 新内容 Markdown
        │ 工具 / API
        ▼
Document Service（Host）
  projection  AST → Markdown + anchors
  planning    target 解析 → diff 预览
  validation  schema + 权限 + revision
  apply       事务、幂等、审计、undo
        │
        ├──────────────────────────────┐
        ▼                              ▼
JSON AST（权威存储）            Object / Asset Store
blocks / inline / marks         对象、组件目录、资产
/ node refs                    （内容寻址，正文只存引用）
        │                              │
        └──────────────┬───────────────┘
                       ▼
旧 UI 编辑器（contentEditable）+ AST 适配层
卡片 / 对象占位卡（旧 UI 无声明式组件渲染器）
```

职责边界：

- **所有写入都经 Document Service**，AI 工具与浏览器 RPC 都不直接改存储。
- Markdown 投影与新内容解析在 Host；旧编辑器 HTML 的投影/解析在客户端适配层；校验与事务统一
  在 Service，编辑器和 AI 走同一套 schema 规则。
- 存储层只有两件事：AST 树与旁表引用；渲染层只消费 AST 与对象，不反向写回。

## 3. 五条必须写死的原则

1. **AST 是唯一权威**；Markdown 是投影，不是第二份真源。两者不一致时以 AST 为准。
2. 投影只保「语义 + AI 可读」，**不承诺无损**；富组件以占位 + id 呈现，回写不走整篇解析。
3. 结构修改一律走 Operations；Markdown 只用于**新内容生成**（目标明确时解析为新节点）。
4. 所有写操作带 `baseRevision`、原子事务、可审计、可逆（inverse op）。
5. **一个 Schema Registry 作为节点契约事实源**：存储校验、编辑器 HTML 映射、AI 工具 JSON Schema、
   Markdown 投影、schemaVersion 校验与能力声明都以它为准（适配层以往返测试兜底），避免定义漂移。

## 4. 节点能力三级

| 层级 | 例子 | AI 能力 | 编辑 / 渲染 |
| --- | --- | --- | --- |
| **content** | paragraph、heading、list、quote、code、table | 读 Markdown、写 Markdown/ops，全文可编辑 | 旧编辑器原生块（contentEditable） |
| **structured** | callout、mindmap、文档内链卡/网页链接卡 | 读投影/指令；写 ops（属性或对象引用） | 卡片复用旧样式；callout/mindmap 为对象占位卡 |
| **application** | 声明式组件（进度/清单/指标卡） | 先查组件目录，再 `update_object` 写实例 props | 旧 UI 暂为对象占位卡；无渲染器与人工编辑入口 |

每个 node type 在 registry 中声明 `ai: { readable, writable, preview, ops }`，工具按能力裁剪：
AI 看不到、也改不了它不该碰的部分。这一条把「Document as Application」从口号变成可执行的边界，
也是「正文不执行内容」的落点。

## 5. Markdown 投影契约

- 投影是**只读视图**，可带块锚点（HTML 注释），导出时剥离。
- 文本块用 Markdown 原生语法；行内 marks 映射到 Markdown，无法映射的样式以注释或
  `capabilities` 说明呈现。
- structured 节点按类型投影：mindmap/component 以占位 + id 呈现（`:::mindmap{objectId=…}` /
  `:::component{objectId=…}`），细节通过对象工具读写；bookmark/docLink 投影为链接，不内联网页内容。
  是否允许小 payload 内联到投影属待定项（见 §11），v0 不内联。
- application 节点（声明式组件）：正文只放占位与对象引用；写入先查组件目录再 `update_object`，
  不把 props/payload 展开到正文。
- **不承诺 Markdown→AST 全量无损**：只在「目标明确的新内容 / 整块替换」时解析 Markdown；
  不允许 AI 整篇重写后再解析回 AST。原因是一旦允许整篇 round-trip，任何转换损失都会变成用户格式
  被静默改写，且与并发编辑的冲突面不可控。

## 6. Document Operations 设计要点

- 请求带 `docId`、`baseRevision`、`idempotencyKey` 与 `ops`；响应返回 revision、变更块 id、diff 与
  撤销凭证（字段语义以 spec 为准）。
- v0 op 集按四类收敛：插入（节点/Markdown）、文本更新（整段精确替换；v0 不支持 range/mark 级编辑）、
  结构修改（move/replace/transform）、删除；完整清单与参数见
  [specs/document-operations-v0.md](../specs/document-operations-v0.md)。
- 服务端流程：解析 target → schema/权限/baseRevision 校验 → 计算 diff → 事务执行 → 写 op log →
  revision+1 → 返回结果。
- `dryRun`（dry-run）返回 diff 不落盘，供预览与审批；批量**全有或全无**，失败逐 op 报错。
- 重复 `idempotencyKey` 返回原结果；`transform_block` 必须显式定义允许的转换与保留字段，
  禁止隐式丢数据。
- op log 支撑审计、撤销与未来协作，与快照版本并存（快照快恢，日志精审）。

为什么不是「整篇内容替换」：整篇替换无法给出稳定的 diff、无法做块级冲突判断、也无法只撤销一部分；
Operations 把一次修改收敛为可校验的意图，才谈得上可审计与可逆。

## 7. 长文档的读侧协议

- 先 `outline`：块树 + id/type/预览/块数，建立全局认知。
- 再 `read`：按 `blocks`/`after`/`limit` 只投影请求范围（Markdown 视图）。
- `search`：按文档或空间检索，返回块 id，用于定位。
- 上下文预算：outline ≤ 2k tokens，单次读投影 ≤ 12k tokens / ≤ 40k 字符（见 spec）；ops 回执
  不回传整篇文档。
- 所有 target 使用稳定 block id，不靠「第 3 段」这类位置描述，位置会随编辑漂移。

读侧协议决定整个方案的上限：模型一次能看多少、能否按需扩展，比单个 op 的语法更重要。
工具契约见 [specs/agent-doc-tools-v0.md](../specs/agent-doc-tools-v0.md)。

## 8. 版本、对象与审计

- 快照：AST 规范化 JSON；对象/资产外置只存引用，版本体积可控但仍比纯文本格式大。
  版本预算的现行值与重估方向见 [document-operations-v0.md](../specs/document-operations-v0.md) §7。
- op 日志：每次 apply 一条，含 actor（user/agent/model）、baseRevision、op 摘要与结果，用于审计与 undo。
- 撤销：inverse ops，按 apply 批次；多次 apply 分别撤销。
- 对象不可变；版本引用保活；GC 按「无版本引用 + 保留期」。
- 冲突：`baseRevision` 不匹配 → 重新读取/重试；未来引入 CRDT 时，ops 映射为 transactions 即可演进。

## 9. 组件运行时边界与安全

- application 节点有独立 schema，不进文档正文、不参与 Markdown 解析；旧 UI 只把它渲染成对象占位卡。
- v1 文档只保存实例：`{ format:'alter-component/1', componentId, componentVersion, props }`；
  组件目录静态编译进协议包（内置进度条/清单/指标卡），是 Host 校验与 AI 工具的事实源。
- 安全：未知组件/props/越界 fail-closed；目录声明 `ai_writable` 供 Agent 发现可写 props；
  不含 eval/iframe/远程代码。
- 未做：旧 UI 的组件渲染器与人工编辑入口、内容寻址 specHash、bindings、持久化实例状态；
  代码组件（iframe sandbox + CSP + 审核通道）留后续。

## 10. 本仓库映射

- `SpaceNode.content` 只存 `alter-doc/1` AST JSON 字符串，没有格式标记字段；`space.saveNode` 只改
  标题等元数据，正文写入只经 Document Operations（含新建文档的 AST 空文档）。
- 新增旁表 `doc_objects` / `doc_assets` / `doc_ops`（代码组件的 `component_specs` 属后续）；
  `host/persistence/store.ts` 用 `PRAGMA user_version` 升级建表；资产二进制放 `dataDir/assets/`，备份必须覆盖该目录。
- Host：新增 Document Service（projection / validation / ops / audit）与 Schema Registry，
  仍复用 SQLite 单写者队列与事务；RPC 端点与 `src/client/rpc.ts` 映射同步增加。
- 客户端：文档页是 `vendor/ui-space` 的旧 UI 1:1 还原（DOM/CSS 冻结）；AST 适配层放
  `src/document/editors/legacy`，经 `@alter-space/legacy-adapter` 别名（`build/build.mjs`、tsconfig paths、
  `vitest.config.mts` 三处）接进旧 `DocumentView`，保存/恢复/资产/评论锚点都走 document client。
- Agent 工具面为 `space_doc_outline` / `space_doc_read` / `space_doc_search` / `space_doc_ops` /
  `space_doc_patch` / `space_doc_generate` / `space_doc_undo`、对象/资产与组件目录工具；正文写入只有
  结构化修改、单块 patch 与新内容生成三类入口，详见 [agent-doc-tools.md](agent-doc-tools.md)。
- 文档资产：上传走 RPC `doc.importAsset` / `doc.importFile`，读取走 `GET /api/alter-space/asset`；
  声明式组件目录在 `vendor/protocol`（Host 校验与 AI 工具事实源；旧 UI 暂不渲染组件），文档只存
  对象引用。
- **已实现 / 未实现边界**：旧 UI 编辑面、评论（含 anchor 生成）、历史（AST→旧 HTML 差异与
  CAS 恢复）、文件卡/链接卡、表格、图片/文件资产物化与 Agent 块级 patch 已落地；callout/mindmap/
  component 在旧 UI 中为对象占位卡（无样式、无人工编辑入口），评论自动重锚与失效提示未做；
  组件侧边界见 §9。
- **所有实现闭合在本仓库**：协议、Host、客户端、编辑器都在 Alter-dsh；`vendor/` 是项目自有源码，
  可改但每次登记。存储映射与单仓库策略的实施基准见
  [specs/document-model-v0.md](../specs/document-model-v0.md) 与
  [specs/system-architecture.md](../specs/system-architecture.md)，本文件不复述。

## 11. 仍待拍板

| 议题 | 当前建议 / 现状 |
| --- | --- |
| 新节点在旧 UI 的呈现与人工入口 | 当前 callout/mindmap/component 为对象占位卡；是否在冻结 UI 外补浮层入口待产品决策 |
| structured payload 内联阈值 | v0 一律占位 + 工具；后续按大小阈值（如 ≤4 KB 内联）再定 |
| op log 是否作为版本历史主存储 | 建议快照 + op log 并存，各司其职 |
| 代码组件引入 | v1 只做声明式组件；代码组件需沙箱 + 审核通道，后续再评估 |
| 版本预算与资产备份实施方案 | 按篇累计字节上限 + 备份覆盖 assets 目录，具体数值实测后定 |

## 相关文档

- [specs/document-model-v0.md](../specs/document-model-v0.md) — 节点模型、Schema Registry、Markdown 投影语法（实施基准）
- [specs/document-operations-v0.md](../specs/document-operations-v0.md) — Operations 信封、op 集、审计与错误码
- [specs/agent-doc-tools-v0.md](../specs/agent-doc-tools-v0.md) — Agent 工具契约与预算
- [specs/system-architecture.md](../specs/system-architecture.md) — Host/Client/vendor 边界与持久化约束
- [agent-doc-tools.md](agent-doc-tools.md) — Agent 读写工具为什么这样设计
- [research/document-storage-options.md](../research/document-storage-options.md) — 候选格式对比与外部证据
- [docs/README.md](../README.md) — 文档分类、体量与写作规则
