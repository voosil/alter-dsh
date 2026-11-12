/**
 * Paste and drop parity with the frozen editor.
 *
 * The frozen editor owned clipboard handling with a hand-written sanitizer; it
 * was retired with the old contentEditable kernel, so its behaviour survives as
 * the acceptance baseline. The AST kernel cannot insert frozen DOM — its
 * document is a ProseMirror tree — so the pipeline is:
 *
 * 1. sanitize clipboard HTML with the frozen whitelist (dangerous elements,
 *    event handlers and URLs dropped; `B`/`I`/`DEL`/`STRIKE` normalized;
 *    `H4-H6` degrade to paragraphs; unknown wrappers unwrapped);
 * 2. upload any `data:` image/file payload through {@link importAsset} first
 *    (the Host rejects inline base64 in the AST), then resolve those payloads
 *    while converting the sanitized HTML through the frozen-editor HTML → AST parser
 *    (`src/document/runtime/html-parser.ts`) and the AST → ProseMirror
 *    converter;
 * 3. insert the resulting blocks at the caret (paste) or drop point (drop).
 *
 * Plain text keeps the frozen link gestures: a document URL becomes a
 * `docLink`, a lone web URL becomes an inline web link, and everything else is
 * inserted as text (drag-in text deliberately does **not** linkify, matching
 * `E:2229-2235`).
 *
 * @module @alter-dsh/space/document/editors/tiptap/paste
 */
import { Extension, type AnyExtension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { JSONContent } from '@tiptap/core';
import type { EditorKernelProps } from '../kernel';
import { parseEditorHtml } from '../../runtime/html-parser';
import { blocksToPmDoc } from './convert';

/** Plugin key of the paste/drop plugin. */
export const pastePluginKey = new PluginKey('alterSpacePaste');

/** Options of {@link createPasteExtension}. */
export interface PasteExtensionOptions {
  /** Upload one pasted/dropped file as an asset. */
  importAsset?: EditorKernelProps['importAsset'];
  /** Report a degraded interaction instead of hiding it (page toast). */
  onNotice?: (message: string) => void;
  /**
   * Whether one document id exists (the frozen editor only inserts a doc link
   * for a known document).
   *
   * The kernel has no document catalog, so the default accepts any well-formed
   * id; the page can narrow it by wiring the lookup.
   */
  hasDoc?: (docId: string) => boolean;
}

/** Result of one sanitize pass (frozen `SanitizedPaste`). */
export interface SanitizedPaste {
  /** Safe HTML in the frozen editor's DOM syntax; empty when nothing usable. */
  html: string;
  /** Some content was dropped or simplified and should be reported. */
  simplified: boolean;
  /** Nothing usable survived (e.g. only scripts). */
  empty: boolean;
}

/** Removed with their whole subtree for security; never worth a notice. */
const SILENT_DROP = new Set([
  'SCRIPT',
  'STYLE',
  'HEAD',
  'TITLE',
  'NOSCRIPT',
  'TEMPLATE',
  'LINK',
  'META',
  'BASE',
  'SVG',
  'CANVAS',
]);

/** Unsupported media/controls: dropped and reported as simplified content. */
const LOSSY_DROP = new Set([
  'IFRAME',
  'FRAME',
  'FRAMESET',
  'OBJECT',
  'EMBED',
  'APPLET',
  'VIDEO',
  'AUDIO',
  'SOURCE',
  'TRACK',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'BUTTON',
  'PARAM',
  'KEYGEN',
  'BGSOUND',
]);

/** Block tags kept in the sanitized output (frozen editor DOM syntax). */
const KEEP_BLOCK = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TH',
  'TD',
  'HR',
]);

/** Inline tags kept as-is (semantics match the frozen editor's marks). */
const KEEP_INLINE = new Set([
  'STRONG',
  'B',
  'EM',
  'I',
  'U',
  'S',
  'DEL',
  'STRIKE',
  'CODE',
  'MARK',
  'A',
  'IMG',
  'BR',
]);

/** Links accepted by the document model (aligned with the frozen-editor parser). */
const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;
/** Images: remote http(s) or inline bitmap data URLs only (no SVG). */
const SAFE_IMAGE_SRC =
  /^(?:https?:\/\/|data:image\/(?:png|jpeg|webp|gif);base64,)/i;
/** Attachment chips: inline base64 payloads of non-executable types. */
const SAFE_FILE_HREF = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;
const UNSAFE_FILE_MIME =
  /^data:(?:text\/html|text\/javascript|application\/javascript|image\/svg\+xml)/i;
