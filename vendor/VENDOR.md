# Vendored Space sources

The directories under `vendor/` are **byte-identical copies** of Space source
files from the upstream Alter repository. They are compiled in place by
[`build/build.mjs`](../build/build.mjs); no other checkout is read at build or
run time.

## Provenance

| Item | Value |
| ---- | ----- |
| Upstream repository | `/Users/yifan/workspace/indie/Alter` (local checkout) |
| Commit | `3ec2adb0ac77371e118908a08276de41e43132aa` — *feat(ui-space): 空间下拉的子菜单从浮层右侧展开* (2026-11-06 09:27:51 +0800) |
| Working tree | includes two uncommitted CSS edits from the same checkout (`OverviewInsights.module.css`, `OverviewView.module.css`) — the bundle build at vendoring time used that state |
| Copied at | 2026-11-06 |
| Copied tree hash | `find vendor -type f -print0 \| sort -z \| xargs -0 shasum \| shasum` → `d104599db711083d1036cc4acdaaee3ba11018e6` |

| `vendor/` directory | Upstream path | Contents |
| ------------------- | ------------- | -------- |
| `ui-space/` | `packages/client/ui-space/src` | Space UI: directory, editor, comments, thoughts, hub, archive, trash |
| `ui-system/` | `packages/client/ui-system/src` | shared controls (Radix) and `--alter-*` design tokens |
| `ui-workbench/` | `packages/client/ui-workbench/src` | Workbench panels referenced by Space views (not mounted by the plugin) |
| `mock-space/` | `packages/mock-services/space/src` | browser-local Space data layer used by this plugin |
| `mock-workbench/` | `packages/mock-services/workbench/src` | Workbench data types used by Space views |
| `protocol/` | `packages/core/protocol/src` | product data contracts |
| `client-modules/` | `packages/core/client-modules/src` | client module registry types (type-only in this bundle) |

`src/`, `build/`, `scripts/`, `index.js`, `cordis.patch.yml`, `locale/` and
`icon.svg` were copied from upstream `plugins/dsh-space` and then adapted to
build from `vendor/` and to run as the self-contained `@alter-dsh/space`
package (package name, loader row id, locale metadata). No Space UI or data
layer file was edited.

## Syncing from upstream

1. Copy the same upstream directories over `vendor/` (keep the layout above).
2. Re-run `node build/build.mjs` and `node scripts/verify.mjs`; the Space code
   needs no edits unless the upstream build assumptions change.
3. Update the provenance table (commit, date, tree hash) in this file.

Upstream packages that are **not** copied: the Alter host application
(`apps/web`), the real host-side Space service (`packages/services/space`), the
DSH bridge/launcher (`packages/dsh/*`), and every other Alter client module.
This repository only carries what the DSH Space panel needs.

## 待回灌上游的 issue 修复

本沙箱只允许写本仓库，以下 `vendor/` 改动是对上游源码的本地偏离，按 Issues
条目记录，待之后同步回上游 Alter 对应路径并删除本节记录。

| 日期 | Issues 条目 | 改动文件 | 一句话说明 |
| ---- | ----------- | -------- | ---------- |
| 2026-11-06 | 文档行内高亮功能：选中文字是灰色的，点击高亮后显示的高亮颜色被选中文字时的灰色背景覆盖了，需要取消选中文字后才能看到高亮色，体验不是很好。 | `vendor/ui-space/src/components/editor/Editor.module.css` | 编辑器内文字选区背景改为半透明，选中时行内高亮（`mark`）等文字背景色仍可见，无需取消选中。回灌目标：`packages/client/ui-space/src/components/editor/Editor.module.css`。 |
