/**
 * Floating format toolbar for the AST-native kernel.
 *
 * Parity with the frozen editor: selecting text raises one floating bar above
 * the selection with 文本类型, bold / underline / strike / code / highlight and
 * 添加评论, plus a word count. Buttons carry `data-state` (`all` / `mixed` /
 * `none`) so the frozen stylesheet's pressed and mixed states apply unchanged.
 *
 * The bar is a DOM overlay owned by the kernel: the document body itself is
 * never wrapped or restructured, and every button maps to one ProseMirror mark
 * command.
 *
 **Known parity gap**: the frozen bar draws lucide icons, this bar draws short
 * text labels (`粗` / `U` / `删` / `码` / `高` / `评论`). Icons are a visual
 * decision that belongs to the parity review: the geometry, pressed/mixed states
 * and behavior are identical, swapping the glyphs is a one-line change per
 * button once the reviewer confirms the icon set.
 *
 * @module @alter-dsh/space/document/editors/tiptap/toolbar
 */
import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';

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

/** CSS class names the frozen stylesheet defines. */
const CLASS = {
  floating: 'floating',
  button: 'toolButton',
  divider: 'toolDivider',
  wordCount: 'wordCount',
} as const;

/** Format state of one mark across the current selection. */
export type FormatState = 'none' | 'mixed' | 'all';

/**
 * Glyphs for the toolbar buttons.
 *
 * The frozen bar draws lucide icons at 15px / 1.7–1.8 stroke width inside
 * `.toolButton`; these inline SVGs are the same shapes, so the toolbar keeps
 * the frozen look without depending on a component library inside the kernel
 * (the kernel also runs in tests without React).
 */
const ICON_PATHS: Readonly<Record<ToolbarMark | 'comment', string>> = {
  bold: 'M6 4h6a4 4 0 0 1 0 8H6zM6 12h7a4 4 0 0 1 0 8H6z',
  underline: 'M6 4v8a6 6 0 0 0 12 0V4M4 20h16',
  strike: 'M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16',
  code: 'm16 18 6-6-6-6M8 6l-6 6 6 6',
  highlight: 'm9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4',
  comment:
    'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 8v6M9 11h6',
};

/** One inline SVG icon at the frozen bar's size. */
function icon(name: keyof typeof ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

/** Accessible labels, matching the frozen editor. */
const LABEL: Readonly<Record<ToolbarMark | 'textType' | 'comment' | 'toolbar', string>> = {
  textType: '文本类型',
  bold: '粗体',
  underline: '下划线',
  strike: '删除线',
  code: '行内代码',
  highlight: '高亮',
  comment: '添加评论',
  toolbar: '文本格式',
};

/**
 * Format state of one mark across a selection.
 *
 * ProseMirror reports "every character has it" through
 * `isActive` for a selection range, so a partial selection is `mixed` whenever
 * the mark is active but does not cover the whole range.
 */
export function markFormatState(
  editor: Editor,
  mark: ToolbarMark,
): FormatState {
  const { selection } = editor.state;
  if (selection.empty) return 'none';
  const active = editor.isActive(mark);
  if (!active) return 'none';
  let total = 0;
  let marked = 0;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!node.isText) return true;
    total += 1;
    if (node.marks.some((item) => item.type.name === mark)) marked += 1;
    return false;
  });
  if (total === 0) return 'none';
  return marked === total ? 'all' : 'mixed';
}

/** Count characters in the document the way the frozen footer shows them. */
export function wordCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.isText) count += (node.text ?? '').replaceAll(/\s/gu, '').length;
    return true;
  });
  return count;
}

/** The toolbar overlay for one editor view. */
export interface FormatToolbar {
  element: HTMLElement;
  /** Recompute position/state for the current selection. */
  update(): void;
  destroy(): void;
}

/** Options of {@link createFormatToolbar}. */
export interface FormatToolbarOptions {
  editor: Editor;
  /** Open the comment composer for the current selection. */
  onComment(quote: string): void;
  /** Open the text-type menu (block conversion) for the caret block. */
  onTextType?(anchor: HTMLElement): void;
}

/** Build one toolbar button with the frozen classes and a11y attributes. */
function button(label: string, onDown: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = CLASS.button;
  element.setAttribute('aria-label', label);
  element.title = label;
  // Keep the selection while clicking, like the frozen bar.
  element.addEventListener('mousedown', (event) => event.preventDefault());
  element.addEventListener('click', onDown);
  return element;
}

