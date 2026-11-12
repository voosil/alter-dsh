/**
 * New-document route landing.
 *
 * The route is an in-memory store outside React: notifying listeners can render
 * before the same batch's `setNodes` commits. `SpaceApp`'s route correction
 * falls back when the target id is missing from the document list, so the
 * create flow must publish the new document before navigating.
 *
 * This suite asserts the ordering at the moment `router.navigate` is called —
 * the same timing that showed "new document lands on the overview" in the
 * browser — plus the final editor/focus state.
 *
 * The service is an in-memory double rather than the real SQLite authority:
 * this layer owns browser behaviour (jsdom), and the Host half is covered by
 * `tests/integration/`. A real-store variant needs a browser runner that can
 * load `node:sqlite`, which the current gate does not have.
 */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Space, SpaceNode, SpaceRouter, SpaceService } from '@alter/protocol';
import { SpaceApp } from '../../../vendor/ui-space/src/SpaceApp';
import { attachDocumentClient } from '../../../src/document/client-access';
import type { SpaceDocumentClient } from '../../../src/client/rpc';

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

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

const FIXED_NOW = () => new Date('2026-11-06T00:00:00.000Z');
const SPACE_ID = 'sp-1';

interface DocNavigation {
  /** 目标内存路由，如 `#/space/sp-1/doc/doc-2`。 */
  to: string;
  /** 导航瞬间侧栏已列出的文档数；新建文档必须已经计入。 */
  listedDocs: number;
}

function createRouter(): SpaceRouter & { docNavigations: DocNavigation[] } {
  let path = '#/space';
  const docNavigations: DocNavigation[] = [];
  const listeners = new Set<() => void>();
  return {
    docNavigations,
    getPath: () => path,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    navigate(next: string) {
      if (next === path) return;
      if (/\/doc\/doc-[^/]+$/.test(next))
        docNavigations.push({
          to: next,
          listedDocs: document.querySelectorAll('[aria-label="空间文档"] [data-actions]').length,
        });
      path = next;
      for (const listener of listeners) listener();
    },
  };
}

/** Minimal in-memory authority: one space, documents created on demand. */
function createMemoryService(): SpaceService {
  const space: Space = {
    id: SPACE_ID,
    name: '导航空间',
    description: '',
    color: '#888888',
    directories: [],
    createdAt: FIXED_NOW().toISOString(),
    updatedAt: FIXED_NOW().toISOString(),
    order: 0,
  } as unknown as Space;
  const nodes: SpaceNode[] = [];
  let sequence = 0;

  const emptyDocument = () =>
    JSON.stringify({ format: 'alter-doc/1', schemaVersion: 1, revision: 1, blocks: [] });

  const newDoc = (parentId: string | null = null): SpaceNode => {
    sequence += 1;
    const id = `doc-${sequence}`;
    const stamp = FIXED_NOW().toISOString();
    const node: SpaceNode = {
      id,
      spaceId: SPACE_ID,
      kind: 'note',
      title: '',
      parentId,
      creator: 'me',
      pinned: false,
      archived: false,
      archivedBy: null,
      archivedAt: null,
      deletedAt: null,
      deletedRoot: false,
      originalParentId: null,
      unread: false,
      content: emptyDocument(),
      activity: 100,
      activityAt: stamp,
      lastOpenCreditAt: null,
      lastEditCreditAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      order: nodes.length,
    } as unknown as SpaceNode;
    nodes.push(node);
    return node;
  };

  const overlay = (node: SpaceNode): SpaceNode => node;
  const service = {
    listSpaces: async () => [space],
    getSpace: async () => space,
    listArchivedSpaces: async () => [],
    listNodes: async () => nodes.map(overlay),
    getNode: async (id: string) => nodes.find((node) => node.id === id),
    createNode: async (input: { parentId?: string | null }) => {
      const node = newDoc(input.parentId ?? null);
      return node;
    },
    saveNode: async (id: string, patch: Record<string, unknown>) => {
      const node = nodes.find((item) => item.id === id);
      if (node) Object.assign(node, patch);
      return node;
    },
    recordOpen: async () => undefined,
    listComments: async () => [],
    listVersions: async () => [],
    listThoughts: async () => [],
    listDeleted: async () => ({ nodes: [], thoughts: [] }),
    search: async () => [],
    listAgents: async () => [],
    listDirectories: async () => ({ recent: [], home: null }),
    getOverview: async () => ({ spaces: [space] }),
    hub: { get: async () => null },
  };

  const documentClient: SpaceDocumentClient = {
    get: async () => ({
      docId: 'doc-1',
      revision: 1,
      title: '',
      doc: { format: 'alter-doc/1', schemaVersion: 1, revision: 1, blocks: [] },
    }),
    outline: async (docId: string) => ({
      docId,
      title: '',
      revision: 1,
      blocks: [],
      blockCount: 0,
      totalBlocks: 0,
      truncated: false,
    }),
    read: async () => ({ markdown: '', truncated: false }),
    search: async () => ({ results: [] }),
    applyOps: async () => ({ revision: 2, changedBlockIds: [] }),
    undo: async () => ({ revision: 3 }),
    restoreVersion: async () => ({ revision: 4 }),
    generate: async () => ({ docId: 'doc-1', revision: 1, changedBlockIds: [], title: '' }),
    importAsset: async () => ({ id: 'asset_1', bytes: 1 }),
    importFile: async () => ({ id: 'asset_1', bytes: 1 }),
    updateObject: async () => ({ ok: true }),
  } as unknown as SpaceDocumentClient;

  return attachDocumentClient(service as unknown as SpaceService, documentClient);
}

