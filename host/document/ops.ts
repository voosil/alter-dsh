/**
 * Pure Document Operations engine for the Alter document model v0.
 *
 * `applyOperations` applies one batch of {@link Operation}s to a deep copy of
 * the canonical block tree, validates every step against the schema registry,
 * and returns the new document together with a diff and the inverse batch that
 * undoes the whole transaction. It never mutates its inputs and never returns
 * a partial result: the first failing operation throws a {@link DocumentError}
 * with a stable machine code.
 *
 * Semantics worth calling out (spec §5 and the v0 implementation contract):
 * - Targets are block ids only; `parent`/`after`/`index` resolve inside the
 *   current tree, so nested blocks are addressable without a path syntax.
 * - Node ids are server-assigned: missing, blank or colliding candidate ids on
 *   inserted/replaced blocks are re-issued through `ctx.createBlockId`; ids of
 *   the subtree a `replace_block` replaces are freed first, so snapshot-based
 *   replacements (and their inverses) keep descendant ids stable.
 * - `replace_block` keeps the target type (use `transform_block` to change it)
 *   and keeps the target block id, so anchors survive content replacement.
 * - `inverseOps` is ordered to be applied as one batch; it restores the tree
 *   structurally and content-wise (revision is intentionally left untouched,
 *   the service increments it).
 * - Inverse/restore replays run in `trusted` mode: they skip the AI capability
 *   gates (`ai.writable` / `ai.ops`) that protect caller batches — an inverse
 *   may legitimately write back into a non-writable container such as
 *   `tableRow` — while schema, size, existence and id-uniqueness validation
 *   still applies.
 * - A transform's inverse cannot be a plain `replace_block` (the block type
 *   changed), so the engine emits: transform back to the original type, then
 *   `replace_block` with the original block to restore content/attrs exactly.
 *   When the registry has no reverse transform edge, it falls back to
 *   `delete_block` + `insert_blocks` at the recorded position.
 *
 * @module @alter-dsh/space/document/ops
 */
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  DocumentError,
  MAX_BLOCK_COUNT,
  MAX_BLOCK_DEPTH,
  isPlainObject,
  type AlterDoc,
  type BlockNode,
  type DocumentErrorCode,
  type InlineNode,
  type JsonValue,
  type Mark,
  type Operation,
  type OperationContext,
  type OperationIssue,
  type OpsResult,
  type TextEdit,
} from './types.js';
import {
  canTransform,
  normalizeAttrs,
  operationAllowedOn,
  plainTextOfInline,
  requireNodeType,
  validateAlterDoc,
  validateObjectPayload,
  validateOperationsShape,
  validateTextEdits,
  type ContentModel,
  type NodeTypeDefinition,
} from './schema.js';

/** One operation's contribution to the batch result. */
interface OpEffect {
  changedBlockIds: string[];
  inverseOps: Operation[];
}

/** One resolved block location inside the current tree. */
interface NodeLocation {
  block: BlockNode;
  parent: BlockNode | null;
  parentId: string | null;
  /** Array that contains the block (`doc.blocks` or `parent.children`). */
  siblings: BlockNode[];
  index: number;
  /** 1-based depth; top-level blocks are depth 1. */
  depth: number;
}

/** Resolved destination container for insert/move. */
interface InsertAnchor {
  siblings: BlockNode[];
  parent: BlockNode | null;
  parentId: string | null;
  /** 0 for the document root. */
  parentDepth: number;
  definition: NodeTypeDefinition | null;
}

type NodeIndex = Map<string, NodeLocation>;

/** Throw one document-model error with a stable code. */
function fail(code: DocumentErrorCode, message: string): never {
  throw new DocumentError(code, message);
}

/** Deep-copy a JSON value (documents are JSON by definition). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function buildNodeIndex(doc: AlterDoc): NodeIndex {
  const index: NodeIndex = new Map();
  indexSiblings(index, doc.blocks, null, null, 1);
  return index;
}

function indexSiblings(
  index: NodeIndex,
  siblings: BlockNode[],
  parent: BlockNode | null,
  parentId: string | null,
  depth: number,
): void {
  for (let position = 0; position < siblings.length; position += 1) {
    const block = siblings[position]!;
    index.set(block.id, {
      block,
      parent,
      parentId,
      siblings,
      index: position,
      depth,
    });
    if (Array.isArray(block.children))
      indexSiblings(index, block.children, block, block.id, depth + 1);
  }
}

function collectBlockIds(blocks: readonly BlockNode[], into: Set<string>): void {
  const stack = [...blocks];
  while (stack.length > 0) {
    const block = stack.pop()!;
    into.add(block.id);
    if (block.children !== undefined) stack.push(...block.children);
  }
}

function countBlockTree(block: BlockNode): number {
  let count = 1;
  if (block.children !== undefined)
    for (const child of block.children) count += countBlockTree(child);
  return count;
}

function countBlocks(blocks: readonly BlockNode[]): number {
  let count = 0;
  for (const block of blocks) count += countBlockTree(block);
  return count;
}

/** Maximum relative depth of a subtree; a leaf has depth 1. */
function subtreeDepth(block: BlockNode): number {
  let depth = 1;
  if (block.children !== undefined)
    for (const child of block.children)
      depth = Math.max(depth, 1 + subtreeDepth(child));
  return depth;
}

