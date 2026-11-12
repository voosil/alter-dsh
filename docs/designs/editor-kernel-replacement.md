---
type: design
status: active
updated: 2026-11-12
---

# 编辑器内核替换：体验不变，内核可换

这篇方案回答「文档页 UI/UX 体验不变的前提下，为什么把编辑器内核从手写 contentEditable 换成
AST 原生 Tiptap、用什么保证体验不回归、怎样完成切换并退役旧内核」。内容架构与写入契约以
[document-content-architecture.md](document-content-architecture.md) 与
[specs/document-operations-v0.md](../specs/document-operations-v0.md) 为准；健壮性现状以
[document-editor-robustness.md](document-editor-robustness.md) 为准；本篇只记录方向、取舍与验收边界。

## 1. 产品决策：冻结体验，不冻结实现

- **结论**（2026-11-11 产品决策）：文档页的不变约束从「DOM/CSS 字节级一致」升级为
  **视觉与交互 parity**；编辑器内核允许替换。
- **唯一内核**（2026-11-12 切换并退役旧内核）：AST 原生 Tiptap 内核（`src/document/editors/tiptap`）
  接管全部正文编辑；旧 contentEditable 内核、其内核适配层与内核偏好模块已删除，**不存在内核切换或
  应用内回滚路径**。
- **冻结条款仍然有效**，只是对象变成「体验」：壳层与全部 CSS（含冻结的 `Editor.module.css`）、
  工具栏/菜单/评论轨/历史面板的视觉不变，[编辑器还原验收](../acceptance/editor-experience-p0-p6.md)
  的行为清单是回归基准。parity 以冻结样式表原样命中 + 验收文档 + 人工清单判定，不再有可运行 A/B 对照。
- 理由：产品要的是用户体验的连续性，不是实现的连续性；字节级 DOM 冻结把健壮性修复全部挤进
  数据层，错误提示与恢复入口的设计空间受限（健壮性方案已列此为风险）。

## 2. 旧方案的结构性问题

旧方案（手写 contentEditable 内核）可用且有验收证据，但以下代价是结构性的，继续打补丁不能消除：

1. **HTML 是有损中间格式**：每次保存走 AST→HTML→DOM→浏览器突变→HTML→AST 的双向映射，
   保真度决定保存是否丢内容（健壮性方案的第一风险）。
2. **编辑期间 DOM 是活状态、AST 是事后重建**：块 id 靠属性在浏览器突变中幸存，复用是启发式；
   评论锚点压在这条脆弱链上。
3. **手写 contentEditable 内核在重造成熟框架已解决的能力**：IME、撤销、粘贴清洗、跨块选区；
   依赖的 execCommand 与原生 undo 属废弃/浏览器私有行为，浏览器更新可致静默回归。
4. **维护税与性能税**：新增节点要同时维护 registry 与两份手写 HTML 映射；每次防抖保存全文
   重解析 DOM，规模文档的保存成本线性上涨。

## 3. 目标架构

| 层 | 内容 | 处置 |
| --- | --- | --- |
| 权威与契约 | Host 存储、`alter-doc/1` AST、Document Operations、AI 工具、Markdown 投影、版本历史 | 不动 |
| 文档页壳层 | React 壳、全部 CSS、工具栏/slash 菜单/评论轨/历史面板的视觉 | 不动 |
| 编辑器内核 | AST 原生 Tiptap（ProseMirror 文档模型） | 已替换，唯一实现 |
| 文档运行时 | 保存生命周期（防抖/单飞/CAS 冲突）、草稿与崩溃恢复、评论锚点、块级 diff、冻结 HTML 投影/解析 | 已落地 `src/document/runtime`（内核无关） |

关键决策：

- **壳层只认 AST**：内核契约是「加载 AST / 捕获回 AST / dirty 通知 / 选区与评论事件」，
  内核内部格式是 ProseMirror 文档树，不进入壳层或持久化。内核由 React 承载，壳层通过同一
  props 与命令式 handle 契约接线；契约放 `src/document/editors/kernel.ts`，内核实现放
  `src/document/editors/tiptap/`。
- **Schema Registry 是唯一事实源**：内核的节点 schema 从现有 registry 生成，AST↔内核状态
  是无损树映射，中间不再有 HTML 字符串——这才真正落地内容架构的原则 5。