const LANGUAGE_CLASS = /^language-([A-Za-z0-9_+#.-]{1,32})$/;
const WEB_URL = /^https?:\/\/\S+$/i;
/** Inline media that the AST can only represent as its own block. */
const INLINE_MEDIA_SELECTOR =
  'img, span[data-file], a[data-link-card], a[data-doc-link]';

function isSafeHref(value: string): boolean {
  return SAFE_HREF.test(value.trim());
}

function isSafeImageSrc(value: string): boolean {
  return SAFE_IMAGE_SRC.test(value.trim());
}

function isSafeFileHref(value: string): boolean {
  const trimmed = value.trim();
  return SAFE_FILE_HREF.test(trimmed) && !UNSAFE_FILE_MIME.test(trimmed);
}

function isWebUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!WEB_URL.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Append the sanitized children of `source` into `target`. */
function sanitizeChildren(
  source: Element,
  target: Node,
  state: { simplified: boolean },
): void {
  for (const child of [...source.childNodes]) {
    sanitizeNode(child, target, state);
  }
}

/** Sanitize one node into `target` (frozen whitelist behavior). */
function sanitizeNode(
  source: Node,
  target: Node,
  state: { simplified: boolean },
): void {
  if (source.nodeType === Node.TEXT_NODE) {
    target.appendChild(document.createTextNode(source.textContent ?? ''));
    return;
  }
  if (source.nodeType !== Node.ELEMENT_NODE) return;
  const element = source as HTMLElement;
  const tag = element.tagName.toUpperCase();

  if (SILENT_DROP.has(tag)) return;
  if (LOSSY_DROP.has(tag)) {
    state.simplified = true;
    return;
  }

  // Legacy card/block syntax: preserved when pasting inside the editor.
  if (tag === 'DIV' && element.dataset['todo'] !== undefined) {
    sanitizeTodo(element, target, state);
    return;
  }
  if (tag === 'DIV' && element.dataset['divider'] !== undefined) {
    const divider = document.createElement('div');
    divider.dataset['divider'] = '';
    divider.setAttribute('contenteditable', 'false');
    divider.appendChild(document.createElement('hr'));
    target.appendChild(divider);
    return;
  }
  if (tag === 'SPAN' && element.dataset['file'] !== undefined) {
    sanitizeFileChip(element, target, state);
    return;
  }
  if (tag === 'A') {
    sanitizeAnchor(element, target, state);
    return;
  }
  if (tag === 'IMG') {
    sanitizeImage(element, target);
    return;
  }
  if (tag === 'PRE') {
    sanitizeCodeBlock(element, target);
    return;
  }
  if (tag === 'H4' || tag === 'H5' || tag === 'H6') {
    // The legacy UI only supports H1-H3; keep the text as a paragraph.
    state.simplified = true;
    const paragraph = document.createElement('p');
    sanitizeChildren(element, paragraph, state);
    target.appendChild(paragraph);
    return;
  }
  if (tag === 'DIV') {
    // A plain div is a structural wrapper: blocks inside stay blocks, an
    // inline-only div becomes one paragraph.
    const hasBlockChild = [...element.children].some((child) =>
      KEEP_BLOCK.has(child.tagName.toUpperCase()),
    );
    if (hasBlockChild || (element.textContent ?? '').trim() === '') {
      sanitizeChildren(element, target, state);
    } else {
      const paragraph = document.createElement('p');
      sanitizeChildren(element, paragraph, state);
      target.appendChild(paragraph);
    }
    return;
  }
  if (KEEP_BLOCK.has(tag)) {
    sanitizeBlock(element, tag, target, state);
    return;
  }
  if (KEEP_INLINE.has(tag)) {
    sanitizeInline(element, tag, target, state);
    return;
  }
  // Unknown element: keep its content, drop the wrapper.
  sanitizeChildren(element, target, state);
}

/** Preserve one `[data-todo]` block (checkbox + text) in frozen editor syntax. */
function sanitizeTodo(
  element: HTMLElement,
  target: Node,
  state: { simplified: boolean },
): void {
  const todo = document.createElement('div');
  todo.dataset['todo'] = '';
  todo.dataset['checked'] =
    element.dataset['checked'] === 'true' ? 'true' : 'false';
  const box = document.createElement('span');
  box.dataset['todoBox'] = '';
  box.setAttribute('contenteditable', 'false');
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', todo.dataset['checked']!);
  box.setAttribute('aria-label', '待办事项');
  box.setAttribute('tabindex', '0');
  const text = document.createElement('span');
  text.dataset['todoText'] = '';
  const source = element.querySelector('[data-todo-text]') ?? element;
  sanitizeChildren(source, text, state);
  if (text.childNodes.length === 0) text.appendChild(document.createElement('br'));
  todo.append(box, text);
  target.appendChild(todo);
}

/** Preserve one `[data-file]` attachment chip in frozen editor syntax. */
function sanitizeFileChip(
  element: HTMLElement,
  target: Node,
  state: { simplified: boolean },
): void {
  const name = (element.dataset['file'] ?? '').trim();
  const href = element.dataset['href'] ?? '';
  if (name === '' || !isSafeFileHref(href)) {
    // Unsupported attachment: keep its text, drop the executable reference.
    state.simplified = true;
    sanitizeChildren(element, target, state);
    return;
  }
  const chip = document.createElement('span');
  chip.dataset['file'] = name;
  chip.dataset['href'] = href;
  const size = element.dataset['size'];
  if (size !== undefined && /^[\d.]+ ?(?:B|KB|MB)$/.test(size)) {
    chip.dataset['size'] = size;
  }
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute('role', 'link');
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('aria-label', `打开文件 ${name}`);
  chip.setAttribute('title', name);
  const icon = document.createElement('span');
  icon.dataset['fileIcon'] = '';
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('contenteditable', 'false');
  const label = document.createElement('span');
  const text = (element.textContent ?? '').trim();
  label.textContent = text === '' ? name : text;
  chip.append(icon, label);
  target.appendChild(chip);
}

/** Sanitize one link, card or document link. */
function sanitizeAnchor(
  element: HTMLElement,
  target: Node,
  state: { simplified: boolean },
): void {
  const docId = element.dataset['docLink'];
  if (docId !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(docId)) {
      state.simplified = true;
      sanitizeChildren(element, target, state);
      return;
    }
    const link = document.createElement('a');
    link.dataset['docLink'] = docId;
    link.setAttribute('contenteditable', 'false');
    const href = element.getAttribute('href') ?? '';
    link.setAttribute('href', isSafeHref(href) ? href : '#');
    link.textContent = (element.textContent ?? '').trim() || docId;
    target.appendChild(link);
    return;
  }
  const cardUrl = element.dataset['linkCard'];
  if (cardUrl !== undefined) {
    if (!isWebUrl(cardUrl)) {
      state.simplified = true;
      sanitizeChildren(element, target, state);
      return;
    }
    const url = cardUrl.trim();
    const link = document.createElement('a');
    link.dataset['linkCard'] = url;
    link.dataset['href'] = url;
    link.setAttribute('href', url);
    link.setAttribute('contenteditable', 'false');
    const title = document.createElement('strong');
    title.textContent =
      (element.querySelector('strong')?.textContent ?? '').trim() ||
      webMetadataTitle(url);
    const description = document.createElement('span');
    description.textContent =
      (element.querySelector('span')?.textContent ?? '').trim() || url;
    link.append(title, description);
    target.appendChild(link);
    return;
  }
  if (element.dataset['webLink'] !== undefined) {
    const href = element.getAttribute('href') ?? '';
    if (!isWebUrl(href)) {
      state.simplified = true;
      sanitizeChildren(element, target, state);
      return;
    }
    const link = document.createElement('a');
    link.dataset['webLink'] = '';
    link.setAttribute('href', href.trim());
    link.setAttribute('contenteditable', 'false');
    link.textContent = (element.textContent ?? '').trim() || href.trim();
    target.appendChild(link);
    return;
  }
  const href = element.getAttribute('href') ?? '';
  if (!isSafeHref(href)) {
    // Unsafe link: keep the text, drop the target (visible degradation).
    state.simplified = true;
    sanitizeChildren(element, target, state);
    return;
  }
  const link = document.createElement('a');
  link.setAttribute('href', href.trim());
  const title = element.getAttribute('title');
  if (title !== null && title.trim() !== '') link.setAttribute('title', title);
  sanitizeChildren(element, link, state);
  target.appendChild(link);
}

/** Keep a safe image; dangerous sources are dropped (no text to preserve). */
function sanitizeImage(element: HTMLElement, target: Node): void {
  const src = (element.getAttribute('src') ?? '').trim();
  if (!isSafeImageSrc(src)) return;
  const image = document.createElement('img');
  image.setAttribute('src', src);
  const alt = element.getAttribute('alt');
  if (alt !== null && alt.trim() !== '') image.setAttribute('alt', alt);
  const title = element.getAttribute('title');
  if (title !== null && title.trim() !== '') image.setAttribute('title', title);
  const width = element.getAttribute('width');
  if (width !== null && /^\d{1,4}(?:px|%)?$/.test(width.trim())) {
    image.setAttribute('width', width.trim());
  }
  target.appendChild(image);
}

/** Flatten one pre/code block into the legacy `<pre><code>` syntax. */
function sanitizeCodeBlock(element: HTMLElement, target: Node): void {
  const nested = element.querySelector('code');
  const text = ((nested ?? element).textContent ?? '').replaceAll('\u200b', '');
  const pre = document.createElement('pre');
  const fromAttribute = (element.dataset['lang'] ?? '').trim();
  const fromClass = (nested?.getAttribute('class') ?? '')
    .split(/\s+/)
    .map((item) => LANGUAGE_CLASS.exec(item)?.[1] ?? '')
    .find((item) => item !== '');
  const lang = fromAttribute !== '' ? fromAttribute : fromClass;
  if (lang !== undefined && /^[A-Za-z0-9_+#.-]{1,32}$/.test(lang)) {
    pre.dataset['lang'] = lang;
  }
  const code = document.createElement('code');
  code.textContent = text;
  pre.appendChild(code);
  target.appendChild(pre);
}

/** Sanitize one kept block element. */
function sanitizeBlock(
  element: HTMLElement,
  tag: string,
  target: Node,
  state: { simplified: boolean },
): void {
  if (tag === 'HR') {
    target.appendChild(document.createElement('hr'));
    return;
  }
  if (tag === 'TABLE') {
    sanitizeTable(element, target, state);
    return;
  }
  if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
    const section = document.createElement(tag.toLowerCase());
    sanitizeRows(element, section, state);
    target.appendChild(section);
    return;
  }
  if (tag === 'TR') {
    const row = document.createElement('tr');
    sanitizeCells(element, row, state);
    target.appendChild(row);
    return;
  }
  if (tag === 'TH' || tag === 'TD') {
    const cell = document.createElement(tag.toLowerCase());
    for (const attr of ['colspan', 'rowspan']) {
      const value = element.getAttribute(attr);
      if (value !== null && /^\d{1,2}$/.test(value.trim())) {
        cell.setAttribute(attr, value.trim());
      }
    }
    sanitizeChildren(element, cell, state);
    if (cell.childNodes.length === 0) cell.appendChild(document.createElement('br'));
    target.appendChild(cell);
    return;
  }
  if (tag === 'UL' || tag === 'OL') {
    const list = document.createElement(tag.toLowerCase());
    const start = element.getAttribute('start');
    if (tag === 'OL' && start !== null && /^\d{1,4}$/.test(start.trim())) {
      list.setAttribute('start', start.trim());
    }
    for (const child of [...element.children]) {
      const childTag = child.tagName.toUpperCase();
      if (childTag === 'UL' || childTag === 'OL') {
        // Nested lists are legitimate list content in the AST.
        sanitizeBlock(child as HTMLElement, childTag, list, state);
        continue;
      }
      if (childTag !== 'LI') {
        state.simplified = true;
        continue;
      }
      sanitizeBlock(child as HTMLElement, 'LI', list, state);
    }
    target.appendChild(list);
    return;
  }
  const block = document.createElement(tag.toLowerCase());
  sanitizeChildren(element, block, state);
  target.appendChild(block);
}

/** Sanitize a table body into rows/cells only. */
function sanitizeTable(
  element: HTMLElement,
  target: Node,
  state: { simplified: boolean },
): void {
  const table = document.createElement('table');
  for (const child of [...element.children]) {
    const tag = child.tagName.toUpperCase();
    if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
      const section = document.createElement(tag.toLowerCase());
      sanitizeRows(child, section, state);
      table.appendChild(section);
    } else if (tag === 'TR') {
      const row = document.createElement('tr');
      sanitizeCells(child, row, state);
      table.appendChild(row);
    } else if (tag === 'CAPTION') {
      // Captions have no AST representation.
      state.simplified = true;
    } else {
      state.simplified = true;
    }
  }
  target.appendChild(table);
}

