---
type: acceptance
status: active
updated: 2026-11-12
---

# 编辑器前端 1:1 还原与 AST 适配 · 验收清单

验收对象：空间文档页——`vendor/ui-space` 的 `DocumentView`、评论轨/评论卡/评论框、历史面板、
历史评论弹窗、底部「子文档 / 全文评论」与导出。前端按产品要求 **1:1 还原为重构前的旧 UI**
（`c73c3f6` 基线），壳层与全部 CSS 保持冻结；编辑内核唯一为 AST 原生 Tiptap
（`src/document/editors/tiptap`），正文经 `@alter-space/document-runtime` 以 `alter-doc/1` AST 与
Document Operations 读写。

结论口径：本清单只验收「前端还原一致 + AST 数据链路正确 + 已知缺口如实披露」。编辑体验的健壮性
（草稿、并发、输入极限、性能等）以[即时编辑器健壮性清单](document-editor-robustness.md)为准，
本清单不重复展开。

## 1. 硬约束（违反即返工）

- **前端冻结的是体验，不是实现**：文档页与基线（`c73c3f6` 旧 UI）保持**视觉与交互 parity**——壳层、
  全部 CSS（含冻结的 `Editor.module.css`）与工具栏/slash 菜单/评论轨/历史面板视觉不动，正常状态渲染出的
  外观与交互不得回归。编辑器内核唯一为 AST 原生 Tiptap；旧 contentEditable 内核已退役，
  **不存在内核切换或应用内回滚路径**（退役决策见[内核替换方案](../designs/editor-kernel-replacement.md)）。
  例外（产品未反对的最小兜底）：加载失败/渲染崩溃的错误页、保存失败态的「导出草稿」按钮、
  错误边界 fallback 仅错误/失败态出现，使用既有样式类与组件。
- **冻结样式是 CSS Modules**：运行时类名带哈希后缀，内核必须使用从冻结样式表解析出的类名后再挂载
  （正文、工具栏、slash 菜单、操作条、字数气泡同此）；视觉基准为冻结 `Editor.module.css` +
  `dom-contract.test.ts` + 验收文档人工清单，不得复制样式，也不得写字面量类名。
- **产品批准的编辑面修复**（2026-11-11《编辑器专题优化》第 1–11 项与后续反馈的第 12–14 项）：允许行为级修复与最小必要 CSS 增量
  （分割线/图片选中态、附件态、placeholder 定位、表格选中与操作条、整行输入 `---` 即时转分割线、
  slash 菜单方向固定、引用标记 `>`/`》`+空格输入、引用行首退格删标记），不得重排 DOM、不得改既有样式类名；
  新增交互态（如 `data-selected`）只存在于编辑面，序列化前剥除、不写入 AST。
- **2026-11-12 用户反馈增量（有意偏离旧基线，以产品反馈为准）**：列表/待办两段式退格、块级手柄
  （选中/拖拽排序）、表格完整工具条与「表格（无表头）」、附件任意类型保存（未知 mime 降级
  `application/octet-stream`）、评论输入框不再随划词自动弹出、激活评论背景调浅（唯一有意视觉增量）。
  合并/拆分单元格的跨度随 AST 保存，不再是数据缺口。
- **数据层唯一入口**：内核只能报 canonical AST blocks，视图不得直接写 `node.content`，也不得绕过
  `doc.applyOps` / `doc.restoreVersion`；历史差异预览与粘贴导入用的冻结 HTML 投影/解析在
  `@alter-space/document-runtime`（`src/document/runtime`），内核不直接处理 HTML。
- **正文单一格式**：正文只有 `alter-doc/1` AST；标题等元数据经 `space.saveNode`，正文写入只经
  Document Operations。
- **资产**：正文中的 data URL 图片/文件在保存前物化为内容寻址资产（AST 内核持有的已是资产引用）；
  上传失败时保留编辑面内容并提示，不得静默丢图。
- **新节点呈现**：file / bookmark / docLink 使用旧卡片样式；callout / mindmap / component 在旧 UI
  中显示为对象占位卡（无人工编辑入口），AI 侧仍可读写其对象。

## 2. 体验行为（旧基线 + 已批准增量，必须可用）

