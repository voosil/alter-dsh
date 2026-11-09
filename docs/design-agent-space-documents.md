# Agent 空间文档读写：技术方案

- 状态：设计（待评审，未实现）
- 日期：2026-11-09
- 环境：DSH Desktop 0.2.2-rc.1（profile `desktop`），仓库 `/Users/yifan/workspace/indie/Alter-dsh`
- 范围：为 `@alter-dsh/space` 增加模型（Agent）可调用的空间文档读写工具，以及让已打开的浏览器 Space UI 安全地看到 Agent 写入
- 评审摘要（先读）：[design-agent-space-documents-review.md](./design-agent-space-documents-review.md)
- 相关文档：[AGENTS.md](../AGENTS.md)、[README.md](../README.md)、[docs/research-agent-creation.md](./research-agent-creation.md)

> **2026-11-09 更新**：上游 Alter 仓库已废弃，`Alter-dsh` 是唯一事实源。本文中「`vendor/` 不可修改/逐字节一致」的旧表述应理解为：**`vendor/` 是自持基线，可修改但需在 `vendor/VENDOR.md` 登记；能用 `host/`/`src/` 实现的不改 vendor**。文档格式与 Agent 工具契约以 [spec-document-model-v0.md](./spec-document-model-v0.md) 为准（本文的 HTML 精确替换设计已被取代）。

---

## 0. 结论摘要

1. **采用 Host 原生工具（方案 A）**：在 `@alter-dsh/space` 的 Host 半侧用 `ctx.tools.register()` 注册 6 个 `space_*` 工具，直接调用进程内的 `SpaceService`。不新增网络链路、不新增运行时依赖、不修改 `vendor/`（逐字节上游拷贝）。
2. **写路径的三件套**：
   - **归属**：所有 Agent 写入在同一个 store 事务里标记为 `creator/author = 'alter'`（复用现有 `'me' | 'alter'` 产品语义，活动流/版本历史自然显示「Alter 更新了」）。
   - **CAS**：`space_read` 返回 `updated_at`，`space_edit` 必须回传 `base_updated_at`；门禁与业务写入在同一 `store.update` 事务内比较，冲突时**不落盘**，返回可操作的重读提示。
   - **强制版本**：vendor 的版本记录有 5 分钟节流，宿主在 Agent 写入时补记一条版本，堵住「Agent 内容被用户自动保存覆盖且无历史可恢复」的缺口。
3. **读路径**：列表/搜索/读取全部做投影与截断（默认 12k 字符、可续读），读工具不调用 `recordOpen`，避免伪造用户活动度；HTML 原样返回以便精确编辑。
4. **浏览器同步首期不做**（评审确认：产品暂不是协作产品）：Agent 写入在下次进入文档/切换空间/刷新页面时可见；浏览器保存 CAS、`watchRevision` 轮询留在后续可选（§9 保留设计）。数据安全靠 Agent 侧 CAS + 强制版本 + 每日快照。DSH 原生 Host→Client 推送对第三方插件不可用（构建期 allowlist），自建 SSE 也不在本期范围。
5. **不采用**：MCP/HTTP 中转（多一跳、无收益）、把文档投影成文件复用 `read`/`edit`（丢结构/版本/归属，且有同步回环）、PTC/code-mode（可作为远期形态）。
6. 预估工作量：**首期 P0（只读）+ P1（写入）约 3–4 人日**；P2（浏览器同步，可选）1.5–2 人日、P3（扩展，可选）1.5–2.5 人日（见 §13）。工具 schema 首 token 成本约 **+1.0–1.5k tokens**（当前 42 个工具合计约 37 KB ≈ 9–10k tokens，增幅 12–15%）。
7. **评审结论（2026-11-09）**：写审批 = 直接执行（`never`，不询问）；首期不做浏览器实时刷新；**正文格式已收敛为「JSON AST 权威 + Markdown 投影 + Document Operations」**（见 [research-document-storage-format.md](./research-document-storage-format.md) §11）。本文的工具契约与架构部分在实现前需按该文档 §11 改写，勿直接照搬。

---

## 1. 目标、非目标与验收标准

### 1.1 目标

- Agent 能在会话中**发现并读取**空间/文档：列空间、列文档树、搜索、按需分页读正文与元数据。
- Agent 能**创建、编辑、评论**文档，写入与浏览器走同一权威数据链路（SQLite 单写者队列），刷新后 UI 一致。
- 写入**可归属、可审计、可恢复**：标 `'alter'`、产生版本、活动流可见、冲突不静默覆盖。
- 对现有 Space 功能与数据文件**零迁移**（沿用 v1 schema 与全部既有字段）。
- 不破坏自包含构建：`pnpm check` 全绿，无新增 npm 依赖，`vendor/` 无改动。

### 1.2 非目标（首期）

- 不做真实「DSH Agent ↔ Space 协作者」身份绑定与权限执行（`AgentPermission` 目前是未执行的产品元数据，见 §7.6）。
- 不做空间/随想/hub 的全套 CRUD；首期只做**文档**，随想、事项、旅程、观察留到后续。
- 不做硬删除（`deleteNode` / `emptyTrash`）与跨空间批量操作。
- 不改 `vendor/ui-space`，不引入 WebSocket/SSE 后台推送（见 §9.5）。
- 不做浏览器实时刷新与跨窗口同步（评审确认；Agent 写入在下次进入文档/切空间/刷新页面时可见，见 §9）。
- 不做 Markdown 正文格式（正文保持 HTML；Markdown 见 §14.2）。

### 1.3 验收标准

| # | 验收项 | 判定 |
| --- | --- | --- |
| A1 | 安装后工具可见 | `cordis_inspect_query`（Host `Tool.listTools`）出现 6 个 `space_*` 工具；`pnpm check` 通过 |
| A2 | 读准确 | `space_read` 返回的正文片段与 `space.db` 中 `content` 逐字符一致（含分页偏移） |
| A3 | 写归属 | Agent 新建/修改文档后：`nodes.creator='alter'`、新增 `versions.author='alter'`、活动流出现「Alter 新建了/更新了」 |
| A4 | 冲突不落盘 | 用过期 `base_updated_at` 调 `space_edit` → 返回 `space/conflict`，回读内容与 `updated_at` 均不变 |
| A5 | 可恢复 | Agent 写入后用户在浏览器保存旧草稿 → 新内容仍能从版本历史恢复（强制版本生效） |
| A6 | HTML 安全 | `<script>`、`onerror=`、`javascript:` 在 Agent 写入路径被剥离/拒绝 |
| A7 | 读不改活动 | 连续 `space_read` 不改变 `activity`/`lastOpenCreditAt` |
| A8 | 写入可见性（非实时） | Agent 改文档后，重新进入该文档/切换空间/刷新页面即可看到最新内容；数据不丢（版本可恢复） |
| A9 | 上下文预算 | 6 个工具 schema 首轮约 +1.0–1.5k tokens；`space_read` 默认结果 ≤ 12k 字符 |

---

## 2. 现状与约束

### 2.1 进程与数据边界

```
DSH Host 进程                                  浏览器（DSH Web GUI）
┌──────────────────────────────┐              ┌───────────────────────────┐
│ @alter-dsh/space Host 半侧    │              │ @alter-dsh/space 客户端    │
│  host/index.ts  apply(ctx)   │              │  src/entry.js → Panel      │
│   ├─ host/store.ts SQLite ───┼── space.db    │  src/space-client.ts       │
│   ├─ vendor/service 业务服务  │              │   SpaceService over RPC    │
│   ├─ host/rpc.ts  ───────────┼── /api/alter-space（Connection 鉴权）───→│
│   └─ ctx.connection.fetch    │              │  vendor/ui-space SpaceApp  │
│ （本方案新增）                │              │  只持有组件 state，无缓存   │
│   ├─ ctx.tools.register      │              │                           │
│   └─ withWriteScope 包装器    │              │                           │
└──────────────────────────────┘              └───────────────────────────┘
```

要点：
- **业务数据只在 Host**（SQLite `${DSH_HOME:-~/.dsh}/data/space/space.db`），浏览器只经 RPC 读写；Agent 工具运行在 Host 进程内，可直接调用同一 `SpaceService`，无需网络。
- 现有 `HostContextLike`（`host/index.ts:50-73`）是结构化类型，刻意不 import `@deepseek-ai/*`；本方案沿用这一自包含约束。
- 写入全部经 `holder` 单写者队列（`host/store.ts:694-743`）：每个 `update` 先 `structuredClone` 快照、在事务里执行、失败回滚，成功才 resolve。

### 2.2 文档模型与写路径不变量（对本方案有影响的部分）

