import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImagePlus,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  MessageSquarePlus,
  Paperclip,
  Quote,
  Strikethrough,
  Table2,
  Text,
  Type,
  Underline,
} from 'lucide-react';
import type { Comment, SpaceNode } from '@alter/protocol';
import { Button, Dialog, Menu, type MenuAction } from '@alter/ui-system';
import {
  createTable,
  hasBlockChild,
  normalizeBlocks,
  convertLineTo,
  convertLineToCode,
  convertLineToDivider,
  convertLineToList,
  convertLineToTodo,
  createParagraph,
  docIdFromPaste,
  docLinkElement,
  findQuoteOffsets,
  insertInlineNode,
  insertPlainTextAtCaret,
  insertSanitizedHtml,
  isCaretAtEnd,
  isCaretAtStart,
  isCaretBeforeLineContent,
  isWebUrl,
  lineElement,
  linkCardElement,
  markCommentLinkIcons,
  moveCaretBeforeTodo,
  normalizeTodoCaret,
  offsetAtPoint,
  placeCaretAtEnd,
  placeCaretAtStart,
  placeSlashMenu,
  pointAtOffset,
  sanitizePastedHtml,
  selectionRects,
  setDocLinkArchived,
  textEditBetween,
  transformTextAnchor,
  webLinkElement,
  webMetadata,
  type SlashMenuSide,
  type TextAnchor,
} from './editor-utils';
import styles from './Editor.module.css';

type BlockKind =
  | 'text'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'todo'
  | 'quote'
  | 'code';

type InlineKind = 'bold' | 'underline' | 'strike' | 'code' | 'highlight';
type FormatState = 'none' | 'mixed' | 'all';
type InlineFormats = Record<InlineKind, FormatState>;

const inlineKinds: InlineKind[] = [
  'bold',
  'underline',
  'strike',
  'code',
  'highlight',
];

const inlineSelectors: Record<InlineKind, string> = {
  bold: 'strong,b',
  underline: 'u',
  strike: 's,del,strike',
  code: 'code',
  highlight: 'mark',
};

/**
 * Lines whose whole text may complete into a divider while typing `---`.
 * Code blocks, list items and todos are excluded: there `---` is legitimate
 * content (YAML frontmatter, separators) and replacing the host block would
 * destroy its structure.
 */
const typedDividerHosts = new Set(['P', 'H1', 'H2', 'H3', 'BLOCKQUOTE']);

const emptyInlineFormats: InlineFormats = {
  bold: 'none',
  underline: 'none',
  strike: 'none',
  code: 'none',
  highlight: 'none',
};

function hasInlineFormat(element: HTMLElement, kind: InlineKind) {
  if (kind === 'code') {
    const code = element.closest('code');
    return Boolean(code && !code.closest('pre'));
  }
  return Boolean(element.closest(inlineSelectors[kind]));
}

function formatStatesForRange(
  editor: HTMLElement,
  range: Range,
): InlineFormats {
  if (range.collapsed) return emptyInlineFormats;
  const counts: Record<InlineKind, number> = {
    bold: 0,
    underline: 0,
    strike: 0,
    code: 0,
    highlight: 0,
  };
  let total = 0;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if ((node.textContent ?? '').trim() && range.intersectsNode(node)) {
      total += 1;
      const parent = node.parentElement;
      if (parent) {
        for (const kind of inlineKinds) {
          if (hasInlineFormat(parent, kind)) counts[kind] += 1;
        }
      }
    }
    node = walker.nextNode();
  }
  if (!total) return emptyInlineFormats;
  const result = { ...emptyInlineFormats };
  for (const kind of inlineKinds) {
    result[kind] =
      counts[kind] === 0 ? 'none' : counts[kind] === total ? 'all' : 'mixed';
  }
  return result;
}

interface MarkerSplit {
  before: Node[];
  selected: Node;
  after: Node[];
}

function cloneWithNodes(template: HTMLElement, nodes: Node[]) {
  const clone = template.cloneNode(false) as HTMLElement;
  clone.append(...nodes);
  return clone;
}

function splitAroundMarker(
  element: HTMLElement,
  marker: Node,
  wrapSelected: boolean,
): MarkerSplit {
  const beforeNodes: Node[] = [];
  const afterNodes: Node[] = [];
  let selected: Node | null = null;
  for (const child of Array.from(element.childNodes)) {
    if (selected) {
      afterNodes.push(child);
      continue;
    }
    if (child === marker) {
      selected = marker;
      continue;
    }
    if (child.contains(marker)) {
      const inner = splitAroundMarker(child as HTMLElement, marker, true);
      beforeNodes.push(...inner.before);
      selected = inner.selected;
      afterNodes.push(...inner.after);
      continue;
    }
    beforeNodes.push(child);
  }
  if (!selected) return { before: [], selected: marker, after: [] };
  return {
    before: beforeNodes.length ? [cloneWithNodes(element, beforeNodes)] : [],
    selected: wrapSelected ? cloneWithNodes(element, [selected]) : selected,
    after: afterNodes.length ? [cloneWithNodes(element, afterNodes)] : [],
  };
}

function removeInlineFormat(
  editor: HTMLElement,
  marker: HTMLElement,
  kind: InlineKind,
) {
  for (;;) {
    let node = marker.parentElement;
    let target: HTMLElement | null = null;
    while (node && node !== editor) {
      if (kind === 'code' && node.closest('pre')) break;
      if (node.matches(inlineSelectors[kind])) {
        target = node;
        break;
      }
      node = node.parentElement;
    }
    if (!target) break;
    const split = splitAroundMarker(target, marker, false);
    target.replaceWith(...split.before, split.selected, ...split.after);
  }
  for (const element of [
    ...marker.querySelectorAll<HTMLElement>(inlineSelectors[kind]),
  ]) {
    if (kind === 'code' && element.closest('pre')) continue;
    element.replaceWith(...element.childNodes);
  }
}

interface SlashState {
  line: HTMLElement;
  query: string;
  top: number;
  left: number;
  index: number;
  /**
   * Side of the command line the menu appeared on when it opened. Kept for the
   * menu's lifetime so filtering cannot flip it across the line.
   */
  side: SlashMenuSide | null;
}

interface ToolbarState {
  left: number;
  top: number;
  below: boolean;
  countLeft: number;
  countTop: number;
  count: number;
  quote: string;
}

interface LinkBarState {
  element: HTMLElement;
  left: number;
  top: number;
  kind: 'inline' | 'card';
}

interface LinkEditingState {
  href: string;
  label: string;
  kind: 'inline' | 'card';
}

/** Hover handle that turns a table into one selectable block. */
interface TableBarState {
  element: HTMLTableElement;
  left: number;
  top: number;
}

interface SlashCommand {
  id: string;
  label: string;
  keywords: string[];
  icon: ReactNode;
  run?: (line: HTMLElement) => void;
  action?: 'image' | 'file';
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** In-order character match, so "/tdo" still finds the "todo" keyword. */
function isSubsequence(query: string, text: string) {
  let index = 0;
  for (const char of text) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return false;
}

/**
 * Rank one command for a normalized query: exact id/label/keyword match first,
 * then prefix, then substring and finally subsequence. `null` drops the item.
 */
function commandMatchRank(command: SlashCommand, query: string) {
  let best: number | null = null;
  for (const candidate of [command.id, command.label, ...command.keywords]) {
    const text = candidate.toLowerCase();
    let rank: number | null = null;
    if (text === query) rank = 0;
    else if (text.startsWith(query)) rank = 1;
    else if (text.includes(query)) rank = 2;
    else if (isSubsequence(query, text)) rank = 3;
    if (rank !== null && (best === null || rank < best)) best = rank;
    if (best === 0) break;
  }
  return best;
}

/** True when a line holds nothing but one image (placeholder spaces allowed). */
function isImageOnlyLine(line: HTMLElement, image: HTMLElement) {
  for (const node of [...line.childNodes]) {
    if (node === image) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? '').replaceAll('\u00a0', '').trim() !== '') {
        return false;
      }
      continue;
    }
    if (node instanceof HTMLElement && node.tagName === 'BR') continue;
    return false;
  }
  return true;
}

/** The image that visually owns one block (block image or image-only line). */
function blockImage(block: HTMLElement): HTMLElement | null {
  if (block.tagName === 'IMG') return block;
  const images = block.querySelectorAll<HTMLElement>('img');
  if (images.length !== 1) return null;
  const image = images[0];
  return image && isImageOnlyLine(block, image) ? image : null;
}

function filterCommands(commands: SlashCommand[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return commands;
  return commands
    .map((command, index) => ({
      command,
      index,
      rank: commandMatchRank(command, normalized),
    }))
    .filter(
      (entry): entry is { command: SlashCommand; index: number; rank: number } =>
        entry.rank !== null,
    )
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command);
}

