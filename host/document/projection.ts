/**
 * Markdown projection of the Alter document AST.
 *
 * The projection is a read-only view (spec "Markdown 投影规范"): the block
 * tree stays authoritative and the Markdown string is what Agent tools and
 * exports consume. Top-level blocks are the裁剪 unit; each included top-level
 * block is preceded by an HTML comment anchor so later operations can target
 * exact blocks. Unknown node types degrade to a visible `opaque` directive
 * instead of being dropped.
 *
 * @module @alter-dsh/space/document/projection
 */
import { getNodeType, plainTextOfInline } from './schema.js';
import type {
  AlterDoc,
  BlockNode,
  InlineNode,
  JsonValue,
  Mark,
  MarkType,
} from './types.js';

/** Default character budget for one projection (spec tools contract: 12k). */
export const DEFAULT_PROJECTION_MAX_CHARS = 12_000;

/** Options accepted by {@link projectDocument}. */
export interface ProjectionOptions {
  /** Only project these top-level block ids (document order is preserved). */
  blockIds?: readonly string[];
  /** Start after this top-level block id (exclusive). */
  after?: string;
  /** Maximum number of top-level blocks to include. */
  limit?: number;
  /** Character budget of the returned Markdown; defaults to 12 000. */
  maxChars?: number;
  /** Emit `<!-- blk:<id> -->` before every included top-level block. */
  anchors?: boolean;
}

/** One top-level block referenced by the projection. */
export interface ProjectedBlockRef {
  id: string;
  type: string;
}

/** Result of {@link projectDocument}. */
export interface ProjectionResult {
  markdown: string;
  includedBlocks: ProjectedBlockRef[];
  truncated: boolean;
}

/** Marks in their canonical outermost-to-innermost wrapper order. */
const MARK_ORDER: readonly MarkType[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'highlight',
  'link',
];

/** Innermost-to-outermost order used when nesting inline marks. */
const MARK_WRAP_ORDER: readonly MarkType[] = [
  'code',
  'underline',
  'highlight',
  'strike',
  'italic',
  'bold',
  'link',
];

const LINE_START_SPECIAL = new Set(['#', '-', '+', '>', ':']);
const ALWAYS_ESCAPE = new Set([
  '\\',
  '`',
  '*',
  '_',
  '~',
  '[',
  ']',
  '<',
  '>',
]);

/** Escape characters that would otherwise start inline Markdown syntax. */
function escapeInlineText(text: string, options: { tableCell?: boolean } = {}): string {
  const lines = text.split('\n');
  return lines.map((line) => escapeLine(line, options)).join('\n');
}

function escapeLine(line: string, options: { tableCell?: boolean }): string {
  let escaped = '';
  for (const char of line) {
    if (ALWAYS_ESCAPE.has(char)) escaped += `\\${char}`;
    else if (options.tableCell === true && char === '|') escaped += '\\|';
    else escaped += char;
  }
  if (escaped === '') return escaped;
  const first = escaped[0]!;
  if (LINE_START_SPECIAL.has(first)) return `\\${escaped}`;
  if (/^\d/.test(escaped)) {
    // `1.` / `1)` at line start would be an ordered-list marker.
    const marker = /^(\d+)([.)])/.exec(escaped);
    if (marker !== null) return `${marker[1]}\\${marker[2]}${escaped.slice(marker[0].length)}`;
  }
  return escaped;
}

/** Escape one directive / image attribute value. */
function escapeAttrValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '');
}

/** [alt] text of an image (brackets and backslashes are special). */
function escapeAltText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('\n', ' ');
}

