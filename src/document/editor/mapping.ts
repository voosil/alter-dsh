/**
 * Bidirectional mapping between the Alter block AST (`AlterDoc.blocks`) and
 * the Tiptap/ProseMirror JSON document used by the editor.
 *
 * Rules that keep the two representations in sync:
 * - Every block id is carried in the `blockId` node attribute (a global
 *   attribute registered by `schema.ts`), so ids survive editing.
 * - Missing or duplicate `blockId`s (copy/paste duplicates blocks with their
 *   attrs) are replaced by a fresh `blk_` + UUID-without-dashes id.
 * - Inline content is canonicalized (adjacent equal-mark text merged, marks in
 *   registry order) because the Host stores it that way; `canonical.ts` owns
 *   that normalization.
 * - Unknown Tiptap nodes degrade to a paragraph (text preserved) or are
 *   skipped when empty; unknown AST node types degrade to a visible paragraph
 *   placeholder. Neither direction throws.
 * - ProseMirror requires non-empty containers (`blockquote`/`callout` =
 *   `block+`, lists = `item+`, list items = `paragraph block*`, table =
 *   `row+`), while the v0 AST allows empty children. Empty containers are
 *   therefore projected with a *wrapper* paragraph/list item that carries no
 *   `blockId`; the reverse mapping drops such wrappers again, so an empty
 *   container round-trips exactly.
 *
 * Known normalizations (non-canonical input may change shape):
 * - `orderedList.start === 1` and an absent `table.headerRows` are lowered to
 *   the registry defaults (1 / one header row) and are not written back as
 *   explicit attrs.
 * - An empty table (no rows) cannot exist in the ProseMirror schema and is
 *   projected as a `[空表格]` paragraph placeholder.
 *
 * @module @alter-dsh/space/document/editor/mapping
 */
import type { JSONContent } from '@tiptap/core';
import type { AlterDoc, BlockNode, InlineNode, JsonValue, Mark } from '../types';
import {
  MARK_ORDER,
  canonicalInline,
  isSafeHref,
  type AlterMarkType,
} from './canonical';

/** Callout tones accepted by the Host registry. */
const CALL_TONES = ['info', 'warn', 'success', 'danger'] as const;

/** Attribute length caps from the Host node registry. */
const MAX_TITLE = 200;
const MAX_CAPTION = 500;
const MAX_ALT = 500;
const MAX_ICON = 64;
const MAX_WIDTH = 32;
const MAX_LANG = 32;
const MAX_URL = 2048;
const MAX_DOC_ID = 128;

/** Empty paragraph node, used as a schema-required content filler. */
function emptyParagraph(): JSONContent {
  return { type: 'paragraph' };
}

