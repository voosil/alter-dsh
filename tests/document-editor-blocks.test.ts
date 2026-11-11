// @vitest-environment jsdom
/**
 * 编辑器专题优化第 1/5/6 项：块级选中与删除（分割线、图片、表格）。
 *
 * 分割线与图片是「不可直接编辑的块」：光标落在其下一行行首按退格时，先选中
 * 整块（data-selected），再按一次才真正删除；删除后光标回到上一行行尾。
 * 表格提供悬浮操作条：选中整表 → 删除 / 上移 / 下移。
 *
 * 这些选中标记只是编辑面状态：不得进入保存的 HTML，也不得影响 AST 往返。
 * 测试断言行为（DOM 变动、选中态、焦点/光标落点、按键结果），不断言整段 HTML。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '../vendor/ui-space/src/components/editor/Editor';
import { parseLegacyHtml } from '../src/document/legacy';

// ---------------------------------------------------------------------------
// jsdom geometry stubs (no layout engine)
// ---------------------------------------------------------------------------

function zeroRect(): DOMRect {
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
  } as DOMRect;
}

if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}
if (typeof Element.prototype.getBoundingClientRect !== 'function') {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return zeroRect();
  };
}
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return zeroRect();
  };
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
    function scrollIntoView() {
      // jsdom has no scrolling.
    };
}

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type EditorOverrides = Record<string, unknown>;

function renderEditor(overrides: EditorOverrides = {}) {
  const props = {
    docId: 'doc-blocks',
    initialHtml: '<p>正文段落</p>',
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

function caretPosition(): { node: Node; offset: number } {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.anchorNode === null) {
    throw new Error('caret is missing');
  }
  return { node: selection.anchorNode, offset: selection.anchorOffset };
}

/** The caret sits inside `element` and nothing of `element` follows it. */
function expectCaretAtEnd(element: HTMLElement): void {
  const caret = caretPosition();
  expect(element.contains(caret.node)).toBe(true);
  const after = document.createRange();
  after.selectNodeContents(element);
  after.setStart(caret.node, caret.offset);
  expect(after.toString()).toBe('');
}

/** The caret sits inside `element` and nothing of `element` precedes it. */
function expectCaretAtStart(element: HTMLElement): void {
  const caret = caretPosition();
  expect(element.contains(caret.node)).toBe(true);
  const before = document.createRange();
  before.selectNodeContents(element);
  before.setEnd(caret.node, caret.offset);
  expect(before.toString()).toBe('');
}

function paragraphs(): HTMLElement[] {
  return [...surface().querySelectorAll<HTMLElement>('p')];
}

function divider(): HTMLElement | null {
  return surface().querySelector<HTMLElement>('[data-divider]');
}

function image(): HTMLElement | null {
  return surface().querySelector<HTMLElement>('img');
}

const dividerHtml =
  '<p>上一行</p><div data-divider contenteditable="false"><hr></div><p>下一行</p>';

const imageHtml =
  '<p>上一行</p><img src="data:image/png;base64,AAAA" alt="图"><p>下一行</p>';

const tableHtml =
  '<p>上文</p><table><tbody><tr><td>单元格</td></tr></tbody></table><p>下文</p>';

function table(): HTMLElement {
  const element = surface().querySelector<HTMLElement>('table');
  if (element === null) throw new Error('table is missing');
  return element;
}

function openTableBar(): HTMLElement {
  fireEvent.mouseOver(table());
  return screen.getByRole('group', { name: '表格操作' });
}

function selectTable(): void {
  openTableBar();
  fireEvent.click(screen.getByRole('button', { name: '选中表格' }));
}

// ---------------------------------------------------------------------------
// 第 1 项：分割线两步删除
// ---------------------------------------------------------------------------

