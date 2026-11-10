// @vitest-environment jsdom
/**
 * P0 document view integration: autosave, retry, serialization, conflict
 * reconciliation/retention, crash-draft recovery and editor continuity.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceService, Thought } from '@alter/protocol';
import { SpaceContext } from '../vendor/ui-space/src/runtime';
import { AlterDocumentView } from '../src/document/AlterDocumentView';
import {
  DRAFT_FORMAT,
  readDocumentDraft,
  type DocumentDraft,
} from '../src/document/editor/draft';
import { astToTiptap } from '../src/document/editor/mapping';
import { applyOperations as applyHostOperations } from '../host/document/ops.js';
import type { OperationContext } from '../host/document/types.js';
import { SpaceRemoteError } from '../src/space-client';
import type { AlterDoc } from '../src/document/types';
import { htmlToMarkdown } from '../vendor/ui-space/src/utils/markdown';
import {
  DocumentModelUnavailableError,
  convertThoughtToDocument,
  createDocumentFromHtml,
} from '../vendor/ui-space/src/thought-conversion';

// jsdom has no layout engine; ProseMirror's scrollIntoView calls these on both
// elements and text ranges.
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
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8');
}

const initialDoc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 2,
  blocks: [
    {
      id: 'blk_h',
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: '测试文档' }],
    },
    {
      id: 'blk_p',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '编辑器正文' }],
    },
  ],
};

const versionDoc: AlterDoc = {
  ...initialDoc,
  revision: 1,
};

const initialSnapshot = {
  docId: 'doc-ui',
  revision: 2,
  title: 'UI 文档',
  doc: initialDoc,
};

function snapshotOf(doc: AlterDoc, revision = doc.revision) {
  return {
    docId: 'doc-ui',
    revision,
    title: 'UI 文档',
    doc: { ...doc, revision },
  };
}

interface HarnessOptions {
  get?: (docId: string) => Promise<unknown>;
  applyOperations?: (input: unknown) => Promise<unknown>;
  saveNode?: (id: string, patch: unknown) => Promise<unknown>;
}

function makeContext(options: HarnessOptions = {}) {
  const get = vi.fn(options.get ?? (async () => initialSnapshot));
  const applyOperations = vi.fn(
    options.applyOperations ??
      (async () => ({
        docId: 'doc-ui',
        revision: 3,
        changedBlockIds: [],
        diff: {},
        warnings: [],
      })),
  );
  const saveNode = vi.fn(options.saveNode ?? (async () => ({})));
  const client = {
    get,
    applyOperations,
    async restoreVersion() {
      return { docId: 'doc-ui', revision: 3 };
    },
    async read() {
      return { markdown: '# 测试文档\n\n编辑器正文\n', revision: 2 };
    },
  };
  const service = {
    document: client,
    saveNode,
    async listComments() {
      return [
        {
          id: 'cm_1',
          docId: 'doc-ui',
          author: 'me',
          body: '侧栏评论内容',
          quote: null,
          anchor: null,
          status: 'open',
          createdAt: '2026-11-09T00:00:00.000Z',
          resolvedAt: null,
          editedAt: null,
          supplements: [],
        },
      ];
    },
    async listVersions() {
      return [
        {
          id: 'ver_1',
          docId: 'doc-ui',
          title: 'UI 文档',
          content: JSON.stringify(versionDoc),
          author: 'me',
          at: '2026-11-09T00:00:00.000Z',
        },
      ];
    },
    async addComment() {
      return {};
    },
    async resolveComment() {
      return {};
    },
  };
  const value = {
    service,
    router: {},
    spaces: [],
    agents: [],
    space: { id: 'sp-inbox' },
    spaceId: 'sp-inbox',
    nodes: [],
    thoughts: [],
    version: 0,
    refresh() {},
    toast() {},
    openSearch() {},
    openThoughtComposer() {},
    openDirectory() {},
    closeDirectory() {},
    removeSpaceFromState() {},
    addSpaceToState() {},
    addNodeToState() {},
    updateNodeInState() {},
  };
  const node = {
    id: 'doc-ui',
    spaceId: 'sp-inbox',
    kind: 'note',
    title: 'UI 文档',
    parentId: null,
    creator: 'alter',
    pinned: false,
    archived: false,
    archivedBy: null,
    archivedAt: null,
    deletedAt: null,
    deletedRoot: false,
    originalParentId: null,
    unread: false,
    content: JSON.stringify(initialDoc),
    activity: 100,
    activityAt: '2026-11-09T00:00:00.000Z',
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    order: 0,
  };
  return { value, node, client, get, applyOperations, saveNode };
}

function renderView(
  options: HarnessOptions = {},
  nodeOverrides: Record<string, unknown> = {},
) {
  const harness = makeContext(options);
  render(
    createElement(
      SpaceContext.Provider,
      { value: harness.value as never },
      createElement(AlterDocumentView, {
        node: { ...harness.node, ...nodeOverrides } as never,
      }),
    ),
  );
  return harness;
}

function seedDraft(overrides: Partial<DocumentDraft> = {}): DocumentDraft {
  const draft: DocumentDraft = {
    format: DRAFT_FORMAT,
    docId: 'doc-ui',
    title: 'UI 文档',
    editor: astToTiptap(initialDoc),
    baseRevision: 2,
    savedRevision: 2,
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
  localStorage.setItem('alter-space:doc-draft:doc-ui', JSON.stringify(draft));
  return draft;
}

function readDraft(): DocumentDraft | undefined {
  return readDocumentDraft('doc-ui');
}

function draftWithText(text: string, baseRevision = 2): DocumentDraft {
  const draftDoc: AlterDoc = {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: baseRevision,
    blocks: [
      {
        id: 'blk_p',
        type: 'paragraph',
        attrs: {},
        content: [{ type: 'text', text }],
      },
    ],
  };
  return seedDraft({ editor: astToTiptap(draftDoc), baseRevision });
}

/** Click a toolbar action that produces a real editor transaction. */
function insertDivider(): void {
  fireEvent.click(screen.getByRole('button', { name: '插入分割线' }));
}

