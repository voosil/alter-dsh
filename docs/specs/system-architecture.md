---
type: spec
status: active
updated: 2026-11-10
---

# 系统架构与持久化约束

本篇规范约束 Alter-dsh 的分层与数据所有权、传输协议、SQLite 持久化与恢复行为、构建自包含、
空间 ↔ DSH 工作区映射不变量，以及必须接受的已知边界。它是这些约束的实施基准；逐文件职责与
源码说明不在本篇展开。

## 1. 分层与数据所有权

| 层 | 职责 | 数据所有权 |
| --- | --- | --- |
| Host 进程（Cordis 插件，`host/` → `lib/`） | 打开 SQLite、组合 `vendor/service` 的业务服务、暴露精确 Fetch 路由 | **唯一权威**：全部业务数据 |
| 传输（DSH Connection） | 浏览器鉴权、Host/Origin 校验、RPC 信封转发 | 无状态 |
| 浏览器客户端（`src/` → `client.js`） | 把 `vendor/ui-space` 的 `SpaceApp` 挂到面板，用 RPC 实现 `SpaceService` | 仅内存状态与 UI 偏好 |

不变量：

- 数据流固定为：`SpaceApp` → 浏览器端 `SpaceService` → RPC → Host 路由 → 业务服务 → SQLite 事务。
  客户端不得绕过该链路读写业务数据。
- 业务数据只存在于 Host 与 SQLite；浏览器 localStorage 只存 UI 偏好，刷新或重开面板后从 Host 重新读取。
- 插件自有数据放 SQLite 侧表（如空间 ↔ 工作区绑定），不写入 `vendor/` 的实体结构。
- 本仓库是 Space 协议、业务服务、编辑器、UI 与 Host 的唯一实现源（单仓库、自包含）。
- `vendor/` 是项目自有源码，可以修改但须克制：新增逻辑优先放 `host/`、`src/`；确需改 `vendor/`
  时保持既有行为与约定一致，并在 `vendor/README.md` 的「构建期模块覆盖与别名 / 关键行为约定」中更新。

## 2. 传输协议约束

- 浏览器只能通过 DSH Connection 的精确 Fetch 路由 `POST /api/alter-space` 访问 Host；
  鉴权与 Host/Origin 校验由 Connection 统一完成，Host 路由不重复实现鉴权。
- 通道常量 `('/api', 'alter-space')` 在 Host 与客户端各有一份，必须保持同步。
- 请求信封 `{ type: 'client-request', rpcId, payload: { op, args } }`；响应信封
  `{ type: 'server-response', rpcId, result: { ok: true, value } }`。业务结果在 `value` 内为
  `{ value }` 或 `{ error: { code, message } }`；HTTP 层只处理信封错误（405/400/500），
  业务失败留在成功响应的 `value` 内。
- **端点白名单**：Host 维护 Space 与 hub 方法白名单；新增端点必须同时加入 Host 白名单与浏览器
  客户端映射（`host/rpc.ts`、`src/space-client.ts`，`storage.*` 在 `src/storage-client.ts`），
  缺一视为未完成。
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

## 5. 构建与自包含

- 要求 Node.js ≥ 24 与 pnpm；`client.js`、`lib/` 是生成产物，不入库，安装或更新前必须先构建。
- 构建期适配集中在 `build/build.mjs`（CSS 适配 + 模块级覆盖）；当前生效的模块覆盖只有
  `DirectoryField → src/native-directory-field.tsx`（宿主目录选择）。文档视图不做模块覆盖：
  `@alter-space/document-view` 别名在 `build/build.mjs` 与 `tsconfig.json` paths 两处声明，
  指向 `src/document/` 的结构化视图。新增覆盖或别名须在 `vendor/README.md` 登记。
- 客户端 bundle 自包含：外置依赖仅限 react 族，新增第三方库必须打进 bundle；
  Host 侧新增依赖不得引入 `@deepseek-ai/*` 运行时依赖。
- 交付前 `pnpm check`（build + verify + docs:check + typecheck + test）必须全绿；
  Host 改动后需重启 Loader 行，客户端改动由 client-HMR 替换。

## 6. 空间 ↔ DSH 工作区映射不变量

- 一个空间只把主工作目录（`directories[0]`）映射为一个 DSH 工作区；参考目录不创建工作区。
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
  （last-writer-wins）。
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
- **面板行为**：Space 面板按产品设计始终浅色；其全局快捷键在面板打开时优先于宿主。

## 相关文档

- [document-model-v0.md](document-model-v0.md) — 文档内容表示与 Markdown 投影
- [document-operations-v0.md](document-operations-v0.md) — 写入契约、版本/快照/备份语义
- [agent-doc-tools-v0.md](agent-doc-tools-v0.md) — Agent 工具契约与预算
- [规范索引](README.md) — 本目录文档清单与维护规则
- [空间 ↔ 工作区验收清单](../acceptance/space-workspace.md) — 映射约定的可执行检查项
- [文档知识库](../README.md) — 分类与写作规则
