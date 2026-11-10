// @vitest-environment jsdom
/**
 * P2 comment rail (jsdom): anchor helpers over the AST, rail rendering
 * (empty/privacy state, open/resolved cards, invalid-anchor marking) and the
 * card/composer interactions (publish, resolve, supplement, edit, delete,
 * locate).
 */
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Comment, SpaceNode } from '@alter/protocol';
import { SpaceContext } from '../vendor/ui-space/src/runtime';
import { AlterDocumentView } from '../src/document/AlterDocumentView';
import {
  anchorText,
  blockText,
  CommentRail,
  findBlock,
  isCommentAnchorValid,
  sortCommentsByAnchor,
  type CommentRailProps,
} from '../src/document/comments';
import type { AlterDoc } from '../src/document/types';

afterEach(() => cleanup());

// jsdom has no layout engine; ProseMirror touches these on the editor surface.
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

const doc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 3,
  blocks: [
    {
      id: 'blk_h',
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: '标题' }],
    },
    {
      id: 'blk_p',
      type: 'paragraph',
      attrs: {},
      content: [
        { type: 'text', text: '第一段' },
        { type: 'hardBreak' },
        { type: 'text', text: '续写' },
      ],
    },
    {
      id: 'blk_list',
      type: 'bulletList',
      attrs: {},
      children: [
        {
          id: 'blk_li',
          type: 'listItem',
          attrs: {},
          children: [
            {
              id: 'blk_lip',
              type: 'paragraph',
              attrs: {},
              content: [{ type: 'text', text: '列表项' }],
            },
          ],
        },
      ],
    },
    {
      id: 'blk_code',
      type: 'codeBlock',
      attrs: { lang: 'ts' },
      content: [{ type: 'text', text: 'const a = 1;' }],
    },
  ],
};

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'cm_1',
    docId: 'doc-1',
    author: 'me',
    body: '评论正文',
    quote: '第一段',
    anchor: { blockId: 'blk_p', offset: 0, length: 3 },
    status: 'open',
    createdAt: '2026-11-10T00:00:00.000Z',
    resolvedAt: null,
    editedAt: null,
    supplements: [],
    ...overrides,
  };
}

type RailHandlers = Pick<
  CommentRailProps,
  | 'onActivate'
  | 'onAddPending'
  | 'onCancelPending'
  | 'onPendingDraftChange'
  | 'onApprove'
  | 'onEdit'
  | 'onSupplement'
  | 'onDelete'
  | 'onLocate'
>;

function renderRail(
  overrides: Partial<CommentRailProps> = {},
): RailHandlers {
  const handlers: RailHandlers = {
    onActivate: vi.fn(),
    onAddPending: vi.fn(async () => undefined),
    onCancelPending: vi.fn(),
    onPendingDraftChange: vi.fn(),
    onApprove: vi.fn(async () => undefined),
    onEdit: vi.fn(async () => undefined),
    onSupplement: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    onLocate: vi.fn(),
  };
  render(
    createElement(CommentRail, {
      comments: [],
      activeCommentId: null,
      invalidCommentIds: new Set<string>(),
      pendingQuote: null,
      ...handlers,
      ...overrides,
    }),
  );
  return handlers;
}

async function openCardMenu(name: '编辑' | '删除'): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '更多评论操作' }));
  const item = await screen.findByRole('menuitem', { name });
  fireEvent.click(item);
}

