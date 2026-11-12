---
type: design
status: active
updated: 2026-11-12
---

# Agent 空间读写方案

这篇方案回答「Agent 怎样发现、读取和写入空间（文档与空间树），为什么用 Host 原生工具，写入如何做到
可归属、可恢复、不互相踩踏」。工具契约与 op 语义以 [specs/agent-tools-v1.md](../specs/agent-tools-v1.md)
和 [specs/document-operations-v0.md](../specs/document-operations-v0.md) 为准；本文件记录决策与理由，
不重复 schema 与逐字段契约。

## 1. 目标与非目标

**目标**

- Agent 能发现并读取空间文档：通过搜索定位文档，按 outline + 范围读 Markdown 投影与元数据。
- Agent 能创建、编辑文档，写入与浏览器走同一权威链路（Host SQLite 单写者队列），刷新后 UI 一致。
  发现与空间树已实现；评论等后续域见 §14 分期。
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
版本记录和事务**。所有写入安全设计（归属、CAS、版本历史）都建立在这一条上：如果工具走 HTTP 回环，
这些保证要么退化成「先查后写」的竞态，要么需要在协议层重新实现一遍事务。

工具面收敛为 `space_doc_outline` / `space_doc_read` / `space_doc_search` / `space_doc_ops` /
`space_doc_patch` / `space_doc_generate` / `space_doc_undo`、对象/资产工具、`space_component_catalog`
与结构工具 `space_browse` / `space_tree`；正文只有 AST 一种格式，正文写入只经 Operations。浏览器侧
写入走同一条链路：文档页经 `@alter-space/document-runtime` 生成 Operations，与 Agent 共用
`doc.applyOps` / `doc.restoreVersion`。完整契约见 [specs/agent-tools-v1.md](../specs/agent-tools-v1.md)。

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
| `space_browse` | 发现先行：空间/树/概览/检索/回收站只投影元数据，绝不回传正文；Agent 拿到 id 才能开始 |
| `space_tree` | 结构写唯一入口：建/改名/移动/置顶/归档/删除/恢复；删除进回收站，恢复不做 undo |

这样划分的目标是**正交且少**：读路径按需扩展；写路径只有「单块文本 patch」「结构化修改」与
「新内容生成」三类意图，都带 block id、baseRevision 与 schema 校验，避免「整篇替换」这类无法给出
稳定 diff、冲突面大的入口。

## 3. 写入安全三件套

| 机制 | 解决的问题 | 现行做法 |
| --- | --- | --- |
| **归属** | vendor 把创建/版本/评论作者硬编码为 `'me'`，Agent 写入会冒充用户 | 归属由写入身份派生：浏览器与 Agent 各走 user/alter 权威栈，入口只选栈、不信任请求体 actor；持久化守卫同事务校验归属不变量（§14.2） |
| **CAS** | Agent 与用户可能基于旧内容互相覆盖 | 读结果返回 revision，写操作必须回传 base；门禁放在**同一个 store 事务内**复核，不是先查后写 |
| **版本历史** | 被覆盖的内容需要有历史可恢复 | 写入在同一事务记录版本（作者随 actor）；用户写入受 5 分钟节流，Agent 写入强制记录；均受条数/字节裁剪 |

要点与理由：

- **CAS 必须在事务内**：队列里可能已有浏览器保存或另一 Agent 调用排队，事务外预检查读到的是旧内存
  （TOCTOU）；只有和事务提交对齐，冲突才真正「不落盘」。
- **冲突不自动 merge**：返回当前 revision 与可操作提示，让模型重新读取后重试；自动合并会把
  两个来源的语义差异藏起来。
- **归属只对 Agent 写入生效**：浏览器写入强制为用户，避免把用户操作误标为 Alter。
- 三件套缺一不可：归属回答「是谁写的」，CAS 回答「基于哪个版本写的」，版本历史回答「写错了能否回退」。
- **强制版本**：Agent 写入落在节流窗口内未产生版本时，同一事务补记一条 `'alter'` 版本，保证每次
  Agent 写入可恢复；这是默认不弹审批（§6）的底气之一。

## 4. 读侧预算与上下文

- **先结构后正文**：`outline` 建立全局认知，再按 block/范围读；列表与搜索只投影元数据与块级命中，
  绝不返回全量正文。