async function renderApp() {
  const service = createMemoryService();
  const router = createRouter();
  render(createElement(SpaceApp, { service, router } as never));
  return { router };
}

/** 标题 textarea；新建后光标应当已经落在里面。 */
function titleInput(): HTMLTextAreaElement {
  return screen.getByLabelText('文档标题') as HTMLTextAreaElement;
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
});

afterEach(() => {
  cleanup();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
});

describe('新建文档后的路由落点', () => {
  it('空空间新建文档时直接打开该文档并把光标放进标题', async () => {
    const { router } = await renderApp();
    fireEvent.click(await screen.findByText('新建文档'));
    await waitFor(() => {
      expect(screen.getByLabelText('文档正文')).toBeTruthy();
    });
    // The page mounts the AST-native kernel by default (no kernel preference).
    expect(
      document.querySelector('[data-editor-kernel="tiptap"]'),
    ).not.toBeNull();
    const [navigation] = router.docNavigations;
    expect(navigation?.listedDocs).toBe(1);
    expect(router.getPath()).toMatch(/\/doc\/doc-[^/]+$/);
    expect(screen.queryByText('空间详情')).toBeNull();
    expect(document.activeElement).toBe(titleInput());
  });

  it('已有文档时新建文档打开新文档，而不是上一篇', async () => {
    const { router } = await renderApp();
    fireEvent.click(await screen.findByText('新建文档'));
    await waitFor(() => {
      expect(router.getPath()).toMatch(/\/doc\/doc-[^/]+$/);
    });
    const firstDoc = router.getPath();

    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="新建"]') as HTMLButtonElement);
    });
    fireEvent.click(await screen.findByText('新建文档'));
    await waitFor(() => {
      expect(router.getPath()).not.toBe(firstDoc);
      expect(screen.getByLabelText('文档正文')).toBeTruthy();
    });
    const last = router.docNavigations.at(-1);
    expect(last?.listedDocs).toBe(2);
    expect(router.getPath()).toBe(last?.to);
    expect(document.activeElement).toBe(titleInput());
  });

  it('重新打开已有文档不抢焦点', async () => {
    const { router } = await renderApp();
    fireEvent.click(await screen.findByText('新建文档'));
    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput());
    });
    const firstDocPath = router.getPath();

    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="新建"]') as HTMLButtonElement);
    });
    fireEvent.click(await screen.findByText('新建文档'));
    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput());
      expect(router.getPath()).not.toBe(firstDocPath);
    });

    const secondDocPath = router.getPath();
    await act(async () => {
      router.navigate(firstDocPath);
    });
    await waitFor(() => {
      expect(router.getPath()).toBe(firstDocPath);
    });
    await act(async () => {
      router.navigate(secondDocPath);
    });
    await waitFor(() => {
      expect(router.getPath()).toBe(secondDocPath);
    });
    expect(document.activeElement).not.toBe(titleInput());
  });
});


