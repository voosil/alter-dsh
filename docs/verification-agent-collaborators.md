# 验证报告：Space AI 协作者创建（#/settings）

- 日期：2026-11-06
- 范围：`@alter-dsh/space` 设置页复用 + `#/settings` 面板壳 + 协作者创建/选择链路
- 结论：**PASS（构建 / 类型 / 测试 / 安装 / 注册）**；**浏览器点击链路未自动化验证**（见限制）

## 已执行

1. **源码与构建**
   - `vendor/ui-settings/src` 含设置页源码（`SettingsPage.tsx`、`SettingsPage.module.css`、
     `index.ts`），构建期通过 `@alter/ui-settings/SettingsPage` 别名参与编译。
2. **`pnpm check` 全绿**
   - `build`：client.js 838 KiB / CSS 153 KiB；`lib/` 重新生成。
   - `verify`：PASS（manifest/loader/外置依赖/Host 产物/自包含性；新增 ui-settings 源码
     断言、`AI 协作者`/`创建协作者`/`#/settings`/`返回空间`/`alter-space-settings-back` 产物断言）。
   - `typecheck`：客户端（含新增 `src/space-shell.tsx`、`vendor/ui-settings`）与 Host 两套通过。
   - `test`：6 个文件 / **27 个测试全部通过**（其中本任务新增 5 个用例）：
     - `tests/service.test.ts`：创建协作者（name/role、空名校验）、写入空间 collaboratorIds、
       关闭并重开 SQLite 后仍持久化；
     - `tests/rpc.test.ts`：经白名单端点 `space.createAgent` → `space.listAgents`；
     - `tests/settings-page.test.ts`：设置页 SSR 渲染（AI 协作者/表单/归档/快捷键/关于、
       无 workbench 时不渲染网页链接）+ 面板壳在 `#/settings` 渲染设置页与「返回空间」。
3. **产物检查**
   - client.js：`window.__ModuleLoader__.load(` / `exports.apply` / `exports.inject` 存在；
     外置 require 仅 `react`、`react-dom`、`react/jsx-runtime`；含设置页文案与设置路由；
     `100dvh` 已全部重写为 `100%`；`kbd` 元素选择器全部限定到 `.alter-space-host kbd`
     （新增的 SettingsPage 快捷键样式也已覆盖）。
4. **安装与注册**
   - `plugin_manager remove_bundle @alter-dsh/space` → `install_bundle /Users/yifan/workspace/indie/Alter-dsh`：
     `application: applied`，warnings 空；profile 仍为 link 安装。
   - Loader 行 `include:alter-dsh-space`（`@alter-dsh/space`）`enabled: true`、`fiberPhase: active`。
   - Client Slots：`main` 槽位 occupant `alter-space` 存在且 `active: true`。
5. **数据安全**
   - 未手工读写/移动 `~/.dsh/data/space/space.db`；单元测试全部使用 `mkdtemp` 临时目录。
   - 未调用真实 `createAgent` 写入用户库（避免污染）；改用临时库 + RPC/SSR 测试覆盖。

## 限制

- 本会话没有浏览器控制能力（Web GUI 需登录态，`curl` 返回 401），无法实际点击
  「空间 → 配置 → 协作者 → 创建协作者 → 返回空间」。已用 SSR 测试覆盖面板壳路由与设置页
  渲染，用构建/静态断言覆盖产物，但**未做浏览器点击验证**。
- 已安装的是 link 包，`client.js` 在最后一次 `pnpm check`（16:02）更新；当前已打开的页面
  需要刷新（或等待 client-HMR）后才会加载新客户端产物。Host 行已重启过。
- 改动 `DocumentView.tsx` 后需要重新构建并刷新页面。

## 并发写入说明（重要）

本会话进行期间，同一工作区有另一个会话/工具在并发改动 Host 半侧（16:04–16:09 重构
`host/store.ts`、`host/rpc.ts`、`host/index.ts` 与 `src/entry.js`/`src/space-client.ts`，
移除了浏览器端 migration 并把 import 收进 Host；删除 `tests/migration.test.ts`、新增
`tests/space-client.test.ts`）。该重构一度让 `pnpm check` 变红，待其稳定后由 Lead
重新执行：**当前 `pnpm check` 全绿（27 个测试）**，本任务设置页/协作者产物与用例仍在。
`src/entry.js` 的 `SpaceShell` 装配未被打断；`host/rpc.ts` 的 `space.createAgent` 白名单
与 `tests/rpc.test.ts` 的协作者用例仍通过。

## 建议的人工验收路径

1. 刷新 DSH 页面 → 左侧「空间」→ 打开任一空间 →「配置」→「协作者」→「在设置中创建协作者」。
2. 在设置页填写「名称 / 职责」→「创建协作者」→ 列表出现新协作者 →「返回空间」。
3. 回到空间「配置」→ 协作者列表出现新条目 → 勾选 → 保存；刷新页面后仍存在
   （SQLite `agents` 表 + `spaces.collaboratorIds`）。
4. 也可在「新建空间」对话框的协作者区块选择该协作者。
