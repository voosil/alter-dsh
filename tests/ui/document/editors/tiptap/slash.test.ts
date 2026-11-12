// @vitest-environment jsdom
/**
 * Slash menu parity with the frozen editor.
 *
 * The frozen editor is the reference for every interaction asserted here
 * (`docs/acceptance/editor-experience-p0-p6.md` §2): the trigger, the DOM of the rows, the
 * keyboard flow, the placement algorithm with its fixed side, the IME restore
 * and the image/file commands that really insert an asset.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import {
  SLASH_COMMANDS,
  filterSlashCommands,
} from '../../../../../src/document/editors/slash-commands';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import { KERNEL_CLASS } from '../../../../../src/document/editors/tiptap/classes';
import { ICON_LUCIDE_NAME } from '../../../../../src/document/editors/tiptap/icons';
import { placeSlashMenu } from '../../../../../src/document/editors/tiptap/slash';

// jsdom has no layout engine. ProseMirror's caret measurement needs these
// shims; placement assertions inject their own geometry.
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
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
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

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  document.querySelectorAll(`.${KERNEL_CLASS.slashMenu}`).forEach((node) => node.remove());
  document.querySelectorAll('input[data-slash-file-input]').forEach((node) => node.remove());
  vi.restoreAllMocks();
});

function mount(
  blocks: BlockNode[],
  extra: Partial<Parameters<typeof createKernelEditor>[0]> = {},
) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc: doc(blocks), ...extra });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/** Press one key on the editable body, the way a browser delivers it. */
function pressKey(
  kernel: ReturnType<typeof mount>,
  key: string,
  init: KeyboardEventInit = {},
): boolean {
  return kernel.editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

/** Type text at the caret through ProseMirror's transaction chain. */
function typeAtCaret(kernel: ReturnType<typeof mount>, text: string): void {
  const view = kernel.editor.view;
  view.dispatch(view.state.tr.insertText(text, view.state.selection.from));
}

/** Open the menu on the document's empty paragraph. */
function openMenu(kernel: ReturnType<typeof mount>): HTMLElement {
  pressKey(kernel, '/');
  const menu = document.querySelector<HTMLElement>(`.${KERNEL_CLASS.slashMenu}`);
  if (menu === null) throw new Error('slash menu did not open');
  return menu;
}

function menuItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>(`.${KERNEL_CLASS.slashItem}`)];
}

function activeItem(menu: HTMLElement): HTMLButtonElement | null {
  return menu.querySelector<HTMLButtonElement>('[data-active]');
}

/** Run one filtered command through Enter, like a user typing the query. */
function runCommand(kernel: ReturnType<typeof mount>, query: string): void {
  openMenu(kernel);
  typeAtCaret(kernel, query);
  pressKey(kernel, 'Enter');
}

