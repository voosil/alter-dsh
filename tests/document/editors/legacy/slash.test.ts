// @vitest-environment jsdom
/**
 * Legacy editor slash commands (editor optimization items 4/8/10).
 *
 * Locks three behaviors of the restored pre-rebuild contentEditable editor:
 * fuzzy command matching, IME composition recovery of the command menu and
 * measured menu placement (the menu hugs its command line and re-places after
 * the filtered height changes). 第 12 项 additionally requires the side the menu
 * first appeared on to stay fixed while the query filters it (including across
 * an IME composition that closes and restores the menu), so filtering a taller
 * menu never makes it jump above/below the command line. The editor DOM/CSS is
 * frozen; these tests assert behavior and geometry numbers, not markup
 * structure.
 *
 * jsdom has no layout engine, so menu/line rectangles are stubbed through
 * `getBoundingClientRect`. The geometry assertions cover both flip paths
 * (below vs above) and the re-placement after filtering.
 */
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '../../../../vendor/ui-space/src/components/editor/Editor';
import { placeSlashMenu } from '../../../../vendor/ui-space/src/components/editor/editor-utils';

// ---------------------------------------------------------------------------
// jsdom stubs (no layout engine)
// ---------------------------------------------------------------------------

function makeRect(values: Partial<DOMRect> = {}): DOMRect {
  const top = values.top ?? 0;
  const left = values.left ?? 0;
  const width = values.width ?? 0;
  const height = values.height ?? 0;
  return {
    x: left,
    y: top,
    top,
    left,
    right: values.right ?? left + width,
    bottom: values.bottom ?? top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}
if (typeof Element.prototype.getBoundingClientRect !== 'function') {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return makeRect();
  };
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = function scrollIntoView() {
    // jsdom has no scrolling.
  };
}

type ExecCommand = (command: string, ui?: boolean, value?: string) => boolean;

function deleteExecCommand(): void {
  delete (document as unknown as { execCommand?: ExecCommand }).execCommand;
}

function stubExecCommand(result = true): void {
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: vi.fn(() => result) as unknown as ExecCommand,
  });
}

beforeEach(() => {
  // "/" is inserted through execCommand; jsdom has no editing pipeline.
  stubExecCommand(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  deleteExecCommand();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type EditorOverrides = Record<string, unknown>;

function renderEditor(overrides: EditorOverrides = {}) {
  const props = {
    docId: 'doc-1',
    initialHtml: '<p><br></p>',
    externalRevision: 1,
    findDoc: () => undefined,
    onOpenDoc: vi.fn(),
    onOpenWeb: vi.fn(),
    onChange: vi.fn(),
    onComment: vi.fn(),
    comments: [],
    ...overrides,
  };
  render(createElement(Editor, props as never));
  return props;
}

function surface(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="文档正文"]',
  );
  if (element === null) throw new Error('editor surface is missing');
  return element;
}

function caretAt(node: Node, offset = 0): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  if (selection === null) throw new Error('no selection');
  selection.removeAllRanges();
  selection.addRange(range);
}

function slashMenu(): HTMLElement | null {
  return screen.queryByRole('listbox', { name: '插入内容' });
}

function optionLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => (option.textContent ?? '').trim(),
  );
}

/** Type "/" on an empty line and open the command menu. */
function openSlash(): HTMLElement {
  const editor = surface();
  caretAt(editor.querySelector('p')!, 0);
  fireEvent.keyDown(editor, { key: '/' });
  return editor;
}

/** Simulate the browser having written `text` into the command line. */
function typeIntoLine(editor: HTMLElement, text: string): void {
  const line = editor.querySelector<HTMLElement>('p')!;
  line.textContent = text;
  caretAt(line.firstChild ?? line, line.firstChild ? text.length : 0);
  fireEvent.input(editor);
}

const FULL_MENU = [
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
  '图片',
  '文件',
];

// ---------------------------------------------------------------------------
// Item 4: fuzzy command matching
// ---------------------------------------------------------------------------

