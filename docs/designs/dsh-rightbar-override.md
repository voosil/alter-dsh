---
type: design
status: active
updated: 2026-11-15
---

# DSH 右侧栏覆盖包（Loader 覆盖）

产品设计（`docs/specs/space-chat-v0.md`）要求「空间主界面在左、DSH 右侧栏在右」。上游
`@deepseek-ai/dsh-client-ui-sidebar-right` 只在会话占据主区时渲染右栏——README 原话
「No surface without a session」，源码 `shell/RightbarRoot.tsx` 的
`usePanelInfo(info => info.activePanelId === null)` 就是那道门。插件无法从外部改它，因为
`rightbar` 是单占位槽位，已由官方右栏占用。

`overrides/rightbar/` 用 **Loader 覆盖**（不动 `app.asar`）替换那条门：

- `lib/client.js` 是官方产物的逐字节副本，只改两处：
  1. 座席可见性：`usePanelInfo(info => info.activePanelId === null)` → `usePanelInfo(() => true)`；
  2. 屏上会话：`show(activePanelId === null ? selected : undefined)` → `show(selected)`，
     即「选中的会话」不再要求对话占据主区。
  3. 模块 id 同步为 `@alter-dsh/rightbar-host`（浏览器模块表的 id 必须等于包名）。
- `cordis.patch.yml` 关掉官方条目 `ui-sidebar-right`，插入本包。
- `lib/index.js` 官方 Host 半边是空 `apply`，原样保留；`locale/` 原样复制。

## 行为变化

右栏从此**与主面板无关**：只要存在选中的会话，它就在空间面板、插件页等任一主面板旁边渲染，
展示该会话的标签（空间页面 / 对话 / 侧边对话）。没有选中会话时没有可渲染的面，右栏不出现。

## 重新应用（DSH 升级后）

升级会带来新的官方产物，本覆盖需要重做：

```sh
# 1. 取当前安装版本的包目录
dsh_pkg="$(dirname "$(dirname "$(readlink -f "$(command -v dsh)")")")"   # 或以应用实际路径为准
# 2. 覆盖本目录的 lib/ 与 locale/
# 3. 重新应用两处替换（见上），并把 id 改为 @alter-dsh/rightbar-host
```

然后用 `plugin_manager` 重新 `install_bundle` 本目录（先 `remove_bundle`）。

## 撤销

```sh
plugin_manager: remove_bundle '@alter-dsh/rightbar-host'
```

移除后 Loader 回到官方条目，右栏恢复「仅会话页」的行为；空间主界面的右栏开关会退化为
`unavailable`（界面会说明原因，不会假装成功）。
