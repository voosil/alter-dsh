// @vitest-environment jsdom
/**
 * The Tiptap kernel mounts, renders the frozen stylesheet's DOM shapes, and
 * captures back to the same AST it was loaded from.
 *
 * These tests are the parity gate for the structural half of the contract:
 * a kernel that cannot round-trip its own body would fail every save.
 * Interaction parity (slash menu, table bar, link editing) needs a real
 * browser and lives in the manual checklist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelEditor, kernelExtensions } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import {
  MANIFEST_MARK_NAMES,
  MANIFEST_NODE_NAMES,
  NATIVE_NODE_NAMES,
} from '../../../../../src/document/editors/tiptap/nodes';
import { NODE_MANIFEST } from '../../../../../src/document/schema-manifest';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

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

function sampleBlocks(): BlockNode[] {
  return [
    block('blk_h1', 'heading', { level: 1 }, {
      content: [{ type: 'text', text: '标题' }],
    }),
    block('blk_p', 'paragraph', {}, {
      content: [
        { type: 'text', text: '加粗', marks: [{ type: 'bold' }] },
        { type: 'text', text: '正文' },
      ],
    }),
    block('blk_ul', 'bulletList', {}, {
      children: [
        block('blk_li', 'listItem', {}, {
          children: [
            block('blk_lip', 'paragraph', {}, {
              content: [{ type: 'text', text: '列表项' }],
            }),
          ],
        }),
      ],
    }),
    block('blk_quote', 'blockquote', {}, {
      children: [
        block('blk_qp', 'paragraph', {}, {
          content: [{ type: 'text', text: '引用' }],
        }),
      ],
    }),
    block('blk_code', 'codeBlock', { lang: 'ts' }, {
      content: [{ type: 'text', text: 'const a = 1;' }],
    }),
    block('blk_hr', 'divider'),
  ];
}

let destroyed: Array<() => void> = [];

afterEach(() => {
  for (const destroy of destroyed) destroy();
  destroyed = [];
});

function mount(blocks: BlockNode[]) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({
    element,
    doc: doc(blocks),
  });
  destroyed.push(() => {
    kernel.destroy();
    element.remove();
  });
  return { kernel, element };
}

describe('kernel mounts and captures its own body', () => {
  it('renders the paragraph text the AST carried', () => {
    const { element } = mount(sampleBlocks());
    expect(element.textContent).toContain('标题');
    expect(element.textContent).toContain('正文');
  });

  it('round-trips its body back to the same AST', () => {
    const blocks = sampleBlocks();
    const { kernel } = mount(blocks);
    const captured = pmDocToBlocks(kernel.capture());
    expect(captured.warnings).toEqual([]);
    expect(captured.value).toEqual(blocks);
  });

  it('renders the DOM shapes the frozen stylesheet targets', () => {
    const { element } = mount(sampleBlocks());
    // Element selectors from Editor.module.css.
    expect(element.querySelector('h1')).not.toBeNull();
    expect(element.querySelector('strong')).not.toBeNull();
    expect(element.querySelector('ul > li > p')).not.toBeNull();
    expect(element.querySelector('blockquote p')).not.toBeNull();
    expect(element.querySelector('pre > code')).not.toBeNull();
    // Attribute selectors from Editor.module.css.
    expect(element.querySelector('[data-divider] hr')).not.toBeNull();
    expect(element.querySelector('[data-block-id]')).not.toBeNull();
  });

  it('loads a new body without reporting an update', () => {
    const onUpdate = vi.fn();
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: doc(sampleBlocks()),
      onUpdate,
    });
    destroyed.push(() => {
      kernel.destroy();
      element.remove();
    });
    const next = [block('blk_new', 'paragraph', {}, {
      content: [{ type: 'text', text: '重新载入' }],
    })];
    kernel.load(doc(next));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(pmDocToBlocks(kernel.capture()).value).toEqual(next);
    expect(element.textContent).toContain('重新载入');
  });

  it('keeps the stable block ids the comment anchors rely on', () => {
    const { element } = mount(sampleBlocks());
    const ids = [...element.querySelectorAll('[data-block-id]')].map((node) =>
      node.getAttribute('data-block-id'),
    );
    expect(ids).toContain('blk_p');
    expect(ids).toContain('blk_hr');
  });
});

describe('block-type conversion (文本类型 menu)', () => {
  /** Mount one body and put the caret inside its first paragraph. */
  function mountAtCaret(blocks: BlockNode[]) {
    const { kernel } = mount(blocks);
    const $from = kernel.editor.state.doc.resolve(2);
    kernel.editor.commands.setTextSelection(
      kernel.editor.state.doc.resolve($from.pos),
    );
    return kernel;
  }

  it('reports the block type at the caret', () => {
    const kernel = mountAtCaret([
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '正文' }],
      }),
    ]);
    expect(kernel.activeBlockType()).toBe('p');
  });

  it('converts the caret paragraph into headings, lists, quotes and code', () => {
    const page = () => [
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '正文' }],
      }),
    ];
    for (const [type, expected] of [
      ['h1', 'heading'],
      ['h2', 'heading'],
      ['h3', 'heading'],
      ['bullet', 'bulletList'],
      ['ordered', 'orderedList'],
      ['todo', 'taskList'],
      ['quote', 'blockquote'],
      ['code', 'codeBlock'],
    ] as const) {
      const kernel = mountAtCaret(page());
      kernel.applyBlockType(type);
      const captured = pmDocToBlocks(kernel.capture());
      expect(captured.value.map((item) => item.type), type).toContain(expected);
      if (type === 'h2') {
        expect(kernel.activeBlockType()).toBe('h2');
      }
    }
  });

  it('converts a converted block back to a paragraph', () => {
    const kernel = mountAtCaret([
      block('blk_h', 'heading', { level: 2 }, {
        content: [{ type: 'text', text: '标题' }],
      }),
    ]);
    kernel.applyBlockType('p');
    expect(pmDocToBlocks(kernel.capture()).value[0]?.type).toBe('paragraph');
  });
});

