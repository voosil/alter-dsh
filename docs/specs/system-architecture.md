---
type: spec
status: active
updated: 2026-11-11
---

# 系统架构与持久化约束

本篇规范约束 Alter-dsh 的分层与数据所有权、传输协议、SQLite 持久化与恢复行为、构建自包含、
空间 ↔ DSH 工作区映射不变量，以及必须接受的已知边界。它是这些约束的实施基准；逐文件职责与
源码说明不在本篇展开。

## 1. 分层与数据所有权

| 层 | 职责 | 数据所有权 |
| --- | --- | --- |
| Host 进程（Cordis 插件，`host/` → `lib/`） | 组合业务服务、注册 RPC/asset 路由、按模式选择本地权威或服务端 bridge | 本地模式下为**唯一权威**；服务端模式下只持有缓存与队列 |
| 服务端（独立 Node/Docker 进程，`server/`） | 打开同一 `LocalSpaceRuntime`，以 bearer token 暴露 RPC/asset/迁移路由与 health/version | 服务端模式下的**唯一权威** |
| 本地 bridge（服务端模式下的 Host 半侧） | 代理 RPC/asset、读缓存、持久化写队列、版本握手 | 仅本地缓存与待同步队列，不是权威 |
| 传输（DSH Connection） | 浏览器鉴权、Host/Origin 校验、RPC 信封转发 | 无状态 |
| 浏览器客户端（`src/` → `client.js`） | 把 `vendor/ui-space` 的 `SpaceApp` 挂到面板，用 RPC 实现 `SpaceService` | 仅内存状态、UI 偏好与崩溃草稿 |

不变量：

- 数据流固定为：`SpaceApp` → 浏览器端 `SpaceService` → RPC → Host 路由 → 业务服务 → SQLite 事务。
  客户端不得绕过该链路读写业务数据。
- 业务数据只存在于 Host 与 SQLite；浏览器 localStorage 只存 UI 偏好，刷新或重开面板后从 Host 重新读取。
- 插件自有数据放 SQLite 侧表（如空间 ↔ 工作区绑定），不写入 `vendor/` 的实体结构。
- 文档页是 `vendor/ui-space` 的旧 UI 1:1 还原（DOM/CSS 冻结）；AST 适配层在 `src/document/editors/legacy`，
  正文仍只经 Document Operations 写入 Host。
- 服务端模式的数据流：`SpaceApp` → Connection → 本地 Host bridge → HTTPS + bearer token → 服务端
  `LocalSpaceRuntime` → SQLite。bridge 的读缓存与写队列只存在于本地数据目录，不能作为权威。
- 模式切换只经显式迁移或显式放弃；两种模式之间不做自动双向同步。
- 本仓库是 Space 协议、业务服务、编辑器、UI 与 Host 的唯一实现源（单仓库、自包含）。
- `vendor/` 是项目自有源码，可以修改但须克制：新增逻辑优先放 `host/`、`src/`；确需改 `vendor/`
  时保持既有行为与约定一致，并在 `vendor/README.md` 的「构建期模块覆盖与别名 / 关键行为约定」中更新。

## 2. 传输协议约束

- 浏览器只能通过 DSH Connection 的精确 Fetch 路由 `POST /api/alter-space` 访问 Host；
  鉴权与 Host/Origin 校验由 Connection 统一完成，Host 路由不重复实现鉴权。
- 服务端模式由本地 bridge 持 bearer token 调用服务端的 `POST /api/alter-space`、
  `GET /api/alter-space/asset` 与 `/api/alter-space/migrate/*`；token 存在 DSH credentials 或
  `0600` 文件，服务端不把网络位置当作身份。服务端 `/healthz` 与 `/version` 公开，其余路由必须鉴权。
- 设置与迁移控制面（`settings.*` / `sync.*` / `migration.*`）始终由 Host 核心处理，即使服务端离线
  仍可读取状态、修改连接配置；其余业务端点交给当前后端。迁移冻结期间，非只读业务端点返回
  `migration/read-only`，控制面保持可用。控制面端点：