describe('comment anchor helpers', () => {
  it('reads flattened top-level block text', () => {
    const paragraph = findBlock(doc, 'blk_p');
    expect(paragraph).toBeDefined();
    // The editor's convention: hard breaks are "\n", nested children are
    // joined by "\n".
    expect(blockText(paragraph!)).toBe('第一段\n续写');
    expect(blockText(findBlock(doc, 'blk_list')!)).toBe('列表项');
    // Comment anchors only address top-level blocks.
    expect(findBlock(doc, 'blk_lip')).toBeUndefined();
    expect(findBlock(doc, 'blk_missing')).toBeUndefined();
  });

  it('validates anchors against the current document', () => {
    expect(
      isCommentAnchorValid(doc, { blockId: 'blk_p', offset: 0, length: 3 }),
    ).toBe(true);
    expect(
      isCommentAnchorValid(doc, { blockId: 'blk_p', offset: 3, length: 2 }),
    ).toBe(true);
    // Range exceeds the block's plain text.
    expect(
      isCommentAnchorValid(doc, { blockId: 'blk_p', offset: 5, length: 2 }),
    ).toBe(false);
    // Nested blocks are not anchorable (the editor anchors top-level blocks).
    expect(
      isCommentAnchorValid(doc, { blockId: 'blk_lip', offset: 0, length: 1 }),
    ).toBe(false);
    // Block no longer exists.
    expect(
      isCommentAnchorValid(doc, { blockId: 'blk_gone', offset: 0, length: 1 }),
    ).toBe(false);
    // Empty / malformed ranges.
    expect(
      isCommentAnchorValid(doc, { blockId: 'blk_p', offset: 0, length: 0 }),
    ).toBe(false);
    expect(
      isCommentAnchorValid(doc, { blockId: 'blk_p', offset: -1, length: 1 }),
    ).toBe(false);
    expect(
      isCommentAnchorValid(doc, { blockId: 'blk_p', offset: 0.5, length: 1 }),
    ).toBe(false);
  });

  it('slices the anchored text', () => {
    expect(
      anchorText(doc, { blockId: 'blk_p', offset: 4, length: 2 }),
    ).toBe('续写');
    expect(
      anchorText(doc, { blockId: 'blk_p', offset: 99, length: 1 }),
    ).toBeUndefined();
  });

  it('orders comments by document position, unanchored last', () => {
    const late = comment({
      id: 'cm_late',
      anchor: { blockId: 'blk_code', offset: 0, length: 2 },
      createdAt: '2026-11-10T00:00:03.000Z',
    });
    const early = comment({
      id: 'cm_early',
      anchor: { blockId: 'blk_p', offset: 0, length: 2 },
      createdAt: '2026-11-10T00:00:02.000Z',
    });
    const middle = comment({
      id: 'cm_middle',
      anchor: { blockId: 'blk_p', offset: 3, length: 2 },
      createdAt: '2026-11-10T00:00:01.000Z',
    });
    const whole = comment({
      id: 'cm_whole',
      anchor: null,
      createdAt: '2026-11-10T00:00:00.000Z',
    });
    expect(
      sortCommentsByAnchor([late, early, middle, whole], doc).map(
        (item) => item.id,
      ),
    ).toEqual(['cm_early', 'cm_middle', 'cm_late', 'cm_whole']);
  });
});

