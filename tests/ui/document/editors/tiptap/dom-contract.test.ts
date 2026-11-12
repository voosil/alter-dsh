// @vitest-environment jsdom
/**
 * Frozen-DOM contract for the AST-native kernel.
 *
 * The document page's stylesheet (`Editor.module.css`) is frozen and written
 * against the legacy DOM: plain element selectors (`p`, `h1`, `pre > code`,
 * `table`, `img`, `blockquote`) plus `data-*` hooks (`data-todo`,
 * `data-divider`, `data-file`, `data-link-card`, …). A kernel can be perfectly
 * "correct" about the AST and still look broken if its DOM misses one of those
 * hooks — that is exactly what happened before this contract existed.
 *
 * This test renders one document containing every node type and asserts that
 * each frozen selector the stylesheet relies on can match. It intentionally
 * does not snapshot the whole DOM: block ids, extra ProseMirror classes and
 * widget attributes are the kernel's business, the hooks below are not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createKernelEditor, type KernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { KERNEL_CLASS } from '../../../../../src/document/editors/tiptap/classes';
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

/** One document carrying every node type the registry supports. */
function fullDocument(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      block('b_h1', 'heading', { level: 1 }, { content: text('一级标题') }),
      block('b_h2', 'heading', { level: 2 }, { content: text('二级标题') }),
      block('b_h3', 'heading', { level: 3 }, { content: text('三级标题') }),
      block('b_p', 'paragraph', {}, {
        content: [
          { type: 'text', text: '普通 ' },
          { type: 'text', text: '粗', marks: [{ type: 'bold' }] },
          { type: 'text', text: '斜', marks: [{ type: 'italic' }] },
          { type: 'text', text: '下划线', marks: [{ type: 'underline' }] },
          { type: 'text', text: '删除', marks: [{ type: 'strike' }] },
          { type: 'text', text: '高亮', marks: [{ type: 'highlight' }] },
          { type: 'text', text: '代码', marks: [{ type: 'code' }] },
          {
            type: 'text',
            text: '链接',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          },
        ],
      }),
      block('b_ul', 'bulletList', {}, {
        children: [
          block('b_li', 'listItem', {}, {
            children: [block('b_lip', 'paragraph', {}, { content: text('项目') })],
          }),
        ],
      }),
      block('b_ol', 'orderedList', { start: 3 }, {
        children: [
          block('b_oli', 'listItem', {}, {
            children: [block('b_olip', 'paragraph', {}, { content: text('第三步') })],
          }),
        ],
      }),
      block('b_tasks', 'taskList', {}, {
        children: [
          block('b_task_done', 'listItem', { checked: true }, {
            children: [block('b_taskp1', 'paragraph', {}, { content: text('已完成') })],
          }),
          block('b_task_todo', 'listItem', { checked: false }, {
            children: [block('b_taskp2', 'paragraph', {}, { content: text('未完成') })],
          }),
        ],
      }),
      block('b_quote', 'blockquote', {}, {
        children: [block('b_qp', 'paragraph', {}, { content: text('引用') })],
      }),
      block('b_code', 'codeBlock', { lang: 'ts' }, { content: text('const a = 1;') }),
      block('b_divider', 'divider'),
      block('b_table', 'table', { headerRows: 1 }, {
        children: [
          block('b_tr1', 'tableRow', {}, {
            children: [block('b_th1', 'tableCell', {}, {
              children: [block('b_thp1', 'paragraph', {}, { content: text('列一') })],
            })],
          }),
          block('b_tr2', 'tableRow', {}, {
            children: [block('b_td1', 'tableCell', {}, {
              children: [block('b_tdp1', 'paragraph', {}, { content: text('值') })],
            })],
          }),
        ],
      }),
      block('b_image', 'image', { assetId: 'asset_1', alt: '图' }),
      block('b_file', 'file', {
        assetId: 'asset_2',
        name: 'notes.pdf',
        mime: 'application/pdf',
        bytes: 2048,
      }),
      block('b_bookmark', 'bookmark', {
        url: 'https://example.com',
        title: '示例站点',
        description: '描述文本',
      }),
      block('b_doclink', 'docLink', { docId: 'doc_9', title: '另一篇文档' }),
      block('b_callout', 'callout', { tone: 'info' }, {
        children: [block('b_cp', 'paragraph', {}, { content: text('提示') })],
      }),
      block('b_component', 'component', { objectId: 'obj_1', title: '组件' }),
    ],
  };
}

let mounted: { kernel: KernelEditor; element: HTMLElement } | null = null;
afterEach(() => {
  mounted?.kernel.destroy();
  mounted?.element.remove();
  mounted = null;
});

function mountDocument(doc: AlterDoc = fullDocument()): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({
    element,
    doc,
    comments: [],
    surfaceClassName: KERNEL_CLASS.surface,
    placeholder: '开始写点什么…',
  });
  mounted = { kernel, element };
  return kernel.editor.view.dom;
}

/** Assert one frozen selector matches inside the surface. */
function expectMatch(surface: HTMLElement, selector: string): void {
  expect(
    surface.querySelector(selector),
    `frozen stylesheet selector ${selector} must match kernel DOM`,
  ).not.toBeNull();
}