function sanitizeRows(
  element: Element,
  target: Node,
  state: { simplified: boolean },
): void {
  for (const child of [...element.children]) {
    if (child.tagName.toUpperCase() !== 'TR') {
      state.simplified = true;
      continue;
    }
    const row = document.createElement('tr');
    sanitizeCells(child, row, state);
    target.appendChild(row);
  }
}

function sanitizeCells(
  row: Element,
  target: Node,
  state: { simplified: boolean },
): void {
  for (const cell of [...row.children]) {
    const tag = cell.tagName.toUpperCase();
    if (tag !== 'TD' && tag !== 'TH') {
      state.simplified = true;
      continue;
    }
    sanitizeBlock(cell as HTMLElement, tag, target, state);
  }
}

/** Sanitize one kept inline element (normalizing B/I/DEL/STRIKE). */
function sanitizeInline(
  element: HTMLElement,
  tag: string,
  target: Node,
  state: { simplified: boolean },
): void {
  if (tag === 'BR') {
    target.appendChild(document.createElement('br'));
    return;
  }
  if (tag === 'A') {
    sanitizeAnchor(element, target, state);
    return;
  }
  if (tag === 'IMG') {
    sanitizeImage(element, target);
    return;
  }
  const map: Record<string, string> = {
    STRONG: 'strong',
    B: 'strong',
    EM: 'em',
    I: 'em',
    U: 'u',
    S: 's',
    DEL: 's',
    STRIKE: 's',
    CODE: 'code',
    MARK: 'mark',
  };
  const inline = document.createElement(map[tag] ?? 'span');
  sanitizeChildren(element, inline, state);
  target.appendChild(inline);
}

