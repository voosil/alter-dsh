---
type: acceptance
status: active
updated: 2026-11-09
---

# AI 协作者创建 · 验证记录

验收对象：Space 面板的 `#/settings` 设置页复用，以及 AI 协作者的创建/选择链路（当前创建入口在
空间详情 →「配置」页的「新建协作者」弹窗；设置页的「AI 协作者」分区只读展示名单）。
结论：**PASS（构建 / 类型 / 测试 / 安装 / 注册）**；浏览器点击链路未自动化，见「未验证与限制」。

## 已验证

| 项 | 结论 |
| --- | --- |
| 构建与类型 | `pnpm check` 全绿（当前链含 build + verify + docs:check + typecheck + test）；`build` 重新生成客户端与 `lib/`，设置页源码经 `@alter/ui-settings/SettingsPage` 别名参与编译。 |
| 产物断言 | 客户端产物含模块加载入口与 `exports.apply` / `exports.inject`；外置 require 仅 react 族；含设置页文案与 `#/settings` 路由；`100dvh` 已重写为 `100%`，`kbd` 选择器限定在面板根下。 |
| 测试 | 6 个测试文件 / 27 个用例全部通过。新增用例覆盖：创建协作者（name/role、空名校验）、写入空间 `collaboratorIds`、关闭并重开 SQLite 后仍持久化；经 RPC 白名单端点 `space.createAgent → space.listAgents`；设置页 SSR 渲染与面板壳在 `#/settings` 渲染设置页 + 「返回空间」。 |
| 安装与注册 | `remove_bundle` 后 `install_bundle`：`application: applied`、warnings 空、link 安装；Loader 行 `enabled: true`、`fiberPhase: active`；Client `main` 槽 occupant 存在且 `active: true`。 |
| 数据安全 | 未手工读写/移动 `~/.dsh/data/space/space.db`；单元测试全部使用 `mkdtemp` 临时目录；未向用户库真实写入协作者。 |

以上各项可用 `pnpm check` 复跑；安装态用 `plugin_manager` 复核 Loader 行与 Client 槽位。

## 未验证与限制

- **浏览器点击链路未自动化**：本会话没有浏览器控制能力（Web GUI 需登录态），未实际点击
  「空间 → 配置 → 协作者 → 创建协作者 → 返回空间」。已用 SSR 测试覆盖面板壳路由与设置页渲染、
  用构建/静态断言覆盖产物，但不等同于点击验证。
- link 安装的客户端产物需刷新页面（或等 client-HMR）后生效；Host 侧改动需重启 Loader 行。

## 人工验收路径

1. 刷新 DSH 页面 → 左侧「空间」→ 打开任一空间 →「配置」→「协作者」→「新建协作者」。
2. 在弹窗填写「名称 / 职责 / 描述 / 使用的模型 / 权限」→ 创建 → 列表出现新协作者。
3. 勾选该协作者 → 保存；刷新页面后仍存在（SQLite 持久化）。
4. 「新建空间」对话框的协作者区块可选择该协作者；设置页的「AI 协作者」分区只读展示名单。

## 相关文档

- [调研：DSH 智能体创建与 Space 协作者接入](../research/dsh-agent-creation.md)
- [验收索引](README.md)
