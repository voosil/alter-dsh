# AGENTS.md — Alter-dsh

「空间」（Space）功能的自包含 DSH 插件（包名 `@alter-dsh/space`），分 Host 与客户端两半：
Host 半侧（`host/` → `lib/`）是 Cordis 插件，持有 SQLite 与业务服务，经 `/api/alter-space`
暴露给浏览器；客户端半侧（`src/` → `client.js`）把 `vendor/ui-space` 的 `SpaceApp` 挂到面板。
业务数据只存在于 Host。

本文件只写入口、硬约束与交付要求。**文档规则与索引以 [docs/README.md](docs/README.md) 为准**，
不要在本文件复制细节或实现说明。

## 硬约束（违反即返工）

- **数据权威在 Host**：业务数据只写 SQLite（`${DSH_HOME:-~/.dsh}/data/space/space.db`）；
  localStorage 只存 UI 偏好。不要手工编辑/移动运行中的数据库；备份用每日快照（含资产归档）或 `sqlite3 .backup`。
- **新增 RPC 端点**必须同时改 `host/authority/rpc.ts` 白名单与 `src/client/rpc.ts` 映射；通道常量
  `('/api', 'alter-space')` 两处保持同步。传输信封与端点语义以 spec 为准。
- **`vendor/` 可改但克制**：新增逻辑优先放 `host/`、`src/`；确实要改 `vendor/` 时保持行为与
  既有约定一致。构建期覆盖与别名集中在 `build/build.mjs`，当前生效的清单写在 `vendor/README.md`。
- **客户端 bundle 自包含**：外置依赖仅限 react 族；新增第三方库必须打进 bundle。
- **空间 ↔ 工作区不变量**：一个空间只把主工作目录（`directories[0]`）映射为一个 DSH 工作区；
  工作区以 canonical 路径为唯一身份；同一目录只能归属一个空间（含已归档空间）；标题前缀 `🪐`；
  绑定只落 `workspace_links` 侧表，**不要写进 Space 实体**。
- **文档正文单一格式**：所有 Space note 正文只有 `alter-doc/1` AST 一种格式；正文写入必须经
  Document Operations，`space.saveNode` 只更新元数据、不接受正文。
- **文档编辑面冻结**：产品文档页是 `vendor/ui-space` 的旧 UI 1:1 还原（CSS、编辑器 DOM 与既有
  JSX 结构不得改动）；AST 适配层在 `src/document/editors/legacy`（别名 `@alter-space/legacy-adapter`），
  正文只经 Document Operations；组件目录在 `vendor/protocol`，声明式组件暂以对象占位卡呈现。
- **文档有预算**：单文档、单目录数量、关键文档体量都有硬上限（见 docs/README.md），
  由 `pnpm docs:check` 强制；关键文档只放导航、规则与约束，不写实现细节、源码说明、变更历史。
- **版本历史与快照**是恢复底线：改动写入路径时必须保留归属（`me` / `alter`）、事务与裁剪语义。

## 常用命令

```sh
pnpm install       # 首次或依赖变化后
pnpm build         # client.js + lib/（生成产物，不入库）
pnpm verify        # 插件包静态校验
pnpm docs:check    # 文档体系校验（分类/体量/索引/链接）
pnpm typecheck     # 客户端与 Host 两套 tsconfig
pnpm test          # vitest
pnpm check         # build + verify + docs:check + typecheck + test（提交前全绿）
```

## 安装、更新与生效

- 安装/更新到当前 DSH profile：用 `plugin_manager` 的 `remove_bundle` 移除同名旧包（首次可跳过），
  再 `install_bundle` 目标为本仓库绝对路径。不要手写 profile 的 `package.json` / `cordis.patch.yml`。
- Host 半侧改动后需要让 Loader 行重启（`set_bundle` 先禁用再启用）；客户端改动由 client-HMR 自动替换。
- 生成的 `client.js` 与 `lib/` 不入库；安装或更新前必须先构建。

## 知识库导航

| 想知道 | 入口 |
| --- | --- |
| 数据模型、Operations、Agent 工具契约、系统架构与持久化边界 | [docs/specs/README.md](docs/specs/README.md) |
| 为什么这样设计、方向与已做决策 | [docs/designs/README.md](docs/designs/README.md) |
| 外部调研证据与候选方案 | [docs/research/README.md](docs/research/README.md) |
| 验收清单与验证记录 | [docs/acceptance/README.md](docs/acceptance/README.md) |
| 文档分类、体量预算、写作与变更规则 | [docs/README.md](docs/README.md) |

## 交付要求

- 行为或契约变更时，代码、测试、spec 与索引在同一变更里更新；不要让文档与实现分叉。
- 提交前 `pnpm check` 全绿（其中含 `pnpm docs:check`）。
- 提交信息用 Conventional Commits：`<type>(<scope>): <一句话说明>`，scope 写具体模块或范畴
  （如 `host`、`document`、`editor`、`workspace`、`settings`、`build`、`docs`）改动横跨多层时按主变更面取一个 scope，其余改动在提交正文说明。
- 文档只写当前有效内容；变更历史交给 git，不写流水账、不贴源码、不写逐文件实现说明。
- 大量涉及样式、UX这类花费时间非常长但人做起来很简单的验证不需要自己做，条理清晰地总结出来让用户Review。