- **预算写死**（数值见 spec，不在本篇复述）：outline 为结构摘要，单次读默认 12k / 最大 40k 字符；
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
  版本历史（每篇 10 版可调，Agent 写入强制记录、不受节流）、op log 撤销、每日整库快照。
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
  而非数据安全；数据安全已由 CAS、版本历史与快照覆盖。

## 10. 实施阶段与工具面现状

- 已实现 15 个工具：11 个文档工具（契约见 [spec](../specs/agent-tools-v1.md) §3）、结构工具
  `space_browse` / `space_tree`（发现与空间树），控制面 `space_settings` / `space_migrate`。
- 能力台账（`host/authority/capabilities.ts`）逐端点声明 Agent 暴露面，parity 门禁强制白名单、
  读写分类、浏览器映射与工具注册四处一致；新操作必须同变更声明暴露或排除。
- 浏览器实时同步（§9）仍不做；评论/版本/随想工具与协作者权限映射未做，按需再排（§14 分期）。
- 工具 schema 成本靠精简 description 与字节棘轮控制，不增加每轮 system prompt 段。

## 11. Top 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 用户旧草稿覆盖 Agent 写入 | 保存被 CAS 拒绝，用户需重试 | 浏览器保存带 CAS，冲突时保留编辑面内容；版本历史 + 快照兜底 |
| Agent 覆盖用户正在编辑的内容 | 用户草稿丢失 | Agent 侧 CAS：过期 base 拒绝，不自动 merge |
| 注入/恶意内容进入正文 | 面板渲染异常、脚本执行 | schema 校验 + 编辑器粘贴过滤 + 组件目录 fail-closed（无任意代码） |
| 工具对所有 Agent（含子 Agent）可见 | 任意 Agent 都能写空间 | 配置门禁；后续按 preset 或插件作用域收窄 |
| `vendor` 同步后行为漂移 | 依赖字段/行为变化导致归属/CAS 失效 | 升级 vendor 后跑工具与写作用域测试；依赖面尽量收敛 |
| 版本历史被裁剪 | 久远内容无法从历史恢复 | 调高版本上限（建议 20–30）；长期恢复依赖每日快照 |
| 无实时刷新，用户看到旧内容 | 误以为 Agent 没写 | 工具返回明确结果；重新进入/刷新即更新 |
| 多窗口/多 Host last-writer-wins | 跨进程覆盖 | 文档化已知边界；CAS 只在进程内有效 |
| 工具注册被 effect 生命周期吞掉 | 工具静默不可用，AI 感知不到能力缺失 | 注册与清理分离（effect 回调**返回** teardown，不在 attach 内 dispose）；apply 测试断言完整工具清单含控制面工具 |

## 12. 验收口径

验收项、状态标记与证据见 [Agent 文档工具验收](../acceptance/s0-document-tools.md) 与
[能力对齐验收](../acceptance/s1-capability-alignment.md)；质量基线（成功率、调用次数、性能）见
[spec §7](../specs/agent-tools-v1.md)，本篇不重复。

## 13. 实现期约束（工具注册与事务）

工具注册与事务的硬约束（可见范围、手写校验、单写者回调、失败可操作）已下沉到
[spec §1](../specs/agent-tools-v1.md)，本篇不重复。

## 14. 全量能力对齐（决策与方向）

### 14.1 目标与边界

- 用户在空间里能做的动作，Agent 都能通过工具完成。发现与空间树已落地（P0/P1）；评论、版本、
  随想、附件、空间治理、协作者与 hub 仍是方向（§14.5 分期）。
- 浏览器写入与 Agent 写入共用同一条权威链路、同一套事务与守卫；本地权威与自部署服务端行为一致。
  不在此列：未装配的 Workbench、未实现的 hub 事项/旅程/观察；结构操作不做 undo，恢复靠回收站与版本。

### 14.2 硬约束：归属不可转移（已落地）

- `creator`、版本作者、评论作者是**写入身份派生**的归属字段，写后不可变；不存在 transfer/claim/adopt
  类入口。UI 的"我创建的 / Alter 创建的"只是该字段的展示分组：树视图按分组过滤时不匹配的父级
  不占行，匹配节点挂到最近的可见祖先（没有则为根），否则 Agent 建在用户文件夹里的文档会在两个
  分组的树视图里都消失。
- 四层保证缺一不可：**输入面**不接受归属字段；**边界**只选栈——浏览器强制用户栈、Agent 绑定
  `alter` 栈、服务端按已认证标记选栈；**创建路径**按写入身份派生；**持久化守卫**在同一事务校验
  "新增实体归属等于当前身份、已有实体归属不变"，违反即回滚。
