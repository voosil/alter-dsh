---
type: acceptance
status: active
updated: 2026-11-10
---

# 编辑器前端 1:1 还原与 AST 适配 · 验收清单

验收对象：空间文档页——`vendor/ui-space` 的 `DocumentView` 及其旧编辑器、评论轨/评论卡/评论框、
历史面板、历史评论弹窗、底部「子文档 / 全文评论」与导出。前端按产品要求 **1:1 还原为重构前的
旧 UI**（`c73c3f6` 基线）；数据层经 `src/document/legacy` 适配到 `alter-doc/1` AST 与
Document Operations。

结论口径：本清单只验收「前端还原一致 + AST 数据链路正确 + 已知缺口如实披露」。编辑体验的健壮性
（草稿、并发、输入极限、性能等）以[即时编辑器健壮性清单](document-editor-robustness.md)为准，
本清单不重复展开。

## 1. 硬约束（违反即返工）

- **前端外观冻结**：文档页 CSS、编辑器 DOM 与既有 JSX 结构与基线一致，逐字节不做改动；数据层
  改动不得改变渲染出的 DOM 结构或样式类名。
- **数据层唯一入口**：编辑器 HTML 只能经 `@alter-space/legacy-adapter`（`src/document/legacy`）
  转成 AST 与 Operation 批次；视图不得直接写 `node.content`，也不得绕过 `doc.applyOps` /
  `doc.restoreVersion`。
- **正文单一格式**：正文只有 `alter-doc/1` AST；标题等元数据经 `space.saveNode`，正文写入只经
  Document Operations。
- **资产**：正文中的 data URL 图片/文件在保存前物化为内容寻址资产；上传失败时保留编辑面内容并
  提示，不得静默丢图。
- **新节点呈现**：file / bookmark / docLink 使用旧卡片样式；callout / mindmap / component 在旧 UI
  中显示为对象占位卡（无人工编辑入口），AI 侧仍可读写其对象。

## 2. 旧体验行为（还原后必须可用）

| 能力 | 验收内容 | 方式 |
| --- | --- | --- |
| 标题与元数据 | 多行自适应标题 textarea、占位「无标题」、自动保存；创建者与更新时间 | 自动 + 人工 |
| 目录与面包屑 | 目录按钮；空间 / 祖先 / 当前文档面包屑 | 人工 |
| 文档菜单 | 复制链接、新建子文档、历史记录、历史评论、导出 Markdown、归档/恢复 | 自动（历史/恢复）+ 人工 |
| 已读记录 | 打开文档 `recordOpen`，目录未读态更新 | 人工 |
| 块编辑 | 正文、H1–H3、无序/有序/待办列表、引用、代码块、分割线、表格、图片、文件 | 人工 |
| slash 菜单 | 输入 `/` 触发块插入，块清单与快捷键与旧版一致 | 人工 |
| 行内格式 | 粗/斜/下划线/删除线/代码/高亮/链接（含链接编辑条） | 人工 |
| 卡片 | 文档内链卡、网页链接卡、文件卡（元数据与下载入口） | 人工 |
| 表格 | 插入表格、编辑单元格、行列操作 | 人工 |
| 图片与文件 | 选择/拖入/粘贴图片；粘贴 data URL 物化为资产 | 自动（资产物化）+ 人工 |
| 撤销与重做 | 编辑内撤销重做；保存后编辑面不重建 | 人工 |
| 自动保存 | 约 700ms 防抖、成功静默、失败显示「保存失败，重试」 | 自动 + 人工 |
| 评论 | 划词评论、评论轨、卡片发布/编辑/补充/解决、quote 随编辑更新 | 自动（锚点）+ 人工 |
| 附加内容 | 底部「子文档 / 全文评论」tab、历史评论弹窗 | 人工 |
| 历史 | 版本列表、差异预览（AST→旧 HTML）、恢复（CAS） | 自动 + 人工 |
| 导出 | 导出 Markdown 投影 | 人工 |
| 输入法 | 中文/日文组合输入不误保存、不丢字 | 人工（未专项覆盖） |
| 归档状态 | 已归档徽标与恢复入口；空文档/无标题语义 | 人工 |

