/**
 * Legacy HTML document body → Alter AST migration parser.
 *
 * Old document bodies are `contentEditable` HTML fragments. Migration keeps
 * semantics (block structure, text, marks, links, tables and inline data-URL
 * images) but not pixels: colors, alignment, styles and unknown structures
 * degrade to plain paragraphs. Conversion is one-way and never throws for
 * arbitrary input; the result always passes `validateAlterDoc`.
 *
 * The parser has no DOM and no dependencies. Inline `data:` images are
 * resolved through {@link LegacyHtmlParserOptions.assetIdFor} — the caller
 * imports them first, so this module only performs a synchronous lookup.
 *
 * @module @alter-dsh/space/document/html-migration
 */
import { validateAlterDoc } from './schema.js';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  MAX_BLOCK_COUNT,
  MAX_BLOCK_DEPTH,
  type BlockNode,
  type InlineNode,
  type JsonValue,
  type Mark,
  type MarkType,
} from './types.js';

/** Injections the migration parser needs from its caller. */
export interface LegacyHtmlParserOptions {
  /** Allocate one unique `blk_…` id per block (table rows/cells included). */
  createBlockId(): string;
  /** Resolve an already-imported data-URL image to its `asset_…` id. */
  assetIdFor(dataUrl: string): string | undefined;
}

/** Canonical mark order (mirrors the registry / markdown projection). */
const MARK_TYPE_ORDER: readonly MarkType[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'highlight',
  'link',
];

/** Upper bound for one `codeBlock` language tag (schema `maxLength`). */
const MAX_LANG_LENGTH = 32;
/** Upper bound for one link target (defensive; nothing longer is representable). */
const MAX_HREF_LENGTH = 2000;
const MAX_ALT_LENGTH = 500;
const MAX_CAPTION_LENGTH = 500;
const MAX_IMAGE_WIDTH_LENGTH = 32;

/** Tree depth cap so absurdly nested input cannot overflow the call stack. */
const MAX_TREE_DEPTH = 200;
/**
 * Conservative serialized-size budget for the emitted blocks. The document
 * limit is 512 KiB; stopping earlier leaves room for JSON structural overhead
 * the estimate does not model exactly.
 */
const MAX_ESTIMATED_BYTES = 400 * 1024;

const TRUNCATION_NOTE = '[文档内容过长，迁移已截断]';

const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;
const DATA_IMAGE_SRC = /^data:image\/(?:png|jpeg|webp|gif);base64,/i;
const LANGUAGE_CLASS = /(?:^|\s)language-([A-Za-z0-9_+#.-]{1,32})(?=\s|$)/;
const CODE_CLASS_ATTR = /<code\b[^>]*\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

const VOID_TAGS = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'img',
  'image',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Elements whose entire subtree is meaningless for document semantics. */
const SKIP_SUBTREE_TAGS = new Set([
  'head',
  'script',
  'style',
  'title',
  'noscript',
  'template',
]);

/** Raw-text elements whose body must not be tokenized as markup. */
const RAW_TEXT_TAGS = new Set(['script', 'style']);

/** Block-level tags used to decide div transparency and p auto-closing. */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Known inline tags (unknown tags are classified structurally instead). */
const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'acronym',
  'b',
  'bdi',
  'bdo',
  'big',
  'br',
  'button',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'img',
  'image',
  'input',
  'ins',
  'kbd',
  'label',
  'mark',
  'meter',
  'output',
  'progress',
  'q',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
]);

/** Inline tags that add one mark to their text content. */
const INLINE_MARK_TAGS: ReadonlyMap<string, MarkType> = new Map([
  ['strong', 'bold'],
  ['b', 'bold'],
  ['em', 'italic'],
  ['i', 'italic'],
  ['u', 'underline'],
  ['ins', 'underline'],
  ['s', 'strike'],
  ['strike', 'strike'],
  ['del', 'strike'],
  ['mark', 'highlight'],
  ['code', 'code'],
]);

const LIST_BOUNDARY = new Set(['ul', 'ol', 'menu']);
const ROW_BOUNDARY = new Set(['table', 'thead', 'tbody', 'tfoot']);
const CELL_BOUNDARY = new Set(['tr']);
const DEFINITION_BOUNDARY = new Set(['dl']);
const P_CLOSE_BOUNDARY = new Set([
  'body',
  'html',
  'div',
  'li',
  'td',
  'th',
  'blockquote',
  'table',
  'ul',
  'ol',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'figure',
  'form',
]);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  shy: '\u00ad',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  times: '\u00d7',
  divide: '\u00f7',
  middot: '\u00b7',
  bull: '\u2022',
  deg: '\u00b0',
  plusmn: '\u00b1',
  sup2: '\u00b2',
  sup3: '\u00b3',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  prime: '\u2032',
  Prime: '\u2033',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  harr: '\u2194',
};

const NUMERIC_ENTITY = /&#(?:[xX]([0-9a-fA-F]+)|(\d+));?/g;
const NAMED_ENTITY = /&([A-Za-z][A-Za-z0-9]*);/g;

function codePointToString(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
    return '\uFFFD';
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return '\uFFFD';
  return String.fromCodePoint(codePoint);
}

/** Decode the HTML entities contentEditable output actually produces. */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text
    .replace(
      NUMERIC_ENTITY,
      (_whole: string, hex: string | undefined, decimal: string | undefined) => {
        const codePoint =
          hex !== undefined
            ? Number.parseInt(hex, 16)
            : Number.parseInt(decimal ?? '', 10);
        return codePointToString(codePoint);
      },
    )
    .replace(
      NAMED_ENTITY,
      (whole: string, name: string) =>
        NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? whole,
    );
}