/** A paragraph placeholder for content the editor cannot represent. */
function placeholderParagraph(block: BlockNode, text: string): JSONContent {
  return {
    type: 'paragraph',
    attrs: { blockId: block.id },
    content: [{ type: 'text', text }],
  };
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

function asString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Tiptap node attrs for an AST block: always the block id, then extras. */
function attrsOf(
  block: BlockNode,
  extra: Record<string, JsonValue | undefined> = {},
): Record<string, JsonValue> {
  const attrs: Record<string, JsonValue> = { blockId: block.id };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) attrs[key] = value;
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Inline: AST → Tiptap
// ---------------------------------------------------------------------------

function marksToTiptap(marks: Mark[] | undefined): JSONContent['marks'] {
  if (marks === undefined || marks.length === 0) return undefined;
  const result: NonNullable<JSONContent['marks']> = [];
  for (const mark of marks) {
    if (mark.type === 'link') {
      const href = mark.attrs?.href;
      if (!isSafeHref(href)) continue;
      result.push({ type: 'link', attrs: { href } });
    } else {
      result.push({ type: mark.type });
    }
  }
  return result.length > 0 ? result : undefined;
}

function inlineToTiptap(content: InlineNode[] | undefined): JSONContent[] {
  const nodes: JSONContent[] = [];
  for (const node of content ?? []) {
    if (node.type === 'hardBreak') {
      nodes.push({ type: 'hardBreak' });
      continue;
    }
    if (typeof node.text !== 'string' || node.text === '') continue;
    const marks = marksToTiptap(node.marks);
    nodes.push(
      marks === undefined
        ? { type: 'text', text: node.text }
        : { type: 'text', text: node.text, marks },
    );
  }
  return nodes;
}

/** Plain text of inline content; breaks become newlines. */
function plainTextOf(content: InlineNode[] | undefined): string {
  let text = '';
  for (const node of content ?? []) {
    text += node.type === 'text' ? node.text : '\n';
  }
  return text;
}

// ---------------------------------------------------------------------------
// Inline: Tiptap → AST
// ---------------------------------------------------------------------------

function marksToAst(marks: JSONContent['marks']): Mark[] | undefined {
  if (marks === undefined || marks.length === 0) return undefined;
  const result: Mark[] = [];
  for (const mark of marks) {
    if (typeof mark.type !== 'string') continue;
    if (mark.type === 'link') {
      const href = mark.attrs?.['href'];
      if (!isSafeHref(href)) continue;
      result.push({ type: 'link', attrs: { href } });
      continue;
    }
    if (!MARK_ORDER.includes(mark.type as AlterMarkType)) continue;
    result.push({ type: mark.type as AlterMarkType });
  }
  return result.length > 0 ? result : undefined;
}

function tiptapToInline(content: JSONContent['content'] | undefined): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (const node of content ?? []) {
    if (node.type === 'text') {
      const text = typeof node.text === 'string' ? node.text : '';
      if (text === '') continue;
      const marks = marksToAst(node.marks);
      nodes.push(
        marks === undefined
          ? { type: 'text', text }
          : { type: 'text', text, marks },
      );
      continue;
    }
    if (node.type === 'hardBreak') {
      nodes.push({ type: 'hardBreak' });
      continue;
    }
    // Unknown inline node: flatten its content so text is not silently lost.
    nodes.push(...tiptapToInline(node.content));
  }
  return canonicalInline(nodes);
}

// ---------------------------------------------------------------------------
// Block ids
// ---------------------------------------------------------------------------

/** Whether the node carries a usable `blockId` attribute. */
function hasRawBlockId(node: JSONContent): boolean {
  const candidate = node.attrs?.['blockId'];
  return typeof candidate === 'string' && candidate.trim() !== '';
}

/** Generate a fresh stable block id (`blk_` + UUID without dashes). */
export function newBlockId(): string {
  const cryptoApi = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  const uuid =
    cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `blk_${uuid.replaceAll('-', '')}`;
}

function freshBlockId(used: Set<string>): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = newBlockId();
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error('无法生成唯一的 block id');
}

