# Vendored Space sources

The directories under `vendor/` are **byte-identical copies** of Space source
files from the upstream Alter repository, with one documented product
adaptation (see below). The browser bundle compiles the UI sources in place
([`build/build.mjs`](../build/build.mjs)); the Host half uses
[`host/store.ts`](../host/store.ts) as its SQLite persistence layer and the
vendored `service/` business logic. No other checkout is read at build or run
time.

## Provenance

| Item | Value |
| ---- | ----- |
| Upstream repository | `/Users/yifan/workspace/indie/Alter` (local checkout) |
| Commit | `3ec2adb0ac77371e118908a08276de41e43132aa` — *feat(ui-space): 空间下拉的子菜单从浮层右侧展开* (2026-11-06 09:27:51 +0800) |
| Working tree | includes two uncommitted CSS edits from the same checkout (`OverviewInsights.module.css`, `OverviewView.module.css`) — the bundle build at vendoring time used that state. This checkout also carries one local edit inside `ui-space/src/views/DocumentView.tsx` (silent auto-save indicator) that is **not** in the upstream commit — restore it from upstream or sync it upstream before release. |
| Copied at | 2026-11-06 (UI sources) / 2026-11-06 (business service) / 2026-11-06 (settings page) |
| Copied tree hash | `find vendor -type f ! -name VENDOR.md -print0 \| sort -z \| xargs -0 shasum \| shasum` → `a08f6567b23593e668067f2d7ab549103559a876` |

| `vendor/` directory | Upstream path | Contents |
| ------------------- | ------------- | -------- |
| `ui-space/` | `packages/client/ui-space/src` | Space UI: directory, editor, comments, thoughts, hub, archive, trash |
| `ui-settings/` | `packages/client/ui-settings/src` | settings page reused by the panel shell: AI collaborators, archived-space restore, shortcuts, about |
| `ui-system/` | `packages/client/ui-system/src` | shared controls (Radix) and `--alter-*` design tokens |
| `ui-workbench/` | `packages/client/ui-workbench/src` | Workbench panels referenced by Space views (not mounted by the plugin) |
| `mock-workbench/` | `packages/mock-services/workbench/src` | Workbench data types used by Space views |
| `protocol/` | `packages/core/protocol/src` | product data contracts (shared by both halves) |
| `client-modules/` | `packages/core/client-modules/src` | client module registry types (type-only in this bundle) |
| `service/` | `packages/services/space/src` | the real Host Space business service (content + hub + upstream store/contracts) |

## Product adaptation in vendored UI

`vendor/ui-space/src/views/DocumentView.tsx` intentionally removes the
「保存中…」 indicator from the document header: the Host autosave is silent and
only surfaces `保存失败，重试` on real failures. This is the only non-comment
change in the vendored Space UI; re-apply it when syncing that file from
upstream.

## Host persistence adaptation

`vendor/service/src/store.ts` and `index.ts` are kept byte-identical as the
upstream reference. The plugin's runtime persistence is
[`host/store.ts`](../host/store.ts), which implements the same `SpaceStore`
contract (`vendor/service/src/contracts.ts`) on top of SQLite:

- one `STRICT` table per collection with a JSON `data` column, plus `hub` and
  `meta`; array order is kept in `meta`;
- single-writer queue + one SQLite transaction per update; only changed rows are
  written;
- corruption backup/recreate and schema versioning through
  `PRAGMA user_version`.

`host/authority.ts` composes the vendored `createHubService` +
`createContentService` over that store exactly like the upstream
`createSpaceService` assembly.

The plugin seam files (`src/`, `build/`, `scripts/`, `package.json`,
`cordis.patch.yml`, `locale/`, `icon.svg`) originate from the upstream
`plugins/dsh-space` package and were adapted for this repository: browser
data now lives behind the Host RPC channel, the old mock data layer was
removed, and the package name/loader row/locale metadata identify the
standalone `@alter-dsh/space` package.

`vendor/ui-settings` is the upstream Space settings page: AI collaborator
creation, archived-space restore, shortcuts and about. Upstream registers it as
a separate `settings` client module; the DSH port reuses only `SettingsPage.tsx`
through `src/space-shell.tsx`, which routes the panel's in-memory `#/settings`
path (the route the vendored Space links already navigate to) and provides the
way back to the Space routes. The Workbench-only link preference is not mounted,
matching the plugin's Workbench boundary.

## Syncing from upstream

1. Copy the same upstream directories over `vendor/` (keep the layout above).
2. Re-run `pnpm build` and `pnpm check`; UI sources need no edits unless the
   upstream build assumptions change. Compare `host/store.ts` against upstream
   `store.ts` when the persistence contract changes.
3. Update the provenance table (commit, date, tree hash) in this file.

Upstream packages that are **not** copied: the Alter host application
(`apps/web`), the DSH bridge/launcher (`packages/dsh/*`), and the remaining
Alter client modules. This repository only carries what the DSH Space panel
needs.

## 待回灌上游的 issue 修复

本沙箱只允许写本仓库，以下 `vendor/` 改动是对上游源码的本地偏离，按 Issues
条目记录，待之后同步回上游 Alter 对应路径并删除本节记录。