- **保存链路复用**：内核捕获 → AST → 运行时块级 diff → Operations；所有编辑走同一条
  保存/草稿/冲突路径。评论锚点以内核位置↔blockId 精确映射，旧数据保留 quote 兜底。
- **文档运行时与内核解耦**：保存生命周期、草稿、快照、Operations、评论锚点、错误上报与
  冻结 HTML 投影/解析归 `src/document/runtime`；内核不拥有这些能力，HTML 投影只服务历史
  差异预览、导出与粘贴导入。

## 4. 内核选型：Tiptap 3（ProseMirror）

**结论**：新内核用 Tiptap 3。理由：依赖已在仓库且有历史实现经验；ProseMirror 文档模型与
`alter-doc/1` 同构（类型化节点树 + attrs + marks + 稳定 id），transaction 模型天然映射
Operations；IME、语义化撤销、粘贴清洗与跨块选区经过生产验证。

被否方案（各一句话）：

- **Lexical**：同样可行，但无既有投入，schema/协作生态迁移成本更高。
- **继续手写内核**：已约 4000 行且真实输入法/断网仍有缺口，边际成本高于引入框架。
- **Notion 式每块独立编辑器**：跨块选区与 IME 复杂度不可接受，框架已解决文档级选区。

**bundle 成本**：实测引入 Tiptap 3 + ProseMirror 后 `client.js` 从 955 KiB 增至 1391 KiB
（+436 KiB，含 159 KiB CSS 不变）；旧内核退役后 1424 KiB / 160 KiB CSS（parity 收口时 1483 KiB，
退役减少 59 KiB）；2026-11-12 用户反馈增量（块级手柄、表格工具条等）后为
**1437 KiB / 161 KiB CSS**（+12 KiB）。超预算时先裁剪扩展集（表格/高亮/task list 可按需）再评估自实现。

## 5. 体验 parity 验收

- **parity 规格即现有验收清单**：[编辑器还原验收 §2](../acceptance/editor-experience-p0-p6.md)
  的体验行为表逐条过；健壮性条目以[健壮性验收](../acceptance/document-editor-robustness.md)为准。
- **视觉基准**：冻结 `Editor.module.css` + `dom-contract.test.ts` + 验收文档人工清单；旧内核已删除，
  不再有可运行 A/B 对照。**交互**：按验收清单逐项过，历史真实浏览器记录保留为已退役内核时代的证据。
- parity 不承诺 DOM 字节一致：内核允许自有容器类与 widget DOM，渲染视觉与交互行为必须一致。
- 样式/UX 的人工验证项输出条理清晰的清单交用户 Review（交付要求），Agent 不自判。

## 6. 退役决策与执行（2026-11-12）

- **退役依据**：parity 已由验收清单与内核测试锁定；切换后生产代码无旧内核调用方；两个内核读写
  同一份 AST，**数据零迁移**。
- **执行结果**：删除旧 contentEditable 编辑器（`vendor/ui-space/src/components/editor/Editor.tsx`
  与 `editor-utils.ts`；仅 `normalizeBlocks`、`findQuoteOffsets`/`pointAtOffset`、`findQuoteRange`
  迁至 `vendor/ui-space/src/utils/editor-text.ts` 供历史 diff 与评论轨使用）、旧内核适配层
  （`src/document/editors/legacy/kernel.ts`）与内核偏好模块（`kernel-preference.ts`）；
  kernel-agnostic 部分从 `src/document/editors/legacy/` 迁至 `src/document/runtime/`，旧 HTML 资产
  物化 `materialize.ts` 随退役删除，别名改为 `@alter-space/document-runtime`（build.mjs、`tsconfig.json`
  与 `vitest.config.mts` 三处同步）。退役只在客户端：`host/document/editors/legacy/` 是 Host 权威实现，
  保持原名与路径。
- **取舍**：旧 HTML 草稿格式（`alter-doc-legacy-draft/1`）与 `materializeLegacyAssets` 随退役删除，
  **陈旧 HTML 草稿不再恢复**；保存与版本全部是 AST，影响面仅限退役前未提交的本地草稿，这是显式取舍。
