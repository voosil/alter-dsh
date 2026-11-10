/**
 * G4 — fault injection for the editor save pipeline.
 *
 * Each case wires the real save pipeline (`createDocumentSaver` +
 * `createAutosaveController` + localStorage draft) to a *real*
 * `DocumentService` over a temporary SQLite store, then injects one Host fault
 * (network error/timeout, database busy, lost receipt, conflict) and asserts
 * the documented safety contract: local input survives, retries never duplicate
 * a revision or a write, and the recovered draft can still be saved after a
 * Host restart or a version restore.
 *
 * @vitest-environment node
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDocumentService,
  type DocumentService,
} from '../host/document/service.js';
import {
  DEFAULT_SPACE_ID,
  openSpaceStore,
  type SpaceStoreHandle,
} from '../host/store.js';
import {
  createAutosaveController,
  createDocumentSaver,
  type AutosaveStatus,
  type DocumentSaver,
} from '../src/document/editor/autosave';
import {
  DRAFT_FORMAT,
  blocksContentEquivalent,
  clearDocumentDraft,
  draftBlocks,
  readDocumentDraft,
  writeDocumentDraft,
  type DocumentDraft,
} from '../src/document/editor/draft';
import { astToTiptap } from '../src/document/editor/mapping';
import { SpaceRemoteError } from '../src/space-client';
import type { AlterDoc } from '../src/document/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixedNow = () => new Date('2026-11-10T00:00:00.000Z');
const dirs: string[] = [];
const stores: SpaceStoreHandle[] = [];

beforeEach(() => {
  // The autosave debounce must never fire behind a test's back; saves are
  // driven explicitly through flush()/retry().
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** In-memory localStorage substitute; the draft module takes it explicitly. */
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

function paragraphDoc(
  text: string,
  id = 'blk_p',
  revision = 1,
): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision,
    blocks: [
      {
        id,
        type: 'paragraph',
        attrs: {},
        content: [{ type: 'text', text }],
      },
    ],
  };
}

async function tempStore(): Promise<SpaceStoreHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-fault-'));
  dirs.push(dir);
  const store = await openSpaceStore({ directory: dir, now: fixedNow });
  stores.push(store);
  return store;
}

async function createDocument(
  service: DocumentService,
  text = '原始内容',
): Promise<{ docId: string; doc: AlterDoc }> {
  const generated = await service.generate({
    spaceId: DEFAULT_SPACE_ID,
    markdown: `${text}\n`,
  });
  const snapshot = await service.get(generated.docId);
  return { docId: generated.docId, doc: snapshot.doc };
}

function blockText(doc: AlterDoc): string {
  const block = doc.blocks[0];
  if (block?.content === undefined) return '';
  return block.content
    .map((inline) => (inline.type === 'text' ? inline.text : '\n'))
    .join('');
}

// ---------------------------------------------------------------------------
// Fault-injecting Host client harness
// ---------------------------------------------------------------------------

type FaultMode =
  | 'none'
  | 'network'
  | 'timeout'
  | 'busy'
  | 'lost-receipt'
  | 'conflict';

interface HarnessOptions {
  service: DocumentService;
  docId: string;
  /** Host snapshot the editor session starts from (the CAS base). */
  initialDoc: AlterDoc;
  initialTitle?: string;
  /** Content currently in the editor. */
  editorDoc: AlterDoc;
  storage: Storage;
  /** Mutable fault selector; tests flip it between attempts. */
  fault: () => FaultMode;
}

interface Harness {
  saver: DocumentSaver;
  controller: ReturnType<typeof createAutosaveController>;
  statuses: AutosaveStatus[];
  calls: Array<{ baseRevision: number; idempotencyKey?: string }>;
  applyOperations: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  onSaved: ReturnType<typeof vi.fn>;
}