| 事项 | 现状（证据） | 对 Agent 工具的影响 |
| --- | --- | --- |
| 正文格式 | `SpaceNode.content` 是 HTML 字符串（contentEditable `innerHTML`，`vendor/protocol/src/space.ts:59`；`vendor/ui-space/src/components/editor/Editor.tsx:591`） | 读/写均按 HTML 原文；编辑用精确字符串替换 |
| 保存语义 | 浏览器 700ms 防抖**整篇**保存 `{title, content}`（`vendor/ui-space/src/views/DocumentView.tsx:209-241`），卸载兜底 flush（`:160-170`） | 浏览器保存会整体覆盖 → 需要冲突检测（§9.4）；Agent 侧 CAS 只保护 Agent 写入 |
| `updated_at` | 仅在 `saveNode` 有实际变更、`moveNode`、`restoreVersion` 时推进（`vendor/service/src/service.ts:420-447/467/659`）；pin/归档/删除/`recordOpen` 不推进 | 作为内容 CAS 的自然键；写工具返回最新值 |
| 版本 | `saveNode` 内容变化时追加整篇快照，同文档 **5 分钟最多一条**，author 硬编码 `'me'`（`service.ts:205-224`） | 归属需宿主补丁；节流缺口用强制版本补（§7.3） |
| 版本保留 | 每篇默认 10 版、总 64 KiB，最新一版永不删（`host/retention.ts:38-61`，`host/settings.ts:24-41`） | 写正文大小需设上限（建议 256 KiB），否则整库 clone/快照代价放大 |
| 活动度/归档 | 读路径会触发 `sweepArchives`：闲置文档被标记 `archivedBy:'agent'`（`service.ts:168-192/349/358/898`） | 读工具接受该副作用但不调用 `recordOpen`；不伪造用户活动 |
| 删除 | 软删整棵子树（`deletedAt/deletedRoot`），恢复按 `deletedAt` 匹配（`service.ts:500-531`） | 首期不暴露删除；`getNode` 对已删返回 `undefined` |
| 层级 | folder 只能位于根；note 可嵌套 note；note 可挂 folder（`service.ts:374-375/453-454`） | `space_create` 的 `parent_id` 必须是未删 folder 且同空间 |
| 评论 | `quote` 是自由字符串、无锚点校验（`service.ts:576-602`） | Agent 评论可带原文引用；不做锚点校验 |
| 协作者权限 | `AgentPermission` 仅创建时 normalize，**无任何执行点**（`vendor/protocol/src/space.ts:20-31`；`host/rpc.ts` 白名单不含权限判断） | 首期用插件配置门禁；协作者权限映射见 §7.6（P3） |

### 2.3 DSH Host 工具机制（已核实）

- 注册：`ctx.tools.register(definition, { when? }) → () => void`（`@deepseek-ai/dsh-tools/lib/index.js:433-445`）。**根 ctx 注册 = 全局工具，所有 Agent/预设可见**；只给某预设时把插件行放进该 preset 的插件组合。
- 返回：`execute` 返回值必须是 lossless JSON 且通过 `output.schema`；`output.render(args, value)` 返回的 `ContentBlock[]` 才是模型看到的内容；`presentationMeta` 进 `result.meta`，供 Chat 卡片（`presentCall/presentResult`）使用。`throw` 会变成 `Error: <message>` + `isError:true`；结构化 code 只来自 `HarnessError`，本仓库不引该依赖，故把稳定 code 写进 message。
- Schema 子集：`type/oneOf/properties/required/additionalProperties/items/enum/const` + `description/title/default/examples`；对象必须显式 `additionalProperties: boolean`。**不用 `defineTool` 时必须自己校验 args**（框架只做 `JSON.parse`）。
- 审批：`ctx.on('tools/pre-execute', (exec, next) => …)`，返回 `{kind:'ask', reason, displayReason}` / `{kind:'deny'}` / `next()`；pipeline 会调用 `ctx.approval.request`，`allowed-once` 才放行。同步 `tools.guard` 只能否决、不能询问用户。
- 可见性/成本：`deferLoading` 在本 profile 的 pi-ai 路由上语义不保证（会被剥离），**不使用**；`systemPrompt.section` 每轮计费，首期不加。按当前工具清单实测，6–8 个紧凑工具约 +3.5–6 KB schema。

### 2.4 浏览器刷新现状

- `SpaceApp` 无推送、无轮询、无 `focus/visibilitychange` 监听；唯一刷新入口是内部 `refresh()` 自增 `version`，各视图操作后调用（`vendor/ui-space/src/SpaceApp.tsx:112/127/170`）。
- 组件 `useEffect` 依赖 `[service, version]`（`SpaceApp.tsx:127/170`），**替换 `service` 对象身份即可触发全量重取**（不必重挂载）。
- `DocumentView` 持有 `draftRef/dirtyRef`：仅在非 dirty 时随 `node` prop 同步正文（`:172-185`）；`service` 身份变化会触发保存 effect 的 cleanup → 若 dirty 会 flush 旧草稿（`:160-171`）。
- 结论：**任何刷新/重挂载都必须先有保存冲突检测**，否则旧草稿会静默覆盖 Agent 写入。

### 2.5 设计约束

1. `vendor/` 逐字节一致，不可修改（`vendor/VENDOR.md`）；所有新逻辑放 `host/` 与 `src/`。
2. 自包含构建：Host 产物只允许 `node:`/相对路径说明符（`scripts/verify.mjs:166-179`）；`package.json` 不新增运行时依赖。
3. `host/index.ts` 的 `HostContextLike` 结构化类型需扩展 `tools`/`on`，或改用 `ctx.get('tools')` 可选发现。
4. 单写者队列同步执行；禁止在 `store.update` 回调里 `await` 同一 store 的另一笔 `update`（会自我死锁，`host/store.ts:697-705`）。
5. `tsconfig.host.json` 的 `noUnusedLocals/noUnusedParameters` 与 `verbatimModuleSyntax` 要求类型导入用 `import type` 且不得留死代码。

---

## 3. 方案选型

| 方案 | 机制 | 优点 | 代价/风险 | 结论 |
| --- | --- | --- | --- | --- |
| **A Host 原生工具（推荐）** | Host 插件内 `ctx.tools.register`，直接调 `SpaceService` | 零网络跳转、Connection 鉴权体系不变、可拿 `exec.agent`、可与同进程写包装器/CAS 深度集成 | 增加 Host 插件职责；工具全局可见需配置门禁 | ✅ 采用 |
| B MCP / HTTP 中转 | 起 MCP server 或让工具经 `/api/alter-space` 回环调用自己 | 工具进程可独立部署 | 鉴权要重新解决（Connection 只认可信 peer）、多一跳、多一个进程/协议面、无功能收益 | ❌ |
| C 文件投影 | 把每篇文档导出成 workspace 下的 `.html/.md`，复用现有 `read/write/edit` | 复用成熟文件编辑体验 | 丢空间结构/评论/版本/归属；双向同步回环；多窗口冲突 | ❌（可作为「导出」功能单列） |
| D PTC / code-mode | 只暴露一个 `run_code` 内的 `space.*` JS API | 工具 schema 极省、组合灵活 | 依赖 PTC executor（本 profile 未启用）、调试与审批更复杂 | ⏳ 远期 |
| E 只做只读 | 只注册 list/search/read | 零写入风险 | 不满足「读写」需求 | 作为阶段 0 先落地 |

---

## 4. 总体架构

### 4.1 组件与职责

| 新组件 | 位置 | 职责 |
| --- | --- | --- |
| `host/tools-types.ts` | Host | `ToolDefinitionLike` / `ToolRunContextLike` / `ToolsLike` 等结构化类型（不 import DSH 包） |
| `host/agent-tools.ts` | Host | 6 个工具的定义（schema/render/卡片/execute）、参数校验、错误映射 |
| `host/write-scope.ts` | Host | 包装 `SpaceStore`：actor 捕获、CAS 门禁、`'alter'` 归属、强制版本、revision 计数 |
| `host/sanitize.ts` | Host | HTML 清洗（白名单）、`htmlToText` 投影、字符边界安全的截断 |
| `host/rpc.ts`（改） | Host | `space.saveNode` 第三参 base 门禁、`space.watchRevision` 只读端点 |
| `host/index.ts`（改） | Host | 组装 `withWriteScope`、注册工具、注册 `tools/pre-execute` 审批监听、配置解析、卸载清理 |
| `src/watch-client.ts` | Client | `watchRevision` 轮询/profile 客户端（不进 `SpaceService` 接口） |
| `src/space-client.ts`（改） | Client | 记录每篇文档最近 `updatedAt`、`saveNode` 带 base、冲突事件 |
| `src/space-shell.tsx`（改） | Client | 可见性轮询、冲突横幅、「载入最新」软刷新 |
| `tests/agent-tools.test.ts` 等 | Tests | 单测/集成/回归 |

### 4.2 数据流

**读**：模型 → `space_read` → `SpaceService.getNode` → 内存快照 → 截断/投影 → `output.render` → 模型；同时 `presentationMeta` 供 Chat 卡片。

**写**：模型 → `space_edit` → 参数校验 → `writeScope.run({origin:'alter', base}, () => service.saveNode(...))` → `store.update` 事务内：CAS 门禁 → vendor 原逻辑（活动度/版本/`updatedAt`）→ `'alter'` 归属打标 → 强制版本 → 提交 → revision+1 → 返回值/卡片。