自动证据以 `tests/document-legacy-view.test.ts`（旧 DocumentView 在 AST 后端上的加载、自动保存、
失败重试、标题、资产物化、版本恢复、外部 revision 重载）与 `tests/document-legacy-adapter.test.ts`
（映射、旧语法、资产物化、评论锚点、块级 diff）为准；人工项在真实桌面应用按上表逐项操作并留证据。

## 3. AST 适配与数据链路

- [x] **D1 加载**：AST 文档投影为旧编辑器 HTML，块保留 `data-block-id`；空文档与标题占位正确。
- [x] **D2 保存**：编辑器 HTML→AST 后以块级 diff 生成 Operation 批次提交（`baseRevision` + 幂等键），
  非整篇覆盖；标题走 `saveNode`。
- [x] **D3 映射**：全部 v0 节点/属性/marks 双向往返；旧编辑器专有语法（旧卡片、待办、分割线、
  内联链接）可解析。
- [x] **D4 降级**：未知/不支持标记转为可见内容并给出 warning，不静默丢弃。
- [x] **D5 资产**：粘贴 data URL 图片/文件在保存前上传为资产并改写引用；上传失败保留原内容并提示重试。
- [x] **D6 评论锚点**：quote 唯一匹配时写入 `{blockId, offset, length}`；歧义或无匹配不写锚点。
- [x] **D7 版本**：历史预览把 AST 版本投影为旧 HTML 做差异；恢复走 `doc.restoreVersion` 并以当前
  revision 作为 CAS base。
- [~] **D8 外部更新**：外部 revision 变化时重载编辑面（有测试）；自身保存回显不重建编辑面
  （实现上不递增外部 revision，未专项验证）。

## 4. 已知缺口（如实记录，不视为通过）

- **对象卡占位**：callout / mindmap / component 在旧 UI 中是无样式的 `data-object-card` 占位，
  无人工插入/编辑入口；AI 工具（`space_object_*`、`space_component_catalog`）仍可读写，保存往返
  不丢对象引用。
- **新特性入口**：声明式组件的选择/属性编辑、mindmap 树编辑、评论自动重锚与失效提示等旧 UI 没有
  的入口均未提供。
- **健壮性缺口**：草稿与崩溃恢复、并发冲突 UX、IME 专项、上限文档与性能、无障碍、客户端故障注入
  未在还原实现上完成（见健壮性清单 A–G 组）。
- **浏览器人工回归**：真实 GUI 的样式逐项比对、slash/表格/评论/历史/导出等浏览器级用例尚未执行
  并留证。

## 5. 复验规则

1. 改动涉及文档页时，先跑自动证据（adapter / view / fuzz 等测试），再按第 2 节受影响的条目做
   自动或人工复验；提交前 `pnpm check` 全绿。
2. 样式与 DOM 用基线 diff 判定：文档页 CSS 与编辑器 DOM 出现非数据层差异即失败。
3. 最终复验由独立子 Agent 按本清单逐项给出 PASS / FAIL / GAP（对应第 4 节）；结论只能是 PASS、
   PASS-WITH-GAPS 或 FAIL，并附证据与残留风险。
4. 状态标记：`[x]` 自动化覆盖；`[~]` 已实现、待真实运行或人工联调；`[ ]` 未做。

## 相关文档

- [即时编辑器健壮性清单](document-editor-robustness.md)（数据安全/并发/输入/异常/规模 A–G 组）
- [文档工具功能验收（S0/S1）](s0-document-tools.md)
- [文档模型 v0](../specs/document-model-v0.md) 与 [Operations v0](../specs/document-operations-v0.md)
- [文档内容架构](../designs/document-content-architecture.md)
- [编辑器健壮性方向](../designs/document-editor-robustness.md)