| 日期 | Issues 条目 | 改动文件 | 一句话说明 |
| ---- | ----------- | -------- | ---------- |
| 2026-11-06 | 文档行内高亮功能：选中文字是灰色的，点击高亮后显示的高亮颜色被选中文字时的灰色背景覆盖了，需要取消选中文字后才能看到高亮色，体验不是很好。 | `vendor/ui-space/src/components/editor/Editor.module.css` | 编辑器内文字选区背景改为半透明，选中时行内高亮（`mark`）等文字背景色仍可见，无需取消选中。回灌目标：`packages/client/ui-space/src/components/editor/Editor.module.css`。 |
| 2026-11-09 | border-radius token规范化并调整，减少可选值数量，整体上采用比较圆润的风格 | `vendor/ui-system/src/styles/tokens.css`（新增 `--alter-radius-xs/pill`，control 8→10、panel 12→16），`vendor/ui-space/**/*.module.css`、`vendor/ui-settings/src/SettingsPage.module.css`、`vendor/ui-system/src/components/navigation-button/NavigationButton.module.css`（26 个文件、97 处字面圆角改为 token） | 圆角收敛为 xs/control/panel/overlay/pill 五级（2–6px→6、7–10px→10、12–16px→16、24 与 999 保留语义），整体调圆；`50%` 圆形与 `0` 不含在内，`src/host.css` 的 control 回退值同步为 10px。回灌目标：上游 `packages/client/ui-system/src/styles/tokens.css` 及对应 `packages/client/*/src/**/*.module.css`；回灌时需同步更新上游 `DESIGN.md` 的圆角规范（原写 control 8/7、panel 12、弹层 16、行内 3–4）。 |
| 2026-11-09 | 文档目录的功能按钮将归档功能放到“一级菜单”，hover可以直接点击归档icon归档文档 | `vendor/ui-space/src/components/Directory.tsx`、`vendor/ui-space/src/components/Directory.module.css` | 目录文档行的 hover 一级操作区新增「归档」图标按钮，悬停文档行即可直接点击归档；「更多操作」菜单里不再重复提供未归档文档的归档项（归档文档仍保留取消归档），行操作区宽度按操作数量（one/two/three）自适应。回灌目标：`packages/client/ui-space/src/components/Directory.tsx` 与 `Directory.module.css`。 |
| 2026-11-09 | 设置页（协作者部分）：创建协作者入口移到空间配置页，改为专用弹窗，包含名称、职责、描述、使用的模型与权限等设置项。 | `vendor/protocol/src/space.ts`、`vendor/service/src/service.ts`、`vendor/ui-space/src/components/CreateAgentDialog.tsx`（新增 `CreateAgentDialog.tsx` / `CreateAgentDialog.module.css`）、`vendor/ui-space/src/views/ConfigView.tsx`/`ConfigView.module.css`、`vendor/ui-space/src/components/CreateSpaceDialog.tsx`/`CreateSpaceDialog.module.css`、`vendor/ui-settings/src/SettingsPage.tsx`/`SettingsPage.module.css` | 协作者创建入口从设置页移到空间详情 → 配置，改为专用弹窗（名称/职责/描述/模型/权限）；协议与服务为 `Agent` 增加描述、模型、权限三个可选字段，创建后自动加入当前空间的协作者草稿。模型与权限目前是产品级元数据，不驱动 DSH Agent 运行时。回灌目标：上游 `packages/core/protocol/src/space.ts`、`packages/services/space/src/service.ts`、`packages/client/ui-space/src/{components,views}/**`、`packages/client/ui-settings/src/**`。 |
| 2026-11-09 | 空间菜单中的“空间详情”item用icon直接显示到hover后显示的菜单中，不用再进三级菜单再打开 | `vendor/ui-space/src/components/Sidebar.tsx`、`vendor/ui-space/src/components/Sidebar.module.css` | 空间下拉列表的空间行 hover 一级操作区新增「空间详情」图标按钮（`SlidersHorizontal`），点击关闭下拉并直达该空间详情（概览）；「空间操作」子菜单里不再重复提供「详情」，仅保留「复制空间链接」。回灌目标：`packages/client/ui-space/src/components/Sidebar.tsx` 与 `Sidebar.module.css`。 |
| 2026-11-09 | 空间中搜索弹窗的输入框focus后显示的border/outline看起来上下没有任何padding，看起来很奇怪，优化一下样式；弹窗中“最近更新”文案和下方的items左侧没有对齐；位置略高，稍微低一些。 | `vendor/ui-space/src/components/SearchPanel.module.css` | 搜索弹窗三处样式调整：输入框高度由铺满 48px 行高收敛为 34px 并补齐水平内边距，聚焦描边上下留出约 6px 空隙、不再贴住上下分隔线；分组标题左缩进 35px（行内缩进 9 + 图标 16 + 间距 10），与结果标题左对齐；浮层顶部间距 16vh→18vh，弹窗整体略下移。回灌目标：`packages/client/ui-space/src/components/SearchPanel.module.css`。 |
| 2026-11-09 | 空间中搜索弹窗 整体优化一下，做到极简。不显示footer的快捷键说明，文档item不显示谁创建的；“最近更新”文案和下面item的最左侧对齐（现在是和文档的名称对齐了，但文档左侧还有icon和padding） | `vendor/ui-space/src/components/SearchPanel.tsx`、`vendor/ui-space/src/components/SearchPanel.module.css` | 搜索弹窗极简化：移除底部快捷键说明（键盘行为保留）、移除「最近更新」条目的「创建者」行并改为单行标题（图标与标题垂直居中）、去掉输入行分隔线；分组标题改为与条目内容左缘（图标左缘）对齐而非与标题文字对齐。回灌目标：`packages/client/ui-space/src/components/SearchPanel.tsx` 与 `SearchPanel.module.css`。 |