function makeHarness(options: HarnessOptions): Harness {
  let editorJson = astToTiptap(options.editorDoc);
  const title = options.initialTitle ?? '故障文档';
  const calls: Harness['calls'] = [];

  const applyOperations = vi.fn(
    async (input: {
      docId: string;
      baseRevision: number;
      ops: unknown[];
      dryRun?: boolean;
      idempotencyKey?: string;
    }) => {
      calls.push({
        baseRevision: input.baseRevision,
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
      });
      const mode = options.fault();
      if (mode === 'network') throw new Error('network error: connection reset');
      if (mode === 'timeout') throw new Error('request timed out after 10s');
      if (mode === 'busy') throw new Error('SQLITE_BUSY: database is locked');
      if (mode === 'conflict')
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      if (mode === 'lost-receipt') {
        // The Host commits, then the response is lost on the way back.
        await options.service.applyOperations({
          docId: input.docId,
          baseRevision: input.baseRevision,
          ops: input.ops as never,
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        });
        throw new Error('connection reset by peer (receipt lost)');
      }
      return options.service.applyOperations({
        docId: input.docId,
        baseRevision: input.baseRevision,
        ops: input.ops as never,
        ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
      });
    },
  );
  const get = vi.fn(async (docId: string) => options.service.get(docId));
  const onSaved = vi.fn();

  const saver = createDocumentSaver({
    docId: options.docId,
    client: { get, applyOperations } as never,
    initialDoc: options.initialDoc,
    baseRevision: options.initialDoc.revision,
    initialTitle: title,
    getEditorJson: () => editorJson,
    getTitle: () => title,
    onSaved,
  });

  const statuses: AutosaveStatus[] = [];
  const controller = createAutosaveController({
    captureDraft: () => ({
      format: DRAFT_FORMAT,
      docId: options.docId,
      title,
      editor: editorJson,
      baseRevision: saver.context().baseRevision,
      savedRevision: saver.context().savedRevision,
    }),
    writeDraft: (draft: DocumentDraft) =>
      writeDocumentDraft(draft, options.storage),
    clearDraft: () => clearDocumentDraft(options.docId, options.storage),
    save: () => saver.save(),
    onStatus: (status) => statuses.push(status),
  });

  return {
    saver,
    controller,
    statuses,
    calls,
    applyOperations,
    get,
    onSaved,
  };
}

function readDraft(storage: Storage, docId: string): DocumentDraft | undefined {
  return readDocumentDraft(docId, storage);
}

