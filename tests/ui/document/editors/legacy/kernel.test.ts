// @vitest-environment jsdom
/**
 * Legacy editor kernel against the kernel-neutral contract.
 *
 * The kernel must (a) expose the frozen editor's body as AST, (b) never turn
 * "no edits yet" into "empty document", and (c) report body events through the
 * contract instead of leaking the editor's HTML callback.
 */
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alterDocToEditorHtml, captureLegacyBlocks } from '@alter-space/legacy-adapter';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';
import type { EditorKernelListener } from '../../../../../src/document/editors/kernel';
import {
  createLegacyKernel,
  type LegacyEditorProps,
} from '../../../../../src/document/editors/legacy/kernel';

afterEach(() => {
  cleanup();
});

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function sampleDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 3,
    blocks: [
      block('blk_h', 'heading', { level: 2 }, {
        content: [{ type: 'text', text: '标题' }],
      }),
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '正文' }],
      }),
    ],
  };
}

/** Mount the kernel with a stub editor that just records its props. */
function mountKernel() {
  const seen: { props?: LegacyEditorProps } = {};
  function StubEditor(props: LegacyEditorProps) {
    seen.props = props;
    return createElement('div', { 'data-testid': 'stub-editor' });
  }
  const doc = sampleDoc();
  const mounted = createLegacyKernel({
    Editor: StubEditor,
    props: {
      docId: 'doc-1',
      document: doc,
      revision: doc.revision,
      baseHtml: alterDocToEditorHtml(doc),
      caret: 'none',
      comments: [],
    },
    editorProps: {
      findDoc: () => undefined,
      onOpenDoc: () => undefined,
      onComment: () => undefined,
      comments: [],
    },
  });
  render(createElement(mounted.Component));
  return { ...mounted, seen, doc };
}

describe('captureLegacyBlocks', () => {
  it('projects editor HTML back to canonical AST blocks', () => {
    const html = alterDocToEditorHtml(sampleDoc());
    const captured = captureLegacyBlocks(html);
    expect(captured.warnings).toEqual([]);
    expect(captured.blocks.map((node) => node.id)).toEqual(['blk_h', 'blk_p']);
    expect(captured.blocks[0]?.attrs['level']).toBe(2);
    expect(captured.blocks[1]?.content).toEqual([
      { type: 'text', text: '正文' },
    ]);
  });

  it('omits empty content/children arrays like the Host does', () => {
    const captured = captureLegacyBlocks('<p data-block-id="blk_p"></p>');
    expect(captured.blocks).toEqual([{ id: 'blk_p', type: 'paragraph', attrs: {} }]);
  });

  it('keeps text of markup the parser degrades instead of dropping it', () => {
    const captured = captureLegacyBlocks(
      '<p data-block-id="blk_p">前<iframe src="https://x"></iframe>后</p>',
    );
    // The iframe may degrade into its own placeholder block; the surrounding
    // text must survive either way.
    const texts = captured.blocks
      .flatMap((node) => node.content ?? [])
      .map((node) => (node.type === 'text' ? node.text : ''))
      .join('');
    expect(texts).toContain('前');
    expect(texts).toContain('后');
  });
});

describe('createLegacyKernel', () => {
  it('returns the base document before the editor reports any change', () => {
    const { kernel, doc } = mountKernel();
    expect(kernel.kind).toBe('legacy');
    expect(kernel.base.revision).toBe(3);
    // Untouched body must not look like "everything was deleted".
    expect(kernel.capture()).toEqual(doc.blocks);
  });

  it('captures the body the editor reported, as canonical AST', () => {
    const { kernel, seen, doc } = mountKernel();
    seen.props?.onChange(alterDocToEditorHtml({
      ...doc,
      blocks: [block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '改过的正文' }],
      })],
    }));
    expect(kernel.capture()).toEqual([
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '改过的正文' }],
      }),
    ]);
  });

  it('forwards the frozen editor props it was given', () => {
    const { seen } = mountKernel();
    expect(seen.props?.docId).toBe('doc-1');
    expect(seen.props?.externalRevision).toBe(3);
    expect(seen.props?.initialHtml).toContain('blk_h');
  });

  it('reports dirty, IME and notice events without leaking HTML', () => {
    const { kernel, seen } = mountKernel();
    const listener: EditorKernelListener & {
      onChange: ReturnType<typeof vi.fn>;
      onCompositionChange: ReturnType<typeof vi.fn>;
      onNotice: ReturnType<typeof vi.fn>;
    } = {
      onChange: vi.fn(),
      onCompositionChange: vi.fn(),
      onNotice: vi.fn(),
    };
    const unsubscribe = kernel.subscribe(listener);

    seen.props?.onChange('<p data-block-id="blk_p">x</p>');
    seen.props?.onCompositionChange?.(true);
    seen.props?.onNotice?.('粘贴内容已简化');

    // `onChange` is the contract's dirty signal: no HTML argument is exposed.
    expect(listener.onChange).toHaveBeenCalledWith();
    expect(listener.onCompositionChange).toHaveBeenCalledWith(true);
    expect(listener.onNotice).toHaveBeenCalledWith('粘贴内容已简化');

    unsubscribe();
    seen.props?.onChange('<p data-block-id="blk_p">y</p>');
    expect(listener.onChange).toHaveBeenCalledTimes(1);
  });

  it('drops listeners and the reported body on destroy', () => {
    const { kernel, seen, doc } = mountKernel();
    const onChange = vi.fn();
    kernel.subscribe({ onChange });

    const edited = alterDocToEditorHtml({
      ...doc,
      blocks: [block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '临时' }],
      })],
    });
    seen.props?.onChange(edited);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(kernel.capture()).not.toEqual(doc.blocks);

    kernel.destroy();
    expect(kernel.capture()).toEqual(doc.blocks);
    seen.props?.onChange(edited);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});