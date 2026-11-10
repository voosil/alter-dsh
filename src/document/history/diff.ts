/**
 * Client-side block-level diff for version history previews.
 *
 * The old HTML history panel diffed rendered HTML with an LCS. AST documents
 * have stable top-level block ids, so the diff is cheaper and more precise:
 * compare top-level blocks by id and report added / removed / modified / moved
 * entries. Modified entries carry the changed attribute names and short text
 * excerpts so the narrow side panel can show a readable preview without
 * rendering the whole document.
 *
 * The engine is pure (no React, no DOM) and bounded: counts are computed for
 * the whole document, but at most `maxEntries` entries are materialized so a
 * huge version gap cannot freeze the panel.
 *
 * @module @alter-dsh/space/document/history/diff
 */
import type { AlterDoc, BlockNode, InlineNode } from '../types';
import { blocksEqual, deepEqualJson } from '../editor/canonical';

/** Default cap of materialized diff entries shown in the panel. */
export const MAX_DIFF_ENTRIES = 100;

/** Default character cap for one block's text excerpt. */
export const DIFF_TEXT_MAX_CHARS = 120;

/** An empty AST used as the base when diffing the oldest snapshot. */
export const EMPTY_ALTER_DOC: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 0,
  blocks: [],
};

/** One kind of block-level change. */
export type BlockDiffKind = 'added' | 'removed' | 'modified' | 'moved';

/** Display labels for diff kinds. */
export const BLOCK_DIFF_KIND_LABELS: Readonly<Record<BlockDiffKind, string>> = {
  added: '新增',
  removed: '删除',
  modified: '修改',
  moved: '移动',
};

/** One changed top-level block. */
export interface BlockDiffEntry {
  kind: BlockDiffKind;
  blockId: string;
  /** Target block type (the removed block's type for removals). */
  type: string;
  /** Human-readable type label, e.g. 「标题 H2」/「正文」. */
  typeLabel: string;
  /** Previous type when the block was transformed. */
  previousType?: string;
  /** `attrs.title/description/caption/alt` excerpt, when present. */
  title?: string;
  /** Target text excerpt (removed: previous text). */
  text?: string;
  /** Previous text excerpt for modified/moved blocks. */
  previousText?: string;
  /** Attribute names that changed on a modified block. */
  changedAttrs?: string[];
  /** 1-based position in the target version (removals: previous version). */
  index: number;
}

/** Summary + bounded entries of one version-to-version diff. */
export interface BlockDiff {
  /** Number of top-level blocks in the base document. */
  baseBlocks: number;
  /** Number of top-level blocks in the target document. */
  targetBlocks: number;
  added: number;
  removed: number;
  modified: number;
  moved: number;
  /** Total changed entries before truncation. */
  total: number;
  /** Materialized entries (at most `maxEntries`). */
  entries: BlockDiffEntry[];
  truncated: boolean;
  maxEntries: number;
}

/** Chinese labels for the common block types (fallback: raw type name). */
const BLOCK_TYPE_LABELS: Readonly<Record<string, string>> = {
  paragraph: '正文',
  heading: '标题',
  bulletList: '无序列表',
  orderedList: '有序列表',
  taskList: '待办列表',
  listItem: '列表项',
  blockquote: '引用',
  codeBlock: '代码块',
  divider: '分割线',
  table: '表格',
  tableRow: '表格行',
  tableCell: '单元格',
  image: '图片',
  bookmark: '网页链接卡',
  docLink: '文档内链卡',
  callout: '高亮块',
  mindmap: '思维导图',
  component: '交互组件',
};

/** Attribute display labels used by the diff entries. */
const ATTR_LABELS: Readonly<Record<string, string>> = {
  level: '层级',
  checked: '勾选',
  title: '标题',
  description: '描述',
  caption: '说明',
  alt: '替代文本',
  lang: '语言',
  url: '链接',
  docId: '文档',
  assetId: '资产',
  start: '起始序号',
  headerRows: '表头行数',
  tone: '语气',
  icon: '图标',
  collapsed: '折叠',
  width: '宽度',
  objectId: '对象',
};

/** Display label of one attribute key. */
export function attrLabel(key: string): string {
  return ATTR_LABELS[key] ?? key;
}

/** Display label of a raw block type name (fallback: the type name itself). */
export function blockTypeName(type: string): string {
  return BLOCK_TYPE_LABELS[type] ?? type;
}

