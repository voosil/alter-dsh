# Space sources

`vendor/` 存放 Space 功能的协议、业务服务与 UI 源码，是项目自有源码目录；浏览器 bundle 由 `build/build.mjs` 从这里编译，Host 半侧用 `host/store.ts` 持久化并组合 `vendor/service` 的业务服务。构建与运行不读取仓库之外的任何路径。

## 目录

| 目录 | 内容 |
| --- | --- |
| `client-modules/` | 客户端模块注册表类型（bundle 内仅类型） |
| `mock-workbench/` | Workbench 数据类型（Space 视图引用；不挂载 Workbench） |
| `protocol/` | 产品数据协议（前后端共享） |
| `service/` | Space 业务服务（content + hub + store 契约） |
| `ui-settings/` | 设置页源码（协作者、归档空间恢复、快捷键、关于） |
| `ui-space/` | Space UI（目录、编辑器、评论、随想、概览、归档、回收站） |
| `ui-system/` | 共享控件与设计 token |
| `ui-workbench/` | Workbench 面板（Space 视图引用；未挂载） |

## 源码说明

`vendor/ui-space/src/views/DocumentView.tsx` 的保存指示器为静默自动保存，只在失败时提示「保存失败，重试」。修改该文件时保持此行为。

## 构建期模块覆盖

`vendor/ui-space/src/components/DirectoryField.tsx` 的工作目录字段在构建期被替换：`build/build.mjs` 把两处导入（`CreateSpaceDialog.tsx` → `./DirectoryField`、`ConfigView.tsx` → `../components/DirectoryField`）重定向到 `src/native-directory-field.tsx`。覆盖组件打开宿主目录选择器（桌面=系统对话框，Web=DSH 浏览），无选择器时回退内置目录浏览器。其余导入（包括覆盖组件内部的回退导入）保持原解析。

## Host 持久化对接

`vendor/service/src/store.ts` / `index.ts` 是 SpaceStore 契约参考；运行时持久化由 `host/store.ts` 实现（每集合一张 STRICT 表 + JSON 数据列、`hub`、`meta`；数组顺序存 `meta`；单写者队列 + 每笔更新一个事务；`PRAGMA user_version` 管理结构版本；损坏备份/重建）。`host/authority.ts` 用该 store 组合 `createHubService` + `createContentService`。

`vendor/ui-settings` 保留为设置页源码；面板的 `#/settings` 由 `src/settings-page.tsx` 渲染（含「存储与备份」），不挂载该源码页面。

## 本地变更记录

修改 `vendor/` 文件必须在此登记；新增逻辑优先放 `host/`、`src/`，只有必须落在协议/服务/UI 内部时才改本目录。

