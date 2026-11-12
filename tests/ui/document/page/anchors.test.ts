// @vitest-environment jsdom
/**
 * E4 comment-anchor validity: drift detection, unique-quote auto repair and
 * the explicit 「部分评论锚点已失效」 notice, plus the DocumentView wiring
 * (repair after comments load and after a successful save).
 */
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment } from '@alter/protocol';
import {
  detectAnchorDrift,
  planCommentAnchorRepairs,
  planReanchor,
  quoteMatchesAnchorText,
  validateCommentAnchor,
  type AnchorComment,
} from '../../../../src/document/runtime';
import type { AlterDoc } from '../../../../src/document/types';
import {
  createPageClient,
  editorSurface,
  installResizeObserver,
  makeNode,
  mountDocumentPage,
  paragraph,
  settle,
  tick,
} from '../../../support/document-page';

let restoreResizeObserver: () => void;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreResizeObserver();
});

/** Three simple paragraphs with unique first/second quotes. */
function anchorDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 4,
    blocks: [
      paragraph('blk_p1', '第一段正文内容'),
      paragraph('blk_p2', '第二段正文内容'),
      paragraph('blk_p3', '无关内容'),
    ],
  };
}

function comment(overrides: Partial<AnchorComment> = {}): AnchorComment {
  return {
    id: 'cm-1',
    quote: '第一段正文内容',
    anchor: {
      blockId: 'blk_p1',
      offset: 0,
      length: '第一段正文内容'.length,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure anchor helpers
// ---------------------------------------------------------------------------

describe('comment anchor validation (E4)', () => {
  it('accepts a valid anchor and reports its anchored text', () => {
    const doc = anchorDoc();
    const item = comment();
    expect(validateCommentAnchor(item, doc)).toBe('valid');
    const drift = detectAnchorDrift(item, doc);
    expect(drift.status).toBe('valid');
    expect(drift.currentText).toBe('第一段正文内容');
  });

  it('flags a missing block and repairs it from the unique quote', () => {
    const doc = anchorDoc();
    const item = comment({
      anchor: { blockId: 'blk_missing', offset: 0, length: 6 },
    });
    expect(validateCommentAnchor(item, doc)).toBe('missing-block');
    expect(planReanchor(item, doc)).toEqual({
      blockId: 'blk_p1',
      offset: 0,
      length: '第一段正文内容'.length,
    });
  });

  it('flags out-of-range offsets and repairs them', () => {
    const doc = anchorDoc();
    const outOfRange = comment({
      anchor: { blockId: 'blk_p1', offset: 999, length: 4 },
    });
    expect(validateCommentAnchor(outOfRange, doc)).toBe('out-of-range');
    expect(planReanchor(outOfRange, doc)?.blockId).toBe('blk_p1');

    const negative = comment({
      anchor: { blockId: 'blk_p1', offset: -1, length: 4 },
    });
    expect(validateCommentAnchor(negative, doc)).toBe('out-of-range');
  });

  it('flags text mismatch and repairs it when the quote is unique', () => {
    const doc = anchorDoc();
    const drifted = comment({
      quote: '第二段正文内容',
      anchor: { blockId: 'blk_p1', offset: 0, length: 6 },
    });
    expect(validateCommentAnchor(drifted, doc)).toBe('text-mismatch');
    expect(planReanchor(drifted, doc)).toEqual({
      blockId: 'blk_p2',
      offset: 0,
      length: '第二段正文内容'.length,
    });
  });

  it('tolerates trimmed and truncated quotes', () => {
    const doc = anchorDoc();
    const trimmed = comment({ quote: '  第一段正文内容  ' });
    expect(validateCommentAnchor(trimmed, doc)).toBe('valid');

    const longDoc: AlterDoc = {
      ...doc,
      blocks: [
        paragraph(
          'blk_long',
          '这是一段足够长的正文内容用于截断容差测试',
        ),
      ],
    };
    const target = '这是一段足够长的正文内容用于截断容差测试';
    const truncated = comment({
      quote: target.slice(0, 10),
      anchor: { blockId: 'blk_long', offset: 0, length: target.length },
    });
    expect(validateCommentAnchor(truncated, longDoc)).toBe('valid');
    expect(
      quoteMatchesAnchorText('这是一段足够长的正文内容', '这是一段足够长的'),
    ).toBe(true);
    expect(quoteMatchesAnchorText('完全不同的文字', '第一段正文内容')).toBe(false);
  });

  it('never guesses an anchor for ambiguous or missing quotes', () => {
    const ambiguous: AlterDoc = {
      ...anchorDoc(),
      blocks: [
        paragraph('blk_a', '重复内容'),
        paragraph('blk_b', '重复内容'),
      ],
    };
    const item = comment({
      quote: '重复内容',
      anchor: { blockId: 'blk_missing', offset: 0, length: 4 },
    });
    expect(planReanchor(item, ambiguous)).toBeNull();
    expect(planReanchor(comment({ quote: '不存在的引用' }), anchorDoc())).toBeNull();
  });

  it('classifies a comment list into repairs and unresolved ids', () => {
    const doc = anchorDoc();
    const plan = planCommentAnchorRepairs(
      [
        comment(),
        comment({
          id: 'cm-drift',
          quote: '第二段正文内容',
          anchor: { blockId: 'blk_missing', offset: 0, length: 3 },
        }),
        comment({
          id: 'cm-lost',
          quote: '不存在的引用文字',
          anchor: { blockId: 'blk_p3', offset: 0, length: 3 },
        }),
        // Full-document comments (no quote) have no anchor by design.
        comment({ id: 'cm-full', quote: null, anchor: null }),
        // Unanchored comment with a unique quote can be repaired.
        comment({ id: 'cm-new', anchor: null }),
      ],
      doc,
    );
    expect(plan.repairs).toEqual([
      {
        commentId: 'cm-drift',
        anchor: {
          blockId: 'blk_p2',
          offset: 0,
          length: '第二段正文内容'.length,
        },
      },
      {
        commentId: 'cm-new',
        anchor: {
          blockId: 'blk_p1',
          offset: 0,
          length: '第一段正文内容'.length,
        },
      },
    ]);
    expect(plan.unresolvedIds).toEqual(['cm-lost']);
  });
});

// ---------------------------------------------------------------------------
// DocumentView wiring
// ---------------------------------------------------------------------------

function makeComment(overrides: Partial<Comment>): Comment {
  return {
    id: 'cm-1',
    docId: 'doc-1',
    author: 'me',
    body: '评论',
    quote: null,
    anchor: null,
    status: 'open',
    createdAt: '2026-11-10T00:00:00.000Z',
    resolvedAt: null,
    editedAt: null,
    supplements: [],
    ...overrides,
  };
}

function renderAnchorsPage(
  doc: AlterDoc,
  comments: Comment[],
  options: { applyOperations?: (input: unknown) => Promise<unknown> } = {},
) {
  const node = makeNode(doc);
  const client = createPageClient(
    doc,
    options.applyOperations === undefined
      ? {}
      : { applyOperations: options.applyOperations },
  );
  const updateComment = vi.fn(async (id: string, patch: unknown) => ({
    ...comments.find((item) => item.id === id),
    ...(patch as object),
  }));
  const page = mountDocumentPage(node, client, {
    listComments: vi.fn(async () => comments),
    updateComment,
  });
  return { page, client, updateComment };
}

describe('comment anchor repair in DocumentView (E4)', () => {
  it('rewrites only uniquely repairable anchors and warns once for the rest', async () => {
    const doc = anchorDoc();
    const comments: Comment[] = [
      makeComment({
        id: 'cm-repair',
        quote: '第二段正文内容',
        anchor: { blockId: 'blk_missing', offset: 0, length: 3 },
      }),
      makeComment({
        id: 'cm-lost',
        quote: '不存在的引用文字',
        anchor: { blockId: 'blk_p3', offset: 0, length: 3 },
      }),
      makeComment({
        id: 'cm-valid',
        quote: '无关内容',
        anchor: { blockId: 'blk_p3', offset: 0, length: 4 },
      }),
    ];
    const { page, updateComment } = renderAnchorsPage(doc, comments);
    await waitFor(() => expect(updateComment).toHaveBeenCalledTimes(1));
    expect(updateComment).toHaveBeenCalledWith('cm-repair', {
      anchor: { blockId: 'blk_p2', offset: 0, length: 7 },
    });
    await waitFor(() => expect(page.toast).toHaveBeenCalledWith('部分评论锚点已失效'));
    // Exactly one notice for any number of unresolved anchors.
    const notices = page.toast.mock.calls.filter(
      (call) => call[0] === '部分评论锚点已失效',
    );
    expect(notices).toHaveLength(1);
    expect(updateComment).not.toHaveBeenCalledWith(
      'cm-valid',
      expect.anything(),
    );
  });

  it('stays silent when every anchor is valid', async () => {
    const doc = anchorDoc();
    const comments: Comment[] = [
      makeComment({
        id: 'cm-valid',
        quote: '无关内容',
        anchor: { blockId: 'blk_p3', offset: 0, length: 4 },
      }),
    ];
    const { page, updateComment } = renderAnchorsPage(doc, comments);
    await waitFor(() => expect(editorSurface(page.container)).toBeTruthy());
    await settle();
    expect(updateComment).not.toHaveBeenCalled();
    expect(page.toast).not.toHaveBeenCalledWith('部分评论锚点已失效');
  });

  it('repairs an ambiguous anchor after a save makes the quote unique again', async () => {
    vi.useFakeTimers();
    const doc: AlterDoc = {
      ...anchorDoc(),
      blocks: [
        paragraph('blk_a', '重复内容一'),
        paragraph('blk_b', '重复内容二'),
      ],
    };
    const comments: Comment[] = [
      makeComment({
        id: 'cm-dup',
        quote: '重复内容',
        anchor: { blockId: 'blk_missing', offset: 0, length: 4 },
      }),
    ];
    const { page, updateComment } = renderAnchorsPage(doc, comments);
    await settle();
    await settle();
    // Ambiguous while both blocks repeat the quote: no write, one notice.
    expect(updateComment).not.toHaveBeenCalled();
    expect(page.toast).toHaveBeenCalledWith('部分评论锚点已失效');

    // Remove one duplicate by editing the first paragraph, then save.
    await page.replaceFirstBlockText('已改写');
    await tick(700);
    await settle();
    await settle();
    await settle();
    await tick(0);
    await settle();

    // The editor also refreshes the stored quote while editing; the anchor
    // repair is the call that carries an `anchor` patch. With the duplicate
    // gone the stored quote matches one block again, so the anchor is repaired.
    const anchorRepairs = updateComment.mock.calls.filter(
      (call) => (call[1] as { anchor?: unknown }).anchor !== undefined,
    );
    expect(anchorRepairs).toHaveLength(1);
    expect(anchorRepairs[0]).toEqual([
      'cm-dup',
      { anchor: { blockId: 'blk_b', offset: 0, length: 4 } },
    ]);
    expect(screen.getByText('已改写')).toBeTruthy();
  });

  it('anchors a new comment against the live body, not the first frame', async () => {
    const doc = anchorDoc();
    const updateComment = vi.fn(async () => ({}));
    const addComment = vi.fn(async (input: Record<string, unknown>) => ({
      ...makeComment({ id: 'cm-live', body: '评论正文' }),
      ...input,
    }));
    const node = makeNode(doc);
    const client = createPageClient(doc);
    const page = mountDocumentPage(node, client, {
      addComment,
      updateComment,
    });
    await waitFor(() => expect(page.surface()).toBeTruthy());
    // Change the first paragraph through ProseMirror; the comment must anchor
    // to these live blocks (the retired path parsed the first-frame HTML).
    await page.replaceFirstBlockText('第一段改写后的内容');
    const quote = '第一段改写后的内容';
    await act(async () => {
      const { TextSelection } = await import('@tiptap/pm/state');
      const view = page.view();
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc as never, 1, 1 + quote.length),
        ),
      );
    });
    await waitFor(
      () =>
        expect(
          document.querySelector('[aria-label="添加评论"]'),
        ).not.toBeNull(),
      { timeout: 3000 },
    );
    await act(async () => {
      document.querySelector<HTMLElement>('[aria-label="添加评论"]')!.click();
    });
    const composer = await screen.findByLabelText('评论内容');
    fireEvent.change(composer, { target: { value: '评论正文' } });
    fireEvent.click(screen.getByRole('button', { name: '发送评论' }));
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    expect(addComment).toHaveBeenCalledWith({
      docId: 'doc-1',
      body: '评论正文',
      quote,
      anchor: { blockId: 'blk_p1', offset: 0, length: quote.length },
    });
    // Keep the page-level comment UI path covered: no duplicate notice here.
    expect(page.toast).not.toHaveBeenCalledWith('部分评论锚点已失效');
  });
});

