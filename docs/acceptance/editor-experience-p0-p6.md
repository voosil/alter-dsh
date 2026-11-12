---
type: acceptance
status: active
updated: 2026-11-11
---

# 编辑器前端 1:1 还原与 AST 适配 · 验收清单

验收对象：空间文档页——`vendor/ui-space` 的 `DocumentView` 及其旧编辑器、评论轨/评论卡/评论框、
历史面板、历史评论弹窗、底部「子文档 / 全文评论」与导出。前端按产品要求 **1:1 还原为重构前的
旧 UI**（`c73c3f6` 基线）；数据层经 `src/document/editors/legacy` 适配到 `alter-doc/1` AST 与
Document Operations。

结论口径：本清单只验收「前端还原一致 + AST 数据链路正确 + 已知缺口如实披露」。编辑体验的健壮性
（草稿、并发、输入极限、性能等）以[即时编辑器健壮性清单](document-editor-robustness.md)为准，
本清单不重复展开。

## 1. 硬约束（违反即返工）

- **前端冻结的是体验，不是实现**：文档页与基线（`c73c3f6` 旧 UI）保持**视觉与交互 parity**——壳层、
  全部 CSS 与工具栏/slash 菜单/评论轨/历史面板视觉不动，正常状态渲染出的外观与交互不得回归。
  编辑器内核允许替换（[内核替换方案](../designs/editor-kernel-replacement.md)）：现行默认是 AST 原生
  内核（`src/document/editors/tiptap`），本节其余条款对两个内核同等生效；legacy 内核保留为回滚路径，
  退役前其适配层与测试不得删除。
  例外（产品未反对的最小兜底）：加载失败/渲染崩溃的错误页、保存失败态的「导出草稿」按钮、
  错误边界 fallback 仅错误/失败态出现，使用既有样式类与组件。
- **产品批准的编辑面修复**（2026-11-11《编辑器专题优化》第 1–11 项与后续反馈的第 12–14 项）：允许行为级修复与最小必要 CSS 增量
  （分割线/图片选中态、附件态、placeholder 定位、表格选中与操作条、整行输入 `---` 即时转分割线、
  slash 菜单方向固定、引用标记 `>`/`》`+空格输入、引用行首退格删标记），不得重排 DOM、不得改既有样式类名；
  新增交互态（如 `data-selected`）只存在于编辑面，序列化前剥除、不写入 AST。
- **数据层唯一入口**：内核只能报 canonical AST blocks，视图不得直接写 `node.content`，也不得绕过
  `doc.applyOps` / `doc.restoreVersion`；legacy 内核的 HTML 只能经 `@alter-space/legacy-adapter`
  （`src/document/editors/legacy`）转成 AST 与 Operation 批次，AST 内核直接产出 blocks。
- **正文单一格式**：正文只有 `alter-doc/1` AST；标题等元数据经 `space.saveNode`，正文写入只经
  Document Operations。
- **资产**：正文中的 data URL 图片/文件在保存前物化为内容寻址资产（AST 内核持有的已是资产引用）；
  上传失败时保留编辑面内容并提示，不得静默丢图。
- **新节点呈现**：file / bookmark / docLink 使用旧卡片样式；callout / mindmap / component 在旧 UI
  中显示为对象占位卡（无人工编辑入口），AI 侧仍可读写其对象。

## 2. 旧体验行为（还原后必须可用）

| 能力 | 验收内容 | 方式 |
| --- | --- | --- |
| 标题与元数据 | 多行自适应标题 textarea、占位「无标题」、自动保存；创建者与更新时间 | 自动 + 人工 |
| 新建与打开 | 新建文档后直接落在该文档（空空间不跳空间概览，已有文档不跳上一篇），光标落在标题可直接输入；重新打开已有文档不抢焦点 | 自动 |
| 目录与面包屑 | 目录按钮；空间 / 祖先 / 当前文档面包屑 | 人工 |
| 文档菜单 | 复制链接、新建子文档、历史记录、历史评论、导出 Markdown；已归档时出现「取消归档」（归档入口在目录侧栏/徽标） | 自动（历史/恢复）+ 人工 |
| 已读记录 | 打开文档 `recordOpen`，目录未读态更新 | 人工 |
| 块编辑 | 正文、H1–H3、无序/有序/待办列表、引用、代码块、分割线、表格、图片、文件；整行输入 `---` 立即转为分割线（无需回车）；空行行首按 markdown 标准输入 `>`+空格转引用（全角 `》` 同），引用行首退格只删该行标记；分割线/图片支持先选中再删除 | 人工 + 行为测试 |
| slash 菜单 | 输入 `/` 触发块插入，块清单与快捷键与旧版一致；菜单打开时按可用空间定在命令行下方或上方并保持方向，过滤变矮/变高只重新测量尺寸与位置、不翻到另一侧 | 人工 + 行为测试 |
| 行内格式 | 粗/斜/下划线/删除线/代码/高亮/链接（含链接编辑条） | 人工 |
| 卡片 | 文档内链卡、网页链接卡、文件卡（元数据与下载入口） | 人工 |
| 表格 | 插入表格、编辑单元格、行列操作；悬浮操作条整表选中、上移/下移、删除 | 人工 + 行为测试 |
| 图片与文件 | 选择/拖入/粘贴图片；粘贴 data URL 物化为资产 | 自动（资产物化）+ 人工 |
| 撤销与重做 | 编辑内撤销重做；保存后编辑面不重建 | 人工 |
| 自动保存 | 约 700ms 防抖、成功静默、失败显示「保存失败，重试」 | 自动 + 人工 |
| 评论 | 划词评论、评论轨、卡片发布/编辑/补充/解决、quote 随编辑更新 | 自动（锚点）+ 人工 |
| 附加内容 | 底部「子文档 / 全文评论」tab、历史评论弹窗 | 人工 |
| 历史 | 版本列表、差异预览（AST→旧 HTML）、恢复（CAS） | 自动 + 人工 |
| 导出 | 导出 Markdown 投影 | 人工 |
| 输入法 | 中文/日文组合输入不误保存、不丢字 | 人工（未专项覆盖） |
| 归档状态 | 已归档徽标与恢复入口；空文档/无标题语义 | 人工 |