**同步**：浏览器 4s 轮询 `watchRevision` → 发现 `origin='agent'` 的新 revision → 横幅/软刷新 → `SpaceApp` 以新 `service` 身份重取。

---

## 5. 工具契约

### 5.0 通用约定

- 工具名/参数名：snake_case 英文；description 与参数描述英文短句（与已安装工具一致），用户可见错误与业务文案用中文。
- 参数一律手动校验（框架只 `JSON.parse`），错误信息带稳定 code：`space/invalid-args`、`space/not-found`、`space/conflict`、`space/edit-not-found`、`space/edit-ambiguous`、`space/too-large`、`space/denied`、`space/cancelled`。
- 输出 envelope 用 XML 风格文本（模型友好），稳定 id（`sp-…`/`doc-…`/`cm-…`）供后续调用。
- 只读工具 `isConcurrencySafe: () => true`；写工具 `isConcurrencySafe: () => false`（同一文档的并发编辑应串行）。
- 所有工具的 `presentCall/presentResult` 做轻量卡片（generic/read/diff），`presentationMeta` 只放有界数据（diff 合计 >16 KB 时降级为 generic，避免撑大 Session 日志）。
- 首期 6 个工具；P1/P2 工具见 §5.7。

### 5.1 `space_list`

> 列空间，或列某个空间的文档树（不含正文）。不知道 `space_id`/`doc_id` 时先调用。

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `space_id` | string | 否 | 空间 id；省略时列出所有空间 |
| `include_archived` | boolean | 否 | 是否包含已归档文档，默认 `false` |

返回（`space_id` 省略时）：

```json
{ "spaces": [{ "id": "sp-inbox", "name": "收件箱", "goal": "", "is_default": true, "document_count": 12 }],
  "truncated": false }
```

`space_id` 给出时：

```json
{ "spaces": [],
  "space": { "id": "sp-…", "name": "产品", "goal": "…" },
  "documents": [{ "id": "doc-…", "title": "需求草案", "kind": "note", "parent_id": null,
                  "updated_at": "2026-11-09T05:12:00.000Z", "archived": false, "pinned": false }],
  "total_documents": 42, "truncated": true }
```

实现：`service.listSpaces()` / `service.listNodes(spaceId)`（**注意 `listNodes` 返回全部正文，工具层只投影元数据**）。上限 300 条 + `truncated` 标记；`document_count` 只数未删 `note`；folder 也出现在 `documents` 里（`kind:'folder'`），供模型选择 `parent_id`。`include_archived` 对空间列表同样生效：省略 `space_id` 且为 true 时用 `listArchivedSpaces()` 合并已归档空间。

### 5.2 `space_search`

> 在空间文档中搜索关键词，返回命中文档与摘录。不知道文档 id 时优先用它。

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 关键词（大小写不敏感，匹配标题与正文纯文本） |
| `space_id` | string | 否 | 限定空间；省略时搜索全部空间（上限 10 个） |
| `limit` | integer | 否 | 返回条数，1–50，默认 20 |

返回：

```json
{ "query": "token", "results": [{ "doc_id": "doc-…", "space_id": "sp-…", "space_name": "产品",
    "title": "鉴权方案", "excerpt": "…token 刷新…", "archived": false,
    "updated_at": "2026-11-09T05:12:00.000Z" }],
  "total": 3, "truncated": false }
```

实现：`service.search(spaceId, query)` 逐空间调用后合并，按 `updated_at` 降序取前 `limit` 条（`updatedAt` 通过 `getNode` 补，命中数已受内存索引约束）；`archived` 结果照实返回并标注。

### 5.3 `space_read`

> 读取一篇空间文档的正文与元数据。正文是 HTML；大文档用 `offset`+`max_chars` 分页。返回的 `updated_at` 必须作为 `space_edit` 的 `base_updated_at`。

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `doc_id` | string | 是 | 文档 id |
| `offset` | integer | 否 | 正文字符偏移（UTF-16），默认 0；用返回值 `next_offset` 续读 |
| `max_chars` | integer | 否 | 本次返回上限，1000–40000，默认 12000 |
| `include_comments` | boolean | 否 | 是否附带未解决评论（最多 20 条），默认 `false` |

返回：

```json
{ "doc": { "id": "doc-…", "space_id": "sp-…", "space_name": "产品", "title": "鉴权方案",
           "parent_id": null, "created_at": "…", "updated_at": "…", "creator": "me",
           "archived": false, "pinned": false, "content_length": 18234, "open_comment_count": 2 },
  "content": "<p>…</p>",
  "offset": 0, "returned_chars": 12000, "total_chars": 18234,
  "truncated": true, "next_offset": 12000,
  "comments": [{ "id": "cm-…", "author": "me", "body": "…", "quote": "…", "created_at": "…" }] }
```

实现要点：
- `service.getNode(docId)`；已删返回 `undefined` → `space/not-found`。
- **不调用 `recordOpen`**：读工具不产生用户活动/未读变化（§1.3 A7）。
- 截断在 UTF-16 代理对边界回退 1 个 char；`next_offset` = `offset + returned_chars`，与原文逐字符对应（不做标签对齐，保证可拼接）。
- 正文为 HTML 原文；描述里说明「编辑时复制返回的片段作为 `old_string`」。

`presentResult`：`card:'read'`，`path: "space://<spaceName>/<title>"`，`lines` 用 `htmlToText` 投影（仅卡片展示，不参与模型内容）。

### 5.4 `space_create`

> 在空间里新建一篇文档。正文是 HTML 片段，写入前会清洗。

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `space_id` | string | 是 | 目标空间 |
| `title` | string | 是 | 标题（trim 后 1–200 字符） |
| `content` | string | 否 | HTML 片段，清洗后保存，默认空 |
| `parent_id` | string | 否 | 目标文件夹 id；省略=根目录。必须是未删 folder 且同空间 |

返回：`{ "doc": { "id": "doc-…", "space_id": "…", "title": "…", "parent_id": null, "updated_at": "…" }, "space_name": "…" }`

实现：`service.createNode({spaceId, parentId, kind:'note', title})` + 非空 content 时 `service.saveNode(id, {content})`。两步走同一个 `origin='alter'` 的写作用域（首期接受两笔连续事务与毫秒级「空文档」中间态，revision +2；如不接受，可在 host 层新增 `createDocumentWithContent` 专用入口复制约 40 行 `createNode` 逻辑，合并为一笔事务）。归属与强制版本由包装器统一处理。

`presentCall`：`{card:'generic', title:'Create <title>', kind:'edit'}`。

### 5.5 `space_edit`

> 对文档做精确字符串替换（首选）或整篇重写。必须带 `space_read` 返回的 `base_updated_at`；base 过期时整次调用失败且不写盘。

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `doc_id` | string | 是 | 文档 id |
| `base_updated_at` | string | 是 | 来自 `space_read` 的 `updated_at`；（可选）也接受内容哈希形式的扩展 |
| `edits` | array | 否 | 精确替换数组，1–20 项；与 `content` 互斥 |
| `edits[].old_string` | string | 是 | 原文中**完全一致**的片段（含 HTML 标签），非空 |
| `edits[].new_string` | string | 是 | 替换文本，可为空（删除） |
| `edits[].replace_all` | boolean | 否 | 允许匹配多处，默认 `false`；`false` 时匹配数 ≠1 报错 |
| `content` | string | 否 | 整篇重写（HTML，清洗），与 `edits` 互斥；属于「破坏性写」，若把 `writeApproval` 调成 `destructive/always` 会被询问 |
| `title` | string | 否 | 同一事务内改标题 |

返回：

```json
{ "doc_id": "doc-…", "title": "鉴权方案", "updated_at": "2026-11-09T06:00:00.000Z",
  "version_recorded": true, "applied": [{ "index": 0, "replacements": 1 }],
  "length_before": 18234, "length_after": 18310 }
```

语义与错误：
- 先按 `edits` 顺序在内存草稿上做精确替换；任意一项失败 → 整次不写盘，返回 `space/edit-not-found`（未找到，提示用 `space_read` 重取）或 `space/edit-ambiguous`（出现 N 次，提示扩大片段或 `replace_all`）。
- CAS 门禁在**同一个 `store.update` 事务内**复核 `updated_at`（防 TOCTOU）；冲突返回 `space/conflict` 与当前 `updated_at`，提示重新 `space_read`。
- 结果大小：`length_after` 上限 256 KiB；`content` 整篇重写走全量清洗，`edits` 只对 `new_string` 做危险内容过滤（见 §7.4）。
- 版本：vendor 正常记录（5 分钟内可能不记）；包装器在未记录时补一条 `'alter'` 版本（§7.3）。
- 卡片：`presentCall` 用 `{card:'diff', title, diffs:[{path:'space://…', oldText, newText}]}` 预览每个替换；`presentResult` 用实际 diff；总 diff 超 16 KB 时降级 generic。

### 5.6 `space_comment`