describe('item 4 fuzzy slash matching', () => {
  it('keeps the original order for an empty query', () => {
    renderEditor();
    openSlash();
    expect(slashMenu()).toBeTruthy();
    expect(optionLabels()).toEqual(FULL_MENU);
  });

  it('matches the incomplete query /tdo to 待办', () => {
    renderEditor();
    const editor = openSlash();
    typeIntoLine(editor, '/tdo');
    expect(optionLabels()).toEqual(['待办']);
  });

  it('matches an incomplete ASCII keyword by subsequence', () => {
    renderEditor();
    const editor = openSlash();
    typeIntoLine(editor, '/chkbx');
    expect(optionLabels()).toEqual(['待办']);
  });

  it('keeps matching commands in their original stable order', () => {
    renderEditor();
    const editor = openSlash();
    typeIntoLine(editor, '/标题');
    expect(optionLabels()).toEqual(['标题 1', '标题 2', '标题 3']);
  });

  it('reports an empty result for a query nothing matches', () => {
    renderEditor();
    const editor = openSlash();
    typeIntoLine(editor, '/zzzzzz');
    expect(slashMenu()).toBeTruthy();
    expect(optionLabels()).toEqual([]);
    expect(document.body.textContent).toContain('没有匹配的指令');
  });
});

// ---------------------------------------------------------------------------
// Item 8: IME composition
// ---------------------------------------------------------------------------