/** Resolve the id for one converted block, de-duplicating copied ids. */
function blockIdOf(node: JSONContent, used: Set<string>): string {
  const candidate = node.attrs?.['blockId'];
  if (typeof candidate === 'string' && candidate.trim() !== '' && !used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  return freshBlockId(used);
}

interface BlockDraft {
  type: string;
  attrs?: BlockNode['attrs'];
  content?: InlineNode[];
  children?: BlockNode[];
}

function makeBlock(
  node: JSONContent,
  draft: BlockDraft,
  used: Set<string>,
): BlockNode {
  const block: BlockNode = {
    id: blockIdOf(node, used),
    type: draft.type,
    attrs: draft.attrs ?? {},
  };
  if (draft.content !== undefined && draft.content.length > 0) {
    block.content = draft.content;
  }
  if (draft.children !== undefined && draft.children.length > 0) {
    block.children = draft.children;
  }
  return block;
}

// ---------------------------------------------------------------------------
// AST → Tiptap
// ---------------------------------------------------------------------------

/** Project one Alter document into a Tiptap/ProseMirror JSON document. */
export function astToTiptap(doc: AlterDoc): JSONContent {
  return { type: 'doc', content: doc.blocks.map(blockToTiptap) };
}

/** Project one Alter block (and its subtree) into Tiptap JSON. */
export function blockToTiptap(block: BlockNode): JSONContent {
  switch (block.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        attrs: attrsOf(block),
        content: inlineToTiptap(block.content),
      };
    case 'heading': {
      const level = Math.min(6, Math.max(1, Math.trunc(asNumber(block.attrs.level) ?? 1)));
      return {
        type: 'heading',
        attrs: attrsOf(block, { level }),
        content: inlineToTiptap(block.content),
      };
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listToTiptap(block);
    case 'listItem':
      // Defensive: a list item outside a list becomes a plain paragraph.
      return {
        type: 'paragraph',
        attrs: attrsOf(block),
        content: inlineToTiptap(
          (block.children ?? []).flatMap((child) => child.content ?? []),
        ),
      };
    case 'blockquote':
      return {
        type: 'blockquote',
        attrs: attrsOf(block),
        content: ensureBlocks(block.children),
      };
    case 'codeBlock': {
      const language = asString(block.attrs.lang, MAX_LANG);
      const text = plainTextOf(block.content);
      const node: JSONContent = {
        type: 'codeBlock',
        attrs: attrsOf(block, { language }),
      };
      if (text !== '') node.content = [{ type: 'text', text }];
      return node;
    }
    case 'divider':
      return { type: 'horizontalRule', attrs: attrsOf(block) };
    case 'table':
      return tableToTiptap(block);
    case 'tableRow':
    case 'tableCell':
    case 'tableHeader':
      return orphanTablePartToTiptap(block);
    case 'image': {
      const assetId = asString(block.attrs.assetId, 200);
      if (assetId === undefined) {
        return placeholderParagraph(block, '[图片：缺少资产 id]');
      }
      return {
        type: 'alterImage',
        attrs: attrsOf(block, {
          assetId,
          alt: asString(block.attrs.alt, MAX_ALT),
          caption: asString(block.attrs.caption, MAX_CAPTION),
          width: asString(block.attrs.width, MAX_WIDTH),
        }),
      };
    }
    case 'bookmark': {
      const url = asString(block.attrs.url, MAX_URL);
      if (url === undefined) {
        return placeholderParagraph(block, '[网页链接卡：缺少链接]');
      }
      return {
        type: 'alterBookmark',
        attrs: attrsOf(block, {
          url,
          title: asString(block.attrs.title, MAX_TITLE),
          description: asString(block.attrs.description, MAX_CAPTION),
          icon: asString(block.attrs.icon, MAX_ICON),
        }),
      };
    }
    case 'docLink': {
      const docId = asString(block.attrs.docId, MAX_DOC_ID);
      if (docId === undefined) {
        return placeholderParagraph(block, '[文档内链卡：缺少文档 id]');
      }
      return {
        type: 'alterDocLink',
        attrs: attrsOf(block, {
          docId,
          title: asString(block.attrs.title, MAX_TITLE),
        }),
      };
    }
    case 'callout': {
      const toneRaw = asString(block.attrs.tone, 16);
      const tone = CALL_TONES.includes(toneRaw as (typeof CALL_TONES)[number])
        ? toneRaw
        : 'info';
      return {
        type: 'alterCallout',
        attrs: attrsOf(block, {
          tone,
          title: asString(block.attrs.title, MAX_TITLE),
          icon: asString(block.attrs.icon, MAX_ICON),
          collapsed: asBoolean(block.attrs.collapsed),
        }),
        content: ensureBlocks(block.children),
      };
    }
    case 'mindmap': {
      const objectId = asString(block.attrs.objectId, 200);
      if (objectId === undefined) {
        return placeholderParagraph(block, '[思维导图：缺少对象 id]');
      }
      return {
        type: 'alterMindmap',
        attrs: attrsOf(block, {
          objectId,
          caption: asString(block.attrs.caption, MAX_CAPTION),
        }),
      };
    }
    case 'component': {
      const objectId = asString(block.attrs.objectId, 200);
      if (objectId === undefined) {
        return placeholderParagraph(block, '[交互组件：缺少对象 id]');
      }
      return {
        type: 'alterComponent',
        attrs: attrsOf(block, {
          objectId,
          title: asString(block.attrs.title, MAX_TITLE),
          description: asString(block.attrs.description, MAX_CAPTION),
        }),
      };
    }
    default:
      return placeholderParagraph(block, `[unsupported node: ${block.type}]`);
  }
}

/** Container children, with a wrapper paragraph when the list is empty. */
function ensureBlocks(children: BlockNode[] | undefined): JSONContent[] {
  const blocks = (children ?? []).map(blockToTiptap);
  return blocks.length > 0 ? blocks : [emptyParagraph()];
}

/** A wrapper list item with no id, dropped again by `tiptapToBlocks`. */
function emptyListItem(isTask: boolean): JSONContent {
  return {
    type: isTask ? 'taskItem' : 'listItem',
    content: [emptyParagraph()],
  };
}

function listItemToTiptap(item: BlockNode, isTask: boolean): JSONContent {
  const children = (item.children ?? []).map(blockToTiptap);
  if (children.length === 0 || children[0]!.type !== 'paragraph') {
    children.unshift(emptyParagraph());
  }
  if (isTask) {
    const checked = asBoolean(item.attrs.checked) ?? false;
    return {
      type: 'taskItem',
      attrs: attrsOf(item, { checked }),
      content: children,
    };
  }
  return { type: 'listItem', attrs: attrsOf(item), content: children };
}

function listToTiptap(block: BlockNode): JSONContent {
  const isTask = block.type === 'taskList';
  const items = (block.children ?? []).map((child) =>
    child.type === 'listItem'
      ? listItemToTiptap(child, isTask)
      : blockToTiptap(child),
  );
  const content = items.length > 0 ? items : [emptyListItem(isTask)];
  if (isTask) return { type: 'taskList', attrs: attrsOf(block), content };
  if (block.type === 'orderedList') {
    const start = asNumber(block.attrs.start);
    return {
      type: 'orderedList',
      attrs: attrsOf(block, { start }),
      content,
    };
  }
  return { type: 'bulletList', attrs: attrsOf(block), content };
}

function tableCellToTiptap(cell: BlockNode, header: boolean): JSONContent {
  return {
    type: header ? 'tableHeader' : 'tableCell',
    attrs: attrsOf(cell),
    content: [{ type: 'paragraph', content: inlineToTiptap(cell.content) }],
  };
}

function tableToTiptap(block: BlockNode): JSONContent {
  const rows = (block.children ?? []).filter((row) => row.type === 'tableRow');
  if (rows.length === 0) {
    // ProseMirror tables require at least one row; degrade to a placeholder.
    return placeholderParagraph(block, '[空表格]');
  }
  const rawHeaderRows = asNumber(block.attrs.headerRows) ?? 1;
  const headerRows = Math.max(
    0,
    Math.min(rows.length, Math.trunc(rawHeaderRows)),
  );
  const content = rows.map((row, rowIndex) => {
    const header = rowIndex < headerRows;
    const cells = (row.children ?? []).filter(
      (cell) => cell.type === 'tableCell' || cell.type === 'tableHeader',
    );
    return {
      type: 'tableRow',
      attrs: attrsOf(row),
      content:
        cells.length > 0
          ? cells.map((cell) => tableCellToTiptap(cell, header))
          : [
              {
                type: header ? 'tableHeader' : 'tableCell',
                content: [emptyParagraph()],
              },
            ],
    };
  });
  return { type: 'table', attrs: attrsOf(block), content };
}

/** Degraded projection for orphan `tableRow`/`tableCell` AST blocks. */
function orphanTablePartToTiptap(block: BlockNode): JSONContent {
  if (block.type === 'tableRow') {
    return {
      type: 'tableRow',
      attrs: attrsOf(block),
      content: [{ type: 'tableCell', content: [emptyParagraph()] }],
    };
  }
  return {
    type: 'tableCell',
    attrs: attrsOf(block),
    content: [{ type: 'paragraph', content: inlineToTiptap(block.content) }],
  };
}

// ---------------------------------------------------------------------------
// Tiptap → AST
// ---------------------------------------------------------------------------

/**
 * Convert Tiptap JSON content back into Alter blocks.
 *
 * Wrapper paragraphs/list items without a `blockId` are dropped, duplicate ids
 * are re-issued and unknown nodes degrade instead of throwing.
 */
export function tiptapToBlocks(content: JSONContent): BlockNode[] {
  return collectBlocksWith(content.content, new Set<string>());
}

function collectBlocksWith(
  content: JSONContent['content'] | undefined,
  used: Set<string>,
): BlockNode[] {
  const blocks: BlockNode[] = [];
  for (const node of content ?? []) {
    const block = tiptapNodeToBlock(node, used);
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

function tiptapNodeToBlock(
  node: JSONContent,
  used: Set<string>,
): BlockNode | undefined {
  switch (node.type) {
    case undefined:
      return undefined;
    case 'paragraph': {
      const content = tiptapToInline(node.content);
      // Wrapper paragraphs (schema filler) never become AST blocks.
      if (content.length === 0 && !hasRawBlockId(node)) return undefined;
      return makeBlock(node, { type: 'paragraph', content }, used);
    }
    case 'heading': {
      const level = Math.min(
        6,
        Math.max(1, Math.trunc(asNumber(node.attrs?.['level']) ?? 1)),
      );
      return makeBlock(
        node,
        { type: 'heading', attrs: { level }, content: tiptapToInline(node.content) },
        used,
      );
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return tiptapToBlockList(node, used);
    case 'listItem':
    case 'taskItem':
      return tiptapToListItem(node, node.type === 'taskItem', used);
    case 'blockquote': {
      const children = collectBlocksWith(node.content, used);
      return makeBlock(node, { type: 'blockquote', children }, used);
    }
    case 'codeBlock': {
      const text = tiptapPlainText(node.content);
      const language = asString(node.attrs?.['language'], MAX_LANG);
      return makeBlock(
        node,
        {
          type: 'codeBlock',
          attrs: language === undefined ? {} : { lang: language },
          content: text === '' ? [] : [{ type: 'text', text }],
        },
        used,
      );
    }
    case 'horizontalRule':
      return makeBlock(node, { type: 'divider' }, used);
    case 'table':
      return tiptapToBlockTable(node, used);
    case 'tableRow': {
      const cells = (node.content ?? [])
        .filter(
          (cell) => cell.type === 'tableCell' || cell.type === 'tableHeader',
        )
        .map((cell) => tiptapToTableCell(cell, used));
      return makeBlock(node, { type: 'tableRow', children: cells }, used);
    }
    case 'tableCell':
    case 'tableHeader':
      return tiptapToTableCell(node, used);
    case 'alterCallout':
      return tiptapToBlockCallout(node, used);
    case 'alterImage':
      return tiptapToBlockImage(node, used);
    case 'alterMindmap':
    case 'alterComponent':
      return tiptapToBlockObject(node, used);
    case 'alterBookmark':
      return tiptapToBlockBookmark(node, used);
    case 'alterDocLink':
      return tiptapToBlockDocLink(node, used);
    default:
      return degradedNodeToBlock(node, used);
  }
}

function tiptapToBlockList(node: JSONContent, used: Set<string>): BlockNode {
  const isTask = node.type === 'taskList';
  const children: BlockNode[] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'listItem' || child.type === 'taskItem') {
      const item = tiptapToListItem(child, isTask || child.type === 'taskItem', used);
      if (item !== undefined) children.push(item);
      continue;
    }
    const block = tiptapNodeToBlock(child, used);
    if (block !== undefined) children.push(block);
  }
  if (isTask) return makeBlock(node, { type: 'taskList', children }, used);
  if (node.type === 'orderedList') {
    const start = asNumber(node.attrs?.['start']);
    return makeBlock(
      node,
      {
        type: 'orderedList',
        attrs: start !== undefined && start !== 1 ? { start } : {},
        children,
      },
      used,
    );
  }
  return makeBlock(node, { type: 'bulletList', children }, used);
}

function tiptapToListItem(
  node: JSONContent,
  isTask: boolean,
  used: Set<string>,
): BlockNode | undefined {
  const children = collectBlocksWith(node.content, used);
  // Wrapper list items (schema filler for empty lists) are dropped again.
  if (children.length === 0 && !hasRawBlockId(node)) return undefined;
  if (isTask) {
    const checked =
      typeof node.attrs?.['checked'] === 'boolean'
        ? (node.attrs['checked'] as boolean)
        : false;
    return makeBlock(
      node,
      { type: 'listItem', attrs: { checked }, children },
      used,
    );
  }
  return makeBlock(node, { type: 'listItem', children }, used);
}

function tiptapToBlockCallout(node: JSONContent, used: Set<string>): BlockNode {
  const toneRaw = node.attrs?.['tone'];
  const tone = CALL_TONES.includes(toneRaw as (typeof CALL_TONES)[number])
    ? (toneRaw as (typeof CALL_TONES)[number])
    : 'info';
  const attrs: BlockNode['attrs'] = { tone };
  const title = asString(node.attrs?.['title'], MAX_TITLE);
  if (title !== undefined) attrs.title = title;
  const icon = asString(node.attrs?.['icon'], MAX_ICON);
  if (icon !== undefined) attrs.icon = icon;
  const collapsed = asBoolean(node.attrs?.['collapsed']);
  if (collapsed !== undefined) attrs.collapsed = collapsed;
  return makeBlock(
    node,
    { type: 'callout', attrs, children: collectBlocksWith(node.content, used) },
    used,
  );
}

function tiptapToBlockImage(node: JSONContent, used: Set<string>): BlockNode {
  const assetId = asString(node.attrs?.['assetId'], 200);
  if (assetId === undefined) {
    return makeBlock(
      node,
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '[图片：缺少资产 id]' }],
      },
      used,
    );
  }
  const attrs: BlockNode['attrs'] = { assetId };
  const alt = asString(node.attrs?.['alt'], MAX_ALT);
  if (alt !== undefined) attrs.alt = alt;
  const caption = asString(node.attrs?.['caption'], MAX_CAPTION);
  if (caption !== undefined) attrs.caption = caption;
  const width = asString(node.attrs?.['width'], MAX_WIDTH);
  if (width !== undefined) attrs.width = width;
  return makeBlock(node, { type: 'image', attrs }, used);
}

