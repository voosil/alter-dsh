// @vitest-environment jsdom
/**
 * Floating format toolbar parity with the frozen editor.
 *
 * The frozen bar is the reference (`docs/acceptance/editor-experience-p0-p6.md` §2): the same
 * buttons in the same order with lucide icons, the 120ms debounce, the
 * top-flip threshold, the selected-character bubble, the IME/mousedown hiding
 * rules and the 文本类型 button that opens the page-owned menu.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import {
  TOOLBAR_MARKS,
  countSelectionCharacters,
  markFormatState,
  placeToolbar,
  placeWordCount,
  type SelectionRect,
} from '../../../../../src/document/editors/tiptap/toolbar';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';
import { KERNEL_CLASS } from '../../../../../src/document/editors/tiptap/classes';

// jsdom has no layout engine; the toolbar measures the selection through
// ProseMirror's `coordsAtPos`, which the individual tests stub.
const zeroRects = () => [] as unknown as DOMRectList;
const zeroRect = () =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }) as DOMRect;
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = zeroRects as never;
}
if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = zeroRects as never;
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = zeroRect as never;
}
if (typeof Element.prototype.getBoundingClientRect !== 'function') {
  Element.prototype.getBoundingClientRect = zeroRect as never;
}
if (typeof document.elementFromPoint !== 'function') {
  // ProseMirror's native mousedown handler asks the document for a hit target.
  document.elementFromPoint = () => null;
}

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function doc(blocks: BlockNode[]): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision: 1, blocks };
}

function textDoc(text = '这是一段正文内容'): AlterDoc {
  return doc([
    block('blk_p', 'paragraph', {}, { content: [{ type: 'text', text }] }),
  ]);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  document
    .querySelectorAll(`.${KERNEL_CLASS.floating}, .${KERNEL_CLASS.wordCount}`)
    .forEach((node) => node.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(
  docValue: AlterDoc,
  extra: Partial<Parameters<typeof createKernelEditor>[0]> = {},
) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc: docValue, ...extra });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/** Set a non-collapsed ProseMirror selection (from/to are document positions). */
function select(kernel: ReturnType<typeof mount>, from: number, to: number): void {
  const view = kernel.editor.view;
  const SelectionCtor = view.state.selection.constructor as unknown as {
    create(doc: unknown, from: number, to: number): unknown;
  };
  view.dispatch(
    view.state.tr.setSelection(SelectionCtor.create(view.state.doc, from, to) as never),
  );
}

/** Collapse the selection without moving through a transaction to another doc. */
function collapse(kernel: ReturnType<typeof mount>, at: number): void {
  const view = kernel.editor.view;
  const SelectionCtor = view.state.selection.constructor as unknown as {
    create(doc: unknown, from: number, to: number): unknown;
  };
  view.dispatch(
    view.state.tr.setSelection(SelectionCtor.create(view.state.doc, at, at) as never),
  );
}

function toolbar(): HTMLElement {
  return document.querySelector<HTMLElement>(`.${KERNEL_CLASS.floating}`)!;
}

function bubble(): HTMLElement {
  return document.querySelector<HTMLElement>(`.${KERNEL_CLASS.wordCount}`)!;
}

function buttonByLabel(label: string): HTMLButtonElement {
  return toolbar().querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  )!;
}

function rect(values: Partial<SelectionRect>): SelectionRect {
  return {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    width: 0,
    height: 0,
    ...values,
  };
}

/** Make the caret measurement deterministic for one selected range. */
function mockCaretGeometry(
  kernel: ReturnType<typeof mount>,
  from: number,
  to: number,
  first: SelectionRect,
  last: SelectionRect,
): void {
  vi.spyOn(kernel.editor.view, 'coordsAtPos').mockImplementation(
    (position: number) =>
      position === from
        ? { left: first.left, right: first.right, top: first.top, bottom: first.bottom }
        : { left: last.left, right: last.right, top: last.top, bottom: last.bottom },
  );
}

