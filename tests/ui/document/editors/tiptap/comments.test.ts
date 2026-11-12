// @vitest-environment jsdom
/**
 * Comment decorations in the AST-native kernel.
 *
 * The frozen editor underlines commented text. The new kernel must keep that
 * visual contract (and must not guess): unique quotes get a range, ambiguous or
 * missing quotes get nothing, and the active comment is distinguished.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import {
  COMMENT_ACTIVE_CLASS,
  COMMENT_CLASS,
  commentDecorations,
  documentTextIndex,
  resolveCommentRanges,
  updateCommentExtensionOptions,
} from '../../../../../src/document/editors/tiptap/comments';
import { blocksToPmDoc } from '../../../../../src/document/editors/tiptap/convert';
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

function twoParagraphDoc(): AlterDoc {
  return doc([
    block('blk_a', 'paragraph', {}, {
      content: [{ type: 'text', text: '第一段有重要结论' }],
    }),
    block('blk_b', 'paragraph', {}, {
      content: [{ type: 'text', text: '第二段普通文字' }],
    }),
  ]);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
});

function mount(docValue: AlterDoc, comments: { id: string; quote: string }[], active?: string) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({
    element,
    doc: docValue,
    comments,
    ...(active === undefined ? {} : { activeCommentId: active }),
  });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

describe('documentTextIndex', () => {
  it('maps every character back to its ProseMirror position', () => {
    const { value } = blocksToPmDoc(twoParagraphDoc().blocks);
    const { text, positions } = documentTextIndex(value);
    expect(text).toContain('第一段有重要结论');
    expect(positions).toHaveLength(text.length);
    // Positions are strictly increasing along the text.
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]!).toBeGreaterThanOrEqual(positions[index - 1]!);
    }
  });
});

describe('resolveCommentRanges', () => {
  it('resolves a unique quote to one range', () => {
    const { value } = blocksToPmDoc(twoParagraphDoc().blocks);
    const ranges = resolveCommentRanges(value, [{ id: 'c1', quote: '重要结论' }], null);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.from).toBeLessThan(ranges[0]!.to);
  });

  it('refuses to guess when the quote appears more than once', () => {
    const { value } = blocksToPmDoc(
      doc([
        block('blk_a', 'paragraph', {}, {
          content: [{ type: 'text', text: '重复 重复' }],
        }),
      ]).blocks,
    );
    expect(resolveCommentRanges(value, [{ id: 'c1', quote: '重复' }], null)).toEqual([]);
  });

  it('ignores a quote that is no longer in the document', () => {
    const { value } = blocksToPmDoc(twoParagraphDoc().blocks);
    expect(
      resolveCommentRanges(value, [{ id: 'c1', quote: '已被删除的句子' }], null),
    ).toEqual([]);
  });

  it('marks the active comment', () => {
    const { value } = blocksToPmDoc(twoParagraphDoc().blocks);
    const ranges = resolveCommentRanges(
      value,
      [{ id: 'c1', quote: '重要结论' }],
      'c1',
    );
    expect(ranges[0]?.active).toBe(true);
  });
});

describe('comment decorations in the editor', () => {
  it('renders the frozen comment class on commented text', () => {
    const kernel = mount(twoParagraphDoc(), [{ id: 'c1', quote: '重要结论' }]);
    const surface = kernel.editor.view.dom;
    const marked = surface.querySelector(`.${COMMENT_CLASS}`);
    expect(marked).not.toBeNull();
    expect(marked?.getAttribute('data-comment-id')).toBe('c1');
    expect(marked?.textContent).toBe('重要结论');
  });

  it('distinguishes the active comment', () => {
    const kernel = mount(
      twoParagraphDoc(),
      [{ id: 'c1', quote: '重要结论' }],
      'c1',
    );
    const surface = kernel.editor.view.dom;
    expect(surface.querySelector(`.${COMMENT_ACTIVE_CLASS}`)).not.toBeNull();
  });

  it('paints nothing for an unresolved quote', () => {
    const kernel = mount(twoParagraphDoc(), [{ id: 'c9', quote: '不存在' }]);
    expect(
      kernel.editor.view.dom.querySelector(`.${COMMENT_CLASS}`),
    ).toBeNull();
  });

  it('drops the decoration when the commented text is edited away', () => {
    const kernel = mount(twoParagraphDoc(), [{ id: 'c1', quote: '重要结论' }]);
    const view = kernel.editor.view;
    expect(view.dom.querySelector(`.${COMMENT_CLASS}`)).not.toBeNull();
    // Delete the commented phrase through the view.
    const { text, positions } = documentTextIndex(view.state.doc);
    const start = text.indexOf('重要结论');
    view.dispatch(
      view.state.tr.delete(positions[start]!, positions[start + 4]! + 1),
    );
    expect(view.dom.querySelector(`.${COMMENT_CLASS}`)).toBeNull();
  });

  it('builds an empty set when there are no comments', () => {
    const { value } = blocksToPmDoc(twoParagraphDoc().blocks);
    expect(commentDecorations(value, [], null).find()).toEqual([]);
  });

  it('reports a commented-text click to the page', () => {
    const onCommentedTextClick = vi.fn();
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: twoParagraphDoc(),
      comments: [{ id: 'c1', quote: '重要结论' }],
      onCommentedTextClick,
    });
    cleanups.push(() => {
      kernel.destroy();
      element.remove();
    });
    const view = kernel.editor.view;
    const { text, positions } = documentTextIndex(view.state.doc);
    const pos = positions[text.indexOf('重要结论')]!;
    // Route a click through the plugin prop the way ProseMirror does.
    view.someProp('handleClick', (handler) => handler(view, pos, new MouseEvent('click') as never));
    expect(onCommentedTextClick).toHaveBeenCalledTimes(1);
  });

  it('refreshes decorations when the comment list changes', () => {
    const kernel = mount(twoParagraphDoc(), []);
    const view = kernel.editor.view;
    expect(view.dom.querySelector(`.${COMMENT_CLASS}`)).toBeNull();

    // A comment added while the document is open must appear without remount.
    updateCommentExtensionOptions(view, [{ id: 'c1', quote: '重要结论' }], null);
    expect(view.dom.querySelector(`.${COMMENT_CLASS}`)).not.toBeNull();

    // Resolving/removing it must clear the underline again.
    updateCommentExtensionOptions(view, [], null);
    expect(view.dom.querySelector(`.${COMMENT_CLASS}`)).toBeNull();
  });
});

