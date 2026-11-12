// @vitest-environment jsdom
/**
 * Table overlay in the AST-native kernel.
 *
 * Parity gate: hovering a table offers 选中; selecting it offers 上移 / 下移 /
 * 删除. Moving must preserve the table node (and its block ids) and must not
 * corrupt the sibling order; deleting removes exactly that node.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

// jsdom has no layout: the overlays measure targets with getBoundingClientRect.
const zeroRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
Element.prototype.getBoundingClientRect = zeroRect as never;

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function cell(id: string, text: string): BlockNode {
  return block(id, 'tableCell', {}, { content: [{ type: 'text', text }] });
}

function table(id: string): BlockNode {
  return block(id, 'table', { headerRows: 1 }, {
    children: [
      block(`${id}_row1`, 'tableRow', {}, {
        children: [cell(`${id}_c11`, 'A'), cell(`${id}_c12`, 'B')],
      }),
      block(`${id}_row2`, 'tableRow', {}, {
        children: [cell(`${id}_c21`, 'C'), cell(`${id}_c22`, 'D')],
      }),
    ],
  });
}

function docWithTable(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      block('blk_p1', 'paragraph', {}, {
        content: [{ type: 'text', text: '之前' }],
      }),
      table('blk_t'),
      block('blk_p2', 'paragraph', {}, {
        content: [{ type: 'text', text: '之后' }],
      }),
    ],
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  document.querySelectorAll('.linkBar').forEach((node) => node.remove());
});

function mount(doc: AlterDoc) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/** The table bar (role + label), regardless of other overlay bars. */
function tableBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="表格操作"]');
}

/** Simulate hovering the first table in the body. */
function hoverTable(kernel: ReturnType<typeof mount>): void {
  const tableElement = kernel.editor.view.dom.querySelector('table');
  expect(tableElement).not.toBeNull();
  tableElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

function clickBar(label: string): void {
  const target = tableBar()?.querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  );
  expect(target, `button ${label}`).not.toBeNull();
  target!.click();
}

describe('table bar', () => {
  it('exists as a body-level overlay with the frozen label', () => {
    mount(docWithTable());
    const bar = tableBar();
    expect(bar).not.toBeNull();
    expect(bar?.className).toBe('linkBar');
    expect(bar?.getAttribute('role')).toBe('group');
    // Nothing hovered yet.
    expect(bar?.style.display).toBe('none');
  });

  it('offers 选中 when a table is hovered', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    const bar = tableBar()!;
    expect(bar.style.display).not.toBe('none');
    expect(bar.querySelector('[aria-label="选中"]')).not.toBeNull();
    expect(bar.querySelector('[aria-label="上移"]')).toBeNull();
  });

  it('offers 上移 / 下移 / 删除 once the table is selected', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    clickBar('选中');
    for (const label of ['上移', '下移', '删除']) {
      expect(tableBar()?.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
    // The frozen stylesheet tints the selected table through this attribute.
    expect(
      kernel.editor.view.dom.querySelector('table')?.getAttribute('data-selected'),
    ).toBe('');
  });

  it('moves the table up while preserving its node and ids', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    clickBar('选中');
    clickBar('上移');
    const types = pmDocToBlocks(kernel.capture()).value.map((item) => item.type);
    expect(types).toEqual(['table', 'paragraph', 'paragraph']);
    const captured = pmDocToBlocks(kernel.capture()).value;
    expect(captured[0]?.id).toBe('blk_t');
    // Children keep their ids too, which is what comment anchors reference.
    expect(captured[0]?.children?.[0]?.id).toBe('blk_t_row1');
  });

  it('moves the table down when a block follows it', () => {
    // Two blocks follow the table here, so a downward move is well defined.
    const withTwo = docWithTable();
    withTwo.blocks.push(
      block('blk_p3', 'paragraph', {}, {
        content: [{ type: 'text', text: '再之后' }],
      }),
    );
    const second = mount(withTwo);
    hoverTable(second);
    clickBar('选中');
    clickBar('下移');
    const types = pmDocToBlocks(second.capture()).value.map((item) => item.type);
    // The table swaps with the block directly below it.
    expect(types).toEqual(['paragraph', 'paragraph', 'table', 'paragraph']);
    expect(pmDocToBlocks(second.capture()).value[2]?.id).toBe('blk_t');
  });

  it('refuses to move the table into the document tail', () => {
    // Known limitation: ProseMirror needs a block after the last one to keep the
    // caret reachable, so a table cannot become the final block. The bar keeps
    // the table in place instead of appending a filler paragraph.
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    clickBar('选中');
    clickBar('下移');
    const types = pmDocToBlocks(kernel.capture()).value.map((item) => item.type);
    expect(types).toEqual(['paragraph', 'table', 'paragraph']);
  });

  it('deletes exactly the selected table', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    clickBar('选中');
    clickBar('删除');
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks.map((item) => item.type)).toEqual(['paragraph', 'paragraph']);
    expect(JSON.stringify(blocks)).not.toContain('blk_t');
  });

  it('removes its overlay when the kernel is destroyed', () => {
    const kernel = mount(docWithTable());
    expect(tableBar()).not.toBeNull();
    kernel.destroy();
    expect(tableBar()).toBeNull();
  });
});


