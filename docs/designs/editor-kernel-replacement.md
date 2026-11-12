---
type: design
status: active
updated: 2026-11-11
---

# 编辑器内核替换：体验不变，内核可换

这篇方案回答「文档页 UI/UX 体验不变的前提下，为什么把编辑器内核从手写 contentEditable 换成
AST 原生编辑器、用什么保证体验不回归、按什么顺序推进与验收」。内容架构与写入契约以
[document-content-architecture.md](document-content-architecture.md) 与
[specs/document-operations-v0.md](../specs/document-operations-v0.md) 为准；健壮性现状以
[document-editor-robustness.md](document-editor-robustness.md) 为准；本篇只记录方向、取舍与验收边界。

## 1. 产品决策：冻结体验，不冻结实现

- **结论**（2026-11-11 产品决策）：文档页的不变约束从「DOM/CSS 字节级一致」升级为
  **视觉与交互 parity**；编辑器内核允许替换。
- **现行默认是 AST 原生内核**（2026-11-12 切换）：`editors/tiptap` 接管正文编辑；legacy 内核与
  其适配层保留为回滚路径（偏好 `{ current: "legacy" }`），退役前不得删除。
- **冻结条款仍然有效**，只是对象变成「体验」：壳层、CSS 与工具栏/菜单/评论轨/历史面板的视觉不变，
  [编辑器还原验收](../acceptance/editor-experience-p0-p6.md)里的旧体验行为仍是回归基准。
- 理由：产品要的是用户体验的连续性，不是实现的连续性；字节级 DOM 冻结把健壮性修复全部挤进
  数据层，错误提示与恢复入口的设计空间受限（健壮性方案已列此为风险）。

## 2. 现方案的结构性问题

现方案可用且有验收证据，但以下代价是结构性的，继续打补丁不能消除：

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
| 编辑器内核 | contentEditable 实现与其内部内容格式 | **可替换** |
| 会话层 | 保存生命周期（防抖/单飞/CAS 冲突）、草稿与崩溃恢复、评论锚点、块级 diff | 提为内核无关共享层 |

关键决策：

- **壳层只认 AST**：内核契约是「加载 AST / 捕获回 AST / dirty 通知 / 选区与评论事件」，
  内核内部格式（legacy 的 HTML、新内核的 ProseMirror JSON）是内核自己的事。两个内核都由
  React 承载，共享同一 props 与命令式 handle 契约；契约放 `src/document/editors/contract.ts`，
  内核实现放 `src/document/editors/<kind>/`。
- **Schema Registry 是唯一事实源**：新内核的节点 schema 从现有 registry 生成，AST↔内核状态
  是无损树映射，中间不再有 HTML 字符串——这才真正落地内容架构的原则 5。
- **保存链路复用**：内核捕获 → AST → 现有块级 diff → Operations；会话层 generalize 后
  legacy 与新内核走同一条保存/草稿/冲突路径。评论锚点从 quote 启发式升级为内核位置↔blockId
  精确映射，旧数据保留 quote 兜底。
- **legacy 适配层随内核退役**：HTML 投影/解析是 legacy 内核的私有能力，不是共享资产；
  新内核不经过它。

## 4. 内核选型：Tiptap 3（ProseMirror）

**结论**：新内核用 Tiptap 3。理由：依赖已在仓库且有历史实现经验；ProseMirror 文档模型与
`alter-doc/1` 同构（类型化节点树 + attrs + marks + 稳定 id），transaction 模型天然映射
Operations；IME、语义化撤销、粘贴清洗与跨块选区经过生产验证。

被否方案（各一句话）：

- **Lexical**：同样可行，但无既有投入，schema/协作生态迁移成本更高。
- **继续手写内核**：已约 4000 行且真实输入法/断网仍有缺口，边际成本高于引入框架。
- **Notion 式每块独立编辑器**：跨块选区与 IME 复杂度不可接受，框架已解决文档级选区。