describe('frozen block DOM contract', () => {
  it('renders the plain element selectors the stylesheet styles', () => {
    const surface = mountDocument();
    for (const selector of [
      'p',
      'h1',
      'h2',
      'h3',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'pre > code',
      'code',
      'strong',
      'em',
      'u',
      's',
      'mark',
      'a[href]',
      'img',
      'table',
      'th',
      'td',
    ]) {
      expectMatch(surface, selector);
    }
  });

  it('renders the data hooks the stylesheet styles', () => {
    const surface = mountDocument();
    for (const selector of [
      '[data-todo]',
      '[data-todo] > [data-todo-box]',
      '[data-todo] > [data-todo-text]',
      '[data-todo][data-checked="true"]',
      '[data-todo][data-checked="false"]',
      '[data-divider] > hr',
      '[data-file]',
      '[data-file] > [data-file-icon] > svg',
      '[data-link-card] > strong',
      '[data-link-card] > span',
      '[data-doc-link]',
      '[data-doc-link] > [data-doc-icon] > svg',
      '[data-object-card][data-kind]',
    ]) {
      expectMatch(surface, selector);
    }
  });

  it('gives every top-level block a data-block-id (comment anchors)', () => {
    const surface = mountDocument();
    const blocks = [...surface.children];
    expect(blocks.length).toBeGreaterThan(0);
    for (const child of blocks) {
      expect(child.getAttribute('data-block-id')).toBeTruthy();
    }
  });

  it('keeps paragraphs inside list items and cells margin-neutral for the stylesheet', () => {
    // The frozen DOM has inline text in `li`/`td`; the kernel nests a real
    // block per ProseMirror's model. `kernel.css` neutralizes its margins —
    // this asserts the DOM shape that rule targets still exists.
    const surface = mountDocument();
    expectMatch(surface, 'li > p');
    expectMatch(surface, 'th > p');
    expectMatch(surface, 'td > p');
    expectMatch(surface, '[data-todo-text] > p');
  });

  it('carries the resolved frozen surface class and editable attributes', () => {
    const surface = mountDocument();
    expect(surface.classList.contains(KERNEL_CLASS.surface)).toBe(true);
    expect(surface.getAttribute('role')).toBe('textbox');
    expect(surface.getAttribute('aria-label')).toBe('文档正文');
    expect(surface.getAttribute('aria-multiline')).toBe('true');
    expect(surface.getAttribute('spellcheck')).toBe('false');
    expect(surface.getAttribute('data-placeholder')).toBe('开始写点什么…');
  });

  it('renders the code block language as the frozen `data-lang` hook', () => {
    const surface = mountDocument();
    const pre = surface.querySelector('pre');
    expect(pre?.getAttribute('data-lang')).toBe('ts');
    expect(pre?.hasAttribute('lang')).toBe(false);
  });

  it('renders the todo box as the frozen non-editable checkbox', () => {
    const surface = mountDocument();
    const box = surface.querySelector('[data-todo-box]');
    expect(box?.getAttribute('role')).toBe('checkbox');
    expect(box?.getAttribute('contenteditable')).toBe('false');
    expect(box?.getAttribute('tabindex')).toBe('0');
    expect(box?.getAttribute('aria-checked')).toBe('true');
    expect(surface.querySelector('[data-todo][data-checked="false"] [data-todo-box]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('renders cards with the frozen text children (never an empty shell)', () => {
    const surface = mountDocument();
    expect(surface.querySelector('[data-file]')?.textContent).toContain('notes.pdf');
    expect(surface.querySelector('[data-file]')?.textContent).toContain('2.0 KB');
    expect(surface.querySelector('[data-link-card] strong')?.textContent).toBe('示例站点');
    expect(surface.querySelector('[data-link-card] span')?.textContent).toBe('描述文本');
    expect(surface.querySelector('[data-doc-link]')?.textContent).toContain('另一篇文档');
    expect(surface.querySelector('[data-object-card][data-kind="component"]')?.textContent).toContain('[交互组件]');
  });

  it('renders the header row as th cells (frozen table header look)', () => {
    const surface = mountDocument();
    const rows = surface.querySelectorAll('table tr');
    expect(rows[0]?.querySelectorAll('th').length).toBe(1);
    expect(rows[1]?.querySelectorAll('td').length).toBe(1);
  });

  it('renders an empty document as one empty paragraph (frozen placeholder)', () => {
    // The frozen page shows the placeholder with `:has(> p:only-child > br)`;
    // an empty AST becomes exactly that shape, not an extra trailing block.
    const surface = mountDocument({
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [],
    });
    expect(surface.children).toHaveLength(1);
    const only = surface.firstElementChild;
    expect(only?.tagName).toBe('P');
    expect(only?.textContent).toBe('');
  });

  it('does not append a trailing paragraph after a divider-ended document', () => {
    const surface = mountDocument({
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [
        block('b_p', 'paragraph', {}, { content: text('上文') }),
        block('b_hr', 'divider'),
      ],
    });
    const last = surface.lastElementChild;
    expect(last?.hasAttribute('data-divider')).toBe(true);
  });
});