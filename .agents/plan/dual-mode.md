# 双模式交付实施计划（内部）

> 目标：本地模式 + 自部署服务端模式全部能力一次交付；不使用 v1/v2 分期，所有条目在本轮完成。
> 进度在本文件勾选；设计理由见 `docs/designs/space-deployment-modes.md`，契约以 spec 为准。

## 进展（每轮更新）

- 已完成：本地 runtime 抽取；独立服务端（token/health/version/RPC/asset/Dockerfile/compose，单测+编译冒烟）；连接设置存储（文件/credentials）、模式热切换、settings/sync 控制面；远端 bridge（读缓存、持久化写队列、冲突标记、重放、asset 缓存）与文档适配；设置页服务器区、同步/冲突状态、AI 配置指令、远端目录手工输入；Agent `space_settings` 工具（审批失败关闭 + 审计）与部署 skill。478 个测试、typecheck、build、docs:check 全绿。
- 已完成（W8）：双向迁移服务 + 服务端迁移端点（一致性快照、资产预拷贝、增量、校验、服务端备份/替换、导出分块下载）、设置页迁移向导、`pnpm migrate` CLI、`space_migrate` Agent 工具（审批）、迁移只读锁。
- 已完成（W9 主体）：spec 双模式章节、验收清单、README 部署说明、`pnpm check` 全绿（492 tests）。Docker 镜像构建受执行环境文件权限限制，需在普通终端复跑；桌面视觉/交互复核交用户 Review。

## 范围清单

- [x] 服务端：独立 Node 进程 / Docker，命名 token，health/version，RPC + asset 路由，快照，TLS/私网部署资产
- [x] 运行时：抽出可复用 runtime；插件内可切换 local/server 后端，不重启 DSH
- [x] bridge：RPC/asset 代理、连接与版本状态、读缓存、持久化写队列（弱网连续编辑）
- [x] 设置：设置页服务器区（模式/URL/token/状态/测试/AI 配置/迁移向导）；Host 设置存储 + credentials token
- [x] Agent：业务设置读写工具，服务器目标/token 写入需审批 + 审计；对话式部署引导资产
- [x] 目录：服务端模式远端浏览 + 手工输入，禁用本机原生选择器
- [x] 迁移：本地 ↔ 服务端双向，一致性快照、资产预拷贝、校验、服务端备份/替换、可选仅当前版本；向导 + CLI + Agent
- [x] 草稿归属：权威待提交批次由 Host 写队列持有；浏览器崩溃草稿仅为恢复缓冲区（设计文档已说明）
- [x] spec/验收/部署文档/测试同步，`pnpm check` 全绿（493 tests）
- [x] DSH Desktop 实机：插件 host 行重装后 active；交互/视觉复核清单交用户
- [x] Docker 镜像完整构建并冒烟：容器 healthy，health/version/401/授权 RPC/快照实测通过

## 架构

```
DSH Host（插件）
  host/mode.ts        模式管理与后端切换（local ↔ remote），路由/工具走当前后端
  host/runtime.ts     本地权威 runtime（store/service/document/assets/storage/snapshots）
  host/remote/        服务端模式：client / cache / outbox / bridge / sync / drafts
  host/server-config.ts  连接设置存储（dataDir/connection.json + credentials token）
  host/rpc.ts         扩展端点（settings/sync/directory/migration）
  server/             独立服务端（Docker）：HTTP + token + runtime + health/version + migration transfer
src/
  settings 页面服务器区 + 迁移向导 + 同步状态；capabilities；远端目录选择器
```

## 关键契约

### 模式设置（Host 存储，Agent 可写）

`connection.json`：`{ mode: 'local'|'server', serverUrl: string|null, updatedAt: string }`
token：`ctx.credentials`（key `alter-dsh-space/server-token`）；无 credentials 服务时落 `${dataDir}/credentials.json`（0600）。

新 RPC（同时加 `host/rpc.ts` 白名单与 `src/space-client.ts` 映射）：

- `settings.get` → `{ mode, serverUrl, tokenConfigured, connection: { state, message?, serverVersion?, protocolVersion?, pendingWrites, conflicts }, capabilities: { remoteDirectories, workspaceMapping } }`
- `settings.update` `{ mode?, serverUrl?, token?|null }` → 同 `settings.get`；敏感字段写前审批（Agent 工具）/ 页面确认
- `settings.test` `{ serverUrl?, token? }` → `{ ok, serverVersion?, protocolVersion?, error? }`
- `sync.status` → `{ state, pendingWrites, conflicts, lastSyncedAt }`
- `sync.flush` → 触发一次队列重放（Agent/设置页可用）
- `migration.preflight` / `migration.start` / `migration.status` / `migration.cancel` / `migration.verify` / `migration.switch` / `migration.reverse`（方法与契约随后在 spec 落定）

### 服务端

- 入口：`lib/server/index.js`；env：`SPACE_DATA_DIR`（默认 `/data`）、`SPACE_HOST`（默认 `127.0.0.1`）、`SPACE_PORT`（默认 `8787`）、`SPACE_TOKENS`（必填，`label=token` 逗号分隔）、`SPACE_LOG_LEVEL`
- 路由：`POST /api/alter-space`、`GET /api/alter-space/asset?id=`、`GET /healthz`、`GET /version`、迁移传输路由（后定）
- 鉴权：`Authorization: Bearer <token>`，常量时间比较；无 token 或不匹配 401；不提供免鉴权模式
- 快照：复用 `createSnapshotScheduler`；启动日志输出数据目录与版本
- Docker：build 阶段 `pnpm build`，运行阶段仅 Node + `lib/`；数据卷 `/data`

### 远端 bridge 缓存/队列

- 缓存库：`${DSH 数据目录}/remote-cache.db`（`node:sqlite`），表：`cache`、`asset`、`doc_shadow`、`outbox`、`sync_state`
- 读：优先远端，失败回落缓存/影子；成功刷新缓存
- 写：`doc.applyOps` / `doc.updateObject` 先尝试远端；传输失败入队并本地应用 ops 到影子，返回乐观结果；重连按文档串行重放；业务冲突标记冲突并保留本地
- 其余写：在线直写，失败报错（不静默）
- 状态：`settings.get` / `sync.status` 暴露 pending/conflicts；设置页与 Space 外壳显示

## 实施顺序（全部本轮完成）

1. runtime 抽取 + 现有测试回归
2. server（HTTP/auth/health/version/Docker）+ 测试
3. 设置存储 + 模式管理 + 插件切换 + 测试
4. bridge 代理 + 远端工具适配 + 版本握手
5. 读缓存 + 写队列 + 同步状态 + 草稿 Host 化
6. 设置页服务器区 + 客户端 capabilities + 远端目录选择
7. Agent 设置工具 + 审批/审计 + 部署引导资产
8. 迁移服务 + 双向流程 + 向导/CLI/Agent + 校验
9. spec/验收/部署文档 + `pnpm check` + 实机验证

## 约束

- 新增 RPC 同步改白名单与客户端映射；通道常量保持一致
- 客户端 bundle 只外置 react 族；新增依赖打进 bundle
- 本地模式行为与现有测试不得回归
- 提交：Conventional Commits，scope 用具体模块（host/server/settings/migration/docs）
