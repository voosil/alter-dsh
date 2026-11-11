// @vitest-environment jsdom
/**
 * E4 comment-anchor validity: drift detection, unique-quote auto repair and
 * the explicit 「部分评论锚点已失效」 notice, plus the DocumentView wiring
 * (repair after comments load and after a successful save).
 */
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment, SpaceNode } from '@alter/protocol';
import { SpaceContext } from '../../../../vendor/ui-space/src/runtime';
import { DocumentView } from '../../../../vendor/ui-space/src/views/DocumentView';
import {
  detectAnchorDrift,
  planCommentAnchorRepairs,
  planReanchor,
  quoteMatchesAnchorText,
  validateCommentAnchor,
  type LegacyAnchorComment,
} from '../../../../src/document/editors/legacy';
import type { AlterDoc, BlockNode } from '../../../../src/document/types';

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

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const originalResizeObserver = (
  globalThis as { ResizeObserver?: unknown }
).ResizeObserver;

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    originalResizeObserver;
});

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

/** Three simple paragraphs with unique first/second quotes. */
function anchorDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 4,
    blocks: [
      block('blk_p1', 'paragraph', {}, {
        content: [{ type: 'text', text: '第一段正文内容' }],
      }),
      block('blk_p2', 'paragraph', {}, {
        content: [{ type: 'text', text: '第二段正文内容' }],
      }),
      block('blk_p3', 'paragraph', {}, {
        content: [{ type: 'text', text: '无关内容' }],
      }),
    ],
  };
}

function comment(
  overrides: Partial<LegacyAnchorComment> = {},
): LegacyAnchorComment {
  return {
    id: 'cm-1',
    quote: '第一段正文内容',
    anchor: { blockId: 'blk_p1', offset: 0, length: '第一段正文内容'.length },
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
        block('blk_long', 'paragraph', {}, {
          content: [
            { type: 'text', text: '这是一段足够长的正文内容用于截断容差测试' },
          ],
        }),
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
        block('blk_a', 'paragraph', {}, {
          content: [{ type: 'text', text: '重复内容' }],
        }),
        block('blk_b', 'paragraph', {}, {
          content: [{ type: 'text', text: '重复内容' }],
        }),
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
        anchor: { blockId: 'blk_p2', offset: 0, length: '第二段正文内容'.length },
      },
      {
        commentId: 'cm-new',
        anchor: { blockId: 'blk_p1', offset: 0, length: '第一段正文内容'.length },
      },
    ]);
    expect(plan.unresolvedIds).toEqual(['cm-lost']);
  });
});

// ---------------------------------------------------------------------------
// DocumentView wiring
// ---------------------------------------------------------------------------

function makeNode(doc: AlterDoc, overrides: Record<string, unknown> = {}): SpaceNode {
  return {
    id: 'doc-1',
    spaceId: 'sp-1',
    kind: 'note',
    title: '测试文档',
    parentId: null,
    creator: 'me',
    pinned: false,
    archived: false,
    archivedBy: null,
    archivedAt: null,
    deletedAt: null,
    deletedRoot: false,
    originalParentId: null,
    unread: false,
    content: JSON.stringify(doc),
    activity: 100,
    activityAt: '2026-11-10T00:00:00.000Z',
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    order: 0,
    ...overrides,
  } as SpaceNode;
}

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

interface HarnessOptions {
  comments?: Comment[];
  get?: (docId: string) => Promise<unknown>;
  applyOperations?: (input: unknown) => Promise<unknown>;
}