/**
 * Sanitize clipboard HTML into the frozen editor's DOM syntax.
 *
 * Security: only allowlisted elements/attributes survive; scripts, styles,
 * frames, embeds, forms and controls are removed, no `on*` attribute is copied
 * and dangerous `href`/`src` schemes are dropped. Unsupported rich structures
 * keep their text and set `simplified` so the caller can surface a notice.
 */
export function sanitizePastedHtml(html: string): SanitizedPaste {
  if (typeof DOMParser === 'undefined') {
    return { html: '', simplified: true, empty: true };
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const state = { simplified: false };
  const output = document.createElement('div');
  for (const child of [...parsed.body.childNodes]) {
    sanitizeNode(child, output, state);
  }
  // Top-level inline runs need one paragraph wrapper each.
  const normalized = document.createElement('div');
  let paragraph: HTMLParagraphElement | null = null;
  for (const node of [...output.childNodes]) {
    const isBlock =
      node.nodeType === Node.ELEMENT_NODE &&
      (KEEP_BLOCK.has((node as Element).tagName.toUpperCase()) ||
        (node as Element).tagName.toUpperCase() === 'DIV');
    if (isBlock) {
      paragraph = null;
      normalized.appendChild(node);
      continue;
    }
    if (paragraph === null) {
      paragraph = document.createElement('p');
      normalized.appendChild(paragraph);
    }
    paragraph.appendChild(node);
  }
  for (const element of [...normalized.querySelectorAll('p')]) {
    if (
      (element.textContent ?? '').trim() === '' &&
      element.childNodes.length === 0
    ) {
      element.remove();
    }
  }
  const empty =
    normalized.childNodes.length === 0 ||
    ((normalized.textContent ?? '').trim() === '' &&
      normalized.querySelector(
        'img,hr,table,ul,ol,pre,[data-todo],[data-divider],[data-file],[data-link-card],[data-doc-link]',
      ) === null);
  return {
    html: normalized.innerHTML,
    simplified: state.simplified,
    empty,
  };
}

/**
 * Split paragraphs so inline media becomes its own top-level block.
 *
 * The frozen editor keeps `<img>` and file chips inline; the AST represents
 * images, files and link/document cards as blocks only. Splitting the paragraph
 * around them preserves the reading order instead of degrading the media to a
 * placeholder run inside the sentence.
 */
function hoistInlineMedia(root: HTMLElement): void {
  for (const child of [...root.children]) {
    if (child.tagName !== 'P') continue;
    if (child.querySelector(INLINE_MEDIA_SELECTOR) === null) continue;
    if (![...child.childNodes].some((node) => isInlineMediaNode(node))) {
      // Media nested under an inline wrapper is left to the parser's visible
      // placeholder path rather than restructuring arbitrary markup.
      continue;
    }
    const parts: Node[] = [];
    let run: Node[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const clone = child.cloneNode(false) as HTMLElement;
      clone.append(...run);
      run = [];
      if ((clone.textContent ?? '').trim() === '' && clone.querySelector('br') === null) {
        return;
      }
      parts.push(clone);
    };
    for (const node of [...child.childNodes]) {
      if (isInlineMediaNode(node)) {
        flush();
        parts.push(node);
        continue;
      }
      run.push(node);
    }
    flush();
    if (parts.length > 0) child.replaceWith(...parts);
  }
}

/** True when one node is inline media the AST must host as its own block. */
function isInlineMediaNode(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (element.matches(INLINE_MEDIA_SELECTOR)) return true;
  return false;
}

/** Uploaded asset metadata returned by the page's asset pipeline. */
type ImportedAsset = {
  assetId: string;
  mime: string;
  bytes: number;
  name?: string;
};

/** Title used by the frozen `webMetadata` for an inline web link. */
function webMetadataTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Extract a document id from a pasted document URL (frozen parser). */
export function documentIdFromPaste(text: string): string | null {
  const trimmed = text.trim();
  const match =
    trimmed.match(/#\/space\/[^/\s]+\/doc\/([^/\s?#]+)/) ??
    trimmed.match(/alter:\/\/doc\/([^/\s?#]+)/);
  return match?.[1] ?? null;
}

/** Read one clipboard `File` as a data URL (rejections resolve to null). */
function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof FileReader === 'undefined') {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '')); 
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Parse the mime and base64 payload of a data URL. */
function parseDataUrl(
  url: string,
): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/i.exec(url.trim());
  if (match === null) return null;
  return { mime: match[1] ?? 'application/octet-stream', base64: match[2] ?? '' };
}

/**
 * User-facing message for a failed upload: the Host's reason when it has one.
 *
 * The page forwards the Host RPC error message unchanged (e.g.
 * 「文件超过 8 MiB 上限（…）」); only a rejection without a message falls back to
 * the generic line, so a real failure is never hidden behind "上传失败".
 */
function uploadFailureNotice(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message.trim();
  }
  return fallback;
}

/** Upload one data URL through the page's asset pipeline. */
async function uploadDataUrl(
  dataUrl: string,
  kind: 'image' | 'file',
  name: string | undefined,
  options: PasteExtensionOptions,
): Promise<ImportedAsset | null> {
  const parsed = parseDataUrl(dataUrl);
  if (parsed === null) {
    options.onNotice?.(`该文件类型不支持：${name ?? '未知文件'}`);
    return null;
  }
  if (options.importAsset === undefined) {
    options.onNotice?.(`当前无法上传附件：${name ?? parsed.mime}`);
    return null;
  }
  try {
    return await options.importAsset({
      kind,
      mime: parsed.mime,
      dataBase64: parsed.base64,
      ...(name === undefined ? {} : { name }),
    });
  } catch (error) {
    options.onNotice?.(
      uploadFailureNotice(error, `文件上传失败：${name ?? parsed.mime}`),
    );
    return null;
  }
}

/** Image node JSON for one uploaded asset. */
function imageJson(asset: ImportedAsset, alt: string | undefined): JSONContent {
  return {
    type: 'image',
    attrs: {
      assetId: asset.assetId,
      ...(alt === undefined || alt === '' ? {} : { alt }),
    },
  };
}

/** File node JSON for one uploaded asset. */
function fileJson(
  asset: ImportedAsset,
  fallbackName: string,
): JSONContent {
  return {
    type: 'file',
    attrs: {
      assetId: asset.assetId,
      // The Host requires a non-empty name; an unnamed clipboard file still
      // gets a visible label instead of producing an invalid block.
      name: asset.name ?? (fallbackName.trim() === '' ? '未命名文件' : fallbackName),
      mime: asset.mime,
      bytes: asset.bytes,
    },
  };
}

/**
 * Insert one JSON node at `target`; returns the position after it.
 *
 * Files are block atoms, so the next file must go after the node just inserted
 * (a range would replace it). The live selection end is exactly that boundary,
 * including when the command leaves a `NodeSelection` on the new block.
 */
function insertJson(
  editor: Editor,
  node: JSONContent,
  target: { from: number; to: number } | number,
): number {
  editor.chain().focus().insertContentAt(target, node).run();
  const { from, to } = editor.state.selection;
  return Math.max(from, to);
}

/** Insert one list of files serially, upload-and-insert per file (frozen order). */
async function insertFiles(
  editor: Editor,
  files: readonly File[],
  target: { from: number; to: number } | number,
  options: PasteExtensionOptions,
): Promise<void> {
  let next = target;
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    if (dataUrl === null || dataUrl === '') {
      options.onNotice?.(`该文件类型不支持：${file.name}`);
      continue;
    }
    const kind: 'image' | 'file' = file.type.startsWith('image/')
      ? 'image'
      : 'file';
    const asset = await uploadDataUrl(
      dataUrl,
      kind,
      file.name === '' ? undefined : file.name,
      options,
    );
    if (asset === null) continue;
    const node =
      kind === 'image'
        ? imageJson(asset, file.name === '' ? undefined : file.name)
        : fileJson(asset, file.name);
    try {
      next = insertJson(editor, node, next);
    } catch {
      // An insert can fail if the document changed while uploading; retry once
      // at the live caret rather than dropping the uploaded asset silently.
      try {
        next = insertJson(editor, node, editor.state.selection.from);
      } catch {
        options.onNotice?.(
          `文件插入失败：${node.attrs?.['name'] ?? node.type ?? '附件'}`,
        );
      }
    }
  }
}

