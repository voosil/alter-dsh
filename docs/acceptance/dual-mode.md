---
type: acceptance
status: draft
updated: 2026-11-12
---

# 双模式（本地 / 自部署服务端）验收清单

验收对象：本地权威、独立服务端、本地 bridge、设置与 Agent 配置、双向迁移。设计理由见
[空间部署形态](../designs/space-deployment-modes.md)，契约以
[系统架构与持久化约束](../specs/system-architecture.md) 为准。

## A. 本地模式回归

- [x] 全量测试全绿（`pnpm test`）；本地读写、工作区映射、版本历史与快照行为不变。
- [x] 插件启动后默认本地模式；未配置服务端时 `/api/alter-space` 行为与改造前一致。
- [x] 本地数据目录与 `space.db` 位置不变。

## B. 独立服务端

- [x] `server` 入口可在 Node 24 下独立启动；`/healthz`、`/version` 返回产品与协议/结构版本。
- [x] 未带 token、错误 token、错误方法、未知路径分别返回 401/405/404；RPC、asset 与 `/migrate/*` 路由鉴权后可用。
- [x] 命名 token 解析、重复/过短/占位 token 拒绝、端口/env 校验有单测。
- [x] 替换数据期间业务路由返回 503 `migration_paused`，`/healthz`、`/version` 与迁移端点保持可用；关闭时先排空进行中的迁移提交。
- [x] Dockerfile 构建 Host 面并只复制 `lib/` 运行；compose 使用数据卷、环境变量与 SPACE_PORT 健康检查。

## C. 模式切换与设置面

- [x] 设置页「服务器」区支持模式、URL、token、连接测试与队列状态；token 只显示已配置。
- [x] 保存 URL/token 不切换数据权威，可在迁移前预配置；模式切换必须显式确认放弃当前权威（`discard`），
  服务端模式下更换 URL 且旧队列有未同步写入时也必须显式放弃；切换失败/配置非法时保留旧后端并回滚已落盘配置。
- [x] 服务端模式下禁用本机原生目录选择；目录浏览走远端 `listDirectories`，并支持手工输入路径。
- [x] `settings.*`、`sync.*`、`migration.*` 白名单、读写分类与客户端映射三处一致；control 端点双向 parity 与
  client 映射单测覆盖。未知端点不得被判为只读。
- [ ] 桌面端实机：本地模式面板回归 + 切到真实服务端后的读写/刷新（留待用户界面验收）。

## D. Agent 配置与审计

- [x] `space_settings` 工具可读取状态、测试连接、切换模式、flush 队列；set/flush 与设置页共用同一
  `applyConnectionPatch`，不再绕过模式/迁移守卫。
- [x] 任何有效的 mode/URL/token 变更都必须经审批（含切回本地）；无审批服务时失败关闭；用户拒绝后不落盘。
- [x] 变更写入 `connection-audit.jsonl`，不包含 token 明文；审计区分 mode/server/token 并记录 `tokenChanged`。
- [x] Agent 工具经 bridge 发往服务端的文档写（applyOps/generate/undo/updateObject）均携带 `alter`；
  浏览器请求体不能伪造 actor；对象更新的 provenance 与版本作者记为 Alter（bridge 回归用例覆盖）。
- [x] 随仓库提供 `space-server-deploy` skill 与设置页「复制 AI 配置指令」。

## E. 弱网连续编辑

- [x] 读缓存：链路离线时列表/文档读立即命中缓存并后台刷新，不再等网络超时；content-addressed 资产优先本地
  缓存；缓存损坏隔离为 `.corrupt-<时间戳>` 后重建，不让插件启动失败。
- [x] 写队列：文档 applyOps 在传输失败时先落盘并乐观应用，返回本地 revision；重连后优先按幂等键重放。
- [x] 冲突：服务端 revision 不匹配时标记冲突、保留本地内容、不自动覆盖；设置页可见计数并提供逐条重试/丢弃入口
  （`sync.resolve`；retry 会按服务端当前 revision 重写 payload 与基线）。
- [x] 队列先落盘再向界面确认；浏览器只保留旧编辑面的崩溃草稿缓冲区。

## F. 数据迁移

- [x] 本地 → 服务端：资产预拷贝 + drain 后一致性快照 + 增量资产 + 提交前服务端校验（part sha256、
  quick_check、schema 版本、逐表计数、文件数）/替换/备份；校验失败目标不变。
- [x] 服务端 → 本地：先冻结再导出快照、分块下载（带重试）、整包 sha256、结构版本/计数/文件数校验、
  备份本地后替换；存在未同步写入时拒绝迁移；`from-server` 必须显式覆盖确认。
- [x] 目标非空时拒绝覆盖，需显式确认；空库判定覆盖 agents/tasks/milestones/hub；`trimHistory` 只保留每篇
  文档最新版本（迁移用例断言行数）。
- [x] 迁移冻结从快照/导出前开始，期间业务只读（含 Agent 工具写门与在途写 drain），控制面仍可用；
  失败/取消不改变当前权威；提交后切换失败会调用服务端 rollback 恢复备份。
- [x] Host 与服务端启动时清扫超过 7 天的 `.migration` 遗留暂存；迁移成功后强制为新库生成一次当日快照。
- [x] 设置页迁移向导、`pnpm migrate` CLI、`space_migrate` Agent 工具共用同一传输实现；CLI 路径、参数、方向、
  未同步写入与 SIGINT 行为有测试。

## G. 文档与发布

- [x] spec/design/acceptance/README 与实现同变更；`pnpm docs:check` 通过。
- [x] `pnpm check` 全绿（build + verify + docs:check + typecheck + 全量测试）。
- [~] `docker compose config` 通过；`docker build --check` 受本机 buildx 权限限制未跑（保留）。
- [x] Docker 镜像完整构建（`DOCKER_BUILDKIT=0 docker build`）成功，容器启动 healthy；`/healthz`、`/version`、
  未授权 401、非 root 用户、`lib/`-only 运行面在容器内实测通过（2026-11-12）。
- [ ] 桌面实机端到端：按本清单 A–F 在 DSH Desktop 上人工复核（UX 视觉项交用户 Review）。
