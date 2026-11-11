---
type: design
status: active
updated: 2026-11-11
---

# Agent 空间文档读写方案

这篇方案回答「Agent 怎样发现、读取和写入空间文档，为什么用 Host 原生工具，写入如何做到可归属、
可恢复、不互相踩踏」。工具契约与 op 语义以 [specs/agent-doc-tools-v0.md](../specs/agent-doc-tools-v0.md)
和 [specs/document-operations-v0.md](../specs/document-operations-v0.md) 为准；本文件记录决策与理由，
不重复 schema 与逐字段契约。

## 1. 目标与非目标

**目标**

- Agent 能发现并读取空间文档：通过搜索定位文档，按 outline + 范围读 Markdown 投影与元数据。
- Agent 能创建、编辑文档，写入与浏览器走同一权威链路（Host SQLite 单写者队列），刷新后 UI 一致。
  （列表/发现工具与评论工具未做；当前工具面见 spec。）
- 写入可归属（`alter`）、可审计（revision/op log）、可恢复（版本与快照）；冲突不静默覆盖。
- 保持插件自包含：Host 不新增网络链路与 `@deepseek-ai/*` 运行时依赖，第三方库打进客户端 bundle。

**非目标**

- 只做文档；随想、事项、旅程、观察留到后续。
- 不做硬删除与跨空间批量操作。
- 不做真实的 DSH Agent ↔ Space 协作者身份绑定与权限执行。
- 不做浏览器实时刷新与跨窗口同步（见 §9）。
- 不做整篇 Markdown 回写解析；结构修改只走 Operations（见内容架构方案）。

## 2. 为什么是 Host 原生工具

| 备选 | 为什么不选 |
| --- | --- |
| MCP / HTTP 中转 | 多一跳；Connection 鉴权要重新解决；多一个进程/协议面，没有功能收益 |
| 把文档投影成工作区文件，复用 `read`/`write`/`edit` | 丢空间结构、评论、版本、归属；双向同步会回环；多窗口冲突 |
| PTC / code-mode | 本 profile 未启用 PTC；调试与审批更复杂；适合远期 |
| 只做只读工具 | 满足不了写入需求；可作为阶段 0 过渡 |

**核心优势**：工具运行在 Host 进程内，直接调用现有 `SpaceService`，因此可以**复用单写者队列、
版本记录和事务**。所有写入安全设计（归属、CAS、强制版本）都建立在这一条上：如果工具走 HTTP 回环，
这些保证要么退化成「先查后写」的竞态，要么需要在协议层重新实现一遍事务。

工具面收敛为 `space_doc_outline` / `space_doc_read` / `space_doc_search` / `space_doc_ops` /
`space_doc_patch` / `space_doc_generate` / `space_doc_undo`、对象/资产工具与 `space_component_catalog`；
正文只有 AST 一种格式，正文写入只经 Operations。浏览器侧写入走同一条链路：旧 `DocumentView` 经
legacy adapter 生成 Operations，与 Agent 共用 `doc.applyOps` / `doc.restoreVersion`。完整契约见
[specs/agent-doc-tools-v0.md](../specs/agent-doc-tools-v0.md)。

工具划分的设计取舍：

| 工具 | 设计要点 |
| --- | --- |
| `space_doc_outline` | 先给结构摘要与 block id，不返回正文；模型据此决定读哪里、改哪里 |
| `space_doc_read` | 按 block/范围投影 Markdown，带锚点与续读位置；不做「读整篇再让模型自己找」 |
| `space_doc_search` | 返回块级命中，让长文档不必全文读取；跨文档查找也走它 |
| `space_doc_ops` | 唯一的结构修改入口；带 baseRevision、幂等键、dry-run 与逐 op 错误 |
| `space_doc_patch` | 单块纯文本精确替换（单次 `update_text` 封装），Agent 的默认编辑路径 |
| `space_doc_undo` | 撤销最近或指定批次（inverseOps），生成新 revision |
| `space_doc_generate` | 只生成新内容（新文档或明确位置插入），Markdown 解析失败即报错 |
| 对象/资产/组件目录工具 | 富对象 payload 与二进制不进正文；组件先查目录再写实例；按能力声明决定可否读写 |

这样划分的目标是**正交且少**：读路径按需扩展；写路径只有「单块文本 patch」「结构化修改」与
「新内容生成」三类意图，都带 block id、baseRevision 与 schema 校验，避免「整篇替换」这类无法给出
稳定 diff、冲突面大的入口。

