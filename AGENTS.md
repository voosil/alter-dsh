# AGENTS.md — Alter-dsh

本仓库是「空间」（Space）功能的自包含 DSH Web 客户端插件（包名
`@alter-dsh/space`）。它把 Space 界面与数据层源码复制到 `vendor/`，加上 DSH
装配缝（`src/`）与构建/校验脚本，构建和安装都不读取其他 checkout。

## 常用命令

```sh
pnpm install      # 首次或依赖变化后
pnpm build        # 生成 client.js（生成产物，不入库）
pnpm verify       # 静态校验
pnpm typecheck    # vendor/ 源码类型检查
pnpm check        # build + verify + typecheck
```

安装/更新到当前 DSH profile：先用 `plugin_manager` 的 `remove_bundle`
移除同名旧包（首次安装可跳过），再 `install_bundle` 目标为本仓库绝对路径。
不要手写 profile 的 `package.json` / `cordis.patch.yml`。

## 结构

- `vendor/`：从 Alter 仓库复制的 Space 源码，**逐字节一致，不要直接改**。
  来源、提交与同步方法见 `vendor/VENDOR.md`。
- `src/`：DSH 装配缝（面板注册、内存路由、宿主样式、数据清理、最小种子）。
- `build/build.mjs`：alias `@alter/*` 到 `vendor/*/src`，Vite 库模式打包为
  `window.__ModuleLoader__.load({ id, factory })` 单文件。
- `scripts/verify.mjs`：静态校验（manifest、loader、外置依赖、样式适配、自包含）。
- `README.md`：功能、原理、安装与已知边界。

## 约定

- 改 Space 产品行为应优先改 `vendor/` 对应源码并同步回 Alter 上游；本仓库不
  单独分叉 UI/数据层代码，除非任务明确要求。
- 构建期适配（`adaptCss`）只在 `build/build.mjs` 中进行，不改原样式文件。
- 外置依赖仅限 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`；
  新增第三方库必须打进 bundle。
- 存储键（`alter.space.mock.v4`、`alter.space.hub.v1` 等）不要改名，否则用户
  已有空间内容会丢失。
- 面板 id `alter-space` 与侧栏图标注册的对应关系属于宿主装配契约，改动前先确认
  DSH Client slot API。