function tiptapToBlockObject(
  node: JSONContent,
  used: Set<string>,
): BlockNode {
  const kind = node.type === 'alterMindmap' ? 'mindmap' : 'component';
  const objectId = asString(node.attrs?.['objectId'], 200);
  const label = kind === 'mindmap' ? '思维导图' : '交互组件';
  if (objectId === undefined) {
    return makeBlock(
      node,
      {
        type: 'paragraph',
        content: [{ type: 'text', text: `[${label}：缺少对象 id]` }],
      },
      used,
    );
  }
  const attrs: BlockNode['attrs'] = { objectId };
  if (kind === 'mindmap') {
    const caption = asString(node.attrs?.['caption'], MAX_CAPTION);
    if (caption !== undefined) attrs.caption = caption;
  } else {
    const title = asString(node.attrs?.['title'], MAX_TITLE);
    if (title !== undefined) attrs.title = title;
    const description = asString(node.attrs?.['description'], MAX_CAPTION);
    if (description !== undefined) attrs.description = description;
  }
  return makeBlock(node, { type: kind, attrs }, used);
}

function tiptapToBlockBookmark(node: JSONContent, used: Set<string>): BlockNode {
  const url = asString(node.attrs?.['url'], MAX_URL);
  if (url === undefined) {
    return makeBlock(
      node,
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '[网页链接卡：缺少链接]' }],
      },
      used,
    );
  }
  const attrs: BlockNode['attrs'] = { url };
  const title = asString(node.attrs?.['title'], MAX_TITLE);
  if (title !== undefined) attrs.title = title;
  const description = asString(node.attrs?.['description'], MAX_CAPTION);
  if (description !== undefined) attrs.description = description;
  const icon = asString(node.attrs?.['icon'], MAX_ICON);
  if (icon !== undefined) attrs.icon = icon;
  return makeBlock(node, { type: 'bookmark', attrs }, used);
}