- **验证**：编辑器相关套件全绿（内核 297 tests、`--project ui` 404 tests），`tsc`/`lint`/`build`/
  `docs:check` 通过；测试拆为 `tests/ui/document/{page,runtime,editors/tiptap}` 并共享
  `tests/support/document-page.ts`，6 个 legacy 套件删除。
- **代价**：失去应用内一键回滚；回滚 = 回退 git 历史并重新构建。冻结 `Editor.module.css` 与验收文档
  保证回退后仍可判定 parity；不再保留灰度开关。

## 7. 推进顺序

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 内核契约 + 旧内核实现（用真实旧内核验证契约，不动现行接线） | 已落地：契约在 `src/document/editors/kernel.ts`，capture 语义（未编辑时回落 base、事件不含 HTML、destroy 后静默）有 ui 层测试锁定；旧内核实现已随退役删除 |
| M2 | Registry 客户端共享 + ProseMirror schema 映射 | 已落地：客户端清单（`src/document/schema-manifest.ts`）由一致性测试锁定与 Host Registry 同步；PM schema 从清单派生，AST↔PM 双向无损往返覆盖全部节点类型并有降级告警 |
| M3 | Tiptap 内核 + 交互复刻 + 会话层内核无关化 | 已收口（2026-11-12，见 §9）：块级 DOM、浮层、键鼠/输入规则、IME、粘贴与资产、评论绘制全部对齐旧体验并有自动化证据；表格不能移到文档末尾（ProseMirror 需末块承载光标）保留为已知差异；真实浏览器/输入法人工复核待进行 |
| — | bundle 实测 | 接入 AST 内核后 `client.js` 955 → 1391 KiB（+436 KiB）；parity 收口后 1483 KiB / 160 KiB CSS；旧内核退役后 1424 KiB / 160 KiB CSS（-59 KiB）；用户反馈增量后 **1437 KiB / 161 KiB CSS（+12 KiB）**。收录 Tiptap 3 与 ProseMirror；按需裁扩展前先记录该基线 |
| M4 | parity 验收 + 切换默认 | 已切到唯一 AST 内核（2026-11-12 产品授权）；切换后体验回归按 §9 收口，视觉与真实输入法的人工复核仍待进行 |
| M5 | 旧内核退役 | **已完成**（2026-11-12）：删除旧编辑器、内核适配层与内核偏好；kernel-agnostic 运行时迁至 `src/document/runtime` 并更名别名；测试拆为 `tests/ui/document/{page,runtime,editors/tiptap}` |
| — | 用户反馈增量（2026-11-12） | 列表/待办两段式退格、块级手柄、表格完整工具条与「表格（无表头）」、附件任意类型降级、评论输入框不再自动弹出与激活交互；新增内核自有浮层 `block-handle.ts`，`kernel.css` 增加 block handle / drop indicator / `data-block-selected` / `[data-table-action]` 状态样式；内核 297 / ui 404 tests 绿 |

每步独立交付、`pnpm check` 全绿。M3 是最大工作量，成本在交互细节而非架构；运行时迁移
触及数据安全底线，必须保留归属（`me`/`alter`）、事务与裁剪语义。

## 8. 风险与开放决策

风险：

- **交互细节复刻遗漏**：以 parity 清单 + 人工 Review 兜底；slash 菜单定位、表格操作条、
  引用退格语义等逐项有验收条目。
- **会话层 generalize 的回归风险**：保存/草稿/冲突是恢复底线，现有故障注入与恢复测试必须全过。
- **bundle 预算**：引入前实测，超预算先裁剪扩展集。

开放决策：

- transaction 级 Operations（比块级 diff 更细的写入粒度）：先升 spec 再实现，不在本次范围。
- 对象卡（callout/mindmap/component）真实渲染器是否随内核替换顺带落地：仍需产品批准，
  与本决策解耦。

## 9. 切换后的体验基线（2026-11-12）

旧内核退役后，文档页的当前事实：