function collectSubtreeIds(block: BlockNode): string[] {
  const ids = [block.id];
  if (block.children !== undefined)
    for (const child of block.children) ids.push(...collectSubtreeIds(child));
  return ids;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Validate one detached block array by wrapping it in a throwaway document. */
function validateBlockSubtree(blocks: BlockNode[]): void {
  validateAlterDoc({
    format: ALTER_DOC_FORMAT,
    schemaVersion: ALTER_DOC_SCHEMA_VERSION,
    revision: 0,
    blocks,
  });
}

/**
 * Reject a document whose new block count would exceed the tree budget.
 * `extra` is the number of blocks added by the operation.
 */
function assertBlockCount(existing: readonly BlockNode[], extra: number): void {
  if (countBlocks(existing) + extra > MAX_BLOCK_COUNT)
    fail('doc/schema-invalid', `文档 block 数量超过上限 ${MAX_BLOCK_COUNT}`);
}

/** Reject inserts/moves that would push the subtree deeper than the limit. */
function assertInsertDepth(
  parentDepth: number,
  blocks: readonly BlockNode[],
): void {
  for (const block of blocks) {
    if (parentDepth + subtreeDepth(block) > MAX_BLOCK_DEPTH)
      fail(
        'node/schema-invalid',
        `插入后 block 嵌套深度超过上限 ${MAX_BLOCK_DEPTH}`,
      );
  }
}

/** Enforce a container's declared `allowedChildren` whitelist. */
function assertAllowedChildren(
  parentDefinition: NodeTypeDefinition | null,
  blocks: readonly BlockNode[],
): void {
  const allowed = parentDefinition?.allowedChildren;
  if (allowed === undefined) return;
  for (const block of blocks) {
    if (!allowed.includes(block.type))
      fail(
        'node/schema-invalid',
        `${parentDefinition!.type} 不允许子节点 ${block.type}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Incoming block preparation (clone → canonical shape → id assignment)
// ---------------------------------------------------------------------------

/**
 * Clone one caller-supplied block and check its structural envelope. This does
 * not fill attribute defaults: replaced/undone blocks must round-trip exactly.
 * The full payload is validated against the registry afterwards.
 */
function canonicalizeIncomingBlock(raw: unknown): BlockNode {
  if (!isPlainObject(raw)) fail('node/schema-invalid', 'block 必须是对象');
  const block = cloneJson(raw) as unknown as BlockNode;
  if (typeof block.type !== 'string' || block.type === '')
    fail('node/schema-invalid', 'block 缺少 type');
  requireNodeType(block.type);
  if (block.attrs === undefined) block.attrs = {};
  else if (!isPlainObject(block.attrs))
    fail('node/schema-invalid', `节点 ${block.type} 的 attrs 必须是对象`);
  if (block.children !== undefined) {
    if (!Array.isArray(block.children))
      fail('node/schema-invalid', `节点 ${block.type} 的 children 必须是数组`);
    block.children = block.children.map((child) =>
      canonicalizeIncomingBlock(child),
    );
  }
  return block;
}

function freshBlockId(usedIds: Set<string>, ctx: OperationContext): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = ctx.createBlockId();
    if (typeof id === 'string' && id.trim() !== '' && !usedIds.has(id))
      return id;
  }
  return fail('op/invalid', 'createBlockId 无法生成唯一的 block id');
}

/** Assign missing or colliding ids depth-first, in document order. */
function assignBlockIds(
  block: BlockNode,
  usedIds: Set<string>,
  ctx: OperationContext,
): void {
  const candidate: unknown = block.id;
  if (
    typeof candidate !== 'string' ||
    candidate.trim() === '' ||
    usedIds.has(candidate)
  )
    block.id = freshBlockId(usedIds, ctx);
  usedIds.add(block.id);
  if (block.children !== undefined)
    for (const child of block.children) assignBlockIds(child, usedIds, ctx);
}

function prepareIncomingBlocks(
  rawBlocks: unknown,
  usedIds: Set<string>,
  ctx: OperationContext,
): BlockNode[] {
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0)
    fail('op/invalid', 'blocks 必须是非空数组');
  const blocks = rawBlocks.map((raw) => canonicalizeIncomingBlock(raw));
  for (const block of blocks) assignBlockIds(block, usedIds, ctx);
  return blocks;
}

/**
 * Prepare the single block of a `replace_block`: forced to the target id (the
 * slot keeps its identity), with fresh ids for its descendants when needed.
 */
function prepareReplacementBlock(
  raw: unknown,
  targetId: string,
  usedIds: Set<string>,
  ctx: OperationContext,
): BlockNode {
  const block = canonicalizeIncomingBlock(raw);
  block.id = targetId;
  if (block.children !== undefined)
    for (const child of block.children) assignBlockIds(child, usedIds, ctx);
  return block;
}

/** Run the injected markdown parser and require a block array result. */
function parseMarkdownBlocks(
  ctx: OperationContext,
  markdown: unknown,
  context: string,
): BlockNode[] {
  if (typeof markdown !== 'string' || markdown.trim() === '')
    fail('op/invalid', `${context} 需要非空 markdown`);
  const parsed = ctx.parseMarkdown(markdown, {
    createBlockId: () => ctx.createBlockId(),
  });
  if (!Array.isArray(parsed))
    fail('op/invalid', 'parseMarkdown 必须返回 block 数组');
  return parsed;
}

// ---------------------------------------------------------------------------
// Container/anchor resolution
// ---------------------------------------------------------------------------

function resolveAnchor(
  doc: AlterDoc,
  index: NodeIndex,
  parentId: string | null | undefined,
  trusted: boolean,
): InsertAnchor {
  if (parentId === undefined || parentId === null)
    return {
      siblings: doc.blocks,
      parent: null,
      parentId: null,
      parentDepth: 0,
      definition: null,
    };
  const location = index.get(parentId);
  if (location === undefined) fail('node/not-found', `父节点不存在：${parentId}`);
  const definition = requireNodeType(location.block.type);
  if (definition.contentModel !== 'blocks')
    fail(
      'node/schema-invalid',
      `父节点 ${parentId}（${location.block.type}）不是块容器，不能承载子块`,
    );
  // AI capability gate: normal caller batches may not write into containers
  // the registry marks non-writable (e.g. tableRow). System-generated inverse
  // and restore replays pass `trusted` and keep only the schema checks above.
  if (!trusted && !definition.ai.writable)
    fail('node/not-writable', `节点类型 ${location.block.type} 不允许写入子块`);
  if (location.block.children === undefined) location.block.children = [];
  return {
    siblings: location.block.children,
    parent: location.block,
    parentId,
    parentDepth: location.depth,
    definition,
  };
}

/**
 * Resolve the insertion offset inside one anchor from `after` / `index`
 * (mutually exclusive, both optional). Defaults to appending at the end.
 */
function resolveInsertIndex(
  anchor: InsertAnchor,
  index: NodeIndex,
  afterId: string | undefined,
  explicitIndex: number | undefined,
): number {
  if (afterId !== undefined && explicitIndex !== undefined)
    fail('op/invalid', 'after 与 index 不能同时提供');
  if (afterId !== undefined) {
    const after = index.get(afterId);
    if (after === undefined)
      fail('node/not-found', `after 锚点不存在：${afterId}`);
    if (after.siblings !== anchor.siblings)
      fail('op/invalid', 'after 必须是目标父级下的兄弟节点');
    return after.index + 1;
  }
  if (explicitIndex !== undefined) {
    if (typeof explicitIndex !== 'number' || !Number.isInteger(explicitIndex))
      fail('op/invalid', 'index 必须是整数');
    if (explicitIndex < 0 || explicitIndex > anchor.siblings.length)
      fail('op/invalid', `index 超出范围：${explicitIndex}`);
    return explicitIndex;
  }
  return anchor.siblings.length;
}

// ---------------------------------------------------------------------------
// Inline content editing (update_text)
// ---------------------------------------------------------------------------

function inlineLength(node: InlineNode): number {
  return node.type === 'text' ? node.text.length : 1;
}

function cloneInlineNode(node: InlineNode): InlineNode {
  if (node.type === 'text')
    return node.marks === undefined
      ? { type: 'text', text: node.text }
      : { type: 'text', text: node.text, marks: cloneJson(node.marks) };
  return { type: 'hardBreak' };
}

function textInlineNode(text: string, marks?: Mark[]): InlineNode {
  if (marks === undefined || marks.length === 0)
    return { type: 'text', text };
  return { type: 'text', text, marks: cloneJson(marks) };
}

/** Stable identity of a mark set, independent of declaration order. */
function marksKey(marks?: Mark[]): string {
  if (marks === undefined || marks.length === 0) return '';
  return marks
    .map((mark) => `${mark.type}:${mark.attrs?.href ?? ''}`)
    .sort()
    .join('|');
}

/** Split inline content at one plain-text offset. */
function splitInlineAt(
  content: InlineNode[],
  offset: number,
): [InlineNode[], InlineNode[]] {
  const left: InlineNode[] = [];
  const right: InlineNode[] = [];
  let cursor = 0;
  for (const node of content) {
    const length = inlineLength(node);
    if (cursor + length <= offset) {
      left.push(cloneInlineNode(node));
    } else if (cursor >= offset) {
      right.push(cloneInlineNode(node));
    } else if (node.type === 'text') {
      const splitAt = offset - cursor;
      const prefix = node.text.slice(0, splitAt);
      const suffix = node.text.slice(splitAt);
      if (prefix !== '') left.push(textInlineNode(prefix, node.marks));
      if (suffix !== '') right.push(textInlineNode(suffix, node.marks));
    }
    cursor += length;
  }
  return [left, right];
}

/**
 * Marks inherited by replacement text: the marks of the character at `offset`,
 * falling back to the previous text character (and to no marks for an empty
 * block).
 */
function marksAtOffset(
  content: InlineNode[],
  offset: number,
): Mark[] | undefined {
  let cursor = 0;
  let previousMarks: Mark[] | undefined;
  for (const node of content) {
    const length = inlineLength(node);
    if (offset >= cursor && offset < cursor + length) {
      if (node.type === 'text')
        return node.marks === undefined ? undefined : cloneJson(node.marks);
      return previousMarks === undefined
        ? undefined
        : cloneJson(previousMarks);
    }
    if (node.type === 'text' && node.text !== '') previousMarks = node.marks;
    cursor += length;
  }
  return previousMarks === undefined ? undefined : cloneJson(previousMarks);
}

/** Build inline nodes for replacement text; embedded newlines become breaks. */
function inlineNodesFromText(text: string, marks?: Mark[]): InlineNode[] {
  if (text === '') return [];
  const nodes: InlineNode[] = [];
  const parts = text.split('\n');
  for (let part = 0; part < parts.length; part += 1) {
    if (part > 0) nodes.push({ type: 'hardBreak' });
    const value = parts[part]!;
    if (value !== '') nodes.push(textInlineNode(value, marks));
  }
  return nodes;
}

/** Canonicalize inline content: drop empty runs, merge equal-adjacent runs. */
function mergeInline(content: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const node of content) {
    if (node.type === 'hardBreak') {
      merged.push({ type: 'hardBreak' });
      continue;
    }
    if (node.text === '') continue;
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      last.type === 'text' &&
      marksKey(last.marks) === marksKey(node.marks)
    ) {
      last.text += node.text;
    } else {
      merged.push(textInlineNode(node.text, node.marks));
    }
  }
  return merged;
}

/** Non-overlapping occurrences of `needle` in `text`. */
function findOccurrences(text: string, needle: string): number[] {
  const occurrences: number[] = [];
  let from = 0;
  while (from <= text.length - needle.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    occurrences.push(at);
    from = at + needle.length;
  }
  return occurrences;
}

/** Apply one exact text edit to inline content, preserving surrounding marks. */
function applyTextEdit(content: InlineNode[], edit: TextEdit): InlineNode[] {
  const text = plainTextOfInline(content);
  const occurrences = findOccurrences(text, edit.oldText);
  if (occurrences.length === 0)
    fail('op/invalid', `update_text 未命中：找不到 ${JSON.stringify(edit.oldText)}`);
  if (edit.replaceAll !== true && occurrences.length > 1)
    fail(
      'op/invalid',
      `update_text 存在歧义：${JSON.stringify(edit.oldText)} 出现 ${occurrences.length} 次（可设置 replaceAll）`,
    );
  let result = content;
  for (
    let occurrence = occurrences.length - 1;
    occurrence >= 0;
    occurrence -= 1
  ) {
    const start = occurrences[occurrence]!;
    const end = start + edit.oldText.length;
    const inheritedMarks = marksAtOffset(result, start);
    const [left, rest] = splitInlineAt(result, start);
    const [, right] = splitInlineAt(rest, end - start);
    result = mergeInline([
      ...left,
      ...inlineNodesFromText(edit.newText, inheritedMarks),
      ...right,
    ]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

type InsertOperation = Extract<Operation, { op: 'insert_blocks' }>;
type InsertMarkdownOperation = Extract<Operation, { op: 'insert_markdown' }>;
type ReplaceOperation = Extract<Operation, { op: 'replace_block' }>;
type UpdateTextOperation = Extract<Operation, { op: 'update_text' }>;
type UpdateAttrsOperation = Extract<Operation, { op: 'update_attrs' }>;
type MoveOperation = Extract<Operation, { op: 'move_block' }>;
type DeleteOperation = Extract<Operation, { op: 'delete_block' }>;
type TransformOperation = Extract<Operation, { op: 'transform_block' }>;
type UpdateObjectOperation = Extract<Operation, { op: 'update_object' }>;

/** Shape shared by `insert_blocks` and its `insert_markdown` alias. */
interface InsertRequest {
  parent?: string | null;
  after?: string;
  index?: number;
  blocks?: BlockNode[];
  markdown?: string;
}

function applyInsertOperation(
  doc: AlterDoc,
  request: InsertRequest,
  index: NodeIndex,
  ctx: OperationContext,
  usedIds: Set<string>,
  trusted: boolean,
): OpEffect {
  const hasBlocks = request.blocks !== undefined;
  const hasMarkdown = request.markdown !== undefined;
  if (hasBlocks === hasMarkdown)
    fail('op/invalid', 'insert 需要且只能提供 blocks 或 markdown 之一');
  const anchor = resolveAnchor(doc, index, request.parent, trusted);
  const at = resolveInsertIndex(anchor, index, request.after, request.index);
  const raw = hasMarkdown
    ? parseMarkdownBlocks(ctx, request.markdown, 'insert_markdown')
    : request.blocks;
  const blocks = prepareIncomingBlocks(raw, usedIds, ctx);
  assertInsertDepth(anchor.parentDepth, blocks);
  assertAllowedChildren(anchor.definition, blocks);
  validateBlockSubtree(blocks);
  assertBlockCount(
    doc.blocks,
    blocks.reduce((total, block) => total + countBlockTree(block), 0),
  );
  anchor.siblings.splice(at, 0, ...blocks);
  const insertedIds = blocks.flatMap((block) => collectSubtreeIds(block));
  const changedBlockIds = [
    ...insertedIds,
    ...(anchor.parentId === null ? [] : [anchor.parentId]),
  ];
  return {
    changedBlockIds: dedupeIds(changedBlockIds),
    inverseOps: blocks.map((block) => ({
      op: 'delete_block' as const,
      target: block.id,
    })),
  };
}

function applyReplaceOperation(
  op: ReplaceOperation,
  index: NodeIndex,
  ctx: OperationContext,
  usedIds: Set<string>,
  trusted: boolean,
): OpEffect {
  const location = index.get(op.target);
  if (location === undefined)
    fail('node/not-found', `节点不存在：${op.target}`);
  const target = location.block;
  if (!trusted && !operationAllowedOn(target.type, 'replace_block'))
    fail('node/not-writable', `节点类型 ${target.type} 不允许 replace_block`);
  const hasBlocks = op.blocks !== undefined;
  const hasMarkdown = op.markdown !== undefined;
  if (hasBlocks === hasMarkdown)
    fail('op/invalid', 'replace_block 需要且只能提供 blocks 或 markdown 之一');
  let raw: unknown;
  if (hasMarkdown) {
    const parsed = parseMarkdownBlocks(ctx, op.markdown, 'replace_block');
    if (parsed.length !== 1)
      fail(
        'op/invalid',
        `replace_block 的 markdown 必须解析为恰好 1 个块，实际 ${parsed.length} 个`,
      );
    raw = parsed[0];
  } else {
    const blocks = op.blocks;
    if (!Array.isArray(blocks) || blocks.length !== 1)
      fail('op/invalid', 'replace_block 的 blocks 必须恰好包含 1 个块');
    raw = blocks[0];
  }
  // The replaced subtree leaves the tree, so its ids are free for the
  // replacement (this is what makes `replace_block` inverses id-stable). The
  // target slot keeps its own id and stays reserved.
  for (const id of collectSubtreeIds(target)) usedIds.delete(id);
  usedIds.add(target.id);
  const replacement = prepareReplacementBlock(raw, target.id, usedIds, ctx);
  if (replacement.type !== target.type)
    fail(
      'op/invalid',
      `replace_block 只允许同类型替换（${target.type} → ${replacement.type}）；换类型请用 transform_block`,
    );
  const parentDefinition =
    location.parent === null ? null : requireNodeType(location.parent.type);
  assertAllowedChildren(parentDefinition, [replacement]);
  if (location.depth - 1 + subtreeDepth(replacement) > MAX_BLOCK_DEPTH)
    fail(
      'node/schema-invalid',
      `替换后 block 嵌套深度超过上限 ${MAX_BLOCK_DEPTH}`,
    );
  validateBlockSubtree([replacement]);
  const original = cloneJson(target);
  location.siblings[location.index] = replacement;
  return {
    changedBlockIds: [target.id],
    inverseOps: [
      { op: 'replace_block', target: target.id, blocks: [original] },
    ],
  };
}

function applyUpdateTextOperation(
  op: UpdateTextOperation,
  index: NodeIndex,
  trusted: boolean,
): OpEffect {
  const location = index.get(op.target);
  if (location === undefined)
    fail('node/not-found', `节点不存在：${op.target}`);
  const block = location.block;
  const definition = requireNodeType(block.type);
  if (
    definition.contentModel !== 'inline' ||
    (!trusted && !operationAllowedOn(block.type, 'update_text'))
  )
    fail(
      'node/not-writable',
      `update_text 只支持 textblock（${block.type} 不支持，改用 replace_block）`,
    );
  validateTextEdits(op.edits);
  const original = cloneJson(block);
  let content: InlineNode[] =
    block.content === undefined ? [] : cloneJson(block.content);
  for (const edit of op.edits) content = applyTextEdit(content, edit);
  if (content.length === 0) delete block.content;
  else block.content = content;
  validateBlockSubtree([block]);
  return {
    changedBlockIds: [block.id],
    inverseOps: [
      { op: 'replace_block', target: block.id, blocks: [original] },
    ],
  };
}

function applyUpdateAttrsOperation(
  op: UpdateAttrsOperation,
  index: NodeIndex,
  trusted: boolean,
): OpEffect {
  const location = index.get(op.target);
  if (location === undefined)
    fail('node/not-found', `节点不存在：${op.target}`);
  const block = location.block;
  const definition = requireNodeType(block.type);
  if (!trusted && !operationAllowedOn(block.type, 'update_attrs'))
    fail('node/not-writable', `节点类型 ${block.type} 不允许 update_attrs`);
  if (!isPlainObject(op.attrs))
    fail('op/invalid', 'update_attrs 需要 attrs 对象');
  const original = cloneJson(block);
  const attrs: Record<string, JsonValue> = cloneJson(block.attrs);
  for (const [key, value] of Object.entries(op.attrs)) {
    if (key === 'objectId')
      fail(
        'node/not-writable',
        'update_attrs 不能修改 objectId；修改对象请用 update_object',
      );
    if (value === null) {
      const spec = definition.attrs[key];
      if (spec === undefined)
        fail('node/schema-invalid', `节点 ${block.type} 不支持属性 ${key}`);
      if (spec.required)
        fail(
          'node/schema-invalid',
          `节点 ${block.type} 的必填属性 ${key} 不能删除`,
        );
      delete attrs[key];
    } else {
      attrs[key] = cloneJson(value);
    }
  }
  block.attrs = attrs;
  validateBlockSubtree([block]);
  return {
    changedBlockIds: [block.id],
    inverseOps: [
      { op: 'replace_block', target: block.id, blocks: [original] },
    ],
  };
}

function applyMoveOperation(
  doc: AlterDoc,
  op: MoveOperation,
  index: NodeIndex,
  trusted: boolean,
): OpEffect {
  const location = index.get(op.target);
  if (location === undefined)
    fail('node/not-found', `节点不存在：${op.target}`);
  const block = location.block;
  if (!trusted && !operationAllowedOn(block.type, 'move_block'))
    fail('node/not-writable', `节点类型 ${block.type} 不允许 move_block`);
  const destinationParentId =
    op.parent === undefined ? undefined : op.parent;
  if (destinationParentId === op.target)
    fail('op/invalid', '不能把块移动到自身');
  if (op.after === op.target) fail('op/invalid', 'after 不能是被移动的块');
  if (destinationParentId !== undefined && destinationParentId !== null) {
    const destination = index.get(destinationParentId);
    if (destination === undefined)
      fail('node/not-found', `父节点不存在：${destinationParentId}`);
    // Reject moving a block into its own subtree.
    let cursor: NodeLocation | undefined = destination;
    let guard = 0;
    while (cursor !== undefined && guard < MAX_BLOCK_DEPTH + 2) {
      if (cursor.block.id === op.target)
        fail('op/invalid', '不能把块移动到自身子树内');
      cursor =
        cursor.parentId === null ? undefined : index.get(cursor.parentId);
      guard += 1;
    }
  }
  const oldParentId = location.parentId;
  const oldIndex = location.index;
  const original = block;
  location.siblings.splice(location.index, 1);
  const freshIndex = buildNodeIndex(doc);
  const anchor = resolveAnchor(
    doc,
    freshIndex,
    destinationParentId,
    trusted,
  );
  const at = resolveInsertIndex(anchor, freshIndex, op.after, op.index);
  assertInsertDepth(anchor.parentDepth, [block]);
  assertAllowedChildren(anchor.definition, [block]);
  anchor.siblings.splice(at, 0, block);
  const changedBlockIds = dedupeIds([
    block.id,
    ...(oldParentId === null ? [] : [oldParentId]),
    ...(anchor.parentId === null ? [] : [anchor.parentId]),
  ]);
  return {
    changedBlockIds,
    inverseOps: [
      {
        op: 'move_block',
        target: original.id,
        parent: oldParentId,
        index: oldIndex,
      },
    ],
  };
}

function applyDeleteOperation(
  op: DeleteOperation,
  index: NodeIndex,
  trusted: boolean,
): OpEffect {
  const location = index.get(op.target);
  if (location === undefined)
    fail('node/not-found', `节点不存在：${op.target}`);
  const block = location.block;
  if (!trusted && !operationAllowedOn(block.type, 'delete_block'))
    fail('node/not-writable', `节点类型 ${block.type} 不允许 delete_block`);
  const mode = op.mode ?? 'remove';
  if (mode !== 'remove' && mode !== 'unwrap')
    fail('op/invalid', `未知 delete mode：${String(mode)}`);
  const original = cloneJson(block);
  const parentId = location.parentId;
  const at = location.index;
  const parentDefinition =
    location.parent === null ? null : requireNodeType(location.parent.type);
  if (mode === 'remove') {
    location.siblings.splice(location.index, 1);
    return {
      changedBlockIds: dedupeIds([
        block.id,
        ...(parentId === null ? [] : [parentId]),
      ]),
      inverseOps: [
        {
          op: 'insert_blocks',
          parent: parentId,
          index: at,
          blocks: [original],
        },
      ],
    };
  }
  const definition = requireNodeType(block.type);
  if (definition.contentModel !== 'blocks')
    fail(
      'node/not-writable',
      `unwrap 仅支持容器块（${block.type} 不是块容器）`,
    );
  const children = block.children ?? [];
  assertAllowedChildren(parentDefinition, children);
  const parentDepth = location.depth - 1;
  for (const child of children) {
    if (parentDepth + subtreeDepth(child) > MAX_BLOCK_DEPTH)
      fail(
        'node/schema-invalid',
        `unwrap 后 block 嵌套深度超过上限 ${MAX_BLOCK_DEPTH}`,
      );
  }
  location.siblings.splice(location.index, 1, ...children);
  const inverseOps: Operation[] = children.map((child) => ({
    op: 'delete_block' as const,
    target: child.id,
  }));
  inverseOps.push({
    op: 'insert_blocks',
    parent: parentId,
    index: at,
    blocks: [original],
  });
  return {
    changedBlockIds: dedupeIds([
      block.id,
      ...children.map((child) => child.id),
      ...(parentId === null ? [] : [parentId]),
    ]),
    inverseOps,
  };
}

/** Carry the source payload of a transform when the content model matches. */
function carryTransformPayload(
  fromModel: ContentModel,
  block: BlockNode,
  nextBlock: BlockNode,
  toDefinition: NodeTypeDefinition,
): void {
  if (fromModel === 'inline') {
    if (block.content === undefined) return;
    const content = cloneJson(block.content);
    const allowedMarks = toDefinition.allowedMarks;
    if (allowedMarks !== undefined && allowedMarks.length === 0) {
      // e.g. codeBlock: flatten to one plain text node, drops all marks.
      const text = plainTextOfInline(content);
      if (text !== '') nextBlock.content = [{ type: 'text', text }];
      return;
    }
    nextBlock.content = content;
    return;
  }
  if (fromModel === 'blocks' || fromModel === 'table') {
    if (block.children !== undefined)
      nextBlock.children = cloneJson(block.children);
  }
}

/**
 * Inverse batch of one `transform_block`.
 *
 * The target changed type, so a bare `replace_block` would be rejected by the
 * same-type rule. When a reverse transform edge exists we first transform back
 * (content-model compatible payloads survive), then `replace_block` the exact
 * original block to restore payload/attrs. Otherwise fall back to removing the
 * transformed block and re-inserting the original at its recorded position.
 */
function buildTransformInverse(
  original: BlockNode,
  currentType: string,
  parentId: string | null,
  atIndex: number,
): Operation[] {
  if (canTransform(currentType, original.type)) {
    return [
      {
        op: 'transform_block',
        target: original.id,
        to: original.type,
        attrs: cloneJson(original.attrs),
      },
      { op: 'replace_block', target: original.id, blocks: [cloneJson(original)] },
    ];
  }
  return [
    { op: 'delete_block', target: original.id },
    {
      op: 'insert_blocks',
      parent: parentId,
      index: atIndex,
      blocks: [cloneJson(original)],
    },
  ];
}

function applyTransformOperation(
  op: TransformOperation,
  index: NodeIndex,
  trusted: boolean,
): OpEffect {
  const location = index.get(op.target);
  if (location === undefined)
    fail('node/not-found', `节点不存在：${op.target}`);
  const block = location.block;
  const fromType = block.type;
  const fromDefinition = requireNodeType(fromType);
  if (!trusted && !operationAllowedOn(fromType, 'transform_block'))
    fail('node/not-writable', `节点类型 ${fromType} 不允许 transform_block`);
  if (typeof op.to !== 'string' || op.to.trim() === '')
    fail('op/invalid', 'transform_block 需要 to');
  if (op.attrs !== undefined && !isPlainObject(op.attrs))
    fail('op/invalid', 'transform_block 的 attrs 必须是对象');
  const toDefinition = requireNodeType(op.to);
  if (!canTransform(fromType, op.to))
    fail(
      'node/unsupported-transform',
      `${fromType} 不能转换为 ${op.to}（不在 registry 白名单内）`,
    );
  const original = cloneJson(block);
  const nextBlock: BlockNode = {
    id: block.id,
    type: op.to,
    attrs: normalizeAttrs(op.to, op.attrs),
  };
  if (fromDefinition.contentModel === toDefinition.contentModel)
    carryTransformPayload(
      fromDefinition.contentModel,
      block,
      nextBlock,
      toDefinition,
    );
  validateBlockSubtree([nextBlock]);
  const parentId = location.parentId;
  const at = location.index;
  location.siblings[location.index] = nextBlock;
  return {
    changedBlockIds: [block.id],
    inverseOps: buildTransformInverse(original, op.to, parentId, at),
  };
}

function applyUpdateObjectOperation(
  op: UpdateObjectOperation,
  index: NodeIndex,
  ctx: OperationContext,
  trusted: boolean,
): OpEffect {
  const location = index.get(op.target);
  if (location === undefined)
    fail('node/not-found', `节点不存在：${op.target}`);
  const block = location.block;
  const type = block.type;
  if (!trusted && !operationAllowedOn(type, 'update_object'))
    fail('node/not-writable', `节点类型 ${type} 不允许 update_object`);
  if (type !== 'mindmap' && type !== 'component')
    fail('node/not-writable', 'update_object 仅支持 mindmap/component 块');
  const objectType: 'mindmap' | 'component' = type;
  validateObjectPayload(objectType, op.payload);
  const original = cloneJson(block);
  const objectId = ctx.createObject({
    docId: ctx.docId,
    blockId: block.id,
    type: objectType,
    payload: cloneJson(op.payload),
  });
  if (
    typeof objectId !== 'string' ||
    objectId.trim() === '' ||
    !objectId.startsWith('obj_')
  )
    fail('object/invalid', `createObject 返回了无效的对象 id：${String(objectId)}`);
  block.attrs = { ...cloneJson(block.attrs), objectId };
  validateBlockSubtree([block]);
  return {
    changedBlockIds: [block.id],
    inverseOps: [
      { op: 'replace_block', target: block.id, blocks: [original] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function applyOne(
  doc: AlterDoc,
  op: Operation,
  index: NodeIndex,
  ctx: OperationContext,
  usedIds: Set<string>,
  trusted: boolean,
): OpEffect {
  switch (op.op) {
    case 'insert_blocks':
      return applyInsertOperation(
        doc,
        op as InsertOperation,
        index,
        ctx,
        usedIds,
        trusted,
      );
    case 'insert_markdown':
      return applyInsertOperation(
        doc,
        op as InsertMarkdownOperation,
        index,
        ctx,
        usedIds,
        trusted,
      );
    case 'replace_block':
      return applyReplaceOperation(op, index, ctx, usedIds, trusted);
    case 'update_text':
      return applyUpdateTextOperation(op, index, trusted);
    case 'update_attrs':
      return applyUpdateAttrsOperation(op, index, trusted);
    case 'move_block':
      return applyMoveOperation(doc, op, index, trusted);
    case 'delete_block':
      return applyDeleteOperation(op, index, trusted);
    case 'transform_block':
      return applyTransformOperation(op, index, trusted);
    case 'update_object':
      return applyUpdateObjectOperation(op, index, ctx, trusted);
    default:
      return fail(
        'op/invalid',
        `未知 operation：${String((op as { op?: unknown }).op)}`,
      );
  }
}

/** Remove duplicate ids while preserving first-seen order. */
function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Options of one {@link applyOperations} batch. */
export interface ApplyOperationsOptions {
  /**
   * System-generated replay (undo `inverseOps` / version restore): skip the AI
   * capability gates (`ai.writable` / `ai.ops`) that protect normal caller
   * batches, while still enforcing schema, size, existence and id-uniqueness.
   * Normal `applyOperations` calls must leave this unset so the fail-closed
   * behaviour is unchanged.
   */
  trusted?: boolean;
}

/**
 * Apply one batch of Document Operations to a deep copy of `doc`.
 *
 * The batch is atomic: any failure throws a {@link DocumentError} (with the
 * failing operation index in `issues`) and no partial document is returned.
 * `doc.revision` is preserved; the caller increments it inside its transaction.
 *
 * @param doc - current canonical document (not mutated).
 * @param ops - non-empty operation batch, applied in order.
 * @param ctx - injected environment (ids, markdown parser, object factory).
 * @param options - batch options; `trusted` marks internal inverse/restore
 *   replays that bypass AI capability gates but not schema validation.
 * @returns the new document, its diff and the batch that undoes it.
 */
export function applyOperations(
  doc: AlterDoc,
  ops: Operation[],
  ctx: OperationContext,
  options: ApplyOperationsOptions = {},
): OpsResult {
  const trusted = options.trusted === true;
  validateOperationsShape(ops);
  validateAlterDoc(doc);
  const next = cloneJson(doc);
  let usedIds = new Set<string>();
  collectBlockIds(next.blocks, usedIds);
  const applied: OpsResult['diff']['applied'] = [];
  const inverseGroups: Operation[][] = [];
  const changedBlockIds: string[] = [];
  for (const [opIndex, op] of ops.entries()) {
    const nodeIndex = buildNodeIndex(next);
    let effect: OpEffect;
    try {
      effect = applyOne(next, op, nodeIndex, ctx, usedIds, trusted);
    } catch (error) {
      if (error instanceof DocumentError) {
        const issues: OperationIssue[] =
          error.issues !== undefined && error.issues.length > 0
            ? error.issues
            : [{ index: opIndex, code: error.code, message: error.message }];
        throw new DocumentError(
          error.code,
          `operation[${opIndex}] ${op.op}：${error.message}`,
          issues,
        );
      }
      throw error;
    }
    for (const id of effect.changedBlockIds) {
      if (!changedBlockIds.includes(id)) changedBlockIds.push(id);
    }
    applied.push({
      index: opIndex,
      op: op.op,
      changedBlockIds: effect.changedBlockIds,
    });
    inverseGroups.push(effect.inverseOps);
    // Deleted blocks free their ids for a later op in the same batch (this is
    // what lets generated inverse batches re-insert blocks under their ids).
    usedIds = new Set<string>();
    collectBlockIds(next.blocks, usedIds);
  }
  // Undo must run in reverse order: each inverse group was captured against the
  // state produced by the operations before it.
  const inverseOps = inverseGroups.reverse().flat();
  validateAlterDoc(next);
  return { doc: next, diff: { applied, changedBlockIds }, inverseOps };
}