/** Render one code span, choosing a backtick fence longer than any run inside. */
function renderCodeSpan(text: string): string {
  let fence = '`';
  while (text.includes(fence)) fence += '`';
  const needsPadding =
    text.startsWith(' ') ||
    text.endsWith(' ') ||
    text.startsWith('`') ||
    text.endsWith('`');
  if (text === '') return '``';
  return needsPadding ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** Sort marks into the canonical order and drop duplicates by kind. */
function canonicalMarks(marks: readonly Mark[] | undefined): Mark[] {
  if (marks === undefined || marks.length === 0) return [];
  const byType = new Map<MarkType, Mark>();
  for (const mark of marks) {
    if (!byType.has(mark.type)) byType.set(mark.type, mark);
  }
  return [...byType.values()].sort(
    (left, right) => MARK_ORDER.indexOf(left.type) - MARK_ORDER.indexOf(right.type),
  );
}

/** Escape one Markdown link destination (angle-bracket form when needed). */
function renderLinkDestination(href: string): string {
  return /[\s()]/.test(href)
    ? `<${href.replaceAll('\\', '\\\\').replaceAll('>', '\\>')}>`
    : href.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

/** Escape one Markdown link label; line breaks collapse to spaces. */
function renderLinkLabel(value: string): string {
  return escapeInlineText(value.replaceAll(/\r?\n/g, ' '));
}

function wrapMark(mark: Mark, body: string): string {
  switch (mark.type) {
    case 'code':
      return renderCodeSpan(body);
    case 'bold':
      return `**${body}**`;
    case 'italic':
      return `*${body}*`;
    case 'underline':
      return `<u>${body}</u>`;
    case 'strike':
      return `~~${body}~~`;
    case 'highlight':
      return `==${body}==`;
    case 'link': {
      const href = mark.attrs?.href ?? '';
      if (href === '') return body;
      return `[${body}](${renderLinkDestination(href)})`;
    }
    default:
      // Future mark kinds: keep the text visible and flag it instead of
      // silently dropping formatting the projection cannot express.
      return `[unsupported mark: ${String((mark as { type?: unknown }).type)}]${body}`;
  }
}

function renderTextNode(node: InlineNode & { type: 'text' }, tableCell: boolean): string {
  const marks = canonicalMarks(node.marks);
  const hasCode = marks.some((mark) => mark.type === 'code');
  let body = hasCode ? node.text : escapeInlineText(node.text, { tableCell });
  for (const type of MARK_WRAP_ORDER) {
    const mark = marks.find((item) => item.type === type);
    if (mark === undefined) continue;
    if (type === 'code') {
      body = renderCodeSpan(node.text);
      continue;
    }
    body = wrapMark(mark, body);
  }
  return body;
}

/**
 * Render inline content as Markdown.
 *
 * Hard breaks become newlines; marks are wrapped in a fixed order so the
 * output is deterministic.
 */
export function inlineToMarkdown(
  content: readonly InlineNode[] | undefined,
  options: { tableCell?: boolean } = {},
): string {
  if (content === undefined) return '';
  const tableCell = options.tableCell === true;
  let output = '';
  for (const node of content) {
    if (node.type === 'text') {
      output += renderTextNode(node, tableCell);
    } else if (node.type === 'hardBreak') {
      output += tableCell ? '<br>' : '\n';
    } else {
      output += '[unsupported inline]';
    }
  }
  return output;
}

/** Project a list of sibling blocks, separated by one blank line. */
function projectBlocks(blocks: readonly BlockNode[] | undefined): string {
  if (blocks === undefined || blocks.length === 0) return '';
  return blocks
    .map((block) => projectBlock(block))
    .filter((markdown) => markdown !== '')
    .join('\n\n');
}

function repeatIndent(level: number): string {
  return ' '.repeat(Math.max(0, level));
}

/** Render a list block (bullet/ordered/task) into Markdown lines. */
function renderListLines(block: BlockNode, indent: number): string[] {
  const listKind =
    block.type === 'orderedList' ? 'ordered' : block.type === 'taskList' ? 'task' : 'bullet';
  const start =
    listKind === 'ordered' && typeof block.attrs.start === 'number'
      ? Math.trunc(block.attrs.start)
      : 1;
  const children = block.children ?? [];
  const lines: string[] = [];
  const itemIndent = repeatIndent(indent);
  const contentIndent = repeatIndent(indent + 2);
  children.forEach((item, index) => {
    if (item.type !== 'listItem') {
      // Defensive: a list only allows list items, but never drop content.
      const rendered = projectBlock(item);
      if (rendered !== '') {
        for (const line of rendered.split('\n')) {
          lines.push(line === '' ? '' : contentIndent + line);
        }
      }
      return;
    }
    let marker: string;
    if (listKind === 'task') {
      marker = item.attrs.checked === true ? '- [x] ' : '- [ ] ';
    } else if (listKind === 'ordered') {
      marker = `${start + index}. `;
    } else {
      marker = '- ';
    }
    const itemChildren = item.children ?? [];
    const first = itemChildren[0];
    let nested: readonly BlockNode[];
    if (first !== undefined && first.type === 'paragraph') {
      const text = inlineToMarkdown(first.content);
      const textLines = text.split('\n');
      if (text === '') {
        lines.push(itemIndent + marker.trimEnd());
      } else {
        lines.push(itemIndent + marker + textLines[0]!);
        for (const extra of textLines.slice(1)) {
          lines.push(extra === '' ? '' : contentIndent + extra);
        }
      }
      nested = itemChildren.slice(1);
    } else {
      lines.push(itemIndent + marker.trimEnd());
      nested = itemChildren;
    }
    for (const child of nested) {
      if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
        lines.push(...renderListLines(child, indent + 2));
        continue;
      }
      const rendered = projectBlock(child);
      if (rendered === '') continue;
      for (const line of rendered.split('\n')) {
        lines.push(line === '' ? '' : contentIndent + line);
      }
    }
  });
  return lines;
}

function renderBlockquote(block: BlockNode): string {
  const inner = projectBlocks(block.children);
  if (inner === '') return '>';
  return inner
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** Escape table-cell pipes while leaving already escaped ones alone. */
function escapeCellPipes(text: string): string {
  let escaped = '';
  let backslashes = 0;
  for (const char of text) {
    if (char === '\\') {
      backslashes += 1;
      escaped += char;
      continue;
    }
    if (char === '|' && backslashes % 2 === 0) escaped += '\\|';
    else escaped += char;
    backslashes = 0;
  }
  return escaped;
}

/** Project one table cell's inline content (newlines become `<br>`). */
function renderTableCell(cell: BlockNode): string {
  if (cell.type !== 'tableCell') {
    return projectBlock(cell).replaceAll('\n', ' ');
  }
  const text = inlineToMarkdown(cell.content);
  return escapeCellPipes(text).replaceAll('\n', '<br>');
}

function renderTable(block: BlockNode): string {
  const rows = (block.children ?? []).filter((row) => row.type === 'tableRow');
  if (rows.length === 0) return '';
  const grid = rows.map((row) =>
    (row.children ?? []).filter((cell) => cell.type === 'tableCell').map(renderTableCell),
  );
  const columns = grid.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) return '';
  const pad = (cells: readonly string[]): string[] => [
    ...cells,
    ...Array.from({ length: Math.max(0, columns - cells.length) }, () => ''),
  ];
  const rawHeaderRows =
    typeof block.attrs.headerRows === 'number' ? block.attrs.headerRows : 1;
  const headerRows = Number.isFinite(rawHeaderRows)
    ? Math.min(grid.length, Math.max(0, Math.trunc(rawHeaderRows)))
    : 1;
  const header = headerRows > 0 ? pad(grid[0]!) : Array.from({ length: columns }, () => '');
  const bodyRows = headerRows > 0 ? grid.slice(1) : grid;
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
  ];
  for (const row of bodyRows) lines.push(`| ${pad(row).join(' | ')} |`);
  return lines.join('\n');
}

