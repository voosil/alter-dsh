// @vitest-environment jsdom
/**
 * Legacy editor caret/placeholder regressions (专题优化 第 9、11、7 项).
 *
 * The editor surface is a frozen 1:1 restoration of the old UI: these tests
 * lock behavior (focus, DOM changes, style contract) instead of markup. The
 * jsdom layer has no layout engine, so vertical centering is asserted as
 * "caret lives in the line box of the first typable line" — the same invariant
 * Chrome renders as a centered caret (verified against headless Chrome).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '../vendor/ui-space/src/components/editor/Editor';

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type EditorOverrides = Record<string, unknown>;

function renderEditor(overrides: EditorOverrides = {}) {
  const props = {
    docId: 'doc-1',
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

/** Focus the surface through both the DOM and React's focus event. */
function focusEditor(editor: HTMLElement) {
  editor.focus();
  fireEvent.focus(editor);
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

/** The single collapsed caret, or a failure when the selection is unusable. */
function caret(): { node: Node; offset: number; line: HTMLElement } {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount !== 1 || !selection.isCollapsed)
    throw new Error('expected one collapsed caret');
  const node = selection.anchorNode;
  if (node === null) throw new Error('caret has no node');
  const element = node instanceof Element ? node : node.parentElement;
  const line = element?.closest<HTMLElement>('p,h1,h2,h3,li,blockquote,pre,[data-todo]');
  if (!line) throw new Error('caret is outside any line box');
  return { node, offset: selection.anchorOffset, line };
}

function lastChangeHtml(onChange: unknown): string {
  const calls = (onChange as { mock: { calls: unknown[][] } }).mock.calls;
  return String(calls.at(-1)?.[0] ?? '');
}

/** Read the frozen editor stylesheet to lock its CSS-only contracts. */
function editorCss(): string {
  return readFileSync(
    path.resolve(
      process.cwd(),
      'vendor/ui-space/src/components/editor/Editor.module.css',
    ),
    'utf8',
  );
}

const EMPTY_TODO =
  '<div data-todo data-checked="false">' +
  '<span data-todo-box contenteditable="false" role="checkbox" aria-checked="false"' +
  ' aria-label="待办事项" tabindex="0"></span>' +
  '<span data-todo-text><br></span></div>';

const TODO_TEXT_TODO = (text: string) =>
  '<div data-todo data-checked="false">' +
  '<span data-todo-box contenteditable="false" role="checkbox" aria-checked="false"' +
  ' aria-label="待办事项" tabindex="0"></span>' +
  `<span data-todo-text>${text}</span></div>`;

const FILE_CHIP =
  '<span data-file="a.pdf" data-href="data:application/pdf;base64,AAAA" data-size="3 B"' +
  ' contenteditable="false" role="link" tabindex="0" aria-label="打开文件 a.pdf">' +
  '<span data-file-icon contenteditable="false" aria-hidden="true"></span>' +
  'a.pdf · 3 B</span>';

// ---------------------------------------------------------------------------
// 第 9 项: Backspace on an empty todo removes the row and keeps the caret on a
// neighboring line box (instead of parking it at the editor root / line start).
// ---------------------------------------------------------------------------