function divider(): HTMLElement {
  const element = document.createElement('span');
  element.className = CLASS.divider;
  return element;
}

/**
 * Create the floating toolbar for one editor.
 *
 * The element is attached to `document.body` and positioned from the live
 * selection; it is removed on destroy so a kernel swap leaves nothing behind.
 */
export function createFormatToolbar(options: FormatToolbarOptions): FormatToolbar {
  const { editor } = options;
  const view = editor.view;

  const bar = document.createElement('div');
  bar.className = CLASS.floating;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', LABEL.toolbar);
  bar.addEventListener('mousedown', (event) => event.preventDefault());

  const textType = button(LABEL.textType, () =>
    options.onTextType?.(textType),
  );
  textType.textContent = '正文';
  textType.dataset['textType'] = '';

  bar.append(textType, divider());

  const markButtons = new Map<ToolbarMark, HTMLButtonElement>();
  for (const mark of TOOLBAR_MARKS) {
    const element = button(LABEL[mark], () => {
      toggleMark(editor, mark);
      update();
    });
    element.append(icon(mark));
    element.dataset['mark'] = mark;
    bar.append(element);
    markButtons.set(mark, element);
  }

  bar.append(divider());
  const commentButton = button(LABEL.comment, () => {
    const quote = selectedText(editor);
    if (quote !== '') options.onComment(quote);
    hide();
  });
  commentButton.append(icon('comment'));
  bar.append(commentButton);

  const count = document.createElement('span');
  count.className = CLASS.wordCount;

  document.body.append(bar, count);

  function selectedText(current: Editor): string {
    const { selection } = current.state;
    if (selection.empty) return '';
    return current.state.doc
      .textBetween(selection.from, selection.to, '\n')
      .trim();
  }

  function hide(): void {
    bar.style.display = 'none';
    count.style.display = 'none';
  }

  function update(): void {
    const { state } = view;
    if (state.selection.empty) {
      hide();
      return;
    }
    const coords = view.coordsAtPos(state.selection.from);
    const end = view.coordsAtPos(state.selection.to);
    bar.style.display = '';
    bar.style.left = `${Math.round((coords.left + end.right) / 2)}px`;
    bar.style.top = `${Math.round(coords.top - 8)}px`;
    bar.style.transform = 'translate(-50%, -100%)';

    count.style.display = '';
    count.textContent = `${wordCount(editor)} 字`;
    count.style.left = `${Math.round(end.right)}px`;
    count.style.top = `${Math.round(end.bottom + 6)}px`;

    for (const [mark, element] of markButtons) {
      const format = markFormatState(editor, mark);
      element.dataset['state'] = format;
      element.setAttribute(
        'aria-pressed',
        format === 'all' ? 'true' : format === 'mixed' ? 'mixed' : 'false',
      );
    }
    const block = blockOf(state.doc.resolve(state.selection.from));
    textType.textContent = block;
    textType.dataset['textType'] = blockId(state.selection.from, state.doc);
  }

  hide();

  return {
    element: bar,
    update,
    destroy() {
      bar.remove();
      count.remove();
    },
  };
}

/** Toggle one mark through Tiptap, leaving the selection in place. */
function toggleMark(editor: Editor, mark: ToolbarMark): void {
  // Marks are declared by the kernel (not by the stock Tiptap extensions), so
  // the type-level `toggleX` helpers are not registered: drive the generic
  // mark command instead, which works for every manifest mark.
  editor.chain().focus().toggleMark(mark).run();
}

/** Human label of the block that contains `from` (文本类型 button). */
function blockOf($pos: { parent: { type: { name: string } } }): string {
  switch ($pos.parent.type.name) {
    case 'heading':
      return '标题';
    case 'codeBlock':
      return '代码块';
    case 'blockquote':
      return '引用';
    default:
      return '正文';
  }
}

/** Stable `data-block-id` of the top-level block containing `from`. */
function blockId(
  from: number,
  doc: EditorView['state']['doc'],
): string {
  const $from = doc.resolve(from);
  if ($from.depth < 1) return '';
  // `before(1)` is the position just before the top-level block itself.
  const node = doc.nodeAt($from.before(1));
  const id = node?.attrs['id'];
  return typeof id === 'string' ? id : '';
}

