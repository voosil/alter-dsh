# AGENTS.md — Alter-dsh

本仓库是「空间」（Space）功能的自包含 DSH 插件（包名 `@alter-dsh/space`），分两半：

- **Host 半侧**（`host/` → `lib/`）：Cordis 插件，打开 SQLite 数据库、组合
  `vendor/service` 的业务服务、通过 DSH Connection 的 `/api/alter-space`
  Fetch 路由暴露给浏览器。
- **客户端半侧**（`src/` → `client.js`）：把 `vendor/ui-space` 的 `SpaceApp`
  挂到面板，`src/space-client.ts` 用 RPC 实现 `SpaceService`；业务数据只存在于 Host。

## 常用命令

```sh
pnpm install      # 首次或依赖变化后
pnpm build        # client.js + lib/（生成产物，不入库）
pnpm verify       # 静态校验
pnpm typecheck    # 客户端与 Host 两套 tsconfig
pnpm test         # vitest
pnpm check        # build + verify + typecheck + test
```

安装/更新到当前 DSH profile：用 `plugin_manager` 的 `remove_bundle` 移除同名
旧包（首次可跳过），再 `install_bundle` 目标为本仓库绝对路径。不要手写 profile
的 `package.json` / `cordis.patch.yml`。Host 代码改动后需要让 Loader 行重启
（`set_bundle` 先禁用再启用）；客户端代码由 client-HMR 自动替换。

## 结构

- `host/store.ts`：SQLite 持久化（每实体一行 JSON、meta 顺序数组、单写者队列、
  事务提交、损坏备份）。`PRAGMA user_version` 记录当前结构版本（目前只有 v1）。
- `host/retention.ts`：文档版本历史上限（每篇默认 10 版 / 64 KiB，随设置生效）。
- `host/backup.ts`：每日整库快照（VACUUM INTO + gzip + 保留最近 N 份）。
- `host/storage.ts` + `host/settings.ts`：存储策略的默认值、校验、占用估算与设置持久化。
- `host/rpc.ts`：`/api/alter-space` Fetch 路由（Connection 负责鉴权）、端点白名单、
  参数/结果信封。
- `host/authority.ts`：用 store 组合上游 hub + content service。
- `src/space-client.ts`：浏览器端 `SpaceService`；通道常量是
  `('/api', 'alter-space')`，与 `host/rpc.ts` 的 `RPC_ROUTE_PATH`/`RPC_ENDPOINT` 保持同步。
- `vendor/`：从 Alter 仓库复制的源码，**逐字节一致，不要直接改**；来源与同步方法见
  `vendor/VENDOR.md`。
- `tests/`：store/service/rpc/space-client/host-apply 测试。

## 约定

- **数据文件**：`${DSH_HOME:-~/.dsh}/data/space/space.db`，每日快照在
  `<dataDir>/backups/space-YYYYMMDD.db.gz`。运行中的 DSH 会持有连接，不要手工
  编辑/移动数据库；备份用 `sqlite3 .backup`、退出后复制，或直接用每日快照。
- **存储设置**：版本历史上限 / 每日快照份数存在 SQLite `meta` 表（`settings:storage`），
  由设置页「存储与备份」经 `storage.get/estimate/set` RPC 修改；改完立即裁剪历史并清理快照。
- 浏览器 localStorage 只存 UI 偏好；业务数据不写回 localStorage。
- 传输协议：浏览器 → `POST /api/alter-space`，Connection 信封
  `{type:'client-request', rpcId, method, payload:{op,args}}`；响应
  `{type:'server-response', rpcId, result:{ok:true, value:{value}|{error}}}`。
  新增端点必须同时加入 `host/rpc.ts` 白名单与 `src/space-client.ts` 映射。
  `storage.*` 是 DSH 扩展端点，客户端映射在 `src/storage-client.ts`。
- 构建期对复制样式的适配只在 `build/build.mjs` 的 `adaptCss` 中进行，不改原样式文件。
- 客户端 bundle 外置依赖仅限 react 族；新增第三方库必须打进 bundle。
