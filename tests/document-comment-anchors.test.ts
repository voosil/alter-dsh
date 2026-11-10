// @vitest-environment jsdom
/**
 * P2 comment anchors: selection → `{blockId, offset, length}`, anchor →
 * decorations, active-comment selection/scroll, click routing, IME guards and
 * invalid-anchor degradation.
 *
 * The editor is mounted directly (not through `AlterDocumentView`) so the
 * assertions target the editor contract the comment rail consumes.
 */
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import {
  AlterTiptapEditor,
  type AlterTiptapEditorProps,
} from '../src/document/editor/AlterTiptapEditor';
import {
  COMMENT_MARK_ACTIVE_CLASS,
  COMMENT_MARK_CLASS,
  COMMENT_MARK_RESOLVED_CLASS,
  MAX_COMMENT_QUOTE_LENGTH,
  blockText,
  commentAnchorRanges,
  commentAnchorText,
  getCommentDecorationState,
  scrollToCommentAnchor,
  type CommentAnchor,
  type CommentMarker,
} from '../src/document/editor/comment-marks';
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const commentDoc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [
    {
      id: 'blk_h',
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: '标题' }],
    },
    {
      id: 'blk_p',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '第一段文字' }],
    },
    {
      id: 'blk_list',
      type: 'bulletList',
      attrs: {},
      children: [
        {
          id: 'blk_li1',
          type: 'listItem',
          attrs: {},
          children: [
            {
              id: 'blk_li1p',
              type: 'paragraph',
              attrs: {},
              content: [{ type: 'text', text: '列表一' }],
            },
          ],
        },
        {
          id: 'blk_li2',
          type: 'listItem',
          attrs: {},
          children: [
            {
              id: 'blk_li2p',
              type: 'paragraph',
              attrs: {},
              content: [{ type: 'text', text: '列表二' }],
            },
          ],
        },
      ],
    },
    {
      id: 'blk_p2',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '第二段' }],
    },
  ],
};

const noIdDoc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [
    {
      id: 'blk_first',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '有 id 的段落' }],
    },
  ],
};

interface MountOptions {
  initialDoc?: AlterDoc;
  commentMarkers?: readonly CommentMarker[];
  activeCommentId?: string | null;
  onCommentAnchorChange?: AlterTiptapEditorProps['onCommentAnchorChange'];
  onCommentClick?: AlterTiptapEditorProps['onCommentClick'];
}

interface Harness {
  editor: () => Editor;
  rerender: (next: MountOptions) => void;
  applyOperations: ReturnType<typeof vi.fn>;
  anchorChanges: ((CommentAnchor & { quote: string }) | null)[];
  clicked: string[];
}

