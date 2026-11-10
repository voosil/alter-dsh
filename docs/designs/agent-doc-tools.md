---
type: design
status: active
updated: 2026-11-10
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
  （列表/发现工具与评论工具在后续阶段；首期工具面见 spec。）
- 写入可归属（`alter`）、可审计（revision/op log）、可恢复（版本与快照）；冲突不静默覆盖。
- 保持插件自包含：Host 不新增网络链路与 `@deepseek-ai/*` 运行时依赖，第三方库打进客户端 bundle。

**非目标（首期）**

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

工具面按 spec v0 收敛为 `space_doc_outline` / `space_doc_read` / `space_doc_search` /
`space_doc_ops` / `space_doc_generate` 与对象/资产工具；正文只有 AST 一种格式，正文写入只经 Operations。
完整契约见 [specs/agent-doc-tools-v0.md](../specs/agent-doc-tools-v0.md)。

工具划分的设计取舍：

| 工具 | 设计要点 |
| --- | --- |
| `space_doc_outline` | 先给结构摘要与 block id，不返回正文；模型据此决定读哪里、改哪里 |
| `space_doc_read` | 按 block/范围投影 Markdown，带锚点与续读位置；不做「读整篇再让模型自己找」 |
| `space_doc_search` | 返回块级命中，让长文档不必全文读取；跨文档查找也走它 |
| `space_doc_ops` | 唯一的结构修改入口；带 baseRevision、幂等键、dry-run 与逐 op 错误 |
| `space_doc_generate` | 只生成新内容（新文档或明确位置插入），Markdown 解析失败即报错 |
| 对象/资产工具 | 富对象 payload 与二进制不进正文；按 registry 能力声明决定可否读写 |

这样划分的目标是**正交且少**：读路径按需扩展，写路径只有「结构化修改」与「新内容生成」两种意图，
避免出现「整篇替换」「按字符串精确替换」这类无法校验、冲突面大的入口。

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
- 首期用插件配置门禁（`agentTools.enabled` + `writeApproval` + 只读开关）并只暴露安全操作：
  不做硬删除、不做跨空间批量。这是单用户桌面产品的合理信任边界。
- 无论是否启用权限映射，工具参数中的 `space_id`/`doc_id` 都要做存在性与一致性校验，不信任模型输入；
  由 `doc_id` 反查空间，而不是相信模型传的 `space_id`。
- 后续（P3）可选：插件配置 `actingCollaboratorId` 或 preset→collaborator 映射，写前校验空间成员
  与能力，缺省 fail-closed；默认空间 `sp-inbox` 无协作者，需显式绑定后才允许写。

## 8. 幂等与重试

- 写工具不做自动重试；`space_doc_ops` 带 `idempotency_key`，重复请求返回原结果，天然适合模型超时重放。
- CAS 让重放变为冲突而不是重复写入；`dry_run` 不落盘，可安全预览。
- 创建文档首期没有幂等键：超时或模型重试可能重复建文档，接受这个风险（返回明确 id，模型重试前先
  list/search）；后续可加 `client_request_id` 去重表或「同空间同标题 + 短时间窗 + creator=alter」启发式。
- 写后回读：返回值基于本次计算与回读，避免 vendor 内部 clone 出来的旧作者字段泄漏到工具结果。

## 9. 浏览器同步：首期不做

**决策**：Agent 写入后不主动推送或刷新已打开的浏览器面板；产品目前不是协作产品，不需要「Agent 写完
面板立刻变」。

- **何时能看到**：重新进入文档、切换空间、切走面板再回来，或刷新页面时 `SpaceApp` 会重新拉取数据，
  不需要改客户端代码。
- **仍保留 Agent 侧 CAS**：Agent 不会覆盖用户两秒前刚保存的内容；过期 base 直接失败并让模型重读。
- **接受的取舍**：用户旧草稿保存时可能覆盖 Agent 写入，不做拦截，靠强制版本 + 每日快照恢复。
- **后续可选（需要时再设计）**：浏览器保存 CAS + 冲突横幅、revision 轮询 + 软刷新。DSH 原生
  Host→Client 推送对第三方插件不可用（构建期 allowlist），自建 SSE 成本高，均不占首期工期。
- **为什么现在不做**：实时同步要连带解决保存冲突 UI、客户端依赖数组失效与多窗口语义，收益是「协作感」
  而非数据安全；数据安全已由 CAS、强制版本与快照覆盖。后续需要时再加，不影响首期架构。

## 10. 分阶段与工作量

当前优先级是先用最小垂直切片验证架构，再实现工具面：

