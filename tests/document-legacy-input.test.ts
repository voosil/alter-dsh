// @vitest-environment jsdom
/**
 * Legacy editor input robustness (C3/C4/D1/D3/D5).
 *
 * Locks the input layer of the restored pre-rebuild contentEditable editor:
 * clipboard sanitizing and media insertion, IME composition suppression,
 * empty-list-item deletion and keyboard/ARIA labels. The editor DOM/CSS is
 * frozen; these tests assert behavior, not markup structure.
 *
 * Real-browser verification (native insertHTML, actual IME, drag from OS) is
 * tracked by G3; the jsdom coverage here is the automated baseline.
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
import { Editor } from '../vendor/ui-space/src/components/editor/Editor';
import { sanitizePastedHtml } from '../vendor/ui-space/src/components/editor/editor-utils';

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

function stubExecCommand(result = true): void {
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: vi.fn(() => result) as unknown as ExecCommand,
  });
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

/** Dispatch one clipboard/drag event with a synthetic dataTransfer. */
function dispatchDataTransfer(
  type: 'paste' | 'drop' | 'dragover',
  data: { html?: string; text?: string; files?: File[] },
): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: data.files ?? [],
      types: [
        ...(data.files === undefined ? [] : ['Files']),
        ...(data.html === undefined ? [] : ['text/html']),
        ...(data.text === undefined ? [] : ['text/plain']),
      ],
      getData: (format: string) => {
        if (format === 'text/html') return data.html ?? '';
        if (format === 'text/plain') return data.text ?? '';
        return '';
      },
    },
  });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files: data.files ?? [],
      types: [
        ...(data.files === undefined ? [] : ['Files']),
        ...(data.html === undefined ? [] : ['text/html']),
        ...(data.text === undefined ? [] : ['text/plain']),
      ],
      dropEffect: 'none',
      getData: (format: string) => {
        if (format === 'text/html') return data.html ?? '';
        if (format === 'text/plain') return data.text ?? '';
        return '';
      },
    },
  });
  return surface().dispatchEvent(event);
}

function imageFile(name = 'pic.png'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
}

function pasteHtml(html: string, overrides: EditorOverrides = {}) {
  const props = renderEditor(overrides);
  dispatchDataTransfer('paste', { html });
  return props;
}

// ---------------------------------------------------------------------------
// C4: clipboard sanitizing
// ---------------------------------------------------------------------------

function sanitizedContainer(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = sanitizePastedHtml(html).html;
  return container;
}