/** Display label of one block type (heading keeps its level). */
export function blockTypeLabel(block: BlockNode): string {
  const base = blockTypeName(block.type);
  if (block.type === 'heading') {
    const level = block.attrs?.['level'];
    if (typeof level === 'number') return `标题 H${level}`;
  }
  return base;
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

/** Plain text of one block, including nested children. */
export function blockText(block: BlockNode): string {
  const parts: string[] = [];
  const pushInline = (content: InlineNode[] | undefined): void => {
    for (const node of content ?? []) {
      if (node.type === 'text' && node.text !== '') parts.push(node.text);
    }
  };
  pushInline(block.content);
  for (const child of block.children ?? []) {
    const text = blockText(child);
    if (text !== '') parts.push(text);
  }
  return parts.join(' ').trim();
}

/** `attrs.title/description/caption/alt` of one block, when present. */
export function blockTitle(block: BlockNode): string | undefined {
  for (const key of ['title', 'description', 'caption', 'alt']) {
    const value = block.attrs?.[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return truncateText(value, DIFF_TEXT_MAX_CHARS);
    }
  }
  return undefined;
}

/** Short text excerpt of one block (falls back to its title attrs). */
export function blockExcerpt(
  block: BlockNode,
  maxChars = DIFF_TEXT_MAX_CHARS,
): string {
  const text = blockText(block);
  if (text !== '') return truncateText(text, maxChars);
  const title = blockTitle(block);
  return title === undefined ? '' : truncateText(title, maxChars);
}

/** Attribute keys whose values differ between two blocks. */
export function changedAttrs(
  base: BlockNode,
  target: BlockNode,
): string[] {
  const keys = new Set([
    ...Object.keys(base.attrs ?? {}),
    ...Object.keys(target.attrs ?? {}),
  ]);
  const changed: string[] = [];
  for (const key of keys) {
    if (deepEqualJson(base.attrs?.[key] ?? null, target.attrs?.[key] ?? null)) {
      continue;
    }
    changed.push(key);
  }
  return changed;
}

/** Whether two AST documents are structurally identical (revision ignored). */
export function documentsEquivalent(
  left: AlterDoc,
  right: AlterDoc,
): boolean {
  if (left.blocks.length !== right.blocks.length) return false;
  return left.blocks.every((block, index) =>
    blocksEqual(block, right.blocks[index]!),
  );
}

function entryFor(
  kind: BlockDiffKind,
  block: BlockNode,
  index: number,
): BlockDiffEntry {
  const title = blockTitle(block);
  return {
    kind,
    blockId: block.id,
    type: block.type,
    typeLabel: blockTypeLabel(block),
    ...(title === undefined ? {} : { title }),
    text: blockExcerpt(block),
    index: index + 1,
  };
}

/**
 * Diff two AST documents at the top level.
 *
 * @param base - older snapshot (use {@link EMPTY_ALTER_DOC} for the oldest one).
 * @param target - snapshot being previewed.
 * @param options.maxEntries - cap of materialized entries (default 100).
 */
export function diffAlterDocs(
  base: AlterDoc,
  target: AlterDoc,
  options: { maxEntries?: number } = {},
): BlockDiff {
  const maxEntries = Math.max(1, options.maxEntries ?? MAX_DIFF_ENTRIES);
  const baseIndexById = new Map<string, number>();
  base.blocks.forEach((block, index) => {
    if (!baseIndexById.has(block.id)) baseIndexById.set(block.id, index);
  });
  const targetIds = new Set(target.blocks.map((block) => block.id));

  const entries: BlockDiffEntry[] = [];
  let total = 0;
  let added = 0;
  let modified = 0;
  let moved = 0;

  const push = (entry: BlockDiffEntry): void => {
    total += 1;
    if (entries.length < maxEntries) entries.push(entry);
  };

  target.blocks.forEach((block, index) => {
    const baseIndex = baseIndexById.get(block.id);
    if (baseIndex === undefined) {
      added += 1;
      push(entryFor('added', block, index));
      return;
    }
    const baseBlock = base.blocks[baseIndex]!;
    if (!blocksEqual(baseBlock, block)) {
      modified += 1;
      const changed = changedAttrs(baseBlock, block);
      push({
        ...entryFor('modified', block, index),
        ...(baseBlock.type === block.type
          ? {}
          : { previousType: baseBlock.type }),
        previousText: blockExcerpt(baseBlock),
        ...(changed.length === 0 ? {} : { changedAttrs: changed }),
      });
      return;
    }
    if (baseIndex !== index) {
      moved += 1;
      push({
        ...entryFor('moved', block, index),
        previousText: blockExcerpt(baseBlock),
      });
    }
  });

  let removed = 0;
  base.blocks.forEach((block, index) => {
    if (targetIds.has(block.id)) return;
    removed += 1;
    push(entryFor('removed', block, index));
  });

  return {
    baseBlocks: base.blocks.length,
    targetBlocks: target.blocks.length,
    added,
    removed,
    modified,
    moved,
    total,
    entries,
    truncated: total > maxEntries,
    maxEntries,
  };
}