| 阶段 | 内容 | 交付/验收 | 预估 |
| --- | --- | --- | --- |
| **v0 垂直切片** | Host Document Service + 旁表；最小 Tiptap 读写；outline/read/ops/generate 四个工具 | 按 [spike 验收标准](../specs/agent-doc-tools-v0.md#4-spike-验收标准) 的 10 篇文档 × 6 类任务验收（成功率 ≥90%、≤4 次调用、读投影 ≤12k tokens） | 3–5 人日 |
| **P0 只读工具** | 搜索/outline/read + 截断投影 + 测试 | 只读工具可上线验证工具面，无写入风险 | 1–1.5 人日 |
| **P1 基础写入** | 写作用域（归属/CAS/强制版本）+ ops/generate + 配置 + 测试 | 写入归属、冲突不落盘、可恢复；浏览器保存仍为原语义 | 2–2.5 人日 |
| **P2 同步与防覆盖（可选）** | 浏览器保存 CAS + 冲突横幅；revision 轮询 + 软刷新 | 旧草稿被拦截；面板接近实时 | 1.5–2 人日 |
| **P3 扩展（可选）** | 列表/评论工具、组织/历史管理、协作者权限映射、按 preset 可见性 | 权限 fail-closed；更多文档管理能力 | 1.5–2.5 人日 |

当前只承诺 v0 垂直切片：先用它验证「AST 权威 + Markdown 投影 + Operations」能否支撑真实 AI 编辑
任务（通过标准见 [spike 验收标准](../specs/agent-doc-tools-v0.md#4-spike-验收标准)），通过后再实现 P0/P1 工具面（合计约
3–4 人日），最后按需排 P2/P3。工具 schema 首 token 成本约 +1.2–1.6k tokens，靠精简 description、
不增加每轮 system prompt 段来控制。

## 11. Top 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 用户旧草稿覆盖 Agent 写入 | Agent 内容被覆盖（非实时，刷新才可见） | 强制版本 + 每日快照可恢复；首期不做浏览器拦截（已接受） |
| Agent 覆盖用户正在编辑的内容 | 用户草稿丢失 | Agent 侧 CAS：过期 base 拒绝，不自动 merge |
| 注入/恶意内容进入正文 | 面板渲染异常、脚本执行 | schema 校验 + 编辑器粘贴清洗 + 组件沙箱 |
| 工具对所有 Agent（含子 Agent）可见 | 任意 Agent 都能写空间 | 配置门禁；后续按 preset 或插件作用域收窄 |
| `vendor` 同步后行为漂移 | 依赖字段/行为变化导致归属/CAS 失效 | 升级 vendor 后跑工具与写作用域测试；依赖面尽量收敛 |
| 版本历史被裁剪 | 久远内容无法从历史恢复 | 调高版本上限（建议 20–30）；长期恢复依赖每日快照 |
| 首期无实时刷新，用户看到旧内容 | 误以为 Agent 没写 | 工具返回明确结果；重新进入/刷新即更新 |
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
| A9 | 上下文预算 | 工具 schema 首轮约 +1.2–1.6k tokens；单次读投影 ≤12k tokens / ≤40k 字符 |
| A10 | 原子与撤销 | 批量 ops 全有或全无；一次 apply 可撤销，op log 可还原 |

完整契约与 spike 验收标准见 [specs/agent-doc-tools-v0.md](../specs/agent-doc-tools-v0.md)
与 [specs/document-model-v0.md](../specs/document-model-v0.md)。

## 13. 实现期约束（工具注册与事务）

- 工具对所有 Agent（含子 Agent）可见，插件配置门禁是唯一范围控制；后续按 preset 或插件作用域收窄。
- DSH 工具框架只做 JSON 解析，参数校验与错误映射必须在工具实现内手写，错误用稳定错误码字符串返回。
- 写作用域必须在 `store.update` 回调内完成；不要在该回调内 await 同一个 store 的其他更新
  （单写者队列会自锁）。
- 失败要可操作：冲突时返回当前 revision，让模型重读后重试；不允许部分成功却不报错。

## 相关文档

- [specs/agent-doc-tools-v0.md](../specs/agent-doc-tools-v0.md) — 工具契约、预算与裁剪（事实源）
- [specs/document-operations-v0.md](../specs/document-operations-v0.md) — Operations 语义与错误码
- [specs/document-model-v0.md](../specs/document-model-v0.md) — 节点模型、Schema Registry 与投影
- [specs/system-architecture.md](../specs/system-architecture.md) — Host/Client 边界与持久化约束
- [document-content-architecture.md](document-content-architecture.md) — 正文格式与分层架构的取舍
- [research/document-storage-options.md](../research/document-storage-options.md) — 存储格式调研与证据
- [docs/README.md](../README.md) — 文档规则与索引
