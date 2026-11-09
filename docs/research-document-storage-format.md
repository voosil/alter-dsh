# 文档存储格式调研与建议

- 状态：调研结论（已收敛架构，未实现）；2026-11-09 讨论后确定终局方向为 §11「JSON AST 权威 + Markdown 投影 + Document Operations」
- 日期：2026-11-09
- 背景：Space 文档当前以 HTML 字符串存储（编辑器 `innerHTML`）。产品预期是「Markdown 页面」未来不只有文字，还有图片、高亮块、mindmap、AI 生成的可交互组件。需要先定这种文档应该用什么数据格式存储。
- 关联：[Agent 空间文档读写方案](./design-agent-space-documents.md)（格式决定会直接改变 Agent 读写工具的设计）

---

## 0. 结论（TL;DR）

这类文档有两种成熟的权威格式，差别不在「能不能存」，而在「编辑主战场与长期产品形态」：

- **路线 A：Markdown 为权威源**（CommonMark/GFM + 受控指令块 + 对象旁表 + 内容寻址资产，可称「Alter Markdown」）——**text-first**。AI 读写、diff/导出、版本体积最优；编辑器仍需换成 AST 型 Markdown 编辑器。
- **路线 B：JSON AST 为权威源**（块/行内节点树，Notion/BlockNote/ProseMirror 式）+ Markdown 作为 Agent/导出投影——**block-first**。类型 schema、稳定 block id、原生块编辑、组件节点、CRDT 协作的上限最高；代价是 Agent 工具更重、版本更大、迁移与编辑器成本更高。

两条路线相同的结论：

1. **正文语义 = 文本 + 行内 marks + 块结构**；行内高亮用 mark，容器（高亮块）用带类型的容器节点/指令，不用无类型 HTML。
2. **mindmap、可交互组件一律是「独立对象 + 引用」**，不进正文载荷；对象不可变、有 schema 与 provenance。
3. **图片/附件用内容寻址资产**，正文不再内联 base64（当前编辑器是 dataURL，会撑大 SQLite/版本/快照）。
4. **不推荐**：HTML 作为长期格式；纯 Markdown；MDX（可执行 JSX，安全与构建成本不可接受）。
5. **Agent 接口与存储格式解耦**：无论 A/B，Agent 都应读 Markdown 投影（带 block id），写用「精确替换 + 结构化对象工具」。
6. 存储位置：首期仍 SQLite 权威 + 资产文件；工作区 `.md` 文件作为导出/镜像，暂不做权威。

我的倾向：若未来 12–18 个月的产品重心是「Notion 式块编辑 + mindmap/交互组件 + 可能的实时协作」，**路线 B 的长期上限更高**；若重心是「AI 快速写作、长文、Markdown 可导出」，**路线 A 更省**。建议先用 §9 的 spike 在同一批文档、同一批 Agent 任务上做 A/B 对比再拍板（判断标准见 §10）。

**2026-11-09 讨论后已收敛**：采纳「**JSON AST 权威 + Markdown 作为 AI 投影 + Document Operations 精确修改**」的混合架构，作为终局方向（详见 §11）。关键是区分：AI 的**内容生成**用 Markdown，**精确修改**用 Operations，**权威存储**是 AST；三者不混用。

---

## 1. 先把「存储格式」拆成四层

混在一起讨论会打架，建议分开决策：

| 层 | 内容 | 本方案 |
| --- | --- | --- |
| ① 正文内容模型 | 文本 + 行内格式 + 块结构 | Markdown（CommonMark/GFM）+ 少量行内扩展（`==高亮==`） |
| ② 富块扩展 | 高亮块、图片、mindmap、交互组件 | 容器用受控指令；原子对象用「引用 + 旁表 JSON」 |
| ③ 对象与资产存储 | 大 payload、二进制 | SQLite 旁表（对象 JSON）+ 文件系统（内容寻址资产） |
| ④ 权威存储位置 | 数据库 vs 工作区文件 | 首期 SQLite 权威；可选 `.md` 镜像导出 |

---

## 2. 未来四类内容分别适合什么表示

| 内容 | 本质 | 适合的表示 | 不适合的表示 |
| --- | --- | --- | --- |
| 文字 + 行内格式 | 文本 | Markdown（AI 友好、diff 友好） | HTML（冗余）、整篇 JSON（AI 编辑差） |
| 图片 | 二进制 + 引用 + 布局 | 资产引用 `![alt](space-asset://…)` / figure 指令 | 正文内 base64（当前做法，撑大一切） |
| 高亮块（callout） | 容器 + 子块 + 样式 | 指令容器 `:::callout{type=…}` + 内部 Markdown | HTML div（无类型、AI 难改）、JSON 块（过度） |
| mindmap | 图结构（节点/边/布局） | 独立 JSON 对象 + 渲染器，正文只放引用 | Markdown/文本（表达不了）、内联巨型 JSON（污染正文） |
| AI 交互组件 | 代码/spec + 实例状态 + 安全边界 | 版本化组件 spec 记录 + 实例对象引用，沙箱渲染 | Markdown、MDX（可执行 JSX）、正文内联脚本 |