describe('slash command table', () => {
  it('offers the same commands, in the same order, as the frozen editor', () => {
    expect(SLASH_COMMANDS.map((command) => command.id)).toEqual([
      'text',
      'h1',
      'h2',
      'h3',
      'bullet',
      'ordered',
      'todo',
      'quote',
      'code',
      'divider',
      'table',
      'table-plain',
      'image',
      'file',
    ]);
    expect(SLASH_COMMANDS.map((command) => command.label)).toEqual([
      '正文',
      '标题 1',
      '标题 2',
      '标题 3',
      '无序列表',
      '有序列表',
      '待办',
      '引用',
      '代码块',
      '分割线',
      '表格',
      '表格（无表头）',
      '图片',
      '文件',
    ]);
  });

  it('returns every command for an empty query', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('ranks exact matches before prefixes and substrings', () => {
    const results = filterSlashCommands('h1');
    expect(results[0]?.id).toBe('h1');
  });

  it('matches Chinese labels', () => {
    const results = filterSlashCommands('列表');
    expect(results.map((command) => command.id)).toEqual(
      expect.arrayContaining(['bullet', 'ordered']),
    );
  });

  it('matches a subsequence, like the frozen search', () => {
    const results = filterSlashCommands('tdo');
    expect(results.some((command) => command.id === 'todo')).toBe(true);
  });

  it('offers nothing for a query that matches no candidate', () => {
    expect(filterSlashCommands('zzzzqqq')).toEqual([]);
  });
});

describe('slash menu DOM', () => {
  it('opens as a listbox of option buttons with lucide icons and labels', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const menu = openMenu(kernel);

    expect(menu.parentElement).toBe(document.body);
    expect(menu.getAttribute('role')).toBe('listbox');
    expect(menu.getAttribute('aria-label')).toBe('插入内容');
    const items = menuItems(menu);
    expect(items).toHaveLength(SLASH_COMMANDS.length);
    items.forEach((item, index) => {
      const command = SLASH_COMMANDS[index]!;
      expect(item.getAttribute('role')).toBe('option');
      expect(item.getAttribute('aria-selected')).toBe(String(index === 0));
      expect(item.dataset['commandId']).toBe(command.id);
      const icon = item.querySelector(`.${KERNEL_CLASS.slashIcon}`);
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(icon?.querySelector('svg')).not.toBeNull();
      expect(item.textContent).toBe(command.label);
    });
    // The same lucide shapes as the frozen menu's component imports.
    const h1 = items.find((item) => item.dataset['commandId'] === 'h1')!;
    expect(h1.querySelector('svg')?.getAttribute('class')).toContain(
      `lucide-${ICON_LUCIDE_NAME.heading1}`,
    );
    const image = items.find((item) => item.dataset['commandId'] === 'image')!;
    expect(image.querySelector('svg')?.getAttribute('class')).toContain(
      `lucide-${ICON_LUCIDE_NAME.imagePlus}`,
    );
    const file = items.find((item) => item.dataset['commandId'] === 'file')!;
    expect(file.querySelector('svg')?.getAttribute('class')).toContain(
      `lucide-${ICON_LUCIDE_NAME.paperclip}`,
    );
  });

  it('marks the highlighted row with data-active and aria-selected', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const menu = openMenu(kernel);
    const items = menuItems(menu);
    expect(activeItem(menu)).toBe(items[0]);
    expect(items[0]?.getAttribute('aria-selected')).toBe('true');
    expect(items[1]?.hasAttribute('data-active')).toBe(false);
    expect(items[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('keeps the caret when the menu is pressed', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const menu = openMenu(kernel);
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    menu.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows the frozen empty state for a query without matches', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const menu = openMenu(kernel);
    typeAtCaret(kernel, 'zzzz');
    const empty = menu.querySelector(`.${KERNEL_CLASS.slashEmpty}`);
    expect(empty).not.toBeNull();
    expect(empty?.tagName.toLowerCase()).toBe('p');
    expect(empty?.textContent).toBe('没有匹配的指令');
    expect(menuItems(menu)).toHaveLength(0);
  });
});

describe('slash menu keyboard and pointer flow', () => {
  it('cycles the highlight with ArrowDown/ArrowUp and scrolls it into view', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const menu = openMenu(kernel);
    const items = menuItems(menu);
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');

    expect(pressKey(kernel, 'ArrowDown')).toBe(false);
    expect(activeItem(menu)).toBe(items[1]);
    expect(scrollSpy).toHaveBeenCalled();

    pressKey(kernel, 'ArrowUp');
    expect(activeItem(menu)).toBe(items[0]);

    // ArrowUp from the first row wraps to the last one.
    pressKey(kernel, 'ArrowUp');
    expect(activeItem(menu)).toBe(items.at(-1));
    expect(items.at(-1)?.dataset['commandId']).toBe('file');
  });

  it('moves the highlight when a row is hovered', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const menu = openMenu(kernel);
    const items = menuItems(menu);
    items[3]!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(activeItem(menu)).toBe(items[3]);
  });

  it('closes on Escape without deleting the typed query', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    openMenu(kernel);
    expect(pressKey(kernel, 'Escape')).toBe(false);
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
    expect(kernel.editor.state.doc.textContent).toBe('/');
  });

  it('runs the highlighted command on Enter and removes the query', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    openMenu(kernel);
    typeAtCaret(kernel, 'h1');
    expect(pressKey(kernel, 'Enter')).toBe(false);
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
    const first = kernel.capture().firstChild;
    expect(first?.type.name).toBe('heading');
    expect(first?.attrs['level']).toBe(1);
    expect(kernel.editor.state.doc.textContent).toBe('');
  });

  it('keeps the menu open on Enter when the query matches nothing', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const menu = openMenu(kernel);
    typeAtCaret(kernel, 'zzzz');
    expect(pressKey(kernel, 'Enter')).toBe(false);
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBe(menu);
    expect(menuItems(menu)).toHaveLength(0);
  });

  it('stays pinned to its line while the caret edits another line', () => {
    const kernel = mount([
      block('blk_p1', 'paragraph'),
      block('blk_p2', 'paragraph', {}, {
        content: [{ type: 'text', text: '第二行' }],
      }),
    ]);
    const menu = openMenu(kernel);
    const view = kernel.editor.view;
    // Move the caret to the second line without changing the document.
    const SelectionCtor = view.state.selection.constructor as unknown as {
      create(doc: unknown, from: number, to: number): unknown;
    };
    view.dispatch(
      view.state.tr.setSelection(
        SelectionCtor.create(view.state.doc, view.state.doc.content.size - 1, view.state.doc.content.size - 1) as never,
      ),
    );
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBe(menu);
    // Typing on the other line does not close the menu (frozen behavior).
    typeAtCaret(kernel, 'x');
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBe(menu);
    // Editing the slash line so it no longer starts with `/` closes it.
    view.dispatch(view.state.tr.delete(1, 2));
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
  });

  it('closes when the line no longer starts with `/`', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    openMenu(kernel);
    const view = kernel.editor.view;
    view.dispatch(view.state.tr.delete(1, 2));
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
  });

  it('resets the highlight to the first row when the query changes', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const menu = openMenu(kernel);
    pressKey(kernel, 'ArrowDown');
    expect(activeItem(menu)).toBe(menuItems(menu)[1]);
    typeAtCaret(kernel, 'h');
    expect(activeItem(menu)).toBe(menuItems(menu)[0]);
    expect(menuItems(menu)[0]?.dataset['commandId']).toBe('h1');
  });

  it('runs the clicked command and closes the menu', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const menu = openMenu(kernel);
    const quote = menuItems(menu).find(
      (item) => item.dataset['commandId'] === 'quote',
    )!;
    quote.click();
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
    expect(kernel.capture().firstChild?.type.name).toBe('blockquote');
  });
});