| 端点 | 请求 | 结果 |
| --- | --- | --- |
| `settings.get` / `sync.status` | 无 | `{ mode, serverUrl, tokenConfigured, updatedAt, connection, capabilities, sync }` |
| `settings.update` | `{ mode?, serverUrl?, token?: string \| null }` | 同上；落盘后后端切换失败时回滚已保存配置并保留旧后端 |
| `settings.test` | `{ serverUrl?, token? }` | `{ ok, serverVersion?, protocolVersion?, authenticated?, message? }`；未配置的地址不得隐式使用已存 token |
| `sync.flush` | 无 | 触发一次队列重放并返回状态 |
| `sync.queue` | 无 | 每个存在未确认写入的文档一行：`{ docId, state: 'pending' \| 'conflict' \| 'failed', entries, baseRevision, lastError?, updatedAt }` |
| `sync.resolve` | `{ docId, action: 'retry' \| 'discard' }` | `{ resolved, state }`；`retry` 按服务端当前 revision 重新武装该文档的队列并重放（离线时返回 `remote/unavailable`），`discard` 丢弃该文档的本地写入与影子，内容和版本以服务端为准 |
| `migration.preflight/start/status/cancel` | `{ direction: 'to-server' \| 'from-server', overwrite?, trimHistory? }` | 预检或任务状态（`status`、`phase`、`counts`、`backup` 等） |

  迁移进行中拒绝修改服务器配置、切换模式与重放队列（`migration/busy`）。浏览器写入归属 `user`、
  Agent 工具写入归属 `alter`；RPC 边界按入口强制归属，不信任请求体里的 actor。
- 通道常量 `('/api', 'alter-space')` 在 Host 与客户端各有一份，必须保持同步。
- 请求信封 `{ type: 'client-request', rpcId, payload: { op, args } }`；响应信封
  `{ type: 'server-response', rpcId, result: { ok: true, value } }`。业务结果在 `value` 内为
  `{ value }` 或 `{ error: { code, message } }`；HTTP 层只处理信封错误（405/400/500），
  业务失败留在成功响应的 `value` 内。
- **端点白名单**：Host 维护 `space.*` / `hub.*` / `doc.*` / `object.*` / `storage.*` 方法白名单，并
  逐条标注只读或写入；新增端点必须同时加入 Host 白名单与浏览器客户端映射（`host/authority/rpc.ts`、
  `src/client/rpc.ts`，`storage.*` 在 `src/client/storage.ts`），缺一视为未完成。白名单、读写分类与
  浏览器映射三处一致性由 `tests/integration/contract/` 检查，未知端点不得被判为只读。
- 参数与结果校验在 Host 侧执行；错误以稳定 `code` 返回，不在信封层抛裸异常。
- 浏览器不得把业务数据持久化到 localStorage、IndexedDB 等本地存储。
- **文档资产通道**：上传走同一 RPC 通道的 `doc.importAsset` / `doc.importFile`；读取由 Host 另注册
  `GET /api/alter-space/asset?id=…`（Connection 鉴权），图片按内容类型 inline 返回供渲染，其他文件按
  `attachment` 下载。白名单、大小上限与错误码以
  [document-operations-v0.md](document-operations-v0.md) §6.4 为准。

## 3. SQLite 持久化

- **位置**：`${DSH_HOME:-~/.dsh}/data/space/space.db`，可用插件行 `config.dataDir` 覆盖目录；
  文档资产字节在 `<dataDir>/assets/`；每日快照为 `<dataDir>/backups/space-YYYYMMDD.db.gz` +
  `space-YYYYMMDD.assets.tar.gz`（无资产时只生成数据库快照）。
- **介质**：Node 内置 `node:sqlite`，WAL 模式、`synchronous=FULL`、`busy_timeout=5000`。
- **结构**：`PRAGMA user_version` 记录结构版本（当前 v3：v2 的 `workspace_links` 侧表、v3 的
  `document_objects` / `document_assets` / `document_ops` 文档侧表）；每实体一张 `(id, data)` 表存
  JSON，`hub(space_id, data)`，`meta(key, value)` 保存数组顺序与簿记。
  低版本库启动时原地加表升级、业务数据不动；schema 版本高于插件支持时拒绝启动。
