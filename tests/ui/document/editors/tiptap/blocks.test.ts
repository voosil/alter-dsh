// @vitest-environment jsdom
/**
 * Frozen block-level DOM for the AST-native kernel.
 *
 * The reference is the legacy loader projection
 * (`src/document/runtime/to-html.ts`): todo rows are a flex `div` with a
 * non-editable checkbox span, cards are the chip/card/anchor shapes the frozen
 * stylesheet targets, tables are bare `<table data-block-id>` elements and
 * images/code blocks expose only the frozen `data-*` hooks. Editing behavior
 * covered here is the part the frozen editor implements by hand per block:
 * checking a todo, Enter/Backspace/ArrowLeft on a todo line, and the capture
 * (todo `checked`, table `headerRows`) that keeps the AST contract intact.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function text(value: string): BlockNode['content'] {
  return [{ type: 'text', text: value }];
}

function doc(blocks: BlockNode[]): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision: 1, blocks };
}

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup) dispose();
  cleanup = [];
});

/** Mount one kernel and return its editable surface. */
function mount(
  blocks: BlockNode[],
  options: { onUpdate?: () => void } = {},
): { surface: HTMLElement; kernel: ReturnType<typeof createKernelEditor> } {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({
    element,
    doc: doc(blocks),
    ...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
  });
  cleanup.push(() => {
    kernel.destroy();
    element.remove();
  });
  return { surface: kernel.editor.view.dom as HTMLElement, kernel };
}

/** Press one key through the editor's binding chain (returns handled). */
function pressKey(
  kernel: ReturnType<typeof createKernelEditor>,
  init: KeyboardEventInit,
): boolean {
  const view = kernel.editor.view;
  return (
    view.someProp('handleKeyDown', (handler) =>
      handler(view, new KeyboardEvent('keydown', { bubbles: true, ...init }) as never),
    ) === true
  );
}

/** Put the caret inside one element's first content position. */
function caretInto(
  kernel: ReturnType<typeof createKernelEditor>,
  element: globalThis.Element,
): void {
  const view = kernel.editor.view;
  const position = view.posAtDOM(element, 0);
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, position),
    ),
  );
}

/** One todo row with its text. */
function todoRow(
  id: string,
  checked: boolean,
  rowId: string,
  value: string,
): BlockNode {
  return block(id, 'taskList', {}, {
    children: [
      block(rowId, 'listItem', { checked }, {
        children: [block(`${rowId}_p`, 'paragraph', {}, { content: text(value) })],
      }),
    ],
  });
}

describe('todo rows use the frozen flat DOM', () => {
  it('renders one row per item with the non-editable checkbox span', () => {
    const { surface } = mount([todoRow('blk_t', true, 'blk_ti', '做事')]);
    const row = surface.querySelector('[data-todo]')!;
    expect(row.tagName).toBe('DIV');
    expect(row.getAttribute('data-block-id')).toBe('blk_ti');
    expect(row.getAttribute('data-checked')).toBe('true');
    const box = row.querySelector('[data-todo-box]')!;
    expect(box.tagName).toBe('SPAN');
    expect(box.getAttribute('contenteditable')).toBe('false');
    expect(box.getAttribute('role')).toBe('checkbox');
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.getAttribute('aria-label')).toBe('待办事项');
    expect(box.getAttribute('tabindex')).toBe('0');
    const label = row.querySelector('[data-todo-text]')!;
    expect(label.textContent).toBe('做事');
    // The frozen stylesheet uses the row attribute for the checked visuals.
    expect(surface.querySelector('input[type="checkbox"]')).toBeNull();
    expect(surface.querySelector('ul')).toBeNull();
    expect(surface.querySelector('li')).toBeNull();
  });

  it('toggles checked from the box click and saves through onChange', () => {
    const onUpdate = vi.fn();
    const { surface, kernel } = mount([todoRow('blk_t', false, 'blk_ti', '做事')], {
      onUpdate,
    });
    const box = surface.querySelector('[data-todo-box]') as HTMLElement;
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const row = surface.querySelector('[data-todo]')!;
    expect(row.getAttribute('data-checked')).toBe('true');
    expect(box.getAttribute('aria-checked')).toBe('true');
    const captured = pmDocToBlocks(kernel.capture()).value;
    const item = captured[0]!.children![0]!;
    expect(item.type).toBe('listItem');
    expect(item.attrs).toEqual({ checked: true });
  });

  it('toggles checked with Space/Enter while the box has focus', () => {
    const { surface, kernel } = mount([todoRow('blk_t', false, 'blk_ti', '做事')]);
    const box = surface.querySelector('[data-todo-box]') as HTMLElement;
    box.focus();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(surface.querySelector('[data-todo]')!.getAttribute('data-checked')).toBe('true');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(surface.querySelector('[data-todo]')!.getAttribute('data-checked')).toBe('false');
    expect(pmDocToBlocks(kernel.capture()).value[0]!.children![0]!.attrs).toEqual({
      checked: false,
    });
  });
});

