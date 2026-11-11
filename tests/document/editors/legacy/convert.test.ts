// @vitest-environment jsdom
/**
 * Legacy editor block auto-conversion (《编辑器专题优化》第 2、3、13 项).
 *
 * Item 2: any `N. ` marker at the start of a line becomes an ordered list
 * (previously only a hardcoded `1.`), and deleting an empty list item keeps
 * the caret on the current line instead of jumping to the previous item.
 * Item 3: an IME-committed `N. ` / `》` triggers the same conversion even when
 * the browser emits no trailing `input` event.
 * Item 13: the quote marker converts only as "marker + space" — `>` and the
 * full-width `》` a Chinese IME produces both need the following space. A bare
 * `>` / `》` stays text whether it arrives through a keydown or a plain input
 * event (the input path must not convert early, or the space would land inside
 * the quote), while an IME that commits `>` / `》` — with or without the trailing
 * space it consumed — still converts at composition end.
 * Divider: typing `---` alone on a line converts it as soon as the third dash
 * lands, without the Enter the legacy editor required.
 *
 * The editor DOM/CSS is frozen (1:1 legacy restore); these tests assert
 * behaviour (block type, list/caret position), never whole-HTML structure.
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '../../../../vendor/ui-space/src/components/editor/Editor';
import {
  alterDocToEditorHtml,
  parseLegacyHtml,
} from '../../../../src/document/editors/legacy';
import type { AlterDoc } from '../../../../src/document/types';

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

type ExecCommand = (command: string, ui?: boolean, value?: string) => boolean;

function deleteExecCommand(): void {
  delete (document as unknown as { execCommand?: ExecCommand }).execCommand;
}

beforeEach(() => {
  deleteExecCommand();
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
  return props as typeof props & { onChange: ReturnType<typeof vi.fn> };
}

function surface(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="文档正文"]',
  );
  if (element === null) throw new Error('editor surface is missing');
  return element;
}

/** Put the caret at one DOM position. */
function caretAt(node: Node, offset = 0): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  if (selection === null) throw new Error('no selection');
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Collapse the caret at the end of one element's content. */
function caretAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  if (selection === null) throw new Error('no selection');
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Plain-text offset of a collapsed caret measured from one element's start. */
function caretOffsetIn(line: HTMLElement): number {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return -1;
  const range = selection.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(line);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function caretInside(element: HTMLElement): boolean {
  const selection = window.getSelection();
  return (
    selection !== null &&
    selection.rangeCount > 0 &&
    element.contains(selection.anchorNode)
  );
}

/** Replace one line's text and leave the caret at its end (typing simulation). */
function typeText(line: HTMLElement, text: string): void {
  line.textContent = text;
  caretAtEnd(line);
}

function lists(): HTMLElement[] {
  return [...surface().querySelectorAll<HTMLElement>('ul, ol')];
}

function itemTexts(list: HTMLElement): string[] {
  return [...list.querySelectorAll(':scope > li')].map((item) =>
    (item.textContent ?? '').trim(),
  );
}

/** A DOM list is treated as ordered when its tag is OL. */
function orderedStart(list: HTMLElement): number {
  const expected = Number.parseInt(list.getAttribute('start') ?? '1', 10);
  return Number.isFinite(expected) ? expected : 1;
}

// ---------------------------------------------------------------------------
// Item 2: any number marker auto-converts to an ordered list
// ---------------------------------------------------------------------------

describe('第 2 项 有序列表自动转换', () => {
  it.each(['2', '3', '10'])(
    'converts "%s. " on an empty line into an ordered list',
    (marker) => {
      const props = renderEditor({ initialHtml: '<p><br></p>' });
      const line = surface().querySelector('p')!;
      typeText(line, `${marker}.`);

      const notPrevented = fireEvent.keyDown(surface(), { key: ' ' });

      expect(notPrevented).toBe(false);
      const converted = lists();
      expect(converted).toHaveLength(1);
      expect(converted[0]!.tagName).toBe('OL');
      expect(itemTexts(converted[0]!)).toEqual(['']);
      expect(caretInside(converted[0]!.querySelector('li')!)).toBe(true);
      expect(props.onChange).toHaveBeenCalled();
    },
  );

  it('keeps the typed number as the ordered list start', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    typeText(surface().querySelector('p')!, '3.');
    fireEvent.keyDown(surface(), { key: ' ' });

    const list = lists()[0]!;
    expect(list.tagName).toBe('OL');
    expect(list.getAttribute('start')).toBe('3');
    expect(orderedStart(list)).toBe(3);
  });

  it('still converts "1. " with the default numbering', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    typeText(surface().querySelector('p')!, '1.');
    const notPrevented = fireEvent.keyDown(surface(), { key: ' ' });

    expect(notPrevented).toBe(false);
    const list = lists()[0]!;
    expect(list.tagName).toBe('OL');
    expect(list.hasAttribute('start')).toBe(false);
    expect(itemTexts(list)).toEqual(['']);
  });

  it('converts a numbered marker typed on an empty line between blocks', () => {
    renderEditor({ initialHtml: '<p>上文</p><p><br></p>' });
    const line = surface().querySelectorAll('p')[1]!;
    typeText(line, '2.');
    fireEvent.keyDown(surface(), { key: ' ' });

    const converted = lists();
    expect(converted).toHaveLength(1);
    expect(converted[0]!.tagName).toBe('OL');
    expect(converted[0]!.getAttribute('start')).toBe('2');
    const blocks = [...surface().children];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.tagName).toBe('P');
    expect(blocks[0]!.textContent).toBe('上文');
    expect(blocks[1]!.tagName).toBe('OL');
  });

  it('does not convert a number that is not the whole line', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const line = surface().querySelector('p')!;
    typeText(line, 'abc 2.');
    const notPrevented = fireEvent.keyDown(surface(), { key: ' ' });

    expect(notPrevented).toBe(true);
    expect(lists()).toHaveLength(0);
    expect(surface().querySelector('p')!.textContent).toBe('abc 2.');
  });
});