function collapseWhitespace(text: string): string {
  return text.replace(/[\t\n\r\f ]+/g, ' ');
}

// ---------------------------------------------------------------------------
// Tokenizer (tolerant, no DOM)
// ---------------------------------------------------------------------------

interface HtmlTextToken {
  kind: 'text';
  text: string;
}

interface HtmlStartToken {
  kind: 'start';
  name: string;
  attrs: Record<string, string | undefined>;
  selfClosing: boolean;
}

interface HtmlEndToken {
  kind: 'end';
  name: string;
}

type HtmlToken = HtmlStartToken | HtmlEndToken | HtmlTextToken;

const START_TAG_AT = /<([A-Za-z][A-Za-z0-9:_-]*)/y;
const END_TAG_AT = /<\/([A-Za-z][A-Za-z0-9:_-]*)/y;
const ATTR_PATTERN =
  /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const PRE_CLOSE_AT = /<\/pre\s*>/gi;
const RAW_CLOSE_CACHE = new Map<string, RegExp>();

function findPreClose(html: string, from: number): { start: number; end: number } | null {
  PRE_CLOSE_AT.lastIndex = from;
  const match = PRE_CLOSE_AT.exec(html);
  if (match === null) return null;
  return { start: match.index, end: match.index + match[0].length };
}

function findRawClose(html: string, tag: string, from: number): number | null {
  let pattern = RAW_CLOSE_CACHE.get(tag);
  if (pattern === undefined) {
    pattern = new RegExp(`</${tag}\\s*>`, 'gi');
    RAW_CLOSE_CACHE.set(tag, pattern);
  }
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  return match === null ? null : match.index + match[0].length;
}

function parseAttributes(raw: string): Record<string, string | undefined> {
  const attrs: Record<string, string | undefined> = {};
  ATTR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_PATTERN.exec(raw)) !== null) {
    if (match[0] === '') {
      ATTR_PATTERN.lastIndex += 1;
      continue;
    }
    const name = match[1]!.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function languageFromClass(className: string | undefined): string | undefined {
  if (className === undefined) return undefined;
  const match = LANGUAGE_CLASS.exec(className);
  return match === null ? undefined : match[1];
}

function languageFromInnerCode(inner: string): string | undefined {
  const match = CODE_CLASS_ATTR.exec(inner);
  if (match === null) return undefined;
  return languageFromClass(match[1] ?? match[2]);
}

/** Reduce a `<pre>` body to plain text: `<br>` → newline, editor tags stripped. */
function preTextOf(inner: string): string {
  const text = inner
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
    .replace(
      /<\/?(?:span|code|font|b|strong|i|em|u|s|strike|del|mark|a|div|p|li|tr|td|th|tbody|thead|tfoot|table|pre|h[1-6]|blockquote|section|article)\b[^>]*>/gi,
      '',
    );
  return decodeEntities(text).replace(/\r\n?/g, '\n');
}

function tokenize(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const pushText = (raw: string): void => {
    if (raw === '') return;
    const text = decodeEntities(raw);
    if (text !== '') tokens.push({ kind: 'text', text });
  };

  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt < 0) {
      pushText(html.slice(index));
      break;
    }
    if (lt > index) pushText(html.slice(index, lt));
    index = lt;

    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', index)) {
      const end = html.indexOf(']]>', index + 9);
      const body = end < 0 ? html.slice(index + 9) : html.slice(index + 9, end);
      pushText(body);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', index) || html.startsWith('<?', index)) {
      const end = html.indexOf('>', index + 2);
      index = end < 0 ? html.length : end + 1;
      continue;
    }

    END_TAG_AT.lastIndex = index;
    const endTag = END_TAG_AT.exec(html);
    if (endTag !== null) {
      const close = html.indexOf('>', endTag.index + endTag[0].length);
      if (close < 0) {
        pushText(html.slice(index));
        break;
      }
      tokens.push({ kind: 'end', name: endTag[1]!.toLowerCase() });
      index = close + 1;
      continue;
    }

    START_TAG_AT.lastIndex = index;
    const startTag = START_TAG_AT.exec(html);
    if (startTag === null) {
      pushText('<');
      index += 1;
      continue;
    }
    const close = html.indexOf('>', startTag.index + startTag[0].length);
    if (close < 0) {
      pushText(html.slice(index));
      break;
    }
    const rawAttrs = html.slice(startTag.index + startTag[0].length, close);
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const name = startTag[1]!.toLowerCase();
    const attrs = parseAttributes(selfClosing ? rawAttrs.replace(/\/\s*$/, '') : rawAttrs);
    index = close + 1;

    if (name === 'pre' && !selfClosing) {
      const preClose = findPreClose(html, index);
      const inner = preClose === null ? html.slice(index) : html.slice(index, preClose.start);
      const text = preTextOf(inner);
      const lang = languageFromClass(attrs.class) ?? languageFromInnerCode(inner);
      if (lang !== undefined) attrs.__preLang = lang;
      tokens.push({ kind: 'start', name, attrs, selfClosing: false });
      if (text !== '') tokens.push({ kind: 'text', text });
      tokens.push({ kind: 'end', name });
      index = preClose === null ? html.length : preClose.end;
      continue;
    }

    if (RAW_TEXT_TAGS.has(name) && !selfClosing) {
      const resume = findRawClose(html, name, index);
      tokens.push({ kind: 'start', name, attrs, selfClosing: false });
      tokens.push({ kind: 'end', name });
      index = resume === null ? html.length : resume;
      continue;
    }

    tokens.push({ kind: 'start', name, attrs, selfClosing });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Tolerant DOM tree