describe('第 1 项 分割线选中与删除', () => {
  it('下一行行首退格先选中整条分割线，再按一次才删除，光标回到上一行行尾', () => {
    const props = renderEditor({ initialHtml: dividerHtml });
    const nextLine = paragraphs()[1]!;
    caretAt(nextLine.firstChild!, 0);

    const firstPress = fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(firstPress).toBe(false);
    const selected = divider();
    expect(selected).not.toBeNull();
    expect(selected!.hasAttribute('data-selected')).toBe(true);
    // Nothing was deleted yet and no save was scheduled.
    expect(surface().querySelector('[data-divider]')).not.toBeNull();
    expect(props.onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(divider()).toBeNull();
    expectCaretAtEnd(paragraphs()[0]!);
    expect(props.onChange).toHaveBeenCalled();
  });

  it('上一行行尾按 Delete 同样先选中，再按一次删除并把光标放回上一行行尾', () => {
    renderEditor({ initialHtml: dividerHtml });
    const previous = paragraphs()[0]!;
    caretAt(previous.firstChild!, previous.textContent!.length);

    fireEvent.keyDown(surface(), { key: 'Delete' });
    expect(divider()?.hasAttribute('data-selected')).toBe(true);

    fireEvent.keyDown(surface(), { key: 'Delete' });
    expect(divider()).toBeNull();
    expectCaretAtEnd(paragraphs()[0]!);
  });

  it('分割线位于文档开头时，删除后光标落到下一行行首', () => {
    renderEditor({
      initialHtml: '<div data-divider contenteditable="false"><hr></div><p>下一行</p>',
    });
    const nextLine = paragraphs()[0]!;
    caretAt(nextLine.firstChild!, 0);

    fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(divider()?.hasAttribute('data-selected')).toBe(true);

    fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(divider()).toBeNull();
    expectCaretAtStart(paragraphs()[0]!);
  });

  it('不在行首/行尾时不抢默认删除行为', () => {
    renderEditor({ initialHtml: dividerHtml });
    const nextLine = paragraphs()[1]!;
    caretAt(nextLine.firstChild!, 1);
    const notPrevented = fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(notPrevented).toBe(true);
    expect(divider()).not.toBeNull();
    expect(divider()!.hasAttribute('data-selected')).toBe(false);
  });

  it('删除相邻分割线后光标落到下一行，而不是补一段尾部段落', () => {
    renderEditor({
      initialHtml:
        '<div data-divider contenteditable="false"><hr></div>' +
        '<div data-divider contenteditable="false"><hr></div><p>下一行</p>',
    });
    caretAt(paragraphs()[0]!.firstChild!, 0);
    fireEvent.keyDown(surface(), { key: 'Backspace' });
    fireEvent.keyDown(surface(), { key: 'Backspace' });

    expect(surface().querySelectorAll('[data-divider]')).toHaveLength(1);
    expect(paragraphs()).toHaveLength(1);
    expectCaretAtStart(paragraphs()[0]!);
  });

  it('点击分割线可选中，Escape 取消选中且不删除', () => {
    renderEditor({ initialHtml: dividerHtml });
    fireEvent.click(divider()!);
    expect(divider()!.hasAttribute('data-selected')).toBe(true);

    fireEvent.keyDown(surface(), { key: 'Escape' });
    expect(divider()).not.toBeNull();
    expect(divider()!.hasAttribute('data-selected')).toBe(false);
  });

  it('选中后再按其他键回到普通编辑并取消选中', () => {
    renderEditor({ initialHtml: dividerHtml });
    fireEvent.click(divider()!);
    expect(divider()!.hasAttribute('data-selected')).toBe(true);

    fireEvent.keyDown(surface(), { key: 'ArrowRight' });
    expect(divider()!.hasAttribute('data-selected')).toBe(false);
    expect(divider()).not.toBeNull();
  });

  it('点击正文其他位置取消分割线选中', () => {
    renderEditor({ initialHtml: dividerHtml });
    fireEvent.click(divider()!);
    expect(divider()!.hasAttribute('data-selected')).toBe(true);

    fireEvent.click(paragraphs()[0]!);
    expect(divider()!.hasAttribute('data-selected')).toBe(false);
  });

  it('选中态不写进保存的 HTML，也不进入 AST', () => {
    const props = renderEditor({ initialHtml: dividerHtml });
    fireEvent.click(divider()!);
    fireEvent.input(surface());

    expect(props.onChange).toHaveBeenCalled();
    const saved = String(props.onChange.mock.calls.at(-1)?.[0] ?? '');
    expect(saved).toContain('data-divider');
    expect(saved).not.toContain('data-selected');

    const parsed = parseLegacyHtml(
      '<div data-divider data-selected="" contenteditable="false"><hr></div><p>后文</p>',
    );
    expect(parsed.blocks.map((block) => block.type)).toEqual([
      'divider',
      'paragraph',
    ]);
    expect(parsed.blocks[0]!.attrs).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 第 6 项：图片选中与删除
// ---------------------------------------------------------------------------

describe('第 6 项 图片选中与删除', () => {
  it('点击图片可选中，选中视觉与分割线一致（data-selected），Escape 取消', () => {
    renderEditor({ initialHtml: imageHtml });
    fireEvent.click(image()!);
    expect(image()!.hasAttribute('data-selected')).toBe(true);

    fireEvent.keyDown(surface(), { key: 'Escape' });
    expect(image()!.hasAttribute('data-selected')).toBe(false);
    expect(surface().querySelector('img')).not.toBeNull();
  });

  it('下一行行首退格先选中图片，再按一次删除，光标回到上一行行尾', () => {
    renderEditor({ initialHtml: imageHtml });
    const nextLine = paragraphs()[1]!;
    caretAt(nextLine.firstChild!, 0);

    fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(image()!.hasAttribute('data-selected')).toBe(true);
    expect(image()).not.toBeNull();

    fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(image()).toBeNull();
    expectCaretAtEnd(paragraphs()[0]!);
  });

  it('点击选中后按 Delete 直接删除图片，光标落到相邻可输入位置', () => {
    renderEditor({ initialHtml: imageHtml });
    fireEvent.click(image()!);
    fireEvent.keyDown(surface(), { key: 'Delete' });

    expect(image()).toBeNull();
    expectCaretAtEnd(paragraphs()[0]!);
  });

  it('行内图片删除后保留所在段落与其余文字', () => {
    renderEditor({
      initialHtml:
        '<p>文字<img src="data:image/png;base64,AAAA" alt="图">尾</p><p>下一行</p>',
    });
    fireEvent.click(image()!);
    fireEvent.keyDown(surface(), { key: 'Delete' });

    expect(image()).toBeNull();
    const line = paragraphs()[0]!;
    expect(line.textContent).toBe('文字尾');
    expect(line.contains(window.getSelection()!.anchorNode)).toBe(true);
  });

  it('图片选中态不写进保存的 HTML，也不进入 AST', () => {
    const props = renderEditor({ initialHtml: imageHtml });
    fireEvent.click(image()!);
    fireEvent.input(surface());

    const saved = String(props.onChange.mock.calls.at(-1)?.[0] ?? '');
    expect(saved).toContain('<img');
    expect(saved).not.toContain('data-selected');

    const parsed = parseLegacyHtml(
      '<img data-selected="" src="data:image/png;base64,AAAA" alt="图">',
      { assetIdFor: () => 'asset_selected1' },
    );
    expect(parsed.blocks.map((block) => block.type)).toEqual(['image']);
    expect(parsed.blocks[0]!.attrs).toEqual({
      assetId: 'asset_selected1',
      alt: '图',
    });
  });
});

// ---------------------------------------------------------------------------
// 第 5 项：表格整表选中 / 删除 / 移动
// ---------------------------------------------------------------------------

describe('第 5 项 表格整表选中、删除与移动', () => {
  it('悬浮表格出现整表入口，点击后整表选中并把光标移出表格', () => {
    renderEditor({ initialHtml: tableHtml });
    const bar = openTableBar();
    expect(surface().contains(bar)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '选中表格' }));

    expect(table().hasAttribute('data-selected')).toBe(true);
    expectCaretAtEnd(paragraphs()[0]!);
    expect(screen.getByRole('button', { name: '上移表格' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '下移表格' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除表格' })).toBeTruthy();
  });

  it('整表选中后按 Delete 删除表格，光标回到上一行行尾', () => {
    const props = renderEditor({ initialHtml: tableHtml });
    selectTable();
    fireEvent.keyDown(surface(), { key: 'Delete' });

    expect(surface().querySelector('table')).toBeNull();
    expectCaretAtEnd(paragraphs()[0]!);
    expect(props.onChange).toHaveBeenCalled();
  });

  it('整表选中后用操作条删除表格', () => {
    renderEditor({ initialHtml: tableHtml });
    selectTable();
    fireEvent.click(screen.getByRole('button', { name: '删除表格' }));

    expect(surface().querySelector('table')).toBeNull();
    expectCaretAtEnd(paragraphs()[0]!);
  });

  it('整表选中后可用上移/下移调整位置', () => {
    renderEditor({ initialHtml: tableHtml });
    selectTable();

    fireEvent.click(screen.getByRole('button', { name: '下移表格' }));
    expect(
      [...surface().children].map((child) => child.tagName.toLowerCase()),
    ).toEqual(['p', 'p', 'table']);

    fireEvent.click(screen.getByRole('button', { name: '上移表格' }));
    expect(
      [...surface().children].map((child) => child.tagName.toLowerCase()),
    ).toEqual(['p', 'table', 'p']);

    fireEvent.click(screen.getByRole('button', { name: '上移表格' }));
    expect(
      [...surface().children].map((child) => child.tagName.toLowerCase()),
    ).toEqual(['table', 'p', 'p']);
    // Already at the top: another move is a no-op.
    fireEvent.click(screen.getByRole('button', { name: '上移表格' }));
    expect(
      [...surface().children].map((child) => child.tagName.toLowerCase()),
    ).toEqual(['table', 'p', 'p']);
  });

  it('表格选中后 Escape 取消选中且保留表格', () => {
    renderEditor({ initialHtml: tableHtml });
    selectTable();
    fireEvent.keyDown(surface(), { key: 'Escape' });

    expect(surface().querySelector('table')).not.toBeNull();
    expect(table().hasAttribute('data-selected')).toBe(false);
  });

  it('点击表格外区域收起操作条并取消选中', () => {
    renderEditor({ initialHtml: tableHtml });
    selectTable();
    expect(screen.getByRole('group', { name: '表格操作' })).toBeTruthy();

    fireEvent.click(paragraphs()[0]!);
    expect(screen.queryByRole('group', { name: '表格操作' })).toBeNull();
    expect(table().hasAttribute('data-selected')).toBe(false);
  });

  it('表格选中态不进入 AST', () => {
    renderEditor({ initialHtml: tableHtml });
    selectTable();
    const parsed = parseLegacyHtml(
      '<table data-selected=""><tbody><tr><td>单元格</td></tr></tbody></table>',
    );
    expect(parsed.blocks.map((block) => block.type)).toEqual(['table']);
  });
});

// ---------------------------------------------------------------------------
// 选中视觉（CSS 契约，不涉及 DOM 结构）
// ---------------------------------------------------------------------------

describe('块选中视觉样式契约', () => {
  const css = readFileSync(
    resolve(
      process.cwd(),
      'vendor/ui-space/src/components/editor/Editor.module.css',
    ),
    'utf8',
  );

  it('图片 hover 光标为 pointer 且选中时有描边', () => {
    expect(css).toMatch(/\.surface img\s*\{[^}]*cursor:\s*pointer/);
    expect(css).toMatch(/\.surface img\[data-selected\]\s*\{[^}]*outline/);
  });

  it('表格选中时有与分割线一致的描边', () => {
    expect(css).toMatch(/\.surface table\[data-selected\]\s*\{[^}]*outline/);
  });
});