| 能力 | 验收内容 | 方式 |
| --- | --- | --- |
| 标题与元数据 | 多行自适应标题 textarea、占位「无标题」、自动保存；创建者与更新时间 | 自动 + 人工 |
| 新建与打开 | 新建文档后直接落在该文档（空空间不跳空间概览，已有文档不跳上一篇），光标落在标题可直接输入；重新打开已有文档不抢焦点 | 自动 |
| 目录与面包屑 | 目录按钮；空间 / 祖先 / 当前文档面包屑 | 人工 |
| 文档菜单 | 复制链接、新建子文档、历史记录、历史评论、导出 Markdown；已归档时出现「取消归档」（归档入口在目录侧栏/徽标） | 自动（历史/恢复）+ 人工 |
| 已读记录 | 打开文档 `recordOpen`，目录未读态更新 | 人工 |
| 块编辑 | 正文、H1–H3、无序/有序/待办列表、引用、代码块、分割线、表格、图片、文件；整行输入 `---` 立即转为分割线（无需回车）；空行行首按 markdown 标准输入 `>`+空格转引用（全角 `》` 同），引用行首退格只删该行标记；分割线/图片支持先选中再删除 | 人工 + 行为测试 |
| 列表/待办退格 | 空列表项第一次 Backspace 原位退成空段落（保留行与 id），第二次删掉空行并把被拆分的同名列表合并、光标回到上一行末尾（不再出现孤立序号）；空待办行第一步只去掉 checkbox（原位变空段落、光标行首），第二步同上；有文字的行首退格保持默认合并语义 | 自动 + 人工 |
| 块级手柄 | hover 顶层 block 左侧显示六点手柄；点击全选 block（文本块 TextSelection，atom/表格 NodeSelection 并标记 `data-block-selected`）；拖拽调整 block 顺序（插入指示线、保留节点 id 与评论锚点，Esc/拖出取消；仅顶层 block，鼠标事件实现，未覆盖触屏） | 自动 + 人工 |
| slash 菜单 | 输入 `/` 触发块插入，块清单与快捷键与旧版一致，新增「表格（无表头）」`table-plain`；菜单打开时按可用空间定在命令行下方或上方并保持方向，过滤变矮/变高只重新测量尺寸与位置、不翻到另一侧 | 人工 + 行为测试 |
| 行内格式 | 粗/斜/下划线/删除线/代码/高亮/链接（含链接编辑条） | 人工 |
| 卡片 | 文档内链卡、网页链接卡、文件卡（元数据与下载入口） | 人工 |
| 表格 | 插入表格（1 表头 + 2 表体）与「表格（无表头）」（3×3 全 td）；光标在表内显示完整深色工具条：上方/下方插入行、左侧/右侧插入列、删除行、删除列、合并单元格、拆分单元格、表头开关（首行 th/td 反转，与 AST `headerRows` 一致）、上移/下移、删除表格；合并/拆分跨度随 AST 保存；hover 仍显示旧「选中」，整表选中仍是旧 3 按钮 | 自动 + 人工 |
| 图片与文件 | 选择/拖入/粘贴图片；粘贴 data URL 物化为资产；附件在 Host 文件白名单内原样保存，白名单外（含空串/未知/可执行类型）统一降级为 `application/octet-stream`，保留原始 name 作下载文件名，非图片以 attachment + nosniff 提供；图片通道白名单不变（png/jpeg/webp/gif，≤4 MiB），文件上限 8 MiB；上传失败显示 Host 的真实 message | 自动（资产物化）+ 人工 |
| 撤销与重做 | 编辑内撤销重做（含输入规则单步撤销、纯文本 undo/redo）；保存后编辑面不重建 | 自动（撤销/重做）+ 人工（保存后不重建） |
| 自动保存 | 约 700ms 防抖、成功静默、失败显示「保存失败，重试」 | 自动 + 人工 |
| 评论 | 划词不再自动弹出输入框（输入框只在「添加评论」工具栏动作或点击已评论文字时打开）；光标进入/离开评论文本时上报 `onCommentAtCaretChange`，评论轨卡片与正文高亮跟随光标；卡片发布/编辑/补充/解决、quote 随编辑更新；激活评论背景调浅（有意视觉增量） | 自动（锚点/光标）+ 人工 |
| 附加内容 | 底部「子文档 / 全文评论」tab、历史评论弹窗 | 人工 |
| 历史 | 版本列表、差异预览（AST→冻结 HTML 投影）、恢复（CAS） | 自动 + 人工 |
| 导出 | 导出 Markdown 投影 | 人工 |
| 输入法 | 中文/日文组合输入不误保存、不丢字 | 人工（未专项覆盖） |
| 归档状态 | 已归档徽标与恢复入口；空文档/无标题语义 | 人工 |

