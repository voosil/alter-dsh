// @vitest-environment jsdom
/**
 * Table action bar parity (`docs/acceptance/editor-experience-p0-p6.md` §2).
 *
 * Frozen behaviour: hovering a table offers 选中; the selected state marks the
 * table with `data-selected`, moves the caret out of the table and turns the
 * bar into 上移/下移/删除. Moving swaps siblings (ids preserved) and saves;
 * deleting removes the table, parks the caret on a typable neighbour and hides
 * the bar. The bar reuses the dark `.linkBar` look and hides 180ms after the
 * pointer leaves the body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import { CellSelection } from '@tiptap/pm/tables';
import type { Node as PmNode } from '@tiptap/pm/model';
import { closeOverlayBars } from '../../../../../src/document/editors/tiptap/overlays';
import { blockSelectionOf } from '../../../../../src/document/editors/tiptap/block-selection';
import { KERNEL_CLASS } from '../../../../../src/document/editors/tiptap/classes';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

// jsdom has no layout: the bars measure their target with getBoundingClientRect.
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

/** A rectangle used to prove the frozen clamp formulas. */
function rect(left: number, top: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + 120,
    bottom: top + 40,
    width: 120,
    height: 40,
    toJSON: () => ({}),
  } as DOMRect;
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
      paragraph('blk_p1', '之前'),
      table('blk_t'),
      paragraph('blk_p2', '之后'),
    ],
  };
}

/** A 3x3 table with no header row (the plain variant). */
function plainTable(id: string): BlockNode {
  return block(id, 'table', { headerRows: 0 }, {
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

/** A table whose two leading rows are header rows. */
function doubleHeaderTable(id: string): BlockNode {
  return block(id, 'table', { headerRows: 2 }, {
    children: [
      block(`${id}_row1`, 'tableRow', {}, {
        children: [cell(`${id}_r1c1`, 'A'), cell(`${id}_r1c2`, 'B')],
      }),
      block(`${id}_row2`, 'tableRow', {}, {
        children: [cell(`${id}_r2c1`, 'C'), cell(`${id}_r2c2`, 'D')],
      }),
      block(`${id}_row3`, 'tableRow', {}, {
        children: [cell(`${id}_r3c1`, 'E'), cell(`${id}_r3c2`, 'F')],
      }),
    ],
  });
}

function docWithPlainTable(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      paragraph('blk_p1', '之前'),
      plainTable('blk_t'),
      paragraph('blk_p2', '之后'),
    ],
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
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

/** The table bar (role + label), regardless of the link bar. */
function tableBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="表格操作"]');
}

function hoverTable(kernel: ReturnType<typeof mount>): HTMLElement {
  const tableElement = kernel.editor.view.dom.querySelector('table');
  expect(tableElement, 'table is rendered').not.toBeNull();
  tableElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  return tableElement!;
}

function pressBar(label: string): void {
  const button = tableBar()?.querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  );
  expect(button, `button ${label}`).not.toBeNull();
  button!.click();
}

/** Document position of the first top-level table. */
function tablePosition(kernel: ReturnType<typeof mount>): number {
  const doc = kernel.editor.state.doc;
  let pos = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const child = doc.child(index);
    if (child.type.name === 'table') return pos;
    pos += child.nodeSize;
  }
  throw new Error('no table in the document');
}

/** First top-level table node. */
function tableNode(kernel: ReturnType<typeof mount>): PmNode | null {
  const doc = kernel.editor.state.doc;
  for (let index = 0; index < doc.childCount; index += 1) {
    const child = doc.child(index);
    if (child.type.name === 'table') return child;
  }
  return null;
}

/** Put the caret inside the first cell of the first table. */
function caretInFirstCell(kernel: ReturnType<typeof mount>): void {
  kernel.editor.commands.setTextSelection(tablePosition(kernel) + 4);
}

/** Whether the caret sits inside any table. */
function caretInsideTable(kernel: ReturnType<typeof mount>): boolean {
  const $from = kernel.editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') return true;
  }
  return false;
}

/** Press one full-toolbar button by its stable action name. */
function pressAction(action: string): void {
  const button = tableBar()?.querySelector<HTMLButtonElement>(
    `[data-table-action="${action}"]`,
  );
  expect(button, `table action ${action}`).not.toBeNull();
  button!.click();
}