// ---------------------------------------------------------------------------
// Item 2: deleting an empty list item keeps the caret on the current line
// ---------------------------------------------------------------------------

describe('第 2 项 空列表项删除', () => {
  it('splits the list around an empty middle item and keeps the caret on the current line', () => {
    const props = renderEditor({
      initialHtml: '<ul><li>第一项</li><li><br></li><li>第三项</li></ul>',
    });
    caretAt(surface().querySelectorAll('ul > li')[1]!, 0);

    const notPrevented = fireEvent.keyDown(surface(), { key: 'Backspace' });

    expect(notPrevented).toBe(false);
    const converted = lists();
    expect(converted).toHaveLength(2);
    expect(itemTexts(converted[0]!)).toEqual(['第一项']);
    expect(itemTexts(converted[1]!)).toEqual(['第三项']);
    const paragraph = surface().querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(currentLineBetween(converted[0]!, converted[1]!)).toBe(paragraph);
    // The current line is a real, editable empty paragraph (no empty list).
    expect(surface().querySelectorAll('p')).toHaveLength(1);
    expect(paragraph!.firstElementChild?.tagName).toBe('BR');
    expect(caretInside(paragraph!)).toBe(true);
    expect(caretOffsetIn(paragraph!)).toBe(0);
    expect(props.onChange).toHaveBeenCalled();
  });

  it('keeps ordered-list numbering after splitting around an empty middle item', () => {
    renderEditor({
      initialHtml: '<ol><li>一</li><li><br></li><li>三</li></ol>',
    });
    caretAt(surface().querySelectorAll('ol > li')[1]!, 0);
    fireEvent.keyDown(surface(), { key: 'Backspace' });

    const converted = lists();
    expect(converted).toHaveLength(2);
    expect(itemTexts(converted[0]!)).toEqual(['一']);
    expect(itemTexts(converted[1]!)).toEqual(['三']);
    // The tail keeps the original numbering instead of restarting at 1.
    expect(converted[1]!.getAttribute('start')).toBe('3');
  });

  it('deletes a trailing empty item and keeps the caret on the current line', () => {
    renderEditor({ initialHtml: '<ul><li>第一项</li><li><br></li></ul>' });
    caretAt(surface().querySelectorAll('ul > li')[1]!, 0);
    fireEvent.keyDown(surface(), { key: 'Backspace' });

    const converted = lists();
    expect(converted).toHaveLength(1);
    expect(itemTexts(converted[0]!)).toEqual(['第一项']);
    const paragraph = surface().querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(surface().lastElementChild).toBe(paragraph);
    expect(caretInside(paragraph!)).toBe(true);
    expect(caretOffsetIn(paragraph!)).toBe(0);
  });

  it('splits the list after a leading empty item and keeps the caret on the current line', () => {
    renderEditor({ initialHtml: '<ol><li><br></li><li>第二项</li></ol>' });
    caretAt(surface().querySelector('ol > li')!, 0);
    fireEvent.keyDown(surface(), { key: 'Backspace' });

    const paragraph = surface().firstElementChild as HTMLElement;
    expect(paragraph.tagName).toBe('P');
    expect(caretInside(paragraph)).toBe(true);
    expect(caretOffsetIn(paragraph)).toBe(0);
    const converted = lists();
    expect(converted).toHaveLength(1);
    expect(itemTexts(converted[0]!)).toEqual(['第二项']);
    // The remaining item keeps the number it had (second item of the list).
    expect(converted[0]!.getAttribute('start')).toBe('2');
  });

  it('replaces a single empty list with one paragraph', () => {
    renderEditor({ initialHtml: '<ul><li><br></li></ul>' });
    caretAt(surface().querySelector('ul > li')!, 0);
    fireEvent.keyDown(surface(), { key: 'Backspace' });

    expect(surface().querySelector('ul')).toBeNull();
    const paragraph = surface().querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(caretInside(paragraph!)).toBe(true);
    expect(caretOffsetIn(paragraph!)).toBe(0);
  });

  it('leaves non-empty list items to the browser default behaviour', () => {
    renderEditor({ initialHtml: '<ul><li>文字</li></ul>' });
    const item = surface().querySelector('ul > li')!;
    caretAt(item.firstChild!, 0);

    const notPrevented = fireEvent.keyDown(surface(), { key: 'Backspace' });

    expect(notPrevented).toBe(true);
    expect(surface().querySelectorAll('ul > li')).toHaveLength(1);
    expect(surface().querySelector('p')).toBeNull();
  });

  it('treats forward Delete on an empty item the same way', () => {
    renderEditor({
      initialHtml: '<ul><li>第一项</li><li><br></li><li>第三项</li></ul>',
    });
    caretAt(surface().querySelectorAll('ul > li')[1]!, 0);
    fireEvent.keyDown(surface(), { key: 'Delete' });

    expect(lists()).toHaveLength(2);
    const paragraph = surface().querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(caretOffsetIn(paragraph!)).toBe(0);
  });

  /** The paragraph that sits between two split lists. */
  function currentLineBetween(before: HTMLElement, after: HTMLElement) {
    const children = [...surface().children];
    const start = children.indexOf(before);
    const end = children.indexOf(after);
    if (start < 0 || end < 0 || end !== start + 2) return null;
    return children[start + 1] ?? null;
  }
});

