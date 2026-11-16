---
type: spec
status: active
updated: 2026-11-15
---

# 空间对话 v0（页面对话 · 侧边对话 · 引用）

围绕空间与页面的对话由三部分组成：**页面对话**（从页面发起的普通 DSH 会话）、**侧边对话**（主对话的分支会话）、**引用**（会话携带的空间/页面引用）。本文是它们的数据与协议契约；UI 行为与理由见[方案](../designs/space-conversations.md)。

## 1. 数据模型

对话记录是 Space 权威库的**侧表**（schema v4），不进入 `SpaceStoreData` 集合：

- `chats(id PK, updated_at, data)`：`ChatRecord = { id, kind: 'page'|'side', sessionId: string|null, title, sideOf: { sessionId, title }|null, quote: string|null, createdAt, updatedAt }`。
- `chat_refs(id PK, chat_id, space_id, node_id NULL, data)`：引用行，`node_id IS NULL` 表示空间引用；JSON 载荷为 `{ label, addedAt, addedBy }`。
- 索引：`chat_refs(chat_id)`、`chat_refs(space_id, node_id)`（反向索引）。

语义约束：

- `sessionId` 指向一个真实 DSH 会话；DSH 拥有会话本身，Space 只保存绑定。`null` 仅在 fork 尚未落库时短暂存在。
- **引用 state 是派生值**：读取时按当前空间/页面状态解析（`current` / `archived` / `missing`），永不落库。label 优先取当前标题（页面存在时），否则保留登记时的 label。
- 引用身份以 `(spaceId, nodeId)` 为准：`setChatRefs` 替换集合时保留未变引用的 id/addedAt/addedBy；`addChatRef` 对重复目标幂等。
- 归属：引用行 `addedBy` 由写入身份派生；浏览器 RPC 只暴露 user 栈。
- 删除：`deleteChat` 只移除对话记录与引用行，**不触碰 DSH 会话**；空间删除的级联清理不含对话记录（引用 state 随之变 `missing`）。

## 2. RPC 端点（chat.*）

浏览器通道 `/api` + `alter-space`，信封与既有约定一致。全部端点在能力台账中**对 Agent 排除**（对话记录属于 DSH 会话域，Agent 通过既有空间工具读取引用对象本身）：

| 端点 | 类 | 语义 |
| --- | --- | --- |
| `chat.listChats(filter?)` | read | 全部对话，`updatedAt` 倒序，refs 已解析 |
| `chat.getChat(id)` | read | 单条；不存在返回 null |
| `chat.createChat(input)` | write | 创建 page/side 对话，可带初始 refs |
| `chat.updateChat(id, patch)` | write | 更新 title / sessionId，前移 updatedAt |
| `chat.deleteChat(id)` | write | 删除记录 + 引用行 |
| `chat.setChatRefs(id, refs)` | write | 整组替换引用（保身份） |
| `chat.addChatRef(id, ref)` | write | 追加引用；重复目标幂等返回原记录 |
| `chat.listChatsForRef({ spaceId, nodeId? })` | read | 反向索引：引用该空间/页面的对话 |

`space.getWorkspaceLink(spaceId)`（read，对 Agent 排除）：读取 Space ↔ DSH 工作区绑定的 `workspaceId`，供页面对话把会话开进空间的映射工作区。绑定本体仍在 `workspace_links` 侧表，不进 Space 实体。

## 3. 两类对话

**页面对话（page）**：普通 DSH 会话，入口在 DSH 左侧会话列表。创建方（浏览器）负责：解析空间映射工作区 → `sessions.create({ workspaceId })` → 登记对话与页面引用。会话不入回收站语义；删除对话记录不影响会话。

**侧边对话（side）**：`sessions.fork({ sessionId })`（不带 `atSeq`，Host 取最近已完成轮次前缀）创建的分支会话；对话记录携带 `sideOf`（来源主对话）与可选 `quote`（划选文本）。创建后由右栏标签页打开；历史视图 tab 只列 `kind:'side'`。

## 4. 引用与 Agent 信息边界