/** Convert one sanitized frozen-editor HTML fragment into insertable JSON content. */
function htmlToContent(
  html: string,
  assetMaps: {
    assetIdFor: (dataUrl: string) => string | undefined;
    fileAssetFor: (dataUrl: string) =>
      | { assetId: string; mime: string; bytes: number; name?: string }
      | undefined;
  },
): { content: JSONContent[] | null; simplified: boolean } {
  const parsed = parseEditorHtml(html, {
    assetIdFor: assetMaps.assetIdFor,
    fileAssetFor: assetMaps.fileAssetFor,
  });
  // Degradations are reported once by the caller with the frozen wording
  // ("部分粘贴内容已简化" / "部分拖入内容已简化"); repeating the parser's own
  // warnings would stack toasts for one paste.
  const converted = blocksToPmDoc(parsed.blocks);
  const json = converted.value.toJSON() as JSONContent;
  const content = json.content;
  return {
    content: Array.isArray(content) && content.length > 0 ? content : null,
    simplified: parsed.warnings.length > 0 || converted.warnings.length > 0,
  };
}

/** Upload every data URL carried by sanitized clipboard HTML. */
async function uploadHtmlAssets(
  root: HTMLElement,
  options: PasteExtensionOptions,
): Promise<{
  assetIdFor: (dataUrl: string) => string | undefined;
  fileAssetFor: (dataUrl: string) =>
    | { assetId: string; mime: string; bytes: number; name?: string }
    | undefined;
}> {
  const imageAssets = new Map<string, string>();
  const fileAssets = new Map<
    string,
    { assetId: string; mime: string; bytes: number; name?: string }
  >();
  const imageUrls = new Set<string>();
  for (const image of root.querySelectorAll('img[src]')) {
    const src = (image.getAttribute('src') ?? '').trim();
    if (src.startsWith('data:image/')) imageUrls.add(src);
  }
  for (const url of imageUrls) {
    const asset = await uploadDataUrl(url, 'image', undefined, options);
    if (asset !== null) imageAssets.set(url, asset.assetId);
  }
  const fileUrls = new Set<string>();
  const fileNames = new Map<string, string>();
  for (const chip of root.querySelectorAll<HTMLElement>('[data-file]')) {
    const href = (chip.dataset['href'] ?? '').trim();
    if (!href.startsWith('data:')) continue;
    fileUrls.add(href);
    const name = (chip.dataset['file'] ?? '').trim();
    if (name !== '') fileNames.set(href, name);
  }
  for (const url of fileUrls) {
    const asset = await uploadDataUrl(
      url,
      'file',
      fileNames.get(url),
      options,
    );
    if (asset !== null) fileAssets.set(url, asset);
  }
  return {
    assetIdFor: (dataUrl) => imageAssets.get(dataUrl.trim()),
    fileAssetFor: (dataUrl) => fileAssets.get(dataUrl.trim()),
  };
}

