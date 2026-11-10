// @vitest-environment jsdom
/**
 * Restored pre-rebuild document UI on top of the AST backend.
 *
 * The legacy `DocumentView` keeps its original DOM/CSS; these tests verify the
 * adapter data layer: loading AST content into the contentEditable editor,
 * autosaving through Document Operations, failure UI, title persistence,
 * external revision reload and version restore.
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
import type { SpaceNode } from '@alter/protocol';
import { SpaceContext } from '../vendor/ui-space/src/runtime';
import { DocumentView } from '../vendor/ui-space/src/views/DocumentView';
import { HistoryPanel } from '../vendor/ui-space/src/components/HistoryPanel';
import type { AlterDoc, BlockNode } from '../src/document/types';

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
      block('blk_ul', 'bulletList', {}, {
        children: [
          block('blk_li', 'listItem', {}, {
            children: [
              block('blk_lip', 'paragraph', {}, {
                content: [{ type: 'text', text: '列表项' }],
              }),
            ],
          }),
        ],
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
  restoreVersion?: (input: unknown) => Promise<unknown>;
  importAsset?: (input: unknown) => Promise<unknown>;
  importFile?: (input: unknown) => Promise<unknown>;
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
  const restoreVersion = vi.fn(
    options.restoreVersion ?? (async () => ({ revision: doc.revision + 1 })),
  );
  return {
    get,
    applyOperations,
    restoreVersion,
    importAsset: options.importAsset ?? vi.fn(),
    importFile: options.importFile ?? vi.fn(),
  };
}

function makeContext(
  node: SpaceNode,
  client: ReturnType<typeof makeClient>,
  versions: unknown[] = [],
) {
  const service = {
    listComments: vi.fn(async () => []),
    recordOpen: vi.fn(async () => node),
    saveNode: vi.fn(async () => node),
    getNode: vi.fn(async () => node),
    addComment: vi.fn(async (input: unknown) => ({
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
      ...(input as object),
    })),
    updateComment: vi.fn(async () => ({})),
    resolveComment: vi.fn(async () => ({})),
    deleteComment: vi.fn(async () => undefined),
    addCommentSupplement: vi.fn(async () => ({})),
    listVersions: vi.fn(async () => versions),
    createNode: vi.fn(async () => node),
    setArchived: vi.fn(async () => node),
    document: client,
  };
  const refresh = vi.fn();
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
  return { value, service, refresh, toast };
}

function editorSurface(): HTMLElement {
  const surface = document.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="文档正文"]',
  );
  if (surface === null) throw new Error('editor surface is missing');
  return surface;
}

function renderView(
  node: SpaceNode,
  client: ReturnType<typeof makeClient>,
  versions: unknown[] = [],
) {
  const context = makeContext(node, client, versions);
  const view = render(
    createElement(
      SpaceContext.Provider,
      { value: context.value as never },
      createElement(DocumentView, { node } as never),
    ),
  );
  return { ...context, ...view };
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

describe('legacy DocumentView on the AST backend', () => {
  it('loads the AST body into the original contentEditable editor DOM', async () => {
    const doc = sampleDoc();
    renderView(makeNode(doc), makeClient(doc));
    await waitFor(() => {
      expect(screen.getByText('鉴权方案')).toBeTruthy();
      expect(screen.getByText('编辑器正文')).toBeTruthy();
      expect(screen.getByText('列表项')).toBeTruthy();
    });
    // The restored shell DOM is unchanged: title textarea, old editor surface
    // and legacy content elements rendered from the adapter HTML.
    const title = screen.getByLabelText('文档标题') as HTMLTextAreaElement;
    expect(title.tagName).toBe('TEXTAREA');
    expect(title.value).toBe('测试文档');
    expect(title.placeholder).toBe('无标题');
    const surface = editorSurface();
    expect(surface.getAttribute('contenteditable')).toBe('true');
    expect(surface.getAttribute('aria-multiline')).toBe('true');
    expect(surface.getAttribute('data-placeholder')).toBe('开始写点什么…');
    expect(surface.innerHTML).toContain('data-block-id="blk_h1"');
    expect(surface.querySelector('h1')?.textContent).toBe('鉴权方案');
    expect(surface.querySelector('ul li')?.textContent).toBe('列表项');
  });

  it('autosaves editor HTML as Document Operations after the legacy debounce', async () => {
    vi.useFakeTimers();
    const doc = sampleDoc();
    const client = makeClient(doc, {
      applyOperations: async () => ({ docId: 'doc-1', revision: 8 }),
    });
    const { refresh } = renderView(makeNode(doc), client);
    await settle();
    expect(screen.getByText('编辑器正文')).toBeTruthy();

    const surface = editorSurface();
    const paragraph = [...surface.querySelectorAll('p')].find(
      (item) => item.textContent === '编辑器正文',
    );
    expect(paragraph).toBeTruthy();
    paragraph!.textContent = '改后的正文';
    fireEvent.input(surface);

    await tick(690);
    expect(client.applyOperations).not.toHaveBeenCalled();
    await tick(30);
    await settle();
    expect(client.applyOperations).toHaveBeenCalledTimes(1);
    const input = client.applyOperations.mock.calls[0]![0] as {
      docId: string;
      baseRevision: number;
      ops: unknown[];
    };
    expect(input.docId).toBe('doc-1');
    expect(input.baseRevision).toBe(7);
    expect(input.ops.length).toBeGreaterThan(0);
    expect(JSON.stringify(input.ops)).toContain('改后的正文');
    expect(refresh).toHaveBeenCalled();
    // A4: the save echo must not recreate the contentEditable DOM.
    expect(editorSurface()).toBe(surface);
    expect(surface.getAttribute('contenteditable')).toBe('true');
  });

  it('shows the legacy 保存失败，重试 action when the save fails', async () => {
    vi.useFakeTimers();
    const doc = sampleDoc();
    const client = makeClient(doc, {
      applyOperations: async () => {
        throw new Error('网络不可用');
      },
    });
    renderView(makeNode(doc), client);
    await settle();
    const surface = editorSurface();
    const paragraph = [...surface.querySelectorAll('p')].find(
      (item) => item.textContent === '编辑器正文',
    );
    paragraph!.textContent = '失败保留的内容';
    fireEvent.input(surface);
    await tick(700);
    await settle();
    const retry = screen.getByRole('button', { name: '保存失败，重试' });
    expect(retry).toBeTruthy();
    // The edited content is still in the editor (no silent loss).
    expect(editorSurface().textContent).toContain('失败保留的内容');
  });

  it('persists the title through the metadata endpoint', async () => {
    vi.useFakeTimers();
    const doc = sampleDoc();
    const client = makeClient(doc);
    const { service } = renderView(makeNode(doc), client);
    await settle();
    fireEvent.change(screen.getByLabelText('文档标题'), {
      target: { value: '新标题' },
    });
    await tick(700);
    await settle();
    expect(service.saveNode).toHaveBeenCalledWith('doc-1', { title: '新标题' });
  });

  it('materializes pasted data-URL images into assets before saving', async () => {
    const doc = sampleDoc();
    const importAsset = vi.fn(async () => ({
      assetId: 'asset_paste1',
      mime: 'image/png',
      bytes: 4,
    }));
    const client = makeClient(doc, {
      importAsset,
      applyOperations: async () => ({ docId: 'doc-1', revision: 8 }),
    });
    renderView(makeNode(doc), client);
    await waitFor(() => expect(editorSurface()).toBeTruthy());

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', {
      type: 'image/png',
    });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [file],
        types: ['Files'],
        getData: () => '',
      },
    });
    editorSurface().dispatchEvent(event);
    await waitFor(() =>
      expect(editorSurface().querySelector('img[src^="data:image/png"]')).toBeTruthy(),
    );
    await waitFor(() => expect(importAsset).toHaveBeenCalled(), {
      timeout: 3000,
    });
    await waitFor(() => expect(client.applyOperations).toHaveBeenCalled(), {
      timeout: 3000,
    });
    const input = client.applyOperations.mock.calls[0]![0] as {
      ops: unknown[];
    };
    const json = JSON.stringify(input.ops);
    expect(json).toContain('"type":"image"');
    expect(json).toContain('asset_paste1');
    expect(json).not.toContain('data:image');
  });

  it('restores a version from the document menu through the client', async () => {
    const doc = sampleDoc();
    const version = {
      id: 'ver-1',
      docId: 'doc-1',
      title: '测试文档',
      content: JSON.stringify({
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: 2,
        blocks: [
          block('blk_old', 'paragraph', {}, {
            content: [{ type: 'text', text: '旧版本内容' }],
          }),
        ],
      }),
      author: 'me',
      at: '2026-11-09T00:00:00.000Z',
    };
    const client = makeClient(doc, {
      restoreVersion: async () => ({ docId: 'doc-1', revision: 8 }),
    });
    renderView(makeNode(doc), client, [version]);
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '文档菜单' }));
    const historyItem = await screen.findByRole('menuitem', {
      name: /历史记录/,
    });
    fireEvent.click(historyItem);
    await waitFor(() => expect(screen.getByText('旧版本内容')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /还原到此版本/ }));
    await waitFor(() =>
      expect(client.restoreVersion).toHaveBeenCalledWith({
        docId: 'doc-1',
        versionId: 'ver-1',
        baseRevision: 7,
      }),
    );
  });

  it('reloads the editor when an external snapshot changes the revision', async () => {
    const doc = sampleDoc();
    const client = makeClient(doc);
    const { rerender } = renderView(makeNode(doc), client);
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    // D4: external reloads must start a fresh editing session. The browser's
    // native undo stack is only cleared when the contenteditable element is
    // re-created / toggled, so the reload path rebuilds the body nodes instead
    // of assigning innerHTML in place (a real Chrome Ctrl+Z after version
    // restore would otherwise replay pre-restore edits).
    const staleParagraph = editorSurface().querySelector('p');
    expect(staleParagraph).not.toBeNull();
    // The reload path must detach/re-attach the editing host (fresh browser
    // editing session → native undo stack dropped) instead of assigning
    // innerHTML in place, which Chromium keeps undoable.
    const surface = editorSurface();
    const surfaceParent = surface.parentElement;
    expect(surfaceParent).not.toBeNull();
    const detachedLog: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== 'childList') continue;
        for (const removed of record.removedNodes)
          if (removed === surface) detachedLog.push('removed');
        for (const added of record.addedNodes)
          if (added === surface) detachedLog.push('added');
      }
    });
    observer.observe(surfaceParent!, { childList: true });

    const updated: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 8,
      blocks: [
        block('blk_new', 'paragraph', {}, {
          content: [{ type: 'text', text: '外部新内容' }],
        }),
      ],
    };
    const updatedNode = makeNode(updated, {
      updatedAt: '2026-11-10T01:00:00.000Z',
    });
    rerender(
      createElement(
        SpaceContext.Provider,
        {
          value: makeContext(updatedNode, client).value as never,
        },
        createElement(DocumentView, { node: updatedNode } as never),
      ),
    );
    await waitFor(() => {
      expect(screen.getByText('外部新内容')).toBeTruthy();
      expect(screen.queryByText('编辑器正文')).toBeNull();
    });
    // The old body nodes are detached (fresh editing session) and the
    // contenteditable attribute ends in its normal editable state.
    observer.disconnect();
    expect(detachedLog).toEqual(['removed', 'added']);
    expect(editorSurface()).toBe(surface);
    expect(editorSurface().contains(staleParagraph)).toBe(false);
    expect(staleParagraph!.isConnected).toBe(false);
    expect(editorSurface().getAttribute('contenteditable')).toBe('true');
    expect(
      editorSurface().querySelector('[data-block-id="blk_new"]'),
    ).not.toBeNull();
  });
});

describe('legacy HistoryPanel version preview and restore', () => {
  function versionNode(): SpaceNode {
    return makeNode(sampleDoc());
  }

  function versionFixture() {
    return {
      id: 'ver-1',
      docId: 'doc-1',
      title: '测试文档',
      content: JSON.stringify({
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: 2,
        blocks: [
          block('blk_old', 'paragraph', {}, {
            content: [{ type: 'text', text: '旧版本内容' }],
          }),
        ],
      }),
      author: 'me',
      at: '2026-11-09T00:00:00.000Z',
    };
  }

  it('renders AST version bodies as legacy HTML and restores through the client', async () => {
    const node = versionNode();
    const client = makeClient(sampleDoc(), {
      restoreVersion: async () => ({ docId: 'doc-1', revision: 8 }),
    });
    const versions = [versionFixture()];
    const context = makeContext(node, client, versions);
    const onRestored = vi.fn();
    render(
      createElement(
        SpaceContext.Provider,
        { value: context.value as never },
        createElement(HistoryPanel, {
          open: true,
          doc: node,
          baseRevision: 7,
          onClose: vi.fn(),
          onRestored,
        } as never),
      ),
    );
    await waitFor(() => {
      expect(screen.getByText('旧版本内容')).toBeTruthy();
    });
    // AST JSON must never be rendered as raw text in the preview.
    expect(document.body.textContent).not.toContain('"format":"alter-doc/1"');
    fireEvent.click(
      screen.getByRole('button', { name: /还原到此版本/ }),
    );
    await waitFor(() => {
      expect(client.restoreVersion).toHaveBeenCalledWith({
        docId: 'doc-1',
        versionId: 'ver-1',
        baseRevision: 7,
      });
    });
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });
});