自动证据：

- 内核（14 个套件）：`tests/ui/document/editors/tiptap/dom-contract.test.ts`（冻结 DOM 契约：块级 DOM 与模块类名）、
  `blocks.test.ts`（待办/卡片/表格）、`blocks-selection.test.ts`（块选中/表格条）、`block-handle.test.ts`
  （块手柄选中/拖拽）、`slash.test.ts`、`toolbar.test.ts`、`keyboard.test.ts`、`input.test.ts`
  （输入规则/IME/粘贴拖入/两段式退格）、`overlays.test.ts`（表格工具条）、`link-overlay.test.ts`、
  `comments.test.ts`（Highlight 绘制、caret 上报与 quote 维护）、`kernel-mount.test.ts`/`body.test.ts`/`kernel.test.ts`（接线）；
- 页面与运行时：`tests/ui/document/page/{view,recovery,resilience,anchors,document-page}.test.ts`、
  `tests/ui/document/runtime/{adapter,save}.test.ts`，共享页面 harness 在 `tests/support/document-page.ts`；
  新建文档路由落点由 `tests/ui/app/navigation.test.ts`（内存服务替身 + 真 SpaceApp）约束；
- 规模与随机走查：`tests/nightly/document/fuzz.test.ts`（G2 种子随机）；
- 当前复核：编辑器相关套件全绿（内核 297 tests、`--project ui` 404 tests），`tsc`（客户端）、
  `lint`、`build` 与 `docs:check` 通过；bundle `client.js` 1437 KiB / 161 KiB CSS；6 个 legacy
  测试套件已随旧内核删除。全仓 `pnpm check` 以与并行改动合并后的工作树为准。

以下真实浏览器验收记录产生于已退役的 contentEditable 内核时代（编辑/保存/刷新拼接、slash、撤销、
崩溃草稿、版本恢复脏状态、粘贴安全、导出/历史/评论、样式冻结对照）；当前视觉基准为冻结
`Editor.module.css` + `dom-contract.test.ts` + 本节行为清单的人工复验，替代项与限制见第 4 节。

## 3. AST 数据链路

- [x] **D1 加载**：AST 文档直接加载到 Tiptap 内核，块保留稳定 `data-block-id`；空文档与标题占位正确。
- [x] **D2 保存**：内核捕获 AST blocks 后以块级 diff 生成 Operation 批次提交（`baseRevision` + 幂等键），
  非整篇覆盖；标题走 `saveNode`。
- [x] **D3 映射**：全部 v0 节点/属性/marks 双向往返（AST↔ProseMirror）；历史预览与粘贴导入的冻结
  HTML 语法（旧卡片、待办、分割线、内联链接）可解析。
- [x] **D4 降级**：未知/不支持标记转为可见内容并给出 warning，不静默丢弃。
- [x] **D5 资产**：粘贴 data URL 图片/文件在保存前上传为资产并改写引用；上传失败保留原内容并提示重试。
- [x] **D6 评论锚点**：quote 唯一匹配时写入 `{blockId, offset, length}`；歧义或无匹配不写锚点。
- [x] **D7 版本**：历史预览把 AST 版本投影为冻结 HTML 做差异；恢复走 `doc.restoreVersion` 并以当前
  revision 作为 CAS base。
- [x] **D8 外部更新**：外部 revision 变化时重载编辑面（有测试）；自身保存回显不重建编辑面
  （测试断言自身保存回显不重建编辑面；外部 revision 变化才重载）。内核按「文档身份 + revision」重载，
  版本恢复、冲突重载与草稿恢复后的正文是页面显式传入的文档，不会被下一次保存覆盖。

内核 parity 证据（冻结体验口径，断言 data-* / aria / 文案，不依赖冻结类名字面量）：
块级 DOM 与模块类名 `dom-contract.test.ts`；浮层 slash/toolbar；操作条与块选中 overlays/link-overlay/blocks-selection；
输入规则/键盘/IME/粘贴拖入 keyboard/input；评论 Highlight 绘制与 quote 回写 comments；页面与运行时链路见
`tests/ui/document/page/` 与 `tests/ui/document/runtime/`。

## 4. 已知缺口与增量（如实记录，不视为通过）

- **对象卡占位**：callout / mindmap / component 在旧 UI 中是无样式的 `data-object-card` 占位，
  无人工插入/编辑入口；AI 工具（`space_object_*`、`space_component_catalog`）仍可读写，保存往返
  不丢对象引用。新增人工入口需要产品批准前端改动（当前冻结）。
