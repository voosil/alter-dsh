// @vitest-environment jsdom
/**
 * The document page's body bridge exposes the link writer.
 *
 * The page owns the 编辑链接 dialog but the kernel owns the document, so the
 * bridge must hand over an `applyLinkEdit` handle once mounted and route it to
 * the live ProseMirror view.
 */
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TiptapBody } from '../../../../../src/document/editors/tiptap/body';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

const zeroRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
Element.prototype.getBoundingClientRect = zeroRect as never;
// A selection also positions the floating toolbar, which measures ranges.
const zeroRects = () => [] as unknown as DOMRectList;
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = zeroRects as never;
}
if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = zeroRects as never;
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = zeroRect as never;
}

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function cardDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      block('blk_bm', 'bookmark', { url: 'https://old.example', title: '旧标题' }),
      block('blk_tail', 'paragraph', {}, {
        content: [{ type: 'text', text: '之后' }],
      }),
    ],
  };
}

afterEach(() => {
  cleanup();
});

describe('TiptapBody link write-back', () => {
  it('hands the page an applyLinkEdit handle and applies its input', () => {
    const onBlocks = vi.fn();
    const handles: Array<{
      applyLinkEdit(input: {
        kind: 'card' | 'inline';
        pos: number;
        href: string;
        label: string;
      }): void;
    }> = [];
    const doc = cardDoc();
    render(
      createElement(TiptapBody, {
        docId: 'doc-1',
        document: doc,
        revision: 1,
        baseHtml: '',
        caret: 'none',
        comments: [],
        onBlocks,
        onReady: (handle: (typeof handles)[number]) => handles.push(handle),
      }),
    );
    expect(handles).toHaveLength(1);
    handles[0]!.applyLinkEdit({
      kind: 'card',
      pos: 0,
      href: 'https://new.example',
      label: '新标题',
    });
    const view = (document.querySelector('[data-editor-kernel="tiptap"]') as
      | (HTMLElement & { pmView?: { state: { doc: never } } })
      | null)?.pmView;
    expect(view).toBeDefined();
    const blocks = pmDocToBlocks(view!.state.doc as never).value;
    expect(blocks[0]?.attrs['url']).toBe('https://new.example');
    expect(blocks[0]?.attrs['title']).toBe('新标题');
    // The write is a document edit, so the page is told to save.
    expect(onBlocks).toHaveBeenCalled();
  });

  it('reports the selection so the page can quote it for a new comment', () => {
    const onSelectionChange = vi.fn();
    const doc: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [
        block('blk_p', 'paragraph', {}, {
          content: [{ type: 'text', text: '这段是要评论的内容' }],
        }),
      ],
    };
    render(
      createElement(TiptapBody, {
        docId: 'doc-1',
        document: doc,
        revision: 1,
        baseHtml: '',
        caret: 'none',
        comments: [],
        onBlocks: () => undefined,
        onSelectionChange,
      }),
    );
    const host = document.querySelector('[data-editor-kernel="tiptap"]') as
      | (HTMLElement & { pmView?: { state: { doc: never; tr: unknown }; dispatch(tr: unknown): void } })
      | null;
    const view = host?.pmView;
    expect(view).toBeDefined();

    // Select the middle of the paragraph, the way a drag selection would.
    const selectionConstructor = (
      view!.state as unknown as {
        selection: { constructor: { create(doc: unknown, from: number, to: number): unknown } };
      }
    ).selection.constructor;
    const tr = (view!.state as unknown as { tr: { setSelection(sel: unknown): unknown } }).tr;
    view!.dispatch(
      tr.setSelection(selectionConstructor.create(view!.state.doc, 1, 5)) as never,
    );

    expect(onSelectionChange).toHaveBeenCalled();
    const last = onSelectionChange.mock.calls.at(-1)?.[0] as {
      quote: string;
      collapsed: boolean;
    } | undefined;
    expect(last?.collapsed).toBe(false);
    expect(last?.quote.trim()).toBe('这段是要');
  });
});