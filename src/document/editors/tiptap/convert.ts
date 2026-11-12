/**
 * Lossless `alter-doc/1` <-> ProseMirror document mapping.
 *
 * This replaces the lossy HTML round-trip the retired editor needed: an AST
 * block and a ProseMirror node are the same tree, so conversion is a walk with
 * no intermediate string format and no parsing heuristics.
 *
 * Two shapes intentionally differ from the AST registry because ProseMirror
 * needs real containers (the editor schema in `nodes.ts` declares the same
 * mapping):
 *
 * - a task list stores `taskItem` rows (the AST says `listItem`), so a row's
 *   checkbox state lives on the row node;
 * - table cells hold blocks and header rows use `tableHeader` nodes (the AST
 *   stores inline cell content and derives `<th>` from `headerRows`).
 *
 * Both directions are **total**: input the schema cannot represent is reported
 * through `warnings` and degraded to visible content instead of being silently
 * dropped, matching the adapter rule that "unknown markup degrades visibly,
 * never disappears".
 *
 * @module @alter-dsh/space/document/editors/tiptap/convert
 */
import {
  Fragment,
  type Mark as PmMark,
  type Node as PmNode,
  type Schema as SchemaType,
} from '@tiptap/pm/model';
import type { BlockNode, InlineNode, Mark, JsonValue } from '../../types';
import { nodeManifestEntry } from '../../schema-manifest';
import { getEditorSchema } from './schema';

/** Result of one conversion direction. */
export interface ConversionResult<T> {
  value: T;
  /** Content the target format could not represent, in human-readable form. */
  warnings: string[];
}

/**
 * Canonical AST form: empty `content`/`children` arrays are omitted, matching
 * what the Host stores. Ids and order are preserved.
 */
export function normalizeBlocks(blocks: readonly BlockNode[]): BlockNode[] {
  return blocks.map((node) => {
    const out: BlockNode = {
      id: node.id,
      type: node.type,
      attrs: normalizeAttrs(node.attrs),
    };
    if (node.content !== undefined && node.content.length > 0) {
      out.content = node.content;
    }
    if (node.children !== undefined && node.children.length > 0) {
      out.children = normalizeBlocks(node.children);
    }
    return out;
  });
}

