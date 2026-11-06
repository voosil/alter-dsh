# @alter-dsh/space

**完全自主的「空间」功能**：把 Space 模块作为 DSH Web 客户端插件运行，源码全部由本仓库自带，构建与安装不依赖任何其他 checkout。

此前该插件是 Alter 仓库 `plugins/dsh-space` 里的**直接迁移**版本：它原样编译 Alter 仓库中的 `@alter/ui-space`、`@alter/ui-system`、`@alter/mock-space` 等源码，只补 DSH 装配缝，因此构建必须依赖 Alter 仓库及其 `node_modules`。本仓库把相关源码复制到 [`vendor/`](vendor/VENDOR.md)，并保留同样的装配缝与构建产物格式，使「空间」成为独立、可自行构建和安装的插件。

## 包含的功能

- 空间目录与切换、新建空间、空间设置（名称、图标、外观）
- 文档：编辑器、行内评论、版本历史与比较、归档/恢复、回收站
- 随想：列表、输入、编辑、移动、删除
- 空间详情（hub）：概览（总结 / 活动热力图 / 用量）、活动、旅程、观察、配置与插件发现
- 搜索、空间归档页、恢复流程

数据层是随插件打包的浏览器本地存储（`alter.space.mock.v4`、`alter.space.hub.v1`），存储键与迁移标记与迁移版保持完全一致，因此升级不会丢失已有空间内容。

## 目录

| 路径 | 说明 |
| ---- | ---- |
| `src/` | DSH 装配缝：面板/侧栏图标注册（`entry.js`）、内存路由（`router.js`）、宿主适配样式（`host.css`）、演示数据清理与 hub 收窄（`plugin-data.js`）、最小种子（`minimal-seed.js`） |
| `vendor/` | 从 Alter 仓库复制的 Space 源码，逐字节一致，详见 [vendor/VENDOR.md](vendor/VENDOR.md) |
| `build/build.mjs` | Vite 库模式构建 → `client.js`（`window.__ModuleLoader__.load({ id, factory })` 单文件，样式内联） |
| `scripts/verify.mjs` | 静态校验：manifest、bundle patch、locale/icon、loader 格式、外置依赖、样式适配、自包含性 |
| `index.js` | Host 半侧空实现：让包成为普通 Loader 行，并把 `dsh.client` 声明接入 Web 启动图 |
| `cordis.patch.yml` | 插入 `alter-dsh-space` Loader 行 |
| `locale/`、`icon.svg` | 设置页与插件清单的展示资源 |

## 工作原理

| 层 | 来源 | 说明 |
| -- | ---- | ---- |
| 界面 | `vendor/ui-space/src`（原样编译） | `SpaceApp` 接收 `SpaceCapabilities`；只从 `SpaceApp` 入口引用，不经过含 `alterModules` 注册的包入口 |
| 数据 | `vendor/mock-space/src`（原样编译） | `createSpaceService()` + 本地 hub mock；构建期用 `src/minimal-seed.js` 替换演示种子 |
| 共享控件/主题 | `vendor/ui-system/src`（原样编译） | `--alter-*` tokens 与 Radix 控件 |
| 装配缝 | `src/entry.js`、`src/router.js` | 注册 DSH 根级 `main` keyed slot（key `alter-space`）与同 id 的 `sidebar.panellist` 图标；`SpaceRouter` 换成内存路由 |
| 构建产物 | `build/build.mjs` | Vite 库模式 → `window.__ModuleLoader__.load({ id, factory })` 单文件；CSS 内联并注入 `<style data-plugin="<包名>">` |

构建期对复制来的样式做三处适配（[`build/build.mjs`](build/build.mjs) 的 `adaptCss`），不改 `vendor/` 中的原样式文件：

1. `100dvh` 视口单位改为 `100%`，让 Space 根节点按面板盒而不是窗口计量；
2. `tokens.css` 里的 `color-scheme: light` 从 `:root` 移到 `.alter-space-host`，避免把宿主整体强制为浅色；
3. `SearchPanel.module.css` 中裸 `kbd` 元素选择器改为 `.alter-space-host kbd`，避免影响宿主自己的 `<kbd>`。