- 守卫是唯一能覆盖未来新路径的位置：只靠"没有参数"挡不住写死归属的创建路径，补结构能力时
  Agent 的创建会被记成用户。
- 词表统一：实体用 `me | alter`；归档与事件来源用 `user | agent | system`；桥接与审计用
  `user | alter`，在边界一处映射。

### 14.3 架构决策（已采纳）

- **一个权威栈，两种入口**：按写入身份实例化用户栈与 Agent 栈，入口只选栈、不自带身份参数；
  文档、内容、版本、评论、归档都从栈取身份，写死归属与"缺省 `alter`"已删除。
- **持久化层是唯一守卫位置**：未来新增写路径不必逐个传身份。
- **应用层收敛**：RPC 与工具调用同一组栈服务方法，工具只做薄适配。空间 CRUD 这类联动 DSH 工作区
  的操作在 P3 暴露时必须与浏览器走同一应用路径（workspace 桥接），不得直连服务绕过不变量。
- **服务端模式**：请求级身份选栈；结构写离线时与浏览器一致地明确失败，不新增排队；迁移冻结期间
  工具同样只读；结构写成功后失效读缓存。
- **工具面形态**：领域工具 + action，避免"一方法一工具"（schema 预算失控）和"万能 RPC 工具"
  （无参数校验、暴露内部实现）。读工具并发安全且有投影裁剪，写工具原子；破坏性操作
  （清空回收站、删除空间、恢复版本、删除评论）在 P2/P3 落地时必须接审批。
- **对齐机制**：能力台账是操作面单一事实源，parity 门禁强制四处一致；"暴露/排除"决策在开发时
  显式做出，而不是事后补工具。契约见 [spec §2](../specs/agent-tools-v1.md)。

### 14.4 数据模型决策（已落地）

- 随想带 `creator`（历史数据回填为用户）；归档来源新增 `system`（闲置自动归档是系统行为，
  不显示为用户或 Alter）；活动事件带来源，不再从节点归属反推。
- Agent 写入强制版本（§3），补上节流窗口的可恢复性缺口。

### 14.5 分期

| 阶段 | 内容 | 状态 / 验收 |
| --- | --- | --- |
| P0 归因地基 | 权威栈、持久化守卫、归属派生、随想/归档/事件来源、桥接身份 | 已落地；[s1 验收](../acceptance/s1-capability-alignment.md) |
| P1 发现与空间树 | browse（列表/检索/概览/回收站读）、tree（建/改名/移动/置顶/归档/删除/恢复） | 已落地；同上 |
| P2 协作 | 评论、版本列表与恢复、随想（含转文档）、附件 | 写入互不覆盖；版本恢复走 CAS + 审批 |
| P3 治理 | 空间 CRUD/排序/协作者、已实现 hub 配置；破坏性操作审批 | 不可逆操作必有审批；工作区映射不变量 |
| P4 质量 | 创建幂等、可选结构 CAS、活动流、双模式离线与缓存语义、工具预算实测 | 全模式回归；schema 预算不超限 |

### 14.6 待拍板

1. Agent 是否可以新建空间（联动 DSH 工作区）与 AI 协作者（P3 暴露前必须拍板）。
2. 工具可见范围：当前为配置门禁（`documentTools` / `spaceTools` / 写策略）；是否细化分域开关
   （读/写/结构/破坏性）或按 preset 收窄。

原待拍板项中的权威栈、系统归档、Agent 编辑用户文档、离线失败语义、强制版本均已采纳
（§14.2–14.4）；工具契约层面的开放项见 [spec §8](../specs/agent-tools-v1.md)。

## 相关文档

- [specs/agent-tools-v1.md](../specs/agent-tools-v1.md) — 工具契约、能力台账与预算（事实源）
- [specs/document-operations-v0.md](../specs/document-operations-v0.md) — Operations 语义与错误码
- [specs/document-model-v0.md](../specs/document-model-v0.md) — 节点模型、Schema Registry 与投影
- [specs/system-architecture.md](../specs/system-architecture.md) — Host/Client 边界与持久化约束
- [document-content-architecture.md](document-content-architecture.md) — 正文格式与分层架构的取舍
- [research/document-storage-options.md](../research/document-storage-options.md) — 存储格式调研与证据
- [docs/README.md](../README.md) — 文档规则与索引
