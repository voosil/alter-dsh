// @vitest-environment jsdom
/**
 * P2-4 document footer (「子文档 / 全文评论」tabs) and 「历史评论」dialog.
 *
 * Component-level tests for the footer/dialog plus view integration: footer
 * visibility (children or full-document comments), child navigation, full
 * comments filtering (`anchor === null`), unresolved count and the document-menu
 * entry for resolved comments.
 */
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Comment, SpaceNode } from '@alter/protocol';
import { SpaceContext } from '../vendor/ui-space/src/runtime';
import { AlterDocumentView } from '../src/document/AlterDocumentView';
import {
  DocumentFooter,
  HistoryCommentsDialog,
  resolvedCommentsOf,
} from '../src/document/footer';
import type { AlterDoc } from '../src/document/types';

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const doc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 3,
  blocks: [
    {
      id: 'blk_p',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '正文内容' }],
    },
  ],
};

function spaceNode(overrides: Partial<SpaceNode> = {}): SpaceNode {
  return {
    id: 'doc-1',
    spaceId: 'sp-1',
    kind: 'note',
    title: '当前文档',
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
  };
}

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'cm_1',
    docId: 'doc-1',
    author: 'me',
    body: '评论正文',
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

function renderFooter(
  overrides: {
    children?: SpaceNode[];
    comments?: Comment[];
    onOpenDocument?: (docId: string) => void;
  } = {},
) {
  const onOpenDocument = vi.fn(overrides.onOpenDocument ?? (() => undefined));
  render(
    createElement(DocumentFooter, {
      children: overrides.children ?? [],
      comments: overrides.comments ?? [],
      onOpenDocument,
    }),
  );
  return { onOpenDocument };
}

function renderDialog(
  comments: Comment[],
  options: { open?: boolean; onClose?: () => void } = {},
) {
  const onClose = vi.fn(options.onClose ?? (() => undefined));
  render(
    createElement(HistoryCommentsDialog, {
      open: options.open ?? true,
      comments,
      onClose,
    }),
  );
  return { onClose };
}

interface ViewHarnessOptions {
  nodes?: SpaceNode[];
  comments?: Comment[];
  navigate?: (path: string) => void;
}

function renderDocumentView(options: ViewHarnessOptions = {}) {
  const navigate = vi.fn(options.navigate ?? (() => undefined));
  const comments = options.comments ?? [];
  const service = {
    document: {
      async get() {
        return { docId: 'doc-1', revision: 3, title: '当前文档', doc };
      },
      async applyOperations() {
        return {
          docId: 'doc-1',
          revision: 4,
          changedBlockIds: [],
          diff: {},
          warnings: [],
        };
      },
      async undo() {
        return {
          docId: 'doc-1',
          revision: 4,
          changedBlockIds: [],
          diff: {},
          warnings: [],
        };
      },
      async restoreVersion() {
        return { docId: 'doc-1', revision: 4 };
      },
      async read() {
        return { markdown: '', revision: 3 };
      },
    },
    listComments: vi.fn(async () => comments),
    resolveComment: vi.fn(async () => comment({ status: 'resolved' })),
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
      navigate,
    },
    spaces: [],
    agents: [],
    space: { id: 'sp-1', name: '空间' },
    spaceId: 'sp-1',
    nodes: options.nodes ?? [spaceNode()],
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
  return { navigate, service };
}

async function footerRegion(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: '文档附加内容' });
}

async function openHistoryCommentsMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: '文档菜单' }));
  return screen.findByRole('menuitem', { name: '历史评论' });
}

// ---------------------------------------------------------------------------
// Footer component
// ---------------------------------------------------------------------------