describe('slash menu trigger', () => {
  it('does not open on a line that already has text', () => {
    const kernel = mount([
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '已有文字' }],
      }),
    ]);
    kernel.editor.commands.focus('end');
    pressKey(kernel, '/');
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
    // A transaction that happens to insert the slash must not open it either.
    typeAtCaret(kernel, '/');
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
    expect(kernel.editor.state.doc.textContent).toBe('已有文字/');
  });

  it('does not open for a modified key', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    pressKey(kernel, '/', { metaKey: true });
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
  });

  it('does not open during an IME composition', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const dom = kernel.editor.view.dom;
    dom.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    pressKey(kernel, '/', { isComposing: true });
    typeAtCaret(kernel, '/h');
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
    dom.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
  });

  it('restores the menu after a composition on the same slash line', async () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    const dom = kernel.editor.view.dom;
    const menu = openMenu(kernel);
    const side = menu.dataset['side'];
    dom.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
    typeAtCaret(kernel, 'h');
    dom.dispatchEvent(new Event('compositionend', { bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).not.toBeNull();
    });
    const restored = document.querySelector<HTMLElement>(
      `.${KERNEL_CLASS.slashMenu}`,
    )!;
    // The query comes from the line, and the side is the one the menu had
    // before the composition (direction must not flip while typing).
    const ids = menuItems(restored).map((item) => item.dataset['commandId']);
    expect(ids).toContain('h1');
    expect(ids.length).toBeLessThan(SLASH_COMMANDS.length);
    expect(restored.dataset['side']).toBe(side);
  });
});

