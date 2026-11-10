# Space sources

`vendor/` 存放 Space 功能的协议、业务服务与 UI 源码，是项目自有源码目录；浏览器 bundle 由
`build/build.mjs` 从这里编译，Host 半侧用 `host/store.ts` 持久化并组合 `vendor/service` 的业务服务。
构建与运行不读取仓库之外的任何路径。

本文件只维护**当前生效**的目录职责、构建期覆盖与行为约定。历史改动见 git 历史，不在此追加变更流水账。

## 目录

| 目录 | 内容 |
| --- | --- |
| `client-modules/` | 客户端模块注册表类型（bundle 内仅类型） |
| `mock-workbench/` | Workbench 数据类型（Space 视图引用；不挂载 Workbench） |
| `protocol/` | 产品数据协议（前后端共享；含声明式组件目录） |
| `service/` | Space 业务服务（content + hub + store 契约） |
| `ui-settings/` | 设置页源码（协作者、归档空间恢复、快捷键、关于） |
| `ui-space/` | Space UI（目录、评论、随想、概览、归档、回收站） |
| `ui-system/` | 共享控件与设计 token |
| `ui-workbench/` | Workbench 面板（Space 视图引用；未挂载） |

## 构建期模块覆盖与别名

当前只有一个模块级覆盖，由 `build/build.mjs` 注册：

- **工作目录字段**：把 `CreateSpaceDialog.tsx` → `./DirectoryField` 与
  `ConfigView.tsx` → `../components/DirectoryField` 重定向到 `src/native-directory-field.tsx`。
  覆盖组件打开宿主目录选择器（桌面=系统对话框，Web=DSH 浏览），无选择器时回退内置目录浏览器。

文档视图不做模块覆盖：`@alter-space/document-view` 别名指向 `src/document/` 的插件结构化视图，
别名在 `build/build.mjs` 的 alias 与 `tsconfig.json` 的 `paths` 两处声明，必须保持同步。

其余导入（含覆盖模块内部对原实现的引用）保持原解析。

新增覆盖或别名必须同时改 `build/build.mjs`（及 `tsconfig.json`）并更新本节清单；
不要在其他位置散落覆盖逻辑。

## 关键行为约定

- **正文只有 AST**：文档正文只有 `alter-doc/1` AST 一种格式，正文写入只经 Document Operations，
  `space.saveNode` 只改标题等元数据。
- **文档编辑面归属**：文档编辑器、评论/历史、组件渲染等编辑面在 `src/document/`；`vendor/ui-space`
  只保留文档入口与外壳（目录/评论列表/随想/概览/归档/回收站），不在本目录重建编辑器。
  声明式组件目录在 `vendor/protocol`，Host 校验、客户端静态渲染，不执行任意代码。
- **设计 token**：圆角统一走 `--alter-radius-xs/control/panel/overlay/pill` 五级 token，
  不写字面量；宿主容器内的样式必须限定作用域，不泄漏到文档根。
- **协议与持久化分离**：`vendor/service/src/store.ts` / `index.ts` 只是 SpaceStore 契约参考；
  运行时持久化由 `host/store.ts` 实现（每集合一张 STRICT 表 + JSON 数据列、`hub`、`meta`；
  数组顺序存 `meta`；单写者队列 + 每笔更新一个事务；`PRAGMA user_version` 管理结构版本）。
  修改 `vendor/service` 的实体结构时，必须同步检查 `host/store.ts` 的映射与迁移。
- **设置页**：`vendor/ui-settings` 保留设置页源码；面板的 `#/settings` 由 `src/settings-page.tsx`
  渲染（含「存储与备份」），不挂载该源码页面。

## 修改规则

- 新增逻辑优先放 `host/`、`src/`；只有必须落在协议/服务/UI 内部时才改本目录。
- 改 `vendor/` 时保持上表约定与既有契约；行为/契约变化必须同步更新 `docs/specs/` 中对应规范
  （及 `docs/designs/` 中记录的决策），并在 commit message 里写明原因。
- 不要在本文件追加改动日志；文档只写当前有效内容，历史交给 git。