describe('table bar', () => {
  it('exists as a body-level overlay with the frozen shell', () => {
    mount(docWithTable());
    const bar = tableBar();
    expect(bar).not.toBeNull();
    expect(bar?.className).toBe(KERNEL_CLASS.linkBar);
    expect(bar?.getAttribute('role')).toBe('group');
    expect(bar?.style.display).toBe('none');
  });

  it('offers 选中 with the frozen aria/title/text while a table is hovered', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    const bar = tableBar()!;
    expect(bar.style.display).not.toBe('none');
    const button = bar.querySelector<HTMLButtonElement>('[aria-label="选中表格"]');
    expect(button).not.toBeNull();
    expect(button!.textContent).toBe('选中');
    expect(button!.title).toBe('选中整表');
    expect(bar.querySelector('[aria-label="上移表格"]')).toBeNull();
  });

  it('marks the selected table and turns the bar into 上移/下移/删除', () => {
    const kernel = mount(docWithTable());
    const tableElement = hoverTable(kernel);
    pressBar('选中表格');
    expect(tableElement.getAttribute('data-selected')).toBe('');
    const bar = tableBar()!;
    const expectations: Array<[string, string, string]> = [
      ['上移表格', '上移', '上移'],
      ['下移表格', '下移', '下移'],
      ['删除表格', '删除', '删除'],
    ];
    for (const [ariaLabel, text, title] of expectations) {
      const button = bar.querySelector<HTMLButtonElement>(
        `[aria-label="${ariaLabel}"]`,
      );
      expect(button, ariaLabel).not.toBeNull();
      expect(button!.textContent).toBe(text);
      expect(button!.title).toBe(title);
    }
    // The frozen editor parks the caret outside the table so the next delete
    // key removes the table instead of a cell character.
    const selection = kernel.editor.state.selection;
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.textContent).toBe('之前');
  });

  it('moves the table up while preserving its node and ids, and saves once', () => {
    const onUpdate = vi.fn();
    const kernel = mount(docWithTable(), { onUpdate });
    const tableElement = hoverTable(kernel);
    pressBar('选中表格');
    pressBar('上移表格');
    const captured = pmDocToBlocks(kernel.capture()).value;
    expect(captured.map((item) => item.type)).toEqual([
      'table',
      'paragraph',
      'paragraph',
    ]);
    expect(captured[0]?.id).toBe('blk_t');
    expect(captured[0]?.children?.[0]?.id).toBe('blk_t_row1');
    expect(onUpdate).toHaveBeenCalled();
    // The moved table stays the selected block and the bar keeps its buttons.
    const movedTable = kernel.editor.view.dom.querySelector('table');
    expect(movedTable).not.toBe(tableElement);
    expect(movedTable?.getAttribute('data-selected')).toBe('');
    expect(tableBar()?.querySelector('[aria-label="删除表格"]')).not.toBeNull();
    // The caret is outside the table (the next typable block's start here).
    expect(kernel.editor.state.selection.$from.parent.textContent).toBe('之前');
  });

  it('moves the table down when a block follows it', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    pressBar('选中表格');
    pressBar('下移表格');
    const captured = pmDocToBlocks(kernel.capture()).value;
    expect(captured.map((item) => item.type)).toEqual([
      'paragraph',
      'paragraph',
      'table',
    ]);
    expect(captured[2]?.id).toBe('blk_t');
    expect(kernel.editor.state.selection.$from.parent.textContent).toBe('之后');
  });

  it('does not move the last table down (the document may end with it)', () => {
    // The document may end with the table: the frozen editor allows it and the
    // kernel must not append a filler paragraph.
    const kernel = mount(
      {
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: 1,
        blocks: [paragraph('blk_p1', '之前'), table('blk_t')],
      },
    );
    hoverTable(kernel);
    pressBar('选中表格');
    pressBar('下移表格');
    expect(pmDocToBlocks(kernel.capture()).value.map((item) => item.type)).toEqual([
      'paragraph',
      'table',
    ]);
  });

  it('shows the full toolbar when the caret starts inside the only table', () => {
    const kernel = mount({
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [table('blk_t')],
    });
    expect(tableBar()?.style.display).not.toBe('none');
    expect(
      tableBar()?.querySelector('[aria-label="上方插入行"]'),
    ).not.toBeNull();
    // The whole-table 选中 entry only exists while the caret is outside a table.
    expect(tableBar()?.querySelector('[aria-label="选中表格"]')).toBeNull();
    expect(caretInsideTable(kernel)).toBe(true);
  });

  it('selecting a lone table never appends a paragraph nor saves', () => {
    // The whole-table state machine only moves the caret when a typable
    // neighbour exists; it never mutates the document just to select.
    const onUpdate = vi.fn();
    const kernel = mount(
      {
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: 1,
        blocks: [table('blk_t')],
      },
      { onUpdate },
    );
    const tableElement = kernel.editor.view.dom.querySelector('table')!;
    blockSelectionOf(kernel.editor).select(tableElement, { moveCaret: true });
    expect(pmDocToBlocks(kernel.capture()).value.map((item) => item.type)).toEqual([
      'table',
    ]);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('deletes exactly the selected table and parks the caret before it', () => {
    const onUpdate = vi.fn();
    const kernel = mount(docWithTable(), { onUpdate });
    hoverTable(kernel);
    pressBar('选中表格');
    pressBar('删除表格');
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks.map((item) => item.type)).toEqual(['paragraph', 'paragraph']);
    expect(JSON.stringify(blocks)).not.toContain('blk_t');
    expect(onUpdate).toHaveBeenCalled();
    expect(kernel.editor.state.selection.$from.parent.textContent).toBe('之前');
    // The bar is hidden once its table is gone.
    expect(tableBar()?.style.display).toBe('none');
  });

  it('deletes the selected table through the real Backspace path', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    pressBar('选中表格');
    kernel.editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }),
    );
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks.map((item) => item.type)).toEqual(['paragraph', 'paragraph']);
    expect(JSON.stringify(blocks)).not.toContain('blk_t');
  });

  it('cancels the table selection with Escape through the real keydown path', () => {
    const kernel = mount(docWithTable());
    const tableElement = hoverTable(kernel);
    pressBar('选中表格');
    kernel.editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(tableElement.getAttribute('data-selected')).toBeNull();
    expect(pmDocToBlocks(kernel.capture()).value).toHaveLength(3);
  });

  it('hides 180ms after the pointer leaves and keeps the selection meanwhile', () => {
    vi.useFakeTimers();
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    expect(tableBar()?.style.display).not.toBe('none');
    kernel.editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'));
    expect(tableBar()?.style.display).not.toBe('none');
    vi.advanceTimersByTime(179);
    expect(tableBar()?.style.display).not.toBe('none');
    vi.advanceTimersByTime(1);
    expect(tableBar()?.style.display).toBe('none');
  });

  it('hides when a non-table area is clicked', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    const paragraphElement = kernel.editor.view.dom.querySelector('p');
    expect(paragraphElement).not.toBeNull();
    paragraphElement!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(tableBar()?.style.display).toBe('none');
  });

  it('clamps its position with the frozen table-bar constants', () => {
    const kernel = mount(docWithTable());
    const tableElement = kernel.editor.view.dom.querySelector('table')!;
    tableElement.getBoundingClientRect = () => rect(300, 200);
    tableElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(tableBar()?.style.left).toBe('300px');
    // top = max(10, rect.top - 34)
    expect(tableBar()?.style.top).toBe('166px');
  });

  it('clamps its position inside the viewport at the right edge and top', () => {
    const kernel = mount(docWithTable());
    const tableElement = kernel.editor.view.dom.querySelector('table')!;
    tableElement.getBoundingClientRect = () => rect(5000, 5);
    tableElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const bar = tableBar()!;
    // left = min(max(12, rect.left), max(12, innerWidth - 160))
    expect(bar.style.left).toBe(`${window.innerWidth - 160}px`);
    expect(bar.style.top).toBe('10px');
  });

  it('shares the frozen hide timer with the link bar', () => {
    // The frozen editor uses one timer for both bars: leaving the body keeps
    // them visible while the pointer is over either bar, and hides both after.
    vi.useFakeTimers();
    const linkedCell: BlockNode = block('blk_lc', 'tableCell', {}, {
      content: [
        {
          type: 'text',
          text: '链接',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/x' } }],
        },
      ],
    });
    const kernel = mount({
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [
        paragraph('blk_p1', '之前'),
        block('blk_t', 'table', { headerRows: 1 }, {
          children: [
            block('blk_row', 'tableRow', {}, { children: [linkedCell] }),
          ],
        }),
        paragraph('blk_p2', '之后'),
      ],
    });
    const anchor = kernel.editor.view.dom.querySelector(
      'table a[data-web-link]',
    );
    expect(anchor).not.toBeNull();
    anchor!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const linkBarElement = document.querySelector<HTMLElement>(
      '[aria-label="链接操作"]',
    )!;
    expect(linkBarElement.style.display).not.toBe('none');
    expect(tableBar()?.style.display).not.toBe('none');

    kernel.editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(179);
    expect(linkBarElement.style.display).not.toBe('none');
    linkBarElement.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    // Entering one bar cancels the shared hide for both.
    expect(linkBarElement.style.display).not.toBe('none');
    expect(tableBar()?.style.display).not.toBe('none');
    linkBarElement.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(180);
    expect(linkBarElement.style.display).toBe('none');
    expect(tableBar()?.style.display).toBe('none');
  });

  it('keeps the caret while the bar is pressed', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    const bar = tableBar()!;
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    bar.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('closes from the shared IME/focus closer', () => {
    const kernel = mount(docWithTable());
    hoverTable(kernel);
    expect(tableBar()?.style.display).not.toBe('none');
    closeOverlayBars(kernel.editor);
    expect(tableBar()?.style.display).toBe('none');
  });

  it('removes its overlay when the kernel is destroyed', () => {
    const kernel = mount(docWithTable());
    expect(tableBar()).not.toBeNull();
    kernel.destroy();
    expect(tableBar()).toBeNull();
  });
});
/** Captured `headerRows` of the first table block, when present. */
function capturedHeaderRows(
  kernel: ReturnType<typeof mount>,
): number | undefined {
  const tableBlock = pmDocToBlocks(kernel.capture()).value.find(
    (item) => item.type === 'table',
  );
  const value = tableBlock?.attrs['headerRows'];
  return typeof value === 'number' ? value : undefined;
}

