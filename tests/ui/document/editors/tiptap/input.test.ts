// @vitest-environment jsdom
/**
 * Paste, drop and clipboard-sanitizing parity with the frozen editor.
 *
 * The frozen editor sanitizes clipboard HTML with its own whitelist, inserts
 * files through the asset pipeline, turns a lone web URL into an inline link,
 * turns a document URL into an in-app link card, and never linkifies plain text
 * on drag-in. The AST kernel keeps those gestures but uploads `data:` payloads
 * first (the Host rejects inline base64) and converts the sanitized legacy HTML
 * through the same HTML → AST parser the save path uses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createKernelEditor,
  type CreateKernelEditorOptions,
} from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import {
  documentIdFromPaste,
  sanitizePastedHtml,
} from '../../../../../src/document/editors/tiptap/paste';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

// jsdom has no layout engine: overlays/toolbar measure geometry on mount.
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
const zeroRects = () => [] as unknown as DOMRectList;
Range.prototype.getClientRects = zeroRects as never;
Element.prototype.getClientRects = zeroRects as never;
Range.prototype.getBoundingClientRect = zeroRect as never;
// jsdom has no hit testing; ProseMirror's drop path falls back to the caret.
if (typeof document.elementFromPoint !== 'function') {
  (document as unknown as { elementFromPoint: () => null }).elementFromPoint =
    () => null;
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

function paragraph(id: string, text = ''): BlockNode {
  return block(id, 'paragraph', {}, {
    content: text === '' ? undefined : [{ type: 'text', text }],
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});

function mount(
  docValue: AlterDoc,
  options: Partial<CreateKernelEditorOptions> = {},
) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc: docValue, ...options });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

function captured(kernel: ReturnType<typeof mount>): BlockNode[] {
  return pmDocToBlocks(kernel.capture()).value;
}

/** File payload shaped like the page's asset upload response. */
function asset(
  name = 'asset_1',
  mime = 'image/png',
  bytes = 4,
): { assetId: string; mime: string; bytes: number; name?: string } {
  return { assetId: name, mime, bytes };
}