- 引用是**明确的用户动作**：自动引用（右栏新建对话）、粘贴转换、菜单动作；没有引用就没有上下文授权。
- 被引用对象的信息访问走**既有空间工具**（`space_browse` / `space_doc_*` / `space_comments` 等）：数据模型里有什么，Agent 就能读什么；引用不新增工具、不枚举字段。
- 引用失效（`missing`）时 UI 置灰：输入框 chip 直接读引用 state；消息卡片没有会话身份，经装配层注入的只读解析器从 chat 记录取同一 `(spaceId, nodeId)` 的 state。`missing` 置灰加删除线且不跳转，`archived` 置灰但仍可打开。Agent 读取失败时按各工具既有错误语义返回。
- 引用面（UserText 规则 + 卡片渲染件）与输入框面（dock id `alter-space-refs` + `@space-ref` 触发源）各自单一归属：DSH 对重复的 slot 声明与重复触发源都抛错，两处都注册会让存活的那个 composer 拿不到 codec，chip 静默降级为纯文本。

## 5. DSH 集成面（客户端）

- 右栏新增三个 tab 类型：`alter-space.page`（空间页面，page 型，复用 `SpaceApp`）、`alter-space.side`（侧边对话）、`alter-space.session`（页面对话）。后两者是 **resource 型**：分别声明 `dsh-resource://spacechat/session/**` 与 `dsh-resource://spacesession/session/**`，content id 即会话地址，因此布局重载后仍还原到同一会话。三者都经 `ctx.sidebarRightTabs.register` 两段式注册，body 挂 `sidebar.right.pane.tab`。
- **空间主界面的开关是同一个控件**：页面、空间首页、概览（`SpaceDetailShell` 及其下活动/配置等插件页）都渲染共享的 `RightbarButton`，图标与提示与对话页一致；`SpaceApp` 带 `embedded` 时（右栏标签里的空间视图）不渲染它——右栏本来就是展开的，点它只会收起自己所在的列。
- **右栏是 DSH 官方右栏，经 Loader 覆盖解除「仅会话页」限制**：上游 `RightbarRoot` 只在
  `activePanelId === null` 时渲染右栏（README：No surface without a session），插件无法从外部
  改它（`rightbar` 是单占位槽位，官方占用）。`overrides/rightbar` 用官方产物的副本替换那条门：
  座席恒可见、屏上会话取「选中的会话」。因此空间面板（插件主面板）旁也有右栏，内容是该会话的
  标签：空间页面 / 对话 / 侧边对话。没有选中会话时右栏不出现，开关返回 `unavailable` 并说明原因。
  升级 DSH 后需按 `overrides/rightbar/README.md` 重新应用。