## 3. 写入安全三件套

| 机制 | 解决的问题 | 做法 |
| --- | --- | --- |
| **归属** | vendor 把创建/版本/评论作者硬编码为 `'me'`，Agent 写入会冒充用户 | 在 store 外层加 `withWriteScope` 包装器：Agent 写入在同一事务里把新增节点/版本/评论打标为 `'alter'`，活动流自然显示「Alter 更新了」 |
| **CAS** | Agent 与用户可能基于旧内容互相覆盖 | 读结果返回 revision，写操作必须回传 base；门禁放在**同一个 store.update 事务内**复核，不是先查后写 |
| **强制版本** | vendor 版本记录有 5 分钟节流，被覆盖的内容可能无历史可恢复 | Agent 写入若本次没有产生版本，宿主在同一事务补记一条 `'alter'` 版本（默认开，受版本条数/字节裁剪约束） |

要点与理由：

- **CAS 必须在事务内**：队列里可能已有浏览器保存或另一 Agent 调用排队，事务外预检查读到的是旧内存
  （TOCTOU）；只有和事务提交对齐，冲突才真正「不落盘」。
- **冲突不自动 merge**：返回当前 revision 与可操作提示，让模型重新读取后重试；自动合并会把
  两个来源的语义差异藏起来。
- **归属只对 Agent 写入生效**：浏览器写入保持 vendor 原有语义，避免把用户操作误标为 Alter。
- 三件套缺一不可：归属回答「是谁写的」，CAS 回答「基于哪个版本写的」，强制版本回答「写错了能否回退」。

包装顺序也是设计的一部分：写作用域包在业务服务最外层、版本裁剪之外，这样归属打标与强制版本先发生，
随后同一事务里的裁剪再按策略收敛版本；反过来放会把补记的版本排除在裁剪统计之外，长期会超出预算。

## 4. 读侧预算与上下文

- **先结构后正文**：`outline` 建立全局认知，再按 block/范围读；列表与搜索只投影元数据与块级命中，
  绝不返回全量正文。
- **预算写死**（数值见 spec，不在本篇复述）：outline ≤ 2k tokens，单次读 ≤ 12k tokens / ≤ 40k 字符；
  ops 回执只返回 revision/changed_block_ids/diff，不回传整篇文档。
- **稳定定位**：所有 target 用 block id，不用「第 3 段」这类位置描述；位置会随编辑漂移，
  而 block id 能让「先读后写」的 CAS 语义成立。
- **并发语义**：读工具标记为并发安全；写工具标记为不并发安全，同一文档的并发编辑应串行。
- 卡片类展示数据（diff、预览）有上限，超出降级为普通卡片，避免把 Session 日志撑大。

读侧预算不是实现细节，而是方案上限：模型能否在有限上下文里处理长文档、能否只改一处而不重写全篇，
直接决定工具的成功率与 token 成本。

## 5. 清洗、校验与大小上限

- **主路径是 schema 校验**：写入走 Operations 与 Schema Registry；未知节点类型、非法 props、
  越界 payload 直接拒绝落盘，不静默降级。Markdown 只用于新内容生成，解析失败即报错。
- **不伪造活动**：读工具不调用 `recordOpen`，不改变用户活动度与未读状态；读路径的归档 sweep
  是产品既有副作用，接受并记录。
- **大小上限**：单篇正文 ≤ 512 KiB（见 [document-model-v0.md](../specs/document-model-v0.md) §2）；
  读默认 12k、最大 40k 字符/次；搜索默认 20、最多 50 条/次；diff 卡片 meta 合计 ≤16 KB
  （超出降级为普通卡片，避免 Session 日志膨胀）。

## 6. 写审批：默认直接执行

- **默认 `writeApproval='never'`：不弹审批，Agent 写入立即生效。** 底气是三层可恢复性：
  强制版本（每次写入可回滚）、版本历史（每篇 10 版可调）、每日整库快照。
- 接受「先写、错了再恢复」的取舍：单用户桌面产品，Agent 工具与浏览器同属本机用户，事前拦截的收益
  低于审批疲劳的成本。
- 配置仍保留 `never / always / destructive` 三档；`destructive` 只对整篇重写、恢复版本、归档/删除
  等破坏性操作询问。默认 `never` 时监听器直接放行，无额外开销。