describe('placeSlashMenu', () => {
  const base = {
    lineTop: 100,
    lineBottom: 120,
    lineLeft: 50,
    menuWidth: 290,
    menuHeight: 200,
    viewportWidth: 1024,
    viewportHeight: 800,
  };

  it('opens below when it fits under the line', () => {
    expect(placeSlashMenu(base)).toEqual({
      top: 124,
      left: 50,
      side: 'below',
    });
  });

  it('opens above when there is no room below', () => {
    const placement = placeSlashMenu({
      ...base,
      lineTop: 700,
      lineBottom: 720,
    });
    expect(placement.side).toBe('above');
    expect(placement.top).toBe(496);
  });

  it('keeps the preferred side even when the other side would fit', () => {
    const placement = placeSlashMenu({
      ...base,
      lineTop: 400,
      lineBottom: 420,
      preferredSide: 'above',
    });
    expect(placement.side).toBe('above');
    expect(placement.top).toBe(400 - 4 - 200);
  });

  it('clamps the menu to the command line left edge and the 12px margins', () => {
    expect(placeSlashMenu({ ...base, lineLeft: 0 }).left).toBe(12);
    expect(placeSlashMenu({ ...base, lineLeft: 1000 }).left).toBe(722);
  });

  it('falls back to the frozen 290px width when the menu is unmeasured', () => {
    const placement = placeSlashMenu({
      ...base,
      lineLeft: 1000,
      menuWidth: 0,
    });
    expect(placement.left).toBe(722);
  });

  it('clamps the top into the viewport', () => {
    const placement = placeSlashMenu({
      ...base,
      lineTop: 5,
      menuHeight: 100,
      preferredSide: 'above',
    });
    expect(placement.top).toBe(12);
  });
});

describe('slash menu placement in the editor', () => {
  function rect(values: Partial<DOMRect>): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
      ...values,
    } as DOMRect;
  }

  function setViewportHeight(height: number): () => void {
    const original = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: height,
    });
    return () => {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: original,
      });
    };
  }

  it('keeps the side fixed while the query filters, and re-decides after Escape', () => {
    const restoreViewport = setViewportHeight(700);
    try {
      let menuHeight = 200;
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: Element) {
          if (this.classList?.contains(KERNEL_CLASS.slashMenu)) {
            return rect({ width: 290, height: menuHeight });
          }
          return rect({});
        },
      );
      const kernel = mount([block('blk_p', 'paragraph')]);
      const view = kernel.editor.view;
      vi.spyOn(view, 'coordsAtPos').mockReturnValue({
        left: 100,
        right: 100,
        top: 600,
        bottom: 620,
      });

      const menu = openMenu(kernel);
      // Below needs 620 + 4 + 200 = 824 > 688, so the menu opens above.
      expect(menu.dataset['side']).toBe('above');
      expect(menu.style.top).toBe(`${600 - 4 - 200}px`);

      // Filtering shrinks the menu: below would now fit (620 + 4 + 50 = 674),
      // but the direction stays fixed.
      menuHeight = 50;
      typeAtCaret(kernel, 'h');
      expect(menu.dataset['side']).toBe('above');
      expect(menu.style.top).toBe(`${600 - 4 - 50}px`);

      // Escape closes; the next menu is fresh and may flip.
      pressKey(kernel, 'Escape');
      expect(document.querySelector(`.${KERNEL_CLASS.slashMenu}`)).toBeNull();
      view.dispatch(
        view.state.tr.delete(1, view.state.doc.content.size - 1),
      );
      const reopened = openMenu(kernel);
      expect(reopened.dataset['side']).toBe('below');
      expect(reopened.style.top).toBe(`${620 + 4}px`);
    } finally {
      restoreViewport();
    }
  });
});

