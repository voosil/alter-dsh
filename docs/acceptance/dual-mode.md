---
type: acceptance
status: draft
updated: 2026-11-11
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
- [x] 未带 token、错误 token、错误方法、未知路径分别返回 401/405/404；RPC 与 asset 路由鉴权后可用。
- [x] 命名 token 解析、重复/过短 token 拒绝、端口/env 校验有单测。
- [x] Dockerfile 构建 Host 面并只复制 `lib/` 运行；compose 使用数据卷与环境变量。

## C. 模式切换与设置面

- [x] 设置页「服务器」区支持模式、URL、token、连接测试与队列状态；token 只显示已配置。
- [x] 保存服务端配置后热切换后端，不重启 DSH；切换失败/配置非法时保留旧后端并回滚已落盘配置。
- [x] 服务端模式下禁用本机原生目录选择；目录浏览走远端 `listDirectories`，并支持手工输入路径。
- [x] `settings.*`、`sync.*`、`migration.*` 有 Host 白名单与客户端映射，单测覆盖。
- [ ] 桌面端实机：本地模式面板回归 + 切到真实服务端后的读写/刷新（留待用户界面验收）。

## D. Agent 配置与审计

- [x] `space_settings` 工具可读取状态、测试连接、切换模式、flush 队列。
- [x] 修改服务器目标/token 必须经审批；无审批服务时失败关闭；用户拒绝后不落盘。
- [x] 变更写入 `connection-audit.jsonl`，不包含 token 明文。
- [x] Agent 工具经 bridge 发往服务端的文档写（applyOps/generate/undo/updateObject）均携带 `alter`；
  对象更新的 provenance 与版本作者记为 Alter，不回退成用户（bridge 回归用例覆盖）。
- [x] 随仓库提供 `space-server-deploy` skill 与设置页「复制 AI 配置指令」。

## E. 弱网连续编辑

- [x] 读缓存：列表/文档读在服务端离线时回落缓存；content-addressed 资产可离线读取。
- [x] 写队列：文档 applyOps 在传输失败时落盘并乐观应用，返回本地 revision；重连后按基线 revision 重放。
- [~] 冲突：服务端 revision 不匹配时标记冲突、保留本地内容、不自动覆盖；设置页可见计数，**逐条处置（重试/丢弃）尚无入口**。
- [x] 队列先落盘再向界面确认；浏览器只保留旧编辑面的崩溃草稿缓冲区。

## F. 数据迁移

- [x] 本地 → 服务端：资产预拷贝 + drain 后一致性快照 + 增量资产 + 服务端校验（part sha256、quick_check、schema 版本、逐表行数、文件数）/替换/备份。
- [x] 服务端 → 本地：导出快照、分块下载、整包 sha256、结构版本/行数/文件数校验、备份本地后替换；存在未同步写入时拒绝迁移。
- [~] 目标非空时拒绝覆盖，需显式确认；`trimHistory` 只保留每篇文档最新版本（迁移用例尚未断言 versions 行数）。
- [x] 迁移冻结期间只读（含 Agent 工具写门与在途写 drain），控制面仍可用；失败/取消不改变当前权威模式。
- [x] 设置页迁移向导、`pnpm migrate` CLI、`space_migrate` Agent 工具共用同一传输实现。

## G. 文档与发布

- [x] spec/design/acceptance/README 与实现同变更；`pnpm docs:check` 通过。
- [x] `pnpm check` 全绿（build + verify + docs:check + typecheck + 全量测试）。
- [~] `docker compose config` 通过（含 token/env 注入）；`docker build --check` 需在普通终端复跑确认（本机 buildx 权限受限）。
- [x] Docker 镜像完整构建：`docker build` 成功（250 MB），容器启动后 `healthy`；`/healthz`、`/version`、未授权 401、授权 RPC 与每日快照均在容器内实测通过。
- [ ] 桌面实机端到端：按本清单 A–F 在 DSH Desktop 上人工复核（UX 视觉项交用户 Review）。
