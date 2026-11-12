// @vitest-environment jsdom
/**
 * Comment underlines in the AST-native kernel.
 *
 * The frozen editor paints commented ranges with the CSS Custom Highlight API
 * (`::highlight(alter-comment)`), never by wrapping DOM. The kernel must keep
 * that contract: unique quotes become ranges, ambiguous or missing quotes paint
 * nothing, the active comment goes into its own highlight name, and an edit
 * that removes the quote clears the paint.
 *
 * jsdom has no Highlight API, so the tests install a recording stub: they
 * assert what the kernel registers (names + range text) instead of computed
 * styles, which is the part the frozen stylesheet depends on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import {
  COMMENT_ACTIVE_HIGHLIGHT,
  COMMENT_HIGHLIGHT,
  documentTextIndex,
  resolveCommentRanges,
  updateCommentExtensionOptions,
} from '../../../../../src/document/editors/tiptap/comments';
import { blocksToPmDoc } from '../../../../../src/document/editors/tiptap/convert';
import { TextSelection } from '@tiptap/pm/state';
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

/** One recorded highlight registration. */
interface HighlightRecord {
  name: string;
  ranges: Range[];
}

const painted: HighlightRecord[] = [];
const registry = new Map<string, unknown>();

/** Stub the browser Highlight API surface the kernel uses. */
function installHighlightStub(): void {
  class FakeHighlight {
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
    readonly ranges: Range[];
  }
  Object.defineProperty(globalThis, 'Highlight', {
    configurable: true,
    writable: true,
    value: FakeHighlight,
  });
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    writable: true,
    value: {
      highlights: {
        set(name: string, value: { ranges: Range[] }) {
          registry.set(name, value);
          painted.push({ name, ranges: value.ranges });
        },
        delete(name: string) {
          registry.delete(name);
          painted.push({ name, ranges: [] });
        },
      },
    },
  });
}

beforeEach(() => {
  painted.length = 0;
  registry.clear();
  installHighlightStub();
});

afterEach(() => {
  delete (globalThis as { Highlight?: unknown }).Highlight;
  delete (globalThis as { CSS?: unknown }).CSS;
});

function mount(
  docValue: AlterDoc,
  comments: { id: string; quote: string }[],
  active?: string,
  options: {
    onCommentAtCaretChange?: (id: string | null) => void;
  } = {},
) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({
    element,
    doc: docValue,
    comments,
    ...(active === undefined ? {} : { activeCommentId: active }),
    ...(options.onCommentAtCaretChange === undefined
      ? {}
      : { onCommentAtCaretChange: options.onCommentAtCaretChange }),
  });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/** The ranges registered under one highlight name, last write wins. */
function paintedRanges(name: string): Range[] {
  const record = [...painted].reverse().find((entry) => entry.name === name);
  return record?.ranges ?? [];
}