结论：**文字用 Markdown，容器块用指令，交互对象用「旁表 JSON + 正文引用」，二进制用资产库**。这四类各得其所，而不是用一个格式硬扛全部。

---

## 3. 候选格式对比

| 维度 | A. HTML（现状） | B. 纯 Markdown | C. **Markdown + 指令 + 对象（路线 A）** | D. **JSON AST + Markdown 投影（路线 B）** | E. MDX |
| --- | --- | --- | --- | --- | --- |
| AI 读写质量 | 差（标签噪声、易写坏） | 最好 | 好（正文为 MD，对象用工具） | 中（读 MD 投影，写结构化工具；轮次/token 更高） | 差（要生成 JSX） |
| 高亮块 | 可但无类型、难校验 | 不支持 | ✅ 容器指令 | ✅ 原生 block | ✅ |
| mindmap/交互组件 | 只能 iframe/脚本，危险 | 不支持 | ✅ 引用对象 | ✅ 原生 block（自定义 node view） | ✅ 但需执行 JS |
| 安全 | 差（`innerHTML` + 脚本/事件） | 好（无执行） | 好（无执行；组件沙箱） | 好（渲染器受控；组件仍需沙箱） | 差（任意 JS/依赖） |
| 校验/类型 | 弱 | 弱 | 中（对象 JSON 有 schema；正文语法受控） | 强（整篇 schema 完整） | 弱 |
| diff / 版本体积 | 大（标签 + base64） | 小 | 小（对象不重复进版本） | 中—大（整树快照；需对象外置 + 规范化序列化） | 中 |
| 可读/可导出 | 一般 | 最好（原样 .md） | 好（导出时对象降级为围栏/链接） | 一般（需要 Markdown 投影/导出器，富块有损） | 差 |
| 编辑器成本 | 已投入（contentEditable） | 中（Markdown 编辑器） | 中高（AST 编辑器 + 自定义节点） | 高（ProseMirror/Tiptap/Lexical/BlockNote 重写 + node view） | 高 |
| 协作/CRDT 前景 | 弱 | 弱 | 中（可演进为指令 AST/block） | 最强（ProseMirror/Tiptap+Yjs 原生路径） | 弱 |
| 迁移成本（从当前 HTML） | 0 | 中（HTML→MD 已有导出器） | 中（需补块映射与资产迁移） | 高（HTML→AST 需 schema 解析/转换，保真更难） | 最高 |

**结论**：C 与 D 没有绝对优劣——**C 优化「AI 写作 + 文本互操作 + 轻量」，D 优化「块编辑 + 类型安全 + 协作上限」**。A/B/E 分别对应「不换」「能力不足」「不该用」。具体取舍见 §4.4–§4.5。

---

## 4. 两条可行路线：Alter Markdown（A）与 JSON AST（B）

### 4.1 一个文档长什么样（路线 A）

````markdown
# 鉴权方案

结论：先做 P0，**只读工具**优先，高亮部分是待确认项。

:::callout{type="warn" title="待确认"}
第三方登录的 token 刷新策略还没定，需要和 @安全 对齐。
:::