function renderView(doc: AlterDoc, options: HarnessOptions = {}) {
  const node = makeNode(doc);
  const comments = options.comments ?? [];
  const listComments = vi.fn(async () => comments);
  const updateComment = vi.fn(async (id: string, patch: unknown) => ({
    ...comments.find((item) => item.id === id),
    ...(patch as object),
  }));
  const applyOperations = vi.fn(
    options.applyOperations ??
      (async () => ({ docId: 'doc-1', revision: doc.revision + 1 })),
  );
  const client = {
    get: vi.fn(
      options.get ??
        (async () => ({
          docId: 'doc-1',
          revision: doc.revision,
          title: '测试文档',
          doc,
        })),
    ),
    applyOperations,
    restoreVersion: vi.fn(async () => ({ revision: doc.revision + 1 })),
    importAsset: vi.fn(),
    importFile: vi.fn(),
  };
  const service = {
    listComments,
    updateComment,
    recordOpen: vi.fn(async () => node),
    saveNode: vi.fn(async () => node),
    getNode: vi.fn(async () => node),
    addComment: vi.fn(async () => makeComment({})),
    resolveComment: vi.fn(async () => makeComment({})),
    deleteComment: vi.fn(async () => undefined),
    addCommentSupplement: vi.fn(async () => makeComment({})),
    listVersions: vi.fn(async () => []),
    createNode: vi.fn(async () => node),
    setArchived: vi.fn(async () => node),
    document: client,
  };
  const toast = vi.fn();
  const value = {
    service,
    router: { navigate: vi.fn() },
    spaces: [],
    agents: [],
    space: { id: 'sp-1', name: '空间' },
    spaceId: 'sp-1',
    nodes: [node],
    thoughts: [],
    version: 0,
    refresh: vi.fn(),
    toast,
    addNodeToState: vi.fn(),
    updateNodeInState: vi.fn(),
    openSearch: vi.fn(),
    openThoughtComposer: vi.fn(),
    openDirectory: vi.fn(),
    closeDirectory: vi.fn(),
    removeSpaceFromState: vi.fn(),
    addSpaceToState: vi.fn(),
    openWeb: vi.fn(),
    workbench: undefined,
  };
  render(
    createElement(
      SpaceContext.Provider,
      { value: value as never },
      createElement(DocumentView, { node } as never),
    ),
  );
  return { service, toast, client };
}

function editorSurface(): HTMLElement {
  const surface = document.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="文档正文"]',
  );
  if (surface === null) throw new Error('editor surface is missing');
  return surface;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
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
    const { service, toast } = renderView(doc, { comments });
    await waitFor(() =>
      expect(service.updateComment).toHaveBeenCalledTimes(1),
    );
    expect(service.updateComment).toHaveBeenCalledWith('cm-repair', {
      anchor: { blockId: 'blk_p2', offset: 0, length: 7 },
    });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('部分评论锚点已失效'),
    );
    // Exactly one notice for any number of unresolved anchors.
    const notices = toast.mock.calls.filter(
      (call) => call[0] === '部分评论锚点已失效',
    );
    expect(notices).toHaveLength(1);
    expect(service.updateComment).not.toHaveBeenCalledWith(
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
    const { service, toast } = renderView(doc, { comments });
    await waitFor(() => expect(editorSurface()).toBeTruthy());
    await settle();
    expect(service.updateComment).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith('部分评论锚点已失效');
  });

  it('repairs an ambiguous anchor after a save makes the quote unique again', async () => {
    vi.useFakeTimers();
    const doc: AlterDoc = {
      ...anchorDoc(),
      blocks: [
        block('blk_a', 'paragraph', {}, {
          content: [{ type: 'text', text: '重复内容一' }],
        }),
        block('blk_b', 'paragraph', {}, {
          content: [{ type: 'text', text: '重复内容二' }],
        }),
      ],
    };
    const comments: Comment[] = [
      makeComment({
        id: 'cm-dup',
        quote: '重复内容',
        anchor: { blockId: 'blk_missing', offset: 0, length: 4 },
      }),
    ];
    const { service, toast } = renderView(doc, { comments });
    await settle();
    await settle();
    // Ambiguous while both blocks repeat the quote: no write, one notice.
    expect(service.updateComment).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('部分评论锚点已失效');

    // Remove one duplicate by editing the first paragraph, then save.
    const surface = editorSurface();
    const first = [...surface.querySelectorAll('p')].find(
      (item) => item.textContent === '重复内容一',
    );
    expect(first).toBeTruthy();
    first!.textContent = '已改写';
    fireEvent.input(surface);
    await tick(700);
    await settle();
    await settle();
    await settle();
    await tick(0);
    await settle();

    // The editor also refreshes the stored quote while editing; the anchor
    // repair is the call that carries an `anchor` patch.
    const anchorRepairs = service.updateComment.mock.calls.filter(
      (call) => (call[1] as { anchor?: unknown }).anchor !== undefined,
    );
    expect(anchorRepairs).toHaveLength(1);
    expect(anchorRepairs[0]).toEqual([
      'cm-dup',
      { anchor: { blockId: 'blk_a', offset: 0, length: 3 } },
    ]);
  });
});
