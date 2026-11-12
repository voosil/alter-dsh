---
type: spec
status: active
updated: 2026-11-12
---

# 空间评论 v0

本篇规范约束 Space 文档评论的生命周期：状态模型、删除语义（软删除墓碑）、正文写入触发的级联删除、
客户端可见面与旧数据兼容。评论锚点的文本展平约定见 [document-model-v0.md](document-model-v0.md) §4，
正文写入通道见 [document-operations-v0.md](document-operations-v0.md)。

## 1. 实体与状态

```ts
interface Comment {
  id: string;
  docId: string;
  author: Creator;                    // 写入身份派生，写后不可变
  body: string;
  quote: string | null;               // 被评论文字；null = 全文评论
  anchor: CommentAnchor | null;
  status: 'open' | 'resolved' | 'deleted';
  createdAt: string;
  resolvedAt: string | null;
  deletedAt: string | null;           // 仅 deleted 非空
  editedAt: string | null;
  supplements: CommentSupplement[];
}
```

状态迁移只有三条：`open → resolved`（采纳）、`open|resolved → deleted`（删除），其余保持不变；
`deleted` 是终态。

## 2. 删除即墓碑

- 删除不移除记录：`body`/`quote`/`anchor`/`supplements` 原样保留，只写 `status='deleted'` 与
  `deletedAt`；`listComments(docId)` 返回该文档全部状态（含墓碑）。
- 重复删除幂等：保留首个 `deletedAt`；目标不存在仍报 `评论不存在`。
- 对墓碑的编辑、补充、采纳是幂等 no-op：原样返回墓碑，不写 `editedAt`/`resolvedAt`、不追加补充。
  客户端 quote 回写（450ms 防抖）可能晚于正文保存（700ms）触发的级联，竞态不转化为错误。
- 客户端不持久化空 quote：空串表示「被评论文字已被删掉」，Host 忽略该次 quote 更新；删除语义只由
  正文写入的级联决定，否则会先清掉级联的唯一判据。

## 3. 正文级联删除

- 判据与具体 Operation 无关：一次正文写入提交后，`open` 且 `quote` 非空的评论，若 `quote` 在新正文的
  扁平文本中不再出现，即置为 `deleted`（`deletedAt` 取该次写入时间）。
- 扁平文本与锚点同一约定：顶层块按文档顺序、inline text 原样、hardBreak 与块边界记为换行；比较前
  折叠空白，再做子串包含。
- 「文本仍在但不再唯一匹配」只是锚点歧义，不算删除；`resolved` 与 `quote === null` 的全文评论不参与。
- 级联与正文写入在**同一事务**内完成，只在正文序列化结果真的变化时触发，`dryRun` 不触发；覆盖
  `applyOps` / `generate` / `undo` / `restoreVersion` 全部正文写入路径。
- 撤销不复活：`undo` 只回滚正文 Operation，已级联删除的评论保持「已删除」。

## 4. 客户端可见面

- 评论轨与正文高亮只渲染 `open`；`deleted` 不绘制下划线、不进轨。
- 底部「全文评论」只列 `open` 且 `quote === null` 的评论。
- 「历史评论」合并展示 `resolved`（标注「采纳」）与 `deleted`（标注「已删除」），按各自发生时间
  （`resolvedAt` / `deletedAt`）倒序；沿用既有评论卡样式，不新增视觉语言。
- 正文保存成功后重新读取评论列表：级联结果只有 Host 知道，客户端不能从刚提交的正文推导。

## 5. 持久化与兼容

- 评论行是纯 JSON 实体行，新字段随行读写，无需数据库 schema 升级。
- 旧行缺失 `deletedAt` 视同 `null`；未知 `status` 收敛为 `open`。
- 墓碑随文档一起清理（删除空间、清空回收站按 `docId` 连带删除），不提供单独的永久删除接口。

## 相关文档

- [document-model-v0.md](document-model-v0.md) — 评论锚点的文本约定与 AST 节点
- [document-operations-v0.md](document-operations-v0.md) — 正文写入契约（级联在同一事务内）
- [编辑器还原验收](../acceptance/editor-experience-p0-p6.md) — D9 评论删除与历史
- [文档知识库](../README.md) — 分类、预算与写作规则