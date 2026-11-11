// @vitest-environment jsdom
/**
 * Legacy document view recovery UX: crash-draft dialogs, conflict paths
 * (B1/B2/B3), version-restore guard (B4) and read-only recovery windows.
 */
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceNode } from '@alter/protocol';
import { SpaceContext } from '../../../../vendor/ui-space/src/runtime';
import { DocumentView } from '../../../../vendor/ui-space/src/views/DocumentView';
import {
  LEGACY_DRAFT_FORMAT,
  alterDocToEditorHtml,
  legacyDraftStorageKey,
  readLegacyDraft,
  serializeDocument,
  type LegacyDocumentDraft,
} from '../../../../src/document/editors/legacy';
import { applyOperations as applyHostOperations } from '../../../../host/document/ast/operations.js';
import type {
  AlterDoc,
  BlockNode,
  OperationContext,
} from '../../../../host/document/editors/legacy/types.js';
import { SpaceRemoteError } from '../../../../src/client/rpc';

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

let blockSequence = 0;
let objectSequence = 0;

function makeOperationContext(): OperationContext {
  return {
    docId: 'doc-1',
    nowIso: () => '2026-11-10T00:00:00.000Z',
    createBlockId: () => `blk_gen_${(blockSequence += 1)}`,
    parseMarkdown: () => {
      throw new Error('unused');
    },
    createObject: () => `obj_gen_${(objectSequence += 1)}`,
  };
}

function paragraph(id: string, text: string): BlockNode {
  return {
    id,
    type: 'paragraph',
    attrs: {},
    content: text === '' ? [] : [{ type: 'text', text }],
  };
}

function docOf(blocks: BlockNode[], revision = 1): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision, blocks };
}

interface ServerState {
  doc: AlterDoc;
  revision: number;
  title: string;
}

function makeServerClient(server: ServerState) {
  const defaultApply = async (input: {
    baseRevision: number;
    ops: unknown[];
  }): Promise<unknown> => {
    if (input.baseRevision !== server.revision) {
      throw new SpaceRemoteError('doc/conflict', '文档已被修改');
    }
    const result = applyHostOperations(
      server.doc,
      input.ops as never,
      makeOperationContext(),
    );
    server.revision += 1;
    server.doc = { ...result.doc, revision: server.revision };
    return { docId: 'doc-1', revision: server.revision };
  };
  const applyOperations = vi.fn(defaultApply);
  const get = vi.fn(async () => ({
    docId: 'doc-1',
    revision: server.revision,
    title: server.title,
    doc: server.doc,
  }));
  const restoreVersion = vi.fn(
    async (input: { versionId: string; baseRevision: number }) => {
      if (input.baseRevision !== server.revision) {
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      }
      const version = versions.get(input.versionId);
      if (version === undefined) {
        throw new SpaceRemoteError('op/invalid', '历史版本不存在');
      }
      server.revision += 1;
      server.doc = { ...version, revision: server.revision };
      server.title = '历史版本标题';
      return { docId: 'doc-1', revision: server.revision };
    },
  );
  const client = {
    get,
    applyOperations,
    restoreVersion,
    importAsset: vi.fn(),
    importFile: vi.fn(),
  };
  return { client, get, applyOperations, restoreVersion, server };
}

const versions = new Map<string, AlterDoc>();