> 以 AI 协作者身份给文档加评论（不改正文），用于评审与提问。

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `doc_id` | string | 是 | 文档 id |
| `body` | string | 是 | 评论正文，1–4000 字符 |
| `quote` | string | 否 | 引用的原文片段（≤1000 字符），用于评论锚点展示 |

返回：`{ "comment": { "id": "cm-…", "doc_id": "doc-…", "author": "alter", "status": "open", "created_at": "…" } }`

实现：`service.addComment({docId, body, quote})`；`author` 由 writeScope 打标（vendor 硬编码 `'me'`）。

### 5.7 后续工具（P1/P2，不在首期）

| 工具 | 内容 | 依赖能力 |
| --- | --- | --- |
| `space_organize` | rename / move / pin / unpin / archive / unarchive | `saveNode`（title）、`moveNode`、`setPinned`、`setArchived`；需修正 `archivedBy='user'` 的归属 |
| `space_history` | 列版本（含作者/时间/摘录）、恢复版本 | `listVersions`/`restoreVersion`；恢复也需 `base_updated_at` |
| `space_comments` | 列未解决评论 / resolve | `listComments`/`resolveComment` |
| `space_trash` | 删除到回收站 / 从回收站恢复 | `deleteNode`/`restoreNode`；**只允许 `writeApproval:'always'`**，首期不暴露硬删除 |
| `space_thoughts` | 随想读写/转文档 | `listThoughts`/`createThought`/`updateThought`/`convertThought` |

### 5.8 工具预算

- 6 个工具 schema 约 3.5–5 KB（≈1.0–1.4k tokens）。
- 不加 `systemPrompt.section`（每轮计费），靠 description 与调用结果自解释。
- 不使用 `deferLoading`（pi-ai 路由语义不保证，见 §2.3）。

---

## 6. Host 实现设计

### 6.1 模块划分

```
host/
  tools-types.ts   # 结构化 Tool 类型（无 @deepseek-ai import）
  agent-tools.ts   # 6 个工具定义 + registerSpaceTools()
  write-scope.ts   # withWriteScope(store) → SpaceStore + run/getRevision
  sanitize.ts      # sanitizeHtml / htmlToText / truncateChars
  rpc.ts           # + saveNode base 门禁 + watchRevision
  index.ts         # 组装、配置、审批监听、生命周期
```

### 6.2 结构化类型（自包含）

```ts
// host/tools-types.ts —— 只描述用到的形状，不依赖 @deepseek-ai/*
export interface JsonSchemaLike { /* type/oneOf/properties/required/additionalProperties/items/enum/const/description */ }
export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: JsonSchemaLike;
    render(args: unknown, value: unknown): { type: 'text'; text: string }[];
    presentationMeta?(args: unknown, value: unknown): unknown;
  };
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>;
  isConcurrencySafe?(args: unknown): boolean;
  presentCall?(args: unknown): unknown;
  presentResult?(args: unknown, result: { content: unknown[]; isError: boolean; meta?: unknown }): unknown;
}
export interface ToolsLike {
  register(definition: ToolDefinitionLike, options?: { when?: (ctx: { agent?: unknown }) => boolean | Promise<boolean> }): () => void;
}
```

`HostContextLike` 增加：

```ts
tools?: ToolsLike;
on?(name: 'tools/pre-execute', listener: (exec: ToolExecutionLike, next: () => Promise<unknown>) => Promise<unknown>): () => void;
```

### 6.3 组装与生命周期

```ts
// host/index.ts（apply 内，示意）
const rawStore = await openSpaceStore({ directory, now, logger });
const retained = withVersionRetention(rawStore, () => rawStore.getStorageSettings());
const scope = withWriteScope(retained);                       // actor/CAS/归属/强制版本/revision（最外层）
const service = createSpaceAuthority(scope, now);             // 业务服务写 scope，scope 内再进 retention
const storage = createSpaceStorage({ store: rawStore, directory });
const route = createSpaceFetchRoute({ service, storage, scope, revision: scope.getRevision });

// 工具：可选发现，tools 缺失时 RPC 仍可用
let disposeTools = () => {};
ctx.inject(['tools'], (child) => {
  disposeTools = registerSpaceTools(child.tools!, { service, scope, config: agentToolsConfig });
});
// 写审批：全局监听，只对 space_* 写工具生效
const disposeApproval = ctx.on?.('tools/pre-execute', approvalListener(config.agentTools.writeApproval));
// effect cleanup：disposeTools(); disposeApproval?.(); disposeRoute(); …
```

- 所有注册（route/tools/listener/snapshot）都必须在同一个 `ctx.effect` 内并返回 cleanup，保证卸载/重载不泄漏。
- 也可以保持 `inject: ['connection']` 不变，用 `ctx.get('tools')` 可选发现，避免无 tools 的 profile 里整个 Space 面板失效；设计推荐后者（工具是可选能力）。

### 6.4 配置（`SpacePluginConfig` 扩展，手工校验）

```ts
export interface SpacePluginConfig {
  dataDir?: unknown;
  agentTools?: unknown;   // boolean | object
}
// 归一化后：
interface ResolvedAgentToolsConfig {
  enabled: boolean;                 // 默认 true
  writeApproval: 'never' | 'always' | 'destructive'; // 默认 'never'（评审确认：直接执行，不询问）
  maxReadChars: number;             // 默认 12000，范围 1000–40000
  maxListDocuments: number;         // 默认 300，范围 1–1000
  maxDocumentBytes: number;         // 默认 256 KiB
  forceVersionPerWrite: boolean;    // 默认 true
}
```

配置写在插件行（`cordis.patch.yml` 的 row config），不写 profile 的 `package.json`。校验失败时打日志并回退默认值（不阻断 Space 主功能）。

### 6.5 RPC 扩展（`host/rpc.ts`）

| 端点 | 变更 | 说明 |
| --- | --- | --- |
| `space.saveNode` | args 增加可选第 3 项 `baseUpdatedAt`；有值时走 `scope.run({origin:'browser', base}, () => service.saveNode(id, patch))`，冲突抛 `SpaceRpcError('space/conflict', …)` | 浏览器保存冲突检测；`vendor` 签名不变 |
| `space.watchRevision` | **后续可选（首期不做）**：只读端点返回 `{ instance, revision, lastOrigin, updatedAt }` | 加入 `SPACE_METHOD_SET` 白名单；不触碰 `SpaceService`（特判分支） |

`revision`（首期可不实现，设计保留给后续 P2）归 `withWriteScope` 所有：每次成功 `store.update` 后 `revision += 1` 并记录本次 origin（`agent`/`browser`/`system`）。RPC 分发时对**有副作用的 `space.*` 方法**（如 `saveNode/createNode/deleteNode/moveNode/comment/thought` 等）统一包 `scope.run({origin:'browser'}, …)`，未包裹的读路径（归档 sweep）落为 `system`。插件重新激活时 `instance` 重新生成，客户端据此识别 Host 重启并全量刷新。

### 6.6 错误映射

| 场景 | code | 文案（示例） |
| --- | --- | --- |
| 文档不存在/已删 | `space/not-found` | `文档 doc-… 不存在或已删除；请用 space_list/space_search 重新定位。` |
| CAS 冲突 | `space/conflict` | `文档已被修改（当前 updated_at=…）；请重新 space_read 后再提交。` |
| 精确替换未命中 | `space/edit-not-found` | `第 2 个替换未找到完全匹配的 old_string；请用 space_read 获取当前 HTML 后重试。` |
| 精确替换命中多处 | `space/edit-ambiguous` | `old_string 出现 3 次；请扩大匹配片段，或设置 replace_all=true。` |
| 参数非法 | `space/invalid-args` | 指出具体参数与范围 |
| 超限 | `space/too-large` | `正文 320000 字符超过上限 262144。` |
| 配置禁止 | `space/denied` | `当前插件配置不允许 Agent 写入空间文档。` |
| 取消 | `space/cancelled` | 检查 `exec.signal.aborted` 后立即返回 |

### 6.7 测试钩子

沿用 `tests/host-apply.test.ts` 的 fake context 风格：fake ctx 增加 `tools.register` 捕获 `Map<name, definiton>`、`on` 捕获 listener、`inject` 直接执行回调；`pnpm check` 前新增 `tests/agent-tools.test.ts`、`tests/write-scope.test.ts`，并扩展 `tests/rpc.test.ts`、`tests/space-client.test.ts`。`scripts/verify.mjs:320` 的 `localSources` 增加三个新 Host 文件；`lib/host/*.js` 产物断言按需补充。

---

## 7. 写入安全设计

### 7.1 归属（attribution）

**问题**：`createNode`/`recordVersion`/`addComment`/`addCommentSupplement`/`convertThought` 都把作者硬编码为 `'me'`（`vendor/service/src/service.ts:221/396/574/615/765`），而 `vendor/` 不能改；产品活动流/历史靠 `creator/author` 区分「我 / Alter」。