/** Insert one sanitized HTML payload (paste or drop mode). */
async function insertHtml(
  editor: Editor,
  html: string,
  fallbackText: string,
  target: { from: number; to: number } | number,
  options: PasteExtensionOptions,
  mode: 'paste' | 'drop',
): Promise<void> {
  const sanitized = sanitizePastedHtml(html);
  if (sanitized.empty) {
    if (fallbackText !== '') {
      insertPlainText(editor, fallbackText, target);
    }
    return;
  }
  const root = document.createElement('div');
  root.innerHTML = sanitized.html;
  hoistInlineMedia(root);
  const assetMaps = await uploadHtmlAssets(root, options);
  const converted = htmlToContent(root.innerHTML, assetMaps);
  if (converted.content === null) {
    if (fallbackText !== '') insertPlainText(editor, fallbackText, target);
    return;
  }
  if (sanitized.simplified || converted.simplified) {
    options.onNotice?.(
      mode === 'paste' ? '部分粘贴内容已简化' : '部分拖入内容已简化',
    );
  }
  try {
    editor.chain().focus().insertContentAt(target, converted.content).run();
  } catch {
    // The document moved while assets uploaded: insert at the live caret.
    editor
      .chain()
      .focus()
      .insertContentAt(editor.state.selection.from, converted.content)
      .run();
  }
}