- **真实环境限制**：真实输入法 IME、真实断网（非 route abort）、真实桌面/面板冷启动未覆盖；
  headless 已测 4990 块/509.7KiB 文档（已退役内核时代实测，见健壮性 F 组），jsdom 覆盖组合输入与
  保存失败重试。
- **浏览器自动化替代（已退役内核时代的记录）**：headless 合成 Ctrl+Z 与鼠标拖选不生效，当时用
  `execCommand('undo')` 与程序化 Range 等价验证；当前内核的真实键盘/鼠标、表格悬浮操作条与真实
  输入法仍建议人工抽查。
- **第 12–14 项的真实环境抽查**：slash 菜单方向固定、引用标记输入（含中文输入法把 `>` 打成 `》`
  的提交时序）与引用行首退格目前只有 jsdom 行为测试证据，真实浏览器观感与真实输入法时序待人工抽查。
- **块类型转换的块身份**：引用↔正文、标题↔正文这类行为级转换会重建块（沿用运行时 Operations diff
  的既有语义），该行的评论锚点按 E4 契约标记失效或重新锚定，版本历史呈现为删除+插入，而不是原地改类型。
- **有意视觉增量**：激活评论的文字背景在 `kernel.css` 中用
  `color-mix(in srgb, var(--alter-accent-soft) 40%, transparent)` 调浅（作用域
  `.kernelSurface::highlight(alter-comment-active)`），普通评论仍只有下划线；这是唯一有意偏离冻结
  视觉的补丁。
- **新能力限制**：块手柄拖拽是鼠标事件实现，未覆盖触屏；多表头文档的「表头开关」只作用于首行
  （`toggleHeaderRow` 语义）；图片上传仍限 png/jpeg/webp/gif（4 MiB）。表格合并/拆分已可用且
  跨度随 AST 保存，不再是已知缺口。
- **内核的已知形态差异**（不影响数据与可读性，产品可接受）：
  文本类型菜单锚在工具栏按钮上（旧实现锚工具栏整体，Menu 左缘约 4px）；卡片 ⇄ 行内链接互转在
  `alter-doc/1` 中必然跨块重构；表格不能下移到文档末尾（编辑器需要末块承载光标）；图片是块级节点，
  旧版「段落内行内图片只删 img 保留段落」的分支在新内核不可达；文本类型菜单把引用内/表格单元格里的
  段落转成待办时只做顶层文本块转换。

## 5. 复验规则

1. 改动涉及文档页时，先跑自动证据（`tests/ui/document/page/`、`tests/ui/document/runtime/`、
   `tests/ui/document/editors/tiptap/` 与 fuzz），再按第 2 节受影响的条目做自动或人工复验；
   提交前 `pnpm check` 全绿。
2. 视觉与 DOM 基准：冻结 `Editor.module.css` + `dom-contract.test.ts` + 验收文档人工清单。文档页 CSS
   与渲染出的块级 DOM 出现非声明差异即失败（除 §1 已声明的错误/失败态最小兜底 UI 外）。旧组件已删，
   不再有可运行 A/B 对照；应用内回滚不再存在，回滚 = git 历史。
3. 最终复验由独立子 Agent 按本清单逐项给出 PASS / FAIL / GAP（对应第 4 节）；结论只能是 PASS、
   PASS-WITH-GAPS 或 FAIL，并附证据与残留风险。
4. 状态标记：`[x]` 自动化覆盖；`[~]` 已实现、待真实运行或人工联调；`[ ]` 未做。
5. 人工复验重点（2026-11-12 增量）：列表/待办两步退格（第一步退成空段落、第二步删行合并列表并把
   光标移到上一行末尾）；块手柄 hover 显示、点击全选与拖拽排序（Esc/拖出取消）；表格工具条各动作、
   表头开关与「表格（无表头）」；附件上传任意类型与未知类型的下载；评论输入框不再随划词自动弹出、
   点击已评论文字激活、激活评论背景调浅的观感。

## 相关文档

- [即时编辑器健壮性清单](document-editor-robustness.md)（数据安全/并发/输入/异常/规模 A–G 组）
- [文档工具功能验收（S0/S1）](s0-document-tools.md)
- [文档模型 v0](../specs/document-model-v0.md) 与 [Operations v0](../specs/document-operations-v0.md)
- [文档内容架构](../designs/document-content-architecture.md)
- [编辑器健壮性方向](../designs/document-editor-robustness.md)