function makeNode(server: ServerState, overrides: Record<string, unknown> = {}): SpaceNode {
  return {
    id: 'doc-1',
    spaceId: 'sp-1',
    kind: 'note',
    title: server.title,
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
    content: serializeDocument(server.doc),
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

function makeContext(
  node: SpaceNode,
  client: ReturnType<typeof makeServerClient>['client'],
  serviceOverrides: Record<string, unknown> = {},
) {
  const service = {
    listComments: vi.fn(async () => []),
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
    ...serviceOverrides,
  };
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
    toast: vi.fn(),
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
  return { value, service };
}

function mountView(
  node: SpaceNode,
  client: ReturnType<typeof makeServerClient>['client'],
  serviceOverrides: Record<string, unknown> = {},
) {
  const context = makeContext(node, client, serviceOverrides);
  const view = render(
    createElement(
      SpaceContext.Provider,
      { value: context.value as never },
      createElement(DocumentView, { node } as never),
    ),
  );
  const surface = (): HTMLElement => {
    const element = view.container.querySelector<HTMLElement>(
      '[role="textbox"][aria-label="文档正文"]',
    );
    if (element === null) throw new Error('editor surface missing');
    return element;
  };
  return { ...view, ...context, surface };
}

function seedDraft(
  overrides: Partial<LegacyDocumentDraft> = {},
): LegacyDocumentDraft {
  const draft: LegacyDocumentDraft = {
    format: LEGACY_DRAFT_FORMAT,
    docId: 'doc-1',
    html: alterDocToEditorHtml(docOf([paragraph('blk_draft', '草稿正文')])),
    title: '草稿标题',
    baseRevision: 7,
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
  localStorage.setItem(legacyDraftStorageKey('doc-1'), JSON.stringify(draft));
  return draft;
}

function storedDraft(): LegacyDocumentDraft | undefined {
  return readLegacyDraft('doc-1');
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  blockSequence = 0;
  objectSequence = 0;
  versions.clear();
  localStorage.clear();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    originalResizeObserver;
});

// ---------------------------------------------------------------------------
// Crash-draft recovery dialogs
// ---------------------------------------------------------------------------

describe('legacy crash-draft recovery', () => {
  it('offers restore/discard for a same-revision draft and restores it', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client, applyOperations } = makeServerClient(server);
    const node = makeNode(server);
    seedDraft();
    const view = mountView(node, client);
    const dialog = await screen.findByRole('dialog', {
      name: '发现未保存草稿',
    });
    expect(dialog).toBeTruthy();
    // Recovery window: editor must not accept input.
    expect(view.surface().getAttribute('contenteditable')).toBe('false');

    fireEvent.click(within(dialog).getByRole('button', { name: '恢复' }));
    await waitFor(() =>
      expect(view.surface().textContent).toContain('草稿正文'),
    );
    expect(
      (screen.getByLabelText('文档标题') as HTMLTextAreaElement).value,
    ).toBe('草稿标题');
    expect(view.surface().getAttribute('contenteditable')).toBe('true');
    await tick(700);
    await settle();
    expect(applyOperations).toHaveBeenCalledTimes(1);
    expect(
      (applyOperations.mock.calls[0]![0] as { baseRevision: number })
        .baseRevision,
    ).toBe(7);
    expect(storedDraft()).toBeUndefined();
  });

  it('discards a same-revision draft without touching the editor', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client } = makeServerClient(server);
    seedDraft();
    const view = mountView(makeNode(server), client);
    const dialog = await screen.findByRole('dialog', {
      name: '发现未保存草稿',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃' }));
    await waitFor(() => expect(storedDraft()).toBeUndefined());
    expect(view.surface().textContent).toContain('服务端正文');
    expect(screen.queryByRole('dialog', { name: '发现未保存草稿' })).toBeNull();
  });

  it('keeps local content over a newer revision (stale draft, B2)', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端新内容')], 9),
      revision: 9,
      title: '测试文档',
    };
    const { client, applyOperations, get } = makeServerClient(server);
    const node = makeNode(
      { ...server, doc: docOf([paragraph('blk_p', '旧内容')], 7), revision: 7 },
      { content: serializeDocument(docOf([paragraph('blk_p', '旧内容')], 7)) },
    );
    seedDraft({ baseRevision: 5 });
    const view = mountView(node, client);
    const dialog = await screen.findByRole('dialog', {
      name: '检测到旧版本草稿',
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '保留本地并覆盖' }),
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    await tick(700);
    await settle();
    await waitFor(() => expect(applyOperations).toHaveBeenCalled());
    const input = applyOperations.mock.calls.at(-1)![0] as {
      baseRevision: number;
    };
    expect(input.baseRevision).toBe(9);
    await waitFor(() =>
      expect(JSON.stringify(server.doc.blocks)).toContain('草稿正文'),
    );
    expect(view.surface().textContent).toContain('草稿正文');
    expect(storedDraft()).toBeUndefined();
  });

  it('discards a stale draft and reloads the latest server content', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端新内容')], 9),
      revision: 9,
      title: '测试文档',
    };
    const { client } = makeServerClient(server);
    const node = makeNode(
      { ...server, doc: docOf([paragraph('blk_p', '旧内容')], 7), revision: 7 },
      { content: serializeDocument(docOf([paragraph('blk_p', '旧内容')], 7)) },
    );
    seedDraft({ baseRevision: 5 });
    const view = mountView(node, client);
    const dialog = await screen.findByRole('dialog', {
      name: '检测到旧版本草稿',
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '丢弃并重载' }),
    );
    await waitFor(() =>
      expect(view.surface().textContent).toContain('服务端新内容'),
    );
    expect(storedDraft()).toBeUndefined();
  });

  it('silently drops a draft already represented by the server', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '已落盘正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client } = makeServerClient(server);
    const draft = seedDraft({
      html: alterDocToEditorHtml(docOf([paragraph('blk_p', '已落盘正文')])),
      title: '测试文档',
      baseRevision: 7,
    });
    expect(draft.html).toContain('已落盘正文');
    mountView(makeNode(server), client);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(storedDraft()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A1/A2: draft survives a crash / page hide and is offered on reopen
// ---------------------------------------------------------------------------

describe('legacy crash safety', () => {
  it('writes a draft before the page is hidden (A1/A2)', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client } = makeServerClient(server);
    const view = mountView(makeNode(server), client);
    await waitFor(() => expect(view.surface()).toBeTruthy());
    const paragraphElement = view.surface().querySelector('p')!;
    paragraphElement.textContent = '页面隐藏前的内容';
    fireEvent.input(view.surface());
    const visibility = Object.getOwnPropertyDescriptor(
      document,
      'visibilityState',
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      const draft = storedDraft();
      expect(draft).toBeDefined();
      expect(draft!.html).toContain('页面隐藏前的内容');
      expect(draft!.baseRevision).toBe(7);
    } finally {
      if (visibility === undefined) {
        delete (document as unknown as { visibilityState?: string })
          .visibilityState;
      } else {
        Object.defineProperty(document, 'visibilityState', visibility);
      }
    }
  });

  it('persists a draft on unmount and offers it again on reopen (A1)', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client, applyOperations } = makeServerClient(server);
    // The final background save fails (offline), so the draft is the only copy.
    applyOperations.mockRejectedValue(new Error('离线'));
    const node = makeNode(server);
    const first = mountView(node, client);
    await waitFor(() => expect(first.surface()).toBeTruthy());
    const paragraphElement = first.surface().querySelector('p')!;
    paragraphElement.textContent = '切换文档前的内容';
    fireEvent.input(first.surface());
    cleanup();
    await settle();
    const draft = storedDraft();
    expect(draft).toBeDefined();
    expect(draft!.html).toContain('切换文档前的内容');

    // Reopen the same document: the draft is offered and can be restored.
    const second = mountView(node, client);
    const dialog = await screen.findByRole('dialog', {
      name: '发现未保存草稿',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '恢复' }));
    await waitFor(() =>
      expect(second.surface().textContent).toContain('切换文档前的内容'),
    );
  });
});

