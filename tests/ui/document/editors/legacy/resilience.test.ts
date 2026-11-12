// @vitest-environment jsdom
/**
 * E1/E2 resilience: the document page never white-screens, corrupted content
 * becomes an explicit error state, render crashes are caught by the boundary,
 * and every failure leaves a structured (content-free) diagnostic trace.
 */
import { createElement, type ReactNode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeEditorKernelPreference } from '../../../../../src/document/editors/kernel-preference';
import type { SpaceNode } from '@alter/protocol';
import { SpaceContext } from '../../../../../vendor/ui-space/src/runtime';
import { DocumentView } from '../../../../../vendor/ui-space/src/views/DocumentView';
import { DocumentErrorBoundary } from '../../../../../vendor/ui-space/src/components/DocumentErrorBoundary';
import { overviewPath } from '../../../../../vendor/ui-space/src/space-route';
import {
  LEGACY_ERROR_LOG_PREFIX,
  reportLegacyDocumentError,
} from '../../../../../src/document/editors/legacy';
import { SpaceRemoteError } from '../../../../../src/client/rpc';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

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
  // This file exercises the legacy kernel explicitly (see the frozen-parity design).
  writeEditorKernelPreference({ current: 'legacy' });
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

function sampleDoc(revision = 7): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision,
    blocks: [
      block('blk_h1', 'heading', { level: 1 }, {
        content: [{ type: 'text', text: '鉴权方案' }],
      }),
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '编辑器正文' }],
      }),
    ],
  };
}

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

interface ClientOptions {
  get?: (docId: string) => Promise<unknown>;
  applyOperations?: (input: unknown) => Promise<unknown>;
}

function makeClient(doc: AlterDoc, options: ClientOptions = {}) {
  const get = vi.fn(
    options.get ??
      (async () => ({
        docId: 'doc-1',
        revision: doc.revision,
        title: '测试文档',
        doc,
      })),
  );
  const applyOperations = vi.fn(
    options.applyOperations ??
      (async () => ({ docId: 'doc-1', revision: doc.revision + 1 })),
  );
  return {
    get,
    applyOperations,
    restoreVersion: vi.fn(async () => ({ revision: doc.revision + 1 })),
    importAsset: vi.fn(),
    importFile: vi.fn(),
  };
}

function makeContext(
  node: SpaceNode,
  client: ReturnType<typeof makeClient>,
  overrides: { listComments?: () => Promise<unknown[]> } = {},
) {
  const service = {
    listComments: vi.fn(
      overrides.listComments ??
        (async () => []),
    ),
    recordOpen: vi.fn(async () => node),
    saveNode: vi.fn(async () => node),
    getNode: vi.fn(async () => node),
    addComment: vi.fn(async () => ({})),
    updateComment: vi.fn(async () => ({})),
    resolveComment: vi.fn(async () => ({})),
    deleteComment: vi.fn(async () => undefined),
    addCommentSupplement: vi.fn(async () => ({})),
    listVersions: vi.fn(async () => []),
    createNode: vi.fn(async () => node),
    setArchived: vi.fn(async () => node),
    document: client,
  };
  const refresh = vi.fn();
  const toast = vi.fn();
  const router = { navigate: vi.fn() };
  const value = {
    service,
    router,
    spaces: [],
    agents: [],
    space: { id: 'sp-1', name: '空间' },
    spaceId: 'sp-1',
    nodes: [node],
    thoughts: [],
    version: 0,
    refresh,
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
  return { value, service, refresh, toast, router };
}

function renderView(
  node: SpaceNode,
  client: ReturnType<typeof makeClient>,
  overrides: { listComments?: () => Promise<unknown[]> } = {},
) {
  const context = makeContext(node, client, overrides);
  const view = render(
    createElement(
      SpaceContext.Provider,
      { value: context.value as never },
      createElement(DocumentView, { node } as never),
    ),
  );
  return { ...context, ...view };
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

function reportsFrom(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return (spy.mock.calls as unknown[][])
    .filter((call) => call[0] === LEGACY_ERROR_LOG_PREFIX)
    .map((call) => call[1] as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// E2: structured diagnostics
// ---------------------------------------------------------------------------

describe('legacy document error reporting (E2)', () => {
  it('reports structured identifiers and never logs document content', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('保存失败'), {
      code: 'doc/conflict',
    });
    const report = reportLegacyDocumentError('save', error, {
      docId: 'doc-1',
      revision: 4,
      content: '机密正文不应出现在日志里',
    });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0]![0]).toBe(LEGACY_ERROR_LOG_PREFIX);
    expect(report).toMatchObject({
      scope: 'save',
      code: 'doc/conflict',
      message: '保存失败',
      docId: 'doc-1',
      revision: 4,
    });
    expect(JSON.stringify(report)).not.toContain('机密正文');
    expect(report).not.toHaveProperty('content');
  });
});

// ---------------------------------------------------------------------------
// E1: error boundary
// ---------------------------------------------------------------------------

