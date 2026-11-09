---
type: research
status: active
updated: 2026-11-09
---

# 空间文档的存储格式与位置调研

这篇调研回答：未来的空间文档（文字之外还有图片、高亮块、mindmap、AI 生成的可交互组件）应该用什么
格式作为权威存储、存放在哪里，以及这对 Agent 读写接口意味着什么。结论已被采纳，当前方向见
[文档内容架构](../designs/document-content-architecture.md) 与[文档模型 v0](../specs/document-model-v0.md)；
本篇只保留仍影响决策的对比与证据。

## 问题与约束

- 现状：正文以 HTML 字符串存储（编辑器直接写 `innerHTML`，见 `vendor/ui-space` 编辑器），图片以 data
  URL 内联。富块与组件无处安放，标签噪声也让 AI 难以稳定读写。
- 未来内容：文字 + 行内格式 + 块结构，以及图片、高亮块（callout）、mindmap、可交互组件。
- 硬约束：AI 是主要作者，需要可读可写的文本接口；版本与快照体积可控；可导出 Markdown；
  正文不执行任意代码；迁移只要求语义保真、不要求像素级保真。

## 把「存储格式」拆成四层

混在一起讨论容易打架，四层应分别决策：

| 层 | 内容 | 要求 |
| --- | --- | --- |
| ① 正文内容模型 | 文本 + 行内 marks + 块结构 | 能表达标题/列表/引用/代码/表格等，AI 可读写 |
| ② 富块扩展 | 高亮块、图片、mindmap、交互组件 | 有类型、可校验，不能是无类型 HTML |
| ③ 对象与资产 | 大 payload、二进制 | 独立于正文存储，可复用、可版本化 |
| ④ 权威存储位置 | 数据库 vs 工作区文件 | 满足事务、备份、权限与协作边界 |

## 四类内容适合的表示

| 内容 | 本质 | 适合的表示 | 不适合的表示 |
| --- | --- | --- | --- |
| 文字 + 行内格式 | 文本 | Markdown（AI 友好、diff 友好） | HTML（标签噪声）、整篇 JSON（AI 编辑差） |
| 图片 | 二进制 + 引用 + 布局 | 内容寻址资产 + 正文引用 | 正文内联 base64（撑大版本与快照） |
| 高亮块 | 容器 + 子块 + 样式 | 带类型的容器块或受控指令 + 内部 Markdown | 无类型 HTML div、把整块塞进 JSON |
| mindmap | 图结构（节点/边/布局） | 独立 JSON 对象 + 渲染器，正文只放引用 | Markdown/纯文本（表达不了）、内联巨型 JSON |
| 可交互组件 | 代码/spec + 实例状态 + 安全边界 | 版本化组件 spec + 实例引用，沙箱渲染 | Markdown、MDX、正文内联脚本 |

结论：文字用 Markdown，容器块用带类型节点，交互对象走「旁表对象 + 正文引用」，二进制走资产库——
四类各得其所，不用一种格式硬扛全部。

## 候选格式对比

| 维度 | HTML（现状） | 纯 Markdown | Markdown 权威 + 指令/对象 | JSON AST 权威 + Markdown 投影 | MDX |
| --- | --- | --- | --- | --- | --- |
| AI 读写质量 | 差 | 最好 | 好（正文是 Markdown，对象用工具） | 中（读投影、写结构化工具，轮次偏高） | 差（要生成 JSX） |
| 富块 / 自定义节点 | 勉强但无类型 | 不支持 | 引用对象 | 原生块 + 自定义 node view | 支持但需执行 JS |
| 安全 | 差（脚本/事件） | 好 | 好（组件沙箱） | 好（受控渲染，组件仍需沙箱） | 差（任意依赖） |
| 校验 / 类型 | 弱 | 弱 | 中 | 强（整篇 schema） | 弱 |
| 版本 / diff 体积 | 大（标签 + base64） | 小 | 小（对象外置） | 中—大（整树快照，需规范化与对象外置） | 中 |
| 可读 / 可导出 | 一般 | 最好 | 好（富块降级为围栏/链接） | 一般（需投影，富块有损） | 差 |
| 编辑器成本 | 已投入（contentEditable） | 中 | 中高（AST 编辑器 + 自定义节点） | 高（ProseMirror/Tiptap 级重写） | 高 |
| 迁移成本（自 HTML） | 0 | 中 | 中 | 高（HTML→AST 保真更难） | 最高 |