**方案**：`withWriteScope` 包在业务服务最外层、`withVersionRetention` 之外（service → writeScope → retention → raw；即 `retained = withVersionRetention(rawStore)`，`scope = withWriteScope(retained)`，`createSpaceAuthority(scope)`）。这样归属打标与强制版本先发生，随后 retention 在同一事务里按策略裁剪；反过来（scope 在 retention 内）虽可工作，但强制版本会晚于裁剪追加，本次事务最多超出一版，且版本字节统计少算 `'alter'` 的 3 字节。在每次 `update` 里：

1. 调用时（同一同步栈）取走本次写作用域 `{ origin, guard }`（**不能**放到队列闭包里读全局变量，否则并发浏览器写会被误标）。
2. 事务内先跑 `guard`（CAS），再执行 vendor 原 `change`。
3. 若 `origin==='alter'`，按 diff 打标：
   - 新增 `SpaceNode` → `creator='alter'`；
   - 新增 `DocVersion` → `author='alter'`；
   - 新增 `Comment` / `CommentSupplement` → `author='alter'`；
   - 新增归档且 `archivedBy` 仍为 `'user'`（`setArchived` 硬编码）→ 改为 `'agent'`。

```ts
// host/write-scope.ts（示意）
function withWriteScope(store: SpaceStore): ScopedSpaceStore {
  let pending: { origin: Origin; guard?: Guard } | undefined;
  let revision = 0;
  let lastOrigin: Origin = 'system';
  let updatedAt = new Date(0).toISOString();

  function update<T>(change: (data: SpaceStoreData) => T): Promise<T> {
    const scope = pending;
    pending = undefined;                       // 同步捕获，避免并发误标
    return store.update((data) => {
      const before = captureBefore(data);      // id 集合 / updatedAt 快照 / 版本数
      scope?.guard?.(data);                    // CAS：失败 throw，事务回滚
      const result = change(data);             // vendor 原逻辑原样执行
      if (scope?.origin === 'alter') {
        stampAlter(data, before);              // 归属
        ensureVersion(data, before, nowIso()); // 强制版本（§7.3）
      }
      return result;
    }).then((result) => {
      revision += 1;
      lastOrigin = scope?.origin ?? 'system';
      updatedAt = new Date().toISOString();
      return result;
    });
  }

  return {
    read: () => store.read(),
    close: () => store.close(),
    update,
    run<T>(scope: { origin: Origin; guard?: Guard }, fn: () => T): T {
      pending = scope;
      try { return fn(); } finally { if (pending === scope) pending = undefined; }
    },
    getRevision: () => ({ instance, revision, lastOrigin, updatedAt }),
  };
}
```

**边界与已验证事实**：
- `service.saveNode` 等写方法在返回 Promise 前同步调用 `store.update`（没有 `await`），因此 `run()` 的 `finally` 在入队后立即执行、scope 已被捕获；不会误标后续请求。
- `stampAlter` 只改 JSON 字段，不改变 `store.ts` 的行级 diff/`structuredClone` 回滚机制，也不影响事务提交。
- 返回值是 vendor 在 `change` 内 `clone` 出来的（仍是 `'me'`）→ 写工具应自行构造返回值或写后 `getNode` 回读，不能直接透传。
- 已知遗漏：`search` 结果里随想的 `creator` 是派生值（`service.ts:887`），随想无 `creator` 字段，不影响文档工具；hub 无归属字段，首期不涉及。
- `create` + `save content` 若拆成两笔事务，会各 +1 revision 且中间有短暂空文档窗口；实现时优先在 writeScope 内提供 `createDocumentWithContent` 专用入口（同一事务内先 add node 再 set content 并触发一次 `recordVersion` 语义），减少一次提交与中间态。

### 7.2 CAS（乐观并发）

- **键**：`SpaceNode.updatedAt`（ISO ms 字符串）。它只在内容/标题实际变化、移动、恢复版本时推进，是内容版本的近似单射；pin/归档/删除/`recordOpen` 不推进，不会造成假冲突。
- **读侧**：`space_read`/`space_list` 返回 `updated_at`；模型只能凭它写。
- **写侧**：`space_edit` 必填 `base_updated_at`。门禁放在 `store.update` 事务内、vendor `change` 之前：

```ts
function nodeUnchangedGuard(docId: string, expected: string): Guard {
  return (data) => {
    const node = data.nodes.find((n) => n.id === docId);
    if (!node || node.deletedAt) throw new WriteError('space/not-found', …);
    if (node.updatedAt !== expected)
      throw new ConflictError({ currentUpdatedAt: node.updatedAt, currentTitle: node.title });
  };
}
```

- **为什么不在 service 外预检查**：队列里可能已有别的写排队（浏览器保存/另一 Agent 调用），预检查会读到旧内存；门禁在事务内执行才能与 `BEGIN IMMEDIATE` 对齐。
- **禁止**在 `store.update` 回调里 `await service.saveNode(...)`：同一队列会自我死锁（`host/store.ts:697-705`）。
- **冲突语义**：抛错回滚内存快照、不提交；工具返回当前 `updated_at`，模型应重新 `space_read` 后重试。不做自动 merge。
- **反向保护**：浏览器整篇保存目前不带 base，仍可能覆盖 Agent 写入；由 §9.4 的浏览器 CAS + 强制版本兜底。

### 7.3 强制版本（弥补 5 分钟节流）

vendor 的 `recordVersion` 对同一文档 5 分钟内最多记一条（`vendor/service/src/service.ts:205-224`）。若用户在 Agent 写入后 5 分钟内又保存旧草稿，两次都可能不产生版本 → Agent 内容不可恢复。

宿主在 `stampAlter` 后补一条版本：**凡是本次写入推进了 `updatedAt` 的文档，若本次没有为它新增 `DocVersion`，就追加一条 `{ id, docId, title, content, author:'alter', at: updatedAt }`**。它和业务写入在同一个事务提交；由于 `withVersionRetention` 在 scope 内层，紧随其后的同一事务裁剪会把更旧的版本裁掉（条数 + 64 KiB），最新一版永不删。

- 配置开关 `forceVersionPerWrite`（默认 true）；关闭后退回 vendor 原生行为。
- 代价：Agent 高频编辑时版本数增长更快（受条数/字节上限约束）；好处是「history 可恢复」对 Agent 写入始终成立。
- 只有 `origin==='alter'` 才强制；浏览器写入保持 vendor 语义。

### 7.4 HTML 清洗与大小上限

Agent 生成的 HTML 会被产品 UI 以 `innerHTML` 渲染（`vendor/ui-space/src/components/editor/Editor.tsx:591`），因此必须当成**不受完全信任的内容**处理（模型被提示注入、复制网页内容等）：

- **标签白名单**：`p br div span strong b em i u s del h1-h6 ul ol li blockquote pre code a hr table thead tbody tr td th img`。
- **属性白名单**：`a[href,title]`、`img[src,alt,width,height]`、其余标签只保留无属性；**移除**所有 `on*`、`style`、`class`、`id`、`data-*`。
- **移除**：`script style iframe object embed svg math form input textarea button link meta base template` 整块内容。
- **URL**：`href` 仅允许 `http(s):`/`mailto:`/站内 `#`；`src` 仅允许 `http(s):` 与 `data:image/(png|jpeg|webp|gif);base64,`（单图 ≤2 MB），其余删除属性。
- **实现**：Host 无 DOM，用迭代式正则清洗（移除危险块 → 过滤标签/属性 → 过滤 URL → 处理未闭合/未知标签），对结果做二次扫描直到稳定；作为「防误伤 + 防脚本执行」的保守层，不承诺通用 sanitizer 安全性（模型输出不是主要攻击面）。
- **整篇重写（`content`）**：对完整 HTML 做白名单清洗（会丢弃既有内容里不在白名单的属性，符合「整篇重写」语义）。
- **精确替换（`edits`）**：只对每个 `new_string` 做「危险块/属性/URL」过滤（`<script>`/`on*`/`javascript:` 等），不重排、不清洗用户既有 HTML，避免模型的一次小改动改动整篇样式。
- **纯文本用户输入**：工具描述要求 HTML；如 `content` 中不含任何标签，仍按 HTML 保存（浏览器编辑器可接受纯文本），但会转义 `<`/`&` 防止被解释为标签——实现上统一走清洗器即可。
- **大小**：单篇正文 ≤256 KiB（`maxDocumentBytes`）；单次 `edits` 的 `old_string`+`new_string` 合计 ≤256 KiB；超出返回 `space/too-large`。`space_read` 默认 12k、最大 40k 字符。

### 7.5 写审批（评审确认：默认直接执行）