function draftText(draft: DocumentDraft | undefined): string {
  if (draft === undefined) return '';
  const blocks = draftBlocks(draft);
  if (blocks === undefined) return '';
  return blockText({
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: draft.baseRevision,
    blocks,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('G4 save fault injection', () => {
  it('keeps the draft and retries after network failures without duplicate revisions', async () => {
    const store = await tempStore();
    const service = createDocumentService({ store, now: fixedNow });
    const { docId, doc } = await createDocument(service);
    const storage = new MemoryStorage();
    const fault = { mode: 'network' as FaultMode };
    const edited = paragraphDoc('网络重试后内容');
    const harness = makeHarness({
      service,
      docId,
      initialDoc: doc,
      editorDoc: edited,
      storage,
      fault: () => fault.mode,
    });

    harness.controller.notifyChange();
    await harness.controller.flush();
    expect(harness.statuses.at(-1)?.kind).toBe('failed');
    // Local input is preserved as a draft; the Host is untouched.
    expect(draftText(readDraft(storage, docId))).toBe('网络重试后内容');
    expect((await service.get(docId)).revision).toBe(1);
    expect(store.listDocumentOps(docId)).toHaveLength(0);

    // A timeout on the next attempt behaves the same and still does not write.
    fault.mode = 'timeout';
    await harness.controller.retry();
    expect(harness.statuses.at(-1)?.kind).toBe('failed');
    expect((await service.get(docId)).revision).toBe(1);
    expect(store.listDocumentOps(docId)).toHaveLength(0);

    fault.mode = 'none';
    await harness.controller.retry();
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
    const saved = await service.get(docId);
    expect(saved.revision).toBe(2);
    expect(blockText(saved.doc)).toBe('网络重试后内容');
    expect(readDraft(storage, docId)).toBeUndefined();
    // Exactly one committed batch: retries never duplicated the write.
    expect(store.listDocumentOps(docId)).toHaveLength(1);
    expect(harness.onSaved).toHaveBeenCalledWith(2, expect.anything(), '故障文档');
  });

  it('replays the idempotency key when the write landed but the receipt was lost', async () => {
    const store = await tempStore();
    const service = createDocumentService({ store, now: fixedNow });
    const { docId, doc } = await createDocument(service);
    const storage = new MemoryStorage();
    const fault = { mode: 'lost-receipt' as FaultMode };
    const edited = paragraphDoc('回执丢失的内容');
    const harness = makeHarness({
      service,
      docId,
      initialDoc: doc,
      editorDoc: edited,
      storage,
      fault: () => fault.mode,
    });

    harness.controller.notifyChange();
    await harness.controller.flush();
    expect(harness.statuses.at(-1)?.kind).toBe('failed');
    // The Host did commit revision 2 even though the client saw an error.
    expect((await service.get(docId)).revision).toBe(2);
    expect(store.listDocumentOps(docId)).toHaveLength(1);
    expect(draftText(readDraft(storage, docId))).toBe('回执丢失的内容');

    fault.mode = 'none';
    await harness.controller.retry();
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
    const saved = await service.get(docId);
    // Idempotent replay: no second revision, no duplicate content.
    expect(saved.revision).toBe(2);
    expect(blockText(saved.doc)).toBe('回执丢失的内容');
    expect(store.listDocumentOps(docId)).toHaveLength(1);
    expect(readDraft(storage, docId)).toBeUndefined();
    const keys = harness.calls.map((call) => call.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(new Set(keys).size).toBe(1);
  });

  it('retains the draft while the database is busy and saves once on retry', async () => {
    const store = await tempStore();
    const service = createDocumentService({ store, now: fixedNow });
    const { docId, doc } = await createDocument(service);
    const storage = new MemoryStorage();
    const fault = { mode: 'busy' as FaultMode };
    const harness = makeHarness({
      service,
      docId,
      initialDoc: doc,
      editorDoc: paragraphDoc('数据库忙时的内容'),
      storage,
      fault: () => fault.mode,
    });

    harness.controller.notifyChange();
    await harness.controller.flush();
    expect(harness.statuses.at(-1)?.kind).toBe('failed');
    await harness.controller.retry();
    expect(harness.statuses.at(-1)?.kind).toBe('failed');
    expect(draftText(readDraft(storage, docId))).toBe('数据库忙时的内容');
    expect((await service.get(docId)).revision).toBe(1);

    fault.mode = 'none';
    await harness.controller.retry();
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
    const saved = await service.get(docId);
    expect(saved.revision).toBe(2);
    expect(blockText(saved.doc)).toBe('数据库忙时的内容');
    expect(store.listDocumentOps(docId)).toHaveLength(1);
    expect(readDraft(storage, docId)).toBeUndefined();
  });

  it('recovers the draft after a host restart and saves it against the reloaded revision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-fault-restart-'));
    dirs.push(dir);
    const store1 = await openSpaceStore({ directory: dir, now: fixedNow });
    stores.push(store1);
    const service1 = createDocumentService({ store: store1, now: fixedNow });
    const { docId, doc } = await createDocument(service1);
    const storage = new MemoryStorage();

    // Fake timers (see beforeEach) keep the 700ms debounce from firing: this
    // test simulates a crash before the pending autosave reaches the Host.
    const edited = paragraphDoc('重启前未保存内容');
    const crashed = makeHarness({
      service: service1,
      docId,
      initialDoc: doc,
      editorDoc: edited,
      storage,
      fault: () => 'none',
    });
    crashed.controller.notifyChange();
    const pendingDraft = readDraft(storage, docId);
    expect(pendingDraft).toBeDefined();
    expect(pendingDraft?.baseRevision).toBe(1);
    expect(draftText(pendingDraft)).toBe('重启前未保存内容');

    // Host restart: the in-memory queue is lost, the SQLite file and the
    // browser draft survive.
    await store1.close();
    const store2 = await openSpaceStore({ directory: dir, now: fixedNow });
    stores.push(store2);
    const service2 = createDocumentService({ store: store2, now: fixedNow });
    const reloaded = await service2.get(docId);
    expect(reloaded.revision).toBe(1);
    expect(blockText(reloaded.doc)).toBe('原始内容');

    const recovered = readDraft(storage, docId)!;
    const recoveredBlocks = draftBlocks(recovered)!;
    expect(blocksContentEquivalent(recoveredBlocks, edited.blocks)).toBe(true);
    const reopened = makeHarness({
      service: service2,
      docId,
      initialDoc: reloaded.doc,
      editorDoc: {
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: reloaded.revision,
        blocks: recoveredBlocks,
      },
      storage,
      fault: () => 'none',
    });
    reopened.controller.notifyChange();
    await reopened.controller.flush();
    expect(reopened.statuses.at(-1)).toEqual({ kind: 'idle' });
    const saved = await service2.get(docId);
    expect(saved.revision).toBe(2);
    expect(blockText(saved.doc)).toBe('重启前未保存内容');
    expect(store2.listDocumentOps(docId)).toHaveLength(1);
    expect(readDraft(storage, docId)).toBeUndefined();
  });

  it('reconciles a conflict when the host already has the intended content', async () => {
    const store = await tempStore();
    const service = createDocumentService({ store, now: fixedNow });
    const { docId, doc } = await createDocument(service);
    const blockId = doc.blocks[0]!.id;
    const storage = new MemoryStorage();
    // Another duplicate request already landed the intended content.
    await service.applyOperations({
      docId,
      baseRevision: 1,
      ops: [
        {
          op: 'update_text',
          target: blockId,
          edits: [{ oldText: '原始内容', newText: '服务端已有内容' }],
        },
      ],
    });
    expect((await service.get(docId)).revision).toBe(2);
    expect(store.listDocumentOps(docId)).toHaveLength(1);

    const fault = { mode: 'conflict' as FaultMode };
    const harness = makeHarness({
      service,
      docId,
      // The editor still holds the stale revision it loaded before the write.
      initialDoc: doc,
      editorDoc: paragraphDoc('服务端已有内容', blockId),
      storage,
      fault: () => fault.mode,
    });
    harness.controller.notifyChange();
    await harness.controller.flush();

    // doc/conflict + equal content is reconciled as already saved.
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
    expect(harness.get).toHaveBeenCalledWith(docId);
    expect(harness.onSaved).toHaveBeenCalledWith(2, expect.anything(), '故障文档');
    expect((await service.get(docId)).revision).toBe(2);
    expect(store.listDocumentOps(docId)).toHaveLength(1);
    expect(readDraft(storage, docId)).toBeUndefined();
  });

  it('keeps the unsaved draft when a version restore happens', async () => {
    const store = await tempStore();
    const service = createDocumentService({ store, now: fixedNow });
    const generated = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '原始内容\n',
    });
    const docId = generated.docId;
    const initial = await service.get(docId);
    const blockId = initial.doc.blocks[0]!.id;
    // A saved edit on top of the generated revision (revision 2).
    await service.applyOperations({
      docId,
      baseRevision: 1,
      ops: [
        {
          op: 'update_text',
          target: blockId,
          edits: [{ oldText: '原始内容', newText: '已保存修改' }],
        },
      ],
    });
    const version = store
      .read()
      .versions.find((candidate) => candidate.docId === docId);
    expect(version).toBeDefined();

    const storage = new MemoryStorage();
    const unsaved = paragraphDoc('未保存草稿内容', blockId);
    const snapshot = await service.get(docId);
    expect(snapshot.revision).toBe(2);
    const harness = makeHarness({
      service,
      docId,
      initialDoc: snapshot.doc,
      editorDoc: unsaved,
      storage,
      fault: () => 'none',
    });
    harness.controller.notifyChange();
    const draftBefore = readDraft(storage, docId);
    expect(draftText(draftBefore)).toBe('未保存草稿内容');

    // Restore the generated revision while the editor still has unsaved input.
    const restored = await service.restoreVersion({
      docId,
      versionId: version!.id,
      baseRevision: 2,
    });
    expect(restored.revision).toBe(3);
    const afterRestore = await service.get(docId);
    expect(blockText(afterRestore.doc)).toBe('原始内容');

    // Current semantics: the restore path does not clear the draft, so the
    // unsaved input is still recoverable (it is not silently dropped).
    const draftAfter = readDraft(storage, docId);
    expect(draftAfter).toBeDefined();
    const recoveredBlocks = draftBlocks(draftAfter!)!;
    expect(blocksContentEquivalent(recoveredBlocks, unsaved.blocks)).toBe(true);

    // The recovered draft can still be saved on top of the restored revision.
    const current = await service.get(docId);
    const ops = current.doc.blocks.map((block) => ({
      op: 'delete_block' as const,
      target: block.id,
    }));
    if (recoveredBlocks.length > 0)
      ops.push({
        op: 'insert_blocks',
        parent: null,
        index: 0,
        blocks: recoveredBlocks,
      });
    const savedDraft = await service.applyOperations({
      docId,
      baseRevision: current.revision,
      ops,
    });
    expect(savedDraft.revision).toBe(4);
    const final = await service.get(docId);
    expect(blocksContentEquivalent(final.doc.blocks, recoveredBlocks)).toBe(true);
    // Revisions stayed monotonic: 1 (generate) → 2 (edit) → 3 (restore) → 4.
    expect(store.listDocumentOps(docId).length).toBeGreaterThanOrEqual(3);
  });
});
