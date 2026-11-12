# Space sources

`vendor/` 存放 Space 功能的协议、业务服务与 UI 源码，是项目自有源码目录；浏览器 bundle 由
`build/build.mjs` 从这里编译，Host 半侧用 `host/persistence/store.ts` 持久化并组合 `vendor/service` 的业务服务。
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
| `ui-space/` | Space UI（目录、文档页壳层与冻结样式、评论、随想、概览、归档、回收站） |
| `ui-system/` | 共享控件与设计 token |
| `ui-workbench/` | Workbench 面板（Space 视图引用；未挂载） |

## 构建期模块覆盖与别名

当前只有一个模块级覆盖，由 `build/build.mjs` 注册：

- **工作目录字段**：把 `CreateSpaceDialog.tsx` → `./DirectoryField` 与
  `ConfigView.tsx` → `../components/DirectoryField` 重定向到 `src/app/native-directory-field.tsx`。
  覆盖组件打开宿主目录选择器（桌面=系统对话框，Web=DSH 浏览），无选择器时回退内置目录浏览器。

另有一个插件自有别名：`@alter-space/document-runtime` 指向 `src/document/runtime/index.ts`。文档运行时
是内核无关的共享层：保存生命周期（防抖/单飞/冲突）、草稿与崩溃恢复、快照、Operations diff、评论锚点、
错误上报，以及历史预览、导出与粘贴导入用的冻结 HTML 投影/解析。别名在 `build/build.mjs` 的 alias、
`tsconfig.json` 的 `paths` 与 `vitest.config.mts` 三处声明，必须保持同步；它只由客户端 bundle 解析，
Host 编译面（`tsconfig.host.json`）不包含 `vendor/ui-space`，这是有意的分层边界。

其余导入（含覆盖模块内部对原实现的引用）保持原解析。

新增覆盖或别名必须同时改 `build/build.mjs`（及 `tsconfig.json`、`vitest.config.mts`）并更新本节
清单；不要在其他位置散落覆盖逻辑。

## 关键行为约定

- **归属由写入身份派生，不可转移**：边界身份 `SpaceActor`（`user`/`alter`）在协议包一处映射为
  实体词表（`creatorOf`：`me`/`alter`；`archiveSourceOf`：`user`/`agent`）。content/hub 服务与
  DocumentService 都在构造时绑定 actor，创建路径（节点/随想/评论/补充/版本/事项/事件）一律派生，
  不接受按调用传入的身份；`convertThought` 的新节点归属当前身份，`restoreNode` 不改已有归属。
  闲置自动归档两个栈都写 `system`。持久化层（`host/persistence/attribution.ts`）是唯一守卫：
  同一事务内校验「新增实体归属=当前身份、已有归属不可变、补充只增不改、archivedBy 只能变为
  null/当前身份来源/system」，违反即回滚；无 actor 的 update 禁止新增带归属实体。
  历史行加载时回填：随想 `creator→me`、事件 `source→agent`（不改结构版本）。
- **正文只有 AST**：文档正文只有 `alter-doc/1` AST 一种格式，正文写入只经 Document Operations，
  `space.saveNode` 只改标题等元数据。
- **文档编辑面冻结体验、不冻结实现**：文档页与基线（本目录旧 UI）保持视觉与交互 parity——壳层、CSS
  （含冻结的 `Editor.module.css`）与各面板视觉不改。编辑器内核唯一为 AST 原生 Tiptap
  （`src/document/editors/tiptap`），旧 contentEditable 内核已退役；客户端经
  `@alter-space/document-runtime` → Document Operations 写入。组件目录在 `vendor/protocol`（Host 校验），
  旧 UI 暂把 callout/mindmap/component 显示为对象占位卡。
- **设计 token**：圆角统一走 `--alter-radius-xs/control/panel/overlay/pill` 五级 token，
  不写字面量；宿主容器内的样式必须限定作用域，不泄漏到文档根。
- **协议与持久化分离**：`vendor/service/src/store.ts` / `index.ts` 只是 SpaceStore 契约参考；
  运行时持久化由 `host/persistence/store.ts` 实现（每集合一张 STRICT 表 + JSON 数据列、`hub`、`meta`；
  数组顺序存 `meta`；单写者队列 + 每笔更新一个事务；`PRAGMA user_version` 管理结构版本）。
  修改 `vendor/service` 的实体结构时，必须同步检查 `host/persistence/store.ts` 的映射与迁移。
- **设置页**：`vendor/ui-settings` 保留设置页源码；面板的 `#/settings` 由 `src/settings/page.tsx`
  渲染（含「存储与备份」），不挂载该源码页面。

## 修改规则

- 新增逻辑优先放 `host/`、`src/`；只有必须落在协议/服务/UI 内部时才改本目录。
- 改 `vendor/` 时保持上表约定与既有契约；行为/契约变化必须同步更新 `docs/specs/` 中对应规范
  （及 `docs/designs/` 中记录的决策），并在 commit message 里写明原因。
- 不要在本文件追加改动日志；文档只写当前有效内容，历史交给 git。