function buildSlashCommands(line: HTMLElement): SlashCommand[] {
  const clear = () => {
    line.innerHTML = '';
  };
  return [
    {
      id: 'text',
      label: '正文',
      keywords: ['text', 'paragraph', '正文', '段落'],
      icon: <Text />,
      run: () => {
        clear();
        convertLineTo(line, 'p');
      },
    },
    {
      id: 'h1',
      label: '标题 1',
      keywords: ['h1', 'heading1', '标题', '一级'],
      icon: <Heading1 />,
      run: () => {
        clear();
        convertLineTo(line, 'h1');
      },
    },
    {
      id: 'h2',
      label: '标题 2',
      keywords: ['h2', 'heading2', '标题', '二级'],
      icon: <Heading2 />,
      run: () => {
        clear();
        convertLineTo(line, 'h2');
      },
    },
    {
      id: 'h3',
      label: '标题 3',
      keywords: ['h3', 'heading3', '标题', '三级'],
      icon: <Heading3 />,
      run: () => {
        clear();
        convertLineTo(line, 'h3');
      },
    },
    {
      id: 'bullet',
      label: '无序列表',
      keywords: ['bullet', 'list', 'ul', '列表', '无序'],
      icon: <List />,
      run: () => {
        clear();
        convertLineToList(line, false);
      },
    },
    {
      id: 'ordered',
      label: '有序列表',
      keywords: ['number', 'ordered', 'ol', '列表', '有序'],
      icon: <ListOrdered />,
      run: () => {
        clear();
        convertLineToList(line, true);
      },
    },
    {
      id: 'todo',
      label: '待办',
      keywords: ['todo', 'task', 'checkbox', '待办', '事项'],
      icon: <ListTodo />,
      run: () => {
        clear();
        convertLineToTodo(line);
      },
    },
    {
      id: 'quote',
      label: '引用',
      keywords: ['quote', 'blockquote', '引用', '>', '》'],
      icon: <Quote />,
      run: () => {
        clear();
        convertLineTo(line, 'blockquote');
      },
    },
    {
      id: 'code',
      label: '代码块',
      keywords: ['code', '代码'],
      icon: <Code2 />,
      run: () => {
        clear();
        convertLineToCode(line);
      },
    },
    {
      id: 'divider',
      label: '分割线',
      keywords: ['divider', 'hr', '分割线'],
      icon: <Minus />,
      run: () => {
        clear();
        convertLineToDivider(line);
      },
    },
    {
      id: 'table',
      label: '表格',
      keywords: ['table', '表格'],
      icon: <Table2 />,
      run: () => {
        clear();
        const table = createTable();
        const paragraph = createParagraph();
        line.replaceWith(table, paragraph);
        const firstCell = table.querySelector('th');
        if (firstCell) placeCaretAtEnd(firstCell);
      },
    },
    {
      id: 'image',
      label: '图片',
      keywords: ['image', 'img', '图片'],
      icon: <ImagePlus />,
      action: 'image',
    },
    {
      id: 'file',
      label: '文件',
      keywords: ['file', 'attachment', '文件', '附件'],
      icon: <Paperclip />,
      action: 'file',
    },
  ];
}