describe('document error boundary (E1)', () => {
  it('catches a render crash, reports it and recovers through 重试', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const goOverview = vi.fn();
    let crashed = true;
    function Child(): ReactNode {
      if (crashed) throw new Error('评论轨渲染失败');
      return createElement('p', null, '已恢复的正文');
    }
    render(
      createElement(
        DocumentErrorBoundary,
        {
          docId: 'doc-1',
          title: '文档界面出现异常',
          message: '可重试或返回空间目录',
          onGoOverview: goOverview,
          classNames: {
            scroller: 'scroller',
            paper: 'paper',
            header: 'header',
            title: 'title',
            body: 'body',
            actions: 'actions',
          },
        },
        createElement(Child),
      ),
    );
    expect(screen.getByText('文档界面出现异常')).toBeTruthy();
    expect(screen.getByText('可重试或返回空间目录')).toBeTruthy();
    const reports = reportsFrom(consoleSpy);
    expect(
      reports.some(
        (report) => report['scope'] === 'render' && report['docId'] === 'doc-1',
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '返回空间目录' }));
    expect(goOverview).toHaveBeenCalledTimes(1);

    crashed = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByText('已恢复的正文')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// E1: corrupted content is an explicit error page (not a blank document)
// ---------------------------------------------------------------------------

describe('document load failures (E1)', () => {
  it('shows an explicit error state for corrupted content and can navigate back', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const node = makeNode(sampleDoc(), { content: '{not-json' });
    const { router } = renderView(node, makeClient(sampleDoc()));
    await waitFor(() => expect(screen.getByText('无法显示文档')).toBeTruthy());
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    const reports = reportsFrom(consoleSpy);
    expect(
      reports.some(
        (report) => report['scope'] === 'load' && report['docId'] === 'doc-1',
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '返回空间目录' }));
    expect(router.navigate).toHaveBeenCalledWith(overviewPath('sp-1'));
  });

  it('recovers from a corrupt stored snapshot through a Host reload', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = sampleDoc();
    const node = makeNode(doc, { content: '{broken' });
    const client = makeClient(doc);
    renderView(node, client);
    await waitFor(() => expect(screen.getByText('无法显示文档')).toBeTruthy());
    expect(client.get).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(editorSurface()).toBeTruthy();
    expect(reportsFrom(consoleSpy).some((report) => report['scope'] === 'load')).toBe(
      true,
    );
  });

  it('keeps the page usable when comments fail to load (no crash)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = sampleDoc();
    const { toast } = renderView(makeNode(doc), makeClient(doc), {
      listComments: async () => {
        throw new Error('评论接口 500');
      },
    });
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    await waitFor(() =>
      expect(
        reportsFrom(consoleSpy).some((report) => report['scope'] === 'comments'),
      ).toBe(true),
    );
    expect(toast).toHaveBeenCalledWith('评论加载失败，请稍后重试');
    // The editor is still there and editable.
    expect(editorSurface().getAttribute('contenteditable')).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// E2: save failures keep the legacy retry and add an export-draft escape
// ---------------------------------------------------------------------------

describe('document save failure actions (E2)', () => {
  it('shows 导出草稿 next to 保存失败，重试 and downloads the draft', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = sampleDoc();
    const client = makeClient(doc, {
      applyOperations: async () => {
        throw new Error('网络不可用');
      },
    });
    const { toast } = renderView(makeNode(doc), client);
    await settle();
    const surface = editorSurface();
    const paragraph = [...surface.querySelectorAll('p')].find(
      (item) => item.textContent === '编辑器正文',
    );
    expect(paragraph).toBeTruthy();
    paragraph!.textContent = '失败但仍保留的正文';
    fireEvent.input(surface);
    await tick(700);
    await settle();

    expect(screen.getByRole('button', { name: '保存失败，重试' })).toBeTruthy();
    const exportButton = screen.getByRole('button', { name: '导出草稿' });
    expect(exportButton).toBeTruthy();
    expect(
      reportsFrom(consoleSpy).some((report) => report['scope'] === 'save'),
    ).toBe(true);

    const originalCreate = (
      URL as unknown as { createObjectURL?: unknown }
    ).createObjectURL;
    const originalRevoke = (
      URL as unknown as { revokeObjectURL?: unknown }
    ).revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:mock-draft');
    const revokeObjectURL = vi.fn();
    (URL as unknown as Record<string, unknown>).createObjectURL =
      createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL =
      revokeObjectURL;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      fireEvent.click(exportButton);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      click.mockRestore();
      (URL as unknown as Record<string, unknown>).createObjectURL =
        originalCreate;
      (URL as unknown as Record<string, unknown>).revokeObjectURL =
        originalRevoke;
    }
    // The failed edit is still in the editor; no toast was needed.
    expect(editorSurface().textContent).toContain('失败但仍保留的正文');
    expect(toast).not.toHaveBeenCalledWith('部分评论锚点已失效');
  });

  it('keeps the conflict dialog as the only export path for conflicts', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = sampleDoc();
    const serverDoc = sampleDoc(9);
    const client = makeClient(doc, {
      applyOperations: async () => {
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      },
      get: async () => ({
        docId: 'doc-1',
        revision: 9,
        title: '测试文档',
        doc: serverDoc,
      }),
    });
    renderView(makeNode(doc), client);
    await settle();
    const surface = editorSurface();
    const paragraph = [...surface.querySelectorAll('p')].find(
      (item) => item.textContent === '编辑器正文',
    );
    paragraph!.textContent = '冲突时保留的正文';
    fireEvent.input(surface);
    await tick(700);
    await settle();
    await settle();

    expect(screen.getByText('文档已被其他修改')).toBeTruthy();
    // Conflict keeps its own dialog actions; the header must not grow a second
    // export button (appearance freeze: no extra normal-state controls).
    // The modal hides the background from the a11y tree, so query text here.
    expect(screen.getAllByText('导出草稿')).toHaveLength(1);
    expect(screen.getByText('保存失败，重试')).toBeTruthy();
  });
});