**bundle 成本**：实测引入 Tiptap 3 + ProseMirror 后 `client.js` 从 955 KiB 增至 1391 KiB
（+436 KiB，含 159 KiB CSS 不变）。超预算时先裁剪扩展集（表格/高亮/task list 可按需）再评估自实现。

## 5. 体验 parity 验收

- **parity 规格即现有验收清单**：[编辑器还原验收 §2](../acceptance/editor-experience-p0-p6.md)
  的旧体验行为表逐条过；健壮性条目以[健壮性验收](../acceptance/document-editor-robustness.md)为准。
- **视觉**：对 `c73c3f6` 基线做截图对照；**交互**：复用现有真实浏览器回归用例。
- parity 不承诺 DOM 字节一致：新内核允许自有容器类与 widget DOM，渲染视觉与交互行为必须一致。
- 样式/UX 的人工验证项输出条理清晰的清单交用户 Review（交付要求），Agent 不自判。

## 6. 灰度与回滚

- 内核选择是 localStorage UI 偏好（符合「localStorage 只存 UI 偏好」硬约束），默认 legacy。
- **数据零迁移**：两个内核读写同一份 AST；legacy 草稿格式保持可读，新内核用自己的草稿
  载荷，恢复/丢弃/保留覆盖的会话语义一致。
- parity 通过后切默认；观察一个版本后退役 legacy 适配层（HTML 投影/解析与专属测试一同退场）。
- 退役前任何 parity 回归都可一键回滚 legacy；回滚路径保留到退役为止。

## 7. 推进顺序

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 内核契约 + legacy 内核实现（用真实旧内核验证契约，不动现行接线） | 已落地：契约 `src/document/editors/kernel.ts`，legacy 实现在同一层，capture 语义（未编辑时回落 base、事件不含 HTML、destroy 后静默）有 ui 层测试锁定 |
| M2 | Registry 客户端共享 + ProseMirror schema 映射 | 已落地：客户端清单（`src/document/schema-manifest.ts`）由一致性测试锁定与 Host Registry 同步；PM schema 从清单派生，AST↔PM 双向无损往返覆盖全部节点类型并有降级告警 |
| M3 | Tiptap 内核 + 交互复刻 + 会话层内核无关化 | 进行中：Tiptap 内核可挂载、按旧 CSS 选择器渲染、无损 capture；保存控制器与草稿内核无关；DocumentView 已按偏好切换内核；slash 菜单、`---` 即时转分割线、评论下划线装饰、浮层格式工具栏、表格操作条、链接操作条、划词评论引用、`Mod-U` 与 `》`/`[]` 行转换快捷键已复刻；表格不能移到文档末尾（ProseMirror 需末块承载光标）；parity 人工验收未完成 |
| — | bundle 实测 | 接入 AST 内核后 `client.js` 955 → 1391 KiB（+436 KiB），收录 Tiptap 3 与 ProseMirror；按需裁扩展前先记录此基线 |
| M4 | parity 验收 + 开关切默认 | **默认已切到 AST 内核**（2026-11-12 产品授权）；legacy 保留为回滚路径（偏好 `{ current: "legacy" }`）。视觉与真实输入法的人工复核仍待进行，发现问题按回归处理 |
| M5 | legacy 退役 | 未开始 |

每步独立交付、`pnpm check` 全绿。M3 是最大工作量，成本在交互细节而非架构；会话层 generalize
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

## 相关文档

- [document-content-architecture.md](document-content-architecture.md) — AST 权威与五条原则
- [document-editor-robustness.md](document-editor-robustness.md) — 健壮性现状与数据层先行决策
- [specs/document-model-v0.md](../specs/document-model-v0.md) — 节点模型与 Schema Registry
- [specs/document-operations-v0.md](../specs/document-operations-v0.md) — Operations 契约
- [specs/system-architecture.md](../specs/system-architecture.md) — Host/Client/vendor 边界与测试分层
- [acceptance/editor-experience-p0-p6.md](../acceptance/editor-experience-p0-p6.md) — parity 规格来源
