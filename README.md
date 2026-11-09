# @alter-dsh/space

**完全自主、正式持久化的「空间」功能**：Space UI 作为 DSH Web 客户端插件运行，数据由 DSH Host 进程中的 Space 服务持有并落盘到 SQLite；浏览器只是客户端。构建、运行和存储都不依赖任何其他 checkout。

## 包含的功能

- 空间目录与切换、新建空间、空间设置（名称、图标、外观）
- 文档：编辑器、行内评论、版本历史与比较、归档/恢复、回收站
- 随想：列表、输入、编辑、移动、删除
- 空间详情（hub）：概览（总结 / 活动热力图 / 用量）、活动、配置与插件
- 设置：AI 协作者创建、归档空间恢复、快捷键与关于；空间配置/新建空间里可选择协作者
- 搜索、空间归档页、恢复流程

## 架构

| 层 | 位置 | 说明 |
| -- | ---- | ---- |
| 权威数据 | Host 进程（Cordis 插件，`lib/host`） | `vendor/service` 的 Space 业务服务 + `host/store.ts` 的 SQLite 持久化 |
| 传输 | DSH Connection 精确 Fetch 路由 | `/api/alter-space`，由 connection 统一完成浏览器鉴权与 Host/Origin 校验 |
| 浏览器 | `client.js` | `src/space-client.ts` 把 `SpaceService` 映射到 RPC；`src/space-shell.tsx` 在 `#/settings` 与空间路由之间切换；`vendor/ui-space` 的 `SpaceApp` 直接消费 |

数据流：`SpaceApp` → `SpaceService`（浏览器实现）→ `ctx.connection.rpc.call('/api', 'alter-space', …)` → Host 路由 → Space 服务 → SQLite 事务。

## 数据持久化

- **位置**：`${DSH_HOME:-~/.dsh}/data/space/space.db`，可用插件行 `config.dataDir` 覆盖目录。
- **介质**：SQLite（Node 内置 `node:sqlite`），WAL 模式、`synchronous=FULL`、`busy_timeout=5000`。
- **表结构**（v1，`PRAGMA user_version = 1`）：`spaces`、`nodes`、`thoughts`、`comments`、`versions`、`agents`、`tasks`、`events`、`milestones` 各一张 `(id, data)` 表；`hub(space_id, data)`；`meta(key, value)` 保存数组顺序与簿记。`data` 是实体的 JSON，业务服务代码不需要感知 SQL 结构。
- **写入**：所有变更进入单写者队列；每笔变更只写「新增/修改/删除的实体行 + 顺序数组 + meta」，在一个事务里提交，提交成功才 resolve；失败回滚内存快照并抛错。普通编辑只更新一行，不会重写整库。
- **启动**：打开数据库 → 校验 schema 版本 → `PRAGMA quick_check` → 读入内存（读路径与上游一致，业务服务从内存取值）。启动时顺带把上次异常退出留下的 WAL 截断，并把 `journal_size_limit` 限制为 16 MiB。
- **版本历史**：业务服务每 5 分钟最多记录一个完整版本；宿主在业务写入的同一事务里把每篇文档的历史裁剪到「设置值（默认 10 个版本）」且单篇总量 ≤64 KiB，从最旧删除。
- **每日快照**：Host 启动约 10 秒后、之后每 6 小时、以及插件卸载时（当天还没有快照才执行）自动生成：`VACUUM INTO` 得到一致性副本 → gzip → 原子替换为 `<dataDir>/backups/space-YYYYMMDD.db.gz`，只保留最近「设置值（默认 3）份」。生成失败或磁盘不足只告警，不影响业务。
- **存储设置**：Space 设置页新增「存储与备份」：可修改「版本历史上限（每篇）」与「每日快照保留」；保存后立即裁剪历史、清理多余快照，并按当前文档数量显示修改后的占用上限估算（不含 WAL 与损坏兜底副本）。估算由 Host 通过 `storage.get / storage.estimate / storage.set` 三个 RPC 端点计算。
- **损坏处理**：只有真正的数据库损坏（`SQLITE_NOTADB` / `SQLITE_CORRUPT` 或 `quick_check` 失败）才把 `space.db`/`-wal`/`-shm`/`-journal` 移到 `.corrupt-<时间戳>-<pid>-<序号>` 并重建默认库；锁、权限、I/O 错误保留原文件并直接报错。损坏副本最多保留 2 组 / 256 MiB，避免反复损坏撑满磁盘；schema 版本高于插件支持时拒绝启动。
- **备份/恢复**：自动快照即整库备份，恢复时退出 DSH，`gunzip` 快照后用 Node `DatabaseSync` 跑一次 `PRAGMA quick_check`，再替换 `space.db`（删除残留 `-wal`/`-shm`）。仍可手工复制 `space.db` 或使用 `sqlite3 .backup`。