function tiptapToBlockDocLink(node: JSONContent, used: Set<string>): BlockNode {
  const docId = asString(node.attrs?.['docId'], MAX_DOC_ID);
  if (docId === undefined) {
    return makeBlock(
      node,
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '[文档内链卡：缺少文档 id]' }],
      },
      used,
    );
  }
  const attrs: BlockNode['attrs'] = { docId };
  const title = asString(node.attrs?.['title'], MAX_TITLE);
  if (title !== undefined) attrs.title = title;
  return makeBlock(node, { type: 'docLink', attrs }, used);
}

function tiptapToBlockTable(node: JSONContent, used: Set<string>): BlockNode {
  const children: BlockNode[] = [];
  let headerRows = 0;
  let headerPhase = true;
  for (const rowNode of node.content ?? []) {
    if (rowNode.type !== 'tableRow') continue;
    const cells = (rowNode.content ?? []).filter(
      (cell) => cell.type === 'tableCell' || cell.type === 'tableHeader',
    );
    const isHeaderRow =
      cells.length > 0 && cells.every((cell) => cell.type === 'tableHeader');
    if (headerPhase && isHeaderRow) headerRows += 1;
    else headerPhase = false;
    const rowCells = cells.map((cell) => tiptapToTableCell(cell, used));
    children.push(
      makeBlock(rowNode, { type: 'tableRow', children: rowCells }, used),
    );
  }
  return makeBlock(node, { type: 'table', attrs: { headerRows }, children }, used);
}