describe('item 8 slash menu across IME composition', () => {
  it('restores the filtered menu after the IME commits todo', async () => {
    stubExecCommand(true);
    renderEditor();
    const editor = openSlash();
    expect(slashMenu()).toBeTruthy();

    fireEvent.compositionStart(editor);
    expect(slashMenu()).toBeNull();

    // Half-composed text: no keydown, no menu.
    const line = editor.querySelector<HTMLElement>('p')!;
    line.textContent = '/todo';
    caretAt(line.firstChild!, 5);
    fireEvent.input(editor);
    expect(slashMenu()).toBeNull();

    fireEvent.compositionEnd(editor);
    await waitFor(() => expect(slashMenu()).toBeTruthy());
    expect(optionLabels()).toEqual(['待办']);
  });

  it('keeps the menu responsive to a trailing query change', async () => {
    stubExecCommand(true);
    renderEditor();
    const editor = openSlash();

    fireEvent.compositionStart(editor);
    const line = editor.querySelector<HTMLElement>('p')!;
    line.textContent = '/todo';
    caretAt(line.firstChild!, 5);
    fireEvent.input(editor);
    fireEvent.compositionEnd(editor);
    await waitFor(() => expect(optionLabels()).toEqual(['待办']));

    // A trailing space must refresh the query, not close the menu.
    typeIntoLine(editor, '/todo ');
    await waitFor(() => expect(optionLabels()).toEqual(['待办']));
    expect(slashMenu()).toBeTruthy();
  });

  it('executes the active command on Enter after composition ends', async () => {
    stubExecCommand(true);
    const props = renderEditor();
    const editor = openSlash();

    fireEvent.compositionStart(editor);
    const line = editor.querySelector<HTMLElement>('p')!;
    line.textContent = '/todo';
    caretAt(line.firstChild!, 5);
    fireEvent.input(editor);
    fireEvent.compositionEnd(editor);
    await waitFor(() => expect(optionLabels()).toEqual(['待办']));

    const notPrevented = fireEvent.keyDown(editor, { key: 'Enter' });
    expect(notPrevented).toBe(false);
    await waitFor(() =>
      expect(surface().querySelector('[data-todo]')).toBeTruthy(),
    );
    expect(surface().querySelector('p')).toBeNull();
    expect(slashMenu()).toBeNull();
    expect(props.onChange).toHaveBeenCalled();
  });

  it('never opens or executes the menu while composing', () => {
    stubExecCommand(true);
    renderEditor();
    const editor = openSlash();

    fireEvent.compositionStart(editor);
    const line = editor.querySelector<HTMLElement>('p')!;
    line.textContent = '/todo';
    caretAt(line.firstChild!, 5);
    fireEvent.input(editor);

    // IME owns Enter: no preventDefault, no command executed.
    const notPrevented = fireEvent.keyDown(editor, { key: 'Enter' });
    expect(notPrevented).toBe(true);
    expect(surface().querySelector('[data-todo]')).toBeNull();
    expect(slashMenu()).toBeNull();
  });

  it('does not reopen the menu when composition removes the slash', async () => {
    stubExecCommand(true);
    renderEditor();
    const editor = openSlash();

    fireEvent.compositionStart(editor);
    const line = editor.querySelector<HTMLElement>('p')!;
    line.textContent = '待办';
    caretAt(line.firstChild!, 2);
    fireEvent.input(editor);
    fireEvent.compositionEnd(editor);

    await waitFor(() => expect(surface().textContent).toBe('待办'));
    expect(slashMenu()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 10: measured slash menu placement
// ---------------------------------------------------------------------------

type Geometry = {
  lineRect: () => DOMRect;
  menuHeight: (optionCount: number) => number;
};

function installGeometry(geometry: Geometry): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: Element,
  ) {
    if (this.getAttribute('role') === 'listbox') {
      const count = this.querySelectorAll('[role="option"]').length;
      const height = geometry.menuHeight(count);
      return makeRect({ width: 290, height });
    }
    return geometry.lineRect();
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** CSS box model of `.slashMenu`: 5px padding each side + 1px border. */
function menuHeight(optionCount: number): number {
  return optionCount === 0 ? 62 : optionCount * 32 + 12;
}

describe('item 10 measured slash menu placement', () => {
  it('hugs the command line below when there is room', async () => {
    const restore = installGeometry({
      lineRect: () =>
        makeRect({ top: 300, bottom: 320, left: 40, width: 600, height: 20 }),
      menuHeight,
    });
    try {
      renderEditor();
      openSlash();
      await waitFor(() => expect(slashMenu()).toBeTruthy());
      const menu = slashMenu()!;
      await waitFor(() => expect(parseFloat(menu.style.top)).toBe(324));
      expect(parseFloat(menu.style.left)).toBe(40);
    } finally {
      restore();
    }
  });

  it('flips above a line near the viewport bottom and re-places after filtering', async () => {
    const restore = installGeometry({
      lineRect: () =>
        makeRect({ top: 650, bottom: 670, left: 40, width: 600, height: 20 }),
      menuHeight,
    });
    try {
      renderEditor();
      const editor = openSlash();
      await waitFor(() => expect(slashMenu()).toBeTruthy());
      const menu = slashMenu()!;

      // 13 items (~428px) do not fit below: flip above with a 4px gap.
      await waitFor(() => expect(parseFloat(menu.style.top)).toBe(218));
      expect(parseFloat(menu.style.top) + menuHeight(13)).toBeLessThanOrEqual(
        650,
      );

      // Filtering down to one item must re-measure and hug the line again.
      typeIntoLine(editor, '/tdo');
      await waitFor(() => expect(optionLabels()).toEqual(['待办']));
      await waitFor(() => expect(parseFloat(menu.style.top)).toBe(602));
      // Still anchored above: a naive re-measure would flip it to 674 (below).
      expect(parseFloat(menu.style.top) + menuHeight(1)).toBeLessThanOrEqual(
        650 - 4,
      );
    } finally {
      restore();
    }
  });

  it('keeps the below placement while the filtered menu shrinks', async () => {
    const restore = installGeometry({
      lineRect: () =>
        makeRect({ top: 300, bottom: 320, left: 40, width: 600, height: 20 }),
      menuHeight,
    });
    try {
      renderEditor();
      const editor = openSlash();
      await waitFor(() => expect(slashMenu()).toBeTruthy());
      const menu = slashMenu()!;
      await waitFor(() => expect(parseFloat(menu.style.top)).toBe(324));

      typeIntoLine(editor, '/tdo');
      await waitFor(() => expect(optionLabels()).toEqual(['待办']));
      // The shorter menu keeps the same anchor: top follows the line, not the
      // viewport bottom.
      await waitFor(() => expect(parseFloat(menu.style.top)).toBe(324));
      expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(320 + 4);
    } finally {
      restore();
    }
  });

  it('keeps the side when the query clears back to the full list', async () => {
    const restore = installGeometry({
      lineRect: () =>
        makeRect({ top: 650, bottom: 670, left: 40, width: 600, height: 20 }),
      menuHeight,
    });
    try {
      renderEditor();
      const editor = openSlash();
      await waitFor(() => expect(slashMenu()).toBeTruthy());
      const menu = slashMenu()!;
      await waitFor(() => expect(parseFloat(menu.style.top)).toBe(218));

      typeIntoLine(editor, '/tdo');
      await waitFor(() => expect(optionLabels()).toEqual(['待办']));
      await waitFor(() => expect(parseFloat(menu.style.top)).toBe(602));

      // Deleting the query grows the menu back to the full 13 items: the taller
      // menu must grow upwards from the same anchor, not flip below.
      typeIntoLine(editor, '/');
      await waitFor(() => expect(optionLabels()).toEqual(FULL_MENU));
      await waitFor(() => expect(parseFloat(menu.style.top)).toBe(218));
      expect(parseFloat(menu.style.top)).toBeLessThan(650);
    } finally {
      restore();
    }
  });

  it('re-decides the side when the menu is opened again', async () => {
    let bottom = 670;
    const restore = installGeometry({
      lineRect: () => makeRect({ top: bottom - 20, bottom, left: 40, width: 600, height: 20 }),
      menuHeight,
    });
    try {
      renderEditor();
      const editor = openSlash();
      await waitFor(() => expect(slashMenu()).toBeTruthy());
      await waitFor(() =>
        expect(parseFloat(slashMenu()!.style.top)).toBe(bottom - 20 - 4 - menuHeight(13)),
      );

      // Escape closes the menu; the next open measures from scratch.
      fireEvent.keyDown(editor, { key: 'Escape' });
      await waitFor(() => expect(slashMenu()).toBeNull());
      bottom = 320;
      fireEvent.keyDown(editor, { key: '/' });
      await waitFor(() => expect(slashMenu()).toBeTruthy());
      await waitFor(() =>
        expect(parseFloat(slashMenu()!.style.top)).toBe(bottom + 4),
      );
    } finally {
      restore();
    }
  });

  it('keeps a 12px viewport margin on the left edge', async () => {
    const restore = installGeometry({
      lineRect: () =>
        makeRect({ top: 300, bottom: 320, left: 2, width: 600, height: 20 }),
      menuHeight,
    });
    try {
      renderEditor();
      openSlash();
      await waitFor(() => expect(slashMenu()).toBeTruthy());
      const menu = slashMenu()!;
      await waitFor(() => expect(parseFloat(menu.style.left)).toBe(12));
    } finally {
      restore();
    }
  });

  it('keeps the side across an IME reopen of the menu', async () => {
    const restore = installGeometry({
      lineRect: () =>
        makeRect({ top: 650, bottom: 670, left: 40, width: 600, height: 20 }),
      menuHeight,
    });
    try {
      renderEditor();
      const editor = openSlash();
      await waitFor(() => expect(slashMenu()).toBeTruthy());
      await waitFor(() => expect(parseFloat(slashMenu()!.style.top)).toBe(218));

      // A composition closes the menu; committing it restores the menu for the
      // same command line. The restored, much shorter menu must stay pinned
      // above instead of re-deciding (it would fit below) and flipping.
      fireEvent.compositionStart(editor);
      await waitFor(() => expect(slashMenu()).toBeNull());
      const line = editor.querySelector<HTMLElement>('p')!;
      line.textContent = '/引用';
      caretAt(line.firstChild!, 3);
      fireEvent.input(editor);
      fireEvent.compositionEnd(editor);

      await waitFor(() => expect(slashMenu()).toBeTruthy());
      await waitFor(() => expect(optionLabels()).toEqual(['引用']));
      await waitFor(() => expect(parseFloat(slashMenu()!.style.top)).toBe(602));
      expect(
        parseFloat(slashMenu()!.style.top) + menuHeight(1),
      ).toBeLessThanOrEqual(650 - 4);
    } finally {
      restore();
    }
  });

  it('never portals the menu into the document content', async () => {
    renderEditor();
    openSlash();
    await waitFor(() => expect(slashMenu()).toBeTruthy());
    expect(surface().contains(slashMenu())).toBe(false);
    expect(slashMenu()!.parentElement).toBe(document.body);
  });
});

// ---------------------------------------------------------------------------
// 第 12 项 slash 菜单方向稳定：打开时决定上下，过滤时不再翻转
// ---------------------------------------------------------------------------

describe('第 12 项 slash 菜单方向稳定', () => {
  const geometry = {
    lineTop: 650,
    lineBottom: 670,
    lineLeft: 40,
    menuWidth: 290,
    viewportWidth: 1280,
    viewportHeight: 768,
  };

  it('goes above only when the full menu does not fit below', () => {
    expect(
      placeSlashMenu({
        ...geometry,
        lineTop: 300,
        lineBottom: 320,
        menuHeight: 300,
        preferredSide: null,
      }).side,
    ).toBe('below');
    expect(
      placeSlashMenu({ ...geometry, menuHeight: 428, preferredSide: null }).side,
    ).toBe('above');
  });

  it('keeps the recorded side even when the other side would fit', () => {
    // A filtered (short) menu would fit below, but it opened above.
    const above = placeSlashMenu({
      ...geometry,
      menuHeight: 44,
      preferredSide: 'above',
    });
    expect(above.side).toBe('above');
    expect(above.top).toBe(650 - 4 - 44);

    // A menu opened below keeps its 4px gap as it grows.
    const below = placeSlashMenu({
      ...geometry,
      lineTop: 300,
      lineBottom: 320,
      menuHeight: 428,
      preferredSide: 'below',
    });
    expect(below.side).toBe('below');
    expect(below.top).toBe(324);
  });

  it('clamps inside the viewport without changing sides', () => {
    const placement = placeSlashMenu({
      ...geometry,
      menuHeight: 768,
      preferredSide: 'above',
    });
    expect(placement.side).toBe('above');
    expect(placement.top).toBe(12);
  });
});
