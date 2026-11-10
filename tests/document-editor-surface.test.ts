// @vitest-environment jsdom
/**
 * P1 editor writing surface: slash menu, inline formatting and link bar,
 * tables, image insertion (picker/paste/drop), paste routing, Markdown input
 * rules and IME guards.
 *
 * The editor is mounted directly (not through `AlterDocumentView`) so the
 * assertions target the writing surface only. Image uploads are injected via
 * the `uploadImage` seam; the `doc.importAsset` default path is covered by the
 * missing-method and validation cases.
 */
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Editor } from '@tiptap/core';
import {
  AlterTiptapEditor,
  MAX_IMAGE_BYTES,
  validateImageFile,
  type ImageAssetResult,
} from '../src/document/editor/AlterTiptapEditor';
import {
  isWebUrl,
  normalizeLinkHref,
  parseInternalDocLink,
} from '../src/document/editor/link-bar';
import {
  filterSlashCommands,
  slashCommands,
} from '../src/document/editor/slash-menu';
import type { SpaceDocumentClient } from '../src/space-client';
import type { AlterDoc } from '../src/document/types';

// jsdom has no layout engine; ProseMirror calls these on elements and ranges.
if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
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
  };
}

if (typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = function elementFromPoint() {
    return document.querySelector('[data-doc-editor="tiptap"] .ProseMirror');
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const emptyDoc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [{ id: 'blk_p', type: 'paragraph', attrs: {}, content: [] }],
};

const textDoc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [
    {
      id: 'blk_p',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '链接文字' }],
    },
  ],
};

const linkedDoc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [
    {
      id: 'blk_p',
      type: 'paragraph',
      attrs: {},
      content: [
        {
          type: 'text',
          text: '链接文字',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
        },
      ],
    },
  ],
};

interface MountOptions {
  initialDoc?: AlterDoc;
  uploadImage?: (file: File) => Promise<ImageAssetResult>;
  importAsset?: (input: {
    mime: string;
    dataBase64: string;
    name?: string;
  }) => Promise<ImageAssetResult>;
  applyOperations?: Mock;
  title?: string;
}

interface Harness {
  editor: () => Editor;
  applyOperations: Mock;
  get: Mock;
}

function mount(options: MountOptions = {}): Harness {
  const initialDoc = options.initialDoc ?? emptyDoc;
  const revision = initialDoc.revision;
  const applyOperations =
    options.applyOperations ??
    vi.fn(async () => ({
      docId: 'doc-surface',
      revision: revision + 1,
      changedBlockIds: [],
      diff: {},
      warnings: [],
    }));
  const get = vi.fn(async () => ({
    docId: 'doc-surface',
    revision,
    title: options.title ?? '测试文档',
    doc: initialDoc,
  }));
  const client = {
    get,
    applyOperations,
    importAsset: options.importAsset,
    async outline() {
      return {};
    },
    async read() {
      return { markdown: '', revision };
    },
    async search() {
      return {};
    },
    async undo() {
      return {};
    },
    async restoreVersion() {
      return {};
    },
    async generate() {
      return {};
    },
    async getObject() {
      return {};
    },
  } as unknown as SpaceDocumentClient;
  let captured: Editor | undefined;
  render(
    createElement(AlterTiptapEditor, {
      docId: 'doc-surface',
      initialDoc,
      baseRevision: revision,
      initialTitle: options.title ?? '测试文档',
      title: options.title ?? '测试文档',
      client,
      onSaved: () => {},
      uploadImage: options.uploadImage,
      onEditorReady: (instance: Editor) => {
        captured = instance;
      },
    }),
  );
  if (captured === undefined) throw new Error('editor instance was not ready');
  return {
    editor: () => {
      if (captured === undefined) throw new Error('editor instance was not ready');
      return captured;
    },
    applyOperations,
    get,
  };
}

function editorDom(): HTMLElement {
  const dom = document.querySelector(
    '[data-doc-editor="tiptap"] .ProseMirror',
  );
  if (dom === null) throw new Error('editor surface is missing');
  return dom as HTMLElement;
}

interface PasteData {
  text?: string;
  html?: string;
  files?: File[];
}

function clipboard(data: PasteData) {
  const files = data.files ?? [];
  return {
    files,
    types: [
      ...(data.text === undefined ? [] : ['text/plain']),
      ...(data.html === undefined ? [] : ['text/html']),
      ...(files.length === 0 ? [] : ['Files']),
    ],
    getData: (type: string): string => {
      if (type === 'text/plain') return data.text ?? '';
      if (type === 'text/html') return data.html ?? '';
      return '';
    },
  };
}