## 构建、测试与校验

要求：Node.js ≥ 24、pnpm。

```sh
pnpm install
pnpm build      # client.js（浏览器）+ lib/（Host 半侧，tsc）
pnpm verify     # 静态校验：manifest / loader / 外置依赖 / Host 产物 / 自包含性
pnpm typecheck  # 客户端与 Host 两套 tsconfig
pnpm test       # vitest（store/service/rpc/space-client/storage/host-apply）
pnpm check      # 上述全部串联
```

`client.js` 与 `lib/` 是生成产物，不入版本库；安装或更新前必须先构建。

## 安装到当前 DSH profile

用 Harness 的 `plugin_manager` 安装本目录（绝对路径）。若 profile 里还装着旧的 `@alter/dsh-space`，先移除它：

```json
{ "action": "remove_bundle", "target": "@alter/dsh-space" }
```

```json
{ "action": "install_bundle", "target": "/Users/yifan/workspace/indie/Alter-dsh" }
```

安装后左侧栏出现「空间」图标；设置 → 插件中显示「空间」及说明。移除：`remove_bundle`，target 为 `@alter-dsh/space`。

> 修改 Host 半侧后需要让 Loader 行重启（`plugin_manager` 的 `set_bundle` 先禁用再启用，或重新安装）；浏览器半侧由 client-HMR 自动替换。

## 目录

| 路径 | 说明 |
| ---- | ---- |
| `host/` | Host 半侧：`store.ts`（SQLite 持久化）、`authority.ts`（组合业务服务）、`retention.ts`（版本历史上限）、`backup.ts`（每日快照调度）、`storage.ts`（设置与占用估算）、`settings.ts`（策略默认值/边界）、`rpc.ts`（/api/alter-space 路由）、`index.ts`（Cordis 插件入口） |
| `src/` | 客户端装配缝：`entry.js`（面板/侧栏注册）、`space-shell.tsx`（`#/settings` 路由与返回）、`space-client.ts`（SpaceService over RPC）、`storage-client.ts` / `storage-settings.tsx`（存储与备份设置）、`router.js`、宿主适配样式 |
| `vendor/` | 从 Alter 仓库复制的 Space 源码（逐字节一致），详见 [vendor/VENDOR.md](vendor/VENDOR.md) |
| `tests/` | vitest 测试 |
| `client.js`、`lib/` | 构建产物（不入库） |

## 已知边界

- **单 Host 实例**：同一个 `space.db` 由单进程写入；多 Host 进程同时写由 SQLite 写锁串行（last-writer-wins）。
- **无跨窗口实时推送**：其他窗口在刷新/重新读取后看到最新数据。
- **`node:sqlite` 同步 API**：写操作在 Host 事件循环上同步执行；只写变更行，代价可控。若某平台缺少 `node:sqlite`，插件会明确报错而不静默降级。
- **Agent 能力**：`vendor/service` hub 的「事项 / 旅程 / 观察」仍是上游的未实现占位（与 Alter 真实服务一致），只提供「概览」「配置」。协作者创建/选择是产品级数据（名称 + 职责，落 SQLite），不驱动真实 DSH Agent 运行时；Workbench 与 Agent 执行链路尚未接入。
- **Workbench 右侧面板**（`vendor/ui-workbench`）不装配；文档/详情页不显示 Workbench 开关。
- 浏览器地址栏路由为内存路由；刷新后回到默认文档。
- Space 面板按产品设计始终浅色；其全局快捷键在面板打开时优先于宿主。
- 数据文件是 SQLite 二进制，不如 JSON 直观（备份方法见上）。
- **备份存活范围**：每日快照与主库同在数据目录内，能防误删/误改/数据库损坏；不防磁盘故障或整个目录被删。需要异地容灾时把 `backups/` 定期复制到外部位置。
- **RPO**：文档内容 ≤1 次编辑（版本历史，最多 5 分钟粒度）；其余业务数据 ≤24 小时（每日快照）。**RTO**：手动恢复约 5–10 分钟。
- **占用估算**是上限值：按每篇历史填满、快照按保守压缩比估算；实际占用通常更小。

## 验证状态

见交付报告（构建、单元/集成测试、自包含构建证明、页面与持久化实测）。
