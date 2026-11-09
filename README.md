# @alter-dsh/space

**完全自主、正式持久化的「空间」功能**：Space UI 作为 DSH Web 客户端插件运行，数据由 DSH Host
进程中的 Space 服务持有并落盘到 SQLite；浏览器只是客户端。构建、运行和存储完全自包含。

## 包含的功能

- 空间目录与切换、新建空间、空间设置（名称、图标、外观）
- 文档：编辑器、行内评论、版本历史与比较、归档/恢复、回收站
- 随想：列表、输入、编辑、移动、删除
- 空间详情（hub）：概览（总结 / 活动热力图 / 用量）、活动、配置与插件
- 设置页：存储与备份、已归档空间恢复、协作者名单、快捷键与关于；协作者创建在空间详情的「配置」页
- 搜索、空间归档页、恢复流程
- 空间 ↔ DSH 工作区：新建空间时把**主工作目录**（`directories[0]`，其余为参考目录）映射为一个
  DSH 原生工作区，标题为 `🪐 <空间名>`；改名同步标题，删除/归档只做非破坏性处理
- 工作目录选择接入宿主选择器（桌面=系统文件夹对话框，Web=DSH 目录浏览）；宿主无此能力时回退内置浏览器
- Agent 文档读写工具（v0）：模型可通过 `space_doc_*` 工具 outline/read/search/ops/generate 读写空间文档；
  契约见 [docs/specs/agent-doc-tools-v0.md](docs/specs/agent-doc-tools-v0.md)，方案见 [docs/designs/agent-doc-tools.md](docs/designs/agent-doc-tools.md)

## 架构

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 权威数据 | Host 进程（Cordis 插件） | Space 业务服务 + `host/store.ts` 的 SQLite 持久化 |
| 传输 | DSH Connection 精确 Fetch 路由 | `/api/alter-space`，由 Connection 统一完成鉴权与 Host/Origin 校验 |
| 浏览器 | `client.js` | 浏览器端 `SpaceService` over RPC；`vendor/ui-space` 的 `SpaceApp` 直接消费 |

数据流：`SpaceApp` → `SpaceService`（浏览器实现）→ Connection RPC → Host 路由 → Space 服务 → SQLite 事务。

工作区映射由 Host 的 `workspace-sync.ts` 维护：绑定关系落在 `space.db` 的 `workspace_links` 侧表，
不写入 Space 实体；写入 DSH `workspaceRegistry` 后侧栏实时更新。数据模型、持久化与恢复语义见
[系统规范](docs/specs/system-architecture.md)。

## 快速开始

要求：Node.js ≥ 24、pnpm（`node:sqlite` 缺失的平台会明确报错而不降级）。

```sh
pnpm install
pnpm build      # client.js（浏览器）+ lib/（Host 半侧）
pnpm check      # 构建 + 静态校验 + 文档校验 + 类型 + 测试
pnpm test       # 仅 vitest
```

`client.js` 与 `lib/` 是生成产物，不入版本库；安装或更新前必须先构建。

## 安装到当前 DSH profile

用 Harness 的 `plugin_manager` 安装本目录（绝对路径）。若 profile 里还装着旧的 `@alter/dsh-space`，先移除：

```json
{ "action": "remove_bundle", "target": "@alter/dsh-space" }
```

```json
{ "action": "install_bundle", "target": "/Users/yifan/workspace/indie/Alter-dsh" }
```

安装后左侧栏出现「空间」图标；设置 → 插件中显示「空间」及说明。移除时 `remove_bundle` 的 target 为
`@alter-dsh/space`。修改 Host 半侧后需让 Loader 行重启（`set_bundle` 先禁用再启用）；浏览器半侧由
client-HMR 自动替换。

## 目录

| 路径 | 说明 |
| --- | --- |
| `host/` | Host 半侧：SQLite 持久化、业务服务组装、工作区映射、存储策略、快照、RPC 路由、插件入口 |
| `src/` | 客户端装配缝：面板注册、`#/settings` 外壳、宿主目录选择器适配、SpaceService RPC、样式 |
| `vendor/` | Space 的协议、业务服务与 UI 源码（项目自有），说明见 [vendor/README.md](vendor/README.md) |
| `docs/` | 工程知识库，入口 [docs/README.md](docs/README.md) |
| `tests/` | vitest 测试 |
| `client.js`、`lib/` | 构建产物（不入库） |

## 已知边界

- 单 Host 实例写入；多 Host 进程由 SQLite 写锁串行（last-writer-wins）。
- 无跨窗口实时推送：其他窗口在刷新/重新读取后看到最新数据。
- `node:sqlite` 同步 API：写操作在 Host 事件循环上同步执行；只写变更行，代价可控。
- Agent 能力：hub 的「事项 / 旅程 / 观察」仍是未实现占位；协作者是产品级数据，不驱动真实 DSH Agent
  运行时；Workbench 右侧面板不装配。
- 工作区映射：只有主目录映射工作区；归档空间的工作区仍留在 DSH 侧栏。
- 备份存活范围：每日数据库快照与资产归档都在数据目录内，防误删/误改/损坏，不防磁盘故障。

完整边界、RPO/RTO 与存储/恢复语义只在
[docs/specs/system-architecture.md](docs/specs/system-architecture.md) 定义，本文件不复述。

## 文档

工程知识库的规则、分类与体量预算见 [docs/README.md](docs/README.md)：

- [规范 specs](docs/specs/README.md)：数据模型、Operations、Agent 工具契约、系统架构
- [方案 designs](docs/designs/README.md)：设计方向与决策
- [调研 research](docs/research/README.md)：外部证据与候选方案
- [验收 acceptance](docs/acceptance/README.md)：验收清单与验证记录