- **文档内容**：`SpaceNode.content` 只保存 `alter-doc/1` AST JSON，没有其他正文格式或格式标记；
  新表/新字段只加插件自有侧表并通过 `user_version` 升级，不改 `vendor/` 实体结构。
- **文档组件目录**：声明式组件目录编译在协议包（`vendor/protocol`），是 Host 校验与客户端渲染的
  唯一事实源；文档只保存组件实例引用，不携带也不执行任意代码。Agent 工具面与预算见
  [agent-doc-tools-v0.md](agent-doc-tools-v0.md)。
- **写入**：所有变更进入单写者队列；每笔变更只写「新增/修改/删除的实体行 + 顺序数组 + meta」，
  在一个事务里提交，提交成功才 resolve；失败回滚内存快照并抛错。普通编辑只更新一行，不重写整库。
- **归属与裁剪**：写入路径必须保留实体归属（用户 / AI `alter`），并在同一事务内完成内容写入、
  归属标记与版本裁剪；不得绕过单写者队列直接改库。
- **启动**：打开数据库 → 校验 schema 版本 → `PRAGMA quick_check` → 读入内存；顺带截断上次异常退出
  留下的 WAL，并把 `journal_size_limit` 限制为 16 MiB。
- **版本历史**：业务服务每 5 分钟最多记录一个完整版本；宿主在业务写入的同一事务里把每篇文档的历史
  裁剪到设置值（默认 10 个版本）且单篇总量 ≤ 64 KiB，从最旧删除。
- **每日快照**：Host 启动约 10 秒后、之后每 6 小时、以及插件卸载时（当天还没有快照才执行）生成：
  `VACUUM INTO` 一致性副本 → gzip → 原子替换；随后把 `assets/` 打成
  `space-YYYYMMDD.assets.tar.gz`（无资产跳过）；两者都只保留最近「设置值（默认 3）份」。
  生成失败或磁盘不足只告警，不影响业务。
- **文档侧表 GC**：启动时扫描当前文档与保留版本快照的引用，清理未被引用的 `doc_objects` /
  `doc_assets`（资产同时删除磁盘字节）。
- **存储设置**：版本历史上限与每日快照份数存在 `meta` 表（`settings:storage`），经
  `storage.get / storage.estimate / storage.set` RPC 修改；保存后立即裁剪历史并清理多余快照；
  占用估算是上限值（不含 WAL 与损坏兜底副本）。

### 3.1 远程缓存、写队列与迁移暂存

- 服务端模式的读缓存与写队列放在本地数据目录的独立 `remote-cache-<server>.db`（按服务端地址哈希
  分文件），与权威库分离，结构版本不匹配时直接重建；读缓存损坏只丢弃缓存，不触碰权威数据。写队列
  条目是未确认的用户内容，不是可弃缓存：结构升级不得静默清空；不同服务端之间队列与读缓存互相隔离，
  切换服务端或完成整库迁移后必须显式处置（清空）旧队列。
- 写队列在向浏览器确认前必须落盘，携带幂等键与 `baseRevision`，按文档串行重放；传输失败退避重试，
  业务冲突标记为冲突并保留本地内容，不自动覆盖。队列与冲突计数通过 `settings.get` / `sync.status` 暴露。
- 资产按内容寻址缓存；超过上限的资产只流式转发不落缓存。
- 迁移以 `VACUUM INTO` 一致性快照导出，剔除 `workspace_links` 等设备本地侧表；可选只保留每篇文档
  最新版本。暂存与目标备份位于 `<dataDir>/.migration/`，替换前暂停服务端 runtime，完成后重新打开，
  失败时恢复备份；启动时清扫超过 7 天的遗留暂存。冻结从快照前开始并持续到权威切换完成：先拒绝新的
  写请求，再等待在途写结束（drain），避免已确认的写入落在快照之外。

## 4. 恢复与损坏处理

