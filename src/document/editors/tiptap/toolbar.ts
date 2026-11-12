/**
 * Floating format toolbar for the AST-native kernel.
 *
 * Parity with the frozen editor (`docs/acceptance/editor-experience-p0-p6.md` §2):
 *
 * - A non-collapsed selection inside the body raises one fixed bar with
 *   文本类型 / bold / underline / strike / inline code / highlight / 添加评论,
 *   separated like the frozen bar, plus a `{N} 字` bubble counting the
 *   **selected** characters with whitespace removed.
 * - The bar is placed above the first selection rectangle, or below it when the
 *   selection sits near the top of the viewport; horizontally it is clamped to
 *   a 300px-wide estimate. The bubble sits at the last rectangle's bottom-right.
 * - Selection updates are debounced by 120ms, a mousedown inside the body hides
 *   the bar immediately, IME composition keeps it hidden, and a collapsed
 *   selection hides it.
 *
 * The bar is a DOM overlay owned by the kernel: the document body itself is
 * never wrapped or restructured, and every button maps to one ProseMirror mark
 * command. Icons use the frozen lucide geometry from `icons.ts` at the exact
 * sizes and stroke widths the frozen editor passed to `lucide-react`.
 *
 * @module @alter-dsh/space/document/editors/tiptap/toolbar
 */
import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { KERNEL_CLASS } from './classes';
import { createIcon, type IconName } from './icons';

/** Marks the bar toggles, in the frozen display order. */
export const TOOLBAR_MARKS = [
  'bold',
  'underline',
  'strike',
  'code',
  'highlight',
] as const;

/** One inline mark the toolbar drives. */
export type ToolbarMark = (typeof TOOLBAR_MARKS)[number];

/** Format state of one mark across the current selection. */
export type FormatState = 'none' | 'mixed' | 'all';

/** Icon geometry per toolbar button, matching the frozen `lucide-react` calls. */
const MARK_ICON: Readonly<
  Record<ToolbarMark | 'textType' | 'comment', { name: IconName; strokeWidth: number }>
> = {
  textType: { name: 'type', strokeWidth: 1.7 },
  bold: { name: 'bold', strokeWidth: 1.8 },
  underline: { name: 'underline', strokeWidth: 1.8 },
  strike: { name: 'strikethrough', strokeWidth: 1.8 },
  code: { name: 'code2', strokeWidth: 1.7 },
  highlight: { name: 'highlighter', strokeWidth: 1.7 },
  comment: { name: 'messageSquarePlus', strokeWidth: 1.7 },
};

/** Accessible labels, matching the frozen editor. */
const LABEL: Readonly<
  Record<ToolbarMark | 'textType' | 'comment' | 'toolbar', string>
> = {
  textType: '文本类型',
  bold: '粗体',
  underline: '下划线',
  strike: '删除线',
  code: '行内代码',
  highlight: '高亮',
  comment: '添加评论',
  toolbar: '文本格式',
};

/** Toolbar width the frozen editor assumes for horizontal clamping. */
const TOOLBAR_WIDTH = 300;

/** Debounce of the selection observer, matching the frozen editor. */
const SELECTION_DEBOUNCE_MS = 120;

/** One rectangle of the current selection (the fields placement reads). */
export interface SelectionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** Geometry the toolbar placement needs. */
export interface ToolbarGeometry {
  /** First rectangle of the selection (top line). */
  first: SelectionRect;
  /** Last rectangle of the selection (bottom line). */
  last: SelectionRect;
  /** Top of the editable body, used for the "near the editor top" rule. */
  editorTop: number;
  /** Current viewport width. */
  viewportWidth: number;
}

/** Placement of the format bar. */
export interface ToolbarPlacement {
  left: number;
  top: number;
  below: boolean;
}

/** Placement of the selected-character bubble. */
export interface WordCountPlacement {
  left: number;
  top: number;
}