![架构草图](space-asset://asset_01HX…)

:::mindmap{id="obj_01HX…" caption="鉴权流程"}

:::component{id="obj_01HY…" title="Token 过期时间模拟器"}
````

- 正文 100% 是合法 Markdown（CommonMark + GFM），任何 Markdown 工具都能打开/渲染/导出。
- `:::` 指令是 **受控扩展**：类型白名单、属性 schema 校验；未知类型按纯文本保留，不崩。
- mindmap/组件的真实数据不在正文里，只在旁表；正文里的 id 是稳定引用。
- 图片用 `space-asset://` 自定义协议，渲染时由 Host/客户端解析为资产内容。

### 4.2 数据模型

```jsonc
// SpaceNode（扩展现有实体，未知字段对 vendor 服务无影响）
{
  "content": "…markdown…",
  "contentFormat": "alter-md/1",       // 旧文档缺省视为 "html/1"
  "documentVersion": 1
}

// 新旁表（插件自有，不写入 vendor 实体）
doc_objects(
  id TEXT PRIMARY KEY,                 // obj_…
  docId TEXT NOT NULL,
  type TEXT NOT NULL,                  // mindmap | component | …
  schemaVersion INTEGER NOT NULL,
  payloadJson TEXT NOT NULL,           // 类型化 JSON，写入前校验
  provenanceJson TEXT,                 // { generatedBy:'alter', model, promptRef, at }
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
)

component_specs(
  hash TEXT PRIMARY KEY,               // sha256(canonical source)
  format TEXT NOT NULL,                // 'declarative-json' | 'html-sandbox' | 'esm-sandbox'
  source TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  provenanceJson TEXT
)

doc_assets(
  id TEXT PRIMARY KEY,                 // asset_…
  sha256 TEXT NOT NULL UNIQUE,         // 内容寻址，天然去重
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  name TEXT,
  createdAt TEXT NOT NULL
)
// 二进制文件落在 `${dataDir}/assets/<sha256前两位>/<sha256>.<ext>`，DB 只存元数据
```

**对象不可变**：编辑 mindmap/组件 = 生成新对象 id 并替换正文里的引用；旧对象保留给历史版本，回收站/GC 按「是否仍被任何版本引用 + 是否超过历史保留期」清理。这样：

- 文档版本（现有 `DocVersion.content`）只存 Markdown 文本，体积小、diff 干净；
- 恢复旧版本时引用的旧对象还在，渲染一致；
- 大 payload（组件源码、mindmap 图）不会在每版快照里重复。

### 4.3 四类内容的具体落地

**图片/附件**

- 上传 → 算 sha256 → 存资产库（文件系统）→ 正文写 `![alt](space-asset://asset_…)`。
- 渲染器解析 `space-asset://` 取流；导出 Markdown 时可选择「内嵌 base64 / 复制资产目录 / 保留链接」。
- 好处：正文不再含 base64；同一图片多文档引用只存一份；版本/快照体积可控。
- 备份影响：**资产目录必须纳入备份**（现在只有 SQLite 快照）；或资产也进 DB 但用单独的表避免整库膨胀——二选一，见 §6。

**高亮块 / callout**

- 用容器指令，不建对象：`:::callout{type="info|warn|success" title="…"}` + 内部任意 Markdown。
- 解析器按 remark-directive 规则处理嵌套；未知属性忽略并记录告警。
- 也可以用 `>` 引用块 + 属性行做极简版；但指令更明确、可扩展。

**mindmap**

- 对象类型 `mindmap`，payload 建议：
  ```json
  { "root": { "id": "n1", "text": "鉴权", "children": [
      { "id": "n2", "text": "OAuth", "note": "…" } ] },
    "layout": { "type": "tree", "direction": "LR" },
    "theme": "default" }
  ```
- 生成方式：AI 生成初稿（JSON）→ 用户拖拽编辑（写回新对象 id）→ 正文引用更新。
- 也可先用 Mermaid 指令过渡（`:::mermaid` 内是文本），但 mindmap 的可交互编辑最终需要结构化对象，建议一步到位。

**AI 生成的可交互组件**

- 分两类，统一用 `component` 对象承载：
  1. **声明式组件**（推荐默认）：`payload = { renderer:'chart|table|form|dashboard', props:{…}, bindings:[…] }`，由内置渲染器画，最安全、可校验。
  2. **沙箱代码组件**：`payload = { specHash, props, stateRef? }`；`component_specs` 存不可变源码（HTML/ESM），渲染在 `sandbox="allow-scripts"` 的 iframe 中（CSP `default-src 'none'`，无同源、无网络、通过 postMessage 与宿主通信）。
- 文档里只放实例引用（`:::component{id=…}`），代码/spec 单独版本化：同一组件可复用，升级 spec 不影响已固定版本的实例；来源（AI 生成/用户编辑）与模型信息写进 provenance。
- 安全边界：正文永远不执行内容；组件执行只发生在沙箱 iframe；生成代码需经过静态检查/白名单能力（可选）。

### 4.4 路线 A vs 路线 B：怎么选

两条路线共享同一套**语义模型**（块类型、行内 marks、对象引用、资产），真正的差别是「权威序列化表示」与「编辑器生态」：

| 关注点 | A. Markdown 权威（text-first） | B. JSON AST 权威（block-first） |
| --- | --- | --- |
| 权威源 | `.md` 文本 + 指令块 | 结构化 JSON 树（另带 Markdown 投影） |
| 编辑器 | Markdown AST 编辑器（Milkdown / Tiptap+Markdown 等） | block 编辑器（BlockNote / Tiptap / Lexical / ProseMirror） |
| Agent 读 | Markdown（天然） | Markdown 投影 + block id |
| Agent 写 | Markdown 精确替换 | 结构化 block 工具（可辅以按 block id 的文本精确替换） |
| 版本 / diff | 文本 diff，体积小 | 树快照 + 块级 diff，体积较大（需对象外置/规范化） |
| 协作 / CRDT | 需自建或额外方案 | Yjs 成熟路径（ProseMirror/Tiptap） |
| 外部互操作 | 原生 `.md`（git/Obsidian 友好） | 需要 Markdown 导出，富块有损 |
| 块引用 / 评论锚点 | 文本 quote，较弱 | 稳定 block id，精确、可跨文档引用 |
| 从当前 HTML 迁移 | 中（已有 `htmlToMarkdown`） | 较高（HTML→AST 需 schema 解析/转换） |
| 最适合 | 长文写作、AI 主笔、可导出 | 块编辑、大量自定义块、实时协作 |

**用 4 个问题判断**：

1. 用户主要在「长文写作界面」还是「块/卡片拼装界面」里工作？
2. 12–18 个月内是否需要实时协作/多端同步？
3. 是否需要块级引用、精确评论锚点、跨文档引用？
4. Markdown 导出 / git / Obsidian 互操作是否是刚需？

偏「长文、暂不协作、引用要求低、要互操作」→ A；偏「块编辑、要协作、要引用、可接受导出」→ B。

**本项目的信号**：Alter 的 `PRODUCT.md` 明确写「内容组织参考 Notion 的易理解性」，当前编辑器已经是块式 UX（slash 菜单、标题/列表/引用/代码/表格/图片/文件/分割线），未来又要 mindmap/交互组件——这组信号偏向 **B**；但「AI 是主要作者、需要 Markdown 导出」偏向 **A**。所以不建议拍脑袋，按 §9 做 A/B spike 用数据决定。

### 4.5 路线 B：JSON AST 方案详解

#### 4.5.1 数据模型

```jsonc
// SpaceNode.content 的 JSON 序列化（contentFormat: "alter-doc/1"）
{
  "format": "alter-doc/1",
  "schemaVersion": 1,
  "blocks": [
    { "id": "blk_01HX", "type": "heading", "props": { "level": 1 },
      "content": [{ "type": "text", "text": "鉴权方案", "styles": { "bold": true } }],
      "children": [] },

    { "id": "blk_01HY", "type": "callout", "props": { "tone": "warn", "title": "待确认" },
      "children": [
        { "id": "blk_01HZ", "type": "paragraph",
          "content": [{ "type": "text", "text": "token 刷新策略还没定。" }] }
      ] },

    { "id": "blk_01J0", "type": "image", "props": { "assetId": "asset_…", "alt": "架构草图" } },
    { "id": "blk_01J1", "type": "mindmap", "props": { "objectId": "obj_…" } },
    { "id": "blk_01J2", "type": "component", "props": { "objectId": "obj_…" } }
  ]
}
```

- 每个 block：`id`（稳定 ULID）、`type`、`props`（类型化属性）、`content`（行内内容：text/link/mention + styles）、`children`（嵌套块）。
- **schema registry**：每种 block 定义 props 规则、行内/子块约束、渲染器、编辑器 node view、schema 迁移函数；写入前校验，非法内容不会落盘。
- **对象与资产与路线 A 完全相同**：mindmap/组件的 payload 在旁表、图片在资产库，AST 里只放 `objectId`/`assetId`。这样版本快照不会重复大 payload。
- **版本**：`DocVersion.content` 存规范化序列化后的 AST JSON；恢复版本时对象/资产按引用还原。AST JSON 通常比 Markdown 大 1.5–2 倍，**当前 64 KiB/篇版本预算需要重估**（或改为块级增量快照）。
- 文档顶层可用 `contentFormat: "alter-doc/1"` 与旧 HTML 区分，双格式共存。

#### 4.5.2 编辑器与产品能力

- 选一个成熟底座：ProseMirror / Tiptap / Lexical / BlockNote；自定义 node view 渲染 callout、mindmap、component。
- 块拖拽、嵌套、选中、粘贴、IME、撤销这些富文本编辑器里最难的部分由底座解决；后续接 Yjs 可做实时协作。
- 评论锚点可以升级为「block id + 文本偏移」，比纯 quote 更稳；块级引用/跨文档引用天然可行。
- 安全边界不变：正文不执行内容，组件渲染在受控 node view 中，代码型组件仍走沙箱 iframe。

#### 4.5.3 Agent 怎么读写（存储与接口解耦的关键）

Agent 不直接编辑 JSON 树，接口仍以 Markdown 为载体：

- **读**：AST → Markdown 投影（保留 block id，例如 `<!-- blk_01HY -->` 或 `:::callout{#blk_01HY}`），同时返回对象索引。
- **写**（推荐组合）：
  - a. **结构化工具**：`space_blocks_insert/update_text/delete/move`、`space_object_set`（最可靠、可校验）；
  - b. **按 block 的文本精确替换**：`space_edit { block_id, old_text, new_text }`（模型最自然的写作方式，保留块格式）；
  - c. 整段 Markdown patch → 解析映射到块：实现复杂、易歧义，只作后备。
- 富对象（mindmap/组件）一律走专用工具，不让模型直接写 payload。
- 结论：**"JSON AST 存储 = Agent 用不了 Markdown" 是误解**；差别在于写操作要经过 block 工具，而不是整篇字符串替换。

#### 4.5.4 代价与适用条件

| 代价 | 说明 | 缓解 |
| --- | --- | --- |
| 编辑器重写更大 | 块编辑器 + 自定义 node view + 投影导出 | 用 BlockNote/Tiptap 底座，先做文本/图片/callout，再补 mindmap/组件 |
| 版本体积 | AST JSON 大于 Markdown | 对象/资产外置；规范化序列化；重估 64 KiB 预算或块级快照 |
| 迁移更难 | HTML→AST 需 schema 解析 | 复用 ProseMirror DOMParser；旧版本保留 HTML；分批迁移 |
| Agent 工具面更大 | block 工具 + 对象工具 | 接口统一 Markdown 投影；工具少而正交；用 spike 验证模型成功率 |
| Markdown 导出有损 | 富块无法完全映射 | 约定降级语法（围栏块 + 占位）、导出附带对象清单 |

**何时选 B**：块是主要编辑对象（拖拽/嵌套/卡片）、要实时协作、要大量自定义块、要稳定块引用；团队接受更大的编辑器投入与版本存储成本。

### 4.6 为什么不用 MDX

MDX = Markdown + JSX + import/export，需要编译、可执行任意 JS。用在「用户/AI 随时编辑的文档」里意味着：运行时编译、依赖解析、沙箱与供应链安全、版本锁定等一整套问题。**需要交互组件时，用受控指令/受控组件节点 + 沙箱组件对象即可**，不必把整篇文档变成代码。

---

## 5. 对现有系统的影响与迁移路径

| 现有资产 | 影响 | 迁移建议 |
| --- | --- | --- |
| 文档正文（HTML） | 存储格式变化 | 路线 A：复用 `vendor/ui-space/src/utils/markdown.ts` 的 `htmlToMarkdown`；`<img dataURL>` → 资产 + `space-asset://`；`<mark>` → `==…==`；表格 → GFM。路线 B：用 schema 的 DOM parser（如 ProseMirror `DOMParser`）或一次性转换脚本产出 AST；两条路线都要补 callout/图片/表格映射 |
| 编辑器（contentEditable HTML） | 需要替换/扩展 | 路线 A：Markdown AST 编辑器（Milkdown/Tiptap+Markdown）；路线 B：block 编辑器（BlockNote/Tiptap/Lexical/ProseMirror）+ 自定义 node view；这是本方案最大成本项 |
| 评论（quote 锚点） | 不受影响（按纯文本 quote 定位） | 两条路线都可先按 quote 匹配；路线 B 可额外给 block id 做精确锚点 |
| 版本历史 | 旧版本是 HTML | 双格式共存：旧版本按 HTML 渲染，新版本按 `contentFormat` 区分；路线 B 的 AST JSON 体积更大，需要重估版本预算 |
| Agent 读写工具 | 设计需改 | 无论 A/B，都改为「读 Markdown 投影 + 对象专用工具」；A 用整段/片段精确替换，B 用 block 级工具（详见 §8） |
| 每日快照 / 备份 | 新增资产目录 | 见 §6 |

---

## 6. 存储位置：数据库还是工作区文件？

| 方案 | 优点 | 代价 | 建议 |
| --- | --- | --- | --- |
| **A. SQLite 权威（推荐）** | 沿用现有 ACID、单写者队列、版本、评论、搜索；浏览器走 RPC；备份链路不变 | 外部工具不能直接编辑；需要导出 | 首期采用；正文（Markdown 或 AST JSON，取决于路线）存 `content`，对象旁表，资产文件 |
| B. 工作区 `.md` 文件权威 | git/Obsidian/VSCode 可直接编辑；Agent 可用现成文件工具；天然导出 | 无事务、多文件一致性、外部编辑冲突、版本/评论/搜索要重建，权限/沙箱复杂 | 暂不采用 |
| C. DB 权威 + 单向 `.md` 镜像 | 兼顾可移植/可备份/可外部阅读 | 镜像同步逻辑与冲突处理 | 可选增强（导出到空间主目录 `.alter/docs/`） |
| D. 文件权威 + DB 索引 | Obsidian 式 | 同 B，且把 DSH 工作区变成数据库 | 仅在「外部编辑」成为核心需求时再评估 |

注意资产：若二进制放文件系统，**每日快照必须同时覆盖 `assets/` 目录**（当前备份只 `VACUUM INTO` 数据库），否则恢复后图片丢失；建议备份流程加「资产清单 + 增量复制/打包」并在验收里覆盖。

---

## 7. 风险与取舍

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 路线 A：指令语法 round-trip 保真 | Markdown ↔ 编辑器规范化可能改变空白/标记 | 固定 canonical 序列化器 + 语料回归测试（golden corpus） |
| 路线 B：schema 演进 | block 类型/属性升级需要迁移旧文档与旧版本 | schemaVersion + 迁移函数 + fixture 回归；未知类型按占位保留 |
| 路线 B：版本体积 | AST JSON 比 Markdown 大 1.5–2 倍，快照/版本成本上升 | 对象/资产外置；规范化紧凑序列化；重估 64 KiB 预算或改块级增量 |
| 路线 B：Markdown 投影有损 | 富块无法无损导出/回灌 | 投影只用于「读」和导出；写一律走 block/对象工具，不做整篇回灌 |
| 编辑器改造成本 | 两条路线都要换掉 contentEditable，B 的 node view 更多 | 用成熟底座（Milkdown/BlockNote/Tiptap）；先做文字/图片/callout，再补 mindmap/组件 |
| 对象生命周期 | 不可变对象 + 版本引用会积累 | 按「被版本引用 + 保留期」GC；对象表加引用计数视图 |
| 组件安全 | AI 生成代码 | 默认声明式组件；代码组件仅沙箱 iframe + CSP + 能力白名单 + provenance 审核 |
| 资产备份/迁移 | 文件系统资产不在 DB | 备份/恢复/导出流程显式包含 assets；单文档导出打包资产 |
| 迁移保真 | 旧 HTML 的样式/合并单元格会丢 | 明确「迁移只保语义，不保像素」；保留旧版本可回溯；大文档人工抽查 |
| 纯文本工具兼容 | 第三方 Markdown 工具不认指令/不支持 AST | 指令降级为可见围栏代码块；路线 B 提供 Markdown 导出 |

---

## 8. 对 Agent 读写工具设计的影响（重要）

**存储格式 ≠ Agent 接口**。无论选 A 还是 B，Agent 都应面对 Markdown 投影：

- `space_read`：返回 **Markdown 正文**（可分段/按块读取，带 block id 或对象占位）+ 对象索引（`id/type/标题/是否可交互`），不返回 HTML。
- 读取的对象/资产用引用表示，不内联 base64；需要细节时用 `space_object_get` / `space_asset_read`。
- 写入分两层：
  - **文本层**：A 直接按 Markdown 精确替换；B 按 `block_id + old_text/new_text` 精确替换该块文本（模型写作体验接近 Markdown）。
  - **结构层**：插入/删除/移动块、改块属性、mindmap/组件 payload → 专用工具（按 schema 校验），两种路线都需要。
- 资产：`space_asset_upload`（或复用附件服务）返回 `asset_id`；组件生成走受控 spec，不把任意 JS 写进正文。
- 结论：**先定路线，再实现工具**；按 HTML 精确替换实现的工具在两个新路线下都作废，最多作为当前 HTML 编辑器时期的临时能力。

---

## 9. 建议的下一步：v0 规范 + 最小垂直切片（3–5 人日）

架构方向已按 §11 收敛；下一步不是继续选型，而是用一个小切片验证「AST 权威 + Markdown 投影 + Document Operations」能否支撑真实 AI 编辑任务。

1. **v0 规范已写**：[spec-document-model-v0.md](./spec-document-model-v0.md) —— Schema Registry（node 类型、content/inline/marks、capability）、Markdown 投影规则与锚点、op 集与 envelope、对象/资产模型、`baseRevision`/操作日志语义、Agent 工具契约与 spike 验收。
2. **最小垂直切片**：
   - Host：Document Service（outline/read projection/ops 校验与执行/op log）+ SQLite 旁表（`doc_objects`/`doc_assets`/`doc_ops`）；
   - Client：Tiptap 只读渲染 + 一个最小编辑入口（先不做完整编辑器）；
   - Tools：`space_outline` / `space_read` / `space_ops` / `space_generate`（新内容 Markdown）。
3. **样例与任务**：10 篇真实文档（长文、代码块、表格、图片、callout、mindmap 占位、组件占位）；每组任务跑 5–10 次：总结长文、精确改一段、插入高亮块、按指令生成新章节、改表格单元格、把一段整理成 mindmap 占位。
4. **度量**：任务成功率、工具轮次、token（读投影 + ops 回执）、渲染保真、版本体积、撤销/审计可用性。
5. **通过标准**：核心任务成功率 ≥90%、单任务平均 ≤4 次工具调用、单次读投影 ≤12k tokens、撤销/恢复可验证；不满足则先修投影/op 粒度，而不是退回整篇 Markdown 重写。

通过后再排：完整 Tiptap 编辑器、组件运行时、迁移脚本与备份/资产方案。

---

## 10. 待确认的问题（带建议默认）

1. **权威格式**：已确认采用 §11 的混合架构——**JSON AST 权威 + Markdown 投影 + Document Operations**；剩余细节待拍板项见 §11.10。
2. **对象模型是否接受「正文只放引用、payload 存旁表」**？
   - 建议：是（A/B 都适用）。版本小、diff 干净、组件可复用。
3. **交互组件默认形态**：先只做「声明式组件（内置渲染器 + JSON 参数）」，还是一开始就支持「AI 生成代码 + 沙箱」？
   - 建议：先声明式；代码组件作为 P2，安全与 provenance 单独设计。
4. **文档是否要成为工作区里的 `.md` 文件**（可通过 git/Obsidian 编辑）？
   - 建议：首期不做权威文件；先提供「导出/单向镜像」，等外部编辑成为真实需求再评估。
5. **迁移与双格式**：一次性转换还是新旧共存？
   - 建议：双格式共存（`contentFormat` 标记）+ 后台批量转换；历史版本保留原格式。
6. **版本预算**：路线 B 的 AST JSON 比 Markdown 大，当前「10 版 / 64 KiB 每篇」是否要调整？
   - 建议：对象/资产外置后重新测；把固定 64 KiB 改为「按篇的累计字节上限（可配置）」，并允许大文档只保留少量版本。

---

## 11. 对齐后的终局架构（2026-11-09 讨论结论）

> 回应「Markdown 作为 AI 读写接口 + JSON AST 作为权威存储 + Document Operations」的混合提案：**方向正确，建议作为终局架构**。以下是落地必需的补充与收紧。
>
> **实现基准**：[spec-document-model-v0.md](./spec-document-model-v0.md)（节点模型、Schema Registry、Markdown 投影语法、Operation 集、对象/资产、Agent 工具契约、存储映射与 spike 验收）。

### 11.1 分层

```
┌─────────────── AI Agent ───────────────┐
│ 读：Markdown 投影 + 块索引              │
│ 写：Document Operations + 新内容 Markdown│
└───────────────┬────────────────────────┘
                │ 工具 / API
┌───────────────▼────────────────────────┐
│ Document Service（Host）                │
│ • projection（AST → Markdown + anchors）│
│ • planning（target 解析 → diff 预览）   │
│ • validation（schema + 权限 + revision）│
│ • apply（事务、幂等、审计、undo）        │
└───────────────┬────────────────────────┘
                │
┌───────────────▼───────────┐   ┌──────────────────┐
│ JSON AST（权威存储）       │   │ Object/Asset Store│
│ blocks / inline / marks   │◄──│ 对象、组件 spec、  │
│     / node refs           │   │ 资产（内容寻址）   │
└───────────────┬───────────┘   └──────────────────┘
                │
┌───────────────▼────────────────────────┐
│ Editor（Tiptap/ProseMirror） + Renderer │
│ Component Registry（node view / 运行时）│
└────────────────────────────────────────┘
```

### 11.2 五条必须写死的原则

1. **AST 是唯一权威**；Markdown 是**投影（projection）**，不是第二份真源。
2. 投影只保「语义 + AI 可读」，**不承诺无损**；富组件以占位 + id 呈现，回写不走整篇解析。
3. 结构修改一律走 Operations；Markdown 只用于**新内容生成**（insert/replace 目标明确时解析为新节点）。
4. 所有写操作带 `baseRevision`、原子事务、可审计、可逆（inverse op）。
5. **一个 Schema Registry** 同时生成：存储 schema、Tiptap node spec、AI 工具 JSON Schema、Markdown 投影/序列化器、迁移函数、AI 能力声明——避免五套定义漂移。

### 11.3 节点能力三级（回应 Document as Content / Application）

| 层级 | 例子 | AI 能力 | 编辑 / 渲染 |
| --- | --- | --- | --- |
| **content** | paragraph / heading / list / quote / code / table | 读 Markdown、写 Markdown/ops，全文可编辑 | Tiptap 原生节点 |
| **structured** | callout、mindmap、简单图表 | 读投影/指令；写 ops + 类型化 payload | 自定义 node view |
| **application** | 数据面板、计算器、实时图表 | 读 `describe`（能力/输入/输出）；只改 props/绑定，不碰运行时内部 | 沙箱 iframe + 独立 spec/state |

每个 node type 在 registry 中声明 `ai: { readable, writable, preview, ops }`；工具按能力裁剪，AI 看不到/改不了它不该碰的部分。这一条把「Document as Application」从口号变成可执行的边界。

### 11.4 Markdown 投影契约

- 投影是 **read-only 视图**，可带锚点（HTML 注释或指令 attrs），**导出时剥离**。
- 文本块：Markdown 原生语法；行内 marks 映射到 Markdown，无法映射的（颜色/评论锚）以注释或 `capabilities` 说明呈现。
- structured 节点：小对象用指令 + 紧凑 payload（可读可改）；大对象只给 `:::component{id=… title=…}` 占位，细节用 `space_object_get`。
- application 节点：只给占位 + `describe` 摘要；改配置用 ops，不展开 payload。
- **不承诺 Markdown→AST 全量无损**：只在「目标明确的新内容 / 整块替换」时解析 Markdown；不要让 AI 整篇重写后再解析回 AST。

### 11.5 Document Operations 设计

```jsonc
{ "docId": "doc-…", "baseRevision": 12, "idempotencyKey": "…",
  "ops": [
    { "op": "update_text", "target": "blk_…", "changes": { "text": "…" } }
  ] }
```

v0 op 集：`insert_node` / `insert_markdown` / `update_text`（支持 range）/ `update_attrs` / `move_node` / `delete_node` / `replace_node` / `replace_with_markdown` / `transform_node` / `set_marks`。

服务端流程：解析 target → schema/权限/baseRevision 校验 → 计算 diff → 事务执行 → 写 op log → revision+1 → 返回 `{ revision, changedBlockIds, diff, undoToken }`。

- `plan`（dry-run）返回 diff 不落盘，供预览/审批。
- 批量**全有或全无**；失败逐 op 报错；重复 `idempotencyKey` 返回原结果。
- op log 支撑审计、撤销与未来协作；与快照版本并存（快照快恢，日志精审）。
- `transform_node` 必须显式定义允许的转换与保留字段，禁止隐式丢数据。

### 11.6 长文档的读侧协议（容易被忽略，但决定上限）

- 先 `outline(docId)`：块树 + id/type/预览/字数，按章节或预算读。
- `read(docId, blockIds|range, format='markdown')`：只投影请求范围。
- `search(docId|space, query)`：返回块 id。
- 上下文预算目标：outline ≤1–2k tokens，单次读 ≤8–12k tokens；ops 不回传整篇文档。
- 所有 target 用稳定 block id，不靠「第 3 段」这类位置描述（位置会漂移）。

### 11.7 版本、对象与审计

- 快照：AST 规范化 JSON；对象/资产外置只存引用 → 版本体积可控（但仍比 Markdown 大，需重估 64 KiB/篇预算）。
- op 日志：每次 apply 一条，含 actor（user/agent/model）、baseRevision、op 摘要、结果，用于审计与 undo。
- 撤销：inverse ops；AI 一次 turn 的 ops 归组为一个 transaction，可整体撤销。
- 对象不可变；版本引用保活；GC 按「无版本引用 + 保留期」。
- 冲突：`baseRevision` 不匹配 → 重新读取/重试；未来 CRDT 时 ops 映射为 transactions。

### 11.8 组件运行时边界

- application 节点有自己的 schema/loader/sandbox，不进文档正文、不参与 Markdown 解析。
- 文档只保存 instance：`{ componentId, specHash, props, bindings, stateRef? }`；spec 内容寻址、版本固定。
- 安全：iframe sandbox + CSP、默认无网络、capability 声明、provenance、审核状态。
- AI 只能通过 registry 的能力声明操作 props/data，不能把任意运行时代码写进正文（除非走代码组件审核通道）。

### 11.9 与本仓库的映射

- `SpaceNode.content` 从 HTML 改为 AST JSON（`contentFormat: 'alter-doc/1'`）；新增旁表 `doc_objects` / `doc_assets` / `component_specs` / `doc_ops`。
- 客户端：Tiptap 替换 contentEditable；新编辑器/渲染器放 `src/document/`（`build.mjs` 以模块覆盖替换 vendored `DocumentView`）；`SpaceService` 增加 projection / ops 方法（走 RPC）。**上游 Alter 已废弃，所有实现闭合在本仓库**（详见 spec §9.1）。
- Host：新增 Document Service（projection / validation / ops / audit）与 Schema Registry；store 仍是 SQLite 单写者事务。
- Agent 工具改为 `space_outline / space_read / space_ops / space_generate / space_object_*`；之前的 HTML 精确替换设计作废。
- 版本/备份：AST 快照 + 对象/资产 + op 日志；64 KiB 预算调整；资产目录纳入备份。

### 11.10 仍需拍板

1. 投影锚点形式：HTML 注释 / 指令 attrs / 返回侧索引（建议「返回侧索引 + 可选注释」）。
2. structured 节点（如 mindmap）用「Markdown 内联 payload」还是「只给 id + 工具」——建议按 size 阈值（如 payload ≤4 KB 内联可读，超出只给占位 + 工具）。
3. op log 是否作为版本历史主存储（建议快照 + 日志并存）。
4. 组件运行时首发范围（建议声明式优先，代码组件走审核通道）。
5. 迁移批次与旧 HTML 版本保留策略。

---

## 附录：调研参考

- Notion 的 block 数据模型（block id / properties / type / content 子块 / parent）：<https://www.notion.com/blog/data-model-behind-notion>
- BlockNote 的 block JSON 结构（id/type/props/content/children）与 Markdown 导出能力：<https://www.blocknotejs.org/docs/foundations/document-structure>
- ProseMirror Guide（文档=节点树 + schema + transaction，协作编辑的基础）：<https://prosemirror.net/docs/guide/>
- MyST Markdown 的 directive 体系（admonition/figure/iframe/mermaid 等，与「指令块」最接近的成熟先例）：<https://mystmd.org/guide/directives>
- MDX 官方定义（Markdown + JSX/ESM，可执行）：<https://mdxjs.com/docs/what-is-mdx/>
- 当前仓库的 HTML→Markdown 导出实现：`vendor/ui-space/src/utils/markdown.ts:95-102`
- 当前编辑器的内联图片 dataURL 与 quote 锚点评论：`vendor/ui-space/src/components/editor/Editor.tsx:1331-1334`、`Editor.tsx:551-557`
