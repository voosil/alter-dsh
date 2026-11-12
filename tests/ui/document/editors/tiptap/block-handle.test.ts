// @vitest-environment jsdom
/**
 * Block handle parity gate (Notion-style block affordance).
 *
 * Frozen behaviour under test: hovering a top-level block shows one handle in
 * the left gutter; clicking it selects the whole block (TextSelection for text,
 * NodeSelection for atoms/tables) and marks the DOM with `data-block-selected`
 * (editing state only); dragging it reorders top-level blocks with a drop
 * indicator on the target edge, keeps the moved node's id, ignores self drops,
 * cancels with Escape / leaving the body and saves through the kernel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { createBlockHandle, type BlockHandleOptions } from '../../../../../src/document/editors/tiptap/block-handle';
import { blocksToPmDoc, pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import { kernelExtensions } from '../../../../../src/document/editors/tiptap/editor';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

// jsdom has no layout: the handle is positioned from getBoundingClientRect.
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

/** A rectangle used by the geometry stubs. */
function rect(left: number, top: number, width = 300, height = 24): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Give one element a fixed layout rectangle. */
function stubRect(
  element: Element,
  left: number,
  top: number,
  width = 300,
  height = 24,
): void {
  (element as HTMLElement).getBoundingClientRect = () => rect(left, top, width, height);
}

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function paragraph(id: string, text: string): BlockNode {
  return block(id, 'paragraph', {}, { content: [{ type: 'text', text }] });
}

function docWith(blocks: BlockNode[]): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision: 1, blocks };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  document
    .querySelectorAll('[aria-label="块操作"], [data-drop-indicator]')
    .forEach((node) => node.remove());
});

function mount(doc: AlterDoc, options: BlockHandleOptions = {}) {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: kernelExtensions(),
    content: blocksToPmDoc(doc.blocks).value.toJSON(),
  });
  const handle = createBlockHandle(editor, options);
  cleanups.push(() => {
    handle.destroy();
    editor.destroy();
    element.remove();
  });
  return { editor, handle };
}

/** Top-level block elements of the editable body, in document order. */
function topBlocks(editor: Editor): HTMLElement[] {
  return [...editor.view.dom.children] as HTMLElement[];
}

function handleElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[aria-label="块操作"]');
  expect(element, 'block handle is mounted').not.toBeNull();
  return element!;
}

function indicatorElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-drop-indicator]');
  expect(element, 'drop indicator is mounted').not.toBeNull();
  return element!;
}

function moveOver(element: Element, clientY = 0): void {
  element.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY }),
  );
}

function pressHandle(clientX: number, clientY: number): void {
  handleElement().dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
      clientY,
    }),
  );
}

function movePointer(clientX: number, clientY: number): void {
  document.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true, clientX, clientY }),
  );
}

function releasePointer(clientX: number, clientY: number): void {
  document.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, clientX, clientY }),
  );
}

function idsOf(editor: Editor): Array<string | undefined> {
  return pmDocToBlocks(editor.state.doc).value.map((item) => item.id);
}