- **跨插件 seat 必须经 `ctx.slots.inject`**：右栏的 `sidebar.right.pane.tab` 是在上游插件内部 `slots.inject('rightbar') → inject('rightbar.session')` 链里才声明出来的子 slot，直接 `ctx.slots.register` 会在 apply 阶段因「未声明目标」抛错；一个抛错会让同一条 effect 里后续注册全部丢失（表现为引导页缺入口、标签落到「这类内容还没有可用的查看方式。」）。所有外来 seat（`sidebar.right.pane.tab.*`、`conversation.*`）都走 `inject(seat, () => register(...))`。装配层再用逐项隔离的 `safeRegister` 把每个入口单独装起来并打印失败标签，任一注册失败不再连坐。
- **RPC 信封**：浏览器侧经两层信封（Connection 结果 + Host 的 `{ value }`/`{ error }`），漏解内层会把信封对象当载荷——列表端点因此返回对象而非数组，`.map`/`.filter` 直接抛错。`src/client/rpc.ts` 与 `src/chat/client.ts` 都必须解到载荷。
- 会话创建只走工作区流程（`uiWorkspace.connectWorkspace`）：`ctx.sessions` 契约**没有** `create`，直接调用会在运行时抛错。
- 右栏「新建对话」创建普通会话并以 `alter-space.session` 在右栏打开：引用取空间主界面当前内容（在页面上引用页面，否则引用当前空间）；空间面板不在主区时回退到默认空间。页面菜单「AI 对话」仍在主视图打开。
- 「在右侧打开」类动作一律**只展开不收起**（`expandOnly`）：打开一个标签不是切换开关，二次 toggle 会把读者刚展开的列关掉。
- 划选动作经 `ctx.uiConversation.interactions`（id `alter-space-sidechat`）+ keyed surface `conversation.chat.text-interaction`；面板并列「引用文本」与「在侧边对话中引用」。另注册 `conversation.chat.assistant-actions` 条目「在侧边对话中引用」，以整条回复为引用创建分支（划选面板可能被其他插件优先占用，这是稳定入口）。
- 输入框引用：`conversation.input.dock` 上一条引用条（`space-ref`），列出该会话已登记的引用并可删除，空态提示、20 条上限提示；空态「选择空间」与卡片条末尾「＋」打开行内选择面板（装配注入 `pickTargets`：空间列表 + 默认空间最近页面），选中后在光标处插 chip 并登记——只登记不插 chip 不行，Agent 是从消息正文的链接得知引用范围的。空间/页面链接在草稿中出现时经会话作用域事件 `slash/input-insert-reference` 转成 chip（`space-ref` 触发源提供 codec）；codec 不可用时降级为可读文本 `[页面] 名称`。转换前经装配注入的 `resolveTarget`（`getNode`/`getSpace`）校验目标：确认不存在或不可见则保留原文并内联提示；查询失败按不确定处理照常转换。
- 发送消息中的空间链接经 `uiConversation.userText` 规则（id `space-ref`）渲染为引用卡片；卡片悬停经装配注入的预览解析器（`getNode`/`getSpace`）显示标题、所属空间与最近活动时间，`position: fixed` 定位以避开 transcript 的 `overflow-y: clip`。
- 「侧边对话历史」是 `conversation.view` 注册项（id `space-side-history`），仅在存在侧边对话时保持注册（数量为 0 即注销，tab 消失）；行内含来源标题（`sideOf.title` 来自主会话 `displayTitle`）与运行状态三态：`running` → 生成中（呼吸点）；否则若该分支处于「已完成未读」→ 已完成（实心点）；其余 → 空闲。
- 「已完成未读」由 `ctx.uiSession.sessionStatus` 的 `completionUnread` 派生（DSH 在生成结束且主视图未持有该会话时置位），确认权归插件：分支标签页可见时自动确认，历史行「打开」先确认。DSH 的标记只会被主视图清除，而分支始终在右栏标签里，所以本地确认层是必要的，不是重复状态。

## 6. 客户端已知边界（按本 spec 验收时不视为缺陷）

- 侧边对话是 DSH 会话，**会出现在左侧会话列表**（fork 语义）；「入口不出现在左侧栏」需要 DSH 提供会话隐藏位后收敛。左侧列表的可见性由 `ui-workspace` 的 `sessionVisible` 判定，唯一的隐藏位是 `origin === 'subagent'`，而该 origin 的会话按「父会话 + 子地址」寻址、且会把用户分支误标为子智能体，因此不采用。删除侧边记录时会归档其分支会话。
- AI 回复中的链接保持 DSH Markdown 链接渲染；「回复内联引用卡片」依赖 markdown 扩展位，列为后续项。
- 「已归档」在客户端不可观测：归档集合是 `ui-workspace` 的浏览器内 store（`archivedSessionIds`），`uiWorkspace` 服务不暴露它；「相关会话」只能按会话列表缺席标注「已删除」，归档会话按普通会话打开、由 DSH 的归档门拒绝模型步骤。
- 右栏标签条上的标签标题由框架按注册时的地址渲染（`title(address)`），插件无法把运行状态（生成中/已完成）画进标签；状态只在「侧边对话历史」行与分支标签页内可见。
- 右栏引导区由 DSH 按 tab 类型渲染 `{icon, title, description}` 卡片，不能挂自定义内容；「当前空间最近页面」的快捷入口因此由「空间页面」入口进入后的目录/搜索承担。
- 划选浮动面板由 DSH 按注册顺序独占：其他插件先注册时用户只看到「引用文本」，此时用消息动作区的「在侧边对话中引用」（整条）创建分支。
- 同一个会话不允许两个可编辑根：页面对话要么在主视图、要么在右栏标签，不同时打开。