/** Insert plain text, preserving line breaks as hard breaks. */
function insertPlainText(
  editor: Editor,
  text: string,
  target: { from: number; to: number } | number,
): void {
  const lines = text.split(/\r\n|\r|\n/);
  const content: JSONContent[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: 'hardBreak' });
    if (line !== '') content.push({ type: 'text', text: line });
  });
  if (content.length === 0) return;
  editor.chain().focus().insertContentAt(target, content).run();
}

/** Insert one plain-text clipboard payload (frozen paste link gestures). */
function insertPlainTextPayload(
  editor: Editor,
  text: string,
  target: { from: number; to: number } | number,
  options: PasteExtensionOptions,
): void {
  const docId = documentIdFromPaste(text);
  if (docId !== null && (options.hasDoc?.(docId) ?? true)) {
    editor
      .chain()
      .focus()
      .insertContentAt(target, {
        type: 'docLink',
        attrs: { docId },
      })
      .run();
    return;
  }
  if (isWebUrl(text)) {
    const url = text.trim();
    editor
      .chain()
      .focus()
      .insertContentAt(target, {
        type: 'text',
        text: webMetadataTitle(url),
        marks: [{ type: 'link', attrs: { href: url } }],
      })
      .run();
    return;
  }
  insertPlainText(editor, text, target);
}