/**
 * Place the bar against the selection, flipping below when there is no room.
 *
 * The frozen editor estimates a 300px-wide bar, centers it on the first
 * rectangle and clamps it inside the viewport; it flips below the selection
 * when the selection is near the top of the window (70px) or of the body
 * (52px).
 */
export function placeToolbar(geometry: ToolbarGeometry): ToolbarPlacement {
  const { first, last } = geometry;
  const left = Math.min(
    Math.max(first.left + first.width / 2, TOOLBAR_WIDTH / 2 + 10),
    geometry.viewportWidth - TOOLBAR_WIDTH / 2 - 10,
  );
  const below = first.top < 70 || first.top - geometry.editorTop < 52;
  const top = below ? last.bottom + 8 : first.top - 8;
  return { left, top, below };
}

/** Place the `{N} 字` bubble at the last rectangle's bottom-right. */
export function placeWordCount(
  last: SelectionRect,
  viewportWidth: number,
): WordCountPlacement {
  return {
    left: Math.min(last.right + 8, viewportWidth - 46),
    top: last.bottom + 4,
  };
}

/**
 * Count the characters of the current selection the way the bubble shows them.
 *
 * The frozen editor strips **all** whitespace from the selected text and counts
 * code points, so an emoji counts as one.
 */
export function countSelectionCharacters(text: string): number {
  return [...text.replaceAll(/\s/gu, '')].length;
}

/**
 * Format state of one mark across a selection.
 *
 * Parity with the frozen bar's `formatStatesForRange`: non-whitespace text
 * nodes inside the selection are counted; none marked is `none`, all marked is
 * `all`, anything in between is `mixed`.
 */
export function markFormatState(editor: Editor, mark: ToolbarMark): FormatState {
  const { selection } = editor.state;
  if (selection.empty) return 'none';
  let total = 0;
  let marked = 0;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!node.isText) return true;
    const text = node.text ?? '';
    if (text.trim() === '') return false;
    total += 1;
    if (node.marks.some((item) => item.type.name === mark)) marked += 1;
    return false;
  });
  if (total === 0 || marked === 0) return 'none';
  return marked === total ? 'all' : 'mixed';
}

/** The toolbar overlay for one editor view. */
export interface FormatToolbar {
  element: HTMLElement;
  /** Schedule a debounced refresh for the current selection. */
  update(): void;
  /** Hide the bar without waiting for the debounced refresh. */
  hide(): void;
  destroy(): void;
}

/** Options of {@link createFormatToolbar}. */
export interface FormatToolbarOptions {
  editor: Editor;
  /** Open the comment composer for the current selection. */
  onComment(quote: string): void;
  /** Open the text-type menu (block conversion) anchored at `anchor`. */
  onTextType?(anchor: HTMLElement): void;
}

/** Keep only rectangles that occupy space (the frozen filter). */
function visibleRects(range: Range): SelectionRect[] {
  if (typeof range.getClientRects !== 'function') return [];
  try {
    return [...range.getClientRects()]
      .filter((rect) => rect.width > 0 || rect.height > 0)
      .map((rect) => ({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }));
  } catch {
    return [];
  }
}

