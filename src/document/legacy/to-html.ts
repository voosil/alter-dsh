/**
 * AST → legacy contentEditable HTML.
 *
 * The restored pre-rebuild editor owns the DOM and CSS; the adapter only turns
 * `alter-doc/1` blocks into the exact HTML syntax that editor already knows
 * (paragraphs, headings, lists, todos, quotes, code, dividers, tables, inline
 * marks, cards, images). Every block keeps its AST id in `data-block-id`
 * (list items/table rows/cells included; the first paragraph of a list item /
 * quote / todo is kept in `data-paragraph-id`) so a save can reuse ids and
 * keep comment anchors stable.
 *
 * @module @alter-dsh/space/document/legacy/to-html
 */
import { documentAssetUrl } from '../asset-url';
import { safeHref } from './html-parser';
import type { AlterDoc, BlockNode, InlineNode, JsonValue, Mark } from '../types';

/** Options of {@link alterDocToEditorHtml}. */
export interface AlterDocToHtmlOptions {
  /** Map a document id to its in-app path (legacy doc-link href). */
  docPath?: (docId: string) => string;
}

const MARK_WRAP_ORDER: readonly Mark['type'][] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'highlight',
  'link',
];

const FILE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19"/></svg>';
const DOC_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v6h5"/></svg>';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('\n', ' ');
}

/** `data-*` attributes for one block (id first). */
function blockAttrs(
  block: BlockNode,
  extra: ReadonlyArray<readonly [string, JsonValue | undefined]> = [],
): string {
  let result = ` data-block-id="${escapeAttr(block.id)}"`;
  for (const [key, value] of extra) {
    if (value === undefined || value === null) continue;
    result += ` data-${key}="${escapeAttr(String(value))}"`;
  }
  return result;
}