// ---------------------------------------------------------------------------
// Item 3: IME-committed shortcuts
// ---------------------------------------------------------------------------

function compositionStart(editor: HTMLElement): void {
  editor.dispatchEvent(new Event('compositionstart', { bubbles: true }));
}

function compositionEnd(editor: HTMLElement): void {
  editor.dispatchEvent(new Event('compositionend', { bubbles: true }));
}

describe('第 3 项 中文输入法收尾转换', () => {
  it('converts "3. " committed by the IME followed by a space keydown', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const editor = surface();
    const line = editor.querySelector('p')!;
    caretAtEnd(line);

    compositionStart(editor);
    typeText(line, '3.');
    // Half-composed input must not convert early.
    fireEvent.input(editor);
    expect(lists()).toHaveLength(0);
    compositionEnd(editor);

    const notPrevented = fireEvent.keyDown(editor, { key: ' ' });

    expect(notPrevented).toBe(false);
    const list = lists()[0]!;
    expect(list.tagName).toBe('OL');
    expect(list.getAttribute('start')).toBe('3');
    expect(caretInside(list.querySelector('li')!)).toBe(true);
  });

  it('does not convert while the IME composition is still open', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const editor = surface();
    const line = editor.querySelector('p')!;

    compositionStart(editor);
    typeText(line, '3.');
    const notPrevented = fireEvent.keyDown(editor, { key: ' ' });
    expect(notPrevented).toBe(true);
    expect(lists()).toHaveLength(0);
    expect(editor.querySelector('p')).not.toBeNull();
    compositionEnd(editor);
  });

  it('ignores a space keydown flagged isComposing by the browser', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const editor = surface();
    typeText(editor.querySelector('p')!, '3.');

    const notPrevented = fireEvent.keyDown(editor, {
      key: ' ',
      isComposing: true,
    });

    expect(notPrevented).toBe(true);
    expect(lists()).toHaveLength(0);
  });

  it('converts "》" committed by the IME when compositionend emits no input', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const editor = surface();
    const line = editor.querySelector('p')!;
    caretAtEnd(line);

    compositionStart(editor);
    typeText(line, '》');
    fireEvent.input(editor);
    expect(surface().querySelector('blockquote')).toBeNull();
    compositionEnd(editor);

    const quote = surface().querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote!.textContent).toBe('');
    expect(caretInside(quote!)).toBe(true);
  });

  it('converts "》" only when the whole line is the marker', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const editor = surface();
    const line = editor.querySelector('p')!;

    compositionStart(editor);
    typeText(line, '前》');
    compositionEnd(editor);

    expect(surface().querySelector('blockquote')).toBeNull();
    expect(surface().querySelector('p')!.textContent).toBe('前》');
  });

  it('converts "3. " when the IME commits the trailing space too', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const editor = surface();
    const line = editor.querySelector('p')!;
    caretAtEnd(line);

    compositionStart(editor);
    typeText(line, '3. ');
    fireEvent.input(editor);
    expect(lists()).toHaveLength(0);
    compositionEnd(editor);

    const list = lists()[0]!;
    expect(list.tagName).toBe('OL');
    expect(list.getAttribute('start')).toBe('3');
    expect(caretInside(list.querySelector('li')!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 第 13 项: the quote marker converts only as "marker + space". `>` already
// worked; the full-width `》` a Chinese IME produces must behave the same, and
// the old immediate conversion on the bare `》` keydown is gone.
// ---------------------------------------------------------------------------

describe('第 13 项 引用标记标准输入', () => {
  it('converts ">" followed by space into an empty blockquote', () => {
    const props = renderEditor({ initialHtml: '<p><br></p>' });
    const line = surface().querySelector('p')!;
    typeText(line, '>');

    const notPrevented = fireEvent.keyDown(surface(), { key: ' ' });

    expect(notPrevented).toBe(false);
    const quotes = surface().querySelectorAll('blockquote');
    expect(quotes).toHaveLength(1);
    // The marker (and the space) are consumed, so the quote starts empty.
    expect(quotes[0]!.textContent).toBe('');
    expect(surface().textContent).toBe('');
    expect(caretInside(quotes[0]!)).toBe(true);
    expect(props.onChange).toHaveBeenCalled();
  });

  it('converts the full-width "》" followed by space the same way', () => {
    const props = renderEditor({ initialHtml: '<p><br></p>' });
    const line = surface().querySelector('p')!;
    typeText(line, '》');

    const notPrevented = fireEvent.keyDown(surface(), { key: ' ' });

    expect(notPrevented).toBe(false);
    const quotes = surface().querySelectorAll('blockquote');
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.textContent).toBe('');
    expect(surface().textContent).toBe('');
    expect(caretInside(quotes[0]!)).toBe(true);
    expect(props.onChange).toHaveBeenCalled();
  });

  it('does not convert a bare "》" keydown on an empty line', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const line = surface().querySelector('p')!;
    caretAtEnd(line);

    const notPrevented = fireEvent.keyDown(surface(), { key: '》' });

    expect(notPrevented).toBe(true);
    expect(surface().querySelector('blockquote')).toBeNull();
    const paragraph = surface().querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph!.textContent).toBe('');
  });

  it('converts ">" committed by the IME when compositionend emits no input', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const editor = surface();
    const line = editor.querySelector('p')!;
    caretAtEnd(line);

    compositionStart(editor);
    typeText(line, '>');
    fireEvent.input(editor);
    expect(editor.querySelector('blockquote')).toBeNull();
    compositionEnd(editor);

    const quote = editor.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote!.textContent).toBe('');
    expect(caretInside(quote!)).toBe(true);
  });

  it.each(['> ', '》 '])(
    'converts "%s" committed by the IME with the trailing space',
    (committed) => {
      renderEditor({ initialHtml: '<p><br></p>' });
      const editor = surface();
      const line = editor.querySelector('p')!;
      caretAtEnd(line);

      compositionStart(editor);
      typeText(line, committed);
      // Half-composed input must not convert early.
      fireEvent.input(editor);
      expect(editor.querySelector('blockquote')).toBeNull();
      compositionEnd(editor);

      const quote = editor.querySelector('blockquote');
      expect(quote).not.toBeNull();
      expect(quote!.textContent).toBe('');
      expect(caretInside(quote!)).toBe(true);
    },
  );

  it.each(['前》', '>x'])(
    'keeps "%s" as plain text when a space follows',
    (text) => {
      renderEditor({ initialHtml: '<p><br></p>' });
      const line = surface().querySelector('p')!;
      typeText(line, text);

      const notPrevented = fireEvent.keyDown(surface(), { key: ' ' });

      expect(notPrevented).toBe(true);
      expect(surface().querySelector('blockquote')).toBeNull();
      expect(line.tagName).toBe('P');
      expect(line.textContent).toBe(text);
    },
  );

  // A browser typing ">" or "》" fires an input event before the space key
  // arrives; the marker must stay text until the space (the input-path check
  // must not accept a bare marker, otherwise " typing > " turns the line into a
  // quote and the following space lands inside it).
  it.each(['>', '》'])(
    'keeps the marker "%s" as text when it is typed without the space',
    (marker) => {
      const props = renderEditor({ initialHtml: '<p><br></p>' });
      const editor = surface();
      const line = editor.querySelector('p')!;
      typeText(line, marker);

      fireEvent.input(editor, { inputType: 'insertText', data: marker });

      expect(editor.querySelector('blockquote')).toBeNull();
      expect(line.tagName).toBe('P');
      expect(line.textContent).toBe(marker);
      expect(props.onChange).toHaveBeenCalled();

      // The standard gesture still completes with the following space.
      const notPrevented = fireEvent.keyDown(editor, { key: ' ' });
      expect(notPrevented).toBe(false);
      const quote = editor.querySelector('blockquote');
      expect(quote).not.toBeNull();
      expect(quote!.textContent).toBe('');
      expect(caretInside(quote!)).toBe(true);
    },
  );

  it.each(['> ', '》 '])(
    'converts "%s" arriving in one plain input event',
    (committed) => {
      renderEditor({ initialHtml: '<p><br></p>' });
      const editor = surface();
      typeText(editor.querySelector('p')!, committed);

      fireEvent.input(editor, { inputType: 'insertText', data: committed });

      const quote = editor.querySelector('blockquote');
      expect(quote).not.toBeNull();
      expect(quote!.textContent).toBe('');
      expect(caretInside(quote!)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 分割线即时转换：整行输入 "---" 立即变成分割线，不需要回车
// ---------------------------------------------------------------------------

function divider(): HTMLElement | null {
  return surface().querySelector<HTMLElement>('[data-divider]');
}

/** One element's next sibling among the editor's top-level blocks. */
function nextBlock(element: HTMLElement): HTMLElement | null {
  const next = element.nextElementSibling;
  return next instanceof HTMLElement ? next : null;
}

describe('分割线即时转换', () => {
  it('turns "---" into a divider on input without pressing Enter', () => {
    const props = renderEditor({ initialHtml: '<p><br></p>' });
    const line = surface().querySelector('p')!;

    typeText(line, '---');
    fireEvent.input(surface(), { inputType: 'insertText', data: '-' });

    const created = divider();
    expect(created).not.toBeNull();
    expect(created!.querySelector('hr')).not.toBeNull();
    // The marker text is consumed, not kept next to the rule.
    expect(surface().textContent).not.toContain('---');
    expect(surface().firstElementChild).toBe(created);
    const following = nextBlock(created!);
    expect(following).not.toBeNull();
    expect(following!.tagName).toBe('P');
    expect(caretInside(following!)).toBe(true);
    expect(props.onChange).toHaveBeenCalled();
  });

  it('ignores a delete input that leaves the line as "---"', () => {
    renderEditor({ initialHtml: '<p>---</p>' });
    const line = surface().querySelector('p')!;
    caretAtEnd(line);

    fireEvent.input(surface(), { inputType: 'deleteContentBackward' });

    expect(divider()).toBeNull();
    expect(surface().querySelector('p')!.textContent).toBe('---');
  });

  it.each([
    ['h2', '<h2><br></h2>', 'h2'],
    ['blockquote', '<blockquote><br></blockquote>', 'blockquote'],
  ])('converts a divider typed on an empty %s line', (_name, html, tag) => {
    renderEditor({ initialHtml: html });
    typeText(surface().querySelector(tag)!, '---');

    fireEvent.input(surface());

    expect(divider()).not.toBeNull();
    expect(surface().querySelector(tag)).toBeNull();
  });

  it('keeps incomplete or embedded markers as text', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const line = surface().querySelector('p')!;

    typeText(line, '--');
    fireEvent.input(surface());
    expect(divider()).toBeNull();
    expect(line.textContent).toBe('--');

    typeText(line, '前---');
    fireEvent.input(surface());
    expect(divider()).toBeNull();
    expect(line.textContent).toBe('前---');
  });

  it('does not convert when the caret is not at the end of the marker', () => {
    renderEditor({ initialHtml: '<p>---</p>' });
    const line = surface().querySelector('p')!;
    caretAt(line.firstChild!, 0);

    fireEvent.input(surface());

    expect(divider()).toBeNull();
    expect(surface().querySelector('p')!.textContent).toBe('---');
  });

  it('keeps "---" literal inside a code block', () => {
    renderEditor({ initialHtml: '<pre data-code=""><code><br></code></pre>' });
    typeText(surface().querySelector('code')!, '---');

    fireEvent.input(surface());

    expect(divider()).toBeNull();
    expect(surface().querySelector('pre code')!.textContent).toBe('---');
  });

  it('keeps "---" literal inside a list item', () => {
    renderEditor({ initialHtml: '<ul><li><br></li></ul>' });
    typeText(surface().querySelector('ul > li')!, '---');

    fireEvent.input(surface());

    expect(divider()).toBeNull();
    expect(surface().querySelector('ul > li')!.textContent).toBe('---');
  });

  it('converts "---" committed by the IME only after the composition ends', () => {
    renderEditor({ initialHtml: '<p><br></p>' });
    const editor = surface();
    const line = editor.querySelector('p')!;

    compositionStart(editor);
    typeText(line, '---');
    fireEvent.input(editor);
    expect(divider()).toBeNull();

    compositionEnd(editor);
    expect(divider()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AST compatibility of the auto-converted markers
// ---------------------------------------------------------------------------

describe('转换结果与 AST 兼容', () => {
  it('round-trips the typed start through the legacy adapter', () => {
    const props = renderEditor({ initialHtml: '<p><br></p>' });
    typeText(surface().querySelector('p')!, '3.');
    fireEvent.keyDown(surface(), { key: ' ' });

    const calls = props.onChange.mock.calls;
    const html = String(calls.at(-1)?.[0] ?? '');
    expect(html).toContain('<ol start="3">');

    const parsed = parseLegacyHtml(html);
    expect(parsed.blocks).toHaveLength(1);
    const list = parsed.blocks[0]!;
    expect(list.type).toBe('orderedList');
    expect(list.attrs.start).toBe(3);
    expect(list.children?.[0]?.type).toBe('listItem');

    const doc: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: parsed.blocks,
    };
    const reparsed = parseLegacyHtml(alterDocToEditorHtml(doc));
    expect(reparsed.blocks[0]!.type).toBe('orderedList');
    expect(reparsed.blocks[0]!.attrs.start).toBe(3);
  });

  it('round-trips a plain "1. " marker without a start attribute', () => {
    const props = renderEditor({ initialHtml: '<p><br></p>' });
    typeText(surface().querySelector('p')!, '1.');
    fireEvent.keyDown(surface(), { key: ' ' });

    const html = String(props.onChange.mock.calls.at(-1)?.[0] ?? '');
    const parsed = parseLegacyHtml(html);
    expect(parsed.blocks[0]!.type).toBe('orderedList');
    expect(parsed.blocks[0]!.attrs.start).toBeUndefined();
  });

  it('round-trips a split list around the removed empty item', () => {
    const props = renderEditor({
      initialHtml: '<ol><li>一</li><li><br></li><li>三</li></ol>',
    });
    caretAt(surface().querySelectorAll('ol > li')[1]!, 0);
    fireEvent.keyDown(surface(), { key: 'Backspace' });

    const html = String(props.onChange.mock.calls.at(-1)?.[0] ?? '');
    const parsed = parseLegacyHtml(html);
    expect(parsed.blocks.map((block) => block.type)).toEqual([
      'orderedList',
      'paragraph',
      'orderedList',
    ]);
    expect(parsed.blocks[2]!.attrs.start).toBe(3);
  });

  it('round-trips the divider produced by a typed "---"', () => {
    const props = renderEditor({ initialHtml: '<p><br></p>' });
    typeText(surface().querySelector('p')!, '---');
    fireEvent.input(surface());

    const html = String(props.onChange.mock.calls.at(-1)?.[0] ?? '');
    expect(html).toContain('data-divider');
    const parsed = parseLegacyHtml(html);
    expect(parsed.blocks.map((block) => block.type)).toEqual([
      'divider',
      'paragraph',
    ]);
  });
});