// ---------------------------------------------------------------------------

interface HtmlTextNode {
  kind: 'text';
  text: string;
}

interface HtmlElementNode {
  kind: 'element';
  tag: string;
  attrs: Record<string, string | undefined>;
  children: HtmlNode[];
}

type HtmlNode = HtmlTextNode | HtmlElementNode;

function isElementNode(node: HtmlNode): node is HtmlElementNode {
  return node.kind === 'element';
}

function appendText(parent: HtmlElementNode, text: string): void {
  const last = parent.children[parent.children.length - 1];
  if (last !== undefined && last.kind === 'text') {
    last.text += text;
    return;
  }
  parent.children.push({ kind: 'text', text });
}

function findOpenIndex(
  stack: readonly HtmlElementNode[],
  names: readonly string[],
  boundaries: ReadonlySet<string>,
): number {
  for (let index = stack.length - 1; index > 0; index -= 1) {
    const tag = stack[index]!.tag;
    if (names.includes(tag)) return index;
    if (boundaries.has(tag)) return -1;
  }
  return -1;
}

/** Apply the browser's implied end tags for the common contentEditable shapes. */
function autoCloseStack(stack: HtmlElementNode[], name: string): void {
  if (name === 'li') {
    const index = findOpenIndex(stack, ['li'], LIST_BOUNDARY);
    if (index > 0) stack.length = index;
    return;
  }
  if (name === 'td' || name === 'th') {
    const index = findOpenIndex(stack, ['td', 'th'], CELL_BOUNDARY);
    if (index > 0) stack.length = index;
    return;
  }
  if (name === 'tr') {
    const index = findOpenIndex(stack, ['tr'], ROW_BOUNDARY);
    if (index > 0) stack.length = index;
    return;
  }
  if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
    while (stack.length > 1) {
      const tag = stack[stack.length - 1]!.tag;
      if (tag === 'td' || tag === 'th' || tag === 'tr') stack.pop();
      else break;
    }
    if (stack.length > 1) {
      const tag = stack[stack.length - 1]!.tag;
      if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') stack.pop();
    }
    return;
  }
  if (name === 'dt' || name === 'dd') {
    const index = findOpenIndex(stack, ['dt', 'dd'], DEFINITION_BOUNDARY);
    if (index > 0) stack.length = index;
    return;
  }
  if (name === 'option') {
    if (stack.length > 1 && stack[stack.length - 1]!.tag === 'option') stack.pop();
    return;
  }
  if (BLOCK_TAGS.has(name)) {
    const index = findOpenIndex(stack, ['p'], P_CLOSE_BOUNDARY);
    if (index > 0) stack.length = index;
  }
}