两条可行路线没有绝对优劣，差别在编辑主战场与长期产品形态：

- **Markdown 权威（text-first）**：正文即 `.md`，AI 读写、diff、导出、版本体积最优；代价是块编辑、
  稳定块 id、实时协作的上限较低，且仍需换成 AST 型 Markdown 编辑器。
- **JSON AST 权威（block-first）**：块树 + 强 schema，稳定 block id、原生块编辑、组件节点、CRDT 协作
  上限最高；代价是编辑器重写、版本更大、迁移更难，Agent 写作接口要另做 Markdown 投影。

适用条件：产品重心偏「长文写作、AI 主笔、Markdown 互操作」选 text-first；偏「块/卡片拼装、自定义块、
实时协作、块级引用」选 block-first。两者都重要时，可组合为「AST 权威 + Markdown 投影」——这也是被采纳
的方向。

**不推荐**：HTML 作为长期格式（无类型、不安全、体积大）；纯 Markdown（表达不了富块与对象）；
MDX（可执行 JSX，安全与构建成本不可接受）。

## 存储位置：数据库还是工作区文件

| 方案 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- |
| SQLite 权威 | 沿用现有事务、单写者队列、版本、评论、搜索；备份链路不变 | 外部工具不能直接编辑，需要导出 | **采用**：正文 + 对象旁表进库，资产落文件 |
| 工作区 `.md` 文件权威 | git/Obsidian/VSCode 可直接编辑，天然导出 | 无事务、跨文件一致性、外部编辑冲突、版本/评论/搜索要重建 | 暂不采用 |
| DB 权威 + 单向 `.md` 镜像 | 兼顾可移植、可外部阅读 | 镜像同步逻辑与冲突处理 | 可选增强 |
| 文件权威 + DB 索引 | Obsidian 式 | 同「文件权威」，且把工作区变成数据库 | 仅当外部编辑成为核心需求再评估 |

资产注意：二进制放文件系统后，每日快照必须覆盖资产目录（备份不能只覆盖数据库），否则恢复后图片丢失；
资产清单应纳入备份与恢复的验收范围。

## 对现有系统的迁移影响

存储格式变化会同时波及以下现有资产，迁移时必须成组考虑，不能只换正文格式：

| 现有资产 | 影响 | 迁移方向 |
| --- | --- | --- |
| 文档正文（HTML 字符串） | 存储格式变化，旧数据需转换 | 双格式共存（用 `contentFormat` 区分），后台批量转换；复用已有 HTML→Markdown 导出（`vendor/ui-space/src/utils/markdown.ts`），图片从 data URL 迁到资产库 |
| 编辑器（contentEditable） | 需要替换或扩展 | Markdown 路线换 AST 型 Markdown 编辑器；AST 路线换块编辑器 + 自定义 node view——这是本方案最大成本项 |
| 评论（quote 锚点） | 不受影响（按纯文本 quote 定位） | 先按 quote 匹配；AST 路线可额外用 block id 做精确锚点 |
| 版本历史（旧版本是 HTML） | 旧版本按 HTML 渲染，新版本按格式区分 | 历史版本保留原格式；AST 版本体积更大，需重估版本预算 |
| Agent 读写工具 | 需要重做 | 统一改为「读 Markdown 投影 + 写 Operations/对象工具」；按 HTML 精确替换的设计作废 |
| 每日快照 / 备份 | 新增资产目录 | 备份与恢复流程显式覆盖资产，单文档导出打包引用资产 |

## 对 Agent 接口设计的影响

