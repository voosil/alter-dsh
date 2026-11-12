// @vitest-environment jsdom
/**
 * Document page recovery UX: crash-draft dialogs, conflict paths (B1/B2/B3),
 * version-restore guard (B4) and read-only recovery windows.
 *
 * Drafts are kernel-independent AST snapshots; recovery reloads the body by
 * passing an explicit document + revision to the AST-native kernel.
 */
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceNode } from '@alter/protocol';
import {
  DRAFT_FORMAT,
  SAVE_DEBOUNCE_MS,
  draftStorageKey,
  readDocumentDraft,
  serializeDocument,
  type DocumentDraft,
} from '../../../../src/document/runtime';
import type { AlterDoc } from '../../../../src/document/types';
import { SpaceRemoteError } from '../../../../src/client/rpc';
import { applyOperations as applyHostOperations } from '../../../../host/document/ast/operations.js';
import type { OperationContext } from '../../../../host/document/editors/legacy/types.js';
import {
  createPageClient,
  docOf,
  installResizeObserver,
  makeNode,
  mountDocumentPage,
  paragraph,
  settle,
  wait,
} from '../../../support/document-page';

let restoreResizeObserver: () => void;

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

interface ServerState {
  doc: AlterDoc;
  revision: number;
  title: string;
}

const versions = new Map<string, AlterDoc>();

interface ApplyInput {
  baseRevision: number;
  ops: unknown[];
}

