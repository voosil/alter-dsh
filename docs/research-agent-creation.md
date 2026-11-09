# DSH 智能体自定义创建调研与 Space 协作者落地方案

- 日期：2026-11-06
- 环境：DSH Desktop 0.2.2-rc.1，profile `desktop`，仓库 `/Users/yifan/workspace/indie/Alter-dsh`
- 任务：DSH 有多智能体（Agent Teams）但缺「智能体自定义创建」；Space 需要为空间创建协作者（Agent）。先调研可复用/可扩展的现有插件，没有再自研。

## 结论（先行）

1. **Space 的这次诉求没有可直接复用的现成插件**：Space 协作者是产品级实体
   （`Agent { id, name, role, createdAt }`，落在 `space.db` 的 `agents` 表，协议与
   业务服务都在上游 Alter 定义）；现有 DSH 插件管理的是 **DSH Agent 预设 / Team
   成员**（会话插件组合、模型路由），两者概念层级不同，也没有暴露供第三方产品插件
   创建 Space 协作者的扩展点。
2. **DSH 原生「创建智能体」路径是 Creator 模式**：`@deepseek-ai/dsh-client-ui-agent-preset`
   的设置页只读，`Known Limitations` 明确写着 *"Web creates and edits no preset"*；
   创建/覆盖预设要由 Creator 模式（`cordis` 预设）在会话里写 bundle 并安装，属于
   开发者工作流，不是产品里的结构化「新建协作者」表单。
3. **社区生态里确有流行的「智能体/团队自定义」插件，但都是 DSH 全局能力，不是
   Space 协作者的实现层**（见下节）：最流行的 `@linxin666/dsh-client-ui-preset-center`
   是预设中心/分发器（从 dsh-market.com 安装、声明预设），`dsh-agent-team-presets`
   是可视化 Team 预设管理器（队长+成员的角色/提示词/模型/工具），`dsh-bot-team` 是
   长期 Bot 同事（独立会话/人格/模型），且只兼容 0.2.1-rc.x。
4. **因此本次按 A 方案自研**：复用上游 Alter 已有的设置页
   （`packages/client/ui-settings`），在 `@alter-dsh/space` 面板内补齐 `#/settings`
   路由，创建/列出 AI 协作者并可在空间配置中邀请。B 方案（把 Space 协作者动态注册
   为真实 DSH 预设）列为后续可选项，可借鉴 preset-center 已证明可行的
   `ctx.agentPresets.register` 动态声明模式。

## 证据

### 1. 当前 profile 正在运行的相关插件

- profile bundles：`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-experimental-auto-review`、
  `dsh-experimental-agent-team-profile`、`@alter-dsh/space`（`plugin_manager list_bundles`）。
- Client `settings.section` 实际 occupants：`account / general / models / plugins / agent-presets`
  （`cordis_inspect_query` client Slots，root=`settings.section`）——DSH 已内置
  Agent 预设设置页，但没有「新建自定义 Agent」页面。
- Host `agentPresets` 服务方法：`register / list / remoteExportList / readDocument /
  resolve / mount / select / recompose / compositionInventory`；Remote 只暴露
  `list`、`read`、`select`（`cordis_inspect_query` host Service，service=`agentPresets`）。
- Agent Teams：`@deepseek-ai/dsh-experimental-agent-team` 的 teammate 由 Lead 用
  「名字 + 工作描述」创建（fresh/fork），**没有自定义 preset/persona/model/tools
  的创建入口**；其 README 只描述运行时协作、消息、任务板。
- `@deepseek-ai/dsh-client-ui-agent-preset` README（app.asar 内，
  `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-agent-preset/README.md`）：
  - "The page edits nothing: the Creator entry starts a Creator-mode task that
    authors or overrides a preset as a bundle"；
  - Known Limitations: "Web creates and edits no preset: the configuration viewer
    is read-only, and a bundle installed through Creator mode declares a new preset
    or overrides a shipped one by row id"。

### 2. 官方 bundle 目录与当前第三方插件

- `plugin_manager list_bundles`：25 个条目，官方 experimental 里有 agent-team、
  agent-presets UI、plugin-market（未安装）等，**没有「智能体自定义创建」bundle**。
- 当前 profile 仅安装第三方插件 `@alter-dsh/space`；没有运行中的第三方 Agent 插件。

### 3. 社区插件（web 检索 + npm registry / downloads API，2026-11-06）

| 插件 | 近 30 天 npm 下载 | 兼容 DSH | 能力 | 对 Space 协作者的适用性 |
| --- | --- | --- | --- | --- |
| `@linxin666/dsh-client-ui-preset-center` 0.4.15 | **88,115** | `>=0.2.2-rc.1` | 预设中心：从 dsh-market.com 安装预设到 `$DSH_HOME/agent-presets/<id>/`，经 `ctx.agentPresets.register` 动态声明（无需重启），带创意工坊面板 | 无 Space 集成/扩展 API；预设是代码型会话组合，不是 Space 产品协作者；不能直接复用其库 |
| `dsh-agent-team-presets` 0.1.9 | 2,014 | `>=0.2.2-rc.1 <0.3.0` | 可视化 Team 预设：队长+成员，各自 prompt/provider/model/reasoning/tool 白名单/私有 skill；设置页 + 输入区选择器；基于原生 Agent Teams | 最接近「自定义智能体」的体验，但数据在插件/profile 设置域，不与 Space `agents` 表互通；无扩展点 |
| `dsh-bot-team` 1.3.0 | 581 | `^0.2.1-rc.3`（**与 0.2.2-rc.1 不兼容**，需版本豁免） | 长期 Bot 同事：`ctx.agents.create/resume` 真 Agent、独立会话/模型/`BOT.md` 人格、群聊/任务/评审 | 版本不兼容且为独立侧栏产品，不能作为 Space 协作者实现 |

