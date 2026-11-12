/**
 * Frozen-DOM builders for the editor's block cards and atom blocks.
 *
 * The reference is the frozen loader projection
 * (`src/document/runtime/to-html.ts`), which is what users saw before the
 * kernel swap: file chips are `span[data-file]` with an inline paperclip SVG,
 * bookmark cards are `a[data-link-card]` with `strong` + `span`, doc links are
 * `a[data-doc-link]` with the icon-in-a-space trick, and object placeholders are
 * `div[data-object-card]`. The frozen stylesheet targets those exact shapes.
 *
 * Everything here returns a ProseMirror `DOMOutputSpec`, so the card DOM is the
 * same whether the editor renders it or the body is serialized to HTML. Icons
 * are built in the SVG namespace through the `namespace tag` form of an output
 * spec, which keeps `svg`/`path` real SVG elements (an HTML `path` is ignored).
 *
 * @module @alter-dsh/space/document/editors/tiptap/cards
 */
import type { DOMOutputSpec } from '@tiptap/pm/model';

/** SVG namespace URI used by the `namespace tag` output-spec prefix. */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Flat HTML attribute map; `undefined` entries are dropped by {@link attrsOf}. */
type Attributes = Record<string, string>;

/** One optional HTML attribute. */
type AttributeEntry = readonly [string, string | undefined];