/** Text stored inside a codeBlock; schema keeps it in `attrs.code` or `content`. */
function codeTextOf(block: BlockNode): string {
  if (block.content !== undefined) return plainTextOfInline(block.content);
  const code = block.attrs.code;
  return typeof code === 'string' ? code : '';
}

function renderCodeBlock(block: BlockNode): string {
  const lang = typeof block.attrs.lang === 'string' ? block.attrs.lang : '';
  const code = codeTextOf(block);
  let longestRun = 0;
  for (const match of code.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const header = lang === '' ? fence : `${fence}${lang}`;
  return [header, ...code.split('\n'), fence].join('\n');
}

function renderImage(block: BlockNode): string {
  const assetId = block.attrs.assetId;
  const alt = typeof block.attrs.alt === 'string' ? block.attrs.alt : '';
  const caption = typeof block.attrs.caption === 'string' ? block.attrs.caption : '';
  if (typeof assetId !== 'string' || assetId === '') {
    return `:::opaque{type="image"}\n[unsupported node: image without assetId]\n:::`;
  }
  const title = caption === '' ? '' : ` "${escapeAttrValue(caption)}"`;
  return `![${escapeAltText(alt)}](space-asset://${assetId}${title})`;
}

/** File card: `[附件：name](space-asset://asset_…)`. */
function renderFile(block: BlockNode): string {
  const assetId = block.attrs.assetId;
  const name = typeof block.attrs.name === 'string' ? block.attrs.name.trim() : '';
  if (typeof assetId !== 'string' || assetId === '') {
    return `:::opaque{type="file"}\n[unsupported node: file without assetId]\n:::`;
  }
  const label = name === '' ? '附件' : name;
  return `[${renderLinkLabel(`附件：${label}`)}](${renderLinkDestination(
    `space-asset://${assetId}`,
  )})`;
}

function directiveAttrsText(pairs: ReadonlyArray<readonly [string, JsonValue | undefined]>): string {
  const parts: string[] = [];
  for (const [key, value] of pairs) {
    if (value === undefined) continue;
    if (typeof value === 'boolean') parts.push(`${key}=${String(value)}`);
    else if (typeof value === 'number') parts.push(`${key}=${String(value)}`);
    else parts.push(`${key}="${escapeAttrValue(String(value))}"`);
  }
  return parts.length === 0 ? '' : `{${parts.join(' ')}}`;
}

function renderCallout(block: BlockNode): string {
  const header = `:::callout${directiveAttrsText([
    ['tone', block.attrs.tone],
    ['title', block.attrs.title],
    ['icon', block.attrs.icon],
    ['collapsed', block.attrs.collapsed],
  ])}`;
  const body = projectBlocks(block.children);
  return body === '' ? `${header}\n:::` : `${header}\n${body}\n:::`;
}

function renderObjectPlaceholder(block: BlockNode, name: 'mindmap' | 'component'): string {
  const pairs: Array<readonly [string, JsonValue | undefined]> =
    name === 'mindmap'
      ? [
          ['objectId', block.attrs.objectId],
          ['caption', block.attrs.caption],
        ]
      : [
          ['objectId', block.attrs.objectId],
          ['title', block.attrs.title],
          ['description', block.attrs.description],
        ];
  return `:::${name}${directiveAttrsText(pairs)}\n:::`;
}

function renderOpaque(block: BlockNode): string {
  return `:::opaque{type="${escapeAttrValue(block.type)}"}\n[unsupported node]\n:::`;
}

/** Web link card: `[title](url)`, falling back to the URL as the label. */
function renderBookmark(block: BlockNode): string {
  const url = typeof block.attrs.url === 'string' ? block.attrs.url : '';
  if (url === '')
    return ':::opaque{type="bookmark"}\n[unsupported node: bookmark without url]\n:::';
  const title = typeof block.attrs.title === 'string' ? block.attrs.title : '';
  const label = title.trim() === '' ? url : title;
  return `[${renderLinkLabel(label)}](${renderLinkDestination(url)})`;
}

/** Internal document link card: `[title](space-doc:<docId>)`. */
function renderDocLink(block: BlockNode): string {
  const docId = typeof block.attrs.docId === 'string' ? block.attrs.docId : '';
  if (docId === '')
    return ':::opaque{type="docLink"}\n[unsupported node: docLink without docId]\n:::';
  const title = typeof block.attrs.title === 'string' ? block.attrs.title : '';
  const label = title.trim() === '' ? docId : title;
  return `[${renderLinkLabel(label)}](${renderLinkDestination(`space-doc:${docId}`)})`;
}

/**
 * Project a single block (recursively for containers) without a top-level
 * anchor comment.
 */
export function projectBlock(block: BlockNode): string {
  switch (block.type) {
    case 'paragraph':
      return inlineToMarkdown(block.content);
    case 'heading': {
      const rawLevel = typeof block.attrs.level === 'number' ? block.attrs.level : 1;
      const level = Number.isFinite(rawLevel)
        ? Math.min(6, Math.max(1, Math.trunc(rawLevel)))
        : 1;
      const text = inlineToMarkdown(block.content);
      const hashes = '#'.repeat(level);
      return text === '' ? hashes : `${hashes} ${text}`;
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return renderListLines(block, 0).join('\n');
    case 'listItem':
      return projectBlocks(block.children);
    case 'blockquote':
      return renderBlockquote(block);
    case 'codeBlock':
      return renderCodeBlock(block);
    case 'divider':
      return '---';
    case 'table':
      return renderTable(block);
    case 'image':
      return renderImage(block);
    case 'file':
      return renderFile(block);
    case 'bookmark':
      return renderBookmark(block);
    case 'docLink':
      return renderDocLink(block);
    case 'callout':
      return renderCallout(block);
    case 'mindmap':
      return renderObjectPlaceholder(block, 'mindmap');
    case 'component':
      return renderObjectPlaceholder(block, 'component');
    default: {
      const definition = getNodeType(block.type);
      if (definition === undefined) return renderOpaque(block);
      if (definition.contentModel === 'inline') return inlineToMarkdown(block.content);
      if (definition.contentModel === 'blocks') return projectBlocks(block.children);
      if (definition.contentModel === 'table') return renderTable(block);
      return renderOpaque(block);
    }
  }
}

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PROJECTION_MAX_CHARS;
  if (!Number.isFinite(value)) return DEFAULT_PROJECTION_MAX_CHARS;
  return Math.max(0, Math.trunc(value));
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

/** Truncate to a character budget without splitting a surrogate pair. */
function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Project a document into Markdown.
 *
 * Only top-level blocks are selected; `blockIds`/`after`/`limit` narrow the
 * selection and `maxChars` bounds the output. The first selected block is
 * truncated character-safely when it alone exceeds the budget; later blocks
 * stay atomic (the projection stops before the block that would overflow).
 */
export function projectDocument(
  doc: AlterDoc,
  options: ProjectionOptions = {},
): ProjectionResult {
  const anchors = options.anchors !== false;
  const maxChars = normalizeMaxChars(options.maxChars);
  const limit = normalizeLimit(options.limit);
  const wanted =
    options.blockIds === undefined ? undefined : new Set(options.blockIds);
  const afterIndex =
    options.after === undefined
      ? -1
      : doc.blocks.findIndex((block) => block.id === options.after);

  let selected = doc.blocks.filter(
    (block, index) =>
      (afterIndex < 0 || index > afterIndex) &&
      (wanted === undefined || wanted.has(block.id)),
  );
  let truncated = false;
  if (limit !== undefined && selected.length > limit) {
    selected = selected.slice(0, limit);
    truncated = true;
  }

  // Reserve one character for the single trailing newline.
  const budget = Math.max(0, maxChars - 1);
  const parts: string[] = [];
  const includedBlocks: ProjectedBlockRef[] = [];
  let used = 0;

  const composePart = (block: BlockNode): string => {
    const piece = projectBlock(block);
    if (!anchors) return piece;
    const anchor = `<!-- blk:${block.id} -->`;
    return piece === '' ? anchor : `${anchor}\n${piece}`;
  };

  for (const block of selected) {
    const part = composePart(block);
    const separator = parts.length === 0 ? 0 : 2; // one blank line between blocks
    if (used + separator + part.length <= budget) {
      parts.push(part);
      used += separator + part.length;
      includedBlocks.push({ id: block.id, type: block.type });
      continue;
    }
    if (parts.length === 0) {
      // First block alone overflows: character-safe partial projection.
      const anchorText = anchors ? `<!-- blk:${block.id} -->\n` : '';
      if (budget > anchorText.length) {
        const piece = projectBlock(block);
        if (anchors) {
          const body = truncateChars(piece, budget - anchorText.length);
          if (body !== '') {
            parts.push(anchorText + body);
            includedBlocks.push({ id: block.id, type: block.type });
          }
        } else {
          parts.push(truncateChars(part, budget));
          includedBlocks.push({ id: block.id, type: block.type });
        }
      }
    }
    truncated = true;
    break;
  }

  return {
    markdown: parts.length === 0 ? '' : `${parts.join('\n\n')}\n`,
    includedBlocks,
    truncated,
  };
}