- **损坏判定**：只有真正的数据库损坏（`SQLITE_NOTADB` / `SQLITE_CORRUPT`，或 `quick_check` 失败）
  才把 `space.db`、`-wal`、`-shm`、`-journal` 移到 `.corrupt-<时间戳>-<pid>-<序号>` 并重建默认库。
  锁、权限、I/O 错误保留原文件并直接报错；损坏副本最多保留 2 组 / 256 MiB。
- **备份**：每日快照 = 数据库快照 + 资产归档；运行中的 DSH 持有连接，禁止手工编辑或移动数据库，
  手工备份用 `sqlite3 .backup`、退出后复制，或直接用每日快照。
- **恢复**：退出 DSH → `gunzip` 数据库快照并用 Node `DatabaseSync` 跑一次 `PRAGMA quick_check` →
  替换 `space.db`（删除残留 `-wal`/`-shm`）；如需恢复图片，再把资产归档解包回 `<dataDir>/assets/`。
- **恢复目标**：文档内容 RPO ≤ 1 次编辑（版本历史，最多 5 分钟粒度）；其余业务数据 RPO ≤ 24 小时
  （每日快照）；RTO 手动恢复约 5–10 分钟。

## 5. 构建、测试体系与门禁

- 要求 Node.js ≥ 24 与 pnpm；`client.js`、`lib/` 是生成产物，不入库，安装或更新前必须先构建。
- 构建期适配集中在 `build/build.mjs`（CSS 适配 + 模块级覆盖）：当前生效的模块覆盖只有
  `DirectoryField → src/app/native-directory-field.tsx`（宿主目录选择）；`@alter-space/legacy-adapter`
  别名指向 `src/document/editors/legacy/index.ts`，在 `build/build.mjs`、`tsconfig.json` paths 与
  `vitest.config.mts` 三处声明，必须保持同步（由 `tests/integration/contract/` 校验）。新增覆盖或
  别名须在 `vendor/README.md` 登记。
- 客户端 bundle 自包含：外置依赖仅限 react 族，新增第三方库必须打进 bundle；
  Host 侧新增依赖不得引入 `@deepseek-ai/*` 运行时依赖。
- 服务端入口编译到 `lib/server/core/index.js`，Docker 镜像只构建 Host 面（`pnpm build:host`），运行阶段
  不带构建工具；配置经 `SPACE_DATA_DIR` / `SPACE_HOST` / `SPACE_PORT` / `SPACE_TOKENS`（必填，命名
  token 列表）/ `SPACE_SNAPSHOTS` 提供，数据目录必须挂持久卷。
- **测试分层**：`tests/<layer>/` 目录即分层，环境与包含范围只在 `tests/layers.mjs` 声明，由
  `vitest.config.mts` 生成项目。`unit`（纯函数，node，无 I/O，秒级）、`integration`（Host、持久化、
  控制面、远程队列，真 SQLite 与真 HTTP 服务端）、`ui`（冻结旧编辑器 DOM/CSS，jsdom）、
  `nightly`（长跑种子 fuzz，不在门禁内）。不设浏览器 e2e：`dsh web` 登录态与 `__DSH_BOOT__` 注入
  无法在无人值守环境重建，真浏览器验收保留为人工清单。
- **测试复用**：测试之间禁止互相引用；共享代码只放 `tests/support/`（生命周期、构建器、DSH 服务替身、
  真服务端/运行时启动器、AST 断言、fuzz runner）。共享层只统一生命周期与替身，不降级保真度。
- **门禁**：`pnpm check` = lint + build + verify + docs:check + typecheck + 分层测试（不含 fuzz 全量），
  任何红灯不得合并；重构提交必须行为中性。`pnpm test:nightly` = 严格 lint + 全量 fuzz + 覆盖率下限。
  不稳定用例按缺陷处理（并发、端口、时序），不用重试掩盖。
- **覆盖率**：`pnpm test:coverage` 产出 JSON 摘要，`pnpm coverage:report` 按 `tests/layers.mjs` 的
  目录下限（行/语句双指标）校验，只升不降；冻结 UI 与薄接线不设硬指标，写入路径才是棘轮对象。