/** Drop `undefined`/`null` attribute values (the registry default applies). */
function normalizeAttrs(attrs: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/** ProseMirror mark for one AST mark (undefined when the schema lacks it). */
function pmMarkFor(mark: Mark, schema: SchemaType): PmMark | undefined {
  const type = schema.marks[mark.type];
  if (type === undefined) return undefined;
  if (mark.type === 'link') {
    const href = mark.attrs?.href;
    if (typeof href !== 'string' || href === '') return undefined;
    return type.create({ href });
  }
  return type.create();
}

/**
 * Inline nodes of one AST block -> ProseMirror inline fragment.
 *
 * `allowedMarks` is the set the owning node type permits (empty for code
 * blocks). ProseMirror's `marks: ''` only restricts *editing*; `create()`
 * happily stores a mark the schema forbids, so dropping them has to happen
 * here or an illegal mark would reach the Host and fail schema validation.
 */
function inlineContent(
  content: readonly InlineNode[],
  blockType: string,
  allowedMarks: readonly string[],
  schema: SchemaType,
  warnings: string[],
): PmNode[] {
  const nodes: PmNode[] = [];
  for (const node of content) {
    if (node.type === 'hardBreak') {
      nodes.push(schema.nodes['hardBreak']!.create());
      continue;
    }
    if (node.text === '') continue;
    const marks: PmMark[] = [];
    for (const mark of node.marks ?? []) {
      if (!allowedMarks.includes(mark.type)) {
        warnings.push(
          `${blockType}: 行内标记 ${mark.type} 不被该节点允许，已省略`,
        );
        continue;
      }
      const pmMark = pmMarkFor(mark, schema);
      if (pmMark === undefined) {
        warnings.push(
          `${blockType}: 行内标记 ${mark.type} 在编辑器 schema 中不可用，已省略`,
        );
        continue;
      }
      marks.push(pmMark);
    }
    nodes.push(schema.text(node.text, marks));
  }
  return nodes;
}

/** Visible placeholder text for a node the editor cannot represent. */
const PLACEHOLDER_OF: Readonly<Record<string, string>> = {
  image: '[图片：缺少资产 id]',
  file: '[文件：缺少资产 id]',
  bookmark: '[网页链接卡：缺少链接]',
  docLink: '[文档内链卡：缺少文档 id]',
  mindmap: '[思维导图：缺少对象 id]',
  component: '[交互组件：缺少对象 id]',
};

/** One empty paragraph carrying the degraded block's id. */
function placeholderParagraph(
  block: BlockNode,
  schema: SchemaType,
  warnings: string[],
  reason: string,
): PmNode {
  warnings.push(reason);
  const text = PLACEHOLDER_OF[block.type] ?? `[不支持的块：${block.type}]`;
  const paragraph = schema.nodes['paragraph'];
  if (paragraph === undefined) throw new Error('editor schema has no paragraph');
  return paragraph.create({ id: block.id }, schema.text(text));
}

/** Convert AST blocks into one ProseMirror document. */
export function blocksToPmDoc(
  blocks: readonly BlockNode[],
  schema: SchemaType = getEditorSchema(),
): ConversionResult<PmNode> {
  const warnings: string[] = [];
  const nodes: PmNode[] = [];
  for (const block of blocks) {
    const converted = blockToPmNode(block, schema, warnings);
    if (converted !== undefined) nodes.push(converted);
  }
  // The doc schema requires at least one block; an empty document is a single
  // empty paragraph, which is also what a fresh document looks like.
  if (nodes.length === 0) nodes.push(emptyParagraph(schema));
  return {
    value: schema.nodes['doc']!.create(null, nodes),
    warnings,
  };
}

/** One empty paragraph node (the canonical empty document body). */
export function emptyParagraph(schema: SchemaType = getEditorSchema()): PmNode {
  return schema.nodes['paragraph']!.create({ id: '' }, null, []);
}

/** Registry attributes of one block, minus values the node contract rejects. */
function attrsForBlock(
  block: BlockNode,
  manifest: NonNullable<ReturnType<typeof nodeManifestEntry>>,
  warnings: string[],
): Record<string, JsonValue> {
  const attrs: Record<string, JsonValue> = {
    ...normalizeAttrs(block.attrs),
    id: block.id,
  };
  for (const key of Object.keys(attrs)) {
    if (key !== 'id' && manifest.attrs[key] === undefined) {
      warnings.push(`${block.type}.${key}: 属性不在节点契约中，已省略`);
      delete attrs[key];
    }
  }
  return attrs;
}

/** Names of a node's contract attributes that are required but absent. */
function missingRequired(
  block: BlockNode,
  manifest: NonNullable<ReturnType<typeof nodeManifestEntry>>,
): string[] {
  return Object.entries(manifest.attrs)
    .filter(
      ([key, spec]) =>
        spec.required === true &&
        (block.attrs[key] === null || block.attrs[key] === undefined),
    )
    .map(([key]) => key);
}

/** Convert one AST block (recursively) into a ProseMirror node. */
function blockToPmNode(
  block: BlockNode,
  schema: SchemaType,
  warnings: string[],
  parentType?: string,
): PmNode | undefined {
  const manifest = nodeManifestEntry(block.type);
  if (manifest === undefined) {
    return placeholderParagraph(
      block,
      schema,
      warnings,
      `${block.id}: 未知节点类型 ${block.type}，已降级为占位段落`,
    );
  }
  if (block.type === 'table') return tableToPmNode(block, schema, warnings);
  if (block.type === 'listItem' && parentType === 'taskList') {
    return taskItemToPmNode(block, schema, warnings);
  }

  const type = schema.nodes[block.type];
  if (type === undefined) {
    return placeholderParagraph(
      block,
      schema,
      warnings,
      `${block.id}: 节点类型 ${block.type} 不在编辑器 schema 中，已降级为占位段落`,
    );
  }
  const attrs = attrsForBlock(block, manifest, warnings);
  // `checked` is meaningful only on rows inside a task list; a bullet/ordered
  // list item carrying it would lose the attribute in the editor schema.
  if (block.type === 'listItem' && parentType !== 'taskList') {
    if (attrs['checked'] !== undefined) {
      warnings.push(`${block.id}: 普通列表项不支持 checked 属性，已省略`);
      delete attrs['checked'];
    }
  }

  if (manifest.contentModel === 'none') {
    const missing = missingRequired(block, manifest);
    if (missing.length > 0) {
      return placeholderParagraph(
        block,
        schema,
        warnings,
        `${block.type}: 缺少必要属性 ${missing.join('、')}，已降级为占位段落`,
      );
    }
    return type.create(attrs);
  }

  if (manifest.contentModel === 'inline') {
    const inline = inlineContent(
      block.content ?? [],
      block.type,
      manifest.marks,
      schema,
      warnings,
    );
    // `Node.create(attrs, content, marks)`: content is the second argument.
    return type.create(attrs, Fragment.fromArray(inline));
  }

  const children: PmNode[] = [];
  for (const child of block.children ?? []) {
    const converted = blockToPmNode(child, schema, warnings, block.type);
    if (converted !== undefined) children.push(converted);
  }
  // Rows and list items must start with a paragraph; an empty one keeps the
  // block editable instead of making the schema reject the document.
  if (children.length === 0 || !children[0]!.isTextblock) {
    if (block.type === 'listItem' || block.type === 'taskItem') {
      warnings.push(`${block.type}: 首个子块不是段落，已补空段落`);
      const paragraph = schema.nodes['paragraph'];
      if (paragraph !== undefined) {
        children.unshift(paragraph.create({ id: null }, null));
      }
    }
  }
  if (children.length === 0) {
    const relaxed = schema.nodes['paragraph'];
    if (relaxed === undefined) return undefined;
    warnings.push(`${block.type}: 容器没有可表示的子节点，已降级为空段落`);
    return relaxed.create({ id: block.id }, null);
  }
  const fragment = Fragment.fromArray(children);
  // `create()` does not validate content; an invalid container would produce a
  // document ProseMirror cannot render or edit, so it is reported and dropped
  // instead of corrupting the whole body.
  if (!type.validContent(fragment)) {
    warnings.push(`${block.type}: 子节点结构与节点契约不符，已省略`);
    return undefined;
  }
  return type.create(attrs, fragment);
}

/** One task row (`taskItem`) from an AST `listItem` inside a task list. */
function taskItemToPmNode(
  block: BlockNode,
  schema: SchemaType,
  warnings: string[],
): PmNode {
  const type = schema.nodes['taskItem'];
  if (type === undefined) {
    return placeholderParagraph(
      block,
      schema,
      warnings,
      `${block.id}: taskItem 节点不在编辑器 schema 中`,
    );
  }
  const children: PmNode[] = [];
  for (const child of block.children ?? []) {
    const converted = blockToPmNode(child, schema, warnings, 'taskItem');
    if (converted !== undefined) children.push(converted);
  }
  if (children.length === 0 || !children[0]!.isTextblock) {
    const paragraph = schema.nodes['paragraph'];
    if (paragraph !== undefined) {
      children.unshift(paragraph.create({ id: null }, null));
    }
  }
  return type.create(
    { id: block.id, checked: block.attrs.checked === true },
    Fragment.fromArray(children),
  );
}

/** Largest cell span the AST contract allows (mirrors the Host registry). */
const MAX_CELL_SPAN = 50;

/**
 * Read one span attr of an AST cell.
 *
 * Missing/absent means the implicit 1 (plain cell). Out-of-contract values are
 * clamped so the editor can never emit a span the Host rejects.
 */
function cellSpanOf(
  attrs: BlockNode['attrs'],
  key: 'colspan' | 'rowspan',
): number {
  const raw = attrs[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1;
  const span = Math.trunc(raw);
  if (span < 1) return 1;
  return Math.min(span, MAX_CELL_SPAN);
}

/**
 * AST attrs of one editor cell: spans only when they change the grid.
 *
 * `1` is implicit and omitted, which keeps non-merged tables byte-identical to
 * the pre-merge contract and makes reload/capture round-trips idempotent.
 */
function cellAttrsOfPmNode(
  cell: PmNode,
  warnings: string[],
): Record<string, JsonValue> {
  const attrs: Record<string, JsonValue> = {};
  for (const key of ['colspan', 'rowspan'] as const) {
    const raw = cell.attrs[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const span = Math.trunc(raw);
    if (span < 1) continue;
    if (span > MAX_CELL_SPAN) {
      warnings.push(
        `tableCell: ${key} ${span} 超过上限 ${MAX_CELL_SPAN}，已按上限保存`,
      );
      attrs[key] = MAX_CELL_SPAN;
      continue;
    }
    if (span > 1) attrs[key] = span;
  }
  return attrs;
}

/** Paragraph holding one table cell's inline content. */
function cellParagraph(
  cell: BlockNode,
  schema: SchemaType,
  warnings: string[],
): PmNode | undefined {
  const manifest = nodeManifestEntry('tableCell');
  const paragraph = schema.nodes['paragraph'];
  if (manifest === undefined || paragraph === undefined) return undefined;
  const inline = inlineContent(
    cell.content ?? [],
    'tableCell',
    manifest.marks,
    schema,
    warnings,
  );
  return paragraph.create({ id: null }, Fragment.fromArray(inline));
}

/** One table row, using header cells for the leading `headerRows` rows. */
function tableRowToPmNode(
  row: BlockNode,
  header: boolean,
  schema: SchemaType,
  warnings: string[],
): PmNode | undefined {
  const rowType = schema.nodes['tableRow'];
  const cellType = schema.nodes[header ? 'tableHeader' : 'tableCell'];
  if (rowType === undefined || cellType === undefined) return undefined;
  const cells: PmNode[] = [];
  for (const cell of row.children ?? []) {
    if (cell.type !== 'tableCell' && cell.type !== 'tableHeader') {
      warnings.push(`${row.id}: 表格行内出现非单元格节点 ${cell.type}，已省略`);
      continue;
    }
    const paragraph = cellParagraph(cell, schema, warnings);
    if (paragraph !== undefined) {
      cells.push(
        cellType.create(
          {
            id: cell.id,
            colspan: cellSpanOf(cell.attrs, 'colspan'),
            rowspan: cellSpanOf(cell.attrs, 'rowspan'),
          },
          paragraph,
        ),
      );
    }
  }
  // An empty row is a legitimate shape: it is covered by a `rowspan` cell in a
  // row above (ProseMirror's merge model removes the covered cells).
  return rowType.create({ id: row.id }, Fragment.fromArray(cells));
}

/** One AST table, splitting rows into header and body cells by `headerRows`. */
function tableToPmNode(
  block: BlockNode,
  schema: SchemaType,
  warnings: string[],
): PmNode | undefined {
  const tableType = schema.nodes['table'];
  if (tableType === undefined) return undefined;
  const rows = (block.children ?? []).filter(
    (child) => child.type === 'tableRow',
  );
  if (rows.length === 0) {
    return placeholderParagraph(
      block,
      schema,
      warnings,
      `${block.id}: 表格没有行，已降级为占位段落`,
    );
  }
  const raw = block.attrs['headerRows'];
  const requested =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 1;
  const headerRows = Math.max(0, Math.min(rows.length, requested));
  const rowNodes: PmNode[] = [];
  rows.forEach((row, index) => {
    const converted = tableRowToPmNode(
      row,
      index < headerRows,
      schema,
      warnings,
    );
    if (converted !== undefined) rowNodes.push(converted);
  });
  if (rowNodes.length === 0) {
    return placeholderParagraph(
      block,
      schema,
      warnings,
      `${block.id}: 表格没有可表示的行，已降级为占位段落`,
    );
  }
  return tableType.create({ id: block.id }, Fragment.fromArray(rowNodes));
}

/** Convert one ProseMirror document back into canonical AST blocks. */
export function pmDocToBlocks(
  doc: PmNode,
  schema: SchemaType = getEditorSchema(),
): ConversionResult<BlockNode[]> {
  void schema;
  const warnings: string[] = [];
  const blocks: BlockNode[] = [];
  doc.forEach((node) => {
    const block = pmNodeToBlock(node, warnings);
    if (block !== undefined) blocks.push(block);
  });
  return { value: normalizeBlocks(blocks), warnings };
}

/** Stable block id for an editor-created node that has none yet. */
let generatedId = 0;

/** Allocate one `blk_…` id (the Host only requires a unique string). */
export function allocateBlockId(): string {
  generatedId += 1;
  const cryptoApi = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  const unique =
    cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `blk_${unique.replaceAll('-', '')}${generatedId}`;
}

/**
 * Remembered ids for editor-created nodes.
 *
 * A node the editor inserted has no `id` attr yet; allocating a fresh one on
 * every capture would rewrite the block id on each save and break comment
 * anchors. The id is remembered per ProseMirror node and survives until the
 * kernel stamps it into the node attrs (which it does on the first capture).
 */
const rememberedIds = new WeakMap<PmNode, string>();

/** Reset remembered ids and the counter between tests. */
export function resetBlockIdSequence(): void {
  generatedId = 0;
}

/** Stable id of one ProseMirror block (allocated once when missing). */
function stableIdOf(node: PmNode): string {
  const rawId = node.attrs['id'];
  if (typeof rawId === 'string' && rawId !== '') return rawId;
  const remembered = rememberedIds.get(node);
  if (remembered !== undefined) return remembered;
  const id = allocateBlockId();
  rememberedIds.set(node, id);
  return id;
}

/** Registry attrs of one ProseMirror node, read through the manifest. */
function attrsOfPmNode(
  node: PmNode,
  manifest: NonNullable<ReturnType<typeof nodeManifestEntry>>,
): Record<string, JsonValue> {
  const attrs: Record<string, JsonValue> = {};
  for (const key of Object.keys(manifest.attrs)) {
    const value = node.attrs[key];
    if (value === undefined || value === null) continue;
    attrs[key] = value as JsonValue;
  }
  return attrs;
}

/** Inline nodes of one textblock, reporting marks the AST cannot represent. */
function inlineNodesOf(
  node: PmNode,
  blockType: string,
  warnings: string[],
): InlineNode[] {
  const content: InlineNode[] = [];
  node.forEach((child) => {
    if (child.isText) {
      const text = child.text ?? '';
      if (text === '') return;
      const marks: Mark[] = [];
      let missing = 0;
      for (const mark of child.marks) {
        const converted = astMarkOf(mark);
        if (converted === undefined) {
          missing += 1;
          continue;
        }
        marks.push(converted);
      }
      if (missing > 0) {
        warnings.push(
          `${blockType}: ${missing} 个行内标记在 AST 中不可表示，已省略`,
        );
      }
      content.push(
        marks.length === 0
          ? { type: 'text', text }
          : { type: 'text', text, marks },
      );
      return;
    }
    if (child.type.name === 'hardBreak') {
      content.push({ type: 'hardBreak' });
      return;
    }
    warnings.push(`${blockType}: 行内节点 ${child.type.name} 不可表示，已省略`);
  });
  return content;
}

/** Convert one ProseMirror node into an AST block (recursively). */
function pmNodeToBlock(node: PmNode, warnings: string[]): BlockNode | undefined {
  const name = node.type.name;
  if (name === 'table') return tableToBlock(node, warnings);
  // Internal editor nodes map back to the registry node they stand for.
  const manifestName =
    name === 'taskItem' ? 'listItem' : name === 'tableHeader' ? 'tableCell' : name;
  const manifest = nodeManifestEntry(manifestName);
  if (manifest === undefined) {
    warnings.push(`未知的编辑器节点 ${name}，已省略`);
    return undefined;
  }
  const block: BlockNode = {
    id: stableIdOf(node),
    type: manifest.type,
    attrs: attrsOfPmNode(node, manifest),
  };

  if (manifest.contentModel === 'inline') {
    const content = inlineNodesOf(node, manifest.type, warnings);
    if (content.length > 0) block.content = content;
    return block;
  }

  if (manifest.contentModel === 'none') return block;

  const children: BlockNode[] = [];
  node.forEach((child) => {
    const converted = pmNodeToBlock(child, warnings);
    if (converted !== undefined) children.push(converted);
  });
  if (children.length > 0) block.children = children;
  return block;
}

/** Inline content of one editor cell (the AST stores cells as inline text). */
function cellInlineContent(cell: PmNode, warnings: string[]): InlineNode[] {
  const content: InlineNode[] = [];
  let blocks = 0;
  cell.forEach((child) => {
    if (child.isTextblock) {
      if (blocks > 0) content.push({ type: 'hardBreak' });
      content.push(...inlineNodesOf(child, 'tableCell', warnings));
    } else {
      warnings.push(
        `tableCell: 单元格内出现块级节点 ${child.type.name}，已展开为文本`,
      );
      if (content.length > 0) content.push({ type: 'hardBreak' });
      const text = child.textContent;
      if (text !== '') content.push({ type: 'text', text });
    }
    blocks += 1;
  });
  return content;
}

/** One editor row -> AST row (every cell becomes `tableCell`). */
function tableRowToBlock(row: PmNode, warnings: string[]): BlockNode {
  const cells: BlockNode[] = [];
  row.forEach((cell) => {
    if (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader') {
      warnings.push(`tableRow: 出现非单元格节点 ${cell.type.name}，已省略`);
      return;
    }
    const block: BlockNode = {
      id: stableIdOf(cell),
      type: 'tableCell',
      attrs: cellAttrsOfPmNode(cell, warnings),
    };
    const content = cellInlineContent(cell, warnings);
    if (content.length > 0) block.content = content;
    cells.push(block);
  });
  return { id: stableIdOf(row), type: 'tableRow', attrs: {}, children: cells };
}

/** Whether one row is rendered entirely as header cells. */
function isHeaderRow(row: PmNode): boolean {
  if (row.childCount === 0) return false;
  let header = true;
  row.forEach((cell) => {
    if (cell.type.name !== 'tableHeader') header = false;
  });
  return header;
}

/** One editor table -> AST table, deriving `headerRows` from the th rows. */
function tableToBlock(table: PmNode, warnings: string[]): BlockNode {
  const rows: BlockNode[] = [];
  let headerRows = 0;
  let leading = true;
  table.forEach((row) => {
    if (row.type.name !== 'tableRow') {
      warnings.push(`table: 出现非表格行节点 ${row.type.name}，已省略`);
      return;
    }
    if (leading && isHeaderRow(row)) headerRows += 1;
    else leading = false;
    rows.push(tableRowToBlock(row, warnings));
  });
  return {
    id: stableIdOf(table),
    type: 'table',
    attrs: { headerRows },
    children: rows,
  };
}

/** AST mark for one ProseMirror mark (undefined when the AST lacks it). */
function astMarkOf(mark: PmMark): Mark | undefined {
  const name = mark.type.name;
  if (name === 'link') {
    const href = mark.attrs['href'];
    if (typeof href !== 'string' || href === '') return undefined;
    return { type: 'link', attrs: { href } };
  }
  const known: ReadonlySet<Mark['type']> = new Set([
    'bold',
    'italic',
    'underline',
    'strike',
    'code',
    'highlight',
  ]);
  return known.has(name as Mark['type']) ? { type: name as Mark['type'] } : undefined;
}