function tiptapToTableCell(cell: JSONContent, used: Set<string>): BlockNode {
  return makeBlock(
    cell,
    { type: 'tableCell', content: cellParagraphsToInline(cell.content) },
    used,
  );
}

/** Join a table cell's paragraphs into one inline run (breaks between them). */
function cellParagraphsToInline(
  content: JSONContent['content'] | undefined,
): InlineNode[] {
  const parts: InlineNode[] = [];
  for (const child of content ?? []) {
    if (child.type !== 'paragraph') continue;
    const inline = tiptapToInline(child.content);
    if (inline.length === 0) continue;
    if (parts.length > 0) parts.push({ type: 'hardBreak' });
    parts.push(...inline);
  }
  return canonicalInline(parts);
}

/** Recursively collect text nodes of a code block / unknown node. */
function tiptapPlainText(content: JSONContent['content'] | undefined): string {
  let text = '';
  for (const node of content ?? []) {
    if (node.type === 'text') text += typeof node.text === 'string' ? node.text : '';
    else if (node.type === 'hardBreak') text += '\n';
    else text += tiptapPlainText(node.content);
  }
  return text;
}

/** Unknown nodes degrade to a paragraph so text is not lost, or are skipped. */
function degradedNodeToBlock(
  node: JSONContent,
  used: Set<string>,
): BlockNode | undefined {
  const content = tiptapToInline(node.content);
  if (content.length === 0) return undefined;
  if (hasRawBlockId(node)) {
    return makeBlock(node, { type: 'paragraph', content }, used);
  }
  return makeBlock(
    node,
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: `[unsupported node: ${node.type ?? 'unknown'}] `,
        },
        ...content,
      ],
    },
    used,
  );
}
