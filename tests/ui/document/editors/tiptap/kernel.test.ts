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