| 体验点 | 当前事实 |
| --- | --- |
| 冻结样式 | 冻结 `Editor.module.css` 是 CSS Modules，类名带哈希；内核从冻结样式表解析类名后挂载，**不复制样式、不写字面量类名**。除产品批准的最小必要追加（空文档占位符定位、附件态 hover/focus、图片/表格选中态）外不改写既有规则；新增选择器集中在同一冻结样式表内，视觉基准以人工清单为准 |
| 块级 DOM | 以冻结 DOM 契约（`data-todo`、`data-file`、`data-link-card`、`data-doc-link`、`data-divider`、`th`/`td` 等）为准，冻结 CSS 原样命中；内部节点可以有内核自有名字，但渲染出的 DOM 必须符合契约（`dom-contract.test.ts` 锁定） |
| 显式重载 | 正文来源是「页面显式传入的文档」：内核按文档身份 + revision 重载，页面只在显式重载时更新它（保存回显不重建编辑面）；版本恢复、冲突重载与草稿恢复不会被下一次保存覆盖 |
| 评论 | 用 CSS Custom Highlight API 绘制 `::highlight(alter-comment)`；划词不再自动弹输入框（只在「添加评论」工具栏动作或点击已评论文字时打开）；光标进入/离开评论文本时上报 `onCommentAtCaretChange`，评论轨卡片与正文高亮跟随；锚点与 quote 随编辑维护并回写服务端，不在正文里包 DOM；激活评论背景调浅（有意视觉增量），普通评论仍只有下划线 |
| 块身份 | 新块在进入文档时分配一次稳定 id；id 是评论锚点与 Operations diff 的身份，不随保存漂移 |
| 列表/待办退格 | 空列表项/空待办行两段式退格：第一步原位退成空段落（待办只去掉 checkbox），第二步删掉空行、把被拆分的同名列表合并、光标回到上一行末尾；有文字的行首退格保持默认合并语义（有意偏离旧基线） |
| 块级手柄 | hover 顶层 block 左侧显示六点手柄；点击全选（文本块 TextSelection，atom/表格 NodeSelection 并标记 `data-block-selected`）；拖拽调整顺序（插入指示线、保留节点 id 与评论锚点、Esc/拖出取消、仅顶层 block、鼠标事件实现未覆盖触屏）；内核自有浮层 `block-handle.ts` |
| 表格增强 | 光标在表内显示完整深色工具条：上下插行、左右插列、删除行/列、合并/拆分单元格、表头开关（首行 th/td 反转，与 AST `headerRows` 一致）、上移/下移、删除表格；`data-table-action` + active/disabled 视觉；hover 仍显示旧「选中」，整表选中仍是旧 3 按钮；slash 新增「表格（无表头）」`table-plain`（3×3 全 td）；合并/拆分跨度随 AST 保存 |
| 浮层与键鼠 | slash 菜单（图标/文案/定位/方向固定/IME）、格式工具栏（文本类型菜单、定位翻转、选区字符数）、链接条与表格条、块选中状态机、输入规则、键盘边界、粘贴/拖入与资产上传逐项对齐冻结验收 |

**bundle**：当前 `client.js` 1437 KiB / 161 KiB CSS（parity 收口 1483 / 160；旧内核退役 1424 / 160，
-59 KiB；用户反馈增量 +12 KiB）。

保留的已知差异（记入验收清单，不视为缺陷）：

- 文本类型菜单锚在工具栏按钮上，旧实现锚在工具栏整体；Menu 左缘约 4px 差异。
- 卡片 ⇄ 行内链接互转在 `alter-doc/1` 中必然跨块重构（旧 DOM 可原位互转）。
- 表格不能下移到文档末尾：ProseMirror 需要末块承载光标。
- callout / mindmap / component 仍是无人工编辑入口的占位卡（旧 UI 同样没有入口）。

## 相关文档

- [document-content-architecture.md](document-content-architecture.md) — AST 权威与五条原则
- [document-editor-robustness.md](document-editor-robustness.md) — 健壮性现状与数据层先行决策
- [specs/document-model-v0.md](../specs/document-model-v0.md) — 节点模型与 Schema Registry
- [specs/document-operations-v0.md](../specs/document-operations-v0.md) — Operations 契约
- [specs/system-architecture.md](../specs/system-architecture.md) — Host/Client/vendor 边界与测试分层
- [acceptance/editor-experience-p0-p6.md](../acceptance/editor-experience-p0-p6.md) — parity 规格来源