function dividerCount(): number {
  return document.querySelectorAll('[data-doc-editor="tiptap"] .ProseMirror hr')
    .length;
}

async function waitForEditor(): Promise<void> {
  await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
}

/** Flush React microtasks (load promise chains) while fake timers are active. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advance fake timers and flush the work they trigger. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// ---------------------------------------------------------------------------
// Mount / shell
// ---------------------------------------------------------------------------

describe('AST document UI integration', () => {
  it('mounts the Tiptap editor with the loaded document and no manual save UI', async () => {
    renderView();
    await waitFor(() => {
      expect(screen.getByDisplayValue('UI 文档')).toBeTruthy();
      expect(screen.getByText('编辑器正文')).toBeTruthy();
      expect(document.querySelector('[data-doc-editor="tiptap"]')).toBeTruthy();
    });
    // The P0 experience is autosave-only: no manual save button, no permanent
    // saved/unsaved status and no Document-Operations footer hint.
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(screen.queryByText('未保存')).toBeNull();
    expect(screen.queryByText('已同步')).toBeNull();
    expect(screen.queryByText(/Document Operations/)).toBeNull();
  });

  it('opens the comments/history side panel and loads metadata', async () => {
    renderView();
    await waitForEditor();
    fireEvent.click(screen.getByRole('button', { name: '评论与历史' }));
    await waitFor(() => {
      expect(screen.getByText('侧栏评论内容')).toBeTruthy();
      expect(screen.getByPlaceholderText('写下评论…')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('tab', { name: /历史/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '恢复此版本' })).toBeTruthy();
    });
  });

  it('renders the structured view for any note, regardless of stored content', async () => {
    renderView({}, { content: '<p>旧正文</p>', contentFormat: undefined });
    await waitFor(() => {
      expect(
        document.querySelector('article[data-doc-format="alter-doc/1"]'),
      ).toBeTruthy();
      expect(
        document.querySelector('[data-doc-editor="tiptap"] .ProseMirror'),
      ).toBeTruthy();
      expect(screen.getByText('编辑器正文')).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Autosave lifecycle
// ---------------------------------------------------------------------------

describe('autosave lifecycle', () => {
  it('debounces body edits into one silent save', async () => {
    vi.useFakeTimers();
    const { applyOperations } = renderView();
    await settle();
    expect(screen.getByText('编辑器正文')).toBeTruthy();
    insertDivider();
    await tick(690);
    expect(applyOperations).not.toHaveBeenCalled();
    await tick(30);
    expect(applyOperations).toHaveBeenCalledTimes(1);
    // Success stays silent: no toast/banner/status text.
    expect(screen.queryByText(/已保存/)).toBeNull();
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
    // Further waiting must not produce duplicate requests for the same edit.
    await tick(300);
    expect(applyOperations).toHaveBeenCalledTimes(1);
    expect(dividerCount()).toBe(1);
  });

  it('never calls the Host when nothing changed', async () => {
    vi.useFakeTimers();
    const { applyOperations, saveNode } = renderView();
    await settle();
    await tick(900);
    expect(applyOperations).not.toHaveBeenCalled();
    expect(saveNode).not.toHaveBeenCalled();
  });

  it('shows a retry action on failure and keeps the local input', async () => {
    let attempts = 0;
    const { applyOperations } = renderView({
      applyOperations: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('网络不可用');
        return { docId: 'doc-ui', revision: 3 };
      },
    });
    await waitForEditor();
    insertDivider();
    const retry = await screen.findByRole(
      'button',
      { name: '保存失败，重试' },
      { timeout: 3000 },
    );
    expect(dividerCount()).toBe(1);
    fireEvent.click(retry);
    await waitFor(() => expect(applyOperations).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '保存失败，重试' })).toBeNull(),
    );
    // The edit survived the failed attempt.
    expect(dividerCount()).toBe(1);
  });

  it('serializes saves and queues edits made while a save is in flight', async () => {
    let resolveFirst!: (value: unknown) => void;
    const calls: { baseRevision: number }[] = [];
    const { applyOperations } = renderView({
      applyOperations: (input) => {
        calls.push(input as { baseRevision: number });
        if (calls.length === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ docId: 'doc-ui', revision: 4 });
      },
    });
    await waitForEditor();
    insertDivider();
    await waitFor(() => expect(calls.length).toBe(1), { timeout: 3000 });

    // Keep editing while the first request is pending.
    insertDivider();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls.length).toBe(1);

    resolveFirst({ docId: 'doc-ui', revision: 3 });
    await waitFor(() => expect(calls.length).toBe(2), { timeout: 3000 });
    expect(calls[0]!.baseRevision).toBe(2);
    expect(calls[1]!.baseRevision).toBe(3);
    // Both dividers are still in the editor: the receipt did not overwrite
    // input made during the save.
    expect(dividerCount()).toBe(2);
  });

  it('reconciles a lost-receipt conflict as already saved', async () => {
    let opsInput: { ops: unknown[] } | undefined;
    const operationContext: OperationContext = {
      docId: 'doc-ui',
      nowIso: () => '2026-11-09T12:00:00.000Z',
      createBlockId: () => 'blk_gen',
      parseMarkdown: () => {
        throw new Error('unused');
      },
      createObject: () => {
        throw new Error('unused');
      },
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockImplementation(async () => {
        // Rebuild what the Host would have stored for the batch the client
        // just tried to apply (as if the receipt had been lost).
        if (opsInput === undefined) throw new Error('missing operations');
        const result = applyHostOperations(
          initialDoc,
          opsInput.ops as never,
          operationContext,
        );
        return snapshotOf({ ...result.doc, revision: 3 }, 3);
      });
    const { applyOperations } = renderView({
      get,
      applyOperations: async (input) => {
        opsInput = input as { ops: unknown[] };
        expect(opsInput.ops.length).toBeGreaterThan(0);
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      },
    });
    await waitForEditor();
    insertDivider();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    // The Host already has the intended content: no conflict banner, the view
    // adopts the Host revision and the draft is cleared.
    expect(
      screen.queryByRole('button', { name: '保留本地草稿并重新加载' }),
    ).toBeNull();
    await waitFor(() => expect(screen.getByText('revision 3')).toBeTruthy());
    expect(readDraft()).toBeUndefined();
  });

  it('keeps local content on an unresolved conflict and offers both paths', async () => {
    const serverDoc: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 5,
      blocks: [
        {
          id: 'blk_other',
          type: 'paragraph',
          attrs: {},
          content: [{ type: 'text', text: '服务端新内容' }],
        },
      ],
    };
    let conflict = true;
    const get = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValue(snapshotOf(serverDoc, 5));
    const { applyOperations } = renderView({
      get,
      applyOperations: async () => {
        if (conflict) throw new SpaceRemoteError('doc/conflict', '文档已被修改');
        return { docId: 'doc-ui', revision: 6 };
      },
    });
    await waitForEditor();
    insertDivider();
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: '保留本地草稿并重新加载' }),
        ).toBeTruthy(),
      { timeout: 3000 },
    );
    // The local content is still in the editor and persisted as a draft.
    expect(dividerCount()).toBe(1);
    expect(readDraft()).toBeDefined();

    conflict = false;
    fireEvent.click(screen.getByRole('button', { name: '丢弃草稿' }));
    await waitFor(() => {
      expect(screen.getByText('服务端新内容')).toBeTruthy();
      expect(screen.queryByText('编辑器正文')).toBeNull();
    });
    expect(readDraft()).toBeUndefined();
  });

  it('retries local content against the latest revision when kept', async () => {
    const serverDoc: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 5,
      blocks: [
        {
          id: 'blk_other',
          type: 'paragraph',
          attrs: {},
          content: [{ type: 'text', text: '服务端新内容' }],
        },
      ],
    };
    const calls: { baseRevision: number }[] = [];
    let conflict = true;
    const get = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValue(snapshotOf(serverDoc, 5));
    renderView({
      get,
      applyOperations: async (input) => {
        calls.push(input as { baseRevision: number });
        if (conflict) {
          conflict = false;
          throw new SpaceRemoteError('doc/conflict', '文档已被修改');
        }
        return { docId: 'doc-ui', revision: 6 };
      },
    });
    await waitForEditor();
    insertDivider();
    const keep = await screen.findByRole(
      'button',
      { name: '保留本地草稿并重新加载' },
      { timeout: 3000 },
    );
    fireEvent.click(keep);
    await waitFor(() => expect(calls.length).toBe(2), { timeout: 3000 });
    expect(calls[1]!.baseRevision).toBe(5);
    // Local content wins: the divider is still there after the retry.
    expect(dividerCount()).toBe(1);
  });

  it('autosaves the title through saveNode without a visible success status', async () => {
    vi.useFakeTimers();
    const { saveNode } = renderView();
    await settle();
    fireEvent.change(screen.getByLabelText('文档标题'), {
      target: { value: '新标题' },
    });
    await tick(690);
    expect(saveNode).not.toHaveBeenCalled();
    await tick(30);
    await settle();
    expect(saveNode).toHaveBeenCalledWith('doc-ui', { title: '新标题' });
    expect(screen.queryByText(/已保存/)).toBeNull();
  });

  it('flushes immediately on Cmd/Ctrl+S', async () => {
    const { applyOperations } = renderView();
    await waitForEditor();
    insertDivider();
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(applyOperations).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
  });

  it('flushes when the page becomes hidden', async () => {
    const { applyOperations } = renderView();
    await waitForEditor();
    insertDivider();
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
      await waitFor(() => expect(applyOperations).toHaveBeenCalledTimes(1), {
        timeout: 1000,
      });
    } finally {
      if (visibility === undefined) {
        delete (document as unknown as { visibilityState?: string })
          .visibilityState;
      } else {
        Object.defineProperty(document, 'visibilityState', visibility);
      }
    }
  });

  it('warns before unload while edits are pending and keeps a draft', async () => {
    const { applyOperations } = renderView();
    await waitForEditor();
    insertDivider();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(readDraft()).toBeDefined();
    await waitFor(() => expect(applyOperations).toHaveBeenCalled(), {
      timeout: 1000,
    });
  });

  it('writes a crash draft when the view unmounts before the debounce', async () => {
    const { applyOperations } = renderView();
    await waitForEditor();
    insertDivider();
    cleanup();
    const draft = readDraft();
    expect(draft).toBeDefined();
    expect(draft!.baseRevision).toBe(2);
    expect(draft!.editor).toBeTruthy();
    // The unmount also fires one last save attempt (fire and forget).
    await waitFor(() => expect(applyOperations).toHaveBeenCalled(), {
      timeout: 1000,
    });
  });
});

// ---------------------------------------------------------------------------
// Crash-draft recovery
// ---------------------------------------------------------------------------

describe('crash draft recovery', () => {
  it('offers restore/discard and restores the draft content', async () => {
    draftWithText('草稿正文');
    const { applyOperations } = renderView();
    await waitFor(() =>
      expect(screen.getByText(/检测到未保存草稿/)).toBeTruthy(),
    );
    // The surface stays on the server snapshot until the user chooses.
    expect(screen.queryByText('草稿正文')).toBeNull();
    expect(
      (screen.getByLabelText('文档标题') as HTMLInputElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(screen.getByText('草稿正文')).toBeTruthy());
    await waitFor(() => expect(applyOperations).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    const input = applyOperations.mock.calls[0]![0] as { baseRevision: number };
    expect(input.baseRevision).toBe(2);
    expect(readDraft()).toBeUndefined();
  });

  it('discards a same-revision draft and keeps the server snapshot', async () => {
    draftWithText('草稿正文');
    renderView();
    await waitFor(() =>
      expect(screen.getByText(/检测到未保存草稿/)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: '丢弃' }));
    await waitFor(() =>
      expect(screen.queryByText(/检测到未保存草稿/)).toBeNull(),
    );
    expect(screen.getByText('编辑器正文')).toBeTruthy();
    expect(readDraft()).toBeUndefined();
  });

  it('surfaces a conflicting draft with keep/reload and discard actions', async () => {
    draftWithText('旧草稿正文', 1);
    const { get } = renderView();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '保留本地草稿并重新加载' }),
      ).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: '丢弃草稿' })).toBeTruthy();
    expect(readDraft()).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '丢弃草稿' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/检测到未保存草稿/)).toBeNull());
    expect(screen.getByText('编辑器正文')).toBeTruthy();
    expect(readDraft()).toBeUndefined();
  });

  it('keeps the local draft and saves it over the reloaded revision', async () => {
    draftWithText('旧草稿正文', 1);
    const latestDoc: AlterDoc = {
      ...initialDoc,
      revision: 4,
      blocks: [
        {
          id: 'blk_new',
          type: 'paragraph',
          attrs: {},
          content: [{ type: 'text', text: '服务端新内容' }],
        },
      ],
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValue(snapshotOf(latestDoc, 4));
    const { applyOperations } = renderView({ get });
    const keep = await screen.findByRole(
      'button',
      { name: '保留本地草稿并重新加载' },
      { timeout: 3000 },
    );
    fireEvent.click(keep);
    await waitFor(() => expect(screen.getByText('旧草稿正文')).toBeTruthy(), {
      timeout: 3000,
    });
    await waitFor(() => expect(applyOperations).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    const input = applyOperations.mock.calls[0]![0] as { baseRevision: number };
    expect(input.baseRevision).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Editor continuity
// ---------------------------------------------------------------------------

describe('editor continuity', () => {
  it('keeps the same editor instance and undo history across an autosave', async () => {
    const { applyOperations } = renderView();
    await waitForEditor();
    const surface = document.querySelector(
      '[data-doc-editor="tiptap"] .ProseMirror',
    );
    expect(surface).toBeTruthy();

    insertDivider();
    await waitFor(() => expect(applyOperations).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    await waitFor(() => expect(screen.getByText('revision 3')).toBeTruthy());

    // The save echo updates the snapshot but must not recreate the surface
    // (a revision-keyed editor used to remount and drop the undo history).
    expect(
      document.querySelector('[data-doc-editor="tiptap"] .ProseMirror'),
    ).toBe(surface);
    expect(
      (screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Static wiring / conversions (unchanged contracts)
// ---------------------------------------------------------------------------

describe('document view wiring', () => {
  it('routes every vendored document view through the structured component', () => {
    for (const file of [
      'vendor/ui-space/src/SpaceApp.tsx',
      'vendor/ui-space/src/SpaceWorkbench.tsx',
    ]) {
      const text = source(file);
      expect(text).toContain("from '@alter-space/document-view'");
      expect(text).not.toContain('views/DocumentView');
    }
    const spaceApp = source('vendor/ui-space/src/SpaceApp.tsx');
    expect(spaceApp).toContain('<DocumentView key={node.id} node={node} />');
    expect(source('vendor/ui-space/src/SpaceWorkbench.tsx')).not.toContain(
      'embedded',
    );
  });

  it('has no adaptive document view and no build-time override', () => {
    expect(
      existsSync(path.join(root, 'src', 'document', 'adaptive-document-view.tsx')),
    ).toBe(false);
    expect(
      existsSync(path.join(root, 'build', 'document-view-override.mjs')),
    ).toBe(false);
    const build = source('build/build.mjs');
    expect(build).toContain('@alter-space\\/document-view');
    expect(build).not.toContain('document-view-override');
    const tsconfig = JSON.parse(source('tsconfig.json')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(
      tsconfig.compilerOptions.paths['@alter-space/document-view'],
    ).toEqual(['src/document/AlterDocumentView.tsx']);
  });
});

describe('thought → document conversion', () => {
  it('converts rich-text editor output to Markdown', () => {
    expect(
      htmlToMarkdown(
        '<p>想法一</p><p><strong>重点</strong> 与 <a href="https://example.com">链接</a></p>',
      ),
    ).toBe('想法一\n\n**重点** 与 [链接](https://example.com)');
  });

  it('creates an empty AST note, then fills it through the document model', async () => {
    const events: string[] = [];
    const createNode = vi.fn(async () => {
      events.push('createNode');
      return { id: 'doc-new' };
    });
    const generate = vi.fn(async () => {
      events.push('generate');
      return {};
    });
    const service = {
      createNode,
      document: { generate },
    } as unknown as SpaceService;

    const node = await createDocumentFromHtml(service, {
      spaceId: 'sp-1',
      html: '<p>草稿正文</p>',
    });

    expect(node.id).toBe('doc-new');
    expect(createNode).toHaveBeenCalledWith({ spaceId: 'sp-1', kind: 'note' });
    expect(generate).toHaveBeenCalledWith({
      docId: 'doc-new',
      markdown: '草稿正文',
    });
    expect(events).toEqual(['createNode', 'generate']);
  });

  it('converts a thought through the document model with its content', async () => {
    const convertThought = vi.fn(async () => ({ node: { id: 'doc-conv' } }));
    const generate = vi.fn(async () => ({}));
    const service = {
      convertThought,
      document: { generate },
    } as unknown as SpaceService;
    const thought = {
      id: 'th-1',
      spaceId: 'sp-1',
      content: '<p>随想内容</p>',
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    } as Thought;

    const node = await convertThoughtToDocument(service, thought);

    expect(node.id).toBe('doc-conv');
    expect(convertThought).toHaveBeenCalledWith('th-1');
    expect(generate).toHaveBeenCalledWith({
      docId: 'doc-conv',
      markdown: '随想内容',
    });
  });

  it('surfaces a visible error when the document model is not attached', async () => {
    const service = {} as unknown as SpaceService;
    await expect(
      createDocumentFromHtml(service, { spaceId: 'sp-1', html: '<p>x</p>' }),
    ).rejects.toBeInstanceOf(DocumentModelUnavailableError);
    await expect(
      convertThoughtToDocument(service, {
        id: 'th-1',
        content: '<p>x</p>',
      } as Thought),
    ).rejects.toThrow('文档模型客户端未装配');
  });
});
