// @vitest-environment jsdom
/**
 * Keyboard, input-rule and IME parity with the frozen editor.
 *
 * The frozen editor implements markdown-style line conversions, list/quote
 * boundary semantics, table Tab, code-block Enter and the IME lifecycle by
 * hand. The new kernel must keep every user-visible gesture: the confirming
 * Space/Enter is swallowed for marker lines, conversions are one undo step,
 * and a composition never commits half-composed text.
 *
 * Assertions use AST blocks and semantic DOM (tags/roles), never frozen CSS
 * class names: the stylesheet is the legacy UI's and must stay untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  createKernelEditor,
  type CreateKernelEditorOptions,
} from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import { readSlashState } from '../../../../../src/document/editors/tiptap/slash';
import { isComposingView } from '../../../../../src/document/editors/tiptap/keyboard';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

// jsdom has no layout engine: the overlays/toolbar patch measure geometry.
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
Element.prototype.getBoundingClientRect = zeroRect as never;
const zeroRects = () => [] as unknown as DOMRectList;
Range.prototype.getClientRects = zeroRects as never;
Element.prototype.getClientRects = zeroRects as never;
Range.prototype.getBoundingClientRect = zeroRect as never;

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

function textBlock(
  id: string,
  type: string,
  text: string,
  attrs: BlockNode['attrs'] = {},
): BlockNode {
  return block(id, type, attrs, {
    content: text === '' ? undefined : [{ type: 'text', text }],
  });
}

function paragraph(id: string, text = ''): BlockNode {
  return textBlock(id, 'paragraph', text);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});

function mount(
  docValue: AlterDoc,
  options: Partial<CreateKernelEditorOptions> = {},
) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc: docValue, ...options });
  if (!document.body.contains(element)) document.body.append(element);
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/** Absolute position at the end of the deepest textblock inside `node`. */
function endPositionOf(node: PmNode, nodePos: number): number {
  if (node.isTextblock) return nodePos + 1 + node.content.size;
  if (node.isLeaf || node.childCount === 0) return nodePos + 1;
  const last = node.child(node.childCount - 1);
  return endPositionOf(last, nodePos + 1 + (node.content.size - last.nodeSize));
}

/** Start/end of one top-level child of the document. */
function childRange(
  docNode: PmNode,
  index: number,
): { start: number; end: number; node: PmNode } {
  let start = 0;
  for (let step = 0; step < docNode.childCount; step += 1) {
    const child = docNode.child(step);
    if (step === index) {
      return { start, end: start + child.nodeSize, node: child };
    }
    start += child.nodeSize;
  }
  throw new Error(`no child at ${index}`);
}

/** Put the caret at the end of the `index`-th top-level block. */
function caretAtBlockEnd(
  kernel: ReturnType<typeof mount>,
  index = 0,
  offset = 0,
): void {
  const view = kernel.editor.view;
  const docNode = view.state.doc;
  const range = childRange(docNode, index);
  const position = endPositionOf(range.node, range.start) + offset;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, position),
    ),
  );
}

/** Put the caret at an absolute document position. */
function caretAt(kernel: ReturnType<typeof mount>, position: number): void {
  const view = kernel.editor.view;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, position),
    ),
  );
}

/** Position of the caret inside the first block's paragraph text. */
function caretInFirstParagraph(
  kernel: ReturnType<typeof mount>,
  offset = 0,
): void {
  caretAt(kernel, 1 + offset);
}

/** Run one keyboard event through the editor's binding chain. */
function pressKey(
  kernel: ReturnType<typeof mount>,
  init: KeyboardEventInit,
): boolean {
  const view = kernel.editor.view;
  return (
    view.someProp('handleKeyDown', (handler) =>
      handler(view, new KeyboardEvent('keydown', init) as never),
    ) === true
  );
}

/** Type text through ProseMirror's text-input chain (input rules). */
function typeText(
  kernel: ReturnType<typeof mount>,
  text: string,
  from?: number,
): boolean {
  const view = kernel.editor.view;
  const position = from ?? view.state.selection.from;
  return (
    view.someProp('handleTextInput', (handler) =>
      handler(view, position, position, text),
    ) === true
  );
}

function blocks(kernel: ReturnType<typeof mount>): BlockNode[] {
  return pmDocToBlocks(kernel.capture()).value;
}