describe('slash command execution', () => {
  it('turns the line into a title', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    runCommand(kernel, 'h2');
    const first = kernel.capture().firstChild;
    expect(first?.type.name).toBe('heading');
    expect(first?.attrs['level']).toBe(2);
  });

  it('turns the line into a bullet list', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    runCommand(kernel, 'bullet');
    expect(kernel.capture().firstChild?.type.name).toBe('bulletList');
  });

  it('creates a divider followed by an empty paragraph', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    runCommand(kernel, 'divider');
    const captured = kernel.capture();
    expect(captured.childCount).toBe(2);
    expect(captured.firstChild?.type.name).toBe('divider');
    expect(captured.lastChild?.type.name).toBe('paragraph');
  });

  it('creates the frozen 3x3 table with one header row plus a paragraph', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    runCommand(kernel, 'table');
    const captured = kernel.capture();
    expect(captured.childCount).toBe(2);
    const table = captured.firstChild;
    expect(table?.type.name).toBe('table');
    expect(table?.childCount).toBe(3);
    const headerRow = table?.firstChild;
    expect(headerRow?.childCount).toBe(3);
    headerRow?.forEach((cell) => expect(cell.type.name).toBe('tableHeader'));
    table?.lastChild?.forEach((cell) => expect(cell.type.name).toBe('tableCell'));
    expect(captured.lastChild?.type.name).toBe('paragraph');
    // The caret waits in the empty paragraph after the table.
    const selection = kernel.editor.state.selection;
    expect(selection.$from.parent.type.name).toBe('paragraph');
    expect(selection.$from.node(1).type.name).not.toBe('table');
    expect(
      pmDocToBlocks(kernel.capture()).value[0]?.attrs['headerRows'],
    ).toBe(1);
  });

  it('creates a 3x3 table with no header row and a paragraph after it', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    runCommand(kernel, 'table-plain');
    const captured = kernel.capture();
    expect(captured.childCount).toBe(2);
    const table = captured.firstChild;
    expect(table?.type.name).toBe('table');
    expect(table?.childCount).toBe(3);
    table?.forEach((row) => {
      expect(row.childCount).toBe(3);
      row.forEach((cell) => expect(cell.type.name).toBe('tableCell'));
    });
    expect(captured.lastChild?.type.name).toBe('paragraph');
    expect(pmDocToBlocks(kernel.capture()).value[0]?.attrs['headerRows']).toBe(0);
    // The caret waits in the empty paragraph after the table.
    const selection = kernel.editor.state.selection;
    expect(selection.$from.parent.type.name).toBe('paragraph');
    expect(selection.$from.node(1).type.name).not.toBe('table');
  });

  it('creates a task list instead of crashing (no toggleTaskList command)', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    runCommand(kernel, 'todo');
    const list = kernel.capture().firstChild;
    expect(list?.type.name).toBe('taskList');
    expect(list?.childCount).toBe(1);
    expect(['taskItem', 'listItem']).toContain(list?.firstChild?.type.name);
  });
});