describe('第 9 项 空 checkbox 删除', () => {
  it('removes an empty todo row and puts the caret at the end of the previous line', () => {
    const props = renderEditor({
      initialHtml: `<p>上一行</p>${EMPTY_TODO}<p>下一行</p>`,
    });
    const todo = surface().querySelector<HTMLElement>('[data-todo]')!;
    caretAt(todo.querySelector('[data-todo-text]')!, 0);

    const notPrevented = fireEvent.keyDown(surface(), { key: 'Backspace' });

    expect(notPrevented).toBe(false);
    expect(surface().querySelector('[data-todo]')).toBeNull();
    const previous = surface().querySelector('p')!;
    const position = caret();
    expect(position.line).toBe(previous);
    expect(previous.contains(position.node)).toBe(true);
    expect(previous.textContent).toBe('上一行');
    expect(lastChangeHtml(props.onChange)).not.toContain('data-todo');
    expect(props.onChange).toHaveBeenCalled();
  });

  it('removes an empty leading todo and puts the caret at the start of the next line', () => {
    renderEditor({ initialHtml: `${EMPTY_TODO}<p>下一行</p>` });
    const todo = surface().querySelector<HTMLElement>('[data-todo]')!;
    caretAt(todo.querySelector('[data-todo-text]')!, 0);

    fireEvent.keyDown(surface(), { key: 'Backspace' });

    expect(surface().querySelector('[data-todo]')).toBeNull();
    const next = surface().querySelector('p')!;
    const position = caret();
    expect(position.line).toBe(next);
    expect(next.contains(position.node)).toBe(true);
  });

  it('degenerates the only empty todo into an empty paragraph with the caret inside it', () => {
    const props = renderEditor({ initialHtml: EMPTY_TODO });
    const todo = surface().querySelector<HTMLElement>('[data-todo]')!;
    caretAt(todo.querySelector('[data-todo-text]')!, 0);

    const notPrevented = fireEvent.keyDown(surface(), { key: 'Delete' });

    expect(notPrevented).toBe(false);
    expect(surface().querySelector('[data-todo]')).toBeNull();
    const paragraph = surface().querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph!.textContent).toBe('');
    expect(paragraph!.firstElementChild?.tagName).toBe('BR');
    const position = caret();
    expect(position.line).toBe(paragraph);
    expect(paragraph!.contains(position.node)).toBe(true);
    expect(props.onChange).toHaveBeenCalled();
  });

  it('deletes the empty todo even when the caret sits between checkbox and text', () => {
    renderEditor({ initialHtml: `<p>上一行</p>${EMPTY_TODO}` });
    const editor = surface();
    focusEditor(editor);
    const todo = editor.querySelector<HTMLElement>('[data-todo]')!;
    // Caret on the todo wrapper itself, before [data-todo-text].
    caretAt(todo, 0);

    fireEvent.keyDown(editor, { key: 'Backspace' });

    expect(editor.querySelector('[data-todo]')).toBeNull();
    expect(editor.querySelector('p')!.textContent).toBe('上一行');
  });

  it('leaves a todo with text to the browser default behavior', () => {
    renderEditor({ initialHtml: TODO_TEXT_TODO('有内容的待办') });
    caretAt(surface().querySelector('[data-todo-text]')!.firstChild!, 0);

    const notPrevented = fireEvent.keyDown(surface(), { key: 'Backspace' });

    expect(notPrevented).toBe(true);
    expect(surface().querySelector('[data-todo]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 第 11 项: empty-document caret stays in the first line box of the empty
// paragraph, and the placeholder stays visible exactly while the doc is empty.
// ---------------------------------------------------------------------------

/** The CSS selector the editor stylesheet uses for the placeholder. */
const PLACEHOLDER_SELECTOR =
  ':is(:empty, :has(> p:only-child:empty), :has(> p:only-child > br:only-child))';

describe('第 11 项 空文档光标与 placeholder', () => {
  it('focuses an empty document with the caret on the first line, not after the <br>', () => {
    renderEditor({ initialHtml: '' });
    const editor = surface();
    expect(editor.children.length).toBe(0);

    focusEditor(editor);

    const paragraph = editor.querySelector('p');
    expect(paragraph).not.toBeNull();
    // Placeholder stays visible: the empty document keeps matching its rule.
    expect(editor.matches(PLACEHOLDER_SELECTOR)).toBe(true);
    const position = caret();
    expect(position.line).toBe(paragraph);
    // First typable position: before the placeholder <br> (line 1). Placing the
    // caret after it would render on the second, zero-height line.
    expect(position.node).toBe(paragraph);
    expect(position.offset).toBe(0);
  });

  it('keeps the caret and placeholder stable when Backspace hits an empty document', () => {
    renderEditor({ initialHtml: '' });
    const editor = surface();
    focusEditor(editor);
    const paragraph = editor.querySelector('p')!;
    const before = caret();

    const notPrevented = fireEvent.keyDown(editor, { key: 'Backspace' });

    expect(notPrevented).toBe(false);
    expect(editor.querySelector('p')).toBe(paragraph);
    expect(editor.matches(PLACEHOLDER_SELECTOR)).toBe(true);
    const after = caret();
    expect(after.line).toBe(paragraph);
    expect(after.node).toBe(before.node);
    expect(after.offset).toBe(before.offset);
  });

  it('hides the placeholder once the document has text and restores it when cleared', () => {
    renderEditor({ initialHtml: '' });
    const editor = surface();
    focusEditor(editor);
    const paragraph = editor.querySelector('p')!;

    paragraph.textContent = '字';
    fireEvent.input(editor);
    expect(editor.matches(PLACEHOLDER_SELECTOR)).toBe(false);

    paragraph.innerHTML = '<br>';
    fireEvent.input(editor);
    expect(editor.matches(PLACEHOLDER_SELECTOR)).toBe(true);
  });

  it('styles the empty-document placeholder out of the line flow', () => {
    const css = editorCss();
    const index = css.indexOf('.surface:is(:empty, :has(> p:only-child:empty)');
    expect(index).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', index);
    const body = css.slice(open + 1, css.indexOf('}', open));
    expect(body).toContain('content: attr(data-placeholder)');
    // 绝对定位让占位符脱离行内流，否则它会占掉空段落的首行。
    expect(body).toContain('position: absolute');
    expect(body).toContain('inset:');
    expect(body).toContain('pointer-events: none');
  });
});

// ---------------------------------------------------------------------------
// 第 7 项: attachment chips expose hover/focus-visible surface states built
// from the existing visual tokens (CSS-only state, like the link card).
// ---------------------------------------------------------------------------

describe('第 7 项 附件 chip 态样式', () => {
  it('keeps the attachment chip keyboard focusable for its selected state', () => {
    renderEditor({ initialHtml: `<p>${FILE_CHIP}</p>` });
    const chip = surface().querySelector<HTMLElement>('[data-file]');
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('tabindex')).toBe('0');

    chip!.focus();

    expect(document.activeElement).toBe(chip);
  });

  it('changes the chip background and softens the border on hover/focus', () => {
    const css = editorCss();
    const ruleWith = (selector: string) => {
      const index = css.indexOf(selector);
      expect(index).toBeGreaterThanOrEqual(0);
      const open = css.indexOf('{', index);
      return css.slice(open + 1, css.indexOf('}', open));
    };

    const state = ruleWith('.surface [data-file]:hover');
    expect(state).toMatch(/background-color:\s*var\(--alter-[\w-]+\)/);
    expect(state).toMatch(/border-color:\s*var\(--alter-[\w-]+\)/);

    const focused = ruleWith('.surface [data-file]:focus-visible');
    expect(focused).toMatch(/background-color:\s*var\(--alter-[\w-]+\)/);
    expect(css).toMatch(/\[data-file\]:focus-visible[^{]*\{[^}]*outline:/);
  });
});