/** Poll until `predicate` holds (async uploads settle on real timers). */
async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1500,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out: ${message}`);
}

/** One synthetic clipboard/drag payload. */
interface ClipData {
  html?: string;
  text?: string;
  files?: File[];
}

/** Dispatch one clipboard/drag event with a synthetic DataTransfer. */
function dispatchDataTransfer(
  kernel: ReturnType<typeof mount>,
  type: 'paste' | 'drop' | 'dragover',
  data: ClipData,
): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer = {
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
  };
  Object.defineProperty(event, 'clipboardData', { value: transfer });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  Object.defineProperty(event, 'clientX', { value: 0 });
  Object.defineProperty(event, 'clientY', { value: 0 });
  return kernel.editor.view.dom.dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// Sanitizer (frozen whitelist, §3.5.3)
// ---------------------------------------------------------------------------

/** DOM view of one sanitized payload. */
function sanitizedContainer(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = sanitizePastedHtml(html).html;
  return container;
}

describe('clipboard HTML sanitizing', () => {
  it('removes executable elements, event handlers and dangerous URLs', () => {
    const html =
      '<p onclick="alert(1)">安全文字<script>alert(1)</script>' +
      '<img src="javascript:alert(1)">' +
      '<a href="javascript:alert(1)">坏链</a>' +
      '<a href="https://example.com">好链</a></p>' +
      '<iframe src="https://evil.example"></iframe><style>p{}</style>' +
      '<object data="x"></object><embed src="x">' +
      '<form action="/x"><input value="1"></form>' +
      '<link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0">';
    const result = sanitizePastedHtml(html);
    const container = sanitizedContainer(html);
    expect(
      container.querySelector(
        'script,style,iframe,object,embed,form,input,link,meta',
      ),
    ).toBeNull();
    for (const element of container.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(/javascript:/i.test(attribute.value)).toBe(false);
      }
    }
    expect(container.textContent).toContain('安全文字');
    expect(container.textContent).toContain('坏链');
    expect(
      container.querySelector('a[href="https://example.com"]'),
    ).toBeTruthy();
    expect(result.simplified).toBe(true);
  });

  it('keeps supported structure, marks, links and inline images', () => {
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
  });

  it('normalizes legacy inline tags (B/I/DEL/STRIKE)', () => {
    const container = sanitizedContainer(
      '<p><b>粗</b><i>斜</i><del>删</del><strike>划</strike></p>',
    );
    expect(container.querySelector('strong')?.textContent).toBe('粗');
    expect(container.querySelector('em')?.textContent).toBe('斜');
    expect(container.querySelectorAll('s')).toHaveLength(2);
    expect(container.querySelector('b,i,del,strike')).toBeNull();
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
    expect(todo?.dataset['checked']).toBe('true');
    expect(todo?.querySelector('[data-todo-text]')?.textContent).toBe('待办事项');
    expect(container.querySelector('div[data-divider] hr')).toBeTruthy();
    const file = container.querySelector<HTMLElement>('span[data-file]');
    expect(file?.dataset['href']).toBe('data:application/pdf;base64,AAAA');
    expect(
      container.querySelector('a[data-doc-link="doc-2"]')?.textContent,
    ).toBe('文档二');
    const card = container.querySelector<HTMLElement>('a[data-link-card]');
    expect(card?.dataset['linkCard']).toBe('https://example.com');
    expect(card?.querySelector('strong')?.textContent).toBe('示例');
    expect(result.simplified).toBe(false);
  });

  it('drops block ids, unsupported media and unsafe attachments', () => {
    const html =
      '<p data-block-id="blk_dup" data-paragraph-id="blk_p">文本</p>' +
      '<video src="https://x/video.mp4"></video>' +
      '<h4>四级标题</h4>' +
      '<span data-file="evil.html" data-href="data:text/html;base64,AAAA">evil</span>' +
      '<img src="data:image/svg+xml;base64,AAAA">';
    const result = sanitizePastedHtml(html);
    const container = sanitizedContainer(html);
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

  it('unwraps unknown containers and keeps their content', () => {
    const container = sanitizedContainer(
      '<custom-card><p>保留内容</p><em>斜体</em></custom-card>',
    );
    expect(container.querySelector('custom-card')).toBeNull();
    expect(container.textContent).toContain('保留内容');
    expect(container.querySelector('em')?.textContent).toBe('斜体');
  });

  it('reports an empty result when only unsafe content was pasted', () => {
    const result = sanitizePastedHtml(
      '<script>alert(1)</script><style>x{}</style>',
    );
    expect(result.empty).toBe(true);
    expect(result.html).toBe('');
  });

  it('recognizes document URLs for the doc-link gesture', () => {
    expect(documentIdFromPaste('#/space/sp-1/doc/doc-2')).toBe('doc-2');
    expect(documentIdFromPaste('alter://doc/doc-3')).toBe('doc-3');
    expect(documentIdFromPaste('https://example.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Paste insertion
// ---------------------------------------------------------------------------

describe('paste insertion', () => {
  it('sanitizes pasted HTML before inserting it', async () => {
    const onNotice = vi.fn();
    const kernel = mount(doc([paragraph('p')]), { onNotice });
    dispatchDataTransfer(kernel, 'paste', {
      html:
        '<h2>粘贴标题</h2><p onclick="alert(1)">粘贴正文<script>alert(1)</script>' +
        '<a href="javascript:alert(1)">坏链</a><iframe src="x"></iframe></p>',
    });
    await waitUntil(
      () => captured(kernel).some((item) => item.type === 'heading'),
      'pasted heading',
    );
    const types = captured(kernel).map((item) => item.type);
    expect(types).toContain('heading');
    const body = captured(kernel).find((item) => item.type === 'paragraph');
    expect(body?.content?.some((node) => node.text?.includes('粘贴正文'))).toBe(
      true,
    );
    expect(body?.content?.some((node) => node.text?.includes('坏链'))).toBe(
      true,
    );
    expect(
      body?.content?.some((node) =>
        node.marks?.some((mark) => mark.type === 'link'),
      ),
    ).toBe(false);
    expect(onNotice).toHaveBeenCalledWith('部分粘贴内容已简化');
    expect(kernel.editor.view.dom.querySelector('script,iframe')).toBeNull();
  });

  it('reports one simplification notice for one paste', async () => {
    const onNotice = vi.fn();
    const kernel = mount(doc([paragraph('p')]), { onNotice });
    dispatchDataTransfer(kernel, 'paste', {
      // H4 degrades in the sanitizer; a remote image degrades in the AST parser.
      html: '<h4>四级</h4><p><img src="https://example.com/x.png" alt="远程"></p>',
    });
    await waitUntil(
      () =>
        captured(kernel).some((item) =>
          item.content?.some((node) => node.text?.includes('四级')),
        ),
      'pasted degraded content',
    );
    const simplificationNotices = onNotice.mock.calls.filter(
      (call) => call[0] === '部分粘贴内容已简化',
    );
    expect(simplificationNotices).toHaveLength(1);
  });

  it('keeps supported rich structure when pasting', async () => {
    const kernel = mount(doc([paragraph('p')]));
    dispatchDataTransfer(kernel, 'paste', {
      html:
        '<ul><li>粘贴项目</li></ul><p><strong>粘贴粗体</strong></p>',
    });
    await waitUntil(
      () => captured(kernel).some((item) => item.type === 'bulletList'),
      'pasted list',
    );
    const list = captured(kernel).find((item) => item.type === 'bulletList');
    expect(
      list?.children?.[0]?.children?.[0]?.content?.[0]?.text,
    ).toBe('粘贴项目');
    const paragraphBlock = captured(kernel).find(
      (item) => item.type === 'paragraph',
    );
    expect(
      paragraphBlock?.content?.some(
        (node) =>
          node.text === '粘贴粗体' &&
          node.marks?.some((mark) => mark.type === 'bold'),
      ),
    ).toBe(true);
  });

  it('preserves the legacy card/block syntax pasted from inside the editor', async () => {
    const kernel = mount(doc([paragraph('p')]));
    dispatchDataTransfer(kernel, 'paste', {
      html:
        '<div data-todo data-checked="true"><span data-todo-box contenteditable="false"></span>' +
        '<span data-todo-text>待办事项</span></div>' +
        '<div data-divider contenteditable="false"><hr></div>' +
        '<a data-doc-link="doc-2" href="#/space/sp-1/doc/doc-2">文档二</a>' +
        '<a data-link-card="https://example.com" href="https://example.com">' +
        '<strong>示例</strong><span>描述</span></a>',
    });
    await waitUntil(
      () => captured(kernel).some((item) => item.type === 'taskList'),
      'pasted task list',
    );
    const types = captured(kernel).map((item) => item.type);
    expect(types).toContain('taskList');
    expect(types).toContain('divider');
    expect(types).toContain('docLink');
    expect(types).toContain('bookmark');
    const todo = captured(kernel).find((item) => item.type === 'taskList');
    expect(todo?.children?.[0]?.attrs['checked']).toBe(true);
    expect(
      todo?.children?.[0]?.children?.[0]?.content?.[0]?.text,
    ).toBe('待办事项');
    const docLink = captured(kernel).find((item) => item.type === 'docLink');
    expect(docLink?.attrs['docId']).toBe('doc-2');
    const bookmark = captured(kernel).find((item) => item.type === 'bookmark');
    expect(bookmark?.attrs['url']).toBe('https://example.com');
    expect(bookmark?.attrs['title']).toBe('示例');
    expect(bookmark?.attrs['description']).toBe('描述');
  });

  it('turns a pasted document URL into a document link card', async () => {
    const kernel = mount(doc([paragraph('p')]));
    dispatchDataTransfer(kernel, 'paste', {
      text: '#/space/sp-1/doc/doc-2',
    });
    await waitUntil(
      () => captured(kernel).some((item) => item.type === 'docLink'),
      'doc link',
    );
    const link = captured(kernel).find((item) => item.type === 'docLink');
    expect(link?.attrs['docId']).toBe('doc-2');
  });

  it('turns a lone pasted web URL into an inline web link', async () => {
    const kernel = mount(doc([paragraph('p')]));
    dispatchDataTransfer(kernel, 'paste', {
      text: 'https://www.example.com/path',
    });
    await waitUntil(
      () =>
        captured(kernel).some((item) =>
          item.content?.some((node) =>
            node.marks?.some((mark) => mark.type === 'link'),
          ),
        ),
      'web link',
    );
    const withLink = captured(kernel).find((item) =>
      item.content?.some((node) =>
        node.marks?.some((mark) => mark.type === 'link'),
      ),
    );
    expect(withLink?.content?.[0]?.text).toBe('example.com');
    expect(
      withLink?.content?.[0]?.marks?.[0]?.attrs?.['href'],
    ).toBe('https://www.example.com/path');
  });

  it('inserts any other plain text without turning tags into markup', async () => {
    const kernel = mount(doc([paragraph('p')]));
    dispatchDataTransfer(kernel, 'paste', {
      text: '纯文本 <b>不是标签</b>',
    });
    await waitUntil(
      () =>
        (captured(kernel)[0]?.content?.[0]?.text ?? '').includes('纯文本'),
      'plain text',
    );
    expect(kernel.editor.view.dom.querySelector('b')).toBeNull();
    expect(captured(kernel)[0]?.content?.[0]?.text).toContain(
      '纯文本 <b>不是标签</b>',
    );
  });
});

// ---------------------------------------------------------------------------
// Drop insertion
// ---------------------------------------------------------------------------

describe('drop insertion', () => {
  it('accepts drags with a copy cursor and sanitizes dropped HTML', async () => {
    const kernel = mount(doc([paragraph('p')]));
    const notPrevented = dispatchDataTransfer(kernel, 'dragover', {
      html: '<p>x</p>',
    });
    // The dragover handler accepts the drag (preventDefault => dispatch false).
    expect(notPrevented).toBe(false);
    dispatchDataTransfer(kernel, 'drop', {
      html: '<p>拖入文字<script>alert(1)</script></p>',
    });
    await waitUntil(
      () =>
        (captured(kernel)[0]?.content?.[0]?.text ?? '').includes('拖入文字'),
      'dropped html',
    );
    expect(kernel.editor.view.dom.querySelector('script')).toBeNull();
  });

  it('claims external plain-text drops and leaves internal drags to ProseMirror', async () => {
    const kernel = mount(doc([paragraph('p')]));
    const view = kernel.editor.view;
    const external = dispatchDataTransfer(kernel, 'drop', { text: '外部文本' });
    // An external drag is claimed by the paste extension...
    expect(external).toBe(false);
    await waitUntil(
      () =>
        (captured(kernel)[0]?.content?.[0]?.text ?? '').includes('外部文本'),
      'external drop text',
    );

    // ...while a drag that started inside this editor keeps ProseMirror's pass
    // semantics: the source stays put and the extension does not claim the
    // event, so no duplicated copy appears at the drop point.
    view.dragging = { slice: kernel.editor.state.doc.slice(0), move: true };
    try {
      dispatchDataTransfer(kernel, 'drop', { text: '内部文本' });
    } finally {
      view.dragging = null;
    }
    await Promise.resolve();
    expect(JSON.stringify(captured(kernel))).not.toContain('内部文本');
  });

  it('uses the drop wording when dropped HTML is simplified', async () => {
    const onNotice = vi.fn();
    const kernel = mount(doc([paragraph('p')]), { onNotice });
    dispatchDataTransfer(kernel, 'drop', {
      html: '<p>拖入</p><iframe src="x"></iframe>',
    });
    await waitUntil(
      () => onNotice.mock.calls.length > 0,
      'drop simplification notice',
    );
    expect(onNotice).toHaveBeenCalledWith('部分拖入内容已简化');
  });

  it('does not linkify dropped plain text (paste and drop differ)', async () => {
    const kernel = mount(doc([paragraph('p')]));
    dispatchDataTransfer(kernel, 'drop', {
      text: 'https://example.com',
    });
    await waitUntil(
      () =>
        (captured(kernel)[0]?.content?.[0]?.text ?? '').includes('example.com'),
      'dropped text',
    );
    expect(
      captured(kernel)[0]?.content?.some((node) =>
        node.marks?.some((mark) => mark.type === 'link'),
      ),
    ).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Files (clipboard and drop)
// ---------------------------------------------------------------------------

function imageFile(name = 'pic.png'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
}

describe('file insertion', () => {
  it('uploads a pasted image and inserts one image block', async () => {
    const importAsset = vi
      .fn()
      .mockResolvedValue(asset('asset_img', 'image/png', 4));
    const kernel = mount(doc([paragraph('p')]), { importAsset });
    dispatchDataTransfer(kernel, 'paste', { files: [imageFile()] });
    await waitUntil(
      () => captured(kernel).some((item) => item.type === 'image'),
      'pasted image block',
    );
    const image = captured(kernel).find((item) => item.type === 'image');
    expect(image?.attrs['assetId']).toBe('asset_img');
    expect(image?.attrs['alt']).toBe('pic.png');
    expect(importAsset).toHaveBeenCalledTimes(1);
  });

  it('uploads a pasted non-image file and inserts one file card', async () => {
    const importAsset = vi
      .fn()
      .mockResolvedValue(asset('asset_pdf', 'application/pdf', 3));
    const kernel = mount(doc([paragraph('p')]), { importAsset });
    dispatchDataTransfer(kernel, 'paste', {
      files: [new File(['pdf'], 'a.pdf', { type: 'application/pdf' })],
    });
    await waitUntil(
      () => captured(kernel).some((item) => item.type === 'file'),
      'pasted file block',
    );
    const file = captured(kernel).find((item) => item.type === 'file');
    expect(file?.attrs['assetId']).toBe('asset_pdf');
    expect(file?.attrs['name']).toBe('a.pdf');
    expect(file?.attrs['mime']).toBe('application/pdf');
  });

  it('inserts several pasted files serially in clipboard order', async () => {
    const importAsset = vi
      .fn()
      .mockImplementation(
        async ({ kind }: { kind: 'image' | 'file' }) =>
          kind === 'image'
            ? asset('asset_img', 'image/png', 4)
            : asset('asset_pdf', 'application/pdf', 3),
      );
    const kernel = mount(doc([paragraph('p')]), { importAsset });
    dispatchDataTransfer(kernel, 'paste', {
      files: [
        imageFile('first.png'),
        new File(['pdf'], 'second.pdf', { type: 'application/pdf' }),
      ],
    });
    await waitUntil(
      () =>
        captured(kernel).filter(
          (item) => item.type === 'image' || item.type === 'file',
        ).length === 2,
      'two pasted file blocks',
    );
    const kinds = captured(kernel)
      .filter((item) => item.type === 'image' || item.type === 'file')
      .map((item) => item.type);
    expect(kinds).toEqual(['image', 'file']);
    expect(importAsset).toHaveBeenCalledTimes(2);
  });

  it('reports the Host upload error instead of dropping the file silently', async () => {
    const onNotice = vi.fn();
    const hostMessage = '文件超过 8 MiB 上限（8388608 字节，上限 8388608 字节）';
    const importAsset = vi.fn().mockRejectedValue(new Error(hostMessage));
    const kernel = mount(doc([paragraph('p')]), { importAsset, onNotice });
    dispatchDataTransfer(kernel, 'paste', { files: [imageFile()] });
    await waitUntil(
      () => onNotice.mock.calls.length > 0,
      'upload failure notice',
    );
    // The real reason reaches the user (frozen error text is only a fallback).
    expect(onNotice.mock.calls[0]?.[0]).toBe(hostMessage);
    expect(captured(kernel).some((item) => item.type === 'image')).toBe(false);
  });

  it('keeps the generic wording when an upload rejects without a message', async () => {
    const onNotice = vi.fn();
    const importAsset = vi.fn().mockRejectedValue(new Error(''));
    const kernel = mount(doc([paragraph('p')]), { importAsset, onNotice });
    dispatchDataTransfer(kernel, 'paste', { files: [imageFile()] });
    await waitUntil(
      () => onNotice.mock.calls.length > 0,
      'upload failure notice',
    );
    expect(onNotice.mock.calls[0]?.[0]).toContain('文件上传失败');
    expect(captured(kernel).some((item) => item.type === 'image')).toBe(false);
  });

  it('uploads a data-URL image embedded in pasted HTML before inserting it', async () => {
    const importAsset = vi
      .fn()
      .mockResolvedValue(asset('asset_data', 'image/png', 2));
    const kernel = mount(doc([paragraph('p')]), { importAsset });
    dispatchDataTransfer(kernel, 'paste', {
      html: '<p>前<img src="data:image/png;base64,AAAA" alt="图">后</p>',
    });
    await waitUntil(
      () => captured(kernel).some((item) => item.type === 'image'),
      'uploaded pasted image',
    );
    const image = captured(kernel).find((item) => item.type === 'image');
    expect(image?.attrs['assetId']).toBe('asset_data');
    expect(importAsset).toHaveBeenCalledTimes(1);
    const text = captured(kernel)
      .filter((item) => item.type === 'paragraph')
      .map((item) => item.content?.map((node) => node.text).join('') ?? '')
      .join('');
    expect(text).toContain('前');
    expect(text).toContain('后');
    expect(JSON.stringify(captured(kernel))).not.toContain('data:image');
  });

  it('keeps a visible notice when a data-URL image cannot be uploaded', async () => {
    const onNotice = vi.fn();
    const kernel = mount(doc([paragraph('p')]), { onNotice });
    dispatchDataTransfer(kernel, 'paste', {
      html: '<p><img src="data:image/png;base64,AAAA" alt="图"></p>',
    });
    await waitUntil(
      () => onNotice.mock.calls.length > 0,
      'missing importAsset notice',
    );
    expect(onNotice.mock.calls[0]?.[0]).toContain('无法上传');
    expect(JSON.stringify(captured(kernel))).not.toContain('data:image');
  });
});