describe('comment rail', () => {
  it('shows the privacy empty state without comments or a selection', () => {
    renderRail();
    expect(screen.getByText(/还没有评论/)).toBeTruthy();
    expect(screen.getByText(/评论仅当前空间可见/)).toBeTruthy();
  });

  it('renders open comments with author, quote and body', () => {
    renderRail({ comments: [comment()] });
    expect(screen.getByText('我')).toBeTruthy();
    expect(screen.getByText('第一段')).toBeTruthy();
    expect(screen.getByText('评论正文')).toBeTruthy();
  });

  it('marks comments whose anchor is invalid', () => {
    renderRail({
      comments: [comment()],
      invalidCommentIds: new Set(['cm_1']),
    });
    expect(screen.getByText('锚点已失效')).toBeTruthy();
    const card = screen.getByText('评论正文').closest('article');
    expect(card?.hasAttribute('data-invalid')).toBe(true);
  });

  it('keeps resolved comments collapsed until expanded', () => {
    renderRail({
      comments: [
        comment(),
        comment({
          id: 'cm_resolved',
          body: '已解决的评论',
          status: 'resolved',
          resolvedAt: '2026-11-10T01:00:00.000Z',
        }),
      ],
    });
    expect(screen.queryByText('已解决的评论')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /已解决/ }));
    expect(screen.getByText('已解决的评论')).toBeTruthy();
  });

  it('publishes a selection comment through the composer', async () => {
    const handlers = renderRail({ pendingQuote: '选中的文字' });
    expect(screen.getByText('选中的文字')).toBeTruthy();
    const textarea = screen.getByRole('textbox', { name: '评论内容' });
    fireEvent.change(textarea, { target: { value: '  新评论  ' } });
    expect(handlers.onPendingDraftChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: '发送评论' }));
    await waitFor(() =>
      expect(handlers.onAddPending).toHaveBeenCalledWith('新评论'),
    );
  });

  it('cancels the pending selection comment', () => {
    const handlers = renderRail({ pendingQuote: '选中的文字' });
    fireEvent.click(screen.getByRole('button', { name: '取消引用' }));
    expect(handlers.onCancelPending).toHaveBeenCalledTimes(1);
  });

  it('resolves a comment from the card action', async () => {
    const handlers = renderRail({ comments: [comment()] });
    fireEvent.click(screen.getByRole('button', { name: '采纳评论' }));
    await waitFor(() =>
      expect(handlers.onApprove).toHaveBeenCalledWith('cm_1'),
    );
  });

  it('adds a supplement from the card action', async () => {
    const handlers = renderRail({ comments: [comment()] });
    fireEvent.click(screen.getByRole('button', { name: '补充评论' }));
    fireEvent.change(screen.getByRole('textbox', { name: '补充评论内容' }), {
      target: { value: '补充内容' },
    });
    fireEvent.click(screen.getByRole('button', { name: '补充' }));
    await waitFor(() =>
      expect(handlers.onSupplement).toHaveBeenCalledWith('cm_1', '补充内容'),
    );
  });

  it('edits a comment body from the card menu', async () => {
    const handlers = renderRail({ comments: [comment()] });
    await openCardMenu('编辑');
    const textarea = await screen.findByRole('textbox', {
      name: '编辑评论内容',
    });
    fireEvent.change(textarea, { target: { value: '改过的正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(handlers.onEdit).toHaveBeenCalledWith('cm_1', '改过的正文'),
    );
  });

  it('deletes a comment after confirmation', async () => {
    const handlers = renderRail({ comments: [comment()] });
    await openCardMenu('删除');
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    await waitFor(() =>
      expect(handlers.onDelete).toHaveBeenCalledWith('cm_1'),
    );
  });

  it('locates a valid comment but not an invalid one', () => {
    const handlers = renderRail({ comments: [comment()] });
    fireEvent.click(screen.getByText('评论正文'));
    expect(handlers.onLocate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cm_1' }),
    );
    cleanup();

    const invalidHandlers = renderRail({
      comments: [comment()],
      invalidCommentIds: new Set(['cm_1']),
    });
    fireEvent.click(screen.getByText('评论正文'));
    expect(invalidHandlers.onLocate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Document view wiring
// ---------------------------------------------------------------------------

function spaceNode(): SpaceNode {
  return {
    id: 'doc-1',
    spaceId: 'sp-1',
    kind: 'note',
    title: '评论文档',
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
  };
}

function renderDocumentView(comments: Comment[]) {
  const resolveComment = vi.fn(async () => comment({ status: 'resolved' }));
  const service = {
    document: {
      async get() {
        return { docId: 'doc-1', revision: 3, title: '评论文档', doc };
      },
      async applyOperations() {
        return { docId: 'doc-1', revision: 4, changedBlockIds: [], diff: {}, warnings: [] };
      },
      async undo() {
        return { docId: 'doc-1', revision: 4, changedBlockIds: [], diff: {}, warnings: [] };
      },
      async restoreVersion() {
        return { docId: 'doc-1', revision: 4 };
      },
      async read() {
        return { markdown: '', revision: 3 };
      },
    },
    listComments: vi.fn(async () => comments),
    resolveComment,
    addComment: vi.fn(async () => comment()),
    updateComment: vi.fn(async () => comment()),
    addCommentSupplement: vi.fn(async () => comment()),
    deleteComment: vi.fn(async () => undefined),
    recordOpen: vi.fn(async () => undefined),
    saveNode: vi.fn(async () => undefined),
    setArchived: vi.fn(async () => undefined),
  };
  const value = {
    service,
    router: {
      getPath: () => '#/space/sp-1/doc/doc-1',
      subscribe: () => () => undefined,
      navigate: vi.fn(),
    },
    spaces: [],
    agents: [],
    space: { id: 'sp-1', name: '空间' },
    spaceId: 'sp-1',
    nodes: [spaceNode()],
    thoughts: [],
    version: 0,
    refresh: vi.fn(),
    toast: vi.fn(),
    openSearch: vi.fn(),
    openThoughtComposer: vi.fn(),
    openDirectory: vi.fn(),
    closeDirectory: vi.fn(),
    removeSpaceFromState: vi.fn(),
    addSpaceToState: vi.fn(),
    addNodeToState: vi.fn(),
    updateNodeInState: vi.fn(),
  };
  render(
    createElement(
      SpaceContext.Provider,
      { value: value as never },
      createElement(AlterDocumentView, { node: spaceNode() as never }),
    ),
  );
  return service;
}

describe('document view comment wiring', () => {
  it('loads comments into the rail and marks stale anchors', async () => {
    const stale = comment({
      id: 'cm_stale',
      body: '失效的评论',
      anchor: { blockId: 'blk_p', offset: 50, length: 3 },
    });
    renderDocumentView([comment(), stale]);
    fireEvent.click(await screen.findByRole('button', { name: '评论' }));
    await waitFor(() => {
      expect(screen.getByText('评论正文')).toBeTruthy();
      expect(screen.getByText('失效的评论')).toBeTruthy();
    });
    const staleCard = screen.getByText('失效的评论').closest('article');
    expect(staleCard?.hasAttribute('data-invalid')).toBe(true);
    expect(staleCard?.textContent).toContain('锚点已失效');
  });

  it('resolves a comment through the service and refreshes the rail', async () => {
    const service = renderDocumentView([comment()]);
    fireEvent.click(await screen.findByRole('button', { name: '评论' }));
    await screen.findByText('评论正文');
    fireEvent.click(screen.getByRole('button', { name: '采纳评论' }));
    await waitFor(() =>
      expect(service.resolveComment).toHaveBeenCalledWith('cm_1'),
    );
    expect(service.listComments).toHaveBeenCalledTimes(2);
  });
});