- 结论：社区生态证明「DSH 全局自定义 Agent」是真实需求且有流行方案，但没有任何
  插件把「产品空间内的协作者」作为扩展对象；把 Space 协作者映射到这些插件会引入
  错误的信任/语义边界（预设拥有与 shell 访问同等的信任）。
- 参考：<https://www.npmjs.com/package/@linxin666/dsh-client-ui-preset-center>、
  <https://github.com/bloodarea/dsh-agent-team-presets>、
  <https://github.com/shper/dsh-bot-team>、
  <https://api.npmjs.org/downloads/point/last-month/dsh-agent-team-presets>。

### 4. Space 侧缺口（本仓库）

- `vendor/ui-space/src/components/CreateSpaceDialog.tsx` 与
  `vendor/ui-space/src/views/ConfigView.tsx` 均有「创建协作者 / 在设置中创建协作者」，
  点击执行 `router.navigate('#/settings')`。
- `src/router.js` 是内存路由；`vendor/ui-space/src/SpaceApp.tsx` 只处理 `#/space`
  路由，DSH 端口没有设置页 → 链接失效、协作者列表始终为空。
- 上游 Alter 已有完整设置页：`/Users/yifan/workspace/indie/Alter/packages/client/ui-settings/src/SettingsPage.tsx`
  （AI 协作者创建 + 归档空间恢复 + 快捷键 + 关于）。

## 方案对比

| 方案 | 内容 | 优点 | 代价/风险 |
| --- | --- | --- | --- |
| **A（本次采用）** | 在 Space 面板内补齐 `#/settings`，复用上游 `SettingsPage` 创建产品级协作者（name+role，SQLite/RPC 持久化） | 与上游产品语义一致；改动小；无第三方依赖；立即修复死链；协作者可被空间创建/配置引用 | 协作者目前只是产品数据，不驱动真实 DSH Agent 执行（Workbench/Agent 运行时尚未接入，与仓库既有边界一致） |
| **B（后续可选）** | Host 内用 `ctx.agentPresets.register(PresetDefinition)` 把协作者动态声明为 DSH 预设（persona + 工具/模型），Space 记录 preset id | 协作者可真正参与会话/团队；可借鉴 preset-center 的动态声明 + 惰性库模式 | 需要 Cordis 条目列表、模型路由、preset revision 生命周期、Remote/权限边界、`Agent` 模型扩展与迁移；预设即代码（信任边界高）；收益取决于 Workbench/真实执行链路何时接入 |
| C | 安装/扩展社区插件（preset-center / agent-team-presets / bot-team） | 不重复造轮子（尤其 preset-center 88k/月） | 都不解决 Space 协作者；需改第三方源码或依赖其私有接口；bot-team 版本不兼容；引入新的信任面与 profile 依赖 |

## 推荐与风险

- **现在做 A**：直接满足「为空间创建协作者」；本次已实现并纳入构建/校验（见下）。
- **B 之前不建议动**：Space 目前没有真实 Agent 执行/Workbench 链路，先接预设会把
  未验证的信任边界引入产品数据；等 Workbench/Agent 运行时接入时再评估，并优先
  复用 preset-center 的「惰性安装、显式声明、可卸载」模式。
- 若用户需要 DSH 全局的「自定义智能体/团队」，建议单独安装社区插件
  `dsh-agent-team-presets`（与 Space 功能并行，不互相依赖），不要把它当作 Space
  协作者的实现层。

## 本次实现（A）与验证口径

- 新增 `vendor/ui-settings/`（上游 `packages/client/ui-settings/src` 逐字节复制，含
  `SettingsPage.tsx`、`SettingsPage.module.css`、`index.ts`）。
- 新增 `src/space-shell.tsx`：订阅同一内存 router，`#/settings` 渲染
  `<SettingsPage service={service} />`（不传 workbench），其余路径渲染原 `SpaceApp`；
  提供「返回空间」（恢复进入设置前的路由）与 Escape 返回。
- `build/build.mjs` 增加 `@alter/ui-settings/SettingsPage` 别名；`scripts/verify.mjs`
  增加 vendored 目录/设置页产物断言；`tsconfig.json` 覆盖 TSX 与 vendored 设置页类型检查；
  `vendor/VENDOR.md`、`README.md` 更新。
- 数据链路不变：`listAgents` / `createAgent` / `updateSpace(collaboratorIds)` 走既有
  `/api/alter-space` RPC 与 SQLite；新增单测覆盖创建协作者、空间引用与重开库持久化。
- 验证：`pnpm check` 全绿（build + verify + typecheck + 27 个测试）；安装到 desktop
  profile 后的运行时验证见交付报告（浏览器点击验证受本会话无浏览器控制限制）。