describe('todo line keyboard behavior', () => {
  it('Enter on a row with text continues with a new todo row', () => {
    const { surface, kernel } = mount([todoRow('blk_t', false, 'blk_ti', '做事')]);
    caretInto(kernel, surface.querySelector('[data-todo-text] p')!);
    expect(pressKey(kernel, { key: 'Enter' })).toBe(true);
    const rows = surface.querySelectorAll('[data-todo]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toBe('做事');
    const captured = pmDocToBlocks(kernel.capture()).value;
    const items = captured[0]!.children!;
    expect(items).toHaveLength(2);
    expect(items[1]!.attrs).toEqual({ checked: false });
    // The caret moved into the new row's text.
    expect(kernel.editor.view.state.selection.$from.parent.textContent).toBe('');
  });

  it('Enter on an empty row turns the line back into a paragraph', () => {
    const { surface, kernel } = mount([
      block('blk_p', 'paragraph', {}, { content: text('上') }),
      todoRow('blk_t', false, 'blk_ti', ''),
    ]);
    caretInto(kernel, surface.querySelector('[data-todo-text] p')!);
    expect(pressKey(kernel, { key: 'Enter' })).toBe(true);
    expect(surface.querySelector('[data-todo]')).toBeNull();
    const captured = pmDocToBlocks(kernel.capture()).value;
    expect(captured.map((item) => item.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('Backspace on an empty row removes only the checkbox, then jumps up on the second press', () => {
    const { surface, kernel } = mount([
      block('blk_p', 'paragraph', {}, { content: text('上一行') }),
      todoRow('blk_t', false, 'blk_ti', ''),
    ]);
    caretInto(kernel, surface.querySelector('[data-todo-text] p')!);
    // First Backspace: the row becomes an empty paragraph in place; the caret
    // stays on this line (product 2026-11-12, two-step deletion).
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    expect(surface.querySelector('[data-todo]')).toBeNull();
    const captured = pmDocToBlocks(kernel.capture()).value;
    expect(captured.map((item) => item.type)).toEqual(['paragraph', 'paragraph']);
    const afterFirst = kernel.editor.view.state.selection.$from;
    expect(afterFirst.parent.type.name).toBe('paragraph');
    expect(afterFirst.parent.content.size).toBe(0);
    // The retired paragraph keeps the row's block id.
    expect(captured[1]?.id).toBe('blk_ti');
    // Second Backspace: back to the previous line's end (default merge).
    expect(pressKey(kernel, { key: 'Backspace' })).toBe(true);
    expect(kernel.editor.view.state.selection.from).toBe(
      '上一行'.length + 1,
    );
  });

  it('ArrowLeft at the row start jumps to the previous line', () => {
    const { surface, kernel } = mount([
      block('blk_p', 'paragraph', {}, { content: text('上一行') }),
      todoRow('blk_t', false, 'blk_ti', '待办'),
    ]);
    caretInto(kernel, surface.querySelector('[data-todo-text] p')!);
    expect(pressKey(kernel, { key: 'ArrowLeft' })).toBe(true);
    expect(kernel.editor.view.state.selection.from).toBe('上一行'.length + 1);
  });
});

describe('the 文本类型 conversion owns the todo node', () => {
  it('converts a paragraph into a one-row todo and back', () => {
    const { surface, kernel } = mount([
      block('blk_p', 'paragraph', {}, { content: text('正文') }),
    ]);
    caretInto(kernel, surface.querySelector('p')!);
    kernel.applyBlockType('todo');
    const row = surface.querySelector('[data-todo]')!;
    expect(row.getAttribute('data-checked')).toBe('false');
    expect(row.querySelector('[data-todo-text]')!.textContent).toBe('正文');
    const todoBlocks = pmDocToBlocks(kernel.capture()).value;
    expect(todoBlocks.map((item) => item.type)).toEqual(['taskList']);

    caretInto(kernel, surface.querySelector('[data-todo-text] p')!);
    kernel.applyBlockType('p');
    expect(surface.querySelector('[data-todo]')).toBeNull();
    expect(pmDocToBlocks(kernel.capture()).value.map((item) => item.type)).toEqual([
      'paragraph',
    ]);
  });
});

describe('cards use the frozen chip/card DOM', () => {
  const cards = (): BlockNode[] => [
    block('blk_f', 'file', {
      assetId: 'asset_f',
      name: 'a.pdf',
      mime: 'application/pdf',
      bytes: 2048,
    }),
    block('blk_bm', 'bookmark', {
      url: 'https://example.com/guide',
      title: '指南',
      description: '外部网页',
    }),
    block('blk_dl', 'docLink', { docId: 'doc_2', title: '另一篇' }),
    block('blk_mm', 'mindmap', { objectId: 'obj_1', caption: '脑图' }),
    block('blk_cp', 'component', { objectId: 'obj_2', title: '进度' }),
  ];

  it('renders the file chip with the legacy icon and size label', () => {
    const { surface } = mount(cards());
    const file = surface.querySelector('[data-file]') as HTMLElement;
    expect(file.tagName).toBe('SPAN');
    expect(file.getAttribute('data-block-id')).toBe('blk_f');
    expect(file.getAttribute('data-asset-id')).toBe('asset_f');
    expect(file.getAttribute('data-name')).toBe('a.pdf');
    expect(file.getAttribute('data-mime')).toBe('application/pdf');
    expect(file.getAttribute('data-bytes')).toBe('2048');
    expect(file.getAttribute('data-href')).toBeTruthy();
    expect(file.getAttribute('contenteditable')).toBe('false');
    expect(file.getAttribute('tabindex')).toBe('0');
    const icon = file.querySelector('[data-file-icon]')!;
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(icon.querySelector('svg path')).not.toBeNull();
    expect(file.textContent).toBe('a.pdf · 2.0 KB');
    // The raw asset attribute name must never reach the DOM.
    expect(file.getAttribute('assetid')).toBeNull();
    expect(file.getAttribute('assetId')).toBeNull();
  });

  it('renders the bookmark card as a focusable anchor with strong + span', () => {
    const { surface } = mount(cards());
    const card = surface.querySelector('[data-link-card]') as HTMLElement;
    expect(card.tagName).toBe('A');
    expect(card.getAttribute('data-block-id')).toBe('blk_bm');
    expect(card.getAttribute('data-href')).toBe('https://example.com/guide');
    expect(card.getAttribute('href')).toBe('https://example.com/guide');
    expect(card.children).toHaveLength(2);
    expect(card.children[0]!.tagName).toBe('STRONG');
    expect(card.children[0]!.textContent).toBe('指南');
    expect(card.children[1]!.tagName).toBe('SPAN');
    expect(card.children[1]!.textContent).toBe('外部网页');
    expect(card.getAttribute('tabindex')).toBe('0');
  });

  it('renders the doc link with the icon-in-a-space structure', () => {
    const { surface } = mount(cards());
    const link = surface.querySelector('[data-doc-link]') as HTMLElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('data-doc-id')).toBe('doc_2');
    expect(link.getAttribute('data-block-id')).toBe('blk_dl');
    expect(link.getAttribute('href')).toContain('doc_2');
    const icon = link.querySelector('[data-doc-icon]')!;
    expect(icon.getAttribute('contenteditable')).toBe('false');
    expect(icon.querySelector('svg path')).not.toBeNull();
    expect(link.textContent).toBe('另一篇');
  });

  it('renders object placeholders with visible frozen text', () => {
    const { surface } = mount(cards());
    const mindmap = surface.querySelector('[data-object-card][data-kind="mindmap"]')!;
    expect(mindmap.getAttribute('data-block-id')).toBe('blk_mm');
    expect(mindmap.getAttribute('data-object-id')).toBe('obj_1');
    expect(mindmap.getAttribute('contenteditable')).toBe('false');
    expect(mindmap.textContent).toBe('[思维导图] 脑图');
    const component = surface.querySelector(
      '[data-object-card][data-kind="component"]',
    )!;
    expect(component.textContent).toBe('[交互组件] 进度');
  });

  it('opens a focused card with Enter through the page callback', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const onOpenWeb = vi.fn();
    const onOpenDoc = vi.fn();
    const kernel = createKernelEditor({
      element,
      doc: doc(cards()),
      onOpenWeb,
      onOpenDoc,
    });
    cleanup.push(() => {
      kernel.destroy();
      element.remove();
    });
    const bookmark = element.querySelector('[data-link-card]') as HTMLElement;
    bookmark.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onOpenWeb).toHaveBeenCalledWith('https://example.com/guide');
    const docLink = element.querySelector('[data-doc-link]') as HTMLElement;
    docLink.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onOpenDoc).toHaveBeenCalledWith('doc_2');
  });
});

describe('atom blocks expose the frozen attributes only', () => {
  it('renders an image with data-* attributes and no raw asset name', () => {
    const { surface } = mount([
      block('blk_img', 'image', {
        assetId: 'asset_i',
        alt: '架构图',
        caption: '图 1',
        width: '320',
      }),
    ]);
    const image = surface.querySelector('img')!;
    expect(image.getAttribute('data-block-id')).toBe('blk_img');
    expect(image.getAttribute('data-asset-id')).toBe('asset_i');
    expect(image.getAttribute('src')).toBeTruthy();
    expect(image.getAttribute('alt')).toBe('架构图');
    expect(image.getAttribute('title')).toBe('图 1');
    expect(image.getAttribute('width')).toBe('320');
    expect(image.getAttribute('assetid')).toBeNull();
  });

  it('renders a code block with data-lang, not a raw lang attribute', () => {
    const { surface } = mount([
      block('blk_code', 'codeBlock', { lang: 'ts' }, {
        content: [{ type: 'text', text: 'const a = 1;' }],
      }),
    ]);
    const pre = surface.querySelector('pre')!;
    expect(pre.getAttribute('data-block-id')).toBe('blk_code');
    expect(pre.getAttribute('data-lang')).toBe('ts');
    expect(pre.getAttribute('lang')).toBeNull();
    expect(pre.querySelector('code')!.textContent).toBe('const a = 1;');
  });

  it('renders a divider as the selectable wrapper around hr', () => {
    const { surface } = mount([block('blk_hr', 'divider')]);
    const divider = surface.querySelector('[data-divider]')!;
    expect(divider.getAttribute('data-block-id')).toBe('blk_hr');
    expect(divider.getAttribute('contenteditable')).toBe('false');
    expect(divider.querySelector('hr')).not.toBeNull();
  });

  it('renders a callout as a neutral object card around its blocks', () => {
    const { surface } = mount([
      block('blk_co', 'callout', { tone: 'warn', title: '注意' }, {
        children: [
          block('blk_cop', 'paragraph', {}, { content: text('提示正文') }),
        ],
      }),
    ]);
    const callout = surface.querySelector('[data-object-card][data-kind="callout"]')!;
    expect(callout.getAttribute('data-block-id')).toBe('blk_co');
    expect(callout.getAttribute('data-tone')).toBe('warn');
    expect(callout.querySelector('p')!.textContent).toBe('提示正文');
  });
});

describe('tables render bare tables with header cells', () => {
  const table = (headerRows: number): BlockNode =>
    block('blk_table', 'table', { headerRows }, {
      children: [
        block('blk_row1', 'tableRow', {}, {
          children: [
            block('blk_c11', 'tableCell', {}, { content: text('表头') }),
            block('blk_c12', 'tableCell', {}, { content: text('表头二') }),
          ],
        }),
        block('blk_row2', 'tableRow', {}, {
          children: [
            block('blk_c21', 'tableCell', {}, { content: text('数据') }),
            block('blk_c22', 'tableCell', {}, { content: text('数据二') }),
          ],
        }),
      ],
    });

  it('renders the table directly under the surface, with th header cells', () => {
    const { surface } = mount([table(1)]);
    expect(surface.querySelector('.tableWrapper')).toBeNull();
    const element = surface.querySelector('table')!;
    expect(element.parentElement).toBe(surface);
    expect(element.getAttribute('data-block-id')).toBe('blk_table');
    const headRow = element.querySelectorAll('tr')[0]!;
    expect(headRow.querySelectorAll('th')).toHaveLength(2);
    expect(headRow.querySelector('th')!.getAttribute('data-block-id')).toBe('blk_c11');
    const bodyRow = element.querySelectorAll('tr')[1]!;
    expect(bodyRow.querySelectorAll('td')).toHaveLength(2);
    // Cell content is a block, normalized by the kernel stylesheet.
    expect(element.querySelector('th p')!.textContent).toBe('表头');
  });

  it('derives headerRows from the header row count on capture', () => {
    const withHeader = mount([table(2)]);
    expect(
      withHeader.surface.querySelectorAll('tr')[1]!.querySelectorAll('th'),
    ).toHaveLength(2);
    expect(pmDocToBlocks(withHeader.kernel.capture()).value).toEqual([table(2)]);

    const withoutHeader = mount([table(0)]);
    expect(
      withoutHeader.surface.querySelector('tr')!.querySelectorAll('th'),
    ).toHaveLength(0);
    expect(pmDocToBlocks(withoutHeader.kernel.capture()).value).toEqual([
      table(0),
    ]);
  });
});

describe('merged cells persist through capture and reload', () => {
  /** One 2×2 table; the first row is a header row unless `headerRows` is 0. */
  const grid = (headerRows = 1): BlockNode[] => [
    block('blk_table', 'table', { headerRows }, {
      children: [
        block('blk_row1', 'tableRow', {}, {
          children: [
            block('blk_c11', 'tableCell', {}, { content: text('A') }),
            block('blk_c12', 'tableCell', {}, { content: text('B') }),
          ],
        }),
        block('blk_row2', 'tableRow', {}, {
          children: [
            block('blk_c21', 'tableCell', {}, { content: text('C') }),
            block('blk_c22', 'tableCell', {}, { content: text('D') }),
          ],
        }),
      ],
    }),
  ];

  /** Absolute document position of the table cell whose text is `label`. */
  function cellPosition(
    kernel: ReturnType<typeof createKernelEditor>,
    surface: HTMLElement,
    label: string,
  ): number {
    const cell = [...surface.querySelectorAll('th, td')].find(
      (element) => element.textContent === label,
    );
    if (cell === null || cell === undefined)
      throw new Error(`no cell for ${label}`);
    const view = kernel.editor.view;
    const inside = view.posAtDOM(cell.querySelector('p') ?? cell, 0);
    const $inside = view.state.doc.resolve(inside);
    for (let depth = $inside.depth; depth > 0; depth -= 1) {
      const name = $inside.node(depth).type.name;
      if (name === 'tableCell' || name === 'tableHeader') {
        return $inside.before(depth);
      }
    }
    throw new Error(`no cell for ${label}`);
  }

  it('merges a 2×2 range, captures spans and reloads still merged', () => {
    const { surface, kernel } = mount(grid());
    const view = kernel.editor.view;
    const anchorCell = view.state.doc.resolve(
      cellPosition(kernel, surface, 'A'),
    );
    const headCell = view.state.doc.resolve(
      cellPosition(kernel, surface, 'D'),
    );
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchorCell, headCell)));
    expect(kernel.editor.commands.mergeCells()).toBe(true);

    const captured = pmDocToBlocks(kernel.capture());
    expect(captured.warnings).toEqual([]);
    const table = captured.value[0]!;
    expect(table.type).toBe('table');
    expect(table.attrs['headerRows']).toBe(1);
    const merged = table.children![0]!.children![0]!;
    expect(merged.type).toBe('tableCell');
    expect(merged.attrs).toEqual({ colspan: 2, rowspan: 2 });
    // The covered row keeps no cells of its own (ProseMirror's merge model).
    expect(table.children![1]!.children ?? []).toEqual([]);

    // The live DOM carries the span attributes the frozen stylesheet needs.
    const mergedCell = surface.querySelector('th[colspan="2"]');
    expect(mergedCell).not.toBeNull();
    expect(mergedCell!.getAttribute('rowspan')).toBe('2');
    expect(mergedCell!.textContent).toContain('A');

    // Reloading the captured AST restores the merge; a second capture is stable.
    const reloaded = mount(captured.value);
    const header = reloaded.surface.querySelector('th');
    expect(header).not.toBeNull();
    expect(header!.getAttribute('colspan')).toBe('2');
    expect(header!.getAttribute('rowspan')).toBe('2');
    expect(pmDocToBlocks(reloaded.kernel.capture()).value).toEqual(
      captured.value,
    );
  });

  it('keeps plain cells free of span attributes', () => {
    const { surface, kernel } = mount(grid());
    for (const cell of surface.querySelectorAll('th, td')) {
      expect(cell.getAttribute('colspan')).toBeNull();
      expect(cell.getAttribute('rowspan')).toBeNull();
    }
    const captured = pmDocToBlocks(kernel.capture()).value[0]!;
    for (const row of captured.children ?? []) {
      for (const cell of row.children ?? []) {
        expect(cell.attrs).toEqual({});
      }
    }
  });

  it('splits a merged cell back into plain cells without losing the grid', () => {
    const { surface, kernel } = mount(grid(0));
    const view = kernel.editor.view;
    view.dispatch(
      view.state.tr.setSelection(
        new CellSelection(
          view.state.doc.resolve(cellPosition(kernel, surface, 'A')),
          view.state.doc.resolve(cellPosition(kernel, surface, 'D')),
        ),
      ),
    );
    expect(kernel.editor.commands.mergeCells()).toBe(true);
    const merged = pmDocToBlocks(kernel.capture()).value;
    const reloaded = mount(merged);

    // Put the caret inside the merged cell and split it again.
    const reloadedView = reloaded.kernel.editor.view;
    const mergedCell = reloaded.surface.querySelector('td')!;
    const inside = reloadedView.posAtDOM(mergedCell.querySelector('p')!, 0);
    reloadedView.dispatch(
      reloadedView.state.tr.setSelection(
        TextSelection.create(reloadedView.state.doc, inside),
      ),
    );
    expect(reloaded.kernel.editor.commands.splitCell()).toBe(true);

    const split = pmDocToBlocks(reloaded.kernel.capture());
    expect(split.warnings).toEqual([]);
    const table = split.value[0]!;
    expect(table.attrs['headerRows']).toBe(0);
    const cells = (table.children ?? []).flatMap((row) => row.children ?? []);
    expect(cells).toHaveLength(4);
    for (const cell of cells) expect(cell.attrs).toEqual({});
    // The split survives one more reload as plain cells.
    const again = mount(split.value);
    expect(again.surface.querySelectorAll('td')).toHaveLength(4);
    expect(again.surface.querySelector('td[colspan]')).toBeNull();
  });
});