describe('block handle', () => {
  it('is a body-level button with the frozen grip icon', () => {
    mount(docWith([paragraph('blk_p', '正文')]));
    const handle = handleElement();
    expect(handle.tagName).toBe('BUTTON');
    expect(handle.getAttribute('aria-label')).toBe('块操作');
    expect(handle.querySelector('svg')).not.toBeNull();
    expect(handle.dataset['visible']).toBe('false');
  });

  it('shows in the left gutter of the hovered top-level block', () => {
    const { editor } = mount(
      docWith([paragraph('blk_a', '一'), paragraph('blk_b', '二')]),
    );
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    moveOver(blocks[0]!);
    const handle = handleElement();
    expect(handle.dataset['visible']).toBe('true');
    // 26px left of the block, clamped into the viewport, top + 2px.
    expect(handle.style.left).toBe('94px');
    expect(handle.style.top).toBe('52px');
  });

  it('resolves the top-level block when the pointer is on a nested element', () => {
    const list: BlockNode = block('blk_list', 'bulletList', {}, {
      children: [
        block('blk_li1', 'listItem', {}, {
          children: [paragraph('blk_l1', '一')],
        }),
        block('blk_li2', 'listItem', {}, {
          children: [paragraph('blk_l2', '二')],
        }),
      ],
    });
    const { editor } = mount(docWith([list]));
    const root = topBlocks(editor)[0]!;
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(root, 130, 40);
    const nested = root.querySelector('li p');
    expect(nested).not.toBeNull();
    moveOver(nested!);
    const handle = handleElement();
    expect(handle.dataset['visible']).toBe('true');
    expect(handle.style.left).toBe('104px');
    // Clicking the handle selects the whole list, not the paragraph inside it.
    handle.click();
    const selection = editor.state.selection;
    expect(selection).toBeInstanceOf(TextSelection);
    expect(editor.state.doc.textBetween(selection.from, selection.to)).toBe('一二');
    expect(root.getAttribute('data-block-selected')).toBe('');
  });

  it('selects a text block with a TextSelection covering its content', () => {
    const { editor } = mount(
      docWith([paragraph('blk_a', '一'), paragraph('blk_b', '二')]),
    );
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[1]!, 120, 100);
    moveOver(blocks[1]!);
    handleElement().click();
    const selection = editor.state.selection;
    expect(selection).toBeInstanceOf(TextSelection);
    expect(editor.state.doc.textBetween(selection.from, selection.to)).toBe('二');
    expect(blocks[1]!.getAttribute('data-block-selected')).toBe('');
    expect(blocks[0]!.hasAttribute('data-block-selected')).toBe(false);
    // Editing-surface attribute only: it never reaches the AST.
    expect(JSON.stringify(pmDocToBlocks(editor.state.doc).value)).not.toContain(
      'data-block-selected',
    );
  });

  it('selects a divider with a NodeSelection', () => {
    const { editor } = mount(
      docWith([paragraph('blk_p', '正文'), block('blk_hr', 'divider')]),
    );
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[1]!, 120, 90, 300, 20);
    moveOver(blocks[1]!);
    handleElement().click();
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe('divider');
    expect(
      editor.view.dom.querySelector('[data-divider]')?.getAttribute('data-block-selected'),
    ).toBe('');
  });

  it('selects a table with a NodeSelection', () => {
    const table: BlockNode = block('blk_t', 'table', { headerRows: 1 }, {
      children: [
        block('blk_row', 'tableRow', {}, {
          children: [
            block('blk_c', 'tableCell', {}, {
              content: [{ type: 'text', text: 'A' }],
            }),
          ],
        }),
      ],
    });
    const { editor } = mount(docWith([paragraph('blk_p', '之前'), table]));
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[1]!, 120, 90, 300, 60);
    moveOver(blocks[1]!);
    handleElement().click();
    // The table plugin normalizes a table NodeSelection into a CellSelection
    // covering every cell: the whole table is selected either way.
    const selection = editor.state.selection;
    const selectionKind = (selection as { jsonID?: string }).jsonID ?? '';
    expect(['node', 'cell']).toContain(selectionKind);
    if (selection instanceof NodeSelection) {
      expect(selection.node.type.name).toBe('table');
    }
    expect(blocks[1]!.getAttribute('data-block-selected')).toBe('');
  });

  it('drops the block mark when the selection moves away', () => {
    const { editor } = mount(docWith([paragraph('blk_p', '正文')]));
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    moveOver(blocks[0]!);
    handleElement().click();
    expect(blocks[0]!.getAttribute('data-block-selected')).toBe('');
    editor.commands.setTextSelection(1);
    expect(blocks[0]!.hasAttribute('data-block-selected')).toBe(false);
  });

  it('hides after the pointer leaves the body, and stays while on the handle', () => {
    vi.useFakeTimers();
    const { editor } = mount(docWith([paragraph('blk_p', '正文')]));
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    moveOver(blocks[0]!);
    expect(handleElement().dataset['visible']).toBe('true');
    editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'));
    handleElement().dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(handleElement().dataset['visible']).toBe('true');
    handleElement().dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(119);
    expect(handleElement().dataset['visible']).toBe('true');
    vi.advanceTimersByTime(1);
    expect(handleElement().dataset['visible']).toBe('false');
  });

  it('hides on scroll', () => {
    const { editor } = mount(docWith([paragraph('blk_p', '正文')]));
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    moveOver(blocks[0]!);
    expect(handleElement().dataset['visible']).toBe('true');
    document.dispatchEvent(new Event('scroll'));
    expect(handleElement().dataset['visible']).toBe('false');
  });

  it('reorders a block by dragging: drop before the first block', () => {
    const onDragChange = vi.fn();
    const { editor } = mount(
      docWith([paragraph('blk_a', '一'), paragraph('blk_b', '二'), paragraph('blk_c', '三')]),
      { onDragChange },
    );
    const onUpdate = vi.fn();
    editor.on('update', onUpdate);
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    stubRect(blocks[1]!, 120, 100);
    stubRect(blocks[2]!, 120, 150);

    moveOver(blocks[2]!);
    pressHandle(200, 150);
    movePointer(200, 52);
    const indicator = indicatorElement();
    expect(indicator.style.display).not.toBe('none');
    expect(indicator.style.top).toBe('50px');
    expect(handleElement().dataset['visible']).toBe('false');
    expect(onDragChange).toHaveBeenLastCalledWith(true);

    releasePointer(200, 52);
    expect(idsOf(editor)).toEqual(['blk_c', 'blk_a', 'blk_b']);
    expect(onUpdate).toHaveBeenCalled();
    expect(onDragChange).toHaveBeenLastCalledWith(false);
    // The caret stays inside the block that was moved.
    expect(editor.state.selection.$from.parent.textContent).toBe('三');
    expect(indicator.style.display).toBe('none');
  });

  it('reorders a block after the last one when dropped below the body', () => {
    const { editor } = mount(
      docWith([paragraph('blk_a', '一'), paragraph('blk_b', '二'), paragraph('blk_c', '三')]),
    );
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    stubRect(blocks[1]!, 120, 100);
    stubRect(blocks[2]!, 120, 150);
    moveOver(blocks[0]!);
    pressHandle(200, 60);
    movePointer(200, 195);
    expect(indicatorElement().style.top).toBe('174px');
    releasePointer(200, 195);
    expect(idsOf(editor)).toEqual(['blk_b', 'blk_c', 'blk_a']);
  });

  it('ignores dropping a block onto itself', () => {
    const onDragChange = vi.fn();
    const { editor } = mount(
      docWith([paragraph('blk_a', '一'), paragraph('blk_b', '二')]),
      { onDragChange },
    );
    const onUpdate = vi.fn();
    editor.on('update', onUpdate);
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    stubRect(blocks[1]!, 120, 100);
    moveOver(blocks[1]!);
    pressHandle(200, 110);
    // Start the drag away from the block, then move back onto its own source.
    movePointer(200, 300);
    expect(onDragChange).toHaveBeenLastCalledWith(true);
    movePointer(200, 112);
    expect(indicatorElement().style.display).toBe('none');
    releasePointer(200, 112);
    expect(idsOf(editor)).toEqual(['blk_a', 'blk_b']);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onDragChange).toHaveBeenLastCalledWith(false);
  });

  it('cancels a drag with Escape', () => {
    const { editor } = mount(
      docWith([paragraph('blk_a', '一'), paragraph('blk_b', '二')]),
    );
    const onUpdate = vi.fn();
    editor.on('update', onUpdate);
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    stubRect(blocks[1]!, 120, 100);
    moveOver(blocks[0]!);
    pressHandle(200, 60);
    movePointer(200, 104);
    expect(indicatorElement().style.display).not.toBe('none');
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(indicatorElement().style.display).toBe('none');
    releasePointer(200, 104);
    expect(idsOf(editor)).toEqual(['blk_a', 'blk_b']);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('cancels a drag that leaves the body', () => {
    const { editor } = mount(
      docWith([paragraph('blk_a', '一'), paragraph('blk_b', '二')]),
    );
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    stubRect(blocks[1]!, 120, 100);
    moveOver(blocks[0]!);
    pressHandle(200, 60);
    movePointer(2000, 600);
    expect(indicatorElement().style.display).toBe('none');
    releasePointer(2000, 600);
    expect(idsOf(editor)).toEqual(['blk_a', 'blk_b']);
  });

  it('cancels a drag when the window loses focus', () => {
    const { editor } = mount(
      docWith([paragraph('blk_a', '一'), paragraph('blk_b', '二')]),
    );
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    stubRect(blocks[1]!, 120, 100);
    moveOver(blocks[0]!);
    pressHandle(200, 60);
    movePointer(200, 104);
    expect(indicatorElement().style.display).not.toBe('none');
    window.dispatchEvent(new Event('blur'));
    expect(indicatorElement().style.display).toBe('none');
    releasePointer(200, 104);
    expect(idsOf(editor)).toEqual(['blk_a', 'blk_b']);
  });

  it('keeps a plain press without travel as a click-select', () => {
    const { editor } = mount(docWith([paragraph('blk_p', '正文')]));
    const blocks = topBlocks(editor);
    stubRect(editor.view.dom, 100, 0, 500, 400);
    stubRect(blocks[0]!, 120, 50);
    moveOver(blocks[0]!);
    pressHandle(200, 60);
    releasePointer(200, 60);
    handleElement().click();
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(blocks[0]!.getAttribute('data-block-selected')).toBe('');
  });

  it('removes the handle and the insertion line on destroy', () => {
    const { editor, handle } = mount(docWith([paragraph('blk_p', '正文')]));
    expect(document.querySelector('[aria-label="块操作"]')).not.toBeNull();
    handle.destroy();
    expect(editor.view.dom.querySelector('[data-block-selected]')).toBeNull();
    expect(document.querySelector('[aria-label="块操作"]')).toBeNull();
    expect(document.querySelector('[data-drop-indicator]')).toBeNull();
  });
});