function attrText(
  block: BlockNode,
  key: string,
): string | undefined {
  const value = block.attrs[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function attrNumber(block: BlockNode, key: string): number | undefined {
  const value = block.attrs[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Human readable byte size for the legacy file chip label. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Wrap one text run with its marks (deterministic order, links outermost). */
function renderTextRun(text: string, marks: Mark[] | undefined): string {
  let body = escapeHtml(text).replaceAll('\n', '<br>');
  if (marks === undefined || marks.length === 0) return body;
  const byType = new Map<Mark['type'], Mark>();
  for (const mark of marks) if (!byType.has(mark.type)) byType.set(mark.type, mark);
  for (const type of MARK_WRAP_ORDER) {
    const mark = byType.get(type);
    if (mark === undefined) continue;
    switch (type) {
      case 'bold':
        body = `<strong>${body}</strong>`;
        break;
      case 'italic':
        body = `<em>${body}</em>`;
        break;
      case 'underline':
        body = `<u>${body}</u>`;
        break;
      case 'strike':
        body = `<s>${body}</s>`;
        break;
      case 'code':
        body = `<code>${body}</code>`;
        break;
      case 'highlight':
        body = `<mark>${body}</mark>`;
        break;
      case 'link': {
        const href = mark.attrs?.href;
        if (href !== undefined && /^(https?:\/\/|mailto:|\/|#)/i.test(href)) {
          body = `<a href="${escapeAttr(href)}">${body}</a>`;
        }
        break;
      }
    }
  }
  return body;
}

/** Render inline content of one textblock. */
export function renderInline(content: InlineNode[] | undefined): string {
  if (content === undefined || content.length === 0) return '';
  let output = '';
  for (const node of content) {
    if (node.type === 'hardBreak') {
      output += '<br>';
      continue;
    }
    output += renderTextRun(node.text, node.marks);
  }
  return output;
}

/** Inline HTML of the first paragraph child (list items / quotes / todos). */
function firstParagraphInline(
  children: readonly BlockNode[] | undefined,
): { html: string; id?: string; rest: BlockNode[] } {
  const list = children ?? [];
  const first = list[0];
  if (first !== undefined && first.type === 'paragraph') {
    return {
      html: renderInline(first.content),
      id: first.id,
      rest: list.slice(1),
    };
  }
  return { html: '', id: undefined, rest: [...list] };
}

function renderList(
  block: BlockNode,
  ordered: boolean,
  options: AlterDocToHtmlOptions,
): string {
  const tag = ordered ? 'ol' : 'ul';
  const start = ordered ? attrNumber(block, 'start') : undefined;
  const startAttr = start !== undefined && start !== 1 ? ` start="${start}"` : '';
  const items = (block.children ?? []).map((item) => {
    if (item.type !== 'listItem') return renderBlock(item, options);
    const first = firstParagraphInline(item.children);
    const rest = first.rest.map((child) => renderBlock(child, options)).join('');
    const body = `${first.html}${rest}`;
    return `<li${blockAttrs(item, [['paragraph-id', first.id]])}>${
      body === '' ? '<br>' : body
    }</li>`;
  });
  return `<${tag}${blockAttrs(block)}${startAttr}>${items.join('')}</${tag}>`;
}

function renderTaskList(
  block: BlockNode,
  options: AlterDocToHtmlOptions,
): string {
  return (block.children ?? [])
    .map((item) => {
      if (item.type !== 'listItem') return renderBlock(item, options);
      const checked = item.attrs.checked === true;
      const first = firstParagraphInline(item.children);
      const rest = first.rest.map((child) => renderBlock(child, options)).join('');
      const text = first.html === '' ? '<br>' : first.html;
      return (
        `<div data-todo data-checked="${checked ? 'true' : 'false'}"` +
        blockAttrs(item, [
          ['task-list-id', block.id],
          ['paragraph-id', first.id],
        ]) +
        `><span data-todo-box contenteditable="false" role="checkbox" aria-checked="${
          checked ? 'true' : 'false'
        }" aria-label="待办事项" tabindex="0"></span>` +
        `<span data-todo-text>${text}</span>${rest}</div>`
      );
    })
    .join('');
}

function renderBlockquote(
  block: BlockNode,
  options: AlterDocToHtmlOptions,
): string {
  const children = block.children ?? [];
  const parts: string[] = [];
  let paragraphId: string | undefined;
  for (const [index, child] of children.entries()) {
    if (child.type === 'paragraph') {
      const html = renderInline(child.content);
      if (index === 0) paragraphId = child.id;
      if (html !== '') parts.push(html);
      continue;
    }
    parts.push(renderBlock(child, options));
  }
  return `<blockquote${blockAttrs(block, [
    ['paragraph-id', paragraphId],
  ])}>${parts.length === 0 ? '<br>' : parts.join('')}</blockquote>`;
}

function renderCodeBlock(block: BlockNode): string {
  const lang = attrText(block, 'lang');
  const text = (block.content ?? [])
    .map((node) => (node.type === 'text' ? node.text : '\n'))
    .join('');
  return `<pre${blockAttrs(block, [['lang', lang]])}><code>${escapeHtml(
    text,
  )}</code></pre>`;
}

function renderTable(block: BlockNode): string {
  const rows = (block.children ?? []).filter((row) => row.type === 'tableRow');
  const headerRows =
    attrNumber(block, 'headerRows') ?? (rows.length > 0 ? 1 : 0);
  const renderRow = (row: BlockNode, header: boolean): string => {
    const cells = (row.children ?? []).map((cell) => {
      if (cell.type !== 'tableCell' && cell.type !== 'tableHeader') {
        return '';
      }
      const tag = header ? 'th' : 'td';
      const html = renderInline(cell.content);
      return `<${tag}${blockAttrs(cell)}>${html === '' ? '<br>' : html}</${tag}>`;
    });
    return `<tr${blockAttrs(row)}>${cells.join('')}</tr>`;
  };
  const headRows = rows.slice(0, Math.max(0, headerRows));
  const bodyRows = rows.slice(headRows.length);
  const head =
    headRows.length === 0
      ? ''
      : `<thead>${headRows.map((row) => renderRow(row, true)).join('')}</thead>`;
  const body =
    bodyRows.length === 0
      ? ''
      : `<tbody>${bodyRows.map((row) => renderRow(row, false)).join('')}</tbody>`;
  return `<table${blockAttrs(block)}>${head}${body}</table>`;
}

function renderImage(block: BlockNode): string {
  const assetId = attrText(block, 'assetId');
  const alt = attrText(block, 'alt') ?? '';
  const caption = attrText(block, 'caption');
  const width = attrText(block, 'width');
  if (assetId === undefined) {
    return `<p${blockAttrs(block)}>[图片：缺少资产 id]</p>`;
  }
  return (
    `<img${blockAttrs(block, [
      ['asset-id', assetId],
      ['alt', alt],
      ['caption', caption],
    ])} src="${escapeAttr(documentAssetUrl(assetId))}" alt="${escapeAttr(alt)}"` +
    (caption === undefined ? '' : ` title="${escapeAttr(caption)}"`) +
    (width === undefined ? '' : ` width="${escapeAttr(width)}"`) +
    '>'
  );
}

function renderFile(block: BlockNode): string {
  const assetId = attrText(block, 'assetId');
  const name = attrText(block, 'name') ?? '附件';
  const mime = attrText(block, 'mime') ?? 'application/octet-stream';
  const bytes = attrNumber(block, 'bytes');
  if (assetId === undefined) {
    return `<p${blockAttrs(block)}>[文件：缺少资产 id]</p>`;
  }
  const size = bytes === undefined ? '' : ` · ${formatFileSize(bytes)}`;
  return (
    `<span data-file="${escapeAttr(name)}"${blockAttrs(block, [
      ['asset-id', assetId],
      ['name', name],
      ['mime', mime],
      ['bytes', bytes],
      ['href', documentAssetUrl(assetId)],
    ])} contenteditable="false">` +
    `<span data-file-icon contenteditable="false">${FILE_ICON_SVG}</span>` +
    `<span>${escapeHtml(name)}${escapeHtml(size)}</span></span>`
  );
}

function renderBookmark(block: BlockNode): string {
  const url = attrText(block, 'url');
  if (url === undefined) {
    return `<p${blockAttrs(block)}>[网页链接卡：缺少链接]</p>`;
  }
  const title = attrText(block, 'title') ?? url;
  const description = attrText(block, 'description') ?? url;
  const icon = attrText(block, 'icon');
  const attrs = blockAttrs(block, [
    ['title', attrText(block, 'title')],
    ['description', attrText(block, 'description')],
    ['icon', icon],
  ]);
  const href = safeHref(url);
  if (href === undefined) {
    // Stored content must not put an unchecked scheme (javascript:, data:) in
    // an href: the history panel renders this HTML via innerHTML.
    return (
      `<a data-link-card="${escapeAttr(url)}"${attrs} contenteditable="false">` +
      `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(
        description,
      )}</span></a>`
    );
  }
  return (
    `<a data-link-card="${escapeAttr(url)}" data-href="${escapeAttr(
      url,
    )}"${attrs} href="${escapeAttr(href)}" contenteditable="false">` +
    `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(
      description,
    )}</span></a>`
  );
}

function renderDocLink(
  block: BlockNode,
  options: AlterDocToHtmlOptions,
): string {
  const docId = attrText(block, 'docId');
  if (docId === undefined) {
    return `<p${blockAttrs(block)}>[文档内链卡：缺少文档 id]</p>`;
  }
  const title = attrText(block, 'title') ?? docId;
  const href = options.docPath?.(docId) ?? `#/space/doc/${docId}`;
  return (
    `<a data-doc-link="${escapeAttr(docId)}"${blockAttrs(block, [
      ['doc-id', docId],
      ['title', attrText(block, 'title')],
    ])} href="${escapeAttr(href)}" contenteditable="false">` +
    `<span data-doc-icon contenteditable="false">${DOC_ICON_SVG}</span>` +
    `${escapeHtml(title)}</a>`
  );
}

function renderCallout(
  block: BlockNode,
  options: AlterDocToHtmlOptions,
): string {
  const tone = attrText(block, 'tone') ?? 'info';
  const children = (block.children ?? [])
    .map((child) => renderBlock(child, options))
    .join('');
  return (
    `<div data-object-card data-kind="callout"${blockAttrs(block, [
      ['tone', tone],
      ['title', attrText(block, 'title')],
      ['icon', attrText(block, 'icon')],
      ['collapsed', block.attrs.collapsed === true ? 'true' : undefined],
    ])}>${children}</div>`
  );
}

function renderObjectPlaceholder(block: BlockNode, kind: 'mindmap' | 'component'): string {
  const objectId = attrText(block, 'objectId');
  if (objectId === undefined) {
    return `<p${blockAttrs(block)}>[${
      kind === 'mindmap' ? '思维导图' : '交互组件'
    }：缺少对象 id]</p>`;
  }
  const label = kind === 'mindmap' ? '思维导图' : '交互组件';
  const caption =
    kind === 'mindmap'
      ? attrText(block, 'caption')
      : attrText(block, 'title');
  return (
    `<div data-object-card data-kind="${kind}"${blockAttrs(block, [
      ['object-id', objectId],
      ['caption', kind === 'mindmap' ? caption : undefined],
      ['title', kind === 'component' ? caption : undefined],
      ['description', kind === 'component' ? attrText(block, 'description') : undefined],
    ])} contenteditable="false">[${label}]${
      caption === undefined ? '' : ` ${escapeHtml(caption)}`
    }</div>`
  );
}

function renderBlock(
  block: BlockNode,
  options: AlterDocToHtmlOptions = {},
): string {
  switch (block.type) {
    case 'paragraph': {
      const html = renderInline(block.content);
      return `<p${blockAttrs(block)}>${html === '' ? '<br>' : html}</p>`;
    }
    case 'heading': {
      const levelRaw = attrNumber(block, 'level') ?? 1;
      const level = Math.min(6, Math.max(1, Math.trunc(levelRaw)));
      const html = renderInline(block.content);
      return `<h${level}${blockAttrs(block)}>${html === '' ? '<br>' : html}</h${level}>`;
    }
    case 'bulletList':
      return renderList(block, false, options);
    case 'orderedList':
      return renderList(block, true, options);
    case 'taskList':
      return renderTaskList(block, options);
    case 'listItem':
      return firstParagraphInline(block.children).html;
    case 'blockquote':
      return renderBlockquote(block, options);
    case 'codeBlock':
      return renderCodeBlock(block);
    case 'divider':
      // Legacy DOM wraps the rule in a selectable `[data-divider]` element.
      return `<div data-divider${blockAttrs(block)} contenteditable="false"><hr></div>`;
    case 'table':
      return renderTable(block);
    case 'image':
      return renderImage(block);
    case 'file':
      return renderFile(block);
    case 'bookmark':
      return renderBookmark(block);
    case 'docLink':
      return renderDocLink(block, options);
    case 'callout':
      return renderCallout(block, options);
    case 'mindmap':
      return renderObjectPlaceholder(block, 'mindmap');
    case 'component':
      return renderObjectPlaceholder(block, 'component');
    default: {
      const text = `[unsupported node: ${block.type}]`;
      return `<p${blockAttrs(block)}>${escapeHtml(text)}</p>`;
    }
  }
}

/**
 * Convert one AST document into the legacy editor's HTML body.
 *
 * The result is a plain HTML fragment (no wrapper element); the caller assigns
 * it to the editor surface. Unknown node types degrade to visible placeholder
 * paragraphs instead of being dropped.
 */
export function alterDocToEditorHtml(
  doc: AlterDoc,
  options: AlterDocToHtmlOptions = {},
): string {
  return doc.blocks.map((block) => renderBlock(block, options)).join('');
}
