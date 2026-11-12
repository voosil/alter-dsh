// @vitest-environment jsdom
/**
 * Block-selection state machine (divider / image / table) parity gate.
 *
 * Frozen behaviour (`docs/acceptance/editor-experience-p0-p6.md` §2): a caret next to a
 * divider or a whole-line image selects it on the first delete press and
 * removes it on the second; Escape cancels, any other key cancels and then
 * continues; clicking the block selects it and clicking elsewhere cancels;
 * `data-selected` is editing-surface state only and never reaches the AST.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeSelection } from '@tiptap/pm/state';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import {
  blockSelectionOf,
  createBlockSelection,
  handleBlockSelectionKey,
} from '../../../../../src/document/editors/tiptap/block-selection';
import { KERNEL_CLASS } from '../../../../../src/document/editors/tiptap/classes';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

// jsdom has no layout; the overlays measure targets with getBoundingClientRect.
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

function image(id: string): BlockNode {
  return block(id, 'image', { assetId: 'asset_one', alt: '图' });
}

function divider(id: string): BlockNode {
  return block(id, 'divider');
}

function docWith(blocks: BlockNode[]): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision: 1, blocks };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  document.querySelectorAll(`.${KERNEL_CLASS.linkBar}`).forEach((node) => node.remove());
});

function mount(doc: AlterDoc, extra: { onUpdate?: () => void } = {}) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc, ...extra });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/** Caret positions of every text block, in document order. */
function textBlocks(kernel: ReturnType<typeof mount>): Array<{
  start: number;
  end: number;
  text: string;
}> {
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  kernel.editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    ranges.push({
      start: pos + 1,
      end: pos + node.nodeSize - 1,
      text: node.textContent,
    });
    return false;
  });
  return ranges;
}

function press(key: 'Backspace' | 'Delete' | 'Escape' | string): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
}

