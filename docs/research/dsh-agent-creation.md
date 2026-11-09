---
type: research
status: active
updated: 2026-11-09
---

# DSH 智能体创建与 Space 协作者接入调研

这篇调研回答：Space 的「AI 协作者」要不要、以及如何对接 DSH 的智能体创建能力——是复用现成插件与
服务，还是在 Space 侧自建产品级实体。结论是自建产品级协作者（A 方案），真实 DSH Agent 运行时接入
（B 方案）留作后续；验收记录见[协作者创建验收](../acceptance/agent-collaborators.md)。

> 调研基线：DSH Desktop 0.2.2-rc.1（2026-11-06）；外部插件生态与下载量等数据会随时间变化。

## 问题

- DSH 有 Agent Teams 与 Agent 预设，但没有面向产品的「自定义智能体创建」入口。
- Space 需要为每个空间创建协作者。Space 协作者是产品级实体（`Agent`：名称、职责，以及可选的描述、
  模型、权限；随空间数据持久化），与 DSH 的「Agent 预设 / Team 成员」（会话插件组合、模型路由）不在同一概念层。
- 需要先确认：现有 DSH 插件或扩展点能否直接创建协作者；不能的话，应该在哪一层自研。

## 证据

### 当前运行环境的相关能力

- profile 加载 `dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile`、`@alter-dsh/space` 等 bundle。
- 设置区已有 `account / general / models / plugins / agent-presets` 等区块——内置 Agent 预设页，
  但没有「新建自定义 Agent」页面。
- Host `agentPresets` 服务提供 `register / list / remoteExportList / readDocument / resolve / mount /
  select / recompose / compositionInventory`；Remote 侧只暴露 `list / read / select`——第三方产品插件
  没有稳定的创建/注册扩展点。
- 官方 Agent 预设 UI 的定位是只读查看：创建/覆盖预设要走 Creator 模式在会话里写 bundle 并安装，
  属于开发者工作流，不是产品里的「新建协作者」表单。
- Agent Teams 的 teammate 由 Lead 用「名字 + 工作描述」创建（fresh/fork），没有自定义
  preset/persona/model/tools 的创建入口。
- 官方 bundle 目录中没有「智能体自定义创建」bundle。

### 社区插件

| 插件 | 定位 | 与 Space 协作者的关系 |
| --- | --- | --- |
| `@linxin666/dsh-client-ui-preset-center` | 预设中心：从 dsh-market.com 安装预设、动态声明（无需重启） | 社区最流行的方案（npm 月下载约 8.8 万，2026-11-06 查询），但面向 DSH 全局预设，无 Space 集成/扩展 API |
| `dsh-agent-team-presets` | 可视化 Team 预设：队长 + 成员的角色/提示词/模型/工具 | 最接近「自定义智能体」体验，但数据在插件/profile 设置域，不与 Space 协作者数据互通，无扩展点 |
| `dsh-bot-team` | 长期 Bot 同事：独立会话/人格/模型 | 与 DSH 0.2.2-rc.1 不兼容，且是独立侧栏产品 |

社区生态证明「DSH 全局自定义 Agent」是真实需求，但没有任何插件把「产品空间内的协作者」当作扩展对象；
把 Space 协作者映射过去会引入错误的信任边界（预设拥有与 shell 访问同等的信任）。

## Space 侧缺口（A 方案已修复）

- 调研时：空间创建对话框与空间配置页都有「创建协作者 / 在设置中创建协作者」入口，点击导航到
  `#/settings`；但插件面板只处理 `#/space` 路由、没有挂载设置页 → 入口死链，协作者列表始终为空。
- 修复：面板内补齐 `#/settings`（存储与备份、归档空间、协作者名单、快捷键、关于）；协作者创建入口
  改为空间详情 →「配置」页的「新建协作者」弹窗，创建后自动加入当前空间协作者草稿。
- 仓库内已有完整设置页源码（AI 协作者、归档空间恢复、快捷键、关于），可直接复用到面板内。

## 方案对比

| 方案 | 内容 | 优点 | 代价 / 风险 |
| --- | --- | --- | --- |
| **A（采用）** | 在 Space 面板内补齐 `#/settings`，创建 Space 产品级协作者（name+role，随空间数据持久化），供空间创建/配置引用 | 与产品语义一致；改动小；无第三方依赖；修复死链 | 协作者只是产品数据，不驱动真实 DSH Agent 执行 |
| **B（后续）** | Host 内用 `ctx.agentPresets.register` 把协作者声明为真实 DSH 预设（persona + 工具/模型），Space 记录 preset id | 协作者可真正参与会话/团队；可借鉴现成动态声明方案 | 需要 Cordis 条目、模型路由、preset revision 生命周期、Remote/权限边界、数据模型迁移；预设即代码，信任边界高；收益取决于真实执行链路的接入时机 |
| C | 安装/扩展社区插件 | 不重复造轮子 | 都不解决 Space 协作者；需改第三方源码或依赖私有接口；版本不兼容；新增信任面 |

## 推荐与风险

- 现在做 A：直接满足「为空间创建协作者」，且不把未验证的信任边界引入产品数据。
- B 等 Space 有真实 Agent 执行/Workbench 链路后再评估，优先复用「惰性安装、显式声明、可卸载」的模式。
- 用户若需要 DSH 全局的自定义智能体/团队，建议单独安装 `dsh-agent-team-presets`，与 Space 并行，
  不当作 Space 协作者的实现层。

## 已实现范围与验证口径

- 已实现：Space 面板内 `#/settings` 设置页（列出 AI 协作者名单、返回空间入口）；协作者创建在
  空间详情 →「配置」页的「新建协作者」弹窗，创建后可被空间配置邀请；数据随既有 RPC 与 SQLite 链路持久化。
- 验证口径：`pnpm check` 全绿（build + verify + typecheck + 测试）；单测覆盖创建协作者（name/role、
  空名校验）、写入空间 `collaboratorIds`、重开库后仍持久化、RPC 端点链路、设置页 SSR 与面板壳渲染。
- 未覆盖：浏览器点击链路（限制与人工验收路径见[协作者创建验收](../acceptance/agent-collaborators.md)）。

## 参考链接

- 预设中心：<https://www.npmjs.com/package/@linxin666/dsh-client-ui-preset-center>
- Team 预设管理器：<https://github.com/bloodarea/dsh-agent-team-presets>
- Bot 同事：<https://github.com/shper/dsh-bot-team>

## 相关文档

- [Space 协作者创建验收](../acceptance/agent-collaborators.md)
- [调研索引](README.md)
- [文档规则](../README.md)