- **默认 `writeApproval='never'`：不做审批拦截，Agent 写入立即生效。** 评审依据：产品已有三层可恢复性——强制版本（每次写入可回滚）、版本历史（默认 10 版/篇，可调）、每日整库快照；接受「先写、错了再恢复」的取舍。
- 恢复深度提醒：版本历史上限是「条数 + 64 KiB/篇」双约束，大文档可能只保留最近几版；重要文档的长期恢复依赖每日快照。建议把「版本历史上限」调到 20–30（设置页「存储与备份」）。
- 代码仍保留配置档位 `never / always / destructive`（`destructive` = 仅整篇重写、恢复版本、归档/删除时询问），需要用审批收紧时改插件行配置即可；默认 `never` 时监听器直接 `next()`，无额外开销。
- 若启用 `ask`：监听 `tools/pre-execute`，返回 `{ kind:'ask', reason, displayReason }`；无 approval 服务时 pipeline fail-closed，需确认 profile 装有 `dsh-user-approval`（本 profile 有）。同步 `tools.guard` 只用于硬护栏（如「归档文档不可写」），不做询问。

### 7.6 权限模型

- **现状**：`AgentPermission`（read/edit/comment/manage）与 `spaces.collaboratorIds` 只有存储，没有任何执行点；DSH Agent 与 Space 协作者也没有映射（`docs/research-agent-creation.md` 明确协作者是产品数据，不驱动运行时）。
- **首期（P0/P1）**：用插件配置门禁（`agentTools.enabled` + `writeApproval` + 全局只读开关）+ 工具只暴露安全操作（不做硬删除、不做跨空间批量）。这是单用户桌面产品的合理信任边界：工具与浏览器同属本机用户。
- **P3（可选，需要产品决策）**：插件配置 `actingCollaboratorId`（或 preset→collaborator 映射），写前校验：
  1. 不信模型传的 `space_id`：由 `doc_id` 反查 `spaceId`（`getNode`），create/move 校验目标空间；
  2. `space.collaboratorIds.includes(actingCollaboratorId)` 且 `agents.find(id).permissions` 含所需能力（read/edit/comment/manage，缺省 fail-closed）；
  3. 默认空间 `sp-inbox` 无协作者（`host/store.ts:39-41`），需显式绑定后才允许写。
- 无论是否启用映射，工具参数中的 `space_id`/`doc_id` 都要做存在性与一致性校验，不信任模型。

### 7.7 幂等与重试

- 写工具不做自动重试；`space_edit` 因 CAS 天然幂等（重放会冲突，模型重新读取后重试）。
- `space_create` 无幂等键，超时/模型重试可能重复建文档；首期接受（返回明确 id；可在 P1 加 `client_request_id` 去重表，或用「同空间同标题 + 最近 60s + creator=alter」启发式合并，首期不做）。
- 写后回读：`execute` 返回值基于本次计算与 `getNode` 回读，避免 vendor `clone` 的 `'me'` 泄漏到工具结果。

---

## 8. 读取与上下文预算

| 工具 | 上限 | 备注 |
| --- | --- | --- |
| `space_list` | 300 篇/次 + `truncated` | 只投影元数据，绝不返回 `content` |
| `space_search` | 50 条/次 | 摘录由 vendor 生成（约 72 字符），再补 `updated_at` |
| `space_read` | 默认 12k、最大 40k 字符/次 | `offset`+`next_offset` 续读；代理对边界回退 |
| `space_read(include_comments)` | 20 条未解决评论 | 评论正文截断 1k/条 |
| 卡片 meta | diff 合计 ≤16 KB | 超出降级 generic，避免 Session 日志膨胀 |

其他要点：
- 不返回 `listNodes` 的原始数组（含全量正文），先在 Host 投影。
- `htmlToText` 由 host 自备（vendor 的 `htmlToText` 未导出，`service.ts:67-81`），用于搜索摘录已有实现可参考；读卡片展示用。
- 大文档读取不建议一次 40k 全读；description 提示先读开头或按 `space_search` 命中位置定位。

---

## 9. 浏览器同步（首期不做，设计保留）

> 评审确认：产品暂不是协作产品，首期不做实时刷新；本节保留完整设计，供后续需要「协作感」时启用，不占首期工期。

### 9.1 问题与风险

现状下 Agent 写入后，已打开的 Space UI 不更新（无推送/轮询/focus 监听）。用户看到旧内容，随后 700ms 防抖保存会**整体覆盖** Agent 写入（`DocumentView.tsx:209-241`）；版本历史是唯一兜底，但 5 分钟节流可能让覆盖不可恢复。

### 9.2 revision 设计（Host）

- `withWriteScope` 维护进程内 `{ instance, revision, lastOrigin, updatedAt }`：
  - `instance`：插件每次激活重新生成的 UUID，客户端据此识别 Host 重启；
  - `revision`：每次成功 `store.update` +1；
  - `lastOrigin`：`'agent' | 'browser' | 'system'`（写作用域捕获；后台 sweep/初始化默认 `system`）。
- 新 RPC：`space.watchRevision`（无参数）→ `{ value: { instance, revision, lastOrigin, updatedAt } }`，加入 `host/rpc.ts` 的 `SPACE_METHOD_SET` 与特判分支；不污染 `SpaceService` 协议。
- 轮询成本：仅面板可见时每 4s 一次极小 JSON 请求；Host 侧纯内存读，无 SQLite 开销。

### 9.3 客户端软刷新

- `src/watch-client.ts`：`createSpaceWatcher(rpc)`，独立 `rpc.call('/api','alter-space',{op:'space.watchRevision',args:[]})`，**不进** `space-client.ts` 的串行链（避免每次保存被轮询排队）。
- `src/space-shell.tsx`：`useSpaceRevision(watcher)`，面板可见时 4s 轮询 + `visibilitychange`/`focus` 立即拉；记录上次 `{instance, revision}`：
  - `instance` 变化（Host 重启）→ 全量刷新；
  - `lastOrigin === 'agent'` 且 revision 前进 → 显示非阻塞横幅「Alter 更新了空间内容」，点击「载入最新」触发软刷新；
  - `lastOrigin === 'browser'` → 忽略（本窗口保存已有视图内 refresh；多窗口同步不在首期范围）。
- **软刷新首选**：`useMemo(() => ({ ...service }), [service, reloadToken])` 换 service 身份 → `SpaceApp` 的 `[service, version]` effects 重跑、全量重取，不卸载组件（保留路由/滚动）。若实测依赖失效，退化为 `<SpaceApp key={reloadToken}>` 重挂载。
- ⚠️ 前提：换 service 身份会触发 `DocumentView` 保存 effect 的 cleanup，若 dirty 会 flush 旧草稿（`DocumentView.tsx:160-171`）→ **必须先完成 §9.4 的浏览器 CAS**，并让冲突横幅只在用户点击后刷新（用户点击=接受丢弃本地草稿）。

### 9.4 浏览器保存 CAS 与冲突 UI

目标：Agent 写入后，用户的旧草稿保存失败而不是静默覆盖。

- **客户端**（`src/space-client.ts`）：维护 `Map<docId, updatedAt>`，在 `listNodes/getNode/createNode/saveNode/moveNode/restoreVersion/...` 返回值上记录；`saveNode(id, patch)` 调 RPC 时附加第三参 `baseUpdatedAt`（未知时不带）。
- **Host**（`host/rpc.ts`）：`space.saveNode` 有 base 时走 `scope.run({origin:'browser', guard: nodeUnchangedGuard(id, base)}, () => service.saveNode(id, patch))`；冲突返回 `SpaceRpcError('space/conflict', …)`。
- **UI**：`DocumentView` 的 `catch` 已显示「保存失败，重试」（vendor 不显示「保存中」，VENDOR.md 有记录）；冲突时客户端额外通知 shell：显示横幅「文档已在别处更新」+「载入最新（放弃我的修改）」。点击 → 换 service 身份/重挂载 → 旧组件 cleanup 的 flush 带过期 base 会再次冲突、不会覆盖 → 新内容加载。
- 不做自动 merge/覆盖按钮（需要拿到草稿内容，首期从简）。
- 代价：用户可能丢失未保存的本地编辑（有明确提示，且 Agent 写入在版本历史中）。

### 9.5 备选方案（不做）

| 方案 | 结论 |
| --- | --- |
| DSH 原生 Host→Client 推送 | 不可用：client `ctx.connection` 只有 rpc/state/generation/reconnect；`ctx.remote.$on` 的 key 是构建期静态 allowlist；Typert stream 需要构建期 descriptor，而本插件 client 未 inject remote、`build/build.mjs` 无 codegen |
| 自建 SSE（`GET /api/alter-space/events`） | 可行（Connection 的 Fetch 路由支持流式与断开中止，须挂 `/api` 下统一鉴权），但长连接/心跳/重连/测试成本高，留到 P2 之后按需 |
| long-poll | 比 4s 轮询省请求，但占连接、需要 waiter 管理与代理超时处理，收益有限 |
| 不刷新只靠重开面板/刷新页面 | 作为 fallback：即使 P2 未上线，文档改动也会在下次 `recordOpen`/页面刷新时出现；README 已声明无跨窗口推送 |

---

## 10. 一致性与恢复