describe('slash image/file commands', () => {
  function pickFile(input: HTMLInputElement, file: File): void {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event('change'));
  }

  it('uploads and inserts the picked image, then leaves a paragraph', async () => {
    const importAsset = vi.fn(async () => ({
      assetId: 'asset_image',
      mime: 'image/png',
      bytes: 3,
    }));
    const kernel = mount([block('blk_p', 'paragraph')], { importAsset });
    runCommand(kernel, 'image');
    const input = document.querySelector<HTMLInputElement>(
      'input[data-slash-file-input="image"]',
    );
    expect(input).not.toBeNull();
    pickFile(input!, new File(['abc'], 'photo.png', { type: 'image/png' }));

    await vi.waitFor(() => {
      expect(importAsset).toHaveBeenCalledTimes(1);
      expect(kernel.capture().firstChild?.type.name).toBe('image');
    });
    const image = kernel.capture().firstChild;
    expect(image?.attrs['assetId']).toBe('asset_image');
    expect(image?.attrs['alt']).toBe('photo.png');
    expect(kernel.capture().childCount).toBe(2);
    expect(kernel.capture().lastChild?.type.name).toBe('paragraph');
  });

  it('uploads and inserts the picked file card', async () => {
    const importAsset = vi.fn(async () => ({
      assetId: 'asset_file',
      mime: 'text/plain',
      bytes: 3,
      name: 'notes.txt',
    }));
    const kernel = mount([block('blk_p', 'paragraph')], { importAsset });
    runCommand(kernel, 'file');
    const input = document.querySelector<HTMLInputElement>(
      'input[data-slash-file-input="file"]',
    );
    expect(input).not.toBeNull();
    pickFile(input!, new File(['abc'], 'notes.txt', { type: 'text/plain' }));

    await vi.waitFor(() => {
      expect(kernel.capture().firstChild?.type.name).toBe('file');
    });
    const file = kernel.capture().firstChild;
    expect(file?.attrs['assetId']).toBe('asset_file');
    expect(file?.attrs['name']).toBe('notes.txt');
    expect(file?.attrs['mime']).toBe('text/plain');
    expect(file?.attrs['bytes']).toBe(3);
  });

  it('reports the Host upload error without losing the editor content', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onNotice = vi.fn();
    const hostMessage = '文件超过 8 MiB 上限（8388608 字节，上限 8388608 字节）';
    const importAsset = vi.fn(async () => {
      throw new Error(hostMessage);
    });
    const kernel = mount([block('blk_p', 'paragraph')], {
      importAsset,
      onNotice,
    });
    runCommand(kernel, 'image');
    const input = document.querySelector<HTMLInputElement>(
      'input[data-slash-file-input="image"]',
    )!;
    pickFile(input, new File(['abc'], 'photo.png', { type: 'image/png' }));

    await vi.waitFor(() => {
      // The Host reason wins over the old generic "上传失败，请重试" text.
      expect(onNotice).toHaveBeenCalledWith(hostMessage);
    });
    const captured = kernel.capture();
    expect(captured.childCount).toBe(1);
    expect(captured.firstChild?.type.name).toBe('paragraph');
    expect(captured.textContent).toBe('');
    expect(consoleError).toHaveBeenCalled();
  });

  it('reports the Host message for a rejected file upload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onNotice = vi.fn();
    const importAsset = vi.fn(async () => {
      throw new Error('资产存储未启用');
    });
    const kernel = mount([block('blk_p', 'paragraph')], {
      importAsset,
      onNotice,
    });
    runCommand(kernel, 'file');
    const input = document.querySelector<HTMLInputElement>(
      'input[data-slash-file-input="file"]',
    )!;
    pickFile(input, new File(['abc'], 'notes.pdf', { type: 'application/pdf' }));

    await vi.waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith('资产存储未启用');
    });
    // A rejected upload must not leave a half-inserted file card behind.
    expect(kernel.capture().childCount).toBe(1);
  });

  it('falls back to the generic wording when the error has no message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onNotice = vi.fn();
    const importAsset = vi.fn(async () => {
      throw new Error('');
    });
    const kernel = mount([block('blk_p', 'paragraph')], {
      importAsset,
      onNotice,
    });
    runCommand(kernel, 'file');
    const input = document.querySelector<HTMLInputElement>(
      'input[data-slash-file-input="file"]',
    )!;
    pickFile(input, new File(['abc'], 'notes.pdf', { type: 'application/pdf' }));

    await vi.waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith('附件上传失败，请重试');
    });
  });
});