// ---------------------------------------------------------------------------
// Save conflicts (B1/B2/B3)
// ---------------------------------------------------------------------------

describe('legacy save conflicts', () => {
  function conflictingSetup() {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client, applyOperations, get } = makeServerClient(server);
    // First save attempt conflicts; the server has newer content meanwhile.
    applyOperations.mockImplementationOnce(async () => {
      server.doc = docOf([paragraph('blk_other', '他人内容')], 9);
      server.revision = 9;
      throw new SpaceRemoteError('doc/conflict', '文档已被修改');
    });
    const view = mountView(makeNode(server, {
      content: serializeDocument(docOf([paragraph('blk_p', '服务端正文')], 7)),
    }), client);
    return { view, client, applyOperations, get, server };
  }

  async function editSurface(
    view: ReturnType<typeof mountView>,
    text: string,
  ): Promise<void> {
    const surface = view.surface();
    const paragraphElement = surface.querySelector('p');
    expect(paragraphElement).toBeTruthy();
    paragraphElement!.textContent = text;
    fireEvent.input(surface);
    await tick(700);
    await settle();
  }

  it('offers multiple conflict paths and keeps local content on overwrite (B2)', async () => {
    const { view, applyOperations, server } = conflictingSetup();
    await editSurface(view, '本地编辑内容');
    const dialog = await screen.findByRole('dialog', {
      name: '文档已被其他修改',
    });
    const labels = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim());
    expect(labels).toEqual(
      expect.arrayContaining([
        '保留本地草稿并覆盖',
        '重新加载并丢弃本地',
        '导出草稿',
        '仅保留草稿',
      ]),
    );
    // Conflict did not silently overwrite the other writer's content.
    expect(JSON.stringify(server.doc.blocks)).toContain('他人内容');

    fireEvent.click(
      within(dialog).getByRole('button', { name: '保留本地草稿并覆盖' }),
    );
    await settle();
    await waitFor(() => expect(applyOperations).toHaveBeenCalledTimes(2));
    const retryInput = applyOperations.mock.calls[1]![0] as {
      baseRevision: number;
    };
    expect(retryInput.baseRevision).toBe(9);
    await waitFor(() =>
      expect(JSON.stringify(server.doc.blocks)).toContain('本地编辑内容'),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: '文档已被其他修改' }),
      ).toBeNull(),
    );
    expect(view.surface().textContent).toContain('本地编辑内容');
  });

  it('offers a draft download from the conflict dialog', async () => {
    const { view } = conflictingSetup();
    await editSurface(view, '本地编辑内容');
    const dialog = await screen.findByRole('dialog', {
      name: '文档已被其他修改',
    });
    const createObjectUrl = vi.fn(() => 'blob:draft');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    fireEvent.click(within(dialog).getByRole('button', { name: '导出草稿' }));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    const blob = createObjectUrl.mock.calls[0]![0] as Blob;
    expect(blob.type).toContain('text/html');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('reloads and discards local edits from the conflict dialog', async () => {
    const { view, server } = conflictingSetup();
    await editSurface(view, '本地编辑内容');
    const dialog = await screen.findByRole('dialog', {
      name: '文档已被其他修改',
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '重新加载并丢弃本地' }),
    );
    await waitFor(() =>
      expect(view.surface().textContent).toContain('他人内容'),
    );
    expect(JSON.stringify(server.doc.blocks)).toContain('他人内容');
    expect(storedDraft()).toBeUndefined();
  });

  it('never silently overwrites the first writer with a second entry (B3)', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '初始内容')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client, applyOperations } = makeServerClient(server);
    const node = makeNode(server);
    const first = mountView(node, client);
    const second = mountView(node, client);

    // First entry saves.
    const firstParagraph = first.surface().querySelector('p')!;
    firstParagraph.textContent = '入口一内容';
    fireEvent.input(first.surface());
    await tick(700);
    await settle();
    expect(server.revision).toBe(8);
    expect(JSON.stringify(server.doc.blocks)).toContain('入口一内容');

    // Second entry (stale base) saves → conflict, first writer untouched.
    const secondParagraph = second.surface().querySelector('p')!;
    secondParagraph.textContent = '入口二内容';
    fireEvent.input(second.surface());
    await tick(700);
    await settle();
    expect(applyOperations).toHaveBeenCalledTimes(2);
    const dialog = await screen.findByRole('dialog', {
      name: '文档已被其他修改',
    });
    expect(JSON.stringify(server.doc.blocks)).toContain('入口一内容');
    expect(JSON.stringify(server.doc.blocks)).not.toContain('入口二内容');

    // Explicit choice: keep local and overwrite the latest revision.
    fireEvent.click(
      within(dialog).getByRole('button', { name: '保留本地草稿并覆盖' }),
    );
    await settle();
    await waitFor(() => expect(server.revision).toBe(9));
    expect(JSON.stringify(server.doc.blocks)).toContain('入口二内容');
  });
});