- Host 改动后需重启 Loader 行，客户端改动由 client-HMR 原地替换。客户端 bundle 被原地替换时，
  Space 面板选择与面板内路由在页面内续接；页面刷新仍按 DSH 默认重置。

## 6. 空间 ↔ DSH 工作区映射不变量

- 一个空间只把主工作目录（`directories[0]`）映射为一个 DSH 工作区；参考目录不创建工作区。
- 该映射只在本地模式生效；服务端模式下空间目录属于服务器，不创建、不改写本机 DSH 工作区。
- 工作区以 canonical 路径（`fs.realpath` 后）为唯一身份：同一目录最多一个工作区，也只能归属
  一个空间（含已归档空间）。
- 新建空间时创建/接管工作区，标题为 `🪐 <空间名>`；改名同步工作区标题；删除/归档空间只解绑，
  不删除 DSH 的工作区注册。
- 绑定只落 `workspace_links` 侧表，**不写入** `vendor/` 的 Space 实体。
- 侧栏图标保持原生文件夹，空间身份只用标题前缀 `🪐 ` 表示（DSH 工作区行没有自定义 icon 扩展点）。
- 宿主没有 `workspaceRegistry` 服务时降级：空间功能照常可用，只是不创建工作区、不同步标题。
- 存量空间不自动补建工作区；用户在 DSH 删除工作区后不自动重建；恢复空间（unarchive）或改主目录时
  才按新状态重建/接管。
- 归档空间的工作区仍留在 DSH 侧栏（DSH 没有工作区级隐藏/归档）。

## 7. 已知边界

- **单 Host 实例**：同一个 `space.db` 由单进程写入；多 Host 进程同时写由 SQLite 写锁串行
  （last-writer-wins）。服务端模式同样只有一个服务端权威进程。
- **服务端模式依赖在线**：断网时只能读缓存并排队文档写入；创建空间、评论、迁移等未缓存操作会失败；
  不做多主合并或 CRDT，冲突以服务端 revision 为准并保留本地草稿/版本。
- **迁移是整库切换**：切换瞬间客户端进入只读；迁移中断时源侧保持权威，目标只保留暂存与备份；
  反向迁移会覆盖目标侧自上次快照后的新数据，界面必须先说明损失。
- **无跨窗口实时推送**：其他窗口在刷新/重新读取后看到最新数据。
- **`node:sqlite` 同步 API**：写操作在 Host 事件循环上同步执行；平台缺少 `node:sqlite` 时插件
  明确报错，不静默降级。
- **备份存活范围**：每日快照与主库同在数据目录内，能防误删/误改/数据库损坏，不防磁盘故障或整个
  目录被删；异地容灾需把 `backups/` 定期复制到外部位置。
- **产品占位**：hub 的「事项 / 旅程 / 观察」仍是未实现的占位，只提供「概览」「配置」；
  协作者创建/选择是产品级数据（名称 + 职责，落 SQLite），不驱动真实 DSH Agent 运行时；
  Workbench 右侧面板不装配。
- **浏览器路由**：地址栏路由为内存路由，刷新后回到默认文档。
- **数据文件形态**：SQLite 二进制不如 JSON 直观，备份与恢复按 §4 的方式操作。
- **文档编辑器还原**：文档页为旧 UI 1:1 还原（CSS/DOM 不改）；callout / mindmap / component 等新
  AST 节点在旧 UI 中显示为对象占位卡，无人工编辑入口（AI 工具仍可读写，见验收清单）。
- **面板行为**：Space 面板按产品设计始终浅色；其全局快捷键在面板打开时优先于宿主。

## 相关文档

- [document-model-v0.md](document-model-v0.md) — 文档内容表示与 Markdown 投影
- [document-operations-v0.md](document-operations-v0.md) — 写入契约、版本/快照/备份语义
- [agent-doc-tools-v0.md](agent-doc-tools-v0.md) — Agent 工具契约与预算
- [规范索引](README.md) — 本目录文档清单与维护规则
- [空间 ↔ 工作区验收清单](../acceptance/space-workspace.md) — 映射约定的可执行检查项
- [文档知识库](../README.md) — 分类与写作规则