- **恢复深度提醒**：版本历史上限是「条数 + 字节/篇」双约束，大文档可能只留最近几版；重要文档的长期
  恢复依赖每日快照，建议把版本上限调到 20–30（设置页「存储与备份」）。

## 7. 权限现状

- `AgentPermission` 与 `spaces.collaboratorIds` 目前只有存储、没有执行点；DSH Agent 与 Space 协作者
  之间也没有映射。它们是产品数据，不驱动运行时。
- 当前用插件配置门禁（`agentTools.enabled` + `writeApproval` + 只读开关）并只暴露安全操作：
  不做硬删除、不做跨空间批量。这是单用户桌面产品的合理信任边界。
- 无论是否启用权限映射，工具参数中的 `space_id`/`doc_id` 都要做存在性与一致性校验，不信任模型输入；
  由 `doc_id` 反查空间，而不是相信模型传的 `space_id`。
- 后续（P3）可选：插件配置 `actingCollaboratorId` 或 preset→collaborator 映射，写前校验空间成员
  与能力，缺省 fail-closed；默认空间 `sp-inbox` 无协作者，需显式绑定后才允许写。

## 8. 幂等与重试

- 写工具不做自动重试；`space_doc_ops` / `space_doc_patch` 带 `idempotency_key`，重复请求返回原结果，天然适合模型超时重放。
- CAS 让重放变为冲突而不是重复写入；`dry_run` 不落盘，可安全预览。
- 创建文档没有幂等键：超时或模型重试可能重复建文档，接受这个风险（返回明确 id，模型重试前先
  list/search）；后续可加 `client_request_id` 去重表或「同空间同标题 + 短时间窗 + creator=alter」启发式。
- 写后回读：返回值基于本次计算与回读，避免 vendor 内部 clone 出来的旧作者字段泄漏到工具结果。

## 9. 浏览器同步：不做实时推送

**决策**：Agent 写入后不主动推送或刷新已打开的浏览器面板；产品目前不是协作产品，不需要「Agent 写完
面板立刻变」。

- **何时能看到**：重新进入文档、切换空间、切走面板再回来，或刷新页面时 `SpaceApp` 会重新拉取数据，
  不需要改客户端代码。
- **浏览器与 Agent 都做 CAS**：保存带 `baseRevision`；过期 base 直接失败，冲突时保留编辑面内容并
  提示重试，不静默覆盖（草稿/对比/重载 UX 见健壮性清单，当前未做）。
- **后续可选（需要时再设计）**：revision 轮询 + 软刷新、跨窗口同步。DSH 原生 Host→Client 推送对
  第三方插件不可用（构建期 allowlist），自建 SSE 成本高，均不占当前工期。
- **为什么现在不做**：实时同步要连带解决保存冲突 UI、客户端依赖数组失效与多窗口语义，收益是「协作感」
  而非数据安全；数据安全已由 CAS、强制版本与快照覆盖。

## 10. 实施阶段与工具面现状

- 已实现 11 个工具：`space_doc_outline` / `space_doc_read` / `space_doc_search` / `space_doc_ops` /
  `space_doc_patch` / `space_doc_generate` / `space_doc_undo`、`space_asset_import`、
  `space_component_catalog`、`space_object_get` / `space_object_update`；契约与预算以
  [spec](../specs/agent-doc-tools-v0.md) 为准。
- 浏览器实时同步（§9）仍不做；文档列表/评论工具与协作者权限映射未做，按需再排。
- 工具 schema 成本约 +2.2–2.6k tokens（11 个），靠精简 description 控制，不增加每轮 system prompt 段。

## 11. Top 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 用户旧草稿覆盖 Agent 写入 | 保存被 CAS 拒绝，用户需重试 | 浏览器保存带 CAS，冲突时保留编辑面内容；强制版本 + 快照兜底 |
| Agent 覆盖用户正在编辑的内容 | 用户草稿丢失 | Agent 侧 CAS：过期 base 拒绝，不自动 merge |
| 注入/恶意内容进入正文 | 面板渲染异常、脚本执行 | schema 校验 + 编辑器粘贴过滤 + 组件目录 fail-closed（无任意代码） |
| 工具对所有 Agent（含子 Agent）可见 | 任意 Agent 都能写空间 | 配置门禁；后续按 preset 或插件作用域收窄 |
| `vendor` 同步后行为漂移 | 依赖字段/行为变化导致归属/CAS 失效 | 升级 vendor 后跑工具与写作用域测试；依赖面尽量收敛 |
| 版本历史被裁剪 | 久远内容无法从历史恢复 | 调高版本上限（建议 20–30）；长期恢复依赖每日快照 |
| 无实时刷新，用户看到旧内容 | 误以为 Agent 没写 | 工具返回明确结果；重新进入/刷新即更新 |
| 多窗口/多 Host last-writer-wins | 跨进程覆盖 | 文档化已知边界；CAS 只在进程内有效 |