describe('C4 paste sanitizing', () => {
  it('removes executable elements, event handlers and dangerous URLs', () => {
    const result = sanitizePastedHtml(
      '<p onclick="alert(1)">安全文字<script>alert(1)</script>' +
        '<img src="javascript:alert(1)">' +
        '<a href="javascript:alert(1)">坏链</a>' +
        '<a href="https://example.com">好链</a></p>' +
        '<iframe src="https://evil.example"></iframe><style>p{}</style>' +
        '<object data="x"></object><embed src="x">' +
        '<form action="/x"><input value="1"></form>' +
        '<link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0">',
    );
    const container = sanitizedContainer(
      '<p onclick="alert(1)">安全文字<script>alert(1)</script>' +
        '<img src="javascript:alert(1)">' +
        '<a href="javascript:alert(1)">坏链</a>' +
        '<a href="https://example.com">好链</a></p>' +
        '<iframe src="https://evil.example"></iframe><style>p{}</style>' +
        '<object data="x"></object><embed src="x">' +
        '<form action="/x"><input value="1"></form>' +
        '<link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0">',
    );
    expect(
      container.querySelector('script,style,iframe,object,embed,form,input,link,meta'),
    ).toBeNull();
    for (const element of container.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(/javascript:/i.test(attribute.value)).toBe(false);
      }
    }
    expect(container.textContent).toContain('安全文字');
    expect(container.textContent).toContain('坏链');
    expect(container.querySelector('a[href="https://example.com"]')).toBeTruthy();
    expect(result.simplified).toBe(true);
  });

  it('keeps supported rich structure, marks, links and inline images', () => {
    const html =
      '<h2>标题</h2><ul><li>项目</li></ul><blockquote>引用</blockquote>' +
      '<pre><code class="language-ts">const a = 1;</code></pre>' +
      '<table><thead><tr><th>列</th></tr></thead><tbody><tr><td>值</td></tr></tbody></table>' +
      '<p><strong>粗</strong><em>斜</em><u>下</u><s>删</s><code>码</code><mark>高</mark>' +
      '<a href="https://example.com">链</a>' +
      '<img src="data:image/png;base64,AAAA" alt="图"></p>';
    const result = sanitizePastedHtml(html);
    const container = sanitizedContainer(html);
    expect(result.simplified).toBe(false);
    expect(container.querySelector('h2')?.textContent).toBe('标题');
    expect(container.querySelector('ul li')?.textContent).toBe('项目');
    expect(container.querySelector('blockquote')?.textContent).toBe('引用');
    expect(container.querySelector('pre')?.getAttribute('data-lang')).toBe('ts');
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1;');
    expect(container.querySelector('table th')?.textContent).toBe('列');
    expect(container.querySelector('table td')?.textContent).toBe('值');
    expect(container.querySelector('strong')?.textContent).toBe('粗');
    expect(container.querySelector('em')?.textContent).toBe('斜');
    expect(container.querySelector('u')?.textContent).toBe('下');
    expect(container.querySelector('s')?.textContent).toBe('删');
    expect(container.querySelector('mark')?.textContent).toBe('高');
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com',
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('图');
  });

  it('preserves the legacy card/block syntax when pasting internally', () => {
    const html =
      '<div data-todo data-checked="true"><span data-todo-box contenteditable="false"></span>' +
      '<span data-todo-text>待办事项</span></div>' +
      '<div data-divider contenteditable="false"><hr></div>' +
      '<span data-file="a.pdf" data-href="data:application/pdf;base64,AAAA" data-size="3 B">' +
      '<span data-file-icon contenteditable="false"></span>a.pdf · 3 B</span>' +
      '<a data-doc-link="doc-2" href="#/space/sp-1/doc/doc-2">文档二</a>' +
      '<a data-link-card="https://example.com" href="https://example.com">' +
      '<strong>示例</strong><span>描述</span></a>';
    const result = sanitizePastedHtml(html);
    const container = sanitizedContainer(html);
    const todo = container.querySelector<HTMLElement>('div[data-todo]');
    expect(todo?.dataset.checked).toBe('true');
    expect(todo?.querySelector('[data-todo-text]')?.textContent).toBe('待办事项');
    expect(container.querySelector('div[data-divider] hr')).toBeTruthy();
    const file = container.querySelector<HTMLElement>('span[data-file]');
    expect(file?.dataset.href).toBe('data:application/pdf;base64,AAAA');
    expect(file?.getAttribute('role')).toBe('link');
    expect(container.querySelector('a[data-doc-link="doc-2"]')?.textContent).toBe(
      '文档二',
    );
    const card = container.querySelector<HTMLElement>('a[data-link-card]');
    expect(card?.dataset.linkCard).toBe('https://example.com');
    expect(card?.querySelector('strong')?.textContent).toBe('示例');
    expect(result.simplified).toBe(false);
  });

  it('drops duplicate block ids, unsupported media and unsafe attachments', () => {
    const result = sanitizePastedHtml(
      '<p data-block-id="blk_dup" data-paragraph-id="blk_p">文本</p>' +
        '<video src="https://x/video.mp4"></video>' +
        '<h4>四级标题</h4>' +
        '<span data-file="evil.html" data-href="data:text/html;base64,AAAA">evil</span>' +
        '<img src="data:image/svg+xml;base64,AAAA">',
    );
    const container = sanitizedContainer(
      '<p data-block-id="blk_dup" data-paragraph-id="blk_p">文本</p>' +
        '<video src="https://x/video.mp4"></video>' +
        '<h4>四级标题</h4>' +
        '<span data-file="evil.html" data-href="data:text/html;base64,AAAA">evil</span>' +
        '<img src="data:image/svg+xml;base64,AAAA">',
    );
    expect(container.querySelector('[data-block-id]')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('h4')).toBeNull();
    expect(
      [...container.querySelectorAll('p')].some((item) =>
        (item.textContent ?? '').includes('四级标题'),
      ),
    ).toBe(true);
    expect(container.querySelector('span[data-file]')).toBeNull();
    expect(container.textContent).toContain('evil');
    expect(container.querySelector('img')).toBeNull();
    expect(result.simplified).toBe(true);
  });

  it('reports an empty result when only unsafe content was pasted', () => {
    const result = sanitizePastedHtml('<script>alert(1)</script><style>x{}</style>');
    expect(result.empty).toBe(true);
    expect(result.html).toBe('');
  });
});

