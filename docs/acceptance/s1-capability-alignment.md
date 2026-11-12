---
type: acceptance
status: active
updated: 2026-11-12
---

# 能力对齐 P0/P1 验收

验收对象：P0 归因地基（权威栈、持久化守卫、归属派生、桥接身份）、P1 发现与空间树工具
（`space_browse` / `space_tree`）、能力台账 parity 门禁。契约见
[agent-tools-v1.md](../specs/agent-tools-v1.md)，决策见
[Agent 空间读写方案](../designs/agent-doc-tools.md) §14。

口径：`[x]` 自动化覆盖；`[~]` 已实现、依赖运行时未联调；`[ ]` 未做。
自动化入口：`tests/integration/contract/`（台账门禁）、`tests/integration/host/`（工具与归属）、
`tests/integration/persistence/`（守卫）、`tests/integration/remote/` 与 `tests/integration/server/`
（桥接与双模式）。

## P0 归因地基

- [x] 归属矩阵：user/alter 双栈 × 建节点/随想/评论/补充/版本/转文档/归档/hub 事件，
  creator/author/archivedBy/source 全部按写入身份派生（hub 无生产创建点，守卫经种子覆盖）。
- [x] 持久化守卫：新建错误归属实体、篡改已有归属 → 同事务拒绝，内存与磁盘均未变。
- [x] 闲置自动归档来源为 `system`（两个栈触发均一致）。
- [x] 历史数据回填：旧随想补 `creator='me'`，旧事件补 `source='agent'`。
- [x] 强制版本：alter 节流窗口内连续两写产生多个 `alter` 版本；user 写入保持节流；裁剪仍生效。
- [x] 桥接盖章覆盖全部端点（含读，信封权威）；浏览器请求体与 inline 冒充 `alter` 无效（e2e 回归）。
- [x] 服务端按盖章选栈；离线结构写明确失败（`remote/unavailable`）、不排队，读走缓存。
- [x] 迁移冻结期工具只读：7 个结构写动作全部拒绝 `migration/read-only`，读放行，解冻恢复。

## P1 发现与空间树

- [x] `space_browse` 八个 action 可用；输出只含元数据投影，递归断言无正文、正文标记不出现。
- [x] 投影预算：tree ≤ 500 节点带 truncated/total；search 默认 20 / 上限 50、excerpt ≤ 60 字；
  overview recent_docs ≤ 10、events ≤ 20、tasks/milestones ≤ 20；trash 预览 ≤ 80 字。
- [x] `space_tree` 七个 action 可用；「建文件夹→其下建 note→移动→改名→置顶→归档→删除→恢复」双模式通过。
- [x] 归属：新建 `creator='alter'`、归档 `archivedBy='agent'`；user 节点经工具改名/移动后 `creator` 不变。
- [x] 双入口一致：同一操作经工具与经浏览器 RPC 的状态变化（含 order）一致、仅归属不同。
- [x] 读路径不 `recordOpen`、不改变活动度与未读。
- [x] 双模式：本地真 SQLite 与真服务端 harness 均通过；服务端离线时结构写 `remote/unavailable`。

## 台账与门禁

- [x] 台账覆盖全部端点；白名单、读写分类、浏览器映射、工具注册四处一致（parity 测试进 `pnpm check`）。
- [x] schema 字节棘轮生效（15 工具实测 7718 / 上限 7800），spec §6 同步。
- [x] 新操作同变更声明暴露面（AGENTS.md 硬约束）。
- [x] 工具注册不被 effect 生命周期吞掉：apply 测试断言完整工具清单含 `space_settings` / `space_migrate`。

## 数据安全门禁（2026-11-12 决策落地）

- [x] 别人更新了同一篇文档：页面原地换正文，编辑面、撤销栈与光标保留；换正文本身不触发保存，
  下一次编辑基于新内容（`tests/ui/document/page/view.test.ts`）。
- [x] 版本恢复：恢复前自动留一份「恢复前」版本且不受裁剪；最小历史配额下仍可撤销这次恢复
  （`tests/integration/document/service.test.ts`）。
- [x] 大文档恢复：整篇 3000+ 块的文档一次性恢复，撤销点（两份大正文）超出单篇历史字节预算时仍保留。
- [x] 浏览是纯读：`space_browse` 的 tree/node/overview 不再写库；闲置归档由定时 sweep 负责，
  两个身份栈触发都记 `archivedBy='system'`（`tests/integration/host/service.test.ts`、
  `tests/integration/persistence/attribution.test.ts`）。
- [x] 删除空间前强制快照；快照失败则取消删除并返回 `space/snapshot-failed`
  （`tests/integration/host/rpc.test.ts`）。
- [x] 冲突中的文档不被 `flush()` 静默重发：标题失焦、切换文档只写草稿，等待用户决策
  （`tests/ui/document/runtime/save.test.ts`）。

## 人工验证（交用户 Review）

- [ ] 浏览器「我创建的 / Alter 创建的」分组：Agent 经工具创建的节点/随想显示为 Alter。
- [ ] 闲置自动归档在 UI 呈现为系统归档，不再显示为用户或 Alter。
- [ ] Agent 写入后重新进入文档/空间，UI 数据与工具结果一致。