/** Advance the 120ms selection debounce. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(120);
}

describe('toolbar structure', () => {
  it('renders the frozen controls: 文本类型 + marks + divider + 添加评论', () => {
    mount(textDoc());
    const bar = toolbar();
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.getAttribute('aria-label')).toBe('文本格式');
    expect(bar.querySelectorAll(`.${KERNEL_CLASS.toolButton}`)).toHaveLength(
      TOOLBAR_MARKS.length + 2,
    );
    expect(bar.querySelectorAll(`.${KERNEL_CLASS.toolDivider}`)).toHaveLength(2);

    const sequence = [...bar.children].map((child) =>
      child.classList.contains(KERNEL_CLASS.toolDivider)
        ? 'divider'
        : child.getAttribute('aria-label'),
    );
    expect(sequence).toEqual([
      '文本类型',
      'divider',
      '粗体',
      '下划线',
      '删除线',
      '行内代码',
      '高亮',
      'divider',
      '添加评论',
    ]);
  });

  it('uses the Type icon, not a text label, for the 文本类型 button', () => {
    mount(textDoc());
    const textType = buttonByLabel('文本类型');
    expect(textType.title).toBe('文本类型');
    expect(textType.textContent).toBe('');
    const svg = textType.querySelector('svg')!;
    expect(svg.getAttribute('class')).toContain('lucide-type');
    expect(svg.getAttribute('width')).toBe('15');
    expect(svg.getAttribute('height')).toBe('15');
    expect(svg.getAttribute('stroke-width')).toBe('1.7');
  });

  it('draws every mark icon at the frozen size and stroke width', () => {
    mount(textDoc());
    const expected: Record<string, number> = {
      bold: 1.8,
      underline: 1.8,
      strike: 1.8,
      code: 1.7,
      highlight: 1.7,
    };
    for (const mark of TOOLBAR_MARKS) {
      const button = toolbar().querySelector<HTMLButtonElement>(
        `[data-mark="${mark}"]`,
      )!;
      const svg = button.querySelector('svg')!;
      expect(svg.getAttribute('width')).toBe('15');
      expect(svg.getAttribute('height')).toBe('15');
      expect(svg.getAttribute('stroke-width')).toBe(String(expected[mark]));
    }
    const comment = buttonByLabel('添加评论');
    expect(comment.querySelector('svg')?.getAttribute('stroke-width')).toBe('1.7');
  });

  it('starts hidden with the bar and the character bubble together', () => {
    mount(textDoc());
    expect(toolbar().style.display).toBe('none');
    expect(bubble().style.display).toBe('none');
  });

  it('is removed when the kernel is destroyed', () => {
    const kernel = mount(textDoc());
    expect(toolbar()).not.toBeNull();
    kernel.destroy();
    expect(document.querySelector(`.${KERNEL_CLASS.floating}`)).toBeNull();
    expect(document.querySelector(`.${KERNEL_CLASS.wordCount}`)).toBeNull();
  });
});

describe('character count semantics', () => {
  it('counts selected characters with every whitespace removed', () => {
    expect(countSelectionCharacters('abc def')).toBe(6);
    expect(countSelectionCharacters('a b\nc')).toBe(3);
    expect(countSelectionCharacters('中文 字')).toBe(3);
    expect(countSelectionCharacters('😀 a')).toBe(2);
    expect(countSelectionCharacters('')).toBe(0);
  });

  it('reports none for every mark of a collapsed selection', () => {
    const kernel = mount(textDoc());
    for (const mark of TOOLBAR_MARKS) {
      expect(markFormatState(kernel.editor, mark)).toBe('none');
    }
  });
});

describe('placement algorithm', () => {
  const first = rect({ left: 400, right: 420, top: 300, bottom: 320, width: 20, height: 20 });
  const last = rect({ left: 500, right: 700, top: 340, bottom: 360, width: 200, height: 20 });

  it('centers above the first rectangle with the 300px clamp', () => {
    expect(
      placeToolbar({ first, last, editorTop: 0, viewportWidth: 1024 }),
    ).toEqual({ left: 410, top: 292, below: false });
  });

  it('flips below when the selection is near the top of the window', () => {
    const nearTop = rect({ left: 400, right: 420, top: 40, bottom: 60, width: 20, height: 20 });
    expect(
      placeToolbar({ first: nearTop, last, editorTop: 0, viewportWidth: 1024 }),
    ).toEqual({ left: 410, top: 368, below: true });
  });

  it('flips below when the selection is near the top of the editor', () => {
    const nearEditorTop = rect({ left: 400, right: 420, top: 60, bottom: 80, width: 20, height: 20 });
    expect(
      placeToolbar({ first: nearEditorTop, last, editorTop: 20, viewportWidth: 1024 }).below,
    ).toBe(true);
  });

  it('clamps horizontally inside the viewport', () => {
    const farLeft = rect({ left: 0, right: 0, top: 300, bottom: 320, width: 0, height: 20 });
    const farRight = rect({ left: 1000, right: 1000, top: 300, bottom: 320, width: 0, height: 20 });
    expect(placeToolbar({ first: farLeft, last, editorTop: 0, viewportWidth: 1024 }).left).toBe(160);
    expect(placeToolbar({ first: farRight, last, editorTop: 0, viewportWidth: 1024 }).left).toBe(864);
  });

  it('places the bubble at the last rectangle bottom-right, clamped', () => {
    expect(placeWordCount(last, 1024)).toEqual({ left: 708, top: 364 });
    expect(placeWordCount(rect({ right: 1000, bottom: 360 }), 1024)).toEqual({
      left: 978,
      top: 364,
    });
  });
});

describe('toolbar in the editor', () => {
  it('shows after the 120ms debounce with selected-only content and count', async () => {
    vi.useFakeTimers();
    const kernel = mount(textDoc());
    vi.spyOn(kernel.editor.view, 'coordsAtPos').mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    select(kernel, 1, 5);

    expect(toolbar().style.display).toBe('none');
    await vi.advanceTimersByTimeAsync(119);
    expect(toolbar().style.display).toBe('none');
    await vi.advanceTimersByTimeAsync(1);
    expect(toolbar().style.display).toBe('');
    expect(bubble().style.display).toBe('');
    // 这是一段 -> four characters, independent of the rest of the body.
    expect(bubble().textContent).toBe('4 字');
  });

  it('positions the bar above the selection and the bubble at its bottom-right', async () => {
    vi.useFakeTimers();
    const kernel = mount(textDoc());
    mockCaretGeometry(
      kernel,
      1,
      5,
      rect({ left: 400, right: 420, top: 200, bottom: 220, width: 20, height: 20 }),
      rect({ left: 500, right: 620, top: 240, bottom: 260, width: 120, height: 20 }),
    );
    select(kernel, 1, 5);
    await settle();
    expect(toolbar().style.left).toBe('410px');
    expect(toolbar().style.top).toBe('192px');
    expect(toolbar().style.transform).toBe('translate(-50%, -100%)');
    expect(bubble().style.left).toBe('628px');
    expect(bubble().style.top).toBe('264px');
  });

  it('shows below the selection when it sits near the viewport top', async () => {
    vi.useFakeTimers();
    const kernel = mount(textDoc());
    mockCaretGeometry(
      kernel,
      1,
      5,
      rect({ left: 400, right: 420, top: 40, bottom: 60, width: 20, height: 20 }),
      rect({ left: 500, right: 620, top: 100, bottom: 120, width: 120, height: 20 }),
    );
    select(kernel, 1, 5);
    await settle();
    expect(toolbar().style.top).toBe('128px');
    expect(toolbar().style.transform).toBe('translate(-50%)');
    expect(bubble().style.top).toBe('124px');
  });

  it('hides when the selection collapses', async () => {
    vi.useFakeTimers();
    const kernel = mount(textDoc());
    vi.spyOn(kernel.editor.view, 'coordsAtPos').mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    select(kernel, 1, 5);
    await settle();
    expect(toolbar().style.display).toBe('');
    collapse(kernel, 1);
    await settle();
    expect(toolbar().style.display).toBe('none');
    expect(bubble().style.display).toBe('none');
  });

  it('hides immediately on mousedown inside the editor', async () => {
    vi.useFakeTimers();
    const kernel = mount(textDoc());
    vi.spyOn(kernel.editor.view, 'coordsAtPos').mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    select(kernel, 1, 5);
    await settle();
    expect(toolbar().style.display).toBe('');
    kernel.editor.view.dom.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    expect(toolbar().style.display).toBe('none');
    expect(bubble().style.display).toBe('none');
  });

  it('stays hidden during an IME composition and returns on the next selection', async () => {
    vi.useFakeTimers();
    const kernel = mount(textDoc());
    vi.spyOn(kernel.editor.view, 'coordsAtPos').mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    select(kernel, 1, 5);
    await settle();
    expect(toolbar().style.display).toBe('');
    const dom = kernel.editor.view.dom;
    dom.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(toolbar().style.display).toBe('none');
    dom.dispatchEvent(new Event('compositionend', { bubbles: true }));
    await settle();
    expect(toolbar().style.display).toBe('none');

    select(kernel, 1, 3);
    await settle();
    expect(toolbar().style.display).toBe('');
  });
});

describe('button behavior', () => {
  it('anchors the page-owned text-type menu at the 文本类型 button', async () => {
    vi.useFakeTimers();
    const onTextType = vi.fn();
    const kernel = mount(textDoc(), { onTextType });
    vi.spyOn(kernel.editor.view, 'coordsAtPos').mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    select(kernel, 1, 5);
    await settle();
    const textType = buttonByLabel('文本类型');
    textType.click();
    expect(onTextType).toHaveBeenCalledWith(textType);
  });

  it('toggles a mark and reflects all/mixed state in data-state and aria-pressed', async () => {
    vi.useFakeTimers();
    const kernel = mount(
      doc([
        block('blk_p', 'paragraph', {}, {
          content: [
            { type: 'text', text: '加粗', marks: [{ type: 'bold' }] },
            { type: 'text', text: '普通' },
          ],
        }),
      ]),
    );
    vi.spyOn(kernel.editor.view, 'coordsAtPos').mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    // Whole line: bold on half of it -> mixed.
    select(kernel, 1, 5);
    await settle();
    const bold = buttonByLabel('粗体');
    expect(bold.dataset['state']).toBe('mixed');
    expect(bold.getAttribute('aria-pressed')).toBe('mixed');

    // Only the bold half: all.
    select(kernel, 1, 3);
    await settle();
    expect(bold.dataset['state']).toBe('all');
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    const underline = buttonByLabel('下划线');
    expect(underline.dataset['state']).toBe('none');
    expect(underline.getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles a mark through its button', async () => {
    vi.useFakeTimers();
    const kernel = mount(textDoc());
    vi.spyOn(kernel.editor.view, 'coordsAtPos').mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    select(kernel, 1, 5);
    await settle();
    buttonByLabel('粗体').click();
    expect(buttonByLabel('粗体').dataset['state']).toBe('all');
    const blocks = pmDocToBlocks(kernel.capture()).value;
    const content = blocks[0]?.content ?? [];
    expect(
      content.some(
        (node) =>
          node.type === 'text' &&
          node.marks?.some((mark) => mark.type === 'bold'),
      ),
    ).toBe(true);
  });

  it('asks the page to start a comment with the selected text', async () => {
    vi.useFakeTimers();
    const onComment = vi.fn();
    const kernel = mount(textDoc(), { onComment });
    vi.spyOn(kernel.editor.view, 'coordsAtPos').mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    select(kernel, 1, 5);
    await settle();
    buttonByLabel('添加评论').click();
    expect(onComment).toHaveBeenCalledWith('这是一段');
    expect(toolbar().style.display).toBe('none');
  });
});