function mount(options: MountOptions = {}): Harness {
  const initialDoc = options.initialDoc ?? commentDoc;
  const revision = initialDoc.revision;
  const applyOperations = vi.fn(async () => ({
    docId: 'doc-comments',
    revision: revision + 1,
    changedBlockIds: [],
    diff: {},
    warnings: [],
  }));
  const client = {
    async get() {
      return { docId: 'doc-comments', revision, title: '评论文档', doc: initialDoc };
    },
    applyOperations,
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
  const anchorChanges: ((CommentAnchor & { quote: string }) | null)[] = [];
  const clicked: string[] = [];
  const props: AlterTiptapEditorProps = {
    docId: 'doc-comments',
    initialDoc,
    baseRevision: revision,
    initialTitle: '评论文档',
    title: '评论文档',
    client,
    onSaved: () => {},
    onEditorReady: (instance: Editor) => {
      captured = instance;
    },
    commentMarkers: options.commentMarkers,
    activeCommentId: options.activeCommentId ?? null,
    onCommentAnchorChange:
      options.onCommentAnchorChange ??
      ((anchor) => {
        anchorChanges.push(anchor);
      }),
    onCommentClick:
      options.onCommentClick ??
      ((id) => {
        clicked.push(id);
      }),
  };
  const view = render(createElement(AlterTiptapEditor, props));
  if (captured === undefined) throw new Error('editor instance was not ready');
  const rerender = (next: MountOptions): void => {
    Object.assign(props, next);
    view.rerender(createElement(AlterTiptapEditor, props));
  };
  return {
    editor: () => {
      if (captured === undefined) throw new Error('editor instance was not ready');
      return captured;
    },
    rerender,
    applyOperations,
    anchorChanges,
    clicked,
  };
}

function editorDom(): HTMLElement {
  const dom = document.querySelector(
    '[data-doc-editor="tiptap"] .ProseMirror',
  );
  if (dom === null) throw new Error('editor surface is missing');
  return dom as HTMLElement;
}

/** Doc positions of the first occurrence of `needle` in the editor text. */
function textRange(
  editor: Editor,
  needle: string,
): { from: number; to: number } | undefined {
  let found: { from: number; to: number } | undefined;
  editor.state.doc.descendants((node, position) => {
    if (found !== undefined) return false;
    if (!node.isText) return true;
    const index = (node.text ?? '').indexOf(needle);
    if (index < 0) return true;
    found = { from: position + index, to: position + index + needle.length };
    return false;
  });
  return found;
}

function selectText(editor: Editor, needle: string): void {
  const range = textRange(editor, needle);
  if (range === undefined) throw new Error(`text not found: ${needle}`);
  act(() => {
    editor.commands.setTextSelection(range);
  });
}

function lastAnchor(harness: Harness) {
  return harness.anchorChanges[harness.anchorChanges.length - 1];
}

// ---------------------------------------------------------------------------
// Selection → anchor
// ---------------------------------------------------------------------------

describe('selection → comment anchor', () => {
  it('maps a paragraph selection to blockId + plain-text offset/length', () => {
    const harness = mount();
    selectText(harness.editor(), '第一段');
    expect(lastAnchor(harness)).toEqual({
      blockId: 'blk_p',
      offset: 0,
      length: 3,
      quote: '第一段',
    });

    selectText(harness.editor(), '段文');
    expect(lastAnchor(harness)).toEqual({
      blockId: 'blk_p',
      offset: 2,
      length: 2,
      quote: '段文',
    });
  });

  it('counts flattened text for nested blocks (list items joined by newlines)', () => {
    const harness = mount();
    const list = harness
      .editor()
      .state.doc.child(2);
    // Nested block boundaries contribute one newline per block edge.
    expect(blockText(list)).toBe('列表一\n\n列表二');
    selectText(harness.editor(), '列表二');
    expect(lastAnchor(harness)).toEqual({
      blockId: 'blk_list',
      offset: 5,
      length: 3,
      quote: '列表二',
    });
  });

  it('clamps a cross-block selection to the first top-level block', () => {
    const harness = mount();
    const editor = harness.editor();
    const start = textRange(editor, '第一段文字');
    const end = textRange(editor, '第二段');
    if (start === undefined || end === undefined) throw new Error('fixture text missing');
    act(() => {
      editor.commands.setTextSelection({ from: start.from, to: end.from + 1 });
    });
    const anchor = lastAnchor(harness);
    expect(anchor).not.toBeNull();
    expect(anchor!.blockId).toBe('blk_p');
    expect(anchor!.offset).toBe(0);
    // Clamped to the end of the first block's text.
    expect(anchor!.length).toBe('第一段文字'.length);
    // Quote is the full selected plain text (block separators included).
    expect(anchor!.quote).toBe('第一段文字\n列表一\n列表二\n第');
  });

  it('reports null for an empty selection and on blur', () => {
    const harness = mount();
    const editor = harness.editor();
    selectText(editor, '第一段');
    expect(lastAnchor(harness)).not.toBeNull();
    act(() => {
      editor.commands.setTextSelection(2);
    });
    expect(lastAnchor(harness)).toBeNull();
    selectText(editor, '第二段');
    expect(lastAnchor(harness)).not.toBeNull();
    fireEvent.blur(editorDom());
    expect(lastAnchor(harness)).toBeNull();
  });

  it('does not report anchors while an IME composition is active', () => {
    const harness = mount();
    const editor = harness.editor();
    fireEvent.compositionStart(editorDom());
    selectText(editor, '第一段');
    expect(harness.anchorChanges).toHaveLength(0);
    fireEvent.compositionEnd(editorDom());
    // The pending selection is reported once composition ends.
    expect(lastAnchor(harness)).toEqual({
      blockId: 'blk_p',
      offset: 0,
      length: 3,
      quote: '第一段',
    });
  });

  it('assigns a blockId on demand for blocks created by editing', () => {
    const harness = mount({ initialDoc: noIdDoc });
    const editor = harness.editor();
    // Split the paragraph: the new block keeps the text but has no blockId.
    act(() => {
      editor.commands.setTextSelection(6);
      editor.commands.splitBlock();
    });
    selectText(editor, '的段落');
    const anchor = lastAnchor(harness);
    expect(anchor).not.toBeNull();
    expect(anchor!.blockId).toMatch(/^blk_/);
    let ids: string[] = [];
    editor.state.doc.forEach((node) => {
      const id = node.attrs['blockId'];
      if (typeof id === 'string') ids.push(id);
    });
    expect(ids).toContain(anchor!.blockId);
  });

  it('caps the reported quote length', () => {
    const longDoc: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [
        {
          id: 'blk_long',
          type: 'paragraph',
          attrs: {},
          content: [{ type: 'text', text: 'x'.repeat(700) }],
        },
      ],
    };
    const harness = mount({ initialDoc: longDoc });
    const editor = harness.editor();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 1 + 600 });
    });
    const anchor = lastAnchor(harness);
    expect(anchor).not.toBeNull();
    expect(anchor!.length).toBe(600);
    expect(anchor!.quote.length).toBe(MAX_COMMENT_QUOTE_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

describe('comment decorations', () => {
  const validAnchor: CommentAnchor = { blockId: 'blk_p', offset: 0, length: 3 };

  function markers(): CommentMarker[] {
    return [
      { id: 'c1', anchor: validAnchor },
      { id: 'c2', anchor: { blockId: 'blk_missing', offset: 0, length: 2 } },
      { id: 'c3', anchor: { blockId: 'blk_p', offset: 4, length: 99 } },
      { id: 'c4', anchor: { blockId: 'blk_list', offset: 5, length: 3 } },
    ];
  }

  it('renders valid highlights and skips invalid anchors', () => {
    const harness = mount({ commentMarkers: markers() });
    const marks = document.querySelectorAll(`.${COMMENT_MARK_CLASS}`);
    expect(marks).toHaveLength(2);
    expect(Array.from(marks).map((mark) => mark.getAttribute('data-comment-id'))).toEqual([
      'c1',
      'c4',
    ]);
    const state = getCommentDecorationState(harness.editor());
    expect(state?.invalidIds).toEqual(['c2', 'c3']);
  });

  it('marks the active and resolved comments distinctly', () => {
    const harness = mount({
      commentMarkers: [
        { id: 'c1', anchor: validAnchor },
        { id: 'c2', anchor: { blockId: 'blk_p2', offset: 0, length: 3 }, resolved: true },
      ],
      activeCommentId: 'c1',
    });
    const active = document.querySelector(
      `.${COMMENT_MARK_CLASS}.${COMMENT_MARK_ACTIVE_CLASS}`,
    );
    expect(active?.getAttribute('data-comment-id')).toBe('c1');
    const resolved = document.querySelector(`.${COMMENT_MARK_RESOLVED_CLASS}`);
    expect(resolved?.getAttribute('data-comment-id')).toBe('c2');
  });

  it('refreshes decorations when markers change without recreating the editor', () => {
    const harness = mount({ commentMarkers: [markers()[0]!] });
    const editor = harness.editor();
    expect(document.querySelectorAll(`.${COMMENT_MARK_CLASS}`)).toHaveLength(1);

    harness.rerender({
      commentMarkers: [
        markers()[0]!,
        { id: 'c4', anchor: { blockId: 'blk_p2', offset: 0, length: 3 } },
      ],
    });
    expect(harness.editor()).toBe(editor);
    expect(document.querySelectorAll(`.${COMMENT_MARK_CLASS}`)).toHaveLength(2);
    // A decoration refresh is a meta-only transaction: it must not dirty the
    // document or trigger the P0 autosave.
    expect(harness.applyOperations).not.toHaveBeenCalled();
  });

  it('keeps decorations across an autosave (P0 lifecycle unchanged)', async () => {
    vi.useFakeTimers();
    const harness = mount({
      commentMarkers: [{ id: 'c1', anchor: validAnchor }],
    });
    const editor = harness.editor();
    act(() => {
      editor.commands.insertContentAt(1, '前缀');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(harness.applyOperations).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(`.${COMMENT_MARK_CLASS}`)).toHaveLength(1);
  });

  it('routes clicks on a highlight to onCommentClick', () => {
    const harness = mount({ commentMarkers: [markers()[0]!] });
    const mark = document.querySelector(`.${COMMENT_MARK_CLASS}`);
    if (mark === null) throw new Error('comment highlight missing');
    fireEvent.click(mark);
    expect(harness.clicked).toEqual(['c1']);
  });

  it('rebuilds highlights on edit and drops anchors whose block is gone', () => {
    const harness = mount({ commentMarkers: [markers()[0]!, markers()[3]!] });
    const editor = harness.editor();
    expect(document.querySelectorAll(`.${COMMENT_MARK_CLASS}`)).toHaveLength(2);

    // Insert text before the anchor: offsets drift (P2 does not re-anchor) but
    // rendering must stay stable.
    act(() => {
      editor.commands.insertContentAt(1, '前缀');
    });
    expect(document.querySelectorAll(`.${COMMENT_MARK_CLASS}`)).toHaveLength(2);

    // Delete the whole paragraph block: the anchor becomes invalid and is
    // dropped instead of pointing somewhere wrong.
    const paragraph = textRange(editor, '第一段文字');
    if (paragraph === undefined) throw new Error('fixture text missing');
    const blockStart = paragraph.from - 1;
    const blockEnd = paragraph.to + 1;
    act(() => {
      editor.commands.deleteRange({ from: blockStart, to: blockEnd });
    });
    expect(
      Array.from(document.querySelectorAll(`.${COMMENT_MARK_CLASS}`)).map(
        (mark) => mark.getAttribute('data-comment-id'),
      ),
    ).toEqual(['c4']);
    expect(getCommentDecorationState(editor)?.invalidIds).toEqual(['c1']);
  });
});

// ---------------------------------------------------------------------------
// Active comment / scroll helpers
// ---------------------------------------------------------------------------

describe('comment location', () => {
  const anchor: CommentAnchor = { blockId: 'blk_p', offset: 2, length: 2 };

  it('scrollToCommentAnchor selects the anchored text', () => {
    const harness = mount();
    const editor = harness.editor();
    expect(scrollToCommentAnchor(editor, anchor)).toBe(true);
    const expected = textRange(editor, '段文');
    expect(editor.state.selection.from).toBe(expected!.from);
    expect(editor.state.selection.to).toBe(expected!.to);
  });

  it('rejects invalid anchors without touching the selection', () => {
    const harness = mount();
    const editor = harness.editor();
    act(() => {
      editor.commands.setTextSelection(2);
    });
    const before = editor.state.selection.from;
    expect(
      scrollToCommentAnchor(editor, { blockId: 'blk_missing', offset: 0, length: 2 }),
    ).toBe(false);
    expect(
      scrollToCommentAnchor(editor, { blockId: 'blk_p', offset: 4, length: 10 }),
    ).toBe(false);
    expect(editor.state.selection.from).toBe(before);
  });

  it('selects the anchor when activeCommentId changes', () => {
    const harness = mount({
      commentMarkers: [{ id: 'c1', anchor }],
      activeCommentId: null,
    });
    const editor = harness.editor();
    const anchorChangesBefore = harness.anchorChanges.length;
    harness.rerender({
      commentMarkers: [{ id: 'c1', anchor }],
      activeCommentId: 'c1',
    });
    const expected = textRange(editor, '段文');
    expect(editor.state.selection.from).toBe(expected!.from);
    expect(editor.state.selection.to).toBe(expected!.to);
    // Programmatic selection must not be reported back as a user selection.
    expect(harness.anchorChanges.length).toBe(anchorChangesBefore);
  });

  it('ignores an unknown activeCommentId', () => {
    const harness = mount({
      commentMarkers: [{ id: 'c1', anchor }],
      activeCommentId: null,
    });
    const editor = harness.editor();
    const before = editor.state.selection.from;
    harness.rerender({
      commentMarkers: [{ id: 'c1', anchor }],
      activeCommentId: 'c-unknown',
    });
    expect(editor.state.selection.from).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Pure anchor helpers
// ---------------------------------------------------------------------------

describe('anchor helpers', () => {
  it('resolves ranges and text for valid anchors only', () => {
    const harness = mount();
    const doc = harness.editor().state.doc;
    expect(commentAnchorRanges(doc, { blockId: 'blk_p', offset: 2, length: 2 }))
      .toHaveLength(1);
    expect(commentAnchorText(doc, { blockId: 'blk_p', offset: 2, length: 2 }))
      .toBe('段文');
    expect(commentAnchorText(doc, { blockId: 'blk_missing', offset: 0, length: 1 }))
      .toBeUndefined();
    expect(commentAnchorRanges(doc, { blockId: 'blk_p', offset: 4, length: 2 }))
      .toBeUndefined();
  });

  it('splits an anchor that spans several inline runs', () => {
    const harness = mount();
    const doc = harness.editor().state.doc;
    const ranges = commentAnchorRanges(doc, {
      blockId: 'blk_list',
      offset: 2,
      length: 4,
    });
    expect(ranges).toBeDefined();
    // "列表一\n列表二" from offset 2 covers the tail of item 1 and the head of
    // item 2 → two inline decorations (a separator is never highlighted).
    expect(ranges!.length).toBe(2);
  });
});