function buildDom(tokens: readonly HtmlToken[]): HtmlElementNode {
  const root: HtmlElementNode = { kind: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: HtmlElementNode[] = [root];
  let skipTag: string | null = null;
  let skipDepth = 0;

  for (const token of tokens) {
    if (skipTag !== null) {
      if (token.kind === 'start') {
        if (!VOID_TAGS.has(token.name) && !token.selfClosing) skipDepth += 1;
      } else if (token.kind === 'end') {
        if (skipDepth > 0) skipDepth -= 1;
        else if (token.name === skipTag) skipTag = null;
      }
      continue;
    }

    if (token.kind === 'text') {
      appendText(stack[stack.length - 1]!, token.text);
      continue;
    }
    if (token.kind === 'start') {
      if (SKIP_SUBTREE_TAGS.has(token.name)) {
        if (!token.selfClosing) {
          skipTag = token.name;
          skipDepth = 0;
        }
        continue;
      }
      autoCloseStack(stack, token.name);
      const parent = stack[stack.length - 1]!;
      const element: HtmlElementNode = {
        kind: 'element',
        tag: token.name,
        attrs: token.attrs,
        children: [],
      };
      parent.children.push(element);
      if (
        !VOID_TAGS.has(token.name) &&
        !token.selfClosing &&
        stack.length < MAX_TREE_DEPTH
      ) {
        stack.push(element);
      }
      continue;
    }
    for (let index = stack.length - 1; index > 0; index -= 1) {
      if (stack[index]!.tag === token.name) {
        stack.length = index;
        break;
      }
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// Inline helpers
// ---------------------------------------------------------------------------

function canonicalizeMarks(marks: readonly Mark[]): Mark[] {
  const seen = new Set<MarkType>();
  const result: Mark[] = [];
  for (const mark of marks) {
    if (seen.has(mark.type)) continue;
    seen.add(mark.type);
    if (mark.type === 'link') {
      const href = mark.attrs?.href;
      if (href === undefined) continue;
      result.push({ type: 'link', attrs: { href } });
    } else {
      result.push({ type: mark.type });
    }
  }
  return result.sort(
    (left, right) =>
      MARK_TYPE_ORDER.indexOf(left.type) - MARK_TYPE_ORDER.indexOf(right.type),
  );
}

function marksKey(marks: readonly Mark[] | undefined): string {
  if (marks === undefined || marks.length === 0) return '';
  return canonicalizeMarks(marks)
    .map((mark) => `${mark.type}:${mark.attrs?.href ?? ''}`)
    .join('|');
}

function textNode(text: string, marks: readonly Mark[]): InlineNode | undefined {
  if (text === '') return undefined;
  const canonical = canonicalizeMarks(marks);
  if (canonical.length === 0) return { type: 'text', text };
  return { type: 'text', text, marks: canonical };
}

function inlineTextNodes(text: string, marks: readonly Mark[]): InlineNode[] {
  const collapsed = collapseWhitespace(text);
  if (collapsed === '') return [];
  const node = textNode(collapsed, marks);
  return node === undefined ? [] : [node];
}

function addSimpleMark(marks: readonly Mark[], type: MarkType): Mark[] {
  return canonicalizeMarks([...marks, { type }]);
}

function addLinkMark(marks: readonly Mark[], href: string): Mark[] {
  if (href === '' || href.length > MAX_HREF_LENGTH) return [...marks];
  return canonicalizeMarks([...marks, { type: 'link', attrs: { href } }]);
}

function safeHref(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const href = value.trim();
  if (href === '' || href.length > MAX_HREF_LENGTH) return undefined;
  if (SAFE_HREF.test(href)) return href;
  return undefined;
}

function mergeInline(nodes: readonly InlineNode[]): InlineNode[] {
  const result: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.text === '') continue;
      const last = result[result.length - 1];
      if (
        last !== undefined &&
        last.type === 'text' &&
        marksKey(last.marks) === marksKey(node.marks)
      ) {
        last.text += node.text;
        continue;
      }
      result.push(
        node.marks === undefined
          ? { type: 'text', text: node.text }
          : { type: 'text', text: node.text, marks: node.marks },
      );
      continue;
    }
    result.push({ type: 'hardBreak' });
  }
  return result;
}

/** Merge runs, trim edges, collapse breaks: the canonical inline payload. */
function normalizeRun(nodes: readonly InlineNode[]): InlineNode[] {
  const merged = mergeInline(nodes);

  while (merged.length > 0) {
    const first = merged[0]!;
    if (first.type !== 'text') break;
    const text = first.text.replace(/^ +/, '');
    if (text === '') {
      merged.shift();
      continue;
    }
    first.text = text;
    break;
  }
  while (merged.length > 0) {
    const last = merged[merged.length - 1]!;
    if (last.type !== 'text') break;
    const text = last.text.replace(/ +$/, '');
    if (text === '') {
      merged.pop();
      continue;
    }
    last.text = text;
    break;
  }

  const result: InlineNode[] = [];
  for (const node of merged) {
    if (node.type === 'hardBreak') {
      if (result.length === 0) continue;
      if (result[result.length - 1]!.type === 'hardBreak') continue;
      result.push(node);
      continue;
    }
    result.push(node);
  }
  while (result.length > 0 && result[result.length - 1]!.type === 'hardBreak') {
    result.pop();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Text / attribute helpers
// ---------------------------------------------------------------------------

function rawTextOf(node: HtmlNode): string {
  if (node.kind === 'text') return node.text;
  let text = '';
  for (const child of node.children) text += rawTextOf(child);
  return text;
}

function plainTextOf(node: HtmlNode): string {
  return collapseWhitespace(rawTextOf(node)).trim();
}

function firstAttr(
  el: HtmlElementNode,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = el.attrs[name];
    if (value !== undefined) {
      const trimmed = value.trim();
      if (trimmed !== '') return trimmed;
    }
  }
  return undefined;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

function findDescendantElement(
  el: HtmlElementNode,
  predicate: (candidate: HtmlElementNode) => boolean,
): HtmlElementNode | undefined {
  const queue: HtmlElementNode[] = [];
  for (const child of el.children) {
    if (isElementNode(child)) queue.push(child);
  }
  let cursor = 0;
  while (cursor < queue.length) {
    const candidate = queue[cursor]!;
    cursor += 1;
    if (predicate(candidate)) return candidate;
    for (const child of candidate.children) {
      if (isElementNode(child)) queue.push(child);
    }
  }
  return undefined;
}

const blockKindCache = new WeakMap<HtmlElementNode, boolean>();

/** Structural classification; unknown tags are block when they contain blocks. */
function isBlockElement(el: HtmlElementNode): boolean {
  if (BLOCK_TAGS.has(el.tag)) return true;
  if (INLINE_TAGS.has(el.tag)) return false;
  const cached = blockKindCache.get(el);
  if (cached !== undefined) return cached;
  const block = el.children.some(
    (child) => child.kind === 'element' && isBlockElement(child),
  );
  blockKindCache.set(el, block);
  return block;
}

function isImageElement(el: HtmlElementNode): boolean {
  return el.tag === 'img' || el.tag === 'image';
}

function looksLikeLocation(value: string): boolean {
  return /[/\\:]/.test(value) || /\.[A-Za-z0-9]{1,5}$/.test(value);
}

function fileNameOf(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  const segments = withoutQuery.split(/[/\\]/).filter((part) => part !== '');
  const last = segments[segments.length - 1];
  return last === undefined || last === '' ? value : last as string;
}

// ---------------------------------------------------------------------------
// Images / file chips / link cards
// ---------------------------------------------------------------------------

interface ResolvedImage {
  assetId: string;
  alt?: string;
  caption?: string;
  width?: string;
}

function normalizeAssetId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith('asset_') || value.length <= 'asset_'.length) return undefined;
  return value;
}

function imageWidth(el: HtmlElementNode): string | undefined {
  const width = (el.attrs.width ?? '').trim();
  if (/^\d{1,5}%$/.test(width)) return width;
  if (/^\d{1,5}$/.test(width)) return `${width}px`;
  if (/^\d{1,5}px$/.test(width)) return width;
  const style = el.attrs.style ?? '';
  const match = /(?:^|;)\s*width\s*:\s*([^;]{1,40})/i.exec(style);
  if (match !== null) {
    const value = match[1]!.trim();
    if (/^\d{1,5}(?:px|%)$/.test(value) && value.length <= MAX_IMAGE_WIDTH_LENGTH) {
      return value;
    }
  }
  return undefined;
}

function resolveImage(
  el: HtmlElementNode,
  options: LegacyHtmlParserOptions,
): ResolvedImage | undefined {
  const src = (el.attrs.src ?? el.attrs['data-src'] ?? '').trim();
  if (src === '' || !DATA_IMAGE_SRC.test(src)) return undefined;
  const assetId = normalizeAssetId(options.assetIdFor(src));
  if (assetId === undefined) return undefined;
  const alt = truncate((el.attrs.alt ?? '').trim(), MAX_ALT_LENGTH);
  const caption = truncate((el.attrs.title ?? '').trim(), MAX_CAPTION_LENGTH);
  const image: ResolvedImage = { assetId };
  if (alt !== '') image.alt = alt;
  if (caption !== '') image.caption = caption;
  const width = imageWidth(el);
  if (width !== undefined) image.width = width;
  return image;
}

function imagePlaceholderInline(
  el: HtmlElementNode,
  marks: readonly Mark[],
): InlineNode[] {
  const alt = (el.attrs.alt ?? '').trim();
  const label = alt === '' ? '[图片]' : `[图片: ${truncate(alt, 100)}]`;
  return inlineTextNodes(label, marks);
}

function isFileMarkerElement(el: HtmlElementNode): boolean {
  return el.attrs['data-file'] !== undefined;
}

function isLinkCardElement(el: HtmlElementNode): boolean {
  if (el.attrs['data-link-card'] !== undefined) return true;
  return /(?:^|\s)link-card(?:\s|$)/i.test(el.attrs.class ?? '');
}

function inlineFromFileMarker(
  el: HtmlElementNode,
  marks: readonly Mark[],
): InlineNode[] {
  const inner = plainTextOf(el);
  const explicitName = firstAttr(el, [
    'data-name',
    'data-filename',
    'data-title',
    'title',
  ]);
  const fileRef = firstAttr(el, ['data-file']) ?? '';
  const hrefSource =
    firstAttr(el, ['data-href', 'data-url', 'href']) ??
    (safeHref(fileRef) === undefined ? undefined : fileRef);
  const href = safeHref(hrefSource);
  let label = inner;
  if (label === '' && explicitName !== undefined) label = explicitName;
  if (label === '') {
    if (fileRef === '') label = '[文件]';
    else if (looksLikeLocation(fileRef)) label = fileNameOf(fileRef);
    else label = `[文件: ${truncate(fileRef, 120)}]`;
  }
  return inlineTextNodes(label, href === undefined ? marks : addLinkMark(marks, href));
}

function inlineFromLinkCard(
  el: HtmlElementNode,
  marks: readonly Mark[],
): InlineNode[] {
  const inner = plainTextOf(el);
  const title = firstAttr(el, ['data-title', 'data-name', 'title']);
  const nestedLink = findDescendantElement(
    el,
    (candidate) => candidate.tag === 'a' && firstAttr(candidate, ['href']) !== undefined,
  );
  const rawHref =
    firstAttr(el, ['data-href', 'data-url', 'href']) ??
    (nestedLink === undefined ? undefined : firstAttr(nestedLink, ['href']));
  const href = safeHref(rawHref);
  let label = inner;
  if (label === '' && title !== undefined) label = title;
  if (label === '' && href !== undefined) label = href;
  if (label === '') label = rawHref ?? '[链接]';
  return inlineTextNodes(label, href === undefined ? marks : addLinkMark(marks, href));
}

function inlineFromMarkerElement(
  el: HtmlElementNode,
  marks: readonly Mark[],
): InlineNode[] | undefined {
  if (isLinkCardElement(el)) return inlineFromLinkCard(el, marks);
  if (isFileMarkerElement(el)) return inlineFromFileMarker(el, marks);
  return undefined;
}

// ---------------------------------------------------------------------------
// Inline conversion
// ---------------------------------------------------------------------------

function convertInlineElement(
  el: HtmlElementNode,
  marks: readonly Mark[],
): InlineNode[] {
  const marker = inlineFromMarkerElement(el, marks);
  if (marker !== undefined) return marker;
  if (el.tag === 'br') return [{ type: 'hardBreak' }];
  if (el.tag === 'input' || el.tag === 'wbr') return [];
  if (isImageElement(el)) return imagePlaceholderInline(el, marks);
  if (el.tag === 'a') {
    const href = safeHref(el.attrs.href ?? el.attrs['data-href']);
    const nextMarks = href === undefined ? marks : addLinkMark(marks, href);
    return convertInlineNodes(el.children, nextMarks);
  }
  const markType = INLINE_MARK_TAGS.get(el.tag);
  if (markType !== undefined) {
    return convertInlineNodes(el.children, addSimpleMark(marks, markType));
  }
  return convertInlineNodes(el.children, marks);
}

function convertInlineNodes(
  nodes: readonly HtmlNode[],
  marks: readonly Mark[],
): InlineNode[] {
  const result: InlineNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      result.push(...inlineTextNodes(node.text, marks));
      continue;
    }
    if (isBlockElement(node)) {
      const inner = convertInlineNodes(node.children, marks);
      if (inner.length === 0) continue;
      if (result.length > 0 && result[result.length - 1]!.type !== 'hardBreak') {
        result.push({ type: 'hardBreak' });
      }
      result.push(...inner);
      continue;
    }
    result.push(...convertInlineElement(node, marks));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Block conversion state
// ---------------------------------------------------------------------------

interface ConvertState {
  options: LegacyHtmlParserOptions;
  blockCount: number;
  estimatedBytes: number;
  stopped: boolean;
  truncated: boolean;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function estimateInlineBytes(content: readonly InlineNode[]): number {
  let bytes = 0;
  for (const node of content) {
    if (node.type !== 'text') {
      bytes += 20;
      continue;
    }
    bytes += 40 + utf8Length(node.text);
    if (node.marks !== undefined) {
      for (const mark of node.marks) {
        bytes += 24;
        const href = mark.attrs?.href;
        if (href !== undefined) bytes += utf8Length(href);
      }
    }
  }
  return bytes;
}

function estimateBlockBytes(block: BlockNode): number {
  let bytes = 90 + block.id.length + block.type.length;
  bytes += JSON.stringify(block.attrs).length;
  if (block.content !== undefined) bytes += estimateInlineBytes(block.content);
  return bytes;
}

function makeBlock(
  state: ConvertState,
  type: string,
  attrs: Record<string, JsonValue> = {},
  content?: InlineNode[],
  children?: BlockNode[],
  force = false,
): BlockNode | undefined {
  const block: BlockNode = { id: state.options.createBlockId(), type, attrs };
  if (content !== undefined && content.length > 0) block.content = content;
  if (children !== undefined && children.length > 0) block.children = children;
  const cost = estimateBlockBytes(block);
  if (
    !force &&
    (state.stopped ||
      state.blockCount >= MAX_BLOCK_COUNT - 1 ||
      state.estimatedBytes + cost > MAX_ESTIMATED_BYTES)
  ) {
    if (!state.stopped) {
      state.stopped = true;
      state.truncated = true;
    }
    return undefined;
  }
  state.blockCount += 1;
  state.estimatedBytes += cost;
  return block;
}

function makeImageBlock(
  state: ConvertState,
  image: ResolvedImage,
): BlockNode | undefined {
  const attrs: Record<string, JsonValue> = { assetId: image.assetId };
  if (image.alt !== undefined) attrs.alt = image.alt;
  if (image.caption !== undefined) attrs.caption = image.caption;
  if (image.width !== undefined) attrs.width = image.width;
  return makeBlock(state, 'image', attrs);
}

// ---------------------------------------------------------------------------
// Block conversion
// ---------------------------------------------------------------------------

function convertBlocks(
  nodes: readonly HtmlNode[],
  state: ConvertState,
  depth: number,
): BlockNode[] {
  const blocks: BlockNode[] = [];
  let inline: InlineNode[] = [];
  const flush = (): void => {
    if (inline.length === 0) return;
    const content = normalizeRun(inline);
    inline = [];
    if (content.length === 0) return;
    const block = makeBlock(state, 'paragraph', {}, content);
    if (block !== undefined) blocks.push(block);
  };

  for (const node of nodes) {
    if (state.stopped) break;
    if (node.kind === 'text') {
      inline.push(...inlineTextNodes(node.text, []));
      continue;
    }
    if (isImageElement(node)) {
      const image = resolveImage(node, state.options);
      if (image === undefined) {
        inline.push(...imagePlaceholderInline(node, []));
        continue;
      }
      flush();
      const block = makeImageBlock(state, image);
      if (block !== undefined) blocks.push(block);
      continue;
    }
    if (isBlockElement(node)) {
      flush();
      blocks.push(...convertBlockElement(node, state, depth));
      continue;
    }
    inline.push(...convertInlineElement(node, []));
  }
  flush();
  return blocks;
}

/**
 * Convert a paragraph-like container: inline runs become paragraphs, images and
 * block children become sibling blocks. `forceEmptyParagraph` preserves empty
 * `<p>` (e.g. `<p><br></p>`) because it carries a blank line.
 */
function convertInlineContainer(
  el: HtmlElementNode,
  state: ConvertState,
  depth: number,
  forceEmptyParagraph: boolean,
): BlockNode[] {
  const blocks: BlockNode[] = [];
  let inline: InlineNode[] = [];
  const flush = (force: boolean): void => {
    const content = normalizeRun(inline);
    inline = [];
    if (content.length === 0 && !force) return;
    const block = makeBlock(
      state,
      'paragraph',
      {},
      content.length === 0 ? undefined : content,
    );
    if (block !== undefined) blocks.push(block);
  };

  for (const node of el.children) {
    if (state.stopped) break;
    if (node.kind === 'text') {
      inline.push(...inlineTextNodes(node.text, []));
      continue;
    }
    if (isImageElement(node)) {
      const image = resolveImage(node, state.options);
      if (image === undefined) {
        inline.push(...imagePlaceholderInline(node, []));
        continue;
      }
      flush(false);
      const block = makeImageBlock(state, image);
      if (block !== undefined) blocks.push(block);
      continue;
    }
    if (isBlockElement(node)) {
      flush(false);
      blocks.push(...convertBlockElement(node, state, depth));
      continue;
    }
    inline.push(...convertInlineElement(node, []));
  }
  flush(forceEmptyParagraph && blocks.length === 0);
  return blocks;
}

function hasBlockProducingChild(
  el: HtmlElementNode,
  state: ConvertState,
): boolean {
  return el.children.some((child) => {
    if (child.kind !== 'element') return false;
    if (isImageElement(child)) return resolveImage(child, state.options) !== undefined;
    return isBlockElement(child);
  });
}

function convertHeading(
  el: HtmlElementNode,
  state: ConvertState,
): BlockNode[] {
  const parsed = Number.parseInt(el.tag.slice(1), 10);
  const level = Number.isFinite(parsed) ? Math.min(6, Math.max(1, parsed)) : 1;
  const content = normalizeRun(convertInlineNodes(el.children, []));
  const block = makeBlock(
    state,
    'heading',
    { level },
    content.length === 0 ? undefined : content,
  );
  return block === undefined ? [] : [block];
}

function convertBlockquote(
  el: HtmlElementNode,
  state: ConvertState,
  depth: number,
): BlockNode[] {
  if (depth >= MAX_BLOCK_DEPTH) return convertBlocks(el.children, state, depth);
  const children = convertBlocks(el.children, state, depth + 1);
  const block = makeBlock(state, 'blockquote', {}, undefined, children);
  return block === undefined ? [] : [block];
}

function codeLanguageOf(el: HtmlElementNode): string | undefined {
  const fromClass = languageFromClass(el.attrs.class);
  if (fromClass !== undefined) return fromClass;
  const inner = el.attrs.__preLang;
  if (inner !== undefined && inner.length <= MAX_LANG_LENGTH) return inner;
  return undefined;
}

function convertPre(el: HtmlElementNode, state: ConvertState): BlockNode[] {
  let code = rawTextOf(el).replace(/\r\n?/g, '\n');
  if (code.startsWith('\n')) code = code.slice(1);
  if (code.endsWith('\n')) code = code.slice(0, -1);
  const attrs: Record<string, JsonValue> = {};
  const lang = codeLanguageOf(el);
  if (lang !== undefined) attrs.lang = lang;
  const content: InlineNode[] | undefined =
    code === '' ? undefined : [{ type: 'text', text: code }];
  const block = makeBlock(state, 'codeBlock', attrs, content);
  return block === undefined ? [] : [block];
}

function detectChecked(li: HtmlElementNode): boolean | undefined {
  const dataChecked = li.attrs['data-checked'];
  if (dataChecked !== undefined) {
    const normalized = dataChecked.trim().toLowerCase();
    return normalized !== 'false' && normalized !== '0';
  }
  const input = findDescendantElement(
    li,
    (candidate) =>
      candidate.tag === 'input' &&
      (candidate.attrs.type ?? '').trim().toLowerCase() === 'checkbox',
  );
  if (input === undefined) return undefined;
  return input.attrs.checked !== undefined;
}

function convertListItem(
  li: HtmlElementNode,
  state: ConvertState,
  itemDepth: number,
): BlockNode | undefined {
  const checked = detectChecked(li);
  const children = convertBlocks(li.children, state, itemDepth + 1);
  const attrs: Record<string, JsonValue> = checked === undefined ? {} : { checked };
  return makeBlock(state, 'listItem', attrs, undefined, children);
}

function orderedListStart(el: HtmlElementNode): number {
  const raw = (el.attrs.start ?? '').trim();
  if (!/^-?\d{1,7}$/.test(raw)) return 1;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 1;
}

function convertList(
  el: HtmlElementNode,
  state: ConvertState,
  depth: number,
): BlockNode[] {
  const ordered = el.tag === 'ol';
  if (depth + 2 > MAX_BLOCK_DEPTH) {
    const flattened: BlockNode[] = [];
    for (const child of el.children) {
      if (state.stopped) break;
      if (child.kind === 'element' && child.tag === 'li') {
        flattened.push(...convertBlocks(child.children, state, depth));
      } else {
        flattened.push(...convertBlocks([child], state, depth));
      }
    }
    return flattened;
  }

  const items: BlockNode[] = [];
  let pending: HtmlNode[] = [];
  const flushPending = (): void => {
    if (pending.length === 0) return;
    const children = convertBlocks(pending, state, depth + 2);
    pending = [];
    if (children.length === 0) return;
    const item = makeBlock(state, 'listItem', {}, undefined, children);
    if (item !== undefined) items.push(item);
  };

  for (const child of el.children) {
    if (state.stopped) break;
    if (child.kind === 'element' && child.tag === 'li') {
      flushPending();
      const item = convertListItem(child, state, depth + 1);
      if (item !== undefined) items.push(item);
      continue;
    }
    pending.push(child);
  }
  flushPending();
  if (items.length === 0) return [];

  const attrs: Record<string, JsonValue> = {};
  if (ordered) {
    const start = orderedListStart(el);
    if (start !== 1) attrs.start = start;
  }
  const list = makeBlock(
    state,
    ordered ? 'orderedList' : 'bulletList',
    attrs,
    undefined,
    items,
  );
  return list === undefined ? [] : [list];
}

function captionParagraphs(
  captions: readonly HtmlElementNode[],
  state: ConvertState,
): BlockNode[] {
  const blocks: BlockNode[] = [];
  for (const caption of captions) {
    const text = plainTextOf(caption);
    if (text === '') continue;
    const block = makeBlock(state, 'paragraph', {}, [{ type: 'text', text }]);
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

function convertTableCell(
  cell: HtmlElementNode,
  state: ConvertState,
): BlockNode | undefined {
  const content = normalizeRun(convertInlineNodes(cell.children, []));
  return makeBlock(state, 'tableCell', {}, content.length === 0 ? undefined : content);
}

function convertTable(
  el: HtmlElementNode,
  state: ConvertState,
  depth: number,
): BlockNode[] {
  const captions: HtmlElementNode[] = [];
  const rows: Array<{ el: HtmlElementNode; inHead: boolean }> = [];
  const collect = (parent: HtmlElementNode, inHead: boolean): void => {
    for (const child of parent.children) {
      if (child.kind !== 'element') continue;
      if (child.tag === 'caption') {
        captions.push(child);
        continue;
      }
      if (child.tag === 'tr') {
        rows.push({ el: child, inHead });
        continue;
      }
      if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
        collect(child, inHead || child.tag === 'thead');
      }
    }
  };
  collect(el, false);

  if (rows.length === 0 || depth + 2 > MAX_BLOCK_DEPTH) {
    return convertBlocks(el.children, state, depth);
  }

  const headerFlags: boolean[] = [];
  const rowBlocks: BlockNode[] = [];
  for (const row of rows) {
    if (state.stopped) break;
    const cells = row.el.children.filter(
      (child): child is HtmlElementNode =>
        child.kind === 'element' && (child.tag === 'td' || child.tag === 'th'),
    );
    headerFlags.push(
      row.inHead || (cells.length > 0 && cells.every((cell) => cell.tag === 'th')),
    );
    const cellBlocks: BlockNode[] = [];
    for (const cell of cells) {
      if (state.stopped) break;
      const cellBlock = convertTableCell(cell, state);
      if (cellBlock !== undefined) cellBlocks.push(cellBlock);
    }
    const rowBlock = makeBlock(state, 'tableRow', {}, undefined, cellBlocks);
    if (rowBlock !== undefined) rowBlocks.push(rowBlock);
  }

  let headerRows = 0;
  for (const flag of headerFlags) {
    if (!flag) break;
    headerRows += 1;
  }
  headerRows = Math.min(headerRows, rowBlocks.length);

  const blocks: BlockNode[] = [];
  if (rowBlocks.length > 0) {
    const table = makeBlock(state, 'table', { headerRows }, undefined, rowBlocks);
    if (table !== undefined) blocks.push(table);
  }
  blocks.push(...captionParagraphs(captions, state));
  return blocks;
}

function convertBlockElement(
  el: HtmlElementNode,
  state: ConvertState,
  depth: number,
): BlockNode[] {
  if (state.stopped) return [];
  const marker = inlineFromMarkerElement(el, []);
  if (marker !== undefined) {
    const block = makeBlock(
      state,
      'paragraph',
      {},
      marker.length === 0 ? undefined : marker,
    );
    return block === undefined ? [] : [block];
  }

  switch (el.tag) {
    case 'p':
      return convertInlineContainer(el, state, depth, true);
    case 'div': {
      if (hasBlockProducingChild(el, state)) {
        return convertBlocks(el.children, state, depth);
      }
      return convertInlineContainer(el, state, depth, true);
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return convertHeading(el, state);
    case 'ul':
    case 'ol':
      return convertList(el, state, depth);
    case 'blockquote':
      return convertBlockquote(el, state, depth);
    case 'pre':
      return convertPre(el, state);
    case 'hr': {
      const block = makeBlock(state, 'divider');
      return block === undefined ? [] : [block];
    }
    case 'table':
      return convertTable(el, state, depth);
    case 'dt':
    case 'dd':
      return convertInlineContainer(el, state, depth, false);
    default:
      if (isBlockElement(el)) return convertBlocks(el.children, state, depth);
      return convertInlineContainer(el, state, depth, false);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Convert one legacy contentEditable HTML body into Alter AST blocks.
 *
 * The conversion is tolerant: malformed markup, unclosed tags, unknown tags
 * and non-representable structures degrade to text/paragraphs instead of
 * failing. Inline data-URL images become `image` blocks only when
 * `assetIdFor` resolves them; otherwise they become text placeholders.
 *
 * @param html - legacy HTML fragment (or a whole document).
 * @param options - block id allocator and imported-asset lookup.
 * @returns validated top-level blocks (may be empty).
 */
export function parseLegacyHtml(
  html: string,
  options: LegacyHtmlParserOptions,
): BlockNode[] {
  const tokens = tokenize(typeof html === 'string' ? html : '');
  const root = buildDom(tokens);
  const state: ConvertState = {
    options,
    blockCount: 0,
    estimatedBytes: 0,
    stopped: false,
    truncated: false,
  };

  const blocks = convertBlocks(root.children, state, 1);
  if (state.truncated) {
    const note = makeBlock(
      state,
      'paragraph',
      {},
      [{ type: 'text', text: TRUNCATION_NOTE }],
      undefined,
      true,
    );
    if (note !== undefined) blocks.push(note);
  }

  validateAlterDoc({
    format: ALTER_DOC_FORMAT,
    schemaVersion: ALTER_DOC_SCHEMA_VERSION,
    revision: 0,
    blocks,
  });
  return blocks;
}