export function Editor({
  docId,
  initialHtml,
  externalRevision,
  findDoc,
  onOpenDoc,
  onOpenWeb,
  onChange,
  onComment,
  comments,
  activeCommentId,
  onCommentAtCaretChange,
  onCommentQuotesChange,
  onCommentedTextClick,
  onNotice,
  onCompositionChange,
}: {
  docId: string;
  initialHtml: string;
  externalRevision: number;
  findDoc: (id: string) => SpaceNode | undefined;
  onOpenDoc: (id: string) => void;
  onOpenWeb?: (url: string) => void;
  onChange: (html: string) => void;
  onComment: (quote: string) => void;
  comments: Comment[];
  activeCommentId?: string | null;
  onCommentAtCaretChange?: (id: string | null) => void;
  onCommentQuotesChange?: (updates: { id: string; quote: string }[]) => void;
  onCommentedTextClick?: () => void;
  /** Report simplified/dropped clipboard content (defaults to console.warn). */
  onNotice?: (message: string) => void;
  /** Pause the save layer while an IME composition is in progress. */
  onCompositionChange?: (composing: boolean) => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const savedQuoteRef = useRef('');
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pointerSelectingRef = useRef(false);
  const selectionTimerRef = useRef<number | null>(null);
  const linkTimerRef = useRef<number | null>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const initialDocRef = useRef<string | null>(null);
  const lastRevisionRef = useRef(externalRevision);
  const composingRef = useRef(false);
  // The command line whose menu was open when an IME composition started, so
  // the menu can come back once the composition has been committed. The side it
  // was pinned to is remembered too: the restored menu must not re-decide it.
  const composingSlashLineRef = useRef<HTMLElement | null>(null);
  const composingSlashSideRef = useRef<SlashMenuSide | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [blockAnchor, setBlockAnchor] = useState<HTMLElement | null>(null);
  const [activeBlock, setActiveBlock] = useState<BlockKind | null>(null);
  const [inlineFormats, setInlineFormats] =
    useState<InlineFormats>(emptyInlineFormats);
  const [selectedBlock, setSelectedBlock] = useState<HTMLElement | null>(null);
  const [tableBar, setTableBar] = useState<TableBarState | null>(null);
  const [linkBar, setLinkBar] = useState<LinkBarState | null>(null);
  const [linkEditing, setLinkEditing] = useState<LinkEditingState | null>(null);
  const linkEditingElementRef = useRef<HTMLElement | null>(null);
  const [contentTick, setContentTick] = useState(0);
  const [linkLabel, setLinkLabel] = useState('');
  const [linkHref, setLinkHref] = useState('');
  const [linkError, setLinkError] = useState('');
  const commentAnchorsRef = useRef<Map<string, TextAnchor>>(new Map());
  const commentCaretRef = useRef<string | null>(null);
  const lastTextRef = useRef('');
  const commentsRef = useRef(comments);
  const onCommentAtCaretChangeRef = useRef(onCommentAtCaretChange);
  const onCommentQuotesChangeRef = useRef(onCommentQuotesChange);
  const onCommentedTextClickRef = useRef(onCommentedTextClick);
  const onNoticeRef = useRef(onNotice);
  const onCompositionChangeRef = useRef(onCompositionChange);
  commentsRef.current = comments;
  onCommentAtCaretChangeRef.current = onCommentAtCaretChange;
  onCommentQuotesChangeRef.current = onCommentQuotesChange;
  onCommentedTextClickRef.current = onCommentedTextClick;
  onNoticeRef.current = onNotice;
  onCompositionChangeRef.current = onCompositionChange;

  const updateCaretComment = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || document.activeElement !== editor) {
      if (commentCaretRef.current !== null) {
        commentCaretRef.current = null;
        onCommentAtCaretChangeRef.current?.(null);
      }
      return;
    }
    const selection = window.getSelection();
    if (
      !selection?.rangeCount ||
      !selection.isCollapsed ||
      !selection.anchorNode ||
      !editor.contains(selection.anchorNode)
    ) {
      if (commentCaretRef.current !== null) {
        commentCaretRef.current = null;
        onCommentAtCaretChangeRef.current?.(null);
      }
      return;
    }
    const offset = offsetAtPoint(
      editor,
      selection.anchorNode,
      selection.anchorOffset,
    );
    let next: string | null = null;
    if (offset !== null) {
      let shortest = Number.POSITIVE_INFINITY;
      for (const [id, anchor] of commentAnchorsRef.current) {
        if (anchor.end <= anchor.start) continue;
        if (offset < anchor.start || offset >= anchor.end) continue;
        const length = anchor.end - anchor.start;
        if (length < shortest) {
          shortest = length;
          next = id;
        }
      }
    }
    if (commentCaretRef.current !== next) {
      commentCaretRef.current = next;
      onCommentAtCaretChangeRef.current?.(next);
    }
  }, []);

  function syncCommentAnchorsFromText() {
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.textContent ?? '';
    const edit = textEditBetween(lastTextRef.current, text);
    if (edit) {
      const moved = new Map<string, TextAnchor>();
      for (const [id, anchor] of commentAnchorsRef.current) {
        const next = transformTextAnchor(anchor, edit);
        moved.set(id, {
          start: Math.min(next.start, text.length),
          end: Math.min(next.end, text.length),
        });
      }
      commentAnchorsRef.current = moved;
    }
    lastTextRef.current = text;
    const updates: { id: string; quote: string }[] = [];
    for (const comment of commentsRef.current) {
      if (comment.status !== 'open' || comment.quote === null) continue;
      const anchor = commentAnchorsRef.current.get(comment.id);
      if (!anchor) continue;
      const quote = text.slice(anchor.start, anchor.end);
      if (quote !== comment.quote) updates.push({ id: comment.id, quote });
    }
    if (updates.length) onCommentQuotesChangeRef.current?.(updates);
    updateCaretComment();
  }

  function editorHtml() {
    const clone = editorRef.current?.cloneNode(true) as
      | HTMLDivElement
      | undefined;
    if (!clone) return '';
    for (const icon of clone.querySelectorAll<HTMLElement>(
      '[data-doc-icon][data-comment-mark]',
    ))
      delete icon.dataset.commentMark;
    // `data-selected` is editing-surface state only; it must never be saved.
    for (const element of clone.querySelectorAll<HTMLElement>(
      '[data-selected]',
    ))
      delete element.dataset.selected;
    for (const link of clone.querySelectorAll<HTMLElement>(
      'a[data-doc-link]',
    )) {
      delete link.dataset.archived;
      link.querySelector('[data-doc-archived-icon]')?.remove();
    }
    return clone.innerHTML;
  }

  function notifyChange() {
    syncCommentAnchorsFromText();
    onChange(editorHtml());
    setContentTick((tick) => tick + 1);
  }

  /** Make sure the editor owns a caret before inserting plain content. */
  function ensureCaret() {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) return;
    placeCaretAtEnd(editor);
  }

  /** Surface a non-blocking notice (falls back to console.warn). */
  function notifyNotice(message: string) {
    const notice = onNoticeRef.current;
    if (notice) notice(message);
    else console.warn(`[Space 编辑器] ${message}`);
  }

  /**
   * Replace the editor body for an external snapshot (version restore,
   * external revision, draft adoption) and drop the browser's native undo
   * stack with it.
   *
   * Chromium keeps the editing undo history across plain `innerHTML` writes
   * (and across `contentEditable` toggles), so a Ctrl+Z after a version restore
   * could write pre-restore edits back into the restored document. Detaching
   * and re-attaching the editing host starts a fresh editing session; verified
   * in Chrome that `execCommand('undo')` then reports no undo available. The
   * node keeps its attributes/classes and returns to the same position, so the
   * rendered DOM structure and CSS are unchanged.
   */
  function resetEditorBody(editor: HTMLElement, html: string) {
    const hadFocus = document.activeElement === editor;
    const parent = editor.parentNode;
    if (parent !== null) {
      // Detaching the editing host ends the browser's editing session: a
      // re-attached node starts a fresh native undo stack. Chromium keeps the
      // old stack across plain `innerHTML` writes (and across contentEditable
      // toggles), so a post-restore Ctrl+Z could otherwise replay pre-restore
      // edits. The node keeps its attributes/classes and returns to the same
      // position, so the rendered DOM is unchanged.
      const next = editor.nextSibling;
      parent.removeChild(editor);
      editor.innerHTML = html;
      parent.insertBefore(editor, next);
    } else {
      editor.innerHTML = html;
    }
    if (hadFocus) editor.focus();
  }

  function clearFloatingUi() {
    if (selectionTimerRef.current) {
      window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = null;
    }
    if (linkTimerRef.current) {
      window.clearTimeout(linkTimerRef.current);
      linkTimerRef.current = null;
    }
    setSlash(null);
    setToolbar(null);
    setLinkBar(null);
    setBlockAnchor(null);
  }

  // -------------------------------------------------------------------------
  // Block-level selection (divider / image / table)
  // -------------------------------------------------------------------------

  /** Drop the current block selection mark without touching content. */
  function clearBlockSelection() {
    if (!selectedBlock) return;
    selectedBlock.removeAttribute('data-selected');
    setSelectedBlock(null);
  }

  /** Select one non-editable block; only one block can be selected at a time. */
  function selectBlock(element: HTMLElement) {
    if (element === selectedBlock) return;
    clearBlockSelection();
    element.dataset.selected = '';
    setSelectedBlock(element);
  }

  /** Block the caret can pick up with one more delete key press, if any. */
  function adjacentSelectableBlock(
    direction: 'backward' | 'forward',
  ): HTMLElement | null {
    if (selectedBlock) return null;
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount || !selection.isCollapsed) {
      return null;
    }
    if (!selection.anchorNode || !editor.contains(selection.anchorNode)) {
      return null;
    }
    const line = lineElement(selection.anchorNode);
    if (!line) return null;
    const atEdge =
      direction === 'backward' ? isCaretAtStart(line) : isCaretAtEnd(line);
    if (!atEdge) return null;
    const sibling =
      direction === 'backward'
        ? line.previousElementSibling
        : line.nextElementSibling;
    if (!(sibling instanceof HTMLElement)) return null;
    if (sibling.hasAttribute('data-divider')) return sibling;
    return blockImage(sibling);
  }

  /** Put the caret at a block's edge; tables resolve to their first/last cell. */
  function placeCaretInBlock(
    block: HTMLElement | null,
    edge: 'start' | 'end',
  ): boolean {
    if (!block || !block.isConnected) return false;
    if (
      block.tagName === 'IMG' ||
      block.hasAttribute('data-divider') ||
      block.hasAttribute('data-object-card')
    ) {
      return false;
    }
    if (block.tagName === 'TABLE') {
      const cells = [...block.querySelectorAll<HTMLElement>('th,td')];
      const cell = edge === 'end' ? cells[cells.length - 1] : cells[0];
      if (!cell) return false;
      if (edge === 'end') placeCaretAtEnd(cell);
      else placeCaretAtStart(cell);
      return true;
    }
    if (edge === 'end') placeCaretAtEnd(block);
    else placeCaretAtStart(block);
    return true;
  }

  /** Caret at the nearest typable line before `before`, else after `after`. */
  function caretAroundBlock(
    before: HTMLElement | null,
    after: HTMLElement | null,
  ): boolean {
    let previous = before;
    while (previous) {
      if (placeCaretInBlock(previous, 'end')) return true;
      previous = previous.previousElementSibling as HTMLElement | null;
    }
    let next = after;
    while (next) {
      if (placeCaretInBlock(next, 'start')) return true;
      next = next.nextElementSibling as HTMLElement | null;
    }
    return false;
  }

  /** After a block is removed the caret lands at the previous line's end. */
  function caretAfterRemoval(
    previous: HTMLElement | null,
    next: HTMLElement | null,
  ) {
    if (caretAroundBlock(previous, next)) return;
    const paragraph = createParagraph();
    const editor = editorRef.current;
    if (editor) editor.append(paragraph);
    placeCaretAtEnd(paragraph);
  }

  /** Remove the selected block and leave the caret on a typable neighbour. */
  function removeSelectedBlock() {
    const block = selectedBlock;
    if (!block || !block.isConnected) {
      setSelectedBlock(null);
      return;
    }
    const imageLine = block.tagName === 'IMG' ? lineElement(block) : null;
    const inlineImage =
      block.tagName === 'IMG' &&
      imageLine !== null &&
      !isImageOnlyLine(imageLine, block);
    if (inlineImage) {
      // An image inside running text: keep its paragraph, park the caret where
      // the image was so typing continues in place.
      const caret = document.createRange();
      caret.setStartBefore(block);
      caret.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
      block.remove();
      setSelectedBlock(null);
      notifyChange();
      return;
    }
    const removeLine =
      block.tagName === 'IMG' &&
      imageLine !== null &&
      isImageOnlyLine(imageLine, block);
    const removable = removeLine && imageLine ? imageLine : block;
    const previous = removable.previousElementSibling as HTMLElement | null;
    const next = removable.nextElementSibling as HTMLElement | null;
    if (tableBar?.element === removable) setTableBar(null);
    removable.removeAttribute('data-selected');
    removable.remove();
    setSelectedBlock(null);
    caretAfterRemoval(previous, next);
    notifyChange();
  }

  // -------------------------------------------------------------------------
  // Table block handle (select / move / delete)
  // -------------------------------------------------------------------------

  function tableBarPosition(element: HTMLTableElement): TableBarState {
    const rect = element.getBoundingClientRect();
    return {
      element,
      left: Math.min(
        Math.max(12, rect.left),
        Math.max(12, window.innerWidth - 160),
      ),
      top: Math.max(10, rect.top - 34),
    };
  }

  /** Show the hover handle above one table. */
  function showTableBar(element: HTMLTableElement) {
    if (tableBar?.element === element) return;
    if (linkTimerRef.current) window.clearTimeout(linkTimerRef.current);
    setTableBar(tableBarPosition(element));
  }

  /** Follow the table after it moved among its siblings. */
  function refreshTableBar() {
    if (!tableBar) return;
    if (!tableBar.element.isConnected) {
      setTableBar(null);
      return;
    }
    setTableBar(tableBarPosition(tableBar.element));
  }

  /** Turn the hovered table into one selected block. */
  function selectTableBlock() {
    const element = tableBar?.element;
    const editor = editorRef.current;
    if (!element || !editor || !editor.contains(element)) return;
    selectBlock(element);
    // Keep editing focus on the surface and park the caret outside the table so
    // the next delete key removes the whole table instead of a cell character.
    editor.focus();
    caretAroundBlock(
      element.previousElementSibling as HTMLElement | null,
      element.nextElementSibling as HTMLElement | null,
    );
  }

  /** Move the selected table one block up or down. */
  function moveSelectedTable(offset: -1 | 1) {
    const element = selectedBlock;
    if (!(element instanceof HTMLTableElement)) return;
    const sibling =
      offset < 0 ? element.previousElementSibling : element.nextElementSibling;
    if (!(sibling instanceof HTMLElement)) return;
    if (offset < 0) sibling.before(element);
    else sibling.after(element);
    caretAroundBlock(
      element.previousElementSibling as HTMLElement | null,
      element.nextElementSibling as HTMLElement | null,
    );
    refreshTableBar();
    notifyChange();
  }

  // IME composition: suppress floating UI and half-composed saves.
  function handleCompositionStart() {
    composingRef.current = true;
    onCompositionChangeRef.current?.(true);
    composingSlashLineRef.current = slash?.line ?? null;
    composingSlashSideRef.current = slash?.side ?? null;
    clearFloatingUi();
  }

  /**
   * Finish a block shortcut whose marker arrived as one input instead of the
   * keydown that usually triggers it: an IME commit (composition end) or a
   * native input event that carries a marker plus its confirming space.
   *
   * `allowBareMarker` is true only for the composition-end path: the space that
   * confirms a Chinese IME composition is consumed by the IME, so the marker
   * arrives without its trailing space and still completes the gesture. A plain
   * input event must keep a bare marker as text — typing `>` or `》` alone is
   * not the gesture (第 13 项: 引用标记按标准 `>` + 空格输入).
   */
  function convertMarkerShortcut(allowBareMarker: boolean): boolean {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return false;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const line = lineElement(selection.anchorNode);
    if (
      !line ||
      line.tagName.toLowerCase() === 'blockquote' ||
      !isCaretAtEnd(line)
    )
      return false;
    const text = line.textContent ?? '';
    // `N. ` where the trailing space was committed by the IME as well.
    const ordered = /^(\d{1,7})\.\s$/.exec(text);
    if (ordered) {
      line.innerHTML = '';
      convertLineToList(line, true, Number.parseInt(ordered[1]!, 10));
      return true;
    }
    const marker = allowBareMarker ? /^(?:>|》)\s?$/ : /^(?:>|》)\s$/;
    if (marker.test(text)) {
      line.innerHTML = '';
      convertLineTo(line, 'blockquote');
      return true;
    }
    return false;
  }

  /**
   * Complete a typed `---` into a divider as soon as the third dash lands.
   *
   * The legacy editor waited for Enter; the product requires the divider to
   * appear without that extra keystroke. Only a line whose whole content is
   * `---`, with the caret at its end, converts — anything else stays text.
   * An open IME composition is never converted early, and `input` must be an
   * insertion (a delete that happens to leave `---` must not morph the line).
   */
  function convertTypedDivider(input?: InputEvent): boolean {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return false;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const line = lineElement(selection.anchorNode);
    if (!line || line.parentElement !== editor) return false;
    if (!typedDividerHosts.has(line.tagName)) return false;
    const inputType = input?.inputType ?? '';
    if (inputType !== '' && !inputType.startsWith('insert')) return false;
    if ((line.textContent ?? '').trimEnd() !== '---') return false;
    if (!isCaretAtEnd(line)) return false;
    line.innerHTML = '';
    convertLineToDivider(line);
    return true;
  }

  function handleCompositionEnd() {
    composingRef.current = false;
    onCompositionChangeRef.current?.(false);
    const slashLine = composingSlashLineRef.current;
    const slashSide = composingSlashSideRef.current;
    composingSlashLineRef.current = null;
    composingSlashSideRef.current = null;
    // Some browsers do not emit a trailing non-composing input event; finish
    // the composition with one final change notification.
    convertMarkerShortcut(true);
    convertTypedDivider();
    notifyChange();
    if (!slashLine || !slashLine.isConnected) return;
    // The IME committed text without any keydown flowing through the editor,
    // so the suppressed menu has to be restored from the line itself, still
    // pinned to the side it was opened on (第 12 项).
    const caretLine = lineElement(window.getSelection()?.anchorNode ?? null);
    const text = slashLine.textContent ?? '';
    if (caretLine === slashLine && text.startsWith('/'))
      openSlash(slashLine, text.slice(1), slashSide);
  }

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (initialDocRef.current !== docId) {
      resetEditorBody(editor, initialHtml);
      normalizeBlocks(editor);
      initialDocRef.current = docId;
      lastRevisionRef.current = externalRevision;
      commentAnchorsRef.current = new Map();
      lastTextRef.current = editor.textContent ?? '';
      setSlash(null);
      setToolbar(null);
      setSelectedBlock(null);
      setTableBar(null);
      return;
    }
    if (lastRevisionRef.current !== externalRevision) {
      resetEditorBody(editor, initialHtml);
      normalizeBlocks(editor);
      lastRevisionRef.current = externalRevision;
      commentAnchorsRef.current = new Map();
      lastTextRef.current = editor.textContent ?? '';
      setSlash(null);
      setToolbar(null);
    }
  }, [docId, initialHtml, externalRevision]);

  useEffect(() => {
    function updateToolbar() {
      const editor = editorRef.current;
      if (!editor) return;
      if (composingRef.current) {
        setToolbar(null);
        return;
      }
      const rects = selectionRects(editor);
      if (!rects) {
        setToolbar(null);
        setInlineFormats(emptyInlineFormats);
        return;
      }
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      savedRangeRef.current = selection.getRangeAt(0).cloneRange();
      savedQuoteRef.current = selection.toString().trim();
      setInlineFormats(formatStatesForRange(editor, selection.getRangeAt(0)));
      const toolbarWidth = 300;
      const left = Math.min(
        Math.max(
          rects.first.left + rects.first.width / 2,
          toolbarWidth / 2 + 10,
        ),
        window.innerWidth - toolbarWidth / 2 - 10,
      );
      const editorTop = editor.getBoundingClientRect().top;
      const below = rects.first.top < 70 || rects.first.top - editorTop < 52;
      setToolbar({
        left,
        top: below ? rects.last.bottom + 8 : rects.first.top - 8,
        below,
        countLeft: Math.min(rects.last.right + 8, window.innerWidth - 46),
        countTop: rects.last.bottom + 4,
        count: rects.count,
        quote: selection.toString().trim(),
      });
    }
    function scheduleToolbar() {
      if (selectionTimerRef.current)
        window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = window.setTimeout(updateToolbar, 120);
    }
    function handleSelectionChange() {
      const editor = editorRef.current;
      if (!editor) return;
      if (composingRef.current) {
        setToolbar(null);
        return;
      }
      normalizeTodoCaret(editor);
      updateCaretComment();
      const selection = window.getSelection();
      if (
        selection?.rangeCount &&
        !selection.isCollapsed &&
        selection.anchorNode &&
        editor.contains(selection.anchorNode)
      ) {
        savedRangeRef.current = selection.getRangeAt(0).cloneRange();
        savedQuoteRef.current = selection.toString().trim();
      }
      if (pointerSelectingRef.current) return;
      scheduleToolbar();
    }
    function handleMouseDown(event: globalThis.MouseEvent) {
      const editor = editorRef.current;
      if (
        editor &&
        event.target instanceof Node &&
        editor.contains(event.target)
      ) {
        pointerSelectingRef.current = true;
        if (selectionTimerRef.current) {
          window.clearTimeout(selectionTimerRef.current);
          selectionTimerRef.current = null;
        }
        setToolbar(null);
        setBlockAnchor(null);
        setInlineFormats(emptyInlineFormats);
      }
    }
    function handleMouseUp() {
      if (!pointerSelectingRef.current) return;
      pointerSelectingRef.current = false;
      if (selectionTimerRef.current) {
        window.clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = null;
      }
      window.setTimeout(updateToolbar, 0);
      updateCaretComment();
    }
    const editor = editorRef.current;
    const handleBeforeInput = () => {
      if (editor) normalizeTodoCaret(editor);
    };
    editor?.addEventListener('beforeinput', handleBeforeInput);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mouseup', handleMouseUp, true);
    return () => {
      editor?.removeEventListener('beforeinput', handleBeforeInput);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
      if (selectionTimerRef.current)
        window.clearTimeout(selectionTimerRef.current);
    };
  }, [updateCaretComment]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor
      .querySelectorAll<HTMLAnchorElement>('a[data-doc-link]')
      .forEach((link) => {
        const id = link.dataset.docLink;
        if (!id) return;
        const doc = findDoc(id);
        if (!doc) return;
        setDocLinkArchived(link, doc.archived);
      });
    editor.querySelectorAll<HTMLElement>('[data-link-card]').forEach((card) => {
      card.setAttribute('contenteditable', 'false');
      if (card.tagName === 'A') return;
      // 早期卡片是 div，补上链接语义与键盘入口。
      const title =
        card.querySelector('strong')?.textContent?.trim() || '网页链接';
      card.setAttribute('role', 'link');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `打开 ${title}`);
    });
  }, [docId, contentTick, initialHtml, findDoc]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.textContent ?? '';
    const next = new Map<string, TextAnchor>();
    for (const comment of comments) {
      if (comment.status !== 'open' || comment.quote === null) continue;
      const existing = commentAnchorsRef.current.get(comment.id);
      if (existing) {
        const current = text.slice(existing.start, existing.end);
        if (current === comment.quote || current.length > 0) {
          next.set(comment.id, existing);
          continue;
        }
      }
      const found = findQuoteOffsets(text, comment.quote);
      if (found) next.set(comment.id, found);
    }
    commentAnchorsRef.current = next;
    lastTextRef.current = text;
    updateCaretComment();
  }, [comments, docId, externalRevision, updateCaretComment]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const registry = (
      CSS as unknown as {
        highlights?: {
          set: (name: string, highlight: unknown) => void;
          delete: (name: string) => void;
        };
      }
    ).highlights;
    const HighlightConstructor = (
      window as unknown as {
        Highlight?: new (...ranges: Range[]) => unknown;
      }
    ).Highlight;
    if (!registry || !HighlightConstructor) return;
    const ranges: Range[] = [];
    const activeRanges: Range[] = [];
    for (const [id, anchor] of commentAnchorsRef.current) {
      if (anchor.end <= anchor.start) continue;
      const start = pointAtOffset(editor, anchor.start);
      const end = pointAtOffset(editor, anchor.end);
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      if (id === activeCommentId) activeRanges.push(range);
      else ranges.push(range);
    }
    registry.set('alter-comment', new HighlightConstructor(...ranges));
    registry.set(
      'alter-comment-active',
      new HighlightConstructor(...activeRanges),
    );
    const clearIconMarks = markCommentLinkIcons(editor, ranges, activeRanges);
    return () => {
      clearIconMarks();
      registry.delete('alter-comment');
      registry.delete('alter-comment-active');
    };
  }, [comments, contentTick, activeCommentId, docId, externalRevision]);

  useEffect(() => {
    const active =
      slashMenuRef.current?.querySelector<HTMLElement>('[data-active]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [slash]);

  // Pin the rendered menu to its command line: to the line start horizontally,
  // 12px inside the viewport, and on the side the menu first appeared on. The
  // side is decided by the first measurement after opening and reused while the
  // query filters the list, so a shorter (or empty) menu never flips across the
  // command line; only the offset is re-measured.
  useLayoutEffect(() => {
    const menu = slashMenuRef.current;
    const line = slash?.line;
    if (!menu || !line || !line.isConnected) return;
    const lineRect = line.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const placement = placeSlashMenu({
      lineTop: lineRect.top,
      lineBottom: lineRect.bottom,
      lineLeft: lineRect.left,
      menuWidth: menuRect.width,
      menuHeight: menuRect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      preferredSide: slash.side,
    });
    if (
      placement.side === slash.side &&
      Math.abs(placement.top - slash.top) < 0.5 &&
      Math.abs(placement.left - slash.left) < 0.5
    )
      return;
    setSlash((current) =>
      current && current.line === line
        ? {
            ...current,
            top: placement.top,
            left: placement.left,
            side: placement.side,
          }
        : current,
    );
  }, [slash]);

  useEffect(() => {
    return () => {
      if (linkTimerRef.current) window.clearTimeout(linkTimerRef.current);
    };
  }, []);

  function restoreSelection() {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (
      selection?.rangeCount &&
      !selection.isCollapsed &&
      selection.anchorNode &&
      editor.contains(selection.anchorNode)
    ) {
      savedRangeRef.current = selection.getRangeAt(0).cloneRange();
      savedQuoteRef.current = selection.toString().trim();
      return;
    }
    const range = savedRangeRef.current;
    if (!range || !editor.contains(range.commonAncestorContainer)) return;
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function withSelection(action: () => void) {
    restoreSelection();
    action();
    notifyChange();
  }

  function currentBlockKind(): BlockKind | null {
    const selection = window.getSelection();
    const node =
      selection?.anchorNode ?? savedRangeRef.current?.startContainer ?? null;
    const line = lineElement(node);
    if (!line) return null;
    if (line.dataset.todo !== undefined) return 'todo';
    if (line.closest('blockquote')) return 'quote';
    if (line.closest('pre')) return 'code';
    const item = line.closest('li');
    if (item) return item.closest('ol') ? 'ordered' : 'bullet';
    const tag = line.tagName.toLowerCase();
    if (tag === 'h1') return 'h1';
    if (tag === 'h2') return 'h2';
    if (tag === 'h3') return 'h3';
    if (tag === 'p') return 'text';
    return null;
  }

  function removeEmptyFormats(editor: HTMLElement) {
    const selector = 'strong,b,u,s,del,strike,code,mark';
    for (const element of [...editor.querySelectorAll<HTMLElement>(selector)]) {
      if (element.closest('pre')) continue;
      if (element.textContent?.trim()) continue;
      if (element.querySelector('img,[data-file]')) continue;
      element.remove();
    }
  }

  function inlineTag(kind: InlineKind) {
    if (kind === 'bold') return 'strong';
    if (kind === 'underline') return 'u';
    if (kind === 'strike') return 's';
    if (kind === 'code') return 'code';
    return 'mark';
  }

  function toggleInline(kind: InlineKind) {
    const editor = editorRef.current;
    if (!editor) return;
    restoreSelection();
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    const wasAll = formatStatesForRange(editor, range)[kind] === 'all';
    const fragment = range.extractContents();
    if (wasAll) {
      const marker = document.createElement('span');
      marker.append(fragment);
      range.insertNode(marker);
      const selected = document.createRange();
      selected.selectNodeContents(marker);
      selection.removeAllRanges();
      selection.addRange(selected);
      removeInlineFormat(editor, marker, kind);
      const first = marker.firstChild;
      const last = marker.lastChild;
      const restored = document.createRange();
      if (first && last) {
        restored.setStartBefore(first);
        restored.setEndAfter(last);
      }
      marker.replaceWith(...marker.childNodes);
      if (first && last) {
        selection.removeAllRanges();
        selection.addRange(restored);
      }
    } else {
      const wrapper = document.createElement(inlineTag(kind));
      wrapper.append(fragment);
      for (const element of [
        ...wrapper.querySelectorAll<HTMLElement>(inlineSelectors[kind]),
      ]) {
        if (kind === 'code' && element.closest('pre')) continue;
        element.replaceWith(...element.childNodes);
      }
      range.insertNode(wrapper);
      const selected = document.createRange();
      selected.selectNodeContents(wrapper);
      selection.removeAllRanges();
      selection.addRange(selected);
    }
    removeEmptyFormats(editor);
    const current = window.getSelection();
    if (current?.rangeCount) {
      setInlineFormats(formatStatesForRange(editor, current.getRangeAt(0)));
      savedRangeRef.current = current.getRangeAt(0).cloneRange();
    }
    notifyChange();
  }

  function executeBlock(tag: 'p' | 'h1' | 'h2' | 'h3') {
    withSelection(() => {
      const selection = window.getSelection();
      const line = lineElement(selection?.anchorNode ?? null);
      if (line) convertLineTo(line, tag);
      else document.execCommand('formatBlock', false, tag);
    });
  }

  function toggleList(ordered: boolean) {
    withSelection(() => {
      const selection = window.getSelection();
      const line = lineElement(selection?.anchorNode ?? null);
      if (line && line.tagName.toLowerCase() === 'li') {
        document.execCommand(
          ordered ? 'insertOrderedList' : 'insertUnorderedList',
        );
        return;
      }
      if (line) {
        convertLineToList(line, ordered);
        return;
      }
      document.execCommand(
        ordered ? 'insertOrderedList' : 'insertUnorderedList',
      );
    });
  }

  function convertCurrentLine(kind: 'todo' | 'quote' | 'code') {
    withSelection(() => {
      const selection = window.getSelection();
      const line = lineElement(selection?.anchorNode ?? null);
      if (!line) return;
      if (kind === 'todo') convertLineToTodo(line);
      if (kind === 'quote') convertLineTo(line, 'blockquote');
      if (kind === 'code') convertLineToCode(line);
    });
  }

  function closeSlash() {
    setSlash(null);
  }

  /**
   * Open the command menu for one line; placement is measured after render.
   * A fresh menu decides its direction from scratch (第 12 项); only the
   * IME-restored menu passes the side its predecessor was pinned to.
   */
  function openSlash(
    line: HTMLElement,
    query: string,
    side: SlashMenuSide | null = null,
  ) {
    setSlash({ line, query, top: 0, left: 0, index: 0, side });
  }

  function pickFile(kind: 'image' | 'file', line: HTMLElement) {
    line.innerHTML = '';
    placeCaretAtEnd(line);
    const selection = window.getSelection();
    const savedRange =
      selection?.rangeCount && selection.isCollapsed
        ? selection.getRangeAt(0).cloneRange()
        : null;
    const input = document.createElement('input');
    input.type = 'file';
    if (kind === 'image') input.accept = 'image/*';
    input.onchange = () => {
      if (input.files?.length) void insertFiles(input.files, savedRange);
    };
    input.click();
  }

  function executeSlash(command: SlashCommand) {
    if (!slash || composingRef.current) return;
    const line = slash.line;
    setSlash(null);
    if (!line.isConnected) return;
    if (command.action) pickFile(command.action, line);
    else command.run?.(line);
    notifyChange();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // IME composition owns the keystrokes (shortcuts must not fire mid-word).
    const nativeKey = event.nativeEvent as globalThis.KeyboardEvent;
    if (
      composingRef.current ||
      nativeKey.isComposing === true ||
      nativeKey.keyCode === 229
    )
      return;
    const editor = editorRef.current;
    if (editor) {
      normalizeTodoCaret(editor);
      if (
        event.target === editor &&
        event.key === 'ArrowLeft' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        moveCaretBeforeTodo(editor)
      ) {
        event.preventDefault();
        return;
      }
    }
    const focusedTodo = (event.target as HTMLElement).closest?.(
      '[data-todo-box]',
    );
    if (focusedTodo && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault();
      const todo = focusedTodo.closest('[data-todo]');
      if (todo instanceof HTMLElement) toggleTodo(todo);
      return;
    }
    const focusedLink = (event.target as HTMLElement).closest?.<HTMLElement>(
      '[data-link-card], a[data-web-link], [data-file]',
    );
    if (focusedLink && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      setLinkBar(null);
      if (focusedLink.dataset.file !== undefined) {
        const href = focusedLink.dataset.href;
        if (href) window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      openWebUrl(
        focusedLink.dataset.linkCard ?? focusedLink.getAttribute('href'),
      );
      return;
    }
    // 第 1/6 项：分割线与图片先选中再删除。光标贴着这类块时，第一次删除键
    // 只选中整块（Escape 可取消），第二次才真正移除。
    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const selectable = adjacentSelectableBlock(
        event.key === 'Backspace' ? 'backward' : 'forward',
      );
      if (selectable) {
        event.preventDefault();
        selectBlock(selectable);
        return;
      }
    }
    // D3: deleting an empty list item keeps the list continuous and puts the
    // caret where the user can keep typing.
    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const caret = window.getSelection();
      if (
        caret?.rangeCount &&
        caret.isCollapsed &&
        caret.anchorNode &&
        editor?.contains(caret.anchorNode)
      ) {
        const item = lineElement(caret.anchorNode);
        const list = item === null ? null : item.parentElement;
        if (
          item !== null &&
          item.tagName.toLowerCase() === 'li' &&
          item.contains(caret.anchorNode) &&
          (item.textContent ?? '').trim() === '' &&
          list !== null &&
          (list.tagName === 'UL' || list.tagName === 'OL')
        ) {
          event.preventDefault();
          removeEmptyListItem(item, list);
          notifyChange();
          return;
        }
        // 9: an empty todo is a row of its own: Backspace removes it instead of
        // leaving the caret parked at the row start.
        if (
          item !== null &&
          item.dataset.todo !== undefined &&
          item.contains(caret.anchorNode) &&
          (item.querySelector('[data-todo-text]')?.textContent ?? '').trim() === ''
        ) {
          event.preventDefault();
          removeEmptyTodoLine(item);
          notifyChange();
          return;
        }
        // 14: Backspace at the very start of a quote line only drops that
        // line's quote marker (it turns back into a text paragraph in place,
        // content and caret kept). The browser default would fold the line into
        // the previous one — carrying the quote there — which reads as "the
        // quote moved up" instead of "the marker was deleted". A second
        // Backspace then behaves as a normal backward delete.
        if (
          event.key === 'Backspace' &&
          selectedBlock === null &&
          item !== null &&
          item.tagName.toLowerCase() === 'blockquote' &&
          item.parentElement === editor &&
          item.contains(caret.anchorNode) &&
          // A quote holding a nested quote cannot be flattened into a
          // paragraph; leave that block to the default merge.
          item.querySelector('blockquote') === null &&
          // Text-only "at start" would treat a caret right after a leading
          // inline image as line start and swallow the media instead of
          // deleting it.
          isCaretBeforeLineContent(item)
        ) {
          event.preventDefault();
          const paragraph = convertLineTo(item, 'p');
          placeCaretAtStart(paragraph);
          notifyChange();
          return;
        }
        // 11: a document holding a single empty line must keep that line. Letting
        // the default delete tear it down drops the caret out of the line box and
        // brings the placeholder back while the caret sits above it.
        if (editor !== null && isEmptyDocumentLine(editor, item)) {
          event.preventDefault();
          ensureEmptyLineCaret(editor, item);
          return;
        }
      }
    }
    if (slash) {
      const commands = filterCommands(
        buildSlashCommands(slash.line),
        slash.query,
      );
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlash({
          ...slash,
          index: commands.length ? (slash.index + 1) % commands.length : 0,
        });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlash({
          ...slash,
          index: commands.length
            ? (slash.index - 1 + commands.length) % commands.length
            : 0,
        });
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const command = commands[slash.index] ?? commands[0];
        if (command) executeSlash(command);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSlash();
        return;
      }
    }

    if (
      selectedBlock &&
      (event.key === 'Backspace' || event.key === 'Delete')
    ) {
      event.preventDefault();
      removeSelectedBlock();
      return;
    }
    if (selectedBlock && event.key === 'Escape') {
      event.preventDefault();
      clearBlockSelection();
      return;
    }
    if (selectedBlock) {
      // Any other key returns to normal caret editing.
      clearBlockSelection();
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u') {
      event.preventDefault();
      toggleInline('underline');
      return;
    }

    const selectionNode = window.getSelection()?.anchorNode;
    const cell = (
      selectionNode instanceof HTMLElement
        ? selectionNode
        : selectionNode?.parentElement
    )?.closest('td,th');
    if (cell && event.key === 'Tab') {
      const table = cell.closest('table');
      if (!table) return;
      const cells = [...table.querySelectorAll('th,td')];
      const index = cells.indexOf(cell);
      const next = cells[index + (event.shiftKey ? -1 : 1)];
      if (!next) return;
      event.preventDefault();
      placeCaretAtEnd(next as HTMLElement);
      return;
    }

    const selection = window.getSelection();
    const line = lineElement(selection?.anchorNode ?? null);

    if (line && (event.key === ' ' || event.key === 'Enter')) {
      const text = (line.textContent ?? '').trimEnd();
      const ordered = /^(\d{1,7})\.$/.exec(text);
      const blocks: Record<string, () => void> = {
        '#': () => convertLineTo(line, 'h1'),
        '##': () => convertLineTo(line, 'h2'),
        '###': () => convertLineTo(line, 'h3'),
        '-': () => convertLineToList(line, false),
        '*': () => convertLineToList(line, false),
        '[]': () => convertLineToTodo(line),
        '[ ]': () => convertLineToTodo(line),
        // 第 13 项：引用标记按标准 `>` + 空格输入；中文输入法打出的全角
        // `》` 是同一个手势，两者都不再「单独出现即转换」。
        '>': () => convertLineTo(line, 'blockquote'),
        '》': () => convertLineTo(line, 'blockquote'),
      };
      if (event.key === ' ' && (blocks[text] || ordered)) {
        event.preventDefault();
        if (isCaretAtEnd(line)) {
          line.innerHTML = '';
          if (ordered) {
            convertLineToList(line, true, Number.parseInt(ordered[1]!, 10));
          } else {
            blocks[text]?.();
          }
          notifyChange();
        }
        return;
      }
      if (text === '```' && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        line.innerHTML = '';
        convertLineToCode(line);
        notifyChange();
        return;
      }
      if (text === '---' && event.key === 'Enter') {
        event.preventDefault();
        line.innerHTML = '';
        convertLineToDivider(line);
        notifyChange();
        return;
      }
    }

    if (event.key === '/') {
      if (
        line &&
        (line.textContent ?? '') === '' &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault();
        document.execCommand('insertText', false, '/');
        const current = lineElement(window.getSelection()?.anchorNode ?? null);
        if (current) openSlash(current, '');
        return;
      }
    }

    if (line && line.dataset.todo !== undefined) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const text = line.querySelector('[data-todo-text]');
        const content = text?.textContent?.trim() ?? '';
        if (!content) {
          const paragraph = createParagraph();
          line.replaceWith(paragraph);
          placeCaretAtEnd(paragraph);
        } else {
          const todo = document.createElement('div');
          todo.dataset.todo = '';
          todo.dataset.checked = 'false';
          const nextBox = document.createElement('span');
          nextBox.dataset.todoBox = '';
          nextBox.setAttribute('contenteditable', 'false');
          nextBox.setAttribute('role', 'checkbox');
          nextBox.setAttribute('aria-checked', 'false');
          nextBox.setAttribute('aria-label', '待办事项');
          nextBox.setAttribute('tabindex', '0');
          const nextText = document.createElement('span');
          nextText.dataset.todoText = '';
          nextText.append(document.createElement('br'));
          todo.append(nextBox, nextText);
          line.after(todo);
          placeCaretAtEnd(nextText);
        }
        notifyChange();
        return;
      }
    }

    if (line?.tagName.toLowerCase() === 'pre') {
      if (event.key === 'Enter') {
        event.preventDefault();
        const code = line.querySelector('code') ?? line;
        const full = (code.textContent ?? '').replaceAll('\u200b', '');
        if (!full) return;
        const current = window.getSelection();
        let offset = full.length;
        if (current?.rangeCount) {
          const range = current.getRangeAt(0);
          if (code.contains(range.startContainer)) {
            const before = document.createRange();
            before.selectNodeContents(code);
            before.setEnd(range.startContainer, range.startOffset);
            offset = Math.min(
              before.toString().replaceAll('\u200b', '').length,
              full.length,
            );
          }
        }
        const tail = full.slice(offset);
        const next = `${full.slice(0, offset)}\n${tail}${tail ? '' : '\u200b'}`;
        code.textContent = next;
        const textNode = code.firstChild;
        if (textNode) {
          const caret = document.createRange();
          caret.setStart(textNode, Math.min(next.length, offset + 1));
          caret.collapse(true);
          current?.removeAllRanges();
          current?.addRange(caret);
        }
        notifyChange();
        return;
      }
    }
  }

  /**
   * Remove one empty list item and keep the caret on the current line.
   *
   * Per 《编辑器专题优化》第 2 项 the current line degrades to an empty
   * paragraph (splitting the list around it) instead of sending the caret back
   * to the end of the previous item. An ordered list tail keeps numbering.
   */
  function removeEmptyListItem(item: HTMLElement, list: HTMLElement) {
    const ordered = list.tagName === 'OL';
    const rawStart = Number.parseInt(list.getAttribute('start') ?? '1', 10);
    const baseStart = Number.isFinite(rawStart) ? rawStart : 1;
    const index = [...list.children].indexOf(item);
    const trailing: HTMLElement[] = [];
    for (
      let node = item.nextElementSibling;
      node !== null;
      node = node.nextElementSibling
    ) {
      if (node instanceof HTMLElement) trailing.push(node);
    }
    const paragraph = createParagraph();
    item.remove();
    if (trailing.length === 0) {
      if (list.children.length === 0) list.replaceWith(paragraph);
      else list.after(paragraph);
    } else {
      // The tail keeps its displayed numbers: start = base + removed index + 1.
      const tail = document.createElement(list.tagName.toLowerCase());
      const start = baseStart + index + 1;
      if (ordered && start !== 1) tail.setAttribute('start', String(start));
      tail.append(...trailing);
      if (list.children.length === 0) list.replaceWith(paragraph, tail);
      else list.after(paragraph, tail);
    }
    placeCaretAtStart(paragraph);
  }

  /** True when the caret sits on the editor's only line and that line is empty. */
  function isEmptyDocumentLine(editor: HTMLElement, line: HTMLElement | null) {
    if ((editor.textContent ?? '') !== '') return false;
    // The caret can also sit on the host itself once the line was torn down.
    if (line === null) return true;
    if (editor.children.length !== 1 || editor.firstElementChild !== line)
      return false;
    return line.tagName === 'P';
  }

  /** Rebuild the single empty line and park the caret at its first position. */
  function ensureEmptyLineCaret(
    editor: HTMLElement,
    line: HTMLElement | null,
  ) {
    const target =
      line ?? editor.querySelector<HTMLElement>('p') ?? createParagraph();
    if (!target.isConnected) editor.append(target);
    if (!target.firstChild) target.append(document.createElement('br'));
    placeCaretAtStart(target);
  }

  /** Remove an empty todo row and park the caret on the nearest line box. */
  function removeEmptyTodoLine(todo: HTMLElement) {
    const previous = todo.previousElementSibling;
    const next = todo.nextElementSibling;
    if (previous instanceof HTMLElement) {
      todo.remove();
      placeCaretOnLine(previous, 'end');
      return;
    }
    if (next instanceof HTMLElement) {
      todo.remove();
      placeCaretOnLine(next, 'start');
      return;
    }
    // The todo was the only line: leave a plain paragraph behind.
    const paragraph = createParagraph();
    todo.replaceWith(paragraph);
    placeCaretAtStart(paragraph);
  }

  /** Place the caret inside a line, entering the todo text span when needed. */
  function placeCaretOnLine(line: HTMLElement, edge: 'start' | 'end') {
    const target =
      line.dataset.todo !== undefined
        ? (line.querySelector<HTMLElement>('[data-todo-text]') ?? line)
        : line;
    // Empty lines only have a placeholder <br>: collapsing after it would put
    // the caret on a second, zero-height line.
    if (edge === 'end' && (target.textContent ?? '') !== '')
      placeCaretAtEnd(target);
    else placeCaretAtStart(target);
  }

  function handleFocus(event: FocusEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const link = target.closest?.<HTMLElement>(
      'a[data-web-link], [data-link-card]',
    );
    if (link) showLinkBar(link);
    const editor = editorRef.current;
    if (!editor) return;
    if (!hasBlockChild(editor)) {
      editor.innerHTML = '<p><br></p>';
      const paragraph = editor.firstElementChild;
      // 11: the caret must stay on the first line box (before the placeholder
      // <br>); collapsing after it would render one line lower.
      if (paragraph instanceof HTMLElement) placeCaretAtStart(paragraph);
      lastTextRef.current = editor.textContent ?? '';
    }
    updateCaretComment();
  }

  function handleBlur() {
    commentCaretRef.current = null;
    onCommentAtCaretChangeRef.current?.(null);
    clearBlockSelection();
  }

  function handleInput(event: FormEvent<HTMLDivElement>) {
    // Never treat half-composed IME text as final content.
    const nativeInput = event.nativeEvent as InputEvent | undefined;
    if (composingRef.current || nativeInput?.isComposing === true) return;
    if (slash) {
      const text = slash.line.textContent ?? '';
      if (slash.line.isConnected && text.startsWith('/')) {
        setSlash({ ...slash, query: text.slice(1), index: 0 });
      } else {
        setSlash(null);
      }
    }
    convertTypedDivider(nativeInput);
    // A plain input must keep a bare marker as text; only the composition path
    // may accept one without its space (see convertMarkerShortcut).
    convertMarkerShortcut(false);
    notifyChange();
  }

  async function insertFiles(files: File[] | FileList, range?: Range | null) {
    if (!files.length) return;
    const editor = editorRef.current;
    if (!editor) return;
    if (range && editor.contains(range.commonAncestorContainer)) {
      editor.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      editor.focus();
    }
    for (const file of Array.from(files)) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      }).catch(() => '');
      if (dataUrl === '') {
        notifyNotice(`该文件类型不支持：${file.name}`);
        continue;
      }
      if (file.type.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = dataUrl;
        image.alt = file.name;
        insertInlineNode(image);
      } else {
        const chip = document.createElement('span');
        chip.dataset.file = file.name;
        chip.dataset.href = dataUrl;
        chip.dataset.size = formatBytes(file.size);
        chip.setAttribute('contenteditable', 'false');
        chip.setAttribute('role', 'link');
        chip.setAttribute('tabindex', '0');
        chip.setAttribute('aria-label', `打开文件 ${file.name}`);
        chip.setAttribute('title', file.name);
        const icon = document.createElement('span');
        icon.dataset.fileIcon = '';
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('contenteditable', 'false');
        icon.innerHTML =
          '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19"/></svg>';
        const label = document.createElement('span');
        label.textContent = `${file.name} · ${formatBytes(file.size)}`;
        chip.append(icon, label);
        insertInlineNode(chip);
      }
    }
    notifyChange();
  }

  /** Paste rich text through the sanitizer; plain text stays plain. */
  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    if (!editor) return;
    const clipboard = event.clipboardData;
    const files = clipboard.files;
    if (files.length) {
      event.preventDefault();
      void insertFiles(files);
      return;
    }
    const html = clipboard.getData('text/html');
    if (html !== '') {
      event.preventDefault();
      const sanitized = sanitizePastedHtml(html);
      if (sanitized.empty) {
        const fallback = clipboard.getData('text/plain');
        if (fallback !== '') {
          ensureCaret();
          insertPlainTextAtCaret(fallback);
          notifyChange();
        }
        return;
      }
      insertSanitizedHtml(editor, sanitized.html);
      if (sanitized.simplified) notifyNotice('部分粘贴内容已简化');
      notifyChange();
      return;
    }
    const text = clipboard.getData('text/plain');
    if (!text) return;
    const docId = docIdFromPaste(text);
    if (docId) {
      const doc = findDoc(docId);
      if (doc) {
        event.preventDefault();
        insertInlineNode(docLinkElement(doc));
        notifyChange();
        return;
      }
    }
    if (isWebUrl(text)) {
      event.preventDefault();
      insertInlineNode(webLinkElement(text.trim()));
      notifyChange();
      return;
    }
    event.preventDefault();
    ensureCaret();
    insertPlainTextAtCaret(text);
    notifyChange();
  }

  /** Caret range for a drop point, when the browser exposes one. */
  function dropRange(event: DragEvent<HTMLDivElement>): Range | null {
    const editor = editorRef.current;
    if (!editor) return null;
    const point = event.nativeEvent as globalThis.DragEvent;
    const caretDocument = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    };
    if (typeof caretDocument.caretRangeFromPoint === 'function') {
      const range = caretDocument.caretRangeFromPoint(point.clientX, point.clientY);
      if (range && editor.contains(range.startContainer)) return range;
    }
    if (typeof caretDocument.caretPositionFromPoint === 'function') {
      const position = caretDocument.caretPositionFromPoint(
        point.clientX,
        point.clientY,
      );
      if (position && editor.contains(position.offsetNode)) {
        const range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        return range;
      }
    }
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode))
      return selection.getRangeAt(0);
    return null;
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    const types = event.dataTransfer?.types;
    if (!types) return;
    const values = Array.from(types as ArrayLike<string>);
    if (
      values.includes('Files') ||
      values.includes('text/html') ||
      values.includes('text/plain')
    ) {
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = 'copy';
      } catch {
        // Read-only dataTransfer in restricted hosts: dropping still works.
      }
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    const data = event.dataTransfer;
    if (!editor || !data) return;
    const files = data.files;
    if (files && files.length > 0) {
      event.preventDefault();
      void insertFiles(files, dropRange(event));
      return;
    }
    const html = data.getData('text/html');
    if (html !== '') {
      event.preventDefault();
      const sanitized = sanitizePastedHtml(html);
      if (sanitized.empty) {
        const fallback = data.getData('text/plain');
        if (fallback !== '') {
          ensureCaret();
          insertPlainTextAtCaret(fallback);
          notifyChange();
        }
        return;
      }
      insertSanitizedHtml(editor, sanitized.html);
      if (sanitized.simplified) notifyNotice('部分拖入内容已简化');
      notifyChange();
      return;
    }
    const text = data.getData('text/plain');
    if (text !== '') {
      event.preventDefault();
      ensureCaret();
      insertPlainTextAtCaret(text);
      notifyChange();
    }
  }

  function toggleTodo(todo: HTMLElement) {
    const checked = todo.dataset.checked === 'true';
    todo.dataset.checked = checked ? 'false' : 'true';
    const box = todo.querySelector('[data-todo-box]');
    box?.setAttribute('aria-checked', checked ? 'false' : 'true');
    notifyChange();
  }

  function openWebUrl(url: string | null | undefined) {
    const value = (url ?? '').trim();
    if (!isWebUrl(value)) return;
    if (onOpenWeb) onOpenWeb(value);
    else window.open(value, '_blank', 'noopener,noreferrer');
  }

  function showLinkBar(element: HTMLElement) {
    if (linkBar?.element === element) return;
    if (linkTimerRef.current) window.clearTimeout(linkTimerRef.current);
    const rect = element.getBoundingClientRect();
    setLinkBar({
      element,
      left: Math.min(
        Math.max(12, rect.left),
        Math.max(12, window.innerWidth - 260),
      ),
      top: Math.max(10, rect.top - 42),
      kind: element.dataset.linkCard ? 'card' : 'inline',
    });
  }

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const todoBox = target.closest('[data-todo-box]');
    if (todoBox) {
      event.preventDefault();
      const todo = todoBox.closest('[data-todo]');
      if (todo instanceof HTMLElement) toggleTodo(todo);
      return;
    }
    const image = target.closest('img');
    if (image instanceof HTMLElement) {
      event.preventDefault();
      selectBlock(image);
      return;
    }
    const divider = target.closest('[data-divider]');
    if (divider instanceof HTMLElement) {
      event.preventDefault();
      selectBlock(divider);
      return;
    }
    clearBlockSelection();
    const clickedTable = target.closest('table');
    if (!(clickedTable instanceof HTMLTableElement)) setTableBar(null);
    const linkCard = target.closest<HTMLElement>('[data-link-card]');
    if (linkCard?.dataset.linkCard) {
      event.preventDefault();
      setLinkBar(null);
      openWebUrl(linkCard.dataset.linkCard);
      return;
    }
    const webLink = target.closest<HTMLAnchorElement>('a[data-web-link]');
    if (webLink) {
      event.preventDefault();
      setLinkBar(null);
      openWebUrl(webLink.getAttribute('href'));
      return;
    }
    const docLink = target.closest<HTMLAnchorElement>('a[data-doc-link]');
    if (docLink?.dataset.docLink) {
      event.preventDefault();
      onOpenDoc(docLink.dataset.docLink);
      return;
    }
    const file = target.closest<HTMLElement>('[data-file]');
    if (file?.dataset.href) {
      event.preventDefault();
      window.open(file.dataset.href, '_blank', 'noopener,noreferrer');
      return;
    }
    window.setTimeout(() => {
      updateCaretComment();
      if (commentCaretRef.current) onCommentedTextClickRef.current?.();
    }, 0);
  }

  function handleMouseOver(event: MouseEvent<HTMLDivElement>) {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      'a[data-web-link], [data-link-card]',
    );
    if (target) {
      showLinkBar(target);
      return;
    }
    const table = (event.target as HTMLElement).closest('table');
    if (table instanceof HTMLTableElement) showTableBar(table);
  }

  function handleMouseLeave() {
    linkTimerRef.current = window.setTimeout(() => {
      setLinkBar(null);
      setTableBar(null);
    }, 180);
  }

  function openLinkEditor(element: HTMLElement) {
    const isCard = Boolean(element.dataset.linkCard);
    const href = isCard
      ? (element.dataset.linkCard ?? '')
      : (element.getAttribute('href') ?? '');
    const label = isCard
      ? (element.querySelector('strong')?.textContent ?? '')
      : (element.textContent ?? '');
    linkEditingElementRef.current = element;
    setLinkEditing({ href, label, kind: isCard ? 'card' : 'inline' });
    setLinkLabel(label);
    setLinkHref(href);
    setLinkError('');
    setLinkBar(null);
  }

  function saveLinkEdit() {
    if (!linkEditing) return;
    const url = linkHref.trim();
    if (!url) {
      setLinkError('填写链接地址');
      return;
    }
    if (!isWebUrl(url)) {
      setLinkError('链接地址格式不正确');
      return;
    }
    const label = linkLabel.trim() || webMetadata(url).title;
    const element = linkEditingElementRef.current;
    if (!element) return;
    if (linkEditing.kind === 'card') {
      element.dataset.linkCard = url;
      element.setAttribute('href', url);
      const title = element.querySelector('strong');
      if (title) title.textContent = label;
      const description = element.querySelector('span');
      if (description) description.textContent = webMetadata(url).description;
    } else {
      element.setAttribute('href', url);
      element.textContent = label;
    }
    setLinkEditing(null);
    notifyChange();
  }

  function convertLink() {
    if (!linkBar) return;
    const element = linkBar.element;
    if (linkBar.kind === 'inline') {
      const url = element.getAttribute('href') ?? '';
      const card = linkCardElement(url);
      const title = card.querySelector('strong');
      if (title) title.textContent = element.textContent ?? title.textContent;
      element.replaceWith(card);
    } else {
      const url = element.dataset.linkCard ?? '';
      const link = webLinkElement(url);
      const title = element.querySelector('strong');
      if (title?.textContent) link.textContent = title.textContent;
      element.replaceWith(link);
    }
    setLinkBar(null);
    notifyChange();
  }

  const commands = slash
    ? filterCommands(buildSlashCommands(slash.line), slash.query)
    : [];

  const blockActions: MenuAction[] = [
    {
      id: 'p',
      label: '正文',
      icon: <Text />,
      active: activeBlock === 'text',
      onSelect: () => executeBlock('p'),
    },
    {
      id: 'h1',
      label: '标题 1',
      icon: <Heading1 />,
      active: activeBlock === 'h1',
      onSelect: () => executeBlock('h1'),
    },
    {
      id: 'h2',
      label: '标题 2',
      icon: <Heading2 />,
      active: activeBlock === 'h2',
      onSelect: () => executeBlock('h2'),
    },
    {
      id: 'h3',
      label: '标题 3',
      icon: <Heading3 />,
      active: activeBlock === 'h3',
      onSelect: () => executeBlock('h3'),
    },
    {
      id: 'bullet',
      label: '无序列表',
      icon: <List />,
      active: activeBlock === 'bullet',
      onSelect: () => toggleList(false),
    },
    {
      id: 'ordered',
      label: '有序列表',
      icon: <ListOrdered />,
      active: activeBlock === 'ordered',
      onSelect: () => toggleList(true),
    },
    {
      id: 'todo',
      label: '待办',
      icon: <ListTodo />,
      active: activeBlock === 'todo',
      separatorBefore: true,
      onSelect: () => convertCurrentLine('todo'),
    },
    {
      id: 'quote',
      label: '引用',
      icon: <Quote />,
      active: activeBlock === 'quote',
      onSelect: () => convertCurrentLine('quote'),
    },
    {
      id: 'code',
      label: '代码块',
      icon: <Code2 />,
      active: activeBlock === 'code',
      onSelect: () => convertCurrentLine('code'),
    },
  ];

  return (
    <div className={styles.editor}>
      <div
        ref={editorRef}
        className={styles.surface}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline="true"
        aria-label="文档正文"
        data-placeholder="开始写点什么…"
        onInput={handleInput}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={handleClick}
        onMouseOver={handleMouseOver}
        onMouseLeave={handleMouseLeave}
      />

      {toolbar ? (
        <>
          <div
            ref={toolbarRef}
            className={styles.floating}
            style={{
              left: toolbar.left,
              top: toolbar.top,
              transform: toolbar.below
                ? 'translate(-50%, 0)'
                : 'translate(-50%, -100%)',
            }}
            onMouseDown={(event) => event.preventDefault()}
            role="toolbar"
            aria-label="文本格式"
          >
            <button
              type="button"
              className={styles.toolButton}
              aria-label="文本类型"
              title="文本类型"
              onClick={() => {
                setActiveBlock(currentBlockKind());
                setBlockAnchor(toolbarRef.current);
              }}
            >
              <Type size={15} strokeWidth={1.7} />
            </button>
            <span className={styles.toolDivider} />
            <button
              type="button"
              className={styles.toolButton}
              aria-label="粗体"
              title="粗体"
              data-state={inlineFormats.bold}
              aria-pressed={
                inlineFormats.bold === 'all'
                  ? true
                  : inlineFormats.bold === 'mixed'
                    ? 'mixed'
                    : false
              }
              onClick={() => toggleInline('bold')}
            >
              <Bold size={15} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={styles.toolButton}
              aria-label="下划线"
              title="下划线"
              data-state={inlineFormats.underline}
              aria-pressed={
                inlineFormats.underline === 'all'
                  ? true
                  : inlineFormats.underline === 'mixed'
                    ? 'mixed'
                    : false
              }
              onClick={() => toggleInline('underline')}
            >
              <Underline size={15} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={styles.toolButton}
              aria-label="删除线"
              title="删除线"
              data-state={inlineFormats.strike}
              aria-pressed={
                inlineFormats.strike === 'all'
                  ? true
                  : inlineFormats.strike === 'mixed'
                    ? 'mixed'
                    : false
              }
              onClick={() => toggleInline('strike')}
            >
              <Strikethrough size={15} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={styles.toolButton}
              aria-label="行内代码"
              title="行内代码"
              data-state={inlineFormats.code}
              aria-pressed={
                inlineFormats.code === 'all'
                  ? true
                  : inlineFormats.code === 'mixed'
                    ? 'mixed'
                    : false
              }
              onClick={() => toggleInline('code')}
            >
              <Code2 size={15} strokeWidth={1.7} />
            </button>
            <button
              type="button"
              className={styles.toolButton}
              aria-label="高亮"
              title="高亮"
              data-state={inlineFormats.highlight}
              aria-pressed={
                inlineFormats.highlight === 'all'
                  ? true
                  : inlineFormats.highlight === 'mixed'
                    ? 'mixed'
                    : false
              }
              onClick={() => toggleInline('highlight')}
            >
              <Highlighter size={15} strokeWidth={1.7} />
            </button>
            <span className={styles.toolDivider} />
            <button
              type="button"
              className={styles.toolButton}
              aria-label="添加评论"
              title="添加评论"
              onClick={() => {
                const quote =
                  window.getSelection()?.toString().trim() ||
                  savedQuoteRef.current ||
                  toolbar.quote;
                if (quote) onComment(quote);
                setToolbar(null);
              }}
            >
              <MessageSquarePlus size={15} strokeWidth={1.7} />
            </button>
          </div>
          <span
            className={styles.wordCount}
            style={{ left: toolbar.countLeft, top: toolbar.countTop }}
          >
            {toolbar.count} 字
          </span>
          <Menu
            anchor={blockAnchor}
            open={Boolean(blockAnchor)}
            onClose={() => setBlockAnchor(null)}
            align="start"
            width={172}
            actions={blockActions}
          />
        </>
      ) : null}

      {slash
        ? createPortal(
            <div
              ref={slashMenuRef}
              className={styles.slashMenu}
              style={{ top: slash.top, left: slash.left }}
              role="listbox"
              aria-label="插入内容"
              onMouseDown={(event) => event.preventDefault()}
            >
              {commands.length ? (
                commands.map((command, index) => (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={index === slash.index}
                    className={styles.slashItem}
                    data-active={index === slash.index || undefined}
                    onMouseEnter={() =>
                      setSlash((current) =>
                        current ? { ...current, index } : current,
                      )
                    }
                    onClick={() => executeSlash(command)}
                  >
                    <span className={styles.slashIcon} aria-hidden="true">
                      {command.icon}
                    </span>
                    {command.label}
                  </button>
                ))
              ) : (
                <p className={styles.slashEmpty}>没有匹配的指令</p>
              )}
            </div>,
            document.body,
          )
        : null}

      {linkBar
        ? createPortal(
            <div
              className={styles.linkBar}
              style={{ top: linkBar.top, left: linkBar.left }}
              role="group"
              aria-label="链接操作"
              onMouseEnter={() => {
                if (linkTimerRef.current)
                  window.clearTimeout(linkTimerRef.current);
              }}
              onMouseLeave={handleMouseLeave}
            >
              <button
                type="button"
                aria-label={
                  linkBar.kind === 'card' ? '转为行内链接' : '转为卡片链接'
                }
                title={linkBar.kind === 'card' ? '转为行内链接' : '转为卡片链接'}
                onClick={convertLink}
              >
                {linkBar.kind === 'card' ? '转为行内' : '转为卡片'}
              </button>
              <button
                type="button"
                aria-label="编辑链接"
                title="编辑链接"
                onClick={() => openLinkEditor(linkBar.element)}
              >
                编辑
              </button>
            </div>,
            document.body,
          )
        : null}

      {tableBar
        ? createPortal(
            <div
              className={styles.linkBar}
              style={{ top: tableBar.top, left: tableBar.left }}
              role="group"
              aria-label="表格操作"
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => {
                if (linkTimerRef.current)
                  window.clearTimeout(linkTimerRef.current);
              }}
              onMouseLeave={handleMouseLeave}
            >
              {selectedBlock === tableBar.element ? (
                <>
                  <button
                    type="button"
                    aria-label="上移表格"
                    title="上移"
                    onClick={() => moveSelectedTable(-1)}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    aria-label="下移表格"
                    title="下移"
                    onClick={() => moveSelectedTable(1)}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    aria-label="删除表格"
                    title="删除"
                    onClick={() => removeSelectedBlock()}
                  >
                    删除
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  aria-label="选中表格"
                  title="选中整表"
                  onClick={selectTableBlock}
                >
                  选中
                </button>
              )}
            </div>,
            document.body,
          )
        : null}

      <Dialog
        open={Boolean(linkEditing)}
        onClose={() => setLinkEditing(null)}
        title="编辑链接"
        size="small"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLinkEditing(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={saveLinkEdit}>
              保存
            </Button>
          </>
        }
      >
        <div className={styles.linkForm}>
          <label className={styles.linkField}>
            <span>显示文本</span>
            <input
              value={linkLabel}
              onChange={(event) => setLinkLabel(event.target.value)}
            />
          </label>
          <label className={styles.linkField}>
            <span>链接地址</span>
            <input
              value={linkHref}
              onChange={(event) => setLinkHref(event.target.value)}
            />
          </label>
          {linkError ? (
            <p className={styles.linkError} role="alert">
              {linkError}
            </p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