// ---------------------------------------------------------------------------
// C4/C3: paste and drop wiring through the editor
// ---------------------------------------------------------------------------

describe('C4/C3 editor paste and drop', () => {
  it('sanitizes pasted HTML before inserting it into the editor', async () => {
    const props = renderEditor({ onNotice: vi.fn() });
    dispatchDataTransfer('paste', {
      html:
        '<h2>粘贴标题</h2><p onclick="alert(1)">粘贴正文<script>alert(1)</script>' +
        '<a href="javascript:alert(1)">坏链</a></p>',
    });
    await waitFor(() =>
      expect(surface().querySelector('h2')?.textContent).toBe('粘贴标题'),
    );
    expect(surface().textContent).toContain('粘贴正文');
    expect(surface().textContent).toContain('坏链');
    expect(surface().querySelector('script')).toBeNull();
    expect(surface().innerHTML).not.toMatch(/onclick/i);
    expect(surface().innerHTML).not.toMatch(/javascript:/i);
    expect(props.onChange).toHaveBeenCalled();
  });

  it('preserves supported structures when pasting rich text', async () => {
    renderEditor();
    dispatchDataTransfer('paste', {
      html:
        '<ul><li>粘贴项目</li></ul><table><tbody><tr><td>粘贴单元格</td></tr></tbody></table>' +
        '<p><strong>粘贴粗体</strong></p>',
    });
    await waitFor(() =>
      expect(surface().querySelector('ul li')?.textContent).toBe('粘贴项目'),
    );
    expect(surface().querySelector('table td')?.textContent).toBe('粘贴单元格');
    expect(surface().querySelector('strong')?.textContent).toBe('粘贴粗体');
  });

  it('notices simplified pasted content through the optional prop', async () => {
    const onNotice = vi.fn();
    renderEditor({ onNotice });
    dispatchDataTransfer('paste', {
      html: '<video src="https://x/v.mp4"></video><p>保留内容</p>',
    });
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith('部分粘贴内容已简化'),
    );
    expect(surface().textContent).toContain('保留内容');
  });

  it('falls back to console.warn when no notice handler is wired', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderEditor();
    dispatchDataTransfer('paste', {
      html: '<iframe src="https://x"></iframe><p>保留内容</p>',
    });
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('部分粘贴内容已简化'),
      ),
    );
  });

  it('keeps plain-text paste unaffected', async () => {
    const props = renderEditor();
    caretAt(surface().querySelector('p')!.firstChild!, 0);
    dispatchDataTransfer('paste', { text: '纯文本 <b>不是标签</b>' });
    await waitFor(() =>
      expect(surface().textContent).toContain('纯文本 <b>不是标签</b>'),
    );
    expect(surface().querySelector('b')).toBeNull();
    expect(props.onChange).toHaveBeenCalled();
  });

  it('inserts pasted image files as legacy data-URL images', async () => {
    const props = renderEditor();
    dispatchDataTransfer('paste', { files: [imageFile()] });
    await waitFor(() =>
      expect(
        surface().querySelector('img[src^="data:image/png"]'),
      ).toBeTruthy(),
    );
    expect(props.onChange).toHaveBeenCalled();
  });

  it('inserts dropped image files and sanitizes dropped HTML', async () => {
    renderEditor();
    dispatchDataTransfer('drop', { files: [imageFile('drop.png')] });
    await waitFor(() =>
      expect(
        surface().querySelector('img[src^="data:image/png"]'),
      ).toBeTruthy(),
    );
    dispatchDataTransfer('drop', {
      html: '<p>拖入文字<script>alert(1)</script></p>',
    });
    await waitFor(() => expect(surface().textContent).toContain('拖入文字'));
    expect(surface().querySelector('script')).toBeNull();
  });

  it('accepts file drags and inserts attachment chips with labels', async () => {
    renderEditor();
    const dragover = dispatchDataTransfer('dragover', { files: [imageFile()] });
    expect(dragover).toBe(false);
    dispatchDataTransfer('paste', {
      files: [new File(['pdf'], 'a.pdf', { type: 'application/pdf' })],
    });
    await waitFor(() =>
      expect(surface().querySelector('span[data-file]')).toBeTruthy(),
    );
    const chip = surface().querySelector<HTMLElement>('span[data-file]')!;
    expect(chip.getAttribute('role')).toBe('link');
    expect(chip.getAttribute('tabindex')).toBe('0');
    expect(chip.getAttribute('aria-label')).toBe('打开文件 a.pdf');
    expect(chip.getAttribute('contenteditable')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// D1: IME composition
// ---------------------------------------------------------------------------

describe('D1 IME composition', () => {
  it('suppresses slash menus and change commits during composition', async () => {
    const onChange = vi.fn();
    const onCompositionChange = vi.fn();
    renderEditor({
      initialHtml: '<p><br></p>',
      onChange,
      onCompositionChange,
    });
    const editor = surface();
    caretAt(editor.querySelector('p')!, 0);

    editor.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(onCompositionChange).toHaveBeenCalledWith(true);
    expect(onCompositionChange).toHaveBeenCalledTimes(1);

    // Half-composed input must not be committed and must not open the menu.
    fireEvent.keyDown(editor, { key: '/' });
    expect(screen.queryByRole('listbox', { name: '插入内容' })).toBeNull();
    editor.querySelector('p')!.textContent = '组合中';
    fireEvent.input(editor);
    expect(onChange).not.toHaveBeenCalled();

    editor.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(onCompositionChange).toHaveBeenCalledWith(false);
    expect(onChange).toHaveBeenCalled();
  });

  it('opens the slash menu normally after composition ends', async () => {
    stubExecCommand(true);
    renderEditor({ initialHtml: '<p><br></p>' });
    const editor = surface();
    caretAt(editor.querySelector('p')!, 0);
    editor.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    editor.dispatchEvent(new Event('compositionend', { bubbles: true }));
    fireEvent.keyDown(editor, { key: '/' });
    await waitFor(() =>
      expect(screen.getByRole('listbox', { name: '插入内容' })).toBeTruthy(),
    );
  });
});

// ---------------------------------------------------------------------------
// D3: empty list item deletion
// ---------------------------------------------------------------------------

describe('D3 empty list item deletion', () => {
  it('deletes an empty middle list item and keeps the caret on the current line', () => {
    // 2026-11-11《编辑器专题优化》第 2 项：空列表项退格后该行退化为空段落，
    // 光标停在当前行行首，不再跳回上一列表项行尾；列表由此断成前后两段。
    const props = renderEditor({
      initialHtml: '<ul><li>第一项</li><li><br></li><li>第三项</li></ul>',
    });
    const list = surface().querySelector('ul')!;
    caretAt(list.children[1]!, 0);
    const notPrevented = fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(notPrevented).toBe(false);
    const lists = [...surface().querySelectorAll('ul')];
    expect(lists).toHaveLength(2);
    expect([...lists[0]!.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '第一项',
    ]);
    expect([...lists[1]!.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '第三项',
    ]);
    const paragraph = surface().querySelector('p')!;
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    expect(paragraph.contains(selection!.anchorNode)).toBe(true);
    const before = document.createRange();
    before.selectNodeContents(paragraph);
    before.setEnd(selection!.anchorNode!, selection!.anchorOffset);
    expect(before.toString()).toBe('');
    expect(props.onChange).toHaveBeenCalled();
  });

  it('deletes a leading empty item and keeps the caret on the current line', () => {
    // 2026-11-11《编辑器专题优化》第 2 项：同 middle，空段落留在列表之前。
    renderEditor({ initialHtml: '<ul><li><br></li><li>第二项</li></ul>' });
    caretAt(surface().querySelector('ul > li')!, 0);
    fireEvent.keyDown(surface(), { key: 'Backspace' });
    const paragraph = surface().querySelector('p')!;
    expect(surface().firstElementChild).toBe(paragraph);
    const items = [...surface().querySelectorAll('ul > li')];
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toBe('第二项');
    const selection = window.getSelection();
    expect(paragraph.contains(selection!.anchorNode)).toBe(true);
    const before = document.createRange();
    before.selectNodeContents(paragraph);
    before.setEnd(selection!.anchorNode!, selection!.anchorOffset);
    expect(before.toString()).toBe('');
  });

  it('replaces a single empty list with a paragraph', () => {
    renderEditor({ initialHtml: '<ul><li><br></li></ul>' });
    caretAt(surface().querySelector('ul > li')!, 0);
    fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(surface().querySelector('ul')).toBeNull();
    const paragraph = surface().querySelector('p');
    expect(paragraph).toBeTruthy();
    expect(paragraph!.contains(window.getSelection()!.anchorNode)).toBe(true);
  });

  it('keeps ordered list numbering after splitting an empty middle item', () => {
    // 2026-11-11《编辑器专题优化》第 2 项：空列表项删除后列表断成两段，
    // 后段用 start 维持原序号（一 / 空 / 三 → 一 + 空段落 + start=3 的三）。
    renderEditor({ initialHtml: '<ol><li>一</li><li><br></li><li>三</li></ol>' });
    caretAt(surface().querySelectorAll('ol > li')[1]!, 0);
    fireEvent.keyDown(surface(), { key: 'Delete' });
    const lists = [...surface().querySelectorAll('ol')];
    expect(lists).toHaveLength(2);
    expect([...lists[0]!.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '一',
    ]);
    expect([...lists[1]!.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '三',
    ]);
    expect(lists[1]!.getAttribute('start')).toBe('3');
    expect(surface().querySelector('p')).toBeTruthy();
  });

  it('leaves non-empty list items to the browser default behavior', () => {
    renderEditor({ initialHtml: '<ul><li>文字</li></ul>' });
    const item = surface().querySelector('ul > li')!;
    caretAt(item, 1);
    const notPrevented = fireEvent.keyDown(surface(), { key: 'Backspace' });
    expect(notPrevented).toBe(true);
    expect(surface().querySelectorAll('ul > li')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D5: keyboard and accessibility labels
// ---------------------------------------------------------------------------

describe('D5 keyboard and ARIA labels', () => {
  it('labels the editor surface for assistive technology', () => {
    renderEditor();
    const editor = surface();
    expect(editor.getAttribute('aria-label')).toBe('文档正文');
    expect(editor.getAttribute('aria-multiline')).toBe('true');
    expect(editor.getAttribute('role')).toBe('textbox');
  });

  it('exposes the selection toolbar with readable button labels', async () => {
    const original = Range.prototype.getClientRects;
    const rect = { ...zeroRect(), width: 12, height: 12, top: 30, left: 30 };
    Range.prototype.getClientRects = function getClientRects() {
      const rects = [rect];
      (rects as unknown as { item: () => DOMRect }).item = () => rect;
      return rects as unknown as DOMRectList;
    };
    try {
      renderEditor({ initialHtml: '<p>可选择文字</p>' });
      const text = surface().querySelector('p')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await waitFor(() =>
        expect(
          screen.getByRole('toolbar', { name: '文本格式' }),
        ).toBeTruthy(),
      );
      for (const name of [
        '文本类型',
        '粗体',
        '下划线',
        '删除线',
        '行内代码',
        '高亮',
        '添加评论',
      ]) {
        expect(screen.getByRole('button', { name })).toBeTruthy();
      }
    } finally {
      Range.prototype.getClientRects = original;
    }
  });

  it('labels the link actions opened from a link card', async () => {
    renderEditor({
      initialHtml:
        '<p><a data-web-link href="https://example.com">示例链接</a></p>',
    });
    fireEvent.mouseOver(surface().querySelector('a[data-web-link]')!);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '编辑链接' })).toBeTruthy(),
    );
    expect(screen.getByRole('group', { name: '链接操作' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '转为卡片链接' }),
    ).toBeTruthy();
  });
});