- **事务边界**：CAS 门禁、vendor 业务写入、归属打标、强制版本、版本裁剪都在同一个 `store.update` 事务内；失败整体回滚内存快照（`host/store.ts:707-745`）。
- **单写者**：Agent 工具与浏览器 RPC 共享同一 store 队列，天然串行；不存在两个事务交错。
- **崩溃**：SQLite WAL + `synchronous=FULL`；提交成功才返回成功。工具调用在提交后返回，崩溃不会出现「工具报成功但没落盘」；反之超时可能「已落盘但模型认为失败」，由 `space_edit` CAS/`space_create` 重试风险兜底（§7.7）。
- **版本恢复**：强制版本让 Agent 写入可被 `restoreVersion` 恢复；retention 保证最新一版永不删。
- **备份**：每日整库快照不变；Agent 写入与浏览器写入对备份/RPO/恢复流程无影响。
- **多 Host 进程**：仍为 last-writer-wins（README 已知边界）；CAS 只在进程内有效，跨进程不覆盖。

---

## 11. 可观测性与运维

- 日志：工具写入成功/失败打 `logger.info/warn`（含 tool 名、doc id、长度、是否记录版本、revision）；错误带稳定 code。
- 模型侧：工具返回稳定的 `doc_id`、`updated_at`、`version_recorded` 等字段，便于模型/评测断言。
- Chat 侧：diff 卡片让用户直接看到 Agent 改了什么；`presentationMeta` 同时作为审计线索进入 Session 日志。
- 产品侧：归属 `'alter'` 让空间活动/历史自然展示 Agent 行为；评论出现在评论栏。
- 性能：读工具只做内存投影；写工具一次事务（含整库 clone 成本，与浏览器保存同级）；256 KiB 正文上限控制最坏情况。
- 工具可见性排查：`cordis_inspect_query`（Host `Tool.listTools`）确认 6 个工具已注册；`Config.listConfigs` 确认插件行配置生效。

---

## 12. 测试与验收

### 12.1 单元/集成

| 文件 | 覆盖 |
| --- | --- |
| `tests/write-scope.test.ts` | 归属打标（node/version/comment/supplement/archivedBy）、CAS 通过/冲突/回滚、强制版本（vendor 已记则不重复）、revision/origin |
| `tests/agent-tools.test.ts` | 6 个工具 schema 形状、参数校验、读截断与代理对边界、搜索/列表投影、create/edit/comment 返回值、错误 code、卡片 meta、`isConcurrencySafe` |
| `tests/sanitize.test.ts` | script/on*/javascript:/iframe/svg 剥离；白名单保留；data:image 限制；纯文本转义 |
| `tests/rpc.test.ts`（扩展） | `space.saveNode` 第三参冲突、白名单未变（`space.watchRevision` 在 P2 起才测） |
| `tests/space-client.test.ts`（扩展） | base 记录与第三参发送（P2 起启用） |
| `tests/host-apply.test.ts`（扩展） | fake ctx 下工具注册/审批监听/卸载清理 |

### 12.2 手动验收

1. `pnpm check` 全绿（build + verify + typecheck + test）。
2. 按 AGENTS.md 安装到 desktop profile，重启 Host row；刷新页面。
3. `cordis_inspect_query`（Host `Tool.listTools`）确认 6 个工具；新会话首轮提示词增量可接受。
4. 让 Agent「列出空间 → 搜索 → 读文档 → 在文档末尾追加一段 → 评论」；在 Space 面板核对内容、评论、版本历史、活动流（应显示 Alter）。
5. 冲突与恢复：让 Agent 修改文档成功后，在浏览器旧页面保存 → Agent 内容可从版本历史恢复（强制版本）；再用过期 `base_updated_at` 调工具 → 拒绝且不落盘。
6. 非实时可见性：Agent 写入后重新进入该文档/切换空间/刷新页面，内容与归属（Alter）正确显示；不需要任何客户端改动。
7. 数据安全：测试全部使用 `mkdtemp` 临时库或测试空间；不污染用户 `space.db`（与既有测试约定一致）。

### 12.3 回归/静态检查

- `scripts/verify.mjs`：`localSources` 增加 `host/agent-tools.ts`、`host/write-scope.ts`、`host/sanitize.ts`、`host/tools-types.ts`；新增 `lib/host` 产物断言。
- `tsconfig.host.json` 自动纳入 `host/**/*.ts`；注意 `noUnusedLocals/noUnusedParameters`。
- `pnpm build` 后 `lib/` 与 `client.js` 为生成物，不入库。

---

## 13. 分阶段实施

| 阶段 | 内容 | 交付/验收 | 预估 | 风险 |
| --- | --- | --- | --- | --- |
| **P0 只读** | `host/tools-types.ts` + `agent-tools.ts`（list/search/read）+ 截断/投影 + 单测 | A1/A2/A7/A9；无写入风险，可先上线验证工具面 | 1.0–1.5 人日 | 低 |
| **P1 基础写入** | `write-scope.ts`（归属/CAS/强制版本）+ create/edit/comment + 可选审批监听 + 配置 + diff 卡片 + 单测 | A3/A4/A5/A6；浏览器保存仍为 vendor 语义 | 2.0–2.5 人日 | 中：CAS/归属包装器需仔细测试 |
| **P2 同步与防覆盖（可选，首期不做）** | 浏览器 `saveNode` CAS + 冲突横幅；`watchRevision` 轮询 + 软刷新 | A8 的实时版本；旧草稿被拦截 | 1.5–2.0 人日 | 中：依赖 SpaceApp 的 `[service]` 依赖数组（vendor 同步后可能失效），需集成测试 |
| **P3 扩展（可选）** | `space_organize`/`space_history`/`space_comments`（+可选 `space_trash`）、协作者权限映射、按 preset 可见性 | 组织/历史/评论能力，权限 fail-closed | 1.5–2.5 人日 | 中：权限映射需产品确认 |

建议节奏：P0 合入后先观察模型使用质量（工具描述、命名、读预算），再上 P1。**首期只做 P0 + P1，约 3–4 人日**；P2（浏览器 CAS/同步）与 P3 按需再排期。

---

## 14. 风险与开放问题

### 14.1 风险清单

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 浏览器整篇自动保存覆盖 Agent 写入 | Agent 内容被覆盖（非实时，下次刷新才可见） | 强制版本 + 每日快照可恢复；首期不做浏览器拦截（评审接受） |
| R2 | Agent 写入覆盖用户正在编辑的内容 | 用户草稿丢失 | Agent 侧 CAS（过期 base 拒绝，不覆盖用户刚保存的内容） |
| R3 | HTML 注入（`innerHTML` 渲染） | UI 层脚本/样式脏化、白屏 | §7.4 白名单清洗 + 大小上限 |
| R4 | 读工具触发归档 sweep | 闲置文档被归档（产品既有行为） | 接受并写进工具文档；不调用 `recordOpen` |
| R5 | 工具全局可见 | 所有 Agent/子 Agent 都能写空间 | 配置门禁/审批；P3 按 preset 或插件行作用域收窄 |
| R6 | 首 token 成本 | +1.0–1.5k tokens | 精简 description、无 systemPrompt section、必要时合并工具 |
| R7 | 5 分钟版本节流 | 覆盖不可恢复 | 强制版本（默认开） |
| R8 | 大文档/大正文 | 内存与 SQLite 事务放大 | 256 KiB 上限、读分页 |
| R9 | 工具重试/重复创建 | 重复文档 | 返回 id，模型重试前先 list/search；后续幂等键 |
| R10 | `vendor` 同步漂移 | 依赖字段/行为变化 | 把依赖的字段/行号列入附录 B，升级 vendor 时跑 agent-tools 测试 |
| R11 | 首期无实时刷新，用户看到旧内容 | 误以为 Agent 没写 | 工具返回明确结果；重新进入文档/刷新页面即更新；后续 P2 再提示刷新 |
| R12 | 版本历史被裁剪（10 版/64 KiB/篇） | 久远内容无法从历史恢复 | 调高版本历史上限（建议 20–30）；长期恢复依赖每日快照 |
| R13 | 多窗口/多 Host | last-writer-wins | 文档化（README 已有）；CAS 只保进程内 |

### 14.2 产品决策（2026-11-09 评审结论）

1. **写审批**：已确认 `writeApproval='never'`——直接执行、不弹审批。可恢复性由强制版本 + 版本历史 + 每日整库快照兜底；配置保留 `always`/`destructive` 供将来收紧。注意大文档的版本历史受 64 KiB/篇限制（建议把「版本历史上限」调到 20–30）。
2. **浏览器实时刷新**：已确认首期不做（产品暂不是协作产品）。Agent 写入在下次进入文档/切空间/刷新页面时可见；浏览器保存 CAS 与 `watchRevision` 设计保留在 §9，后续按需启用。
3. **正文格式**：待确认，说明见 §14.3；建议 HTML。

### 14.3 正文格式说明（待确认）

空间文档正文在 SQLite 里是编辑器产出的 **HTML**（`vendor/protocol/src/space.ts:59`）。本决策只影响「Agent 读写时看到/提交什么格式」，不影响功能可行性：

