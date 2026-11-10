import type { SpaceNode } from '@alter/protocol';
import { docPath } from '../../space-route';

export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function lineElement(node: Node | null) {
  if (!node) return null;
  const element =
    node instanceof HTMLElement ? node : (node.parentElement ?? null);
  const candidate = element?.closest<HTMLElement>(
    'li,p,h1,h2,h3,blockquote,pre,[data-todo],[data-divider],div',
  );
  if (!candidate || candidate.getAttribute('role') === 'textbox') return null;
  return candidate;
}

const blockTags = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'IMG',
  'HR',
  'A',
]);

export function normalizeBlocks(editor: HTMLElement) {
  let paragraph: HTMLParagraphElement | null = null;
  for (const node of [...editor.childNodes]) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (blockTags.has(element.tagName)) {
        paragraph = null;
        continue;
      }
    }
    if (!paragraph) {
      paragraph = document.createElement('p');
      node.before(paragraph);
    }
    paragraph.append(node);
  }
  // Stored documents can predate the non-editable checkbox marker.
  for (const box of editor.querySelectorAll('[data-todo-box]')) {
    box.setAttribute('contenteditable', 'false');
  }
}

export function hasBlockChild(editor: HTMLElement) {
  return [...editor.children].some((child) => blockTags.has(child.tagName));
}

export function isCaretAtEnd(line: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !line.contains(range.endContainer)) return false;
  const tail = document.createRange();
  tail.selectNodeContents(line);
  if (!range.endContainer) return false;
  tail.setStart(range.endContainer, range.endOffset);
  return tail.toString().length === 0;
}

export function placeCaretAtEnd(element: HTMLElement) {
  const editable = element.closest<HTMLElement>('[contenteditable="true"]');
  editable?.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  if (!editable) element.focus();
}

/** Put the caret at the start of one element's content. */
export function placeCaretAtStart(element: HTMLElement) {
  const editable = element.closest<HTMLElement>('[contenteditable="true"]');
  editable?.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  if (!editable) element.focus();
}