function firstBlock(kernel: ReturnType<typeof mount>): BlockNode {
  const captured = blocks(kernel);
  expect(captured.length).toBeGreaterThan(0);
  return captured[0]!;
}

function selectedParent(kernel: ReturnType<typeof mount>) {
  return kernel.editor.state.selection.$from.parent;
}

// ---------------------------------------------------------------------------
// Inline mark shortcuts
// ---------------------------------------------------------------------------

describe('inline mark shortcuts', () => {
  it('Mod-U toggles underline (the frozen editor implements it by hand)', () => {
    const kernel = mount(doc([paragraph('p', '下划线文字')]));
    const view = kernel.editor.view;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)),
    );
    const handled = pressKey(kernel, { key: 'u', ctrlKey: true });
    expect(handled).toBe(true);
    const content = firstBlock(kernel).content ?? [];
    expect(
      content.some(
        (node) =>
          node.type === 'text' &&
          node.marks?.some((mark) => mark.type === 'underline'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Line conversion rules
// ---------------------------------------------------------------------------

describe('line conversion rules', () => {
  it.each([
    ['#', { type: 'heading', attrs: { level: 1 } }],
    ['##', { type: 'heading', attrs: { level: 2 } }],
    ['###', { type: 'heading', attrs: { level: 3 } }],
    ['-', { type: 'bulletList' }],
    ['*', { type: 'bulletList' }],
    ['>', { type: 'blockquote' }],
    ['》', { type: 'blockquote' }],
  ])('turns a whole `%s` line into the expected block on Space', (marker, expected) => {
    const kernel = mount(doc([paragraph('p', marker)]));
    caretAtBlockEnd(kernel);
    const handled = pressKey(kernel, { key: ' ' });
    expect(handled).toBe(true);
    const converted = firstBlock(kernel);
    expect(converted.type).toBe(expected.type);
    if ('level' in expected && 'attrs' in expected) {
      expect(converted.attrs['level']).toBe(expected.attrs!.level);
    }
    // The caret lands in the new block's only textblock.
    expect(selectedParent(kernel).isTextblock).toBe(true);
    expect(kernel.editor.state.selection.$from.parentOffset).toBe(0);
  });

  it.each([
    ['[]', false],
    ['[ ]', false],
  ])('turns a `%s` line into one task row on Space', (marker, checked) => {
    const kernel = mount(doc([paragraph('p', marker)]));
    caretAtBlockEnd(kernel);
    expect(pressKey(kernel, { key: ' ' })).toBe(true);
    const list = firstBlock(kernel);
    expect(list.type).toBe('taskList');
    expect(list.children?.[0]?.type).toBe('listItem');
    expect(list.children?.[0]?.attrs['checked']).toBe(checked);
  });

  it('keeps the typed number for `3.` and restarts at one for `1.`', () => {
    const three = mount(doc([paragraph('p', '3.')]));
    caretAtBlockEnd(three);
    expect(pressKey(three, { key: ' ' })).toBe(true);
    const ordered = firstBlock(three);
    expect(ordered.type).toBe('orderedList');
    expect(ordered.attrs['start']).toBe(3);

    const one = mount(doc([paragraph('p', '1.')]));
    caretAtBlockEnd(one);
    expect(pressKey(one, { key: ' ' })).toBe(true);
    expect(firstBlock(one).type).toBe('orderedList');
  });

  it('swallows the confirming Space even when the caret is not at the line end', () => {
    const kernel = mount(doc([paragraph('p', '#')]));
    caretInFirstParagraph(kernel, 0);
    expect(pressKey(kernel, { key: ' ' })).toBe(true);
    const unchanged = firstBlock(kernel);
    expect(unchanged.type).toBe('paragraph');
    expect(unchanged.content?.[0]?.text).toBe('#');
  });

  it('leaves a partial marker to the default input path', () => {
    const kernel = mount(doc([paragraph('p', '#标题')]));
    caretAtBlockEnd(kernel);
    expect(pressKey(kernel, { key: ' ' })).toBe(false);
    expect(firstBlock(kernel).type).toBe('paragraph');
  });

  it('converts ``` on Space and Enter into an empty code block', () => {
    for (const key of [' ', 'Enter']) {
      const kernel = mount(doc([paragraph('p', '```')]));
      caretAtBlockEnd(kernel);
      expect(pressKey(kernel, { key })).toBe(true);
      expect(firstBlock(kernel).type).toBe('codeBlock');
      expect(selectedParent(kernel).type.name).toBe('codeBlock');
    }
  });

  it('converts a typed third dash into a divider without pressing Enter', () => {
    const kernel = mount(doc([paragraph('p', '--')]));
    caretAtBlockEnd(kernel);
    expect(typeText(kernel, '-')).toBe(true);
    const captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual(['divider', 'paragraph']);
    // The caret is in the trailing paragraph so typing can continue.
    expect(selectedParent(kernel).type.name).toBe('paragraph');
  });

  it('keeps `---` as text inside a code block (frontmatter-style content)', () => {
    const kernel = mount(
      doc([textBlock('code', 'codeBlock', '--', { lang: null })]),
    );
    caretAtBlockEnd(kernel);
    expect(typeText(kernel, '-')).toBe(false);
    expect(firstBlock(kernel).type).toBe('codeBlock');
  });

  it('converts `---` inside a quote line immediately (quote is a frozen host)', () => {
    const kernel = mount(
      doc([
        block('quote', 'blockquote', {}, {
          children: [paragraph('p', '--')],
        }),
      ]),
    );
    caretAtBlockEnd(kernel, 0);
    expect(typeText(kernel, '-')).toBe(true);
    expect(blocks(kernel).map((item) => item.type)).toEqual([
      'divider',
      'paragraph',
    ]);
  });

  it('leaves marker-shaped text in a list item to ordinary typing', () => {
    const kernel = mount(
      doc([
        block('list', 'bulletList', {}, {
          children: [
            block('item', 'listItem', {}, {
              children: [paragraph('p', '#')],
            }),
          ],
        }),
      ]),
    );
    caretAtBlockEnd(kernel, 0);
    // Not a frozen line host: Space must insert normally, never be swallowed.
    expect(pressKey(kernel, { key: ' ' })).toBe(false);
    expect(firstBlock(kernel).type).toBe('bulletList');
  });

  it('does not convert typed markers inside a list item (frozen host set)', () => {
    const kernel = mount(
      doc([
        block('list', 'bulletList', {}, {
          children: [
            block('item', 'listItem', {}, {
              children: [paragraph('p', '--')],
            }),
          ],
        }),
      ]),
    );
    caretAtBlockEnd(kernel, 0);
    expect(typeText(kernel, '-')).toBe(false);
    expect(firstBlock(kernel).type).toBe('bulletList');
  });

  it('converts a `---` line on Enter even when the caret is not at the end', () => {
    const kernel = mount(doc([paragraph('p', '---')]));
    caretInFirstParagraph(kernel, 0);
    expect(pressKey(kernel, { key: 'Enter' })).toBe(true);
    expect(blocks(kernel).map((item) => item.type)).toEqual([
      'divider',
      'paragraph',
    ]);
  });

  it('undoes and redoes one typed run without touching the block ids', () => {
    const kernel = mount(doc([paragraph('p', '起点')]));
    const view = kernel.editor.view;
    view.dispatch(view.state.tr.insertText('编辑后', 1));
    expect(blocks(kernel).map((item) => item.type)).toEqual(['paragraph']);
    kernel.editor.commands.undo();
    expect(kernel.editor.state.doc.textContent).toBe('起点');
    kernel.editor.commands.redo();
    expect(kernel.editor.state.doc.textContent).toBe('编辑后起点');
    // The block id survives undoing/redoing a text edit.
    for (const captured of blocks(kernel)) {
      expect(captured.id).toBe('p');
    }
  });

  it('keeps the conversion as one undo step', () => {
    const kernel = mount(doc([paragraph('p', '#')]));
    caretAtBlockEnd(kernel);
    expect(pressKey(kernel, { key: ' ' })).toBe(true);
    expect(firstBlock(kernel).type).toBe('heading');
    kernel.editor.commands.undo();
    const restored = firstBlock(kernel);
    expect(restored.type).toBe('paragraph');
    expect(restored.content?.[0]?.text).toBe('#');
  });
});

// ---------------------------------------------------------------------------
// Line boundaries
// ---------------------------------------------------------------------------

describe('line boundaries', () => {
  it('deletes an empty middle list item into a paragraph and splits the list', () => {
    const kernel = mount(
      doc([
        block('list', 'bulletList', {}, {
          children: [
            block('i1', 'listItem', {}, {
              children: [paragraph('p1', '一')],
            }),
            block('i2', 'listItem', {}, {
              children: [paragraph('p2')],
            }),
            block('i3', 'listItem', {}, {
              children: [paragraph('p3', '三')],
            }),
          ],
        }),
      ]),
    );
    // Caret in the empty item's paragraph.
    const view = kernel.editor.view;
    const listStart = childRange(view.state.doc, 0).start;
    const firstItem = view.state.doc.child(0).child(0);
    const secondItemStart = listStart + 1 + firstItem.nodeSize;
    caretAt(kernel, secondItemStart + 2); // item > paragraph > content start

    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    const captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual([
      'bulletList',
      'paragraph',
      'bulletList',
    ]);
    expect(captured[0]?.children?.map((item) => item.type)).toEqual([
      'listItem',
    ]);
    expect(captured[0]?.children?.[0]?.children?.[0]?.content?.[0]?.text).toBe(
      '一',
    );
    expect(captured[1]?.content).toBeUndefined();
    expect(captured[2]?.children?.[0]?.children?.[0]?.content?.[0]?.text).toBe(
      '三',
    );
    // Caret sits at the start of the new empty paragraph.
    const parent = selectedParent(kernel);
    expect(parent.type.name).toBe('paragraph');
    expect(parent.content.size).toBe(0);
  });

  it('keeps ordered numbering after splitting an empty middle item', () => {
    const kernel = mount(
      doc([
        block('list', 'orderedList', { start: 1 }, {
          children: [
            block('i1', 'listItem', {}, {
              children: [paragraph('p1', '一')],
            }),
            block('i2', 'listItem', {}, {
              children: [paragraph('p2')],
            }),
            block('i3', 'listItem', {}, {
              children: [paragraph('p3', '三')],
            }),
          ],
        }),
      ]),
    );
    const view = kernel.editor.view;
    const listStart = childRange(view.state.doc, 0).start;
    const firstItem = view.state.doc.child(0).child(0);
    const secondItemStart = listStart + 1 + firstItem.nodeSize;
    caretAt(kernel, secondItemStart + 2); // item > paragraph > content start
    expect(pressKey(kernel, { key: 'Delete' })).toBe(true);
    const captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual([
      'orderedList',
      'paragraph',
      'orderedList',
    ]);
    expect(captured[2]?.attrs['start']).toBe(3);
  });

  it('drops only the quote marker on Backspace at the quote line start', () => {
    const kernel = mount(
      doc([
        block('quote', 'blockquote', {}, {
          children: [paragraph('p', '引用内容')],
        }),
      ]),
    );
    caretAt(kernel, 2); // paragraph content start inside the quote
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    const captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual(['paragraph']);
    expect(captured[0]?.content?.[0]?.text).toBe('引用内容');
    expect(selectedParent(kernel).type.name).toBe('paragraph');
  });

  it('keeps the single empty paragraph on Backspace', () => {
    const kernel = mount(doc([paragraph('p')]));
    caretAt(kernel, 1);
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    const captured = blocks(kernel);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe('paragraph');
    expect(captured[0]?.content).toBeUndefined();
    expect(kernel.editor.state.selection.from).toBe(1);
  });

  it('jumps between table cells with Tab and never wraps or adds rows', () => {
    const kernel = mount(
      doc([
        block('tbl', 'table', { headerRows: 1 }, {
          children: [
            block('r1', 'tableRow', {}, {
              children: [
                block('c11', 'tableCell', {}, {
                  content: [{ type: 'text', text: 'A' }],
                }),
                block('c12', 'tableCell', {}, {
                  content: [{ type: 'text', text: 'B' }],
                }),
              ],
            }),
            block('r2', 'tableRow', {}, {
              children: [
                block('c21', 'tableCell', {}, {
                  content: [{ type: 'text', text: 'C' }],
                }),
                block('c22', 'tableCell', {}, {
                  content: [{ type: 'text', text: 'D' }],
                }),
              ],
            }),
          ],
        }),
      ]),
    );
    // Caret in the first cell's paragraph: table > row > cell > paragraph > text.
    caretAt(kernel, 4);
    expect(pressKey(kernel, { key: 'Tab' })).toBe(true);
    expect(selectedParent(kernel).textContent).toBe('B');

    // Move to the last cell, then Tab must not create a row or wrap.
    const view = kernel.editor.view;
    const tableStart = childRange(view.state.doc, 0).start;
    const table = view.state.doc.child(0);
    const lastRow = table.child(table.childCount - 1);
    const rowBefore = table.child(table.childCount - 2);
    const lastRowStart = tableStart + 1 + rowBefore.nodeSize;
    const lastCell = lastRow.child(lastRow.childCount - 1);
    const lastCellStart = lastRowStart + 1 + lastRow.child(lastRow.childCount - 2).nodeSize;
    caretAt(kernel, endPositionOf(lastCell, lastCellStart));
    const before = view.state.selection.from;
    expect(pressKey(kernel, { key: 'Tab' })).toBe(false);
    expect(view.state.selection.from).toBe(before);
    expect(blocks(kernel)[0]?.type).toBe('table');
  });

  it('inserts a literal newline on Enter in a code block and never exits', () => {
    const kernel = mount(
      doc([textBlock('code', 'codeBlock', 'ab', { lang: null })]),
    );
    caretAtBlockEnd(kernel);
    expect(pressKey(kernel, { key: 'Enter' })).toBe(true);
    const code = firstBlock(kernel);
    expect(code.type).toBe('codeBlock');
    expect(code.content?.[0]?.text).toBe('ab\n');
    expect(selectedParent(kernel).type.name).toBe('codeBlock');

    const empty = mount(doc([textBlock('code', 'codeBlock', '', { lang: null })]));
    caretAtBlockEnd(empty);
    expect(pressKey(empty, { key: 'Enter' })).toBe(true);
    expect(blocks(empty)[0]?.type).toBe('codeBlock');
  });
});

// ---------------------------------------------------------------------------
// Two-step list / todo deletion (product 2026-11-12)
// ---------------------------------------------------------------------------

/** One AST todo row inside a task list. */
function todoItem(id: string, value: string, checked = false): BlockNode {
  return block(id, 'listItem', { checked }, {
    children: [paragraph(`${id}_p`, value)],
  });
}

/** Caret in the first paragraph of the `itemIndex`-th item of one top-level list. */
function caretInListItem(
  kernel: ReturnType<typeof mount>,
  listIndex: number,
  itemIndex: number,
): void {
  const view = kernel.editor.view;
  const listRange = childRange(view.state.doc, listIndex);
  let itemStart = listRange.start + 1;
  for (let index = 0; index < itemIndex; index += 1) {
    itemStart += listRange.node.child(index).nodeSize;
  }
  // Item open token + paragraph open token.
  caretAt(kernel, itemStart + 2);
}

describe('two-step list deletion', () => {
  it('jumps to the previous line on the second Backspace instead of merging', () => {
    const kernel = mount(
      doc([
        paragraph('lead', '前文'),
        block('list', 'bulletList', {}, {
          children: [
            block('i1', 'listItem', {}, {
              children: [paragraph('p1', '一')],
            }),
            block('i2', 'listItem', {}, {
              children: [paragraph('p2')],
            }),
            block('i3', 'listItem', {}, {
              children: [paragraph('p3', '三')],
            }),
          ],
        }),
      ]),
    );
    caretInListItem(kernel, 1, 1);
    // First Backspace: the empty item degrades to a paragraph in place.
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    expect(blocks(kernel).map((item) => item.type)).toEqual([
      'paragraph',
      'bulletList',
      'paragraph',
      'bulletList',
    ]);
    const afterFirst = kernel.editor.state.selection.$from;
    expect(afterFirst.parent.type.name).toBe('paragraph');
    expect(afterFirst.parent.content.size).toBe(0);

    // Second Backspace: the blank line goes away, the split halves rejoin and
    // the caret lands at the previous list line's end (no re-created row).
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    const captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual([
      'paragraph',
      'bulletList',
    ]);
    expect(captured[1]?.children).toHaveLength(2);
    const $from = kernel.editor.state.selection.$from;
    expect($from.parent.textContent).toBe('一');
    expect($from.parentOffset).toBe(1);
  });

  it('does not recreate an ordered-list number on the second Backspace', () => {
    const kernel = mount(
      doc([
        block('list', 'orderedList', { start: 1 }, {
          children: [
            block('i1', 'listItem', {}, {
              children: [paragraph('p1', '一')],
            }),
            block('i2', 'listItem', {}, {
              children: [paragraph('p2')],
            }),
          ],
        }),
      ]),
    );
    caretInListItem(kernel, 0, 1);
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    expect(blocks(kernel).map((item) => item.type)).toEqual([
      'orderedList',
      'paragraph',
    ]);
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    const captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual(['orderedList']);
    expect(captured[0]?.children).toHaveLength(1);
    expect(captured[0]?.attrs?.['start']).toBe(1);
    const $from = kernel.editor.state.selection.$from;
    expect($from.parent.textContent).toBe('一');
    expect($from.parentOffset).toBe(1);
  });

  it('merges into a previous normal paragraph when the list had no preceding rows', () => {
    const kernel = mount(
      doc([
        paragraph('lead', '前文'),
        block('list', 'bulletList', {}, {
          children: [
            block('i1', 'listItem', {}, {
              children: [paragraph('p1')],
            }),
            block('i2', 'listItem', {}, {
              children: [paragraph('p2', '后')],
            }),
          ],
        }),
      ]),
    );
    caretInListItem(kernel, 1, 0);
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    expect(blocks(kernel).map((item) => item.type)).toEqual([
      'paragraph',
      'paragraph',
      'bulletList',
    ]);
    // The previous line is a normal paragraph: default merge, caret at its end.
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    const captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual([
      'paragraph',
      'bulletList',
    ]);
    expect(captured[0]?.content?.[0]?.text).toBe('前文');
    expect(kernel.editor.state.selection.from).toBe('前文'.length + 1);
  });
});

describe('two-step todo deletion', () => {
  it('removes only the checkbox first, then jumps to the previous line', () => {
    const kernel = mount(
      doc([
        block('tasks', 'taskList', {}, {
          children: [
            todoItem('r1', '一'),
            todoItem('r2', ''),
            todoItem('r3', '三'),
          ],
        }),
      ]),
    );
    caretInListItem(kernel, 0, 1);
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    let captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual([
      'taskList',
      'paragraph',
      'taskList',
    ]);
    // The retired line keeps the row's block id (comment anchors survive).
    expect(captured[1]?.id).toBe('r2');
    const afterFirst = kernel.editor.state.selection.$from;
    expect(afterFirst.parent.type.name).toBe('paragraph');
    expect(afterFirst.parent.content.size).toBe(0);
    expect(afterFirst.parentOffset).toBe(0);

    // Second Backspace drops the checkbox row's paragraph line entirely: the
    // two task halves rejoin and the caret returns to the line above.
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual(['taskList']);
    expect(captured[0]?.children).toHaveLength(2);
    expect(captured[0]?.children?.[0]?.id).toBe('r1');
    expect(captured[0]?.children?.[1]?.id).toBe('r3');
    const $from = kernel.editor.state.selection.$from;
    expect($from.parent.textContent).toBe('一');
    expect($from.parentOffset).toBe(1);
  });

  it('collapses a single-row todo into one paragraph and keeps the caret', () => {
    const kernel = mount(
      doc([
        block('tasks', 'taskList', {}, {
          children: [todoItem('r1', '')],
        }),
      ]),
    );
    caretInListItem(kernel, 0, 0);
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    let captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual(['paragraph']);
    expect(captured[0]?.id).toBe('r1');
    expect(kernel.editor.state.selection.from).toBe(1);

    // A single empty paragraph keeps the frozen "Backspace does nothing" rule.
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    captured = blocks(kernel);
    expect(captured.map((item) => item.type)).toEqual(['paragraph']);
    expect(kernel.editor.state.selection.from).toBe(1);
  });

  it('stays put when an emptied first todo row has no previous line', () => {
    const kernel = mount(
      doc([
        block('tasks', 'taskList', {}, {
          children: [todoItem('r1', ''), todoItem('r2', '二')],
        }),
      ]),
    );
    caretInListItem(kernel, 0, 0);
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    expect(blocks(kernel).map((item) => item.type)).toEqual([
      'paragraph',
      'taskList',
    ]);
    const before = kernel.editor.state.selection.from;
    expect(before).toBe(1);
    // No previous line: the key falls through to the browser default no-op.
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(false);
    expect(kernel.editor.state.selection.from).toBe(before);
    expect(blocks(kernel).map((item) => item.type)).toEqual([
      'paragraph',
      'taskList',
    ]);
  });

  it('leaves a todo row that still has text to the default merge', () => {
    const kernel = mount(
      doc([
        block('tasks', 'taskList', {}, {
          children: [todoItem('r1', '一'), todoItem('r2', '文字')],
        }),
      ]),
    );
    caretInListItem(kernel, 0, 1);
    const before = JSON.stringify(blocks(kernel));
    // The custom row retirement must not touch a row with text: no paragraph
    // block appears, and the row's text stays in the document.
    expect(blocks(kernel).some((item) => item.type === 'paragraph')).toBe(
      false,
    );
    pressKey(kernel, { key: 'Backspace' });
    expect(blocks(kernel).some((item) => item.type === 'paragraph')).toBe(
      false,
    );
    expect(JSON.stringify(blocks(kernel))).toContain('文字');
    expect(before).toContain('文字');
  });
});

// ---------------------------------------------------------------------------
// IME lifecycle
// ---------------------------------------------------------------------------

/** Dispatch one composition event on the editable region. */
function composition(
  kernel: ReturnType<typeof mount>,
  type: 'compositionstart' | 'compositionend',
): void {
  kernel.editor.view.dom.dispatchEvent(new Event(type, { bubbles: true }));
}

/** Flush the microtasks the composition-end conversion is scheduled on. */
async function flushComposition(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('IME lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('closes the slash menu on composition start and does not save half-composed text', async () => {
    const onUpdate = vi.fn();
    const kernel = mount(doc([paragraph('p')]), { onUpdate });
    const view = kernel.editor.view;
    caretInFirstParagraph(kernel, 0);
    // The slash menu opens from the real key path (menus module owns it).
    expect(pressKey(kernel, { key: '/' })).toBe(true);
    expect(readSlashState(view)).not.toBeNull();

    const savesBeforeComposition = onUpdate.mock.calls.length;
    composition(kernel, 'compositionstart');
    expect(isComposingView(view)).toBe(true);
    expect(readSlashState(view)).toBeNull();

    // The browser inserts the half-composed run; the save layer must stay calm.
    view.dispatch(view.state.tr.insertText('组合中', 2, 2));
    expect(onUpdate.mock.calls.length).toBe(savesBeforeComposition);

    composition(kernel, 'compositionend');
    await flushComposition();
    expect(onUpdate.mock.calls.length).toBe(savesBeforeComposition + 1);
    expect(firstBlock(kernel).content?.[0]?.text).toContain('组合中');
  });

  it('finishes a bare `>` marker committed by the IME', async () => {
    const onUpdate = vi.fn();
    const kernel = mount(doc([paragraph('p', '》')]), { onUpdate });
    caretAtBlockEnd(kernel);
    composition(kernel, 'compositionstart');
    composition(kernel, 'compositionend');
    await flushComposition();
    expect(firstBlock(kernel).type).toBe('blockquote');
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('finishes an `N. ` ordered marker committed by the IME with its number', async () => {
    const onUpdate = vi.fn();
    const kernel = mount(doc([paragraph('p', '3. ')]), { onUpdate });
    caretAtBlockEnd(kernel);
    composition(kernel, 'compositionstart');
    composition(kernel, 'compositionend');
    await flushComposition();
    const ordered = firstBlock(kernel);
    expect(ordered.type).toBe('orderedList');
    expect(ordered.attrs['start']).toBe(3);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('finishes a typed `---` divider on composition end', async () => {
    const onUpdate = vi.fn();
    const kernel = mount(doc([paragraph('p', '---')]), { onUpdate });
    caretAtBlockEnd(kernel);
    composition(kernel, 'compositionstart');
    composition(kernel, 'compositionend');
    await flushComposition();
    expect(blocks(kernel).map((item) => item.type)).toEqual([
      'divider',
      'paragraph',
    ]);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});