| | A. HTML（建议） | B. Markdown |
| --- | --- | --- |
| 读 | 原样返回 `<p>…</p>` → Agent 看到标签 | 读时 `HTML→Markdown` 转换 |
| 写 | 精确替换 HTML 片段 | 写时 `Markdown→HTML` 转换 |
| 优点 | 零转换损失；加粗/列表/表格/图片/颜色原样保留；精确替换不重排用户没让改的内容；无新依赖 | 模型更熟悉、token 更省、写起来自然 |
| 缺点 | 标签占 token；长文需小心复制标签 | 转换有损（颜色/高亮/对齐/嵌套/自定义属性丢失或变形）；写回常整篇重排；需转换库；读/写基准格式必须统一，否则精确匹配更易失败 |

当前空间文档以段落+列表为主，HTML 的可读性可接受。若只考虑当前 HTML 编辑器，选 A 即可；**但 2026-11-09 讨论后已收敛为「JSON AST 权威 + Markdown 投影 + Document Operations」的混合架构**（见 [research-document-storage-format.md](./research-document-storage-format.md) §11）：AI 读 Markdown 投影、写走 Operations，权威存储是 AST，mindmap/交互组件/图片走对象与资产旁表。因此本文的 `space_read`/`space_edit` 工具契约必须按新模型改写（outline/read/ops/generate/object_*），不要先按 HTML 实现。

---

## 附录 A：关键代码骨架（示意，非最终实现）

### A.1 注册一个工具（`host/agent-tools.ts`）

```ts
function readTool(deps: ToolDeps): ToolDefinitionLike {
  return {
    name: 'space_read',
    description:
      'Read one Space document. Content is HTML; read the whole document or a character range. ' +
      'Pass the returned updated_at as base_updated_at when calling space_edit.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['doc_id'],
      properties: {
        doc_id: { type: 'string', description: 'Document id from space_list or space_search.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset; use next_offset to continue. Defaults to 0.' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 40000, description: 'Characters to return. Defaults to 12000.' },
        include_comments: { type: 'boolean', description: 'Include up to 20 open comments. Defaults to false.' },
      },
    },
    output: {
      schema: { /* object: doc/content/offset/returned_chars/total_chars/truncated/next_offset/comments */ },
      render: (_args, value) => [{ type: 'text', text: renderRead(value as ReadValue) }],
      presentationMeta: (_args, value) => presentationOfRead(value as ReadValue),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = validateReadArgs(args);           // 手写校验（框架只 JSON.parse）
      if (exec.signal.aborted) throw new SpaceToolError('space/cancelled', '已取消');
      const node = await deps.service.getNode(input.docId);
      if (!node) throw new SpaceToolError('space/not-found', `文档 ${input.docId} 不存在或已删除`);
      return buildReadValue(node, input, deps);       // 截断/评论/元数据
    },
    presentCall: () => ({ card: 'generic', title: 'Read Space document', kind: 'read' }),
    presentResult: (_args, result) =>
      result.isError ? undefined : renderReadCard(result.meta as ReadPresentation),
  };
}
```

### A.2 写作用域（`host/write-scope.ts`）

```ts
const before = (data: SpaceStoreData) => ({
  nodeIds: new Set(data.nodes.map((n) => n.id)),
  updatedAt: new Map(data.nodes.map((n) => [n.id, n.updatedAt])),
  versionCount: countVersionsByDoc(data),
  commentIds: new Set(data.comments.map((c) => c.id)),
  supplementCount: new Map(data.comments.map((c) => [c.id, c.supplements.length])),
});

function stampAlter(data: SpaceStoreData, b: Before) {
  for (const node of data.nodes) {
    if (!b.nodeIds.has(node.id)) { node.creator = 'alter'; continue; }
    if (node.updatedAt !== b.updatedAt.get(node.id) && node.archived && node.archivedBy === 'user')
      node.archivedBy = 'agent';
  }
  for (const version of data.versions) if (!b.versionIds.has(version.id)) version.author = 'alter';
  // comments / supplements 同理
}

function ensureVersion(data: SpaceStoreData, b: Before, at: string) {
  const counts = countVersionsByDoc(data);
  for (const node of data.nodes) {
    const grew = (counts.get(node.id) ?? 0) > (b.versionCount.get(node.id) ?? 0);
    if (node.updatedAt !== b.updatedAt.get(node.id) && !grew) {
      data.versions.push({ id: createId('ver'), docId: node.id, title: node.title,
        content: node.content, author: 'alter', at });
    }
  }
}
```

### A.3 工具内写调用（`space_edit`）

```ts
return deps.scope.run(
  { origin: 'alter', guard: nodeUnchangedGuard(docId, baseUpdatedAt) },
  () => deps.service.saveNode(docId, { title, content: nextContent }),
).then((saved) => ({ doc_id: docId, title: saved.title, updated_at: saved.updatedAt, … }));
```

### A.4 审批监听

```ts
function approvalListener(mode: WriteApproval) {
  return async (exec: ToolExecutionLike, next: () => Promise<PreToolDecisionLike>) => {
    if (!WRITE_TOOLS.has(exec.name)) return next();
    if (mode === 'never') return next();
    const disappearing = mode === 'always' || isDestructiveWrite(exec);
    return disappearing
      ? { kind: 'ask', reason: `Alter writes to a Space document (${exec.name}).`,
          displayReason: { en: 'Allow the AI to write to your Space?', zh: '允许 Alter 修改空间文档吗？' } }
      : next();
  };
}
```

### A.5 RPC 增量

```ts
// host/rpc.ts
if (group === 'space' && method === 'watchRevision') return { value: options.revision() };
if (group === 'space' && method === 'saveNode') {
  const [id, patch, baseUpdatedAt] = args;
  if (typeof baseUpdatedAt !== 'string') return { value: await service.saveNode(id, patch) };
  return { value: await scope.run(
    { origin: 'browser', guard: nodeUnchangedGuard(id, baseUpdatedAt) },
    () => service.saveNode(id, patch),
  ) };
}
```

### A.6 客户端轮询（`src/space-shell.tsx` 示意）

```tsx
const [reloadToken, setReloadToken] = useState(0);
const [notice, setNotice] = useState<string | null>(null);
useEffect(() => {
  if (settings) return;
  let last = { instance: '', revision: -1 };
  const poll = async () => {
    const next = await watcher.revision();           // space.watchRevision
    if (next.instance !== last.instance) { last = next; setReloadToken((v) => v + 1); return; }
    if (next.revision > last.revision && next.lastOrigin === 'agent')
      setNotice('Alter 更新了空间内容');
    last = { instance: next.instance, revision: next.revision };
  };
  const timer = window.setInterval(poll, 4000);
  const onVisible = () => { if (!document.hidden) void poll(); };
  document.addEventListener('visibilitychange', onVisible);
  return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
}, [settings, watcher]);
const liveService = useMemo(() => ({ ...service }), [service, reloadToken]);
```

---

## 附录 B：调研依据（关键证据）

| 主题 | 证据 |
| --- | --- |
| 正文为 HTML / 编辑器 | `vendor/protocol/src/space.ts:59`；`vendor/ui-space/src/components/editor/Editor.tsx:591` |
| 浏览器自动保存 | `vendor/ui-space/src/views/DocumentView.tsx:160-171/172-185/209-241` |
| SpaceApp 刷新点 | `vendor/ui-space/src/SpaceApp.tsx:112/127/170` |
| 保存/版本/活动度/所有权 | `vendor/service/src/service.ts:205-224/420-447/472-498/537-551/574/615/765` |
| 版本保留 | `host/retention.ts:22-61/116-133`；`host/settings.ts:24-41` |
| 单写者/事务 | `host/store.ts:694-745` |
| 现有 RPC 白名单 | `host/rpc.ts:21-64/162-206` |
| 工具注册契约 | `@deepseek-ai/dsh-tools/lib/index.js:433-445`；`pipeline.js:710-740/850-864` |
| 工具实现范式 | `@deepseek-ai/dsh-tool-fs/lib/index.js:253-394/548-641/1458-1555` |
| 审批事件 | `cordis_inspect_query` Event `tools/pre-execute`；`dsh-user-approval/lib/index.js:155/200` |
| 客户端无推送 | `dsh-client-connection/lib/client.browser.js:1421-1456`；`dsh-api-remotes/lib/index.js:21/155` |
| 构建自包含 | `scripts/verify.mjs:166-179/320`；`tsconfig.host.json` |

> 升级 DSH 或同步 `vendor/` 后，需重新核对上表行号与行为，并跑 `pnpm check` + §12 手动验收。

---

## 附录 C：本文引用的既有边界

- README「已知边界」：单 Host 实例、无跨窗口实时推送、`node:sqlite` 同步 API；本方案不改变这些边界（P2 仅进程内轮询）。
- `docs/research-agent-creation.md`：Space 协作者是产品数据，不驱动真实 DSH Agent；本方案把 Agent 写入统一归属 `'alter'`，不假装协作者身份；P3 的映射是可选增强。
- `vendor/VENDOR.md`：`vendor/` 逐字节一致；本方案所有改动在 `host/`、`src/`、`tests/`、`scripts/`。