/** Current selection as one insertion range. */
function selectionRange(view: EditorView): { from: number; to: number } {
  return { from: view.state.selection.from, to: view.state.selection.to };
}

/** Drop position from pointer coordinates, falling back to the caret. */
function dropTarget(view: EditorView, event: DragEvent): number {
  const pos = view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });
  return pos?.pos ?? view.state.selection.from;
}

/** Handle one paste event synchronously; the async insert runs afterwards. */
function handlePasteEvent(
  editor: Editor,
  event: ClipboardEvent,
  options: PasteExtensionOptions,
): boolean {
  const clipboard = event.clipboardData;
  if (clipboard === null) return false;
  const files = Array.from(clipboard.files ?? []);
  const html = clipboard.getData('text/html');
  const text = clipboard.getData('text/plain');
  if (files.length === 0 && html === '' && text === '') return false;
  const target = selectionRange(editor.view);
  if (files.length > 0) {
    void insertFiles(editor, files, target, options);
    return true;
  }
  if (html !== '') {
    void insertHtml(editor, html, text, target, options, 'paste');
    return true;
  }
  insertPlainTextPayload(editor, text, target, options);
  return true;
}

/** Handle one drop event; returns true when the drop was claimed. */
function handleDropEvent(
  editor: Editor,
  event: DragEvent,
  options: PasteExtensionOptions,
): boolean {
  const data = event.dataTransfer;
  if (data === null) return false;
  // An internal drag (a selection or block dragged inside this editor) must
  // keep ProseMirror's move semantics: the same html/plain payload would
  // otherwise be inserted at the drop point while the source stays put, which
  // duplicates content and renumbers the moved blocks.
  if (editor.view.dragging !== null) return false;
  const files = Array.from(data.files ?? []);
  const html = data.getData('text/html');
  const text = data.getData('text/plain');
  if (files.length === 0 && html === '' && text === '') return false;
  const target = dropTarget(editor.view, event);
  if (files.length > 0) {
    void insertFiles(editor, files, target, options);
    return true;
  }
  if (html !== '') {
    void insertHtml(editor, html, text, target, options, 'drop');
    return true;
  }
  // Frozen drop semantics: plain text never becomes a link/card.
  insertPlainText(editor, text, target);
  return true;
}

/**
 * The paste/drop extension.
 *
 * `handlePaste`/`handleDOMEvents.drop` claim the event (so ProseMirror's default
 * slice insertion never runs) and insert only sanitized, converted content.
 * `dragover` accepts file/HTML/text drags with a copy cursor.
 */
export function createPasteExtension(
  options: PasteExtensionOptions = {},
): AnyExtension {
  return Extension.create({
    name: 'alterSpacePaste',
    priority: 1000,
    addProseMirrorPlugins() {
      const editor = this.editor;
      // One event may reach both the `handleDrop` prop and the DOM handler: the
      // first dispatcher handles it, the second replays the same answer (so an
      // internal drag we do not own falls through to ProseMirror's default).
      const dropResults = new WeakMap<Event, boolean>();
      const processDrop = (event: DragEvent): boolean => {
        const previous = dropResults.get(event);
        if (previous !== undefined) return previous;
        const handled = handleDropEvent(editor, event, options);
        dropResults.set(event, handled);
        return handled;
      };
      return [
        new Plugin({
          key: pastePluginKey,
          props: {
            handlePaste(_view, event) {
              return handlePasteEvent(editor, event, options);
            },
            handleDrop(_view, event) {
              return processDrop(event);
            },
            handleDOMEvents: {
              dragover(_view, event) {
                const types = event.dataTransfer?.types;
                if (types === undefined) return false;
                const values = Array.from(types);
                if (
                  values.includes('Files') ||
                  values.includes('text/html') ||
                  values.includes('text/plain')
                ) {
                  event.preventDefault();
                  try {
                    if (event.dataTransfer !== null) {
                      event.dataTransfer.dropEffect = 'copy';
                    }
                  } catch {
                    // Read-only dataTransfer in restricted hosts: dropping still
                    // works through the drop handler.
                  }
                }
                return false;
              },
              drop(_view, event) {
                const handled = processDrop(event);
                if (handled) event.preventDefault();
                return handled;
              },
            },
          },
        }),
      ];
    },
  });
}