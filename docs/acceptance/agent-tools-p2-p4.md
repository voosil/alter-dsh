---
type: acceptance
status: active
updated: 2026-11-12
---

# Agent 空间工具 P2–P4 验收

验收对象：在 P1 之后补齐的领域工具——评论、版本历史、随想、空间治理、协作者与目录、hub 已实现
部分、文件资产导入，以及 `space_settings` 的 `estimate/queue/resolve` 扩展。契约见
[agent-tools-p2-p4.md](../specs/agent-tools-p2-p4.md)，台账见 `host/authority/capabilities.ts`。

口径：`[x]` 自动化覆盖；`[~]` 已实现、依赖运行时未联调；`[ ]` 未做。
自动化入口：`tests/integration/host/`（领域工具与 alter 端点 seam）、
`tests/integration/control/agent-settings-tool.test.ts`、`tests/integration/contract/agent-surface.test.ts`
（台账 parity 与 schema 预算）、`tests/integration/remote/`（服务端模式）。

## P2 协作

- [x] `space_comments` 六个 action 可用：list/add/update/supplement/delete/resolve；新建评论
  `author='alter'`，list 返回三态（含墓碑）且正文裁剪有界。
- [x] 评论删除是软删墓碑（`status='deleted'`），须审批；审批拒绝或无审批服务时删除不执行。
- [x] `space_versions` 的 list 不回传正文、≤ 30 条；restore 走 `doc.restoreVersion`（CAS +
  恢复前版本），须审批，拒绝时不改正文。
- [x] `space_thoughts` 八个 action 可用；`creator='alter'`；跨空间 move 与 convert（随想转文档）通过。
- [x] 文件资产导入 `space_import_file` 可用（base64 + mime + name?），返回 asset id 与字节数；
  图片仍走 `space_asset_import`。

## P3 治理

- [x] `space_governance` 七个 action 可用：建空间/改名/归档/取消归档/重排/删除空间/清空回收站。
- [x] `delete_space` 与 `empty_trash` 须审批；审批拒绝时不执行；删除空间前的恢复点快照在路由层
  （见 [s1 验收](s1-capability-alignment.md) 数据安全门禁）。
- [x] `space_collaborators` 可用：list_agents / create_agent / list_directories（目录条目 ≤ 100）。
- [x] `space_hub` 只暴露 4 个已实现 action（get/summarize/set_policy/set_plugin_enabled）；
  11 个 DEP-002 未实现端点保持排除，台账理由为「服务未实现」。
- [x] required 内置插件不可禁用（`overview`/`config`）。

## P4 质量与控制面

- [x] `space_settings` 新增 estimate/queue/resolve：estimate 返回策略与占用估算；本地模式 queue 为空、
  resolve 明确报错；resolve 在迁移冻结期返回 `migration/read-only`。
- [x] alter 端点 seam：本地与真实服务端两种模式都能按 alter 身份读写，未知端点映射为
  `space/not-found`（`tests/integration/host/agent-rpc.test.ts`）。
- [x] 迁移冻结期新写入被 Host 代理拒绝（`migration/read-only`），读放行。

## 台账与门禁

- [x] 34 个原排除端点翻转为工具映射；剩余 15 个端点保留带理由的排除（2 个不变量例外、1 个 legacy
  恢复、1 个内部清理、11 个 DEP-002 占位）。
- [x] parity 门禁：台账 ↔ RPC 白名单 ↔ 读写分类 ↔ 工具注册（工具名、action 枚举）四处一致。
- [x] schema 字节棘轮覆盖 22 个工具 + 2 个无端点工具；上限调整同步 spec §11 与
  [agent-tools-v1.md](../specs/agent-tools-v1.md) §6。
- [x] 读分类不变：新增读端点（评论/版本/随想/协作者/目录/hub.get/estimate）仍在 READ_ENDPOINTS，
  服务端离线走缓存、迁移冻结期可读。

## 人工验证（交用户 Review，可选）

- [ ] 在真实客户端里让 Agent 建一条评论、回一条补充、确认「Alter 创建」的归属与文档历史面板一致。
- [ ] 让 Agent 归档/恢复一条随想、把一个空间改名，确认浏览器侧状态与工具返回一致。