/** Dispatch a real paste event through the ProseMirror surface. */
function paste(data: PasteData): boolean {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboard(data) });
  act(() => {
    editorDom().dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** Dispatch a real drop event with a file list. */
function dropFiles(files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files,
      types: ['Files'],
      getData: () => '',
    },
  });
  act(() => {
    editorDom().dispatchEvent(event);
  });
}

function press(key: string): void {
  fireEvent.keyDown(editorDom(), { key });
}

/**
 * Simulate character-by-character typing so ProseMirror input rules run:
 * each character goes through `handleTextInput` before being inserted.
 */
function typeChars(editor: Editor, text: string): void {
  for (const char of text) {
    const view = editor.view;
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (handler) =>
      handler(view, from, to, char),
    );
    if (handled !== true) editor.commands.insertContent(char);
  }
}

function jsonOf(harness: Harness): string {
  return JSON.stringify(harness.editor().getJSON());
}

function firstBlock(harness: Harness): Record<string, unknown> {
  const doc = harness.editor().getJSON();
  const first = doc.content?.[0];
  if (first === undefined) throw new Error('document has no blocks');
  return first as Record<string, unknown>;
}

function countNodes(harness: Harness, type: string): number {
  let count = 0;
  harness
    .editor()
    .state.doc.descendants((node) => {
      if (node.type.name === type) count += 1;
      return true;
    });
  return count;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const pngFile = (name = 'pic.png'): File =>
  new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });

function imageUploader(
  result: Partial<ImageAssetResult> = {},
): (file: File) => Promise<ImageAssetResult> {
  return vi.fn(async (file: File) => ({
    assetId: 'asset_1',
    mime: file.type,
    bytes: file.size,
    ...result,
  }));
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

describe('editor toolbar', () => {
  it('exposes inline, heading, block and insert controls', () => {
    mount();
    for (const name of [
      '粗体',
      '斜体',
      '下划线',
      '删除线',
      '高亮',
      '行内代码',
      '链接',
      '一级标题',
      '二级标题',
      '三级标题',
      '无序列表',
      '有序列表',
      '任务列表',
      '引用块',
      '代码块',
      '插入表格',
      '插入图片',
      '插入分割线',
      '插入高亮信息块',
      '撤销',
      '重做',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('applies H3 from the toolbar', () => {
    const harness = mount();
    fireEvent.click(screen.getByRole('button', { name: '三级标题' }));
    expect(firstBlock(harness)['type']).toBe('heading');
    expect(firstBlock(harness)['attrs']).toMatchObject({ level: 3 });
  });

  it('only queues a save for real document changes, not toolbar UI', async () => {
    vi.useFakeTimers();
    const harness = mount();
    await settle();
    // Opening the link bar is pure UI: no document change, no save.
    fireEvent.click(screen.getByRole('button', { name: '链接' }));
    expect(screen.getByRole('dialog', { name: '编辑链接' })).toBeTruthy();
    await tick(900);
    expect(harness.applyOperations).not.toHaveBeenCalled();

    // A real toolbar transaction is autosaved once after the debounce.
    fireEvent.click(screen.getByRole('button', { name: '插入表格' }));
    expect(countNodes(harness, 'table')).toBe(1);
    await tick(700);
    expect(harness.applyOperations).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Slash menu
// ---------------------------------------------------------------------------

describe('slash menu', () => {
  it('opens on / in an empty paragraph and lists the old block commands', async () => {
    mount();
    paste({ text: '/' });
    const listbox = await screen.findByRole('listbox', { name: '插入内容' });
    const labels = within(listbox)
      .getAllByRole('option')
      .map((option) => option.getAttribute('aria-label'));
    for (const label of [
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
      '高亮块',
      '网页链接卡',
    ]) {
      expect(labels).toContain(label);
    }
  });

  it('filters by keyword and executes the selected command', async () => {
    const harness = mount();
    paste({ text: '/' });
    await screen.findByRole('listbox', { name: '插入内容' });
    paste({ text: '表格' });
    const listbox = screen.getByRole('listbox', { name: '插入内容' });
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.getAttribute('aria-label')),
    ).toEqual(['表格']);
    press('Enter');
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: '插入内容' })).toBeNull(),
    );
    expect(firstBlock(harness)['type']).toBe('table');
    // The typed `/表格` text was replaced, not left in the document.
    expect(jsonOf(harness)).not.toContain('"text":"/表格"');
  });

  it('moves the highlight with arrow keys and inserts the block', async () => {
    const harness = mount();
    paste({ text: '/' });
    await screen.findByRole('listbox', { name: '插入内容' });
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    expect(firstBlock(harness)['type']).toBe('heading');
    expect(firstBlock(harness)['attrs']).toMatchObject({ level: 2 });
  });

  it('closes on Escape without changing the paragraph', async () => {
    const harness = mount();
    paste({ text: '/' });
    await screen.findByRole('listbox', { name: '插入内容' });
    press('Escape');
    expect(screen.queryByRole('listbox', { name: '插入内容' })).toBeNull();
    expect(jsonOf(harness)).toContain('"text":"/"');
  });

  it('does not open inside a paragraph that already has text', async () => {
    const harness = mount({ initialDoc: textDoc });
    act(() => {
      harness.editor().commands.focus('end');
    });
    paste({ text: '/' });
    expect(screen.queryByRole('listbox', { name: '插入内容' })).toBeNull();
    expect(jsonOf(harness)).toContain('链接文字/');

    act(() => {
      harness.editor().commands.setTextSelection(1);
    });
    paste({ text: '/' });
    expect(screen.queryByRole('listbox', { name: '插入内容' })).toBeNull();
    expect(jsonOf(harness)).toContain('/链接文字');
  });

  it('does not open while an IME composition is active', async () => {
    const harness = mount();
    const view = harness.editor().view;
    const input = view.input as unknown as { composing: boolean };
    input.composing = true;
    try {
      paste({ text: '/' });
      expect(screen.queryByRole('listbox', { name: '插入内容' })).toBeNull();
    } finally {
      input.composing = false;
    }
    // Once the composition ends a fresh `/` opens the menu again.
    act(() => {
      harness.editor().commands.clearContent();
    });
    paste({ text: '/' });
    await screen.findByRole('listbox', { name: '插入内容' });
  });

  it('runs a command by clicking a menu entry', async () => {
    const harness = mount();
    paste({ text: '/' });
    const listbox = await screen.findByRole('listbox', { name: '插入内容' });
    fireEvent.click(within(listbox).getByRole('option', { name: /待办/ }));
    expect(firstBlock(harness)['type']).toBe('taskList');
  });

  it('clears the slash query when a toolbar action takes over', async () => {
    const harness = mount();
    paste({ text: '/' });
    await screen.findByRole('listbox', { name: '插入内容' });
    const tableButton = screen.getByRole('button', { name: '插入表格' });
    fireEvent.mouseDown(tableButton);
    fireEvent.click(tableButton);
    expect(countNodes(harness, 'table')).toBe(1);
    expect(jsonOf(harness)).not.toContain('"text":"/"');
  });

  it('keeps the command catalog filterable by label and keywords', () => {
    expect(filterSlashCommands(slashCommands, '待办').map((c) => c.id)).toEqual([
      'todo',
    ]);
    expect(filterSlashCommands(slashCommands, 'h2').map((c) => c.id)).toEqual([
      'h2',
    ]);
    expect(filterSlashCommands(slashCommands, '').length).toBe(
      slashCommands.length,
    );
  });
});

describe('card commands', () => {
  it('inserts a bookmark card through the slash menu URL prompt', async () => {
    const harness = mount();
    paste({ text: '/' });
    await screen.findByRole('listbox', { name: '插入内容' });
    paste({ text: '网页链接' });
    press('Enter');
    const dialog = await screen.findByRole('dialog', {
      name: '插入网页链接卡',
    });
    const input = within(dialog).getByLabelText('链接地址') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com/article' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));
    await waitFor(() => {
      const json = jsonOf(harness);
      expect(json).toContain('https://example.com/article');
      if (harness.editor().schema.nodes['alterBookmark'] !== undefined) {
        expect(json).toContain('"type":"alterBookmark"');
      }
    });
    expect(screen.queryByRole('dialog', { name: '插入网页链接卡' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function tableRowCount(harness: Harness): number {
  return countNodes(harness, 'tableRow');
}

function firstRowCellCount(harness: Harness): number {
  let cells = 0;
  harness
    .editor()
    .state.doc.descendants((node) => {
      if (node.type.name !== 'tableRow') return true;
      cells = node.childCount;
      return false;
    });
  return cells;
}

describe('tables', () => {
  it('inserts a table from the toolbar and supports row/column/delete actions', async () => {
    const harness = mount();
    fireEvent.click(screen.getByRole('button', { name: '插入表格' }));
    expect(firstBlock(harness)['type']).toBe('table');
    const tableBar = await screen.findByRole('toolbar', { name: '表格操作' });
    expect(within(tableBar).getByRole('button', { name: '下方插入行' })).toBeTruthy();
    expect(within(tableBar).getByRole('button', { name: '右侧插入列' })).toBeTruthy();
    expect(within(tableBar).getByRole('button', { name: '删除表格' })).toBeTruthy();
    expect(tableRowCount(harness)).toBe(3);
    expect(firstRowCellCount(harness)).toBe(3);

    fireEvent.click(within(tableBar).getByRole('button', { name: '下方插入行' }));
    expect(tableRowCount(harness)).toBe(4);
    fireEvent.click(within(tableBar).getByRole('button', { name: '右侧插入列' }));
    expect(firstRowCellCount(harness)).toBe(4);

    fireEvent.click(within(tableBar).getByRole('button', { name: '删除表格' }));
    expect(countNodes(harness, 'table')).toBe(0);
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: '表格操作' })).toBeNull(),
    );
  });

  it('inserts a table from the slash menu and stays undoable', async () => {
    const harness = mount();
    paste({ text: '/' });
    await screen.findByRole('listbox', { name: '插入内容' });
    paste({ text: '表格' });
    press('Enter');
    expect(countNodes(harness, 'table')).toBe(1);

    act(() => {
      harness.editor().commands.undo();
    });
    expect(countNodes(harness, 'table')).toBe(0);
    act(() => {
      harness.editor().commands.redo();
    });
    expect(countNodes(harness, 'table')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Inline formatting / link bar
// ---------------------------------------------------------------------------

describe('link bar', () => {
  it('creates a link on the selection, then edits and removes it', async () => {
    const harness = mount({ initialDoc: textDoc });
    act(() => {
      harness.editor().commands.setTextSelection({ from: 1, to: 5 });
    });
    fireEvent.click(screen.getByRole('button', { name: '链接' }));
    const dialog = screen.getByRole('dialog', { name: '编辑链接' });
    const input = within(dialog).getByLabelText('链接地址') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));
    await waitFor(() =>
      expect(jsonOf(harness)).toContain(
        '"href":"https://example.com"',
      ),
    );

    // Cursor inside the link: the bar edits the existing link.
    act(() => {
      harness.editor().commands.setTextSelection({ from: 2, to: 2 });
    });
    fireEvent.click(screen.getByRole('button', { name: '链接' }));
    const editDialog = screen.getByRole('dialog', { name: '编辑链接' });
    const editInput = within(editDialog).getByLabelText(
      '链接地址',
    ) as HTMLInputElement;
    expect(editInput.value).toBe('https://example.com');
    fireEvent.click(within(editDialog).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(jsonOf(harness)).not.toContain('"link"'));
  });

  it('rejects an invalid URL and keeps the bar open', () => {
    const harness = mount({ initialDoc: textDoc });
    act(() => {
      harness.editor().commands.setTextSelection({ from: 1, to: 5 });
    });
    fireEvent.click(screen.getByRole('button', { name: '链接' }));
    const dialog = screen.getByRole('dialog', { name: '编辑链接' });
    const input = within(dialog).getByLabelText('链接地址') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not a url' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));
    expect(within(dialog).getByRole('alert').textContent).toContain(
      '链接地址格式不正确',
    );
    expect(jsonOf(harness)).not.toContain('"link"');
  });

  it('inserts the URL as a link at a collapsed cursor', () => {
    const harness = mount();
    fireEvent.click(screen.getByRole('button', { name: '链接' }));
    const dialog = screen.getByRole('dialog', { name: '编辑链接' });
    const input = within(dialog).getByLabelText('链接地址') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com/a' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));
    expect(jsonOf(harness)).toContain('"href":"https://example.com/a"');
    expect(screen.queryByRole('dialog', { name: '编辑链接' })).toBeNull();
  });

  it('opens the bar when hovering a link in the document', async () => {
    mount({ initialDoc: linkedDoc });
    const anchor = document.querySelector(
      '[data-doc-editor="tiptap"] a[href]',
    );
    expect(anchor).toBeTruthy();
    fireEvent.mouseOver(anchor as Element);
    const dialog = await screen.findByRole('dialog', { name: '编辑链接' });
    expect(
      (within(dialog).getByLabelText('链接地址') as HTMLInputElement).value,
    ).toBe('https://example.com');
  });

  it('validates and normalizes URLs', () => {
    expect(normalizeLinkHref('https://example.com')).toBe('https://example.com');
    expect(normalizeLinkHref('example.com/path')).toBe(
      'https://example.com/path',
    );
    expect(normalizeLinkHref('/space/sp-1/doc/doc-1')).toBe(
      '/space/sp-1/doc/doc-1',
    );
    expect(normalizeLinkHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(normalizeLinkHref('not a url')).toBeUndefined();
    expect(normalizeLinkHref('   ')).toBeUndefined();
    expect(isWebUrl('https://example.com')).toBe(true);
    expect(isWebUrl('/space/sp-1/doc/doc-1')).toBe(false);
  });

  it('parses internal Space document links', () => {
    expect(parseInternalDocLink('/space/sp-1/doc/doc-9')).toEqual({
      spaceId: 'sp-1',
      docId: 'doc-9',
    });
    expect(
      parseInternalDocLink('https://host.example/space/sp-2/doc/doc-8?x=1'),
    ).toEqual({ spaceId: 'sp-2', docId: 'doc-8' });
    expect(parseInternalDocLink('https://example.com/article')).toBeUndefined();
    expect(parseInternalDocLink('随便一段文字')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

describe('image insertion', () => {
  it('uploads a picked image and inserts an alterImage block', async () => {
    const uploadImage = imageUploader();
    const harness = mount({ uploadImage });
    const input = screen.getByLabelText('选择图片') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });
    await waitFor(() => expect(jsonOf(harness)).toContain('"asset_1"'));
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(jsonOf(harness)).toContain('"type":"alterImage"');
    expect(jsonOf(harness)).toContain('"alt":"pic.png"');
  });

  it('reports 图片上传未启用 when the client has no importAsset', async () => {
    mount();
    const input = screen.getByLabelText('选择图片') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });
    expect(await screen.findByText('图片上传未启用')).toBeTruthy();
  });

  it('rejects unsupported files with a readable error and no upload', async () => {
    const uploadImage = imageUploader();
    mount({ uploadImage });
    const pdf = new File([new Uint8Array([1])], 'doc.pdf', {
      type: 'application/pdf',
    });
    const input = screen.getByLabelText('选择图片') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdf] } });
    expect(await screen.findByText(/仅支持 PNG\/JPEG\/WebP\/GIF/)).toBeTruthy();
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('uploads pasted image files', async () => {
    const uploadImage = imageUploader({ assetId: 'asset_paste' });
    const harness = mount({ uploadImage });
    expect(paste({ files: [pngFile()] })).toBe(true);
    await waitFor(() => expect(jsonOf(harness)).toContain('"asset_paste"'));
  });

  it('does not silently drop a pasted non-image file with text', async () => {
    const harness = mount();
    const pdf = new File([new Uint8Array([1])], 'doc.pdf', {
      type: 'application/pdf',
    });
    paste({ files: [pdf], text: '保留的文字' });
    expect(await screen.findByText(/不支持的文件类型/)).toBeTruthy();
    await waitFor(() => expect(jsonOf(harness)).toContain('保留的文字'));
  });

  it('uploads dropped image files', async () => {
    const uploadImage = imageUploader({ assetId: 'asset_drop' });
    const harness = mount({ uploadImage });
    dropFiles([pngFile('dropped.png')]);
    await waitFor(() => expect(jsonOf(harness)).toContain('"asset_drop"'));
    expect(uploadImage).toHaveBeenCalledTimes(1);
  });

  it('opens the file picker from the toolbar and from the slash menu', async () => {
    mount();
    const input = screen.getByLabelText('选择图片') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    expect(clickSpy).toHaveBeenCalledTimes(1);

    paste({ text: '/' });
    await screen.findByRole('listbox', { name: '插入内容' });
    paste({ text: '图片' });
    press('Enter');
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it('uploads through doc.importAsset with base64 bytes', async () => {
    const importAsset = vi.fn(
      async (input: { mime: string; dataBase64: string; name?: string }) => ({
        assetId: 'asset_rpc',
        mime: input.mime,
        bytes: 4,
      }),
    );
    const harness = mount({ importAsset });
    const input = screen.getByLabelText('选择图片') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });
    await waitFor(() => expect(jsonOf(harness)).toContain('"asset_rpc"'));
    expect(importAsset).toHaveBeenCalledTimes(1);
    const call = importAsset.mock.calls[0]![0];
    expect(call.mime).toBe('image/png');
    expect(call.name).toBe('pic.png');
    expect(call.dataBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('inserts an image after the slash image command', async () => {
    const uploadImage = imageUploader({ assetId: 'asset_slash' });
    const harness = mount({ uploadImage });
    paste({ text: '/' });
    await screen.findByRole('listbox', { name: '插入内容' });
    paste({ text: '图片' });
    press('Enter');
    const input = screen.getByLabelText('选择图片') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });
    await waitFor(() => expect(jsonOf(harness)).toContain('"asset_slash"'));
    expect(jsonOf(harness)).not.toContain('"text":"/图片"');
  });

  it('validates the image size budget', () => {
    const oversized = new File([new Uint8Array(1)], 'big.png', {
      type: 'image/png',
    });
    Object.defineProperty(oversized, 'size', { value: 4 * 1024 * 1024 + 1 });
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
    expect(validateImageFile(oversized)).toContain('4 MiB');
  });
});

// ---------------------------------------------------------------------------
// Paste routing and Markdown shortcuts
// ---------------------------------------------------------------------------

describe('paste routing', () => {
  it('routes an internal document link to a document-link card', () => {
    const harness = mount();
    expect(paste({ text: '/space/sp-1/doc/doc-9' })).toBe(true);
    const json = jsonOf(harness);
    expect(json).toContain('doc-9');
    // The card node may not be registered in parallel development; when it is,
    // assert the node type, otherwise assert the inline-link fallback.
    if (harness.editor().schema.nodes['alterDocLink'] !== undefined) {
      expect(json).toContain('"type":"alterDocLink"');
    } else {
      expect(json).toContain('"type":"link"');
    }
  });

  it('routes a pasted web URL to an inline link', () => {
    const harness = mount();
    expect(paste({ text: 'https://example.com/page' })).toBe(true);
    expect(jsonOf(harness)).toContain('"href":"https://example.com/page"');
  });

  it('filters rich HTML paste through the editor schema', () => {
    const harness = mount();
    paste({
      html: '<h2>小标题</h2><script>alert(1)</script><p><strong>粗体</strong>与<a href="https://x.test">链接</a></p>',
    });
    const json = jsonOf(harness);
    expect(json).toContain('"level":2');
    expect(json).toContain('"bold"');
    expect(json).toContain('"href":"https://x.test"');
    expect(json).not.toContain('script');
    expect(json).not.toContain('alert');
  });

  it('keeps multi-line plain text paste', () => {
    const harness = mount();
    paste({ text: '第一行\n第二行' });
    expect(harness.editor().getText()).toContain('第一行');
    expect(harness.editor().getText()).toContain('第二行');
  });
});

describe('markdown input rules', () => {
  it('turns Markdown prefixes into blocks', () => {
    const harness = mount();
    const editor = harness.editor();
    act(() => {
      typeChars(editor, '# ');
    });
    expect(firstBlock(harness)).toMatchObject({
      type: 'heading',
      attrs: { level: 1 },
    });

    act(() => {
      editor.commands.setContent('<p></p>');
      editor.commands.focus('end');
      typeChars(editor, '- ');
    });
    expect(firstBlock(harness)['type']).toBe('bulletList');

    act(() => {
      editor.commands.setContent('<p></p>');
      editor.commands.focus('end');
      typeChars(editor, '1. ');
    });
    expect(firstBlock(harness)['type']).toBe('orderedList');

    act(() => {
      editor.commands.setContent('<p></p>');
      editor.commands.focus('end');
      typeChars(editor, '> ');
    });
    expect(firstBlock(harness)['type']).toBe('blockquote');

    act(() => {
      editor.commands.setContent('<p></p>');
      editor.commands.focus('end');
      typeChars(editor, '``` ');
    });
    expect(firstBlock(harness)['type']).toBe('codeBlock');

    act(() => {
      editor.commands.setContent('<p></p>');
      editor.commands.focus('end');
      typeChars(editor, '[ ] ');
    });
    expect(firstBlock(harness)['type']).toBe('taskList');
  });
});