/** A server double that applies real Document Operations (schema-valid saves). */
function makeServerClient(server: ServerState) {
  const defaultApply = async (input: ApplyInput): Promise<unknown> => {
    if (input.baseRevision !== server.revision) {
      throw new SpaceRemoteError('doc/conflict', '文档已被修改');
    }
    const result = applyHostOperations(
      server.doc as never,
      input.ops as never,
      makeOperationContext(),
    );
    server.revision += 1;
    server.doc = { ...(result.doc as AlterDoc), revision: server.revision };
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
  const client = createPageClient(server.doc, {
    get,
    applyOperations,
    restoreVersion,
  });
  return {
    client,
    get: client.get,
    applyOperations: client.applyOperations,
    restoreVersion: client.restoreVersion,
    server,
  };
}

function makeNodeForServer(
  server: ServerState,
  overrides: Record<string, unknown> = {},
): SpaceNode {
  return makeNode(server.doc, {
    title: server.title,
    content: serializeDocument(server.doc),
    ...overrides,
  });
}

function seedDraft(
  overrides: Partial<DocumentDraft> = {},
): DocumentDraft {
  const draft: DocumentDraft = {
    format: DRAFT_FORMAT,
    docId: 'doc-1',
    blocks: docOf([paragraph('blk_draft', '草稿正文')]).blocks,
    title: '草稿标题',
    baseRevision: 7,
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
  localStorage.setItem(draftStorageKey('doc-1'), JSON.stringify(draft));
  return draft;
}

function readStoredDraft(): DocumentDraft | undefined {
  return readDocumentDraft('doc-1');
}

async function saveCycleWait(): Promise<void> {
  await wait(SAVE_DEBOUNCE_MS + 100);
  await settle();
}

beforeEach(() => {
  blockSequence = 0;
  objectSequence = 0;
  versions.clear();
  localStorage.clear();
  restoreResizeObserver = installResizeObserver();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  restoreResizeObserver();
});

// ---------------------------------------------------------------------------
// Crash-draft recovery dialogs
// ---------------------------------------------------------------------------

describe('crash-draft recovery', () => {
  it('offers restore/discard for a same-revision draft and restores it', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client, applyOperations } = makeServerClient(server);
    seedDraft();
    const page = mountDocumentPage(makeNodeForServer(server), client);
    const dialog = await screen.findByRole('dialog', {
      name: '发现未保存草稿',
    });
    expect(dialog).toBeTruthy();
    // Recovery window: the editor must not accept input.
    expect(page.surface().getAttribute('contenteditable')).toBe('false');

    fireEvent.click(within(dialog).getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(page.bodyText()).toContain('草稿正文'));
    expect(
      (screen.getByLabelText('文档标题') as HTMLTextAreaElement).value,
    ).toBe('草稿标题');
    expect(page.surface().getAttribute('contenteditable')).toBe('true');
    await saveCycleWait();
    expect(applyOperations).toHaveBeenCalledTimes(1);
    expect(
      (applyOperations.mock.calls[0]![0] as { baseRevision: number })
        .baseRevision,
    ).toBe(7);
    expect(readStoredDraft()).toBeUndefined();
  });

  it('discards a same-revision draft without touching the editor', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client } = makeServerClient(server);
    seedDraft();
    const page = mountDocumentPage(makeNodeForServer(server), client);
    const dialog = await screen.findByRole('dialog', {
      name: '发现未保存草稿',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃' }));
    await waitFor(() => expect(readStoredDraft()).toBeUndefined());
    expect(page.bodyText()).toContain('服务端正文');
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
      docOf([paragraph('blk_p', '旧内容')], 7),
      {
        title: '测试文档',
        content: serializeDocument(docOf([paragraph('blk_p', '旧内容')], 7)),
      },
    );
    seedDraft({ baseRevision: 5 });
    const page = mountDocumentPage(node, client);
    const dialog = await screen.findByRole('dialog', {
      name: '检测到旧版本草稿',
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '保留本地并覆盖' }),
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    await saveCycleWait();
    await waitFor(() => expect(applyOperations).toHaveBeenCalled());
    expect(
      (applyOperations.mock.calls.at(-1)![0] as { baseRevision: number })
        .baseRevision,
    ).toBe(9);
    await waitFor(() =>
      expect(JSON.stringify(server.doc.blocks)).toContain('草稿正文'),
    );
    expect(page.bodyText()).toContain('草稿正文');
    expect(readStoredDraft()).toBeUndefined();
  });

  it('discards a stale draft and reloads the latest server content', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端新内容')], 9),
      revision: 9,
      title: '测试文档',
    };
    const { client } = makeServerClient(server);
    const node = makeNode(
      docOf([paragraph('blk_p', '旧内容')], 7),
      {
        title: '测试文档',
        content: serializeDocument(docOf([paragraph('blk_p', '旧内容')], 7)),
      },
    );
    seedDraft({ baseRevision: 5 });
    const page = mountDocumentPage(node, client);
    const dialog = await screen.findByRole('dialog', {
      name: '检测到旧版本草稿',
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '丢弃并重载' }),
    );
    await waitFor(() => expect(page.bodyText()).toContain('服务端新内容'));
    expect(readStoredDraft()).toBeUndefined();
  });

  it('silently drops a draft already represented by the server', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '已落盘正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client } = makeServerClient(server);
    seedDraft({
      blocks: docOf([paragraph('blk_p', '已落盘正文')]).blocks,
      title: '测试文档',
      baseRevision: 7,
    });
    mountDocumentPage(makeNodeForServer(server), client);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readStoredDraft()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A1/A2: draft survives a crash / page hide and is offered on reopen
// ---------------------------------------------------------------------------

describe('crash safety', () => {
  it('writes a draft before the page is hidden (A1/A2)', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client } = makeServerClient(server);
    const page = mountDocumentPage(makeNodeForServer(server), client);
    await waitFor(() => expect(page.surface()).toBeTruthy());
    await page.insertAtEnd('页面隐藏前的内容');

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
      const draft = readStoredDraft();
      expect(draft).toBeDefined();
      expect(JSON.stringify(draft!.blocks)).toContain('页面隐藏前的内容');
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
    const node = makeNodeForServer(server);
    const first = mountDocumentPage(node, client);
    await waitFor(() => expect(first.surface()).toBeTruthy());
    await first.insertAtEnd('切换文档前的内容');
    cleanup();
    await settle();
    const draft = readStoredDraft();
    expect(draft).toBeDefined();
    expect(JSON.stringify(draft!.blocks)).toContain('切换文档前的内容');

    // Reopen the same document: the draft is offered and can be restored.
    const second = mountDocumentPage(node, client);
    const dialog = await screen.findByRole('dialog', {
      name: '发现未保存草稿',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '恢复' }));
    await waitFor(() =>
      expect(second.bodyText()).toContain('切换文档前的内容'),
    );
  });
});

