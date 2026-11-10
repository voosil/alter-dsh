/**
 * P0 save lifecycle: draft persistence, autosave scheduling and the save
 * pipeline (debounce, single flight, retry, conflict reconciliation, idempotent
 * retry, oversized diffs, large single-batch saves).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_DEBOUNCE_MS,
  DRAFT_WRITE_INTERVAL_MS,
  createAutosaveController,
  createDocumentSaver,
  readSnapshot,
  type AutosaveStatus,
  type SaveOutcome,
} from '../src/document/editor/autosave';
import {
  DRAFT_FORMAT,
  clearDocumentDraft,
  documentDraftMatchesSnapshot,
  parseDocumentDraft,
  readDocumentDraft,
  writeDocumentDraft,
  type DocumentDraft,
} from '../src/document/editor/draft';
import { DocumentDiffError } from '../src/document/editor/operations';
import { astToTiptap, tiptapToBlocks } from '../src/document/editor/mapping';
import { SpaceRemoteError } from '../src/space-client';
import type { AlterDoc, BlockNode } from '../src/document/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseDoc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 2,
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
      content: [{ type: 'text', text: '正文' }],
    },
  ],
};

function paragraph(id: string, text: string): BlockNode {
  return { id, type: 'paragraph', attrs: {}, content: [{ type: 'text', text }] };
}

function docWithBlocks(blocks: BlockNode[], revision = 2): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision, blocks };
}

function makeDraft(overrides: Partial<DocumentDraft> = {}): DocumentDraft {
  return {
    format: DRAFT_FORMAT,
    docId: 'doc-1',
    title: '标题',
    editor: astToTiptap(baseDoc),
    baseRevision: 2,
    savedRevision: 2,
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
}

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Draft persistence
// ---------------------------------------------------------------------------

describe('document drafts', () => {
  it('round-trips a draft through storage keyed by document id', () => {
    const storage = new MemoryStorage();
    const draft = makeDraft();
    writeDocumentDraft(draft, storage);
    expect(storage.getItem('alter-space:doc-draft:doc-1')).not.toBeNull();
    expect(readDocumentDraft('doc-1', storage)).toEqual(draft);
    clearDocumentDraft('doc-1', storage);
    expect(readDocumentDraft('doc-1', storage)).toBeUndefined();
  });

  it('rejects foreign formats and mismatched document ids', () => {
    expect(parseDocumentDraft({ ...makeDraft(), format: 'other/1' })).toBeUndefined();
    expect(parseDocumentDraft({ ...makeDraft(), docId: '' })).toBeUndefined();
    expect(parseDocumentDraft({ ...makeDraft(), baseRevision: -1 })).toBeUndefined();
    expect(parseDocumentDraft(null)).toBeUndefined();
    const storage = new MemoryStorage();
    writeDocumentDraft(makeDraft(), storage);
    expect(readDocumentDraft('doc-2', storage)).toBeUndefined();
    storage.setItem('alter-space:doc-draft:doc-1', '{not json');
    expect(readDocumentDraft('doc-1', storage)).toBeUndefined();
  });

  it('is a no-op when localStorage is unavailable', () => {
    expect(readDocumentDraft('doc-1', undefined)).toBeUndefined();
    expect(() => writeDocumentDraft(makeDraft(), undefined)).not.toThrow();
    expect(() => clearDocumentDraft('doc-1', undefined)).not.toThrow();
  });

  it('detects when the draft already matches the server snapshot', () => {
    const draft = makeDraft();
    expect(
      documentDraftMatchesSnapshot(draft, { doc: baseDoc, title: '标题' }),
    ).toBe(true);
    expect(
      documentDraftMatchesSnapshot(draft, { ...baseDoc, blocks: [paragraph('blk_x', 'x')] }),
    ).toBe(false);
    expect(documentDraftMatchesSnapshot(draft, { doc: baseDoc, title: '别的标题' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Autosave controller
// ---------------------------------------------------------------------------

interface ControllerHarness {
  controller: ReturnType<typeof createAutosaveController>;
  save: ReturnType<typeof vi.fn>;
  writes: DocumentDraft[];
  statuses: AutosaveStatus[];
  cleared: ReturnType<typeof vi.fn>;
}

function makeController(
  save: () => Promise<SaveOutcome> = async () => ({ kind: 'saved', revision: 3 }),
): ControllerHarness {
  const writes: DocumentDraft[] = [];
  const statuses: AutosaveStatus[] = [];
  const cleared = vi.fn();
  const saveMock = vi.fn(save);
  const controller = createAutosaveController({
    captureDraft: () => ({
      format: DRAFT_FORMAT,
      docId: 'doc-1',
      title: '标题',
      editor: astToTiptap(baseDoc),
      baseRevision: 2,
      savedRevision: 2,
    }),
    writeDraft: (draft) => writes.push(draft),
    clearDraft: () => cleared(),
    save: saveMock,
    onStatus: (status) => statuses.push(status),
  });
  return { controller, save: saveMock, writes, statuses, cleared };
}

describe('autosave controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('debounces edits into exactly one save', async () => {
    const harness = makeController();
    harness.controller.notifyChange();
    await vi.advanceTimersByTimeAsync(300);
    harness.controller.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 10);
    expect(harness.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(harness.save).toHaveBeenCalledTimes(1);
    await harness.controller.flush();
    expect(harness.save).toHaveBeenCalledTimes(1);
  });

  it('never calls the Host when nothing changed', async () => {
    const harness = makeController();
    await harness.controller.flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 3);
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.statuses).toEqual([]);
  });

  it('serializes saves and queues edits made while a save is in flight', async () => {
    const first = deferred<SaveOutcome>();
    const harness = makeController();
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    harness.save.mockImplementation(async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (calls === 1) return await first.promise;
        return { kind: 'saved', revision: 4 };
      } finally {
        concurrent -= 1;
      }
    });

    harness.controller.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(harness.save).toHaveBeenCalledTimes(1);

    // Typing while the request is in flight must not start a second request...
    harness.controller.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(harness.save).toHaveBeenCalledTimes(1);

    // ...but it must be saved right after the receipt arrives.
    first.resolve({ kind: 'saved', revision: 3 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(harness.save).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
  });

  it('keeps the draft, exposes a retry and does not hammer a failed Host', async () => {
    const harness = makeController(async () => ({
      kind: 'failed',
      message: '保存失败：网络错误',
    }));
    harness.controller.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(harness.statuses.at(-1)).toEqual({
      kind: 'failed',
      message: '保存失败：网络错误',
    });
    expect(harness.writes.length).toBeGreaterThan(0);
    expect(harness.cleared).not.toHaveBeenCalled();

    // No automatic retry loop while the Host is down.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 5);
    expect(harness.save).toHaveBeenCalledTimes(1);

    harness.save.mockResolvedValue({ kind: 'saved', revision: 3 });
    await harness.controller.retry();
    expect(harness.save).toHaveBeenCalledTimes(2);
    expect(harness.cleared).toHaveBeenCalled();
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
  });

  it('blocks automatic saves after a conflict until retried', async () => {
    const harness = makeController(async () => ({
      kind: 'conflict',
      message: '冲突',
      serverRevision: 5,
    }));
    harness.controller.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(harness.statuses.at(-1)?.kind).toBe('conflict');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 5);
    expect(harness.save).toHaveBeenCalledTimes(1);

    harness.save.mockResolvedValue({ kind: 'saved', revision: 6 });
    await harness.controller.retry();
    expect(harness.save).toHaveBeenCalledTimes(2);
    expect(harness.cleared).toHaveBeenCalled();
  });

  it('throttles draft writes while typing', async () => {
    const harness = makeController();
    harness.controller.notifyChange();
    expect(harness.writes).toHaveLength(1);
    // Many keystrokes inside the throttle window collapse into no extra write.
    for (let index = 0; index < 5; index += 1) {
      harness.controller.notifyChange();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(harness.writes).toHaveLength(1);
    expect(DRAFT_WRITE_INTERVAL_MS).toBeGreaterThanOrEqual(500);
  });

  it('writes a draft synchronously and fires a last save on dispose', async () => {
    const harness = makeController();
    harness.controller.notifyChange();
    const writesBeforeDispose = harness.writes.length;
    harness.controller.dispose();
    expect(harness.writes.length).toBe(writesBeforeDispose + 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.save).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft when unmounting while an older save is in flight', async () => {
    let resolveSave: ((outcome: SaveOutcome) => void) | undefined;
    const harness = makeController(
      () =>
        new Promise<SaveOutcome>((resolve) => {
          resolveSave = resolve;
        }),
    );
    harness.controller.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(harness.save).toHaveBeenCalledTimes(1);

    // A newer edit lands while the request is in flight, then the editor
    // unmounts (document switch / panel close).
    harness.controller.notifyChange();
    const writesBeforeDispose = harness.writes.length;
    harness.controller.dispose();
    expect(harness.writes.length).toBe(writesBeforeDispose + 1);

    // The in-flight receipt is older than that draft: it must not erase it.
    resolveSave?.({ kind: 'saved', revision: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.cleared).not.toHaveBeenCalled();
  });

  it('clears the draft when the saved content equals the baseline', async () => {
    const harness = makeController(async () => ({ kind: 'skipped' }));
    harness.controller.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(harness.cleared).toHaveBeenCalled();
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
  });

  it('flushes immediately (Cmd/Ctrl+S)', async () => {
    const harness = makeController();
    harness.controller.notifyChange();
    await harness.controller.flush();
    expect(harness.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(harness.save).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Save pipeline
// ---------------------------------------------------------------------------

interface SaverHarness {
  saver: ReturnType<typeof createDocumentSaver>;
  applyOperations: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  onSaved: ReturnType<typeof vi.fn>;
  saveTitle: ReturnType<typeof vi.fn>;
  setEditorDoc: (doc: AlterDoc) => void;
  setTitle: (title: string) => void;
}

function makeSaver(options: {
  initialDoc?: AlterDoc;
  initialTitle?: string;
  applyOperations?: (input: unknown) => Promise<unknown>;
  get?: () => Promise<unknown>;
  saveTitle?: (title: string) => Promise<unknown>;
  computeOps?: (oldDoc: AlterDoc, newDoc: AlterDoc) => never;
} = {}): SaverHarness {
  let editorJson = astToTiptap(options.initialDoc ?? baseDoc);
  let title = options.initialTitle ?? '标题';
  const applyOperations = vi.fn(
    options.applyOperations ?? (async () => ({ revision: 3 })),
  );
  const get = vi.fn(options.get ?? (async () => ({
    docId: 'doc-1',
    revision: 2,
    title: '标题',
    doc: baseDoc,
  })));
  const onSaved = vi.fn();
  const saveTitle = vi.fn(options.saveTitle ?? (async () => undefined));
  const saver = createDocumentSaver({
    docId: 'doc-1',
    client: { get, applyOperations } as never,
    initialDoc: options.initialDoc ?? baseDoc,
    baseRevision: 2,
    initialTitle: options.initialTitle ?? '标题',
    getEditorJson: () => editorJson,
    getTitle: () => title,
    saveTitle,
    onSaved,
    ...(options.computeOps === undefined
      ? {}
      : { computeOps: options.computeOps as never }),
  });
  return {
    saver,
    applyOperations,
    get,
    onSaved,
    saveTitle,
    setEditorDoc: (doc) => {
      editorJson = astToTiptap(doc);
    },
    setTitle: (next) => {
      title = next;
    },
  };
}

describe('document saver', () => {
  it('skips the Host when the editor equals the saved baseline', async () => {
    const harness = makeSaver();
    await expect(harness.saver.save()).resolves.toEqual({ kind: 'skipped' });
    expect(harness.applyOperations).not.toHaveBeenCalled();
    expect(harness.saveTitle).not.toHaveBeenCalled();
  });

  it('saves a body edit as one operation batch with the CAS base', async () => {
    const harness = makeSaver();
    const edited = docWithBlocks([
      baseDoc.blocks[0]!,
      paragraph('blk_p', '正文改'),
    ]);
    harness.setEditorDoc(edited);
    await expect(harness.saver.save()).resolves.toEqual({
      kind: 'saved',
      revision: 3,
    });
    const input = harness.applyOperations.mock.calls[0]![0] as {
      baseRevision: number;
      idempotencyKey?: string;
      ops: unknown[];
    };
    expect(input.baseRevision).toBe(2);
    expect(input.idempotencyKey).toBeTruthy();
    expect(input.ops.length).toBeGreaterThan(0);
    expect(harness.onSaved).toHaveBeenCalledWith(3, expect.anything(), '标题');
    expect(harness.saver.context()).toEqual({ baseRevision: 3, savedRevision: 3 });
  });

  it('saves the title through saveNode before the body', async () => {
    const harness = makeSaver();
    harness.setTitle('  新标题  ');
    await expect(harness.saver.save()).resolves.toEqual({
      kind: 'saved',
      revision: 2,
    });
    expect(harness.saveTitle).toHaveBeenCalledWith('新标题');
    expect(harness.applyOperations).not.toHaveBeenCalled();
    expect(harness.onSaved).toHaveBeenCalledWith(2, expect.anything(), '新标题');
  });

  it('reports a readable failure when the title write fails', async () => {
    const harness = makeSaver({
      saveTitle: async () => {
        throw new Error('网络不可用');
      },
    });
    harness.setTitle('新标题');
    const outcome = await harness.saver.save();
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.message).toContain('标题保存失败');
    }
    expect(harness.applyOperations).not.toHaveBeenCalled();
  });

  it('reuses the idempotency key across a network retry', async () => {
    const harness = makeSaver({
      applyOperations: async () => {
        throw new Error('connection reset');
      },
    });
    harness.setEditorDoc(docWithBlocks([paragraph('blk_p', '正文改')]));
    const first = await harness.saver.save();
    expect(first.kind).toBe('failed');
    const second = await harness.saver.save();
    expect(second.kind).toBe('failed');
    const keys = harness.applyOperations.mock.calls.map(
      (call) => (call[0] as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });

  it('reconciles a conflict when the Host already has the intended content', async () => {
    const edited = docWithBlocks([
      baseDoc.blocks[0]!,
      paragraph('blk_p', '正文改'),
    ]);
    const harness = makeSaver({
      applyOperations: async () => {
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      },
      get: async () => ({
        docId: 'doc-1',
        revision: 5,
        title: '标题',
        doc: { ...edited, revision: 5 },
      }),
    });
    harness.setEditorDoc(edited);
    await expect(harness.saver.save()).resolves.toEqual({
      kind: 'saved',
      revision: 5,
    });
    expect(harness.get).toHaveBeenCalledWith('doc-1');
    expect(harness.onSaved).toHaveBeenCalledWith(5, expect.anything(), '标题');
    expect(harness.saver.context()).toEqual({ baseRevision: 5, savedRevision: 5 });
  });

  it('keeps the local content as a conflict when the Host changed', async () => {
    const harness = makeSaver({
      applyOperations: async () => {
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      },
      get: async () => ({
        docId: 'doc-1',
        revision: 6,
        title: '标题',
        doc: docWithBlocks([paragraph('blk_other', '服务端新内容')], 6),
      }),
    });
    harness.setEditorDoc(docWithBlocks([paragraph('blk_p', '本地内容')]));
    const outcome = await harness.saver.save();
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind === 'conflict') {
      expect(outcome.serverRevision).toBe(6);
    }
    expect(harness.onSaved).not.toHaveBeenCalled();
    expect(harness.saver.context().baseRevision).toBe(2);
  });

  it('surfaces an oversized diff as a readable failure', async () => {
    const harness = makeSaver({
      computeOps: () => {
        throw new DocumentDiffError(
          '变更过大：需要 9000 个操作，超过单次上限 8192。请分批保存后再试。',
        );
      },
    });
    harness.setEditorDoc(docWithBlocks([paragraph('blk_p', '正文改')]));
    const outcome = await harness.saver.save();
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.message).toContain('变更过大');
    }
    expect(harness.applyOperations).not.toHaveBeenCalled();
  });

  it('saves a select-all replacement of 64 blocks in one batch', async () => {
    const blocks = Array.from({ length: 64 }, (_, index) =>
      paragraph(`blk_${index}`, `原文 ${index}`),
    );
    const base = docWithBlocks(blocks);
    const edited = docWithBlocks(
      blocks.map((_, index) => paragraph(`blk_${index}`, `替换 ${index}`)),
    );
    const harness = makeSaver({
      initialDoc: base,
      applyOperations: async () => ({ revision: 3 }),
    });
    harness.setEditorDoc(edited);
    await expect(harness.saver.save()).resolves.toEqual({
      kind: 'saved',
      revision: 3,
    });
    expect(harness.applyOperations).toHaveBeenCalledTimes(1);
    const input = harness.applyOperations.mock.calls[0]![0] as { ops: unknown[] };
    // One replace per changed top-level block, all in a single batch.
    expect(input.ops.length).toBe(64);
    expect(input.ops.length).toBeLessThanOrEqual(8_192);
  });

  it('validates Host snapshots defensively', () => {
    expect(readSnapshot({ revision: 2, doc: baseDoc })?.revision).toBe(2);
    expect(readSnapshot({ revision: 2, doc: { format: 'x', blocks: [] } })).toBeUndefined();
    expect(readSnapshot(null)).toBeUndefined();
    // The intended content projection keeps block ids stable.
    const blocks = tiptapToBlocks(astToTiptap(baseDoc));
    expect(blocks.map((block) => block.id)).toEqual(['blk_h', 'blk_p']);
  });
});