/** Rectangles of a selection measured from the ProseMirror positions. */
function rectsFromPositions(view: EditorView): SelectionRect[] {
  const { selection } = view.state;
  if (selection.empty) return [];
  try {
    const start = view.domAtPos(selection.from);
    const end = view.domAtPos(selection.to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return visibleRects(range);
  } catch {
    return [];
  }
}

/** The body's plain selected text (the comment quote). */
function selectionQuote(view: EditorView): string {
  const selection = window.getSelection();
  if (
    selection !== null &&
    selection.rangeCount > 0 &&
    !selection.isCollapsed &&
    selection.anchorNode !== null &&
    selection.focusNode !== null &&
    view.dom.contains(selection.anchorNode) &&
    view.dom.contains(selection.focusNode)
  ) {
    return selection.toString().trim();
  }
  const { selection: pmSelection } = view.state;
  if (pmSelection.empty) return '';
  return view.state.doc
    .textBetween(pmSelection.from, pmSelection.to, '\n')
    .trim();
}

/** Measured selection used for placement, count and quote. */
interface MeasuredSelection {
  first: SelectionRect;
  last: SelectionRect;
  count: number;
}

/**
 * Measure the current selection.
 *
 * The DOM selection is authoritative in a browser. jsdom and other headless
 * environments have no DOM selection at all, so their measurements come from
 * the ProseMirror selection instead; a range without any layout rectangle
 * (the frozen editor hides the bar in that case) falls back to the caret
 * coordinates so tests can still observe the bar.
 */
function measureSelection(view: EditorView): MeasuredSelection | null {
  const selection = window.getSelection();
  if (selection !== null && selection.rangeCount > 0) {
    if (selection.isCollapsed) return null;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (anchor === null || focus === null) return null;
    if (!view.dom.contains(anchor) || !view.dom.contains(focus)) return null;
    const rects = visibleRects(selection.getRangeAt(0));
    if (rects.length === 0) return null;
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (first === undefined || last === undefined) return null;
    const text = selection.toString();
    return { first, last, count: countSelectionCharacters(text) };
  }
  const { selection: pmSelection } = view.state;
  if (pmSelection.empty) return null;
  const text = view.state.doc.textBetween(
    pmSelection.from,
    pmSelection.to,
    '\n',
  );
  const count = countSelectionCharacters(text);
  const rects = rectsFromPositions(view);
  const measuredFirst = rects[0];
  const measuredLast = rects[rects.length - 1];
  if (measuredFirst !== undefined && measuredLast !== undefined) {
    return { first: measuredFirst, last: measuredLast, count };
  }
  try {
    const from = view.coordsAtPos(pmSelection.from);
    const to = view.coordsAtPos(pmSelection.to);
    return {
      first: {
        left: from.left,
        right: from.right,
        top: from.top,
        bottom: from.bottom,
        width: Math.max(0, from.right - from.left),
        height: Math.max(0, from.bottom - from.top),
      },
      last: {
        left: to.left,
        right: to.right,
        top: to.top,
        bottom: to.bottom,
        width: Math.max(0, to.right - to.left),
        height: Math.max(0, to.bottom - to.top),
      },
      count,
    };
  } catch {
    return null;
  }
}

/** Build one toolbar button with the frozen classes and a11y attributes. */
function button(
  label: string,
  iconName: IconName,
  strokeWidth: number,
  onDown: () => void,
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = KERNEL_CLASS.toolButton;
  element.setAttribute('aria-label', label);
  element.title = label;
  element.append(createIcon(iconName, { size: 15, strokeWidth }));
  // Keep the selection while clicking, like the frozen bar.
  element.addEventListener('mousedown', (event) => event.preventDefault());
  element.addEventListener('click', onDown);
  return element;
}

function divider(): HTMLElement {
  const element = document.createElement('span');
  element.className = KERNEL_CLASS.toolDivider;
  return element;
}

/**
 * Create the floating toolbar for one editor.
 *
 * The elements are attached to `document.body` and positioned from the live
 * selection; they are removed on destroy so a kernel swap leaves nothing behind.
 */
export function createFormatToolbar(
  options: FormatToolbarOptions,
): FormatToolbar {
  const { editor } = options;
  const view = editor.view;

  const bar = document.createElement('div');
  bar.className = KERNEL_CLASS.floating;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', LABEL.toolbar);
  bar.addEventListener('mousedown', (event) => event.preventDefault());

  const textType = button(
    LABEL.textType,
    MARK_ICON.textType.name,
    MARK_ICON.textType.strokeWidth,
    () => options.onTextType?.(textType),
  );
  bar.append(textType, divider());

  const markButtons = new Map<ToolbarMark, HTMLButtonElement>();
  for (const mark of TOOLBAR_MARKS) {
    const icon = MARK_ICON[mark];
    const element = button(LABEL[mark], icon.name, icon.strokeWidth, () => {
      editor.chain().focus().toggleMark(mark).run();
      updateNow();
    });
    element.dataset['mark'] = mark;
    element.dataset['state'] = 'none';
    element.setAttribute('aria-pressed', 'false');
    bar.append(element);
    markButtons.set(mark, element);
  }

  bar.append(divider());
  const comment = button(
    LABEL.comment,
    MARK_ICON.comment.name,
    MARK_ICON.comment.strokeWidth,
    () => {
      const quote = selectionQuote(view);
      if (quote !== '') options.onComment(quote);
      cancelTimers();
      hide();
    },
  );
  bar.append(comment);

  const count = document.createElement('span');
  count.className = KERNEL_CLASS.wordCount;

  document.body.append(bar, count);

  let debounceTimer: number | null = null;
  let immediateTimer: number | null = null;
  let composing = false;
  let pointerSelecting = false;

  function cancelTimers(): void {
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (immediateTimer !== null) {
      window.clearTimeout(immediateTimer);
      immediateTimer = null;
    }
  }

  function hide(): void {
    bar.style.display = 'none';
    count.style.display = 'none';
  }

  function updateNow(): void {
    if (composing || pointerSelecting) {
      hide();
      return;
    }
    const measured = measureSelection(view);
    if (measured === null) {
      hide();
      return;
    }
    let editorTop = 0;
    try {
      editorTop = view.dom.getBoundingClientRect().top;
    } catch {
      editorTop = 0;
    }
    const placement = placeToolbar({
      first: measured.first,
      last: measured.last,
      editorTop,
      viewportWidth: window.innerWidth,
    });
    bar.style.display = '';
    bar.style.left = `${placement.left}px`;
    bar.style.top = `${placement.top}px`;
    bar.style.transform = placement.below
      ? 'translate(-50%, 0)'
      : 'translate(-50%, -100%)';

    const countPlacement = placeWordCount(measured.last, window.innerWidth);
    count.style.display = '';
    count.textContent = `${measured.count} 字`;
    count.style.left = `${countPlacement.left}px`;
    count.style.top = `${countPlacement.top}px`;

    for (const [mark, element] of markButtons) {
      const format = markFormatState(editor, mark);
      element.dataset['state'] = format;
      element.setAttribute(
        'aria-pressed',
        format === 'all' ? 'true' : format === 'mixed' ? 'mixed' : 'false',
      );
    }
  }

  function schedule(): void {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      updateNow();
    }, SELECTION_DEBOUNCE_MS);
  }

  function handleSelectionChange(): void {
    if (composing) {
      cancelTimers();
      hide();
      return;
    }
    if (pointerSelecting) return;
    schedule();
  }

  function handleMouseDown(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Node) || !view.dom.contains(target)) return;
    pointerSelecting = true;
    cancelTimers();
    hide();
  }

  function handleMouseUp(): void {
    if (!pointerSelecting) return;
    pointerSelecting = false;
    cancelTimers();
    // The mouse-up selection is final: refresh without the debounce.
    immediateTimer = window.setTimeout(() => {
      immediateTimer = null;
      updateNow();
    }, 0);
  }

  function handleCompositionStart(): void {
    composing = true;
    cancelTimers();
    hide();
  }

  function handleCompositionEnd(): void {
    composing = false;
    // The frozen editor waits for the next selectionchange to re-show the bar.
  }

  document.addEventListener('selectionchange', handleSelectionChange);
  document.addEventListener('mousedown', handleMouseDown, true);
  document.addEventListener('mouseup', handleMouseUp, true);
  view.dom.addEventListener('compositionstart', handleCompositionStart);
  view.dom.addEventListener('compositionend', handleCompositionEnd);

  hide();

  return {
    element: bar,
    update: schedule,
    hide,
    destroy() {
      cancelTimers();
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
      view.dom.removeEventListener('compositionstart', handleCompositionStart);
      view.dom.removeEventListener('compositionend', handleCompositionEnd);
      bar.remove();
      count.remove();
    },
  };
}