宿主窗口操作区：宿主侧栏收起（桌面端折叠，或窄窗口的抽屉模式）时，DSH 会把窗口操作区（macOS 红绿灯、展开侧栏 / 新建会话按钮）浮在主面板左上角，并通过 `--dsh-frame-leading-clearance` 发布该浮层宽度（仅在浮层挂载时存在）；`src/host.css` 据此在 Space 面板顶部预留与宿主标题栏同高的 48px 窗口条，让 Space 自己的标题行从系统控件下方开始。侧栏展开时该变量不存在，面板仍满铺。

外置依赖只有宿主基座表内的 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`；Radix、lucide、xterm 与全部 Space 代码都打进 bundle，`dsh.client.external` 无需声明。

## 构建与校验

要求：Node.js ≥ 24、pnpm。

```sh
pnpm install
pnpm build      # 生成 client.js
pnpm verify     # 静态校验（manifest / loader 格式 / 外置依赖 / 样式适配 / 自包含性）
pnpm typecheck  # vendor/ 源码类型检查
pnpm check      # build + verify + typecheck
```

`client.js` 是生成产物，不入版本库；安装或更新前必须先构建。构建只读取本仓库内的文件。

## 安装到当前 DSH profile

用 Harness 的 `plugin_manager` 工具安装本目录（绝对路径），它会 link 该目录、把包追加到 profile 的 `dsh.profile.bundles`，并插入 `cordis.patch.yml` 行。若 profile 里还装着旧的迁移版 `@alter/dsh-space`，先移除它（否则侧栏会出现两个「空间」图标）：

```json
{ "action": "remove_bundle", "target": "@alter/dsh-space" }
```

```json
{ "action": "install_bundle", "target": "/Users/yifan/workspace/indie/Alter-dsh" }
```

安装后左侧栏面板图标区出现「空间」图标，点击进入 Space 面板；设置 → 插件中显示「空间」及其说明与图标。移除：`plugin_manager` 的 `remove_bundle`，target 为 `@alter-dsh/space`。

## 与迁移版的差异

- 包名与 Loader 行 id：`@alter/dsh-space` / `alter-space` → `@alter-dsh/space` / `alter-dsh-space`（侧栏面板 id 仍为 `alter-space`，宿主观感不变）。
- 构建与校验只读取本仓库：`build.mjs` 的 alias 指向 `vendor/`，`verify.mjs` 增加「vendor 源码存在」与「源文件不引用其他 checkout」两项检查。
- locale 元数据改为「空间 / Space」的独立实现描述。
- 其余行为、数据层、存储键、样式适配与迁移版一致（Space 界面与数据层代码零改动）。

## 已知降级 / 边界

- **Workbench 右侧面板**（`vendor/ui-workbench`）属于独立设计范围，本插件不装配 `workbench` 能力；因此文档/详情页不显示 Workbench 开关，概览的「继续工作」类入口退化为提示或静默。Space 源码已把该能力当可选项，其余视图完整可用。
- 真实终端、真实 Agent 对话、跨设备同步：数据层仍是设计阶段 mock。
- 浏览器地址栏路由：面板切换会保留当前内存路由，刷新页面回到默认文档；「复制链接」类按钮在 DSH 下不可用。
- Space 面板打开时，其全局快捷键（如 Cmd/Ctrl+K 搜索、Cmd/Ctrl+E）会优先于宿主快捷键；切回对话面板后监听随组件卸载清理。
- Space 按产品设计始终使用浅色主题；宿主深色模式下该面板仍为浅色。
- `xterm` 因 Space 源码对 `vendor/ui-workbench` 的静态引用被打进 bundle，但 v1 不渲染 Workbench，不会实例化终端。

## 验证状态

见本次交付报告。