describe('capture round-trips every frozen block shape', () => {
  it('returns the same AST the kernel was loaded from', () => {
    const blocks: BlockNode[] = [
      block('blk_p', 'paragraph', {}, {
        content: [
          { type: 'text', text: '正文 ' },
          {
            type: 'text',
            text: '链接',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          },
        ],
      }),
      todoRow('blk_t', true, 'blk_ti', '已完成'),
      block('blk_table', 'table', { headerRows: 1 }, {
        children: [
          block('blk_row1', 'tableRow', {}, {
            children: [
              block('blk_c11', 'tableCell', {}, { content: text('头') }),
            ],
          }),
          block('blk_row2', 'tableRow', {}, {
            children: [
              block('blk_c21', 'tableCell', {}, { content: text('体') }),
            ],
          }),
        ],
      }),
      block('blk_img', 'image', { assetId: 'asset_i', alt: '图' }),
      block('blk_file', 'file', {
        assetId: 'asset_f',
        name: 'a.pdf',
        mime: 'application/pdf',
        bytes: 10,
      }),
      block('blk_bm', 'bookmark', { url: 'https://example.com', title: '站' }),
      block('blk_dl', 'docLink', { docId: 'doc_9', title: '文档' }),
      block('blk_hr', 'divider'),
      block('blk_code', 'codeBlock', { lang: 'ts' }, {
        content: [{ type: 'text', text: 'const a = 1;' }],
      }),
    ];
    const { kernel } = mount(blocks);
    const captured = pmDocToBlocks(kernel.capture());
    expect(captured.warnings).toEqual([]);
    expect(captured.value).toEqual(blocks);
    // The inline link renders the frozen `data-web-link` hook for the link bar.
    const anchor = kernel.editor.view.dom.querySelector('a[href]')!;
    expect(anchor.getAttribute('data-web-link')).toBe('');
  });
});