// ---------------------------------------------------------------------------
// Version restore guard (B4)
// ---------------------------------------------------------------------------

describe('legacy version restore guard', () => {
  it('asks before restoring over unsaved edits and persists a draft first', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client, restoreVersion } = makeServerClient(server);
    const historical = docOf([paragraph('blk_old', '历史版本内容')], 2);
    versions.set('ver-1', historical);
    const node = makeNode(server);
    const view = mountView(node, client, {
      listVersions: vi.fn(async () => [
        {
          id: 'ver-1',
          docId: 'doc-1',
          title: '测试文档',
          content: serializeDocument(historical),
          author: 'me',
          at: '2026-11-09T00:00:00.000Z',
        },
      ]),
      getNode: vi.fn(async () => ({
        ...node,
        title: server.title,
        content: serializeDocument(server.doc),
      })),
    });
    await waitFor(() => expect(view.surface()).toBeTruthy());
    const paragraphElement = view.surface().querySelector('p')!;
    paragraphElement.textContent = '未保存的本地内容';
    fireEvent.input(view.surface());

    fireEvent.click(screen.getByRole('button', { name: '文档菜单' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /历史记录/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /还原到此版本/ }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: '存在未保存修改',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(restoreVersion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /还原到此版本/ }));
    const confirm = await screen.findByRole('dialog', {
      name: '存在未保存修改',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: '继续恢复' }),
    );
    await waitFor(() => expect(restoreVersion).toHaveBeenCalledTimes(1));
    const input = restoreVersion.mock.calls[0]![0] as {
      baseRevision: number;
    };
    expect(input.baseRevision).toBe(7);
    // The unsaved edits were persisted as a crash draft before restoring and
    // the draft is kept afterwards for a later recovery.
    expect(storedDraft()).toBeDefined();
    expect(storedDraft()!.html).toContain('未保存的本地内容');
    await waitFor(() =>
      expect(view.surface().textContent).toContain('历史版本内容'),
    );
    expect(storedDraft()).toBeDefined();
  });
});