describe('document footer', () => {
  it('lists child documents and navigates on click', () => {
    const { onOpenDocument } = renderFooter({
      children: [
        spaceNode({ id: 'doc-child-b', title: '子文档 B', parentId: 'doc-1' }),
        spaceNode({
          id: 'doc-child-a',
          title: '',
          parentId: 'doc-1',
          archived: true,
          archivedBy: 'user',
          archivedAt: '2026-11-10T00:00:00.000Z',
        }),
      ],
    });

    expect(screen.getByText('子文档 B')).toBeTruthy();
    // Untitled child keeps the shared placeholder.
    expect(screen.getByText('无标题')).toBeTruthy();
    expect(screen.getByText('已归档')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /子文档 B/ }));
    expect(onOpenDocument).toHaveBeenCalledWith('doc-child-b');
    fireEvent.click(screen.getByRole('button', { name: /无标题/ }));
    expect(onOpenDocument).toHaveBeenCalledWith('doc-child-a');
  });

  it('shows empty states for children and full comments', () => {
    renderFooter();
    expect(screen.getByText('暂无子文档')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /全文评论/ }));
    expect(screen.getByText('暂无全文评论')).toBeTruthy();
  });

  it('shows the unresolved count and lists full comments', () => {
    renderFooter({
      comments: [
        comment({ id: 'cm_open_1', body: '未解决一' }),
        comment({ id: 'cm_open_2', body: '未解决二' }),
        comment({
          id: 'cm_resolved',
          body: '已解决的全文评论',
          status: 'resolved',
          resolvedAt: '2026-11-10T02:00:00.000Z',
        }),
      ],
    });

    const commentsTab = screen.getByRole('tab', { name: /全文评论/ });
    expect(commentsTab.textContent).toContain('2');
    fireEvent.click(commentsTab);
    expect(screen.getByText('未解决一')).toBeTruthy();
    expect(screen.getByText('未解决二')).toBeTruthy();
    expect(screen.getByText('已解决的全文评论')).toBeTruthy();
    expect(screen.getByText('已解决')).toBeTruthy();
    expect(screen.getAllByText('我').length).toBeGreaterThan(0);
  });

  it('switches tabs with the arrow keys', () => {
    renderFooter({
      children: [spaceNode({ id: 'doc-child', title: '子文档', parentId: 'doc-1' })],
    });
    const childrenTab = screen.getByRole('tab', { name: '子文档' });
    fireEvent.click(childrenTab);
    fireEvent.keyDown(childrenTab, { key: 'ArrowRight' });
    expect(
      screen.getByRole('tab', { name: /全文评论/ }).getAttribute('aria-selected'),
    ).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// History comments dialog
// ---------------------------------------------------------------------------

describe('history comments dialog', () => {
  it('lists resolved comments newest first with quote and supplements', () => {
    renderDialog([
      comment({
        id: 'cm_open',
        body: '未解决评论',
        status: 'open',
      }),
      comment({
        id: 'cm_old',
        body: '较早采纳的评论',
        status: 'resolved',
        quote: '旧引用',
        resolvedAt: '2026-11-10T01:00:00.000Z',
      }),
      comment({
        id: 'cm_new',
        body: '最新采纳的评论',
        status: 'resolved',
        quote: '新引用',
        resolvedAt: '2026-11-10T03:00:00.000Z',
        supplements: [
          {
            id: 'sup_1',
            author: 'alter',
            body: '补充说明',
            createdAt: '2026-11-10T02:30:00.000Z',
          },
        ],
      }),
    ]);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('历史评论')).toBeTruthy();
    expect(within(dialog).queryByText('未解决评论')).toBeNull();
    expect(within(dialog).getByText('旧引用')).toBeTruthy();
    expect(within(dialog).getByText('新引用')).toBeTruthy();
    expect(within(dialog).getByText('补充说明')).toBeTruthy();
    const articles = within(dialog).getAllByRole('article');
    expect(articles).toHaveLength(2);
    expect(articles[0]!.textContent).toContain('最新采纳的评论');
    expect(articles[1]!.textContent).toContain('较早采纳的评论');
  });

  it('shows an empty state without resolved comments', () => {
    renderDialog([comment({ status: 'open' })]);
    expect(screen.getByText('还没有历史评论。')).toBeTruthy();
  });

  it('closes through the dialog close button', () => {
    const { onClose } = renderDialog([
      comment({ status: 'resolved', resolvedAt: '2026-11-10T01:00:00.000Z' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('filters and sorts resolved comments in the helper', () => {
    const list = resolvedCommentsOf([
      comment({ id: 'a', status: 'open' }),
      comment({
        id: 'b',
        status: 'resolved',
        resolvedAt: '2026-11-10T01:00:00.000Z',
      }),
      comment({
        id: 'c',
        status: 'resolved',
        resolvedAt: '2026-11-10T03:00:00.000Z',
      }),
    ]);
    expect(list.map((item) => item.id)).toEqual(['c', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Document view integration
// ---------------------------------------------------------------------------

describe('document view footer wiring', () => {
  it('hides the footer without children or full comments', async () => {
    renderDocumentView({
      comments: [
        comment({
          id: 'cm_anchored',
          anchor: { blockId: 'blk_p', offset: 0, length: 2 },
          quote: '正文',
        }),
      ],
    });
    await waitFor(() =>
      expect(screen.getByLabelText('结构化文档正文')).toBeTruthy(),
    );
    expect(
      screen.queryByRole('region', { name: '文档附加内容' }),
    ).toBeNull();
  });

  it('shows child notes sorted by order and navigates on click', async () => {
    const { navigate } = renderDocumentView({
      nodes: [
        spaceNode(),
        spaceNode({
          id: 'doc-child-b',
          title: '子文档 B',
          parentId: 'doc-1',
          order: 2,
        }),
        spaceNode({
          id: 'doc-child-a',
          title: '子文档 A',
          parentId: 'doc-1',
          order: 1,
        }),
        spaceNode({
          id: 'doc-folder',
          kind: 'folder',
          title: '文件夹',
          parentId: 'doc-1',
          order: 0,
        }),
        spaceNode({
          id: 'doc-deleted',
          title: '已删除子文档',
          parentId: 'doc-1',
          order: 3,
          deletedAt: '2026-11-10T00:00:00.000Z',
        }),
        spaceNode({
          id: 'doc-other',
          title: '别的子文档',
          parentId: 'doc-2',
          order: 0,
        }),
      ],
    });

    const footer = await footerRegion();
    const rows = within(footer).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      '子文档 A',
      '子文档 B',
    ]);
    fireEvent.click(within(footer).getByRole('button', { name: '子文档 A' }));
    expect(navigate).toHaveBeenCalledWith('#/space/sp-1/doc/doc-child-a');
  });

  it('lists only anchor-less comments in the full comments tab', async () => {
    renderDocumentView({
      comments: [
        comment({
          id: 'cm_anchored',
          body: '划词评论',
          quote: '正文',
          anchor: { blockId: 'blk_p', offset: 0, length: 2 },
        }),
        comment({ id: 'cm_full_1', body: '全文评论一' }),
        comment({ id: 'cm_full_2', body: '全文评论二' }),
        comment({
          id: 'cm_full_resolved',
          body: '已解决的全文评论',
          status: 'resolved',
          resolvedAt: '2026-11-10T02:00:00.000Z',
        }),
      ],
    });

    const footer = await footerRegion();
    const commentsTab = within(footer).getByRole('tab', { name: /全文评论/ });
    expect(commentsTab.textContent).toContain('2');
    fireEvent.click(commentsTab);

    expect(within(footer).getByText('全文评论一')).toBeTruthy();
    expect(within(footer).getByText('全文评论二')).toBeTruthy();
    expect(within(footer).getByText('已解决的全文评论')).toBeTruthy();
    expect(within(footer).queryByText('划词评论')).toBeNull();
  });

  it('opens the history comments dialog from the document menu', async () => {
    renderDocumentView({
      comments: [
        comment({ id: 'cm_open', body: '未解决评论' }),
        comment({
          id: 'cm_resolved',
          body: '已采纳的历史评论',
          status: 'resolved',
          quote: '历史引用',
          resolvedAt: '2026-11-10T02:00:00.000Z',
        }),
      ],
    });
    await waitFor(() => expect(screen.getByText('正文内容')).toBeTruthy());

    const item = await openHistoryCommentsMenu();
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(item);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('已采纳的历史评论')).toBeTruthy();
    expect(within(dialog).getByText('历史引用')).toBeTruthy();
    expect(within(dialog).queryByText('未解决评论')).toBeNull();
  });

  it('disables the history comments menu entry without resolved comments', async () => {
    renderDocumentView({
      comments: [comment({ id: 'cm_open', body: '未解决评论' })],
    });
    await waitFor(() => expect(screen.getByText('正文内容')).toBeTruthy());
    const item = await openHistoryCommentsMenu();
    expect(item.getAttribute('aria-disabled')).toBe('true');
  });
});