## 12. 验收口径

| # | 验收项 | 判定 |
| --- | --- | --- |
| A1 | 工具可见 | 安装后工具列表出现 spec v0 的 `space_doc_*` 工具；`pnpm check` 通过 |
| A2 | 读准确 | outline/read 返回的 block id 与投影正文和 AST 一致；范围读可按续读锚点拼接 |
| A3 | 写归属 | Agent 新建/修改后节点 `creator='alter'`、新版本 `author='alter'`、活动流显示「Alter 更新了」 |
| A4 | 冲突不落盘 | 过期 `baseRevision` 调用 → 冲突错误，回读内容与版本均不变 |
| A5 | 可恢复 | Agent 写入后用户保存旧草稿，新内容仍可从版本历史恢复（强制版本生效） |
| A6 | 非法写入被拒 | 未知节点类型、非法 props、越界大小被拒绝且不落盘 |
| A7 | 读不改活动 | 连续读不改变 `activity`/`lastOpenCreditAt` |
| A8 | 写入可见性（非实时） | Agent 改文档后重新进入/切空间/刷新页面即可看到最新内容，数据不丢 |
| A9 | 上下文预算 | 工具 schema 首轮约 +2.2–2.6k tokens（11 个）；单次读投影 ≤12k tokens / ≤40k 字符 |
| A10 | 原子与撤销 | 批量 ops 全有或全无；一次 apply 可撤销，op log 可还原 |

完整契约与 spike 验收标准见 [specs/agent-doc-tools-v0.md](../specs/agent-doc-tools-v0.md)
与 [specs/document-model-v0.md](../specs/document-model-v0.md)。

## 13. 实现期约束（工具注册与事务）

- 工具对所有 Agent（含子 Agent）可见，插件配置门禁是唯一范围控制；后续按 preset 或插件作用域收窄。
- DSH 工具框架只做 JSON 解析，参数校验与错误映射必须在工具实现内手写，错误用稳定错误码字符串返回。
- 写作用域必须在 `store.update` 回调内完成；不要在该回调内 await 同一个 store 的其他更新
  （单写者队列会自锁）。
- 失败要可操作：冲突时返回当前 revision，让模型重读后重试；不允许部分成功却不报错。

## 14. 全量能力对齐（方向）

### 14.1 目标与边界

- 用户在空间里能做的动作，Agent 都能通过工具完成：发现、空间树、文档正文、评论、版本、
  随想、回收站、空间治理、协作者与附件。
- 浏览器写入与 Agent 写入共用同一条权威链路、同一套事务与守卫；本地权威与自部署服务端行为
  一致。不在此列：未装配的 Workbench、未实现的 hub 事项/旅程/观察；结构操作不做 undo，恢复
  仍靠回收站与版本。

### 14.2 硬约束：归属不可转移

- `creator`、版本作者、评论作者是**写入身份派生**的归属字段，写后不可变；不存在
  transfer/claim/adopt 类入口。UI 的"我创建的 / Alter 创建的"只是该字段的展示分组。
- 四层保证缺一不可：**输入面**不接受归属字段；**边界**不让调用方声明身份——浏览器强制
  用户、Agent 由宿主绑定 `alter`、服务端按已认证请求选择身份；**创建路径**按写入身份派生；
  **持久化守卫**在同一事务校验"新增实体归属等于当前身份、已有实体归属不变"，违反即回滚。
- 不能只靠"没有参数"：现有创建路径把归属写死为用户，一旦补结构能力，Agent 的创建会被记成
  用户。守卫是唯一能覆盖未来新路径的位置。
- 词表统一：实体用 `me | alter`；归档来源用 `user | agent | system`；桥接与审计用
  `user | agent`，在边界一处映射。

### 14.3 现状缺口