| 日期 | 改动 | 文件 | 说明 |
| --- | --- | --- | --- |
| 2026-11-06 | 文档行内高亮功能：选中文字是灰色的，点击高亮后显示的高亮颜色被选中文字时的灰色背景覆盖了，需要取消选中文字后才能看到高亮色，体验不是很好。 | `vendor/ui-space/src/components/editor/Editor.module.css` | 编辑器内文字选区背景改为半透明，选中时行内高亮（`mark`）等文字背景色仍可见，无需取消选中 |
| 2026-11-09 | border-radius token规范化并调整，减少可选值数量，整体上采用比较圆润的风格 | `vendor/ui-system/src/styles/tokens.css`（新增 `--alter-radius-xs/pill`，control 8→10、panel 12→16），`vendor/ui-space/**/*.module.css`、`vendor/ui-settings/src/SettingsPage.module.css`、`vendor/ui-system/src/components/navigation-button/NavigationButton.module.css`（26 个文件、97 处字面圆角改为 token） | 圆角收敛为 xs/control/panel/overlay/pill 五级（2–6px→6、7–10px→10、12–16px→16、24 与 999 保留语义），整体调圆；`50%` 圆形与 `0` 不含在内，`src/host.css` 的 control 回退值同步为 10px |
| 2026-11-09 | 文档目录的功能按钮将归档功能放到“一级菜单”，hover可以直接点击归档icon归档文档 | `vendor/ui-space/src/components/Directory.tsx`、`vendor/ui-space/src/components/Directory.module.css` | 目录文档行的 hover 一级操作区新增「归档」图标按钮，悬停文档行即可直接点击归档；「更多操作」菜单里不再重复提供未归档文档的归档项（归档文档仍保留取消归档），行操作区宽度按操作数量（one/two/three）自适应 |
| 2026-11-09 | 设置页（协作者部分）：创建协作者入口移到空间配置页，改为专用弹窗，包含名称、职责、描述、使用的模型与权限等设置项。 | `vendor/protocol/src/space.ts`、`vendor/service/src/service.ts`、`vendor/ui-space/src/components/CreateAgentDialog.tsx`（新增 `CreateAgentDialog.tsx` / `CreateAgentDialog.module.css`）、`vendor/ui-space/src/views/ConfigView.tsx`/`ConfigView.module.css`、`vendor/ui-space/src/components/CreateSpaceDialog.tsx`/`CreateSpaceDialog.module.css`、`vendor/ui-settings/src/SettingsPage.tsx`/`SettingsPage.module.css` | 协作者创建入口从设置页移到空间详情 → 配置，改为专用弹窗（名称/职责/描述/模型/权限）；协议与服务为 `Agent` 增加描述、模型、权限三个可选字段，创建后自动加入当前空间的协作者草稿。模型与权限目前是产品级元数据，不驱动 DSH Agent 运行时 |
| 2026-11-09 | 空间详情 → 配置页整体优化：去掉分区横线，删解释性文案，权限与插件收敛 | `vendor/ui-space/src/views/ConfigView.tsx`、`ConfigView.module.css`、`vendor/ui-space/src/hub/SpaceSettings.tsx`、`Hub.module.css`、`vendor/ui-space/src/views/SpaceDetailShell.tsx`、`SpaceDetailShell.module.css` | 配置页与 DSH 设置页统一为「左标题 + 右内容 + 留白分区」的无分割线语言；分区顺序改为 基本信息 / 工作目录 / 协作者 / 决定权限 / 空间插件 / 空间管理，并删掉各分区右侧的解释性 note；「Agent 的决定权限」从三张说明卡收成一行分段控件、只解释当前档位；「空间插件」只要内置插件标记「内置」，去掉「保持开启」与禁用开关；归档/删除只留操作行，说明放回确认弹窗；保存条贴底常驻、用渐隐代替上边框（shell 增加 `data-active` 与配置页无标题横线规则） |
| 2026-11-09 | 空间菜单中的“空间详情”item用icon直接显示到hover后显示的菜单中，不用再进三级菜单再打开 | `vendor/ui-space/src/components/Sidebar.tsx`、`vendor/ui-space/src/components/Sidebar.module.css` | 空间下拉列表的空间行 hover 一级操作区新增「空间详情」图标按钮（`SlidersHorizontal`），点击关闭下拉并直达该空间详情（概览）；「空间操作」子菜单里不再重复提供「详情」，仅保留「复制空间链接」 |
| 2026-11-09 | 空间中搜索弹窗的输入框focus后显示的border/outline看起来上下没有任何padding，看起来很奇怪，优化一下样式；弹窗中“最近更新”文案和下方的items左侧没有对齐；位置略高，稍微低一些。 | `vendor/ui-space/src/components/SearchPanel.module.css` | 搜索弹窗三处样式调整：输入框高度由铺满 48px 行高收敛为 34px 并补齐水平内边距，聚焦描边上下留出约 6px 空隙、不再贴住上下分隔线；分组标题左缩进 35px（行内缩进 9 + 图标 16 + 间距 10），与结果标题左对齐；浮层顶部间距 16vh→18vh，弹窗整体略下移 |
| 2026-11-09 | 空间中搜索弹窗 整体优化一下，做到极简。不显示footer的快捷键说明，文档item不显示谁创建的；“最近更新”文案和下面item的最左侧对齐（现在是和文档的名称对齐了，但文档左侧还有icon和padding） | `vendor/ui-space/src/components/SearchPanel.tsx`、`vendor/ui-space/src/components/SearchPanel.module.css` | 搜索弹窗极简化：移除底部快捷键说明（键盘行为保留）、移除「最近更新」条目的「创建者」行并改为单行标题（图标与标题垂直居中）、去掉输入行分隔线；分组标题改为与条目内容左缘（图标左缘）对齐而非与标题文字对齐 |
| 2026-11-09 | 空间设置的入口还是没有 | `vendor/ui-space/src/components/Sidebar.tsx`、`vendor/ui-space/src/components/Sidebar.module.css` | 目录侧栏页脚新增「空间设置」入口（齿轮图标，右侧，提示框右对齐）：点击导航到 `#/settings`，由 DSH 面板外壳 `src/space-shell.tsx` 渲染复用自项目的设置页（协作者、归档管理、快捷键、关于）与「存储与备份」；页脚改为左右两组布局，左侧仍是当前空间的随想/归藏/回收站 |
| 2026-11-09 | 空间详情页的活动记录重新定一下“什么值得记”：信息太琐碎，一次文档修改也被记录就是噪声；系统日志、数据库可以记，但这里只展示用户真正关心的 | `vendor/service/src/service.ts`、`vendor/ui-space/src/views/activity/ContributionTimeline.tsx` | 活动记录从「编辑流水」收敛为「空间纪事」：只记空间创建、文档新建（有标题或正文，空白草稿不算）、用户主动归档文档、Alter 的行动（AgentEvent）；文档每次编辑/自动保存/版本快照（版本历史）、随想（随想视图；转成文档时按新建文档记一条）、评论（文档评论栏）、事项（端口内暂无数据源）、打开文档与活跃度、闲置自动归档、系统行为一律不记，仍完整保留在数据库里。空状态说明「日常编辑保存在文档的版本历史里」 |