/** Read a non-empty string attribute from a node's attrs. */
export function textAttr(
  attrs: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = attrs[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Read a finite number attribute from a node's attrs. */
export function numberAttr(
  attrs: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = attrs[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** Build an attribute map, skipping optional (undefined) values. */
function attrsOf(entries: readonly AttributeEntry[]): Attributes {
  const out: Attributes = {};
  for (const [name, value] of entries) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Stable block id of one node, as rendered on `data-block-id`. */
function blockId(attrs: Readonly<Record<string, unknown>>): string | undefined {
  return textAttr(attrs, 'id');
}

/**
 * Human readable byte size for a file chip.
 *
 * Mirrors the legacy loader's `formatFileSize` (B / KB / MB, one decimal for
 * the larger units) so a loaded card and a freshly pasted one read the same.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One SVG child in the SVG namespace. */
function svgChild(
  tag: 'path' | 'circle' | 'rect' | 'line',
  attrs: Attributes,
): DOMOutputSpec {
  return [`${SVG_NS} ${tag}`, attrs];
}

/** A 24-box lucide-shaped SVG root in the SVG namespace. */
function svgRoot(
  size: number,
  strokeWidth: number,
  children: readonly DOMOutputSpec[],
): DOMOutputSpec {
  return [
    `${SVG_NS} svg`,
    {
      viewBox: '0 0 24 24',
      width: String(size),
      height: String(size),
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': String(strokeWidth),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    ...children,
  ];
}

/** The legacy file chip's 12px paperclip. */
export function fileIconSpec(): DOMOutputSpec {
  return svgRoot(12, 1.6, [
    svgChild('path', {
      d: 'M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19',
    }),
  ]);
}

/** The legacy inline doc link's 14px document icon. */
export function docIconSpec(): DOMOutputSpec {
  return svgRoot(14, 1.8, [
    svgChild('path', { d: 'M5 3h9l5 5v13H5z' }),
    svgChild('path', { d: 'M14 3v6h5' }),
  ]);
}

/** URL helpers the card DOM needs (asset ids become servable URLs). */
export interface CardRenderContext {
  /** Map a stored `asset_…` id to its servable URL. */
  documentAssetUrl(assetId: string): string;
  /** Map a document id to its in-app path (doc-link card `href`). */
  docPath(docId: string): string;
}

/**
 * File chip: one focusable, non-editable `span[data-file]`.
 *
 * The two inner spans are fixed by the frozen DOM: `[data-file-icon]` holds the
 * paperclip and the plain text span holds `名称 · 大小`.
 */
export function fileCardSpec(
  attrs: Readonly<Record<string, unknown>>,
  context: CardRenderContext,
): DOMOutputSpec {
  const assetId = textAttr(attrs, 'assetId');
  const name = textAttr(attrs, 'name') ?? '附件';
  const mime = textAttr(attrs, 'mime') ?? 'application/octet-stream';
  const bytes = numberAttr(attrs, 'bytes');
  const href = assetId === undefined ? undefined : context.documentAssetUrl(assetId);
  const size = bytes === undefined ? '' : ` · ${formatFileSize(bytes)}`;
  const elementAttrs = attrsOf([
    ['data-file', name],
    ['data-block-id', blockId(attrs)],
    ['data-block-type', 'file'],
    ['data-asset-id', assetId],
    ['data-name', name],
    ['data-mime', mime],
    ['data-bytes', bytes === undefined ? undefined : String(bytes)],
    ['data-href', href],
    ['contenteditable', 'false'],
    ['role', 'link'],
    ['tabindex', '0'],
    ['aria-label', `打开文件 ${name}`],
    ['title', name],
  ]);
  return [
    'span',
    elementAttrs,
    [
      'span',
      { 'data-file-icon': '', contenteditable: 'false', 'aria-hidden': 'true' },
      fileIconSpec(),
    ],
    ['span', {}, `${name}${size}`],
  ];
}

/**
 * Bookmark card: one `a[data-link-card]` with a `strong` title and one `span`.
 *
 * The href is only emitted for a safe scheme (the value is rendered through
 * innerHTML in the history panel too); `data-href` always keeps the original
 * URL so the click handler can open it.
 */
export function bookmarkCardSpec(
  attrs: Readonly<Record<string, unknown>>,
): DOMOutputSpec {
  const url = textAttr(attrs, 'url') ?? '';
  const title = textAttr(attrs, 'title') ?? url;
  const description = textAttr(attrs, 'description') ?? url;
  const href = safeWebHref(url);
  const elementAttrs = attrsOf([
    ['data-link-card', url],
    ['data-block-id', blockId(attrs)],
    ['data-block-type', 'bookmark'],
    ['data-href', url],
    ['href', href],
    ['data-title', textAttr(attrs, 'title')],
    ['data-description', textAttr(attrs, 'description')],
    ['data-icon', textAttr(attrs, 'icon')],
    ['contenteditable', 'false'],
    ['tabindex', '0'],
    ['aria-label', `打开 ${title}`],
  ]);
  return [
    'a',
    elementAttrs,
    ['strong', {}, title],
    ['span', {}, description],
  ];
}

/**
 * Inline doc link: `a[data-doc-link]` with the frozen icon spacing trick.
 *
 * The icon span is an inline `::before`-spaced placeholder holding an absolutely
 * positioned SVG, which keeps the comment underline unbroken; the styling lives
 * in the frozen stylesheet, so the DOM must keep exactly this shape.
 */
export function docLinkCardSpec(
  attrs: Readonly<Record<string, unknown>>,
  context: CardRenderContext,
): DOMOutputSpec {
  const docId = textAttr(attrs, 'docId') ?? '';
  const title = textAttr(attrs, 'title') ?? docId;
  const elementAttrs = attrsOf([
    ['data-doc-link', docId],
    ['data-block-id', blockId(attrs)],
    ['data-block-type', 'docLink'],
    ['data-doc-id', docId],
    ['href', context.docPath(docId)],
    ['data-title', textAttr(attrs, 'title')],
    ['contenteditable', 'false'],
    ['tabindex', '0'],
    ['aria-label', `打开 ${title}`],
  ]);
  return [
    'a',
    elementAttrs,
    ['span', { 'data-doc-icon': '', contenteditable: 'false', 'aria-hidden': 'true' }, docIconSpec()],
    title,
  ];
}

/** Block image: `img` with the frozen asset attributes (no raw `assetId`). */
export function imageSpec(
  attrs: Readonly<Record<string, unknown>>,
  context: CardRenderContext,
): DOMOutputSpec {
  const assetId = textAttr(attrs, 'assetId');
  const src =
    assetId === undefined ? '' : context.documentAssetUrl(assetId);
  return [
    'img',
    attrsOf([
      ['data-block-id', blockId(attrs)],
      ['data-block-type', 'image'],
      ['data-asset-id', assetId],
      ['data-caption', textAttr(attrs, 'caption')],
      ['src', src],
      ['alt', textAttr(attrs, 'alt') ?? ''],
      ['title', textAttr(attrs, 'caption')],
      ['width', textAttr(attrs, 'width')],
    ]),
  ];
}

/** Placeholder card for a mindmap/component object (no styles in the frozen UI). */
export function objectCardSpec(
  kind: 'mindmap' | 'component',
  attrs: Readonly<Record<string, unknown>>,
): DOMOutputSpec {
  const label = kind === 'mindmap' ? '思维导图' : '交互组件';
  const caption =
    kind === 'mindmap'
      ? textAttr(attrs, 'caption')
      : textAttr(attrs, 'title');
  const elementAttrs = attrsOf([
    ['data-object-card', ''],
    ['data-kind', kind],
    ['data-block-id', blockId(attrs)],
    ['data-block-type', kind],
    ['data-object-id', textAttr(attrs, 'objectId')],
    ['data-caption', kind === 'mindmap' ? caption : undefined],
    ['data-title', kind === 'component' ? caption : undefined],
    ['data-description', kind === 'component' ? textAttr(attrs, 'description') : undefined],
    ['contenteditable', 'false'],
  ]);
  return [
    'div',
    elementAttrs,
    `[${label}]${caption === undefined ? '' : ` ${caption}`}`,
  ];
}

/** Divider block: the frozen `div[data-divider]` selectable wrapper around an `hr`. */
export function dividerSpec(
  attrs: Readonly<Record<string, unknown>>,
): DOMOutputSpec {
  return [
    'div',
    attrsOf([
      ['data-divider', ''],
      ['data-block-id', blockId(attrs)],
      ['data-block-type', 'divider'],
      ['contenteditable', 'false'],
    ]),
    ['hr'],
  ];
}

/** Callout container: a neutral `div[data-object-card]` whose children are blocks. */
export function calloutSpec(
  attrs: Readonly<Record<string, unknown>>,
): DOMOutputSpec {
  const collapsed = attrs['collapsed'] === true;
  return [
    'div',
    attrsOf([
      ['data-object-card', ''],
      ['data-kind', 'callout'],
      ['data-block-id', blockId(attrs)],
      ['data-block-type', 'callout'],
      ['data-tone', textAttr(attrs, 'tone')],
      ['data-title', textAttr(attrs, 'title')],
      ['data-icon', textAttr(attrs, 'icon')],
      ['data-collapsed', collapsed ? 'true' : undefined],
    ]),
    0,
  ];
}

/**
 * Only emit an `href` for a scheme a click may follow.
 *
 * Stored content must never put `javascript:`/`data:` in an href: the history
 * panel renders the same HTML through innerHTML.
 */
function safeWebHref(url: string): string | undefined {
  return /^(https?:\/\/|mailto:|\/|#)/i.test(url) ? url : undefined;
}

/** `data-*` attribute names the card DOM carries, for parse rules. */
export const CARD_DATA_ATTRIBUTES = {
  file: 'data-file',
  bookmark: 'data-link-card',
  docLink: 'data-doc-link',
  objectCard: 'data-object-card',
  divider: 'data-divider',
} as const;