**存储格式 ≠ Agent 接口。** 无论选哪条路线，Agent 都应面向 Markdown 投影，而不是 HTML 或整棵树：

- **读**：先用 `outline` 拿块树与预览，再按范围返回 Markdown 投影（带稳定块 id）与对象索引；
  不返回 HTML，不内联 base64。
- **写**分两层：文本层按目标块做精确替换（模型最自然的写作方式）；结构层（插入/删除/移动/改属性/
  对象 payload）走专用工具并做 schema 校验。
- **富对象**（mindmap、组件）一律走专用工具，不让模型直接拼 payload；资产走上传接口拿 id。
- 长文档先 `outline`/`search` 定位、再按范围读，避免整篇进上下文；所有 target 用稳定块 id，
  不用「第 3 段」这类会漂移的位置描述。
- 按 HTML 做精确替换的旧工具设计在 AST 下作废，最多作为过渡期能力。

## 风险与取舍

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 投影 / 序列化 round-trip | Markdown 与编辑器规范化可能改变空白与标记 | 固定 canonical 序列化器 + 语料回归（golden corpus） |
| schema 演进 | 块类型/属性升级要迁移旧文档与旧版本 | schemaVersion + 迁移函数 + fixture 回归；未知类型保留占位 |
| 版本体积 | AST 比 Markdown 大，固定版本的字节预算需重估 | 对象/资产外置；规范化紧凑序列化；块级增量或按篇累计上限 |
| 投影有损 | 富块无法无损导出/回写 | 投影只用于读与导出；写一律走 Operations/对象工具，不做整篇回写 |
| 编辑器改造成本 | 两条路线都要换掉 contentEditable | 用成熟底座，先做文字/图片/高亮块，再补 mindmap 与组件 |
| 对象生命周期 | 不可变对象 + 版本引用会累积 | 按「被版本引用 + 保留期」GC |
| 组件安全 | AI 生成代码 | 默认声明式组件；代码组件仅沙箱 iframe + CSP + 能力白名单 + provenance 审核 |
| 迁移保真 | 旧 HTML 的样式与合并单元格会丢 | 明确「迁移只保语义，不保像素」；保留旧版本可回溯 |
| 第三方工具兼容 | 外部 Markdown 工具不认指令、不支持 AST | 指令降级为可见围栏代码块；提供 Markdown 导出 |

## 结论（已收敛）

已收敛为 **JSON AST 权威 + Markdown 投影 + Document Operations** 的混合架构：

- 权威存储是 AST（块与行内节点树）；Markdown 是只读投影，用于 Agent 读取与新内容生成，不是第二份
  真源，也不承诺无损。
- 结构修改一律走 Document Operations：带 `baseRevision`、原子事务、可审计、可逆；富对象与资产通过
  旁表与引用承载，避免每版快照重复大 payload。
- 单一 Schema Registry 同时产出存储 schema、编辑器节点、Agent 工具 JSON Schema、投影器与迁移函数，
  避免多套定义漂移。
- 落地基准：[文档模型 v0](../specs/document-model-v0.md)、[Operations v0](../specs/document-operations-v0.md)、
  [Agent 文档工具契约](../specs/agent-doc-tools-v0.md)；方向与取舍理由见
  [文档内容架构](../designs/document-content-architecture.md)。

## 参考链接

- Notion 的 block 数据模型：<https://www.notion.com/blog/data-model-behind-notion>
- BlockNote 的 block JSON 与 Markdown 导出：<https://www.blocknotejs.org/docs/foundations/document-structure>
- ProseMirror Guide（文档 = 节点树 + schema + transaction）：<https://prosemirror.net/docs/guide/>
- MyST Markdown directive 体系（指令块的成熟先例）：<https://mystmd.org/guide/directives>
- MDX 官方定义（Markdown + JSX/ESM，可执行）：<https://mdxjs.com/docs/what-is-mdx/>

## 相关文档

- [文档规则](../README.md)
- [文档内容架构（方案）](../designs/document-content-architecture.md)
- [调研索引](README.md)