describe('documentTextIndex', () => {
  it('maps every character back to its ProseMirror position', () => {
    const { value } = blocksToPmDoc(twoParagraphDoc().blocks);
    const { text, positions } = documentTextIndex(value);
    expect(text).toContain('第一段有重要结论');
    expect(positions).toHaveLength(text.length);
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

describe('comment highlights in the editor', () => {
  it('registers the frozen highlight name for a unique quote', () => {
    mount(twoParagraphDoc(), [{ id: 'c1', quote: '重要结论' }]);
    const ranges = paintedRanges(COMMENT_HIGHLIGHT);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.toString()).toBe('重要结论');
    expect(paintedRanges(COMMENT_ACTIVE_HIGHLIGHT)).toHaveLength(0);
  });

  it('puts the active comment in its own highlight name', () => {
    mount(twoParagraphDoc(), [{ id: 'c1', quote: '重要结论' }], 'c1');
    expect(paintedRanges(COMMENT_ACTIVE_HIGHLIGHT)).toHaveLength(1);
    expect(paintedRanges(COMMENT_HIGHLIGHT)).toHaveLength(0);
  });

  it('reports the comment under the caret so the rail follows the cursor', () => {
    // The frozen page keeps the caret/hover comment active: clicking into
    // commented text activates its rail card and its text tint.
    const seen: (string | null)[] = [];
    const kernel = mount(
      twoParagraphDoc(),
      [{ id: 'c1', quote: '重要结论' }],
      undefined,
      { onCommentAtCaretChange: (id) => seen.push(id) },
    );
    const view = kernel.editor.view;
    const { text, positions } = documentTextIndex(view.state.doc);
    const start = text.indexOf('重要结论');
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, positions[start]! + 1),
      ),
    );
    expect(seen).toEqual(['c1']);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)),
    );
    expect(seen).toEqual(['c1', null]);
  });

  it('paints nothing for an unresolved quote', () => {
    mount(twoParagraphDoc(), [{ id: 'c9', quote: '不存在' }]);
    expect(paintedRanges(COMMENT_HIGHLIGHT)).toHaveLength(0);
    expect(paintedRanges(COMMENT_ACTIVE_HIGHLIGHT)).toHaveLength(0);
  });

  it('clears the paint when the commented text is edited away', () => {
    const kernel = mount(twoParagraphDoc(), [{ id: 'c1', quote: '重要结论' }]);
    const view = kernel.editor.view;
    expect(paintedRanges(COMMENT_HIGHLIGHT)).toHaveLength(1);
    const { text, positions } = documentTextIndex(view.state.doc);
    const start = text.indexOf('重要结论');
    view.dispatch(
      view.state.tr.delete(positions[start]!, positions[start + 4]! + 1),
    );
    expect(paintedRanges(COMMENT_HIGHLIGHT)).toHaveLength(0);
  });

  it('repaints when the comment list changes without remounting', () => {
    const kernel = mount(twoParagraphDoc(), []);
    const view = kernel.editor.view;
    expect(paintedRanges(COMMENT_HIGHLIGHT)).toHaveLength(0);

    updateCommentExtensionOptions(view, [{ id: 'c1', quote: '重要结论' }], null);
    expect(paintedRanges(COMMENT_HIGHLIGHT)).toHaveLength(1);

    updateCommentExtensionOptions(view, [], null);
    expect(paintedRanges(COMMENT_HIGHLIGHT)).toHaveLength(0);
  });

  it('clears the highlight registry when the editor is destroyed', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: twoParagraphDoc(),
      comments: [{ id: 'c1', quote: '重要结论' }],
    });
    expect(registry.has(COMMENT_HIGHLIGHT)).toBe(true);
    kernel.destroy();
    element.remove();
    expect(registry.has(COMMENT_HIGHLIGHT)).toBe(false);
    expect(registry.has(COMMENT_ACTIVE_HIGHLIGHT)).toBe(false);
  });

  it('reports a changed quote when the commented text is edited', () => {
    // The frozen editor keeps comment ranges as flat-text anchors and pushes
    // the new snippet to the page, which persists it; a kernel that skipped
    // this would leave every comment pointing at stale text.
    const updates: Array<readonly { id: string; quote: string }[]> = [];
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: twoParagraphDoc(),
      comments: [{ id: 'c1', quote: '重要结论' }],
      onCommentQuotesChange: (next) => updates.push(next),
    });
    cleanups.push(() => {
      kernel.destroy();
      element.remove();
    });
    const view = kernel.editor.view;
    const { text, positions } = documentTextIndex(view.state.doc);
    const start = text.indexOf('重要结论');
    // Type one character inside the commented range.
    view.dispatch(
      view.state.tr.insertText('很', positions[start]! + 2),
    );
    expect(updates.at(-1)?.[0]?.quote).toBe('重要很结论');
  });

  it('does not report a quote twice for the same change', () => {
    const updates: Array<readonly { id: string; quote: string }[]> = [];
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: twoParagraphDoc(),
      comments: [{ id: 'c1', quote: '重要结论' }],
      onCommentQuotesChange: (next) => updates.push(next),
    });
    cleanups.push(() => {
      kernel.destroy();
      element.remove();
    });
    const view = kernel.editor.view;
    const { text, positions } = documentTextIndex(view.state.doc);
    view.dispatch(
      view.state.tr.insertText('很', positions[text.indexOf('重要结论')]! + 2),
    );
    // The page adopts the new quote (that is what stops the reporting loop).
    updateCommentExtensionOptions(view, [{ id: 'c1', quote: '重要很结论' }], null);
    const count = updates.length;
    // A later, unrelated edit outside the comment must not re-report it.
    view.dispatch(view.state.tr.insertText('尾', view.state.doc.content.size));
    expect(updates.length).toBe(count);
  });

  it('keeps the anchor when the page echoes the updated quote back', () => {
    const updates: Array<readonly { id: string; quote: string }[]> = [];
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: twoParagraphDoc(),
      comments: [{ id: 'c1', quote: '重要结论' }],
      onCommentQuotesChange: (next) => updates.push(next),
    });
    cleanups.push(() => {
      kernel.destroy();
      element.remove();
    });
    const view = kernel.editor.view;
    const { text, positions } = documentTextIndex(view.state.doc);
    view.dispatch(
      view.state.tr.insertText('很', positions[text.indexOf('重要结论')]! + 2),
    );
    const before = updates.length;
    // The page rebroadcasts the persisted list (meta only, no document edit).
    updateCommentExtensionOptions(view, [{ id: 'c1', quote: '重要很结论' }], null);
    expect(updates.length).toBe(before);
    expect(paintedRanges(COMMENT_HIGHLIGHT)[0]?.toString()).toBe('重要很结论');
  });

  it('reseeds anchors on reload instead of moving old offsets', () => {
    // An external reload replaces the whole body. Old anchors must not be
    // shifted into the new text (that would report a wrong quote to the page);
    // they are dropped and only quotes that still match are re-anchored.
    const updates: unknown[] = [];
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: twoParagraphDoc(),
      comments: [{ id: 'c1', quote: '重要结论' }],
      onCommentQuotesChange: (next) => updates.push(next),
    });
    cleanups.push(() => {
      kernel.destroy();
      element.remove();
    });
    kernel.load({
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 2,
      blocks: [
        block('blk_new', 'paragraph', {}, {
          content: [{ type: 'text', text: '完全不同的内容' }],
        }),
      ],
    });
    expect(updates).toHaveLength(0);
    expect(paintedRanges(COMMENT_HIGHLIGHT)).toHaveLength(0);
    expect(paintedRanges(COMMENT_ACTIVE_HIGHLIGHT)).toHaveLength(0);
  });

  it('re-anchors a quote that survives the reload', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const kernel = createKernelEditor({
      element,
      doc: twoParagraphDoc(),
      comments: [{ id: 'c1', quote: '普通文字' }],
    });
    cleanups.push(() => {
      kernel.destroy();
      element.remove();
    });
    kernel.load({
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 2,
      blocks: [
        block('blk_new', 'paragraph', {}, {
          content: [{ type: 'text', text: '开头 普通文字 结尾' }],
        }),
      ],
    });
    expect(paintedRanges(COMMENT_HIGHLIGHT)).toHaveLength(1);
    expect(paintedRanges(COMMENT_HIGHLIGHT)[0]?.toString()).toBe('普通文字');
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
    view.someProp('handleClick', (handler) =>
      handler(view, pos, new MouseEvent('click') as never),
    );
    expect(onCommentedTextClick).toHaveBeenCalledTimes(1);
  });

  it('does not report a click outside every commented range', () => {
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
    const pos = positions[text.indexOf('第二段')]!;
    view.someProp('handleClick', (handler) =>
      handler(view, pos, new MouseEvent('click') as never),
    );
    expect(onCommentedTextClick).not.toHaveBeenCalled();
  });
});