- 文档正文能力已完整；发现、结构、评论、版本、随想、回收站、空间治理、协作者、附件都没有
  工具。其中"发现"缺失最阻塞：Agent 拿不到 id 就无法开始。
- 归因目前按方法写死而不是按写入身份派生：节点创建、版本、评论、归档来源、随想搜索结果都有
  字面量；随想没有归属字段；活动事件没有来源；闲置自动归档被呈现为 `agent`。
- 服务端桥接靠逐方法手工带身份，已有遗漏（对象更新），同名问题会随方法增加继续出现。

### 14.4 架构方向

- **一个权威栈，两种入口**：按写入身份分别实例化用户栈与 Agent 栈，浏览器入口与工具入口只选择
  栈、不自带身份参数；文档、内容、版本、评论、归档都从栈取身份，删除写死的归属与"缺省
  `alter`"。
- **持久化层是唯一守卫位置**：同一事务内做归属不变量校验，未来新增写路径不必逐个传身份。
- **应用层收敛**：RPC 与工具调用同一组操作，工作区同步、模式切换、迁移冻结与投影裁剪只有一份
  实现，工具只做薄适配。
- **服务端模式**：请求级身份选栈；读写端点分类补齐；结构写成功后失效读缓存；离线结构写与
  浏览器一致地明确失败，不为结构写新增排队；迁移冻结期间工具同样只读。
- **工具面形态**：领域工具 + action，避免"一方法一工具"（工具与 schema 预算失控）和"万能 RPC
  工具"（无参数校验、暴露内部实现）。只读工具并发安全且有投影裁剪，写工具原子并带 CAS/幂等，
  破坏性操作（清空回收站、删除空间、删除评论）走审批。用能力台账测试约束服务方法、UI 与工具
  三者不漂移。

### 14.5 数据模型缺口

- 随想需要归属字段（历史数据回填为用户）。
- 归档来源新增 `system`：闲置自动归档是系统行为，不应显示为用户或 Alter；历史数据可回填。
- 活动事件需要归属来源，避免继续从节点归属反推；系统事件与 Agent 事件分开呈现。

### 14.6 分期

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 归因地基 | 权威栈、持久化守卫、删除写死归属与默认身份、补随想归属/归档来源/活动来源、修桥接遗漏 | 归属矩阵与能力台账测试；桥接身份回归；无新可见工具 |
| P1 发现与空间树 | 列表/搜索/概览/回收站读取；建文件夹、建文档、改名、移动、置顶、归档、删除、恢复 | 用户点名的"建文件夹、移动文件"可用；投影预算 |
| P2 协作 | 评论、版本列表与恢复、随想（含转文档）、附件 | 写入互不覆盖；版本恢复走 CAS |
| P3 治理 | 空间 CRUD/排序/协作者、已实现 hub 配置；破坏性操作审批 | 不可逆操作必有审批；工作区映射不变量 |
| P4 质量 | 创建幂等、可选结构 CAS、活动流、双模式离线与缓存语义、工具预算实测 | 全模式回归；schema 预算不超限 |

### 14.7 待拍板

1. 闲置自动归档是否对外显示为"系统归档"。
2. 是否删除服务方法上的按调用身份参数，统一由权威栈决定。
3. Agent 是否可以改/删/归档"我创建的"文档（默认可以，只要求 `creator` 不变、版本作者为 Alter）。
4. Agent 是否可以新建空间（联动 DSH 工作区）与 AI 协作者。
5. 服务端离线时结构写失败，是否接受与浏览器一致的失败语义。
6. 工具可见范围：对所有 Agent 可见，还是增加配置分域开关（读/写/结构/破坏性）。

## 相关文档

- [specs/agent-doc-tools-v0.md](../specs/agent-doc-tools-v0.md) — 工具契约、预算与裁剪（事实源）
- [specs/document-operations-v0.md](../specs/document-operations-v0.md) — Operations 语义与错误码
- [specs/document-model-v0.md](../specs/document-model-v0.md) — 节点模型、Schema Registry 与投影
- [specs/system-architecture.md](../specs/system-architecture.md) — Host/Client 边界与持久化约束
- [document-content-architecture.md](document-content-architecture.md) — 正文格式与分层架构的取舍
- [research/document-storage-options.md](../research/document-storage-options.md) — 存储格式调研与证据
- [docs/README.md](../README.md) — 文档规则与索引