自动证据以 `tests/ui/document/editors/legacy/*.test.ts`（adapter/view/save/recovery/input/resilience/anchors）、
`tests/ui/document/editors/legacy/{blocks,caret,convert,slash}.test.ts`（编辑器专题优化）与
`tests/nightly/document/fuzz.test.ts`（G2 种子随机走查）为准；新建文档的路由落点由 `tests/ui/app/navigation.test.ts`（内存服务替身 + 真 SpaceApp）约束。真实浏览器
验收已执行（编辑/保存/刷新拼接、slash、撤销、崩溃草稿、版本恢复脏状态、粘贴安全、导出/历史/评论、
样式冻结对照），替代项与限制见第 4 节。

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
- [x] **D8 外部更新**：外部 revision 变化时重载编辑面（有测试）；自身保存回显不重建编辑面
  （测试断言自身保存回显不重建编辑面；外部 revision 变化才重载）。

## 4. 已知缺口（如实记录，不视为通过）

- **对象卡占位**：callout / mindmap / component 在旧 UI 中是无样式的 `data-object-card` 占位，
  无人工插入/编辑入口；AI 工具（`space_object_*`、`space_component_catalog`）仍可读写，保存往返
  不丢对象引用。新增人工入口需要产品批准前端改动（当前冻结）。
- **真实环境限制**：真实输入法 IME、真实断网（非 route abort）、真实桌面/面板冷启动未覆盖；
  headless 已测 4990 块/509.7KiB 文档（见健壮性 F 组），jsdom 覆盖组合输入与保存失败重试。
- **浏览器自动化替代**：headless 合成 Ctrl+Z 与鼠标拖选不生效，已用 `execCommand('undo')`
  与程序化 Range 等价验证；真实键盘/鼠标、表格悬浮操作条与真实输入法仍建议人工抽查。
- **第 12–14 项的真实环境抽查**：slash 菜单方向固定、引用标记输入（含中文输入法把 `>` 打成 `》`
  的提交时序）与引用行首退格目前只有 jsdom 行为测试证据，真实浏览器观感与真实输入法时序待人工抽查。
- **块类型转换的块身份**：引用↔正文、标题↔正文这类行为级转换会重建块（沿用适配层既有行为），该行
  的评论锚点按 E4 契约标记失效或重新锚定，版本历史呈现为删除+插入，而不是原地改类型。

## 5. 复验规则

1. 改动涉及文档页时，先跑自动证据（adapter / view / fuzz 等测试），再按第 2 节受影响的条目做
   自动或人工复验；提交前 `pnpm check` 全绿。
2. 样式与 DOM 用基线 diff 判定：文档页 CSS 与编辑器 DOM 出现非数据层差异即失败（除 §1 已声明的
   错误/失败态最小兜底 UI 外）。
3. 最终复验由独立子 Agent 按本清单逐项给出 PASS / FAIL / GAP（对应第 4 节）；结论只能是 PASS、
   PASS-WITH-GAPS 或 FAIL，并附证据与残留风险。
4. 状态标记：`[x]` 自动化覆盖；`[~]` 已实现、待真实运行或人工联调；`[ ]` 未做。

## 相关文档

- [即时编辑器健壮性清单](document-editor-robustness.md)（数据安全/并发/输入/异常/规模 A–G 组）
- [文档工具功能验收（S0/S1）](s0-document-tools.md)
- [文档模型 v0](../specs/document-model-v0.md) 与 [Operations v0](../specs/document-operations-v0.md)
- [文档内容架构](../designs/document-content-architecture.md)
- [编辑器健壮性方向](../designs/document-editor-robustness.md)