function click(element: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

describe('block selection', () => {
  it('is memoized per editor view', () => {
    const kernel = mount(docWith([paragraph('blk_p', '正文')]));
    const view = kernel.editor.view;
    expect(blockSelectionOf(view)).toBe(blockSelectionOf(kernel.editor));
    expect(createBlockSelection(view)).toBe(blockSelectionOf(view));
  });

  it('selects an adjacent image on the first Backspace and deletes it on the second', () => {
    const onUpdate = vi.fn();
    const kernel = mount(
      docWith([paragraph('blk_p1', '之前'), image('blk_img'), paragraph('blk_p2', '之后')]),
      { onUpdate },
    );
    const imageElement = kernel.editor.view.dom.querySelector('img');
    expect(imageElement, 'image is rendered').not.toBeNull();
    const ranges = textBlocks(kernel);
    kernel.editor.commands.setTextSelection(ranges[1]!.start);

    const first = press('Backspace');
    expect(handleBlockSelectionKey(kernel.editor, first)).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    // The frozen editor only marks the block; it neither deletes nor saves.
    expect(imageElement!.getAttribute('data-selected')).toBe('');
    expect(onUpdate).not.toHaveBeenCalled();
    expect(pmDocToBlocks(kernel.capture()).value).toHaveLength(3);
    // Editing-surface state must not reach the AST.
    expect(JSON.stringify(pmDocToBlocks(kernel.capture()).value)).not.toContain(
      'data-selected',
    );

    expect(handleBlockSelectionKey(kernel.editor, press('Backspace'))).toBe(true);
    expect(kernel.editor.view.dom.querySelector('img')).toBeNull();
    expect(onUpdate).toHaveBeenCalled();
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks.map((item) => item.type)).toEqual(['paragraph', 'paragraph']);
    // The caret lands at the end of the previous typable block.
    const selection = kernel.editor.state.selection;
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.textContent).toBe('之前');
    expect(selection.from).toBe(textBlocks(kernel)[0]!.end);
  });

  it('selects an adjacent divider forward with Delete and removes it on the second press', () => {
    const kernel = mount(
      docWith([paragraph('blk_p1', '之前'), divider('blk_hr'), paragraph('blk_p2', '之后')]),
    );
    const dividerElement = kernel.editor.view.dom.querySelector('[data-divider]');
    expect(dividerElement, 'divider is rendered').not.toBeNull();
    kernel.editor.commands.setTextSelection(textBlocks(kernel)[0]!.end);

    expect(handleBlockSelectionKey(kernel.editor, press('Delete'))).toBe(true);
    expect(dividerElement!.getAttribute('data-selected')).toBe('');
    expect(pmDocToBlocks(kernel.capture()).value).toHaveLength(3);

    expect(handleBlockSelectionKey(kernel.editor, press('Delete'))).toBe(true);
    expect(kernel.editor.view.dom.querySelector('[data-divider]')).toBeNull();
    expect(pmDocToBlocks(kernel.capture()).value.map((item) => item.type)).toEqual([
      'paragraph',
      'paragraph',
    ]);
    // Previous typable block end wins over the next block start.
    expect(kernel.editor.state.selection.from).toBe(textBlocks(kernel)[0]!.end);
  });

  it('deletes a divider selected by Backspace from the line below it', () => {
    const kernel = mount(
      docWith([paragraph('blk_p1', '之前'), divider('blk_hr'), paragraph('blk_p2', '之后')]),
    );
    kernel.editor.commands.setTextSelection(textBlocks(kernel)[1]!.start);
    expect(handleBlockSelectionKey(kernel.editor, press('Backspace'))).toBe(true);
    expect(handleBlockSelectionKey(kernel.editor, press('Backspace'))).toBe(true);
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks.map((item) => item.type)).toEqual(['paragraph', 'paragraph']);
    expect(JSON.stringify(blocks)).not.toContain('blk_hr');
  });

  it('only handles delete keys at the very edge of the line', () => {
    const kernel = mount(
      docWith([paragraph('blk_p', 'hello'), image('blk_img')]),
    );
    kernel.editor.commands.setTextSelection(2);
    expect(handleBlockSelectionKey(kernel.editor, press('Backspace'))).toBe(false);
    expect(kernel.editor.view.dom.querySelector('img')?.hasAttribute('data-selected')).toBe(
      false,
    );
  });

  it('does not pick up an adjacent table with a delete key', () => {
    // Tables are selected from their bar, never by the caret adjacency rule.
    const kernel = mount(
      {
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: 1,
        blocks: [
          paragraph('blk_p', '之前'),
          block('blk_t', 'table', { headerRows: 1 }, {
            children: [
              block('blk_row', 'tableRow', {}, {
                children: [
                  block('blk_cell', 'tableCell', {}, {
                    content: [{ type: 'text', text: 'A' }],
                  }),
                ],
              }),
            ],
          }),
        ],
      },
    );
    kernel.editor.commands.setTextSelection(textBlocks(kernel)[0]!.end);
    expect(handleBlockSelectionKey(kernel.editor, press('Delete'))).toBe(false);
    expect(kernel.editor.view.dom.querySelector('table')?.hasAttribute('data-selected')).toBe(
      false,
    );
  });

  it('does not use block selection for modified delete keys', () => {
    const kernel = mount(
      docWith([paragraph('blk_p', 'hello'), image('blk_img')]),
    );
    kernel.editor.commands.setTextSelection(textBlocks(kernel)[0]!.end);
    const event = new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    expect(handleBlockSelectionKey(kernel.editor, event)).toBe(false);
  });

  it('cancels with Escape without deleting', () => {
    const kernel = mount(docWith([paragraph('blk_p', '之前'), image('blk_img')]));
    kernel.editor.commands.setTextSelection(textBlocks(kernel)[0]!.end);
    expect(handleBlockSelectionKey(kernel.editor, press('Delete'))).toBe(true);
    const escape = press('Escape');
    expect(handleBlockSelectionKey(kernel.editor, escape)).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    expect(
      kernel.editor.view.dom.querySelector('img')?.hasAttribute('data-selected'),
    ).toBe(false);
    expect(pmDocToBlocks(kernel.capture()).value).toHaveLength(2);
  });

  it('cancels the selection on any other key and lets the key continue', () => {
    const kernel = mount(docWith([paragraph('blk_p', '之前'), image('blk_img')]));
    kernel.editor.commands.setTextSelection(textBlocks(kernel)[0]!.end);
    expect(handleBlockSelectionKey(kernel.editor, press('Delete'))).toBe(true);
    const typing = press('a');
    expect(handleBlockSelectionKey(kernel.editor, typing)).toBe(false);
    expect(typing.defaultPrevented).toBe(false);
    expect(
      kernel.editor.view.dom.querySelector('img')?.hasAttribute('data-selected'),
    ).toBe(false);
  });

  it('selects images and dividers by click and clears on an outside click', () => {
    const kernel = mount(
      docWith([paragraph('blk_p', '正文'), image('blk_img'), divider('blk_hr')]),
    );
    const dom = kernel.editor.view.dom;
    const imageElement = dom.querySelector('img')!;
    expect(click(imageElement).defaultPrevented).toBe(true);
    expect(imageElement.getAttribute('data-selected')).toBe('');

    const dividerElement = dom.querySelector('[data-divider]')!;
    click(dividerElement);
    expect(dividerElement.getAttribute('data-selected')).toBe('');
    // Only one block is selected at a time.
    expect(imageElement.hasAttribute('data-selected')).toBe(false);

    click(dom.querySelector('p')!);
    expect(dividerElement.hasAttribute('data-selected')).toBe(false);
  });

  it('keeps the caret outside a clicked image instead of replacing it on typing', () => {
    const kernel = mount(
      docWith([paragraph('过去', '之前'), image('blk_img'), paragraph('blk_p2', '之后')]),
    );
    const imageElement = kernel.editor.view.dom.querySelector('img')!;
    // ProseMirror selects a selectable atom on mousedown.
    let imagePos = -1;
    kernel.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') imagePos = pos;
      return true;
    });
    kernel.editor.view.dispatch(
      kernel.editor.state.tr.setSelection(
        NodeSelection.create(kernel.editor.state.doc, imagePos),
      ),
    );
    click(imageElement);
    expect(imageElement.getAttribute('data-selected')).toBe('');
    expect(kernel.editor.state.selection).not.toBeInstanceOf(NodeSelection);
    // Typing continues next to the block instead of replacing it.
    kernel.editor.view.dispatch(kernel.editor.state.tr.insertText('x'));
    expect(kernel.editor.view.dom.querySelector('img')).not.toBeNull();
  });

  it('replaces the only block with an empty paragraph when the last image is deleted', () => {
    const kernel = mount(docWith([image('blk_img')]));
    const dom = kernel.editor.view.dom;
    click(dom.querySelector('img')!);
    expect(blockSelectionOf(kernel.editor).removeSelected()).toBe(true);
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('paragraph');
  });

  it('keeps the document valid when the only block is a divider', () => {
    const kernel = mount(docWith([divider('blk_hr')]));
    const dom = kernel.editor.view.dom;
    click(dom.querySelector('[data-divider]')!);
    expect(blockSelectionOf(kernel.editor).removeSelected()).toBe(true);
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('paragraph');
    expect(kernel.editor.state.doc.childCount).toBe(1);
  });

  it('works through the real keydown path of the mounted kernel', () => {
    // End-to-end ordering check: the keyboard extension must dispatch block
    // selection before the browser/ProseMirror default delete handling.
    const kernel = mount(
      docWith([paragraph('blk_p1', '之前'), image('blk_img'), paragraph('blk_p2', '之后')]),
    );
    const dom = kernel.editor.view.dom;
    kernel.editor.commands.setTextSelection(textBlocks(kernel)[1]!.start);
    dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }),
    );
    const imageElement = dom.querySelector('img');
    expect(imageElement).not.toBeNull();
    expect(imageElement!.getAttribute('data-selected')).toBe('');
    expect(pmDocToBlocks(kernel.capture()).value).toHaveLength(3);
    dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(dom.querySelector('img')).toBeNull();
    expect(pmDocToBlocks(kernel.capture()).value.map((item) => item.type)).toEqual([
      'paragraph',
      'paragraph',
    ]);
  });

  it('clears the selection when the kernel is destroyed', () => {
    const kernel = mount(docWith([paragraph('blk_p', '之前'), image('blk_img')]));
    kernel.editor.commands.setTextSelection(textBlocks(kernel)[0]!.end);
    expect(handleBlockSelectionKey(kernel.editor, press('Delete'))).toBe(true);
    blockSelectionOf(kernel.editor).clear();
    expect(
      kernel.editor.view.dom.querySelector('img')?.hasAttribute('data-selected'),
    ).toBe(false);
  });
});