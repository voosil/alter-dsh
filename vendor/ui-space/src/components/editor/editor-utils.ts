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