describe('page-owned lookups for doc links', () => {
  it('writes the page route into doc-link hrefs', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: doc([
        block('blk_link', 'docLink', { docId: 'doc_9', title: '另一篇' }),
      ]),
      docPath: (docId) => `#/space/sp-1/doc/${docId}`,
    });
    destroyed.push(() => {
      kernel.destroy();
      element.remove();
    });
    const link = element.querySelector('a[data-doc-link]');
    expect(link?.getAttribute('href')).toBe('#/space/sp-1/doc/doc_9');
  });

  it('paints the frozen archived badge from the page catalog', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: doc([
        block('blk_link', 'docLink', { docId: 'doc_9', title: '另一篇' }),
      ]),
      resolveDoc: (docId) => (docId === 'doc_9' ? { archived: true } : undefined),
    });
    destroyed.push(() => {
      kernel.destroy();
      element.remove();
    });
    const link = element.querySelector('a[data-doc-link]');
    expect(link?.hasAttribute('data-archived')).toBe(true);
    expect(link?.querySelector('[data-doc-archived-icon]')).not.toBeNull();
  });
});

describe('block identity', () => {
  it('assigns ids to new blocks once and keeps them across captures', () => {
    const { kernel } = mount([
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '正文' }],
      }),
    ]);
    // Split the paragraph: the new block starts without an id.
    kernel.editor.commands.setTextSelection(3);
    kernel.editor.commands.splitBlock();
    const first = pmDocToBlocks(kernel.capture()).value;
    const second = pmDocToBlocks(kernel.capture()).value;
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
    for (const item of first) {
      expect(item.id.startsWith('blk_')).toBe(true);
    }
  });
});

describe('extension coverage', () => {
  it('declares every manifest node (native or kernel-owned)', () => {
    const declared = new Set([...NATIVE_NODE_NAMES, ...MANIFEST_NODE_NAMES]);
    for (const type of Object.keys(NODE_MANIFEST)) {
      expect(declared.has(type), `node ${type} has no extension`).toBe(true);
    }
  });

  it('declares every AST mark', () => {
    expect([...MANIFEST_MARK_NAMES]).toEqual([
      'bold',
      'italic',
      'underline',
      'strike',
      'code',
      'highlight',
      'link',
    ]);
  });

  it('builds the full extension list without throwing', () => {
    expect(() => kernelExtensions()).not.toThrow();
    expect(kernelExtensions().length).toBeGreaterThan(10);
  });

  it('renders cards with the frozen attribute selectors', () => {
    const { element } = mount([
      block('blk_bm', 'bookmark', { url: 'https://example.com', title: '站' }),
      block('blk_file', 'file', {
        assetId: 'asset_f',
        name: '说明.pdf',
        mime: 'application/pdf',
        bytes: 10,
      }),
    ]);
    expect(element.querySelector('[data-link-card]')).not.toBeNull();
    expect(element.querySelector('[data-file]')).not.toBeNull();
  });
});