describe('table toolbar (caret inside a table)', () => {
  it('shows the full toolbar 42px above the table with every command', () => {
    const kernel = mount(docWithTable());
    const tableElement = kernel.editor.view.dom.querySelector('table')!;
    tableElement.getBoundingClientRect = () => rect(300, 200);
    caretInFirstCell(kernel);
    const bar = tableBar()!;
    expect(bar.style.display).not.toBe('none');
    expect(bar.style.top).toBe('158px');
    expect(bar.style.left).toBe('300px');
    const actions = [...bar.querySelectorAll('[data-table-action]')].map(
      (button) => button.getAttribute('data-table-action'),
    );
    expect(actions).toEqual([
      'add-row-before',
      'add-row-after',
      'add-column-before',
      'add-column-after',
      'delete-row',
      'delete-column',
      'merge-cells',
      'split-cell',
      'toggle-header',
      'move-up',
      'move-down',
      'delete-table',
    ]);
  });

  it('keeps compact text with full aria labels and titles', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    const expectations: Array<[string, string]> = [
      ['上方插入行', '↑行'],
      ['下方插入行', '↓行'],
      ['左侧插入列', '←列'],
      ['右侧插入列', '→列'],
      ['删除行', '删行'],
      ['删除列', '删列'],
      ['合并单元格', '合并'],
      ['拆分单元格', '拆分'],
      ['表头开关', '表头'],
      ['上移表格', '上移'],
      ['下移表格', '下移'],
      ['删除表格', '删表'],
    ];
    for (const [ariaLabel, text] of expectations) {
      const button = tableBar()?.querySelector<HTMLButtonElement>(
        `[aria-label="${ariaLabel}"]`,
      );
      expect(button, ariaLabel).not.toBeNull();
      expect(button!.textContent).toBe(text);
      expect(button!.title).not.toBe('');
    }
  });

  it('marks the header toggle active for a header table', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    const button = tableBar()?.querySelector<HTMLElement>(
      '[aria-label="表头开关"]',
    );
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('data-active')).toBe('true');
  });

  it('marks the header toggle inactive for a table without a header', () => {
    const kernel = mount(docWithPlainTable());
    caretInFirstCell(kernel);
    const button = tableBar()?.querySelector<HTMLElement>(
      '[aria-label="表头开关"]',
    );
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.getAttribute('data-active')).toBe('false');
  });

  it('inserts a row above and below and saves', () => {
    const onUpdate = vi.fn();
    const kernel = mount(docWithTable(), { onUpdate });
    caretInFirstCell(kernel);
    pressAction('add-row-after');
    expect(tableNode(kernel)?.childCount).toBe(3);
    expect(onUpdate).toHaveBeenCalled();
    // 上方插入行 is disabled inside the header row (it would push the header
    // out of the leading run); insert from a body row instead.
    const pos = tablePosition(kernel);
    const firstRow = kernel.editor.state.doc.nodeAt(pos + 1)!;
    kernel.editor.commands.setTextSelection(pos + 1 + firstRow.nodeSize + 4);
    pressAction('add-row-before');
    expect(tableNode(kernel)?.childCount).toBe(4);
  });

  it('inserts a column before and after', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    pressAction('add-column-after');
    expect(tableNode(kernel)?.firstChild?.childCount).toBe(3);
    pressAction('add-column-before');
    expect(tableNode(kernel)?.firstChild?.childCount).toBe(4);
    // Header cells stay header cells in the header row.
    expect(tableNode(kernel)?.firstChild?.firstChild?.type.name).toBe(
      'tableHeader',
    );
  });

  it('deletes a row and a column, disabling the action at the last one', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    pressAction('delete-row');
    expect(tableNode(kernel)?.childCount).toBe(1);
    expect(
      tableBar()?.querySelector<HTMLButtonElement>(
        '[aria-label="删除行"]',
      )?.disabled,
    ).toBe(true);
    pressAction('delete-row');
    expect(tableNode(kernel)?.childCount).toBe(1);

    pressAction('delete-column');
    expect(tableNode(kernel)?.firstChild?.childCount).toBe(1);
    expect(
      tableBar()?.querySelector<HTMLButtonElement>(
        '[aria-label="删除列"]',
      )?.disabled,
    ).toBe(true);
    pressAction('delete-column');
    expect(tableNode(kernel)?.firstChild?.childCount).toBe(1);
  });

  it('merges a cell range and splits it again', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    const doc = kernel.editor.state.doc;
    const rowPos = tablePosition(kernel) + 1;
    const firstCellPos = rowPos + 1;
    const firstCell = doc.nodeAt(firstCellPos)!;
    const secondCellPos = firstCellPos + firstCell.nodeSize;
    kernel.editor.view.dispatch(
      kernel.editor.state.tr.setSelection(
        CellSelection.create(kernel.editor.state.doc, firstCellPos, secondCellPos),
      ),
    );
    // A cell range enables 合并单元格.
    expect(
      tableBar()?.querySelector<HTMLButtonElement>(
        '[aria-label="合并单元格"]',
      )?.disabled,
    ).toBe(false);
    pressAction('merge-cells');
    const merged = tableNode(kernel);
    expect(merged?.firstChild?.childCount).toBe(1);
    expect(merged?.firstChild?.firstChild?.attrs['colspan']).toBe(2);
    // The merged cell enables 拆分单元格.
    expect(
      tableBar()?.querySelector<HTMLButtonElement>(
        '[aria-label="拆分单元格"]',
      )?.disabled,
    ).toBe(false);
    pressAction('split-cell');
    expect(tableNode(kernel)?.firstChild?.childCount).toBe(2);
    expect(tableNode(kernel)?.firstChild?.firstChild?.attrs['colspan']).toBe(1);
  });

  it('keeps the header row first: row-before is disabled in the header row', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    expect(
      tableBar()?.querySelector<HTMLButtonElement>(
        '[aria-label="上方插入行"]',
      )?.disabled,
    ).toBe(true);
    // A body row can still get a row inserted above it, keeping the header on
    // top (`headerRows` is derived from the leading header rows).
    const pos = tablePosition(kernel);
    const firstRow = kernel.editor.state.doc.nodeAt(pos + 1)!;
    kernel.editor.commands.setTextSelection(pos + 1 + firstRow.nodeSize + 4);
    expect(
      tableBar()?.querySelector<HTMLButtonElement>(
        '[aria-label="上方插入行"]',
      )?.disabled,
    ).toBe(false);
    pressAction('add-row-before');
    expect(tableNode(kernel)?.childCount).toBe(3);
    expect(capturedHeaderRows(kernel)).toBe(1);
    expect(tableNode(kernel)?.firstChild?.firstChild?.type.name).toBe(
      'tableHeader',
    );
  });

  it('toggles the first row header even from a body row and keeps the caret', () => {
    const kernel = mount(docWithPlainTable());
    const pos = tablePosition(kernel);
    const firstRow = kernel.editor.state.doc.nodeAt(pos + 1)!;
    kernel.editor.commands.setTextSelection(pos + 1 + firstRow.nodeSize + 4);
    expect(capturedHeaderRows(kernel)).toBe(0);
    pressAction('toggle-header');
    expect(capturedHeaderRows(kernel)).toBe(1);
    expect(tableNode(kernel)?.firstChild?.firstChild?.type.name).toBe(
      'tableHeader',
    );
    // The caret returns to the row it was in (a body row).
    expect(caretInsideTable(kernel)).toBe(true);
    expect(kernel.editor.state.selection.$from.node(1).type.name).toBe('table');
  });

  it('keeps headerRows when a row is added below the header', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    pressAction('add-row-after');
    expect(tableNode(kernel)?.childCount).toBe(3);
    expect(capturedHeaderRows(kernel)).toBe(1);
  });

  it('turns a multi-row header off and back on without losing rows', () => {
    const kernel = mount({
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [
        paragraph('blk_p1', '之前'),
        doubleHeaderTable('blk_t'),
        paragraph('blk_p2', '之后'),
      ],
    });
    caretInFirstCell(kernel);
    expect(capturedHeaderRows(kernel)).toBe(2);
    // The built-in header switch only flips the first row; the remaining header
    // row makes the leading run empty, i.e. `headerRows: 0` while it is off.
    pressAction('toggle-header');
    expect(capturedHeaderRows(kernel)).toBe(0);
    expect(tableNode(kernel)?.firstChild?.firstChild?.type.name).toBe('tableCell');
    expect(tableNode(kernel)?.childCount).toBe(3);
    pressAction('toggle-header');
    expect(capturedHeaderRows(kernel)).toBe(2);
    expect(tableNode(kernel)?.childCount).toBe(3);
  });

  it('toggles the header row and the capture reflects headerRows', () => {
    const kernel = mount(docWithPlainTable());
    caretInFirstCell(kernel);
    expect(capturedHeaderRows(kernel)).toBe(0);
    pressAction('toggle-header');
    expect(capturedHeaderRows(kernel)).toBe(1);
    expect(
      tableBar()
        ?.querySelector('[aria-label="表头开关"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    pressAction('toggle-header');
    expect(capturedHeaderRows(kernel)).toBe(0);
  });

  it('moves the table up and keeps the caret inside it', () => {
    const onUpdate = vi.fn();
    const kernel = mount(docWithTable(), { onUpdate });
    caretInFirstCell(kernel);
    pressAction('move-up');
    expect(pmDocToBlocks(kernel.capture()).value.map((item) => item.type)).toEqual([
      'table',
      'paragraph',
      'paragraph',
    ]);
    expect(caretInsideTable(kernel)).toBe(true);
    // The full toolbar is still the active surface after the move.
    expect(
      tableBar()?.querySelector('[data-table-action="add-row-before"]'),
    ).not.toBeNull();
    expect(onUpdate).toHaveBeenCalled();
    pressAction('move-down');
    expect(pmDocToBlocks(kernel.capture()).value.map((item) => item.type)).toEqual([
      'paragraph',
      'table',
      'paragraph',
    ]);
  });

  it('deletes the table from the full toolbar', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    pressAction('delete-table');
    expect(kernel.editor.view.dom.querySelector('table')).toBeNull();
    expect(tableBar()?.style.display).toBe('none');
  });

  it('hides when the caret leaves the table and the hover bar takes over', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    expect(tableBar()?.style.display).not.toBe('none');
    kernel.editor.commands.setTextSelection(1);
    expect(tableBar()?.style.display).toBe('none');
    hoverTable(kernel);
    expect(tableBar()?.querySelector('[aria-label="选中表格"]')).not.toBeNull();
    expect(
      tableBar()?.querySelector('[data-table-action]'),
      'no full toolbar while the caret is outside a table',
    ).toBeNull();
  });

  it('keeps the caret in the table while the toolbar is pressed', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    tableBar()!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(caretInsideTable(kernel)).toBe(true);
  });

  it('closes from the shared IME closer', () => {
    const kernel = mount(docWithTable());
    caretInFirstCell(kernel);
    closeOverlayBars(kernel.editor);
    expect(tableBar()?.style.display).toBe('none');
  });
});