// ---------------------------------------------------------------------------
// Save conflicts (B1/B2/B3)
// ---------------------------------------------------------------------------

describe('save conflicts', () => {
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
    const node = makeNode(
      docOf([paragraph('blk_p', '服务端正文')], 7),
      {
        title: '测试文档',
        content: serializeDocument(docOf([paragraph('blk_p', '服务端正文')], 7)),
      },
    );
    const page = mountDocumentPage(node, client);
    return { page, client, applyOperations, get, server };
  }

  async function editBody(
    page: ReturnType<typeof mountDocumentPage>,
    text: string,
  ): Promise<void> {
    await page.replaceFirstBlockText(text);
    await saveCycleWait();
  }

  it('offers multiple conflict paths and keeps local content on overwrite (B2)', async () => {
    const { page, applyOperations, server } = conflictingSetup();
    await editBody(page, '本地编辑内容');
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
    expect(
      (applyOperations.mock.calls[1]![0] as { baseRevision: number })
        .baseRevision,
    ).toBe(9);
    await waitFor(() =>
      expect(JSON.stringify(server.doc.blocks)).toContain('本地编辑内容'),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: '文档已被其他修改' }),
      ).toBeNull(),
    );
    expect(page.bodyText()).toContain('本地编辑内容');
  });

  it('offers a draft download from the conflict dialog', async () => {
    const { page } = conflictingSetup();
    await editBody(page, '本地编辑内容');
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
    // Drafts are stored as AST blocks; the recovery file is plain text.
    expect(blob.type).toContain('text/plain');
    await expect(blob.text()).resolves.toContain('本地编辑内容');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('reloads and discards local edits from the conflict dialog', async () => {
    const { page, server } = conflictingSetup();
    await editBody(page, '本地编辑内容');
    const dialog = await screen.findByRole('dialog', {
      name: '文档已被其他修改',
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '重新加载并丢弃本地' }),
    );
    await waitFor(() => expect(page.bodyText()).toContain('他人内容'));
    expect(JSON.stringify(server.doc.blocks)).toContain('他人内容');
    expect(readStoredDraft()).toBeUndefined();
  });

  it('never silently overwrites the first writer with a second entry (B3)', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '初始内容')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client, applyOperations } = makeServerClient(server);
    const node = makeNodeForServer(server);
    const first = mountDocumentPage(node, client);
    const second = mountDocumentPage(node, client);

    // First entry saves.
    await first.replaceFirstBlockText('入口一内容');
    await saveCycleWait();
    expect(server.revision).toBe(8);
    expect(JSON.stringify(server.doc.blocks)).toContain('入口一内容');

    // Second entry (stale base) saves → conflict, first writer untouched.
    await second.replaceFirstBlockText('入口二内容');
    await saveCycleWait();
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

describe('version restore guard', () => {
  it('asks before restoring over unsaved edits and persists a draft first', async () => {
    const server: ServerState = {
      doc: docOf([paragraph('blk_p', '服务端正文')], 7),
      revision: 7,
      title: '测试文档',
    };
    const { client, restoreVersion } = makeServerClient(server);
    const historical = docOf([paragraph('blk_old', '历史版本内容')], 2);
    versions.set('ver-1', historical);
    const node = makeNodeForServer(server);
    const page = mountDocumentPage(node, client, {
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
    await waitFor(() => expect(page.surface()).toBeTruthy());
    await page.replaceFirstBlockText('未保存的本地内容');

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
    expect(
      (restoreVersion.mock.calls[0]![0] as { baseRevision: number })
        .baseRevision,
    ).toBe(7);
    // The unsaved edits were persisted as a crash draft before restoring and
    // the draft is kept afterwards for a later recovery.
    const draft = readStoredDraft();
    expect(draft).toBeDefined();
    expect(JSON.stringify(draft!.blocks)).toContain('未保存的本地内容');
    await waitFor(() =>
      expect(page.bodyText()).toContain('历史版本内容'),
    );
    expect(readStoredDraft()).toBeDefined();
  });
});