export function normalizeTodoCaret(editor: HTMLElement) {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (
    document.activeElement !== editor ||
    !selection?.isCollapsed ||
    !node ||
    !editor.contains(node)
  )
    return;
  const element = node instanceof Element ? node : node.parentElement;
  const todo = element?.closest<HTMLElement>('[data-todo]');
  const text = todo?.querySelector<HTMLElement>('[data-todo-text]');
  if (!todo || !text || text.contains(node)) return;
  const textIndex = [...todo.childNodes].indexOf(text);
  const afterText = node === todo && selection.anchorOffset > textIndex;
  const range = document.createRange();
  range.selectNodeContents(text);
  range.collapse(!afterText);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function moveCaretBeforeTodo(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const line = lineElement(range.startContainer);
  const text = line?.querySelector('[data-todo-text]');
  if (!line?.hasAttribute('data-todo') || !text?.contains(range.startContainer))
    return false;
  const before = document.createRange();
  before.selectNodeContents(text);
  before.setEnd(range.startContainer, range.startOffset);
  const placeholder =
    text.childNodes.length === 1 && text.firstChild?.nodeName === 'BR';
  const precedingContent = before.cloneContents();
  if (
    before.toString() ||
    (!placeholder &&
      precedingContent.querySelector('br,img,[contenteditable="false"]'))
  )
    return false;
  if (!line.previousElementSibling) return true;
  before.setStartBefore(line);
  before.collapse(true);
  selection.removeAllRanges();
  selection.addRange(before);
  selection.modify('move', 'backward', 'character');
  normalizeTodoCaret(editor);
  return true;
}

export function createParagraph() {
  const paragraph = document.createElement('p');
  paragraph.append(document.createElement('br'));
  return paragraph;
}

export function convertLineTo(
  line: HTMLElement,
  tag: 'p' | 'h1' | 'h2' | 'h3' | 'blockquote',
) {
  if (line.tagName.toLowerCase() === tag) return line;
  const element = document.createElement(tag);
  while (line.firstChild) element.append(line.firstChild);
  if (!element.firstChild) element.append(document.createElement('br'));
  line.replaceWith(element);
  placeCaretAtEnd(element);
  return element;
}

export function convertLineToList(line: HTMLElement, ordered: boolean) {
  const list = document.createElement(ordered ? 'ol' : 'ul');
  const item = document.createElement('li');
  while (line.firstChild) item.append(line.firstChild);
  if (!item.firstChild) item.append(document.createElement('br'));
  list.append(item);
  line.replaceWith(list);
  placeCaretAtEnd(item);
  return item;
}

export function convertLineToTodo(line: HTMLElement) {
  const todo = document.createElement('div');
  todo.dataset.todo = '';
  todo.dataset.checked = 'false';
  const box = document.createElement('span');
  box.dataset.todoBox = '';
  box.setAttribute('contenteditable', 'false');
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', 'false');
  box.setAttribute('aria-label', '待办事项');
  box.setAttribute('tabindex', '0');
  const text = document.createElement('span');
  text.dataset.todoText = '';
  while (line.firstChild) text.append(line.firstChild);
  if (!text.textContent) text.append(document.createElement('br'));
  todo.append(box, text);
  line.replaceWith(todo);
  placeCaretAtEnd(text);
  return todo;
}

export function convertLineToCode(line: HTMLElement) {
  const pre = document.createElement('pre');
  pre.dataset.code = '';
  const code = document.createElement('code');
  const text = line.textContent ?? '';
  code.textContent = text;
  if (!text) code.append(document.createElement('br'));
  pre.append(code);
  line.replaceWith(pre);
  placeCaretAtEnd(code);
  return pre;
}

export function convertLineToDivider(line: HTMLElement) {
  const divider = document.createElement('div');
  divider.dataset.divider = '';
  divider.setAttribute('contenteditable', 'false');
  divider.append(document.createElement('hr'));
  const paragraph = createParagraph();
  line.replaceWith(divider, paragraph);
  placeCaretAtEnd(paragraph);
  return { divider, paragraph };
}

export function createTable() {
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (let index = 0; index < 3; index += 1) {
    const cell = document.createElement('th');
    cell.append(document.createElement('br'));
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (let rowIndex = 0; rowIndex < 2; rowIndex += 1) {
    const row = document.createElement('tr');
    for (let index = 0; index < 3; index += 1) {
      const cell = document.createElement('td');
      cell.append(document.createElement('br'));
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body);
  return table;
}

export function insertBlockAfter(line: HTMLElement, block: HTMLElement) {
  line.after(block);
  placeCaretAtEnd(block);
  return block;
}

export function insertInlineNode(node: Node) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  const space = document.createTextNode('\u00a0');
  node.parentNode?.insertBefore(space, node.nextSibling);
  const next = document.createRange();
  next.setStartAfter(space);
  next.collapse(true);
  selection.removeAllRanges();
  selection.addRange(next);
}

export function clearSelectionAfterNode(node: Node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function pointAtOffset(
  root: HTMLElement,
  offset: number,
): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return null;
}

export interface TextAnchor {
  start: number;
  end: number;
}

export interface TextEdit {
  start: number;
  removed: number;
  inserted: number;
}

export function findQuoteOffsets(
  text: string,
  quote: string,
): TextAnchor | null {
  const normalized = quote.trim();
  if (!normalized) return null;
  let index = text.indexOf(normalized);
  let length = normalized.length;
  if (index < 0) {
    const compact = normalized.replace(/\s+/g, '');
    if (!compact) return null;
    let stripped = '';
    const offsets: number[] = [];
    for (let position = 0; position < text.length; position += 1) {
      const character = text[position] ?? '';
      if (/\s/.test(character)) continue;
      stripped += character;
      offsets.push(position);
    }
    const compactIndex = stripped.indexOf(compact);
    if (compactIndex < 0) return null;
    const startOffset = offsets[compactIndex];
    const endOffset = offsets[compactIndex + compact.length - 1];
    if (startOffset === undefined || endOffset === undefined) return null;
    index = startOffset;
    length = endOffset - startOffset + 1;
  }
  return { start: index, end: index + length };
}

export function findQuoteRange(root: HTMLElement, quote: string) {
  const offsets = findQuoteOffsets(root.textContent ?? '', quote);
  if (!offsets) return null;
  const start = pointAtOffset(root, offsets.start);
  const end = pointAtOffset(root, offsets.end);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

export function markCommentLinkIcons(
  editor: HTMLElement,
  ranges: Range[],
  activeRanges: Range[],
) {
  const icons = [...editor.querySelectorAll<HTMLElement>('[data-doc-icon]')];
  for (const icon of icons) {
    if (activeRanges.some((range) => range.intersectsNode(icon)))
      icon.dataset.commentMark = 'active';
    else if (ranges.some((range) => range.intersectsNode(icon)))
      icon.dataset.commentMark = 'open';
    else delete icon.dataset.commentMark;
  }
  return () => {
    for (const icon of icons) delete icon.dataset.commentMark;
  };
}

export function textEditBetween(
  previous: string,
  next: string,
): TextEdit | null {
  if (previous === next) return null;
  let prefix = 0;
  const maxPrefix = Math.min(previous.length, next.length);
  while (prefix < maxPrefix && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(previous.length, next.length) - prefix;
  while (
    suffix < maxSuffix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix += 1;
  return {
    start: prefix,
    removed: previous.length - prefix - suffix,
    inserted: next.length - prefix - suffix,
  };
}

function mapAnchorBoundary(position: number, edit: TextEdit, isEnd: boolean) {
  const editEnd = edit.start + edit.removed;
  if (position <= edit.start) return position;
  if (position >= editEnd) return position + edit.inserted - edit.removed;
  return isEnd ? edit.start + edit.inserted : edit.start;
}

export function transformTextAnchor(
  anchor: TextAnchor,
  edit: TextEdit,
): TextAnchor {
  const start = Math.max(0, mapAnchorBoundary(anchor.start, edit, false));
  const end = Math.max(start, mapAnchorBoundary(anchor.end, edit, true));
  return { start, end };
}

export function offsetAtPoint(
  root: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  if (!root.contains(node)) return null;
  try {
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

export function selectionRects(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  if (
    !selection.anchorNode ||
    !editor.contains(selection.anchorNode) ||
    !selection.focusNode ||
    !editor.contains(selection.focusNode)
  )
    return null;
  const range = selection.getRangeAt(0);
  const rects = [...range.getClientRects()].filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (!rects.length) return null;
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return null;
  const text = selection.toString().replace(/\s+/g, '');
  return { first, last, text, count: [...text].length };
}

const archivedIconMarkup =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';

/** 同步内联文档链接的归档标记，归档状态以图标提示而不是尾随文字。 */
export function setDocLinkArchived(link: HTMLAnchorElement, archived: boolean) {
  if (!archived) {
    delete link.dataset.archived;
    link.querySelector('[data-doc-archived-icon]')?.remove();
    return;
  }
  link.dataset.archived = '';
  if (link.querySelector('[data-doc-archived-icon]')) return;
  const badge = document.createElement('span');
  badge.dataset.docArchivedIcon = '';
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', '已归档');
  badge.setAttribute('contenteditable', 'false');
  badge.innerHTML = archivedIconMarkup;
  link.append(badge);
}

export function docLinkElement(doc: SpaceNode) {
  const link = document.createElement('a');
  link.dataset.docLink = doc.id;
  link.href = docPath(doc.spaceId, doc.id);
  link.setAttribute('contenteditable', 'false');
  const icon = document.createElement('span');
  icon.dataset.docIcon = '';
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('contenteditable', 'false');
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v6h5"/></svg>';
  link.append(icon, document.createTextNode(doc.title.trim() || '无标题'));
  setDocLinkArchived(link, doc.archived);
  return link;
}

const webTitles: Record<string, { title: string; description: string }> = {
  'https://www.edge.org/conversation/thinking-fast-and-slow': {
    title: 'Thinking, Fast and Slow',
    description: '关于直觉与审慎思考的对话记录。',
  },
  'https://en.wikipedia.org/wiki/Thinking,_Fast_and_Slow': {
    title: 'Thinking, Fast and Slow',
    description: 'Wikipedia · 关于双系统理论的条目。',
  },
};

export function webMetadata(url: string) {
  const known = webTitles[url];
  if (known) return known;
  try {
    const parsed = new URL(url);
    return {
      title: parsed.hostname.replace(/^www\./, ''),
      description: url,
    };
  } catch {
    return { title: url, description: url };
  }
}

export function webLinkElement(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.dataset.webLink = '';
  link.setAttribute('contenteditable', 'false');
  link.textContent = webMetadata(url).title;
  return link;
}

export function linkCardElement(url: string) {
  const meta = webMetadata(url);
  const card = document.createElement('a');
  card.dataset.linkCard = url;
  card.href = url;
  card.setAttribute('contenteditable', 'false');
  const title = document.createElement('strong');
  title.textContent = meta.title;
  const description = document.createElement('span');
  description.textContent = meta.description;
  card.append(title, description);
  return card;
}

export function docIdFromPaste(text: string) {
  const trimmed = text.trim();
  const match =
    trimmed.match(/#\/space\/[^/\s]+\/doc\/([^/\s?#]+)/) ??
    trimmed.match(/alter:\/\/doc\/([^/\s?#]+)/);
  return match?.[1] ?? null;
}

export function isWebUrl(text: string) {
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function countWords(text: string) {
  const compact = text.replace(/\s+/g, '');
  return [...compact].length;
}

// ---------------------------------------------------------------------------
// Clipboard sanitizing and insertion (C3/C4)
// ---------------------------------------------------------------------------

/** Result of sanitizing one rich-text clipboard payload. */
export interface SanitizedPaste {
  /** Safe HTML in the legacy editor's DOM syntax; empty when nothing usable. */
  html: string;
  /** Some content was dropped or simplified and should be reported. */
  simplified: boolean;
  /** Nothing usable survived (e.g. only scripts). */
  empty: boolean;
}

/** Links accepted by the document model (aligned with the legacy HTML parser). */
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

/** Block tags kept in the sanitized output (legacy editor DOM syntax). */
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

/** Inline tags kept as-is (semantics match the legacy editor's marks). */
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

function isWebUrlValue(value: string): boolean {
  return WEB_URL.test(value.trim());
}

/** Append the sanitized children of `source` into `target`. */
function sanitizeChildren(
  source: Element,
  target: Node,
  state: { simplified: boolean },
): void {
  for (const child of [...source.childNodes])
    sanitizeNode(child, target, state);
}

/** Wrap a text run into one paragraph when needed by the top-level pass. */
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

  // Legacy card/block syntax: preserve when pasting within the editor.
  if (tag === 'DIV' && element.dataset.todo !== undefined) {
    sanitizeTodo(element, target, state);
    return;
  }
  if (tag === 'DIV' && element.dataset.divider !== undefined) {
    const divider = document.createElement('div');
    divider.dataset.divider = '';
    divider.setAttribute('contenteditable', 'false');
    divider.appendChild(document.createElement('hr'));
    target.appendChild(divider);
    return;
  }
  if (tag === 'SPAN' && element.dataset.file !== undefined) {
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
    // The legacy UI only supports H1–H3; keep the text as a paragraph.
    state.simplified = true;
    const paragraph = document.createElement('p');
    sanitizeChildren(element, paragraph, state);
    target.appendChild(paragraph);
    return;
  }
  if (tag === 'DIV') {
    // A plain div is a structural wrapper; blocks inside stay blocks, an
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

/** Preserve one `[data-todo]` block (checkbox + text) in legacy syntax. */
function sanitizeTodo(
  element: HTMLElement,
  target: Node,
  state: { simplified: boolean },
): void {
  const todo = document.createElement('div');
  todo.dataset.todo = '';
  todo.dataset.checked = element.dataset.checked === 'true' ? 'true' : 'false';
  const box = document.createElement('span');
  box.dataset.todoBox = '';
  box.setAttribute('contenteditable', 'false');
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', todo.dataset.checked);
  box.setAttribute('aria-label', '待办事项');
  box.setAttribute('tabindex', '0');
  const text = document.createElement('span');
  text.dataset.todoText = '';
  const source = element.querySelector('[data-todo-text]') ?? element;
  sanitizeChildren(source, text, state);
  if (text.childNodes.length === 0) text.appendChild(document.createElement('br'));
  todo.append(box, text);
  target.appendChild(todo);
}

/** Preserve one `[data-file]` attachment chip in legacy syntax. */
function sanitizeFileChip(
  element: HTMLElement,
  target: Node,
  state: { simplified: boolean },
): void {
  const name = (element.dataset.file ?? '').trim();
  const href = element.dataset.href ?? '';
  if (name === '' || !isSafeFileHref(href)) {
    // Unsupported attachment: keep its text, drop the executable reference.
    state.simplified = true;
    sanitizeChildren(element, target, state);
    return;
  }
  const chip = document.createElement('span');
  chip.dataset.file = name;
  chip.dataset.href = href;
  const size = element.dataset.size;
  if (size !== undefined && /^[\d.]+ ?(?:B|KB|MB)$/.test(size))
    chip.dataset.size = size;
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute('role', 'link');
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('aria-label', `打开文件 ${name}`);
  chip.setAttribute('title', name);
  const icon = document.createElement('span');
  icon.dataset.fileIcon = '';
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
  const docId = element.dataset.docLink;
  if (docId !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(docId)) {
      state.simplified = true;
      sanitizeChildren(element, target, state);
      return;
    }
    const link = document.createElement('a');
    link.dataset.docLink = docId;
    link.setAttribute('contenteditable', 'false');
    link.setAttribute(
      'href',
      isSafeHref(element.getAttribute('href') ?? '') ? element.getAttribute('href')! : '#',
    );
    link.textContent = (element.textContent ?? '').trim() || docId;
    target.appendChild(link);
    return;
  }
  const cardUrl = element.dataset.linkCard;
  if (cardUrl !== undefined) {
    if (!isWebUrlValue(cardUrl)) {
      state.simplified = true;
      sanitizeChildren(element, target, state);
      return;
    }
    const url = cardUrl.trim();
    const link = document.createElement('a');
    link.dataset.linkCard = url;
    link.dataset.href = url;
    link.setAttribute('href', url);
    link.setAttribute('contenteditable', 'false');
    const meta = webMetadata(url);
    const title = document.createElement('strong');
    title.textContent =
      (element.querySelector('strong')?.textContent ?? '').trim() || meta.title;
    const description = document.createElement('span');
    description.textContent =
      (element.querySelector('span')?.textContent ?? '').trim() ||
      meta.description;
    link.append(title, description);
    target.appendChild(link);
    return;
  }
  if (element.dataset.webLink !== undefined) {
    const href = element.getAttribute('href') ?? '';
    if (!isWebUrlValue(href)) {
      state.simplified = true;
      sanitizeChildren(element, target, state);
      return;
    }
    const link = document.createElement('a');
    link.dataset.webLink = '';
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
  if (width !== null && /^\d{1,4}(?:px|%)?$/.test(width.trim()))
    image.setAttribute('width', width.trim());
  target.appendChild(image);
}

/** Flatten one pre/code block into the legacy `<pre><code>` syntax. */
function sanitizeCodeBlock(element: HTMLElement, target: Node): void {
  const nested = element.querySelector('code');
  const text = ((nested ?? element).textContent ?? '').replaceAll('\u200b', '');
  const pre = document.createElement('pre');
  const fromAttribute = (element.dataset.lang ?? nested?.dataset.lang ?? '').trim();
  const fromClass = (nested?.getAttribute('class') ?? '')
    .split(/\s+/)
    .map((item) => LANGUAGE_CLASS.exec(item)?.[1] ?? '')
    .find((item) => item !== '');
  const lang = fromAttribute !== '' ? fromAttribute : fromClass;
  if (lang !== undefined && /^[A-Za-z0-9_+#.-]{1,32}$/.test(lang))
    pre.dataset.lang = lang;
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
      if (value !== null && /^\d{1,2}$/.test(value.trim()))
        cell.setAttribute(attr, value.trim());
    }
    sanitizeChildren(element, cell, state);
    if (cell.childNodes.length === 0)
      cell.appendChild(document.createElement('br'));
    target.appendChild(cell);
    return;
  }
  if (tag === 'UL' || tag === 'OL') {
    const list = document.createElement(tag.toLowerCase());
    const start = element.getAttribute('start');
    if (tag === 'OL' && start !== null && /^\d{1,4}$/.test(start.trim()))
      list.setAttribute('start', start.trim());
    for (const child of [...element.children]) {
      if (child.tagName.toUpperCase() !== 'LI') {
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
      // Captions have no AST representation; keep their text in a row cell.
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

/** Sanitize one kept inline element. */
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
 * Sanitize clipboard HTML into the legacy editor's DOM syntax.
 *
 * Security: only allowlisted elements/attributes survive; scripts, styles,
 * frames, embeds, forms and controls are removed, every `on*` attribute and
 * dangerous `href`/`src` scheme is dropped. Unsupported rich structures keep
 * their text and set `simplified` so the caller can surface a notice.
 */
export function sanitizePastedHtml(html: string): SanitizedPaste {
  if (typeof DOMParser === 'undefined')
    return { html: '', simplified: true, empty: true };
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const state = { simplified: false };
  const output = document.createElement('div');
  for (const child of [...parsed.body.childNodes])
    sanitizeNode(child, output, state);
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
    if ((element.textContent ?? '').trim() === '' && element.childNodes.length === 0)
      element.remove();
  }
  const empty =
    normalized.childNodes.length === 0 ||
    ((normalized.textContent ?? '').trim() === '' &&
      normalized.querySelector('img,hr,table,ul,ol,pre,[data-todo],[data-divider],[data-file]') === null);
  return { html: normalized.innerHTML, simplified: state.simplified, empty };
}

/** Insert one safe text run at the caret (execCommand first, DOM fallback). */
export function insertPlainTextAtCaret(text: string): boolean {
  if (typeof document.execCommand === 'function') {
    try {
      if (document.execCommand('insertText', false, text)) return true;
    } catch {
      // Fall through to the DOM path (jsdom / restricted hosts).
    }
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** One top-level block node produced by the sanitizer. */
function isBlockNode(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = (node as Element).tagName.toUpperCase();
  return KEEP_BLOCK.has(tag) || tag === 'DIV';
}

/** Clone one textblock around a fragment, keeping its tag and attributes. */
function cloneLineWith(line: HTMLElement, content: DocumentFragment): HTMLElement {
  const clone = line.cloneNode(false) as HTMLElement;
  clone.append(content);
  return clone;
}

/** Place the caret after the last inserted node (block-aware). */
function placeCaretAfter(nodes: readonly Node[], editor: HTMLElement): void {
  const last = nodes[nodes.length - 1];
  if (last === undefined) {
    placeCaretAtEnd(editor);
    return;
  }
  if (last.nodeType === Node.ELEMENT_NODE) {
    const element = last as HTMLElement;
    if (element.matches('ul,ol,table,pre,hr,[data-divider]')) {
      const paragraph = document.createElement('p');
      element.after(paragraph);
      placeCaretAtEnd(paragraph);
      return;
    }
    placeCaretAtEnd(element);
    return;
  }
  const range = document.createRange();
  range.setStartAfter(last);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Insert sanitized HTML at the current caret.
 *
 * Browsers use native `insertHTML`; the DOM fallback splits the current
 * textblock so pasted blocks keep their structure in test/jsdom environments
 * and restricted hosts.
 */
export function insertSanitizedHtml(
  editor: HTMLElement,
  html: string,
): boolean {
  if (html.trim() === '') return false;
  if (typeof document.execCommand === 'function') {
    try {
      if (document.execCommand('insertHTML', false, html)) return true;
    } catch {
      // Fall through to the DOM path.
    }
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  if (fragment.childNodes.length === 0) return false;

  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
    placeCaretAtEnd(editor);
  }
  const range = window.getSelection()?.rangeCount
    ? window.getSelection()!.getRangeAt(0)
    : null;
  if (range === null || !editor.contains(range.commonAncestorContainer)) {
    const last = editor.lastElementChild;
    if (last instanceof HTMLElement) placeCaretAtEnd(last);
    const fallback = window.getSelection()?.rangeCount
      ? window.getSelection()!.getRangeAt(0)
      : null;
    if (fallback === null) return false;
    return insertNodesAtRange(editor, fragment, fallback);
  }
  return insertNodesAtRange(editor, fragment, range);
}

/** DOM insertion fallback shared by paste/drop. */
function insertNodesAtRange(
  editor: HTMLElement,
  fragment: DocumentFragment,
  range: Range,
): boolean {
  const hasBlocks = [...fragment.childNodes].some(isBlockNode);
  if (!hasBlocks) {
    const inserted = [...fragment.childNodes];
    range.deleteContents();
    range.insertNode(fragment);
    normalizeBlocks(editor);
    const last = inserted[inserted.length - 1];
    if (last !== undefined && last.parentNode !== null) {
      const tail = document.createRange();
      tail.setStartAfter(last);
      tail.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(tail);
    }
    return true;
  }

  const line = lineElement(range.startContainer);
  const simpleLine =
    line !== null && /^(P|H1|H2|H3)$/.test(line.tagName) ? line : null;
  if (simpleLine !== null && range.collapsed) {
    const before = range.cloneRange();
    before.selectNodeContents(simpleLine);
    before.setEnd(range.startContainer, range.startOffset);
    const after = range.cloneRange();
    after.selectNodeContents(simpleLine);
    after.setStart(range.endContainer, range.endOffset);
    const beforeContent = before.cloneContents();
    const afterContent = after.cloneContents();
    const parts: Node[] = [];
    const hasBefore =
      (beforeContent.textContent ?? '').trim() !== '' ||
      beforeContent.querySelector('img,br,a,[data-file]') !== null;
    const hasAfter =
      (afterContent.textContent ?? '').trim() !== '' ||
      afterContent.querySelector('img,br,a,[data-file]') !== null;
    if (hasBefore) parts.push(cloneLineWith(simpleLine, beforeContent));
    const inserted = [...fragment.childNodes];
    parts.push(...inserted);
    const afterClone = hasAfter
      ? cloneLineWith(simpleLine, afterContent)
      : null;
    if (afterClone !== null) parts.push(afterClone);
    simpleLine.replaceWith(...parts);
    if (afterClone !== null) placeCaretAtStart(afterClone);
    else placeCaretAfter(inserted, editor);
    return true;
  }

  // Non-textblock caret (list item, quote, todo, table cell): insert blocks
  // after the closest top-level block so the list/table structure stays valid.
  let anchor: HTMLElement | null = line;
  while (anchor !== null && anchor.parentElement !== editor)
    anchor = anchor.parentElement;
  const inserted = [...fragment.childNodes];
  if (anchor !== null) {
    anchor.after(...inserted);
  } else {
    editor.append(...inserted);
  }
  normalizeBlocks(editor);
  placeCaretAfter(inserted, editor);
  return true;
}

