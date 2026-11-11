// @vitest-environment jsdom
/**
 * Legacy save controller: debounce, single-flight, idempotency, conflict
 * reconciliation, crash drafts, fault injection (G4) and large/limit documents
 * (C1/C2). Uses the real Host operation engine behind a mock client so the
 * saved documents are schema-valid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_DRAFT_FORMAT,
  LEGACY_SAVE_DEBOUNCE_MS,
  alterDocToEditorHtml,
  createLegacySaveController,
  legacyDraftStorageKey,
  parseLegacyHtml,
  readLegacyDraft,
  serializeDocument,
  type LegacyDocumentClient,
  type LegacyDocumentDraft,
  type LegacyDraftStorage,
  type LegacySaveSnapshot,
  type LegacySaveStatus,
} from '../../../../src/document/editors/legacy';
import { SpaceRemoteError } from '../../../../src/client/rpc';
import { applyOperations as applyHostOperations } from '../../../../host/document/ast/operations.js';
import type { AlterDoc, BlockNode, OperationContext } from '../../../../host/document/editors/legacy/types.js';

if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}

let blockSequence = 0;
let objectSequence = 0;

function makeContext(): OperationContext {
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

interface ApplyInput {
  docId: string;
  baseRevision: number;
  ops: unknown[];
  idempotencyKey?: string;
}

type ApplyOverride = (
  input: ApplyInput,
  server: ServerState,
  runDefault: () => Promise<unknown>,
) => Promise<unknown>;

function makeClient(server: ServerState, applyOverride?: ApplyOverride) {
  const defaultApply = async (input: ApplyInput): Promise<unknown> => {
    if (input.baseRevision !== server.revision) {
      throw new SpaceRemoteError('doc/conflict', '文档已被修改');
    }
    const result = applyHostOperations(
      server.doc,
      input.ops as never,
      makeContext(),
    );
    server.revision += 1;
    server.doc = { ...result.doc, revision: server.revision };
    return { docId: 'doc-1', revision: server.revision };
  };
  const applyOperations = vi.fn((input: ApplyInput) =>
    applyOverride === undefined
      ? defaultApply(input)
      : applyOverride(input, server, () => defaultApply(input)),
  );
  const get = vi.fn(async () => ({
    docId: 'doc-1',
    revision: server.revision,
    title: server.title,
    doc: server.doc,
  }));
  const client = { get, applyOperations } as unknown as LegacyDocumentClient;
  return { client, get, applyOperations, server };
}

function memoryStorage(): LegacyDraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

interface Harness {
  controller: ReturnType<typeof createLegacySaveController>;
  state: { html: string; title: string };
  server: ServerState;
  client: ReturnType<typeof makeClient>['client'];
  applyOperations: ReturnType<typeof makeClient>['applyOperations'];
  get: ReturnType<typeof makeClient>['get'];
  storage: ReturnType<typeof memoryStorage>;
  statuses: LegacySaveStatus[];
  saved: LegacySaveSnapshot[];
  saveTitle: ReturnType<typeof vi.fn>;
}

function setup(options: {
  doc?: AlterDoc;
  html?: string;
  title?: string;
  applyOverride?: ApplyOverride;
  saveTitle?: (title: string) => Promise<void>;
} = {}): Harness {
  const doc = options.doc ?? docOf([paragraph('blk_p', '原始正文')]);
  const server: ServerState = {
    doc,
    revision: doc.revision,
    title: options.title ?? '标题',
  };
  const { client, applyOperations, get } = makeClient(
    server,
    options.applyOverride,
  );
  const state = {
    html:
      options.html ??
      alterDocToEditorHtml(doc, { docPath: (id) => `#/doc/${id}` }),
    title: options.title ?? '标题',
  };
  const statuses: LegacySaveStatus[] = [];
  const saved: LegacySaveSnapshot[] = [];
  const storage = memoryStorage();
  const saveTitle = vi.fn(options.saveTitle ?? (async () => undefined));
  const controller = createLegacySaveController({
    docId: 'doc-1',
    initial: { doc, revision: doc.revision, title: options.title ?? '标题' },
    getClient: () => client,
    capture: () => ({ html: state.html, title: state.title }),
    onStatus: (status) => statuses.push(status),
    onBaseChanged: () => undefined,
    onSaved: (snapshot) => saved.push(snapshot),
    notify: () => undefined,
    saveTitle: (title) => saveTitle(title),
    storage,
    debounceMs: LEGACY_SAVE_DEBOUNCE_MS,
    draftIntervalMs: 1000,
  });
  return {
    controller,
    state,
    server,
    client,
    applyOperations,
    get,
    storage,
    statuses,
    saved,
    saveTitle,
  };
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  blockSequence = 0;
  objectSequence = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Debounce / single-flight / drafts
// ---------------------------------------------------------------------------

describe('legacy save controller: scheduling', () => {
  it('debounces edits and saves once', async () => {
    const harness = setup();
    harness.state.html =
      alterDocToEditorHtml(docOf([paragraph('blk_p', '改后的正文')]));
    harness.controller.notifyChange();
    await tick(690);
    expect(harness.applyOperations).not.toHaveBeenCalled();
    await tick(20);
    await settle();
    expect(harness.applyOperations).toHaveBeenCalledTimes(1);
    const input = harness.applyOperations.mock.calls[0]![0] as ApplyInput;
    expect(input.baseRevision).toBe(1);
    expect(JSON.stringify(input.ops)).toContain('改后的正文');
    expect(harness.server.doc.blocks[0]?.content).toEqual([
      { type: 'text', text: '改后的正文' },
    ]);
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
    expect(readLegacyDraft('doc-1', harness.storage)).toBeUndefined();
  });

  it('queues edits made during an in-flight save without overwriting them', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const harness = setup({
      applyOverride: async (_input, _server, runDefault) => {
        calls += 1;
        if (calls === 1) await gate;
        return runDefault();
      },
    });
    // First save: hold the request open.
    harness.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '第一次编辑')]),
    );
    harness.controller.notifyChange();
    await tick(700);
    expect(harness.applyOperations).toHaveBeenCalledTimes(1);
    // Edit while the request is in flight.
    harness.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '第二次编辑')]),
    );
    harness.controller.notifyChange();
    expect(harness.controller.hasPending()).toBe(true);
    release();
    await settle();
    // The receipt did not clobber the newer input; a second cycle saves it.
    await tick(700);
    await settle();
    expect(harness.applyOperations).toHaveBeenCalledTimes(2);
    const second = harness.applyOperations.mock.calls[1]![0] as ApplyInput;
    expect(second.baseRevision).toBe(2);
    expect(JSON.stringify(second.ops)).toContain('第二次编辑');
    expect(harness.server.doc.blocks[0]?.content).toEqual([
      { type: 'text', text: '第二次编辑' },
    ]);
  });

  it('writes throttled crash drafts and clears them after a save', async () => {
    const harness = setup();
    harness.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '草稿内容')]),
    );
    harness.controller.notifyChange();
    const draft = readLegacyDraft('doc-1', harness.storage);
    expect(draft).toBeDefined();
    expect(draft!.format).toBe(LEGACY_DRAFT_FORMAT);
    expect(draft!.baseRevision).toBe(1);
    expect(draft!.html).toContain('草稿内容');
    await tick(700);
    await settle();
    expect(readLegacyDraft('doc-1', harness.storage)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Retry / idempotency / conflict reconciliation (A5)
// ---------------------------------------------------------------------------

describe('legacy save controller: retry and idempotency', () => {
  it('keeps the draft and reuses the idempotency key on retry', async () => {
    let attempts = 0;
    const harness = setup({
      applyOverride: async (_input, _server, runDefault) => {
        attempts += 1;
        if (attempts === 1) throw new Error('网络不可用');
        return runDefault();
      },
    });
    harness.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '重试后保存')]),
    );
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    expect(harness.statuses.at(-1)?.kind).toBe('failed');
    expect(harness.controller.hasPending()).toBe(true);
    expect(readLegacyDraft('doc-1', harness.storage)).toBeDefined();

    await harness.controller.retry();
    await settle();
    expect(harness.applyOperations).toHaveBeenCalledTimes(2);
    const first = harness.applyOperations.mock.calls[0]![0] as ApplyInput;
    const second = harness.applyOperations.mock.calls[1]![0] as ApplyInput;
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(harness.server.revision).toBe(2);
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
    expect(readLegacyDraft('doc-1', harness.storage)).toBeUndefined();
  });

  it('reconciles a lost receipt as already saved (A5)', async () => {
    const intendedHtml = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '已落盘内容')]),
    );
    const intendedBlocks = parseLegacyHtml(intendedHtml).blocks;
    const harness = setup({
      applyOverride: async () => {
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      },
    });
    // The Host already stores exactly the intended content at a newer revision.
    harness.get.mockImplementation(async () => ({
      docId: 'doc-1',
      revision: 5,
      title: '标题',
      doc: { ...docOf(intendedBlocks, 5) },
    }));
    harness.state.html = intendedHtml;
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
    expect(harness.controller.getBase().revision).toBe(5);
    expect(harness.saved.at(-1)?.revision).toBe(5);
    expect(readLegacyDraft('doc-1', harness.storage)).toBeUndefined();
  });

  it('enters the conflict state without overwriting when content differs (B1/B2)', async () => {
    const harness = setup({
      applyOverride: async () => {
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      },
    });
    harness.get.mockImplementation(async () => ({
      docId: 'doc-1',
      revision: 4,
      title: '标题',
      doc: docOf([paragraph('blk_other', '他人内容')], 4),
    }));
    harness.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '本地内容')]),
    );
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    const status = harness.statuses.at(-1);
    expect(status?.kind).toBe('conflict');
    if (status?.kind === 'conflict') expect(status.serverRevision).toBe(4);
    // Nothing was written over the other writer's content.
    expect(harness.applyOperations).toHaveBeenCalledTimes(1);
    expect(harness.server.revision).toBe(1);
    expect(readLegacyDraft('doc-1', harness.storage)).toBeDefined();
  });

  it('recovers from a database-busy failure by retrying', async () => {
    let attempts = 0;
    const harness = setup({
      applyOverride: async (_input, _server, runDefault) => {
        attempts += 1;
        if (attempts === 1) {
          throw new SpaceRemoteError('op/invalid', 'database is busy');
        }
        return runDefault();
      },
    });
    harness.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '忙时保存')]),
    );
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    expect(harness.statuses.at(-1)?.kind).toBe('failed');
    expect(readLegacyDraft('doc-1', harness.storage)).toBeDefined();
    await harness.controller.retry();
    await settle();
    expect(harness.server.revision).toBe(2);
    expect(harness.statuses.at(-1)).toEqual({ kind: 'idle' });
  });

  it('saves title-only changes without moving the revision', async () => {
    const harness = setup();
    harness.state.title = '新标题';
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    expect(harness.saveTitle).toHaveBeenCalledWith('新标题');
    expect(harness.applyOperations).not.toHaveBeenCalled();
    expect(harness.controller.getBase().title).toBe('新标题');
  });

  it('persists the current draft on demand and on dispose', async () => {
    const harness = setup({
      applyOverride: async () => {
        throw new Error('离线');
      },
    });
    harness.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '卸载前内容')]),
    );
    harness.controller.notifyChange();
    harness.controller.persistDraftNow();
    const draft = readLegacyDraft('doc-1', harness.storage);
    expect(draft).toBeDefined();
    expect(draft!.html).toContain('卸载前内容');

    harness.controller.dispose();
    await settle();
    // The final background save failed, so the crash draft must survive.
    expect(readLegacyDraft('doc-1', harness.storage)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// G4: host restart / draft recovery hand-off
// ---------------------------------------------------------------------------

describe('legacy save controller: fault injection', () => {
  it('recovers a draft with a fresh controller after a host restart (G4)', async () => {
    const failing = setup({
      applyOverride: async () => {
        throw new Error('宿主重启');
      },
    });
    failing.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '重启前内容')]),
    );
    failing.controller.notifyChange();
    await tick(700);
    await settle();
    const draft = readLegacyDraft('doc-1', failing.storage);
    expect(draft).toBeDefined();

    // New client/controller (host restarted); the crash draft is restored.
    const restarted = setup();
    restarted.state.html = draft!.html;
    restarted.state.title = draft!.title;
    restarted.controller.notifyChange();
    await restarted.controller.flush();
    await settle();
    expect(restarted.applyOperations).toHaveBeenCalledTimes(1);
    expect(restarted.server.doc.blocks[0]?.content).toEqual([
      { type: 'text', text: '重启前内容' },
    ]);
    expect(readLegacyDraft('doc-1', restarted.storage)).toBeUndefined();
  });

  it('keeps the draft when a version restore races unsaved edits (B4)', async () => {
    const harness = setup();
    harness.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_p', '未保存的本地内容')]),
    );
    harness.controller.notifyChange();
    harness.controller.persistDraftNow();
    // Version restore adopts a newer server snapshot; the draft stays.
    harness.controller.adopt({
      doc: docOf([paragraph('blk_old', '历史版本内容')], 6),
      revision: 6,
      title: '标题',
    });
    expect(harness.controller.hasPending()).toBe(false);
    expect(readLegacyDraft('doc-1', harness.storage)).toBeDefined();
    // A fresh mount can still recover the draft (conflict path).
    const recovered = setup({ doc: docOf([paragraph('blk_old', '历史版本内容')], 6) });
    const draft = readLegacyDraft('doc-1', harness.storage)!;
    recovered.state.html = draft.html;
    recovered.controller.adoptForOverwrite({
      doc: docOf([paragraph('blk_old', '历史版本内容')], 6),
      revision: 6,
      title: '标题',
    });
    await recovered.controller.flush();
    await settle();
    expect(JSON.stringify(recovered.server.doc.blocks)).toContain(
      '未保存的本地内容',
    );
  });
});

// ---------------------------------------------------------------------------
// C1/C2: large documents and limits
// ---------------------------------------------------------------------------

function paragraphs(count: number, prefix = '段'): BlockNode[] {
  return Array.from({ length: count }, (_, index) =>
    paragraph(`blk_${prefix}_${index}`, `${prefix}${index}`),
  );
}

describe('legacy save controller: large documents', () => {
  it('saves a full replacement of a 64+ block document in one batch (C1)', async () => {
    const initial = docOf(paragraphs(80, '旧'));
    const replacement = docOf(paragraphs(3, '新'));
    const harness = setup({ doc: initial });
    harness.state.html = alterDocToEditorHtml(replacement);
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    expect(harness.applyOperations).toHaveBeenCalledTimes(1);
    const input = harness.applyOperations.mock.calls[0]![0] as ApplyInput;
    expect(input.ops.length).toBeLessThanOrEqual(8192);
    expect(input.ops.length).toBeGreaterThan(64);
    expect(harness.server.doc.blocks).toHaveLength(3);
    expect(JSON.stringify(harness.server.doc.blocks)).toContain('新0');
  });

  it('saves clearing all blocks without a "change too large" dead end (C1)', async () => {
    const initial = docOf(paragraphs(80, '旧'));
    const harness = setup({ doc: initial });
    harness.state.html = '';
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    expect(harness.applyOperations).toHaveBeenCalledTimes(1);
    expect(harness.server.doc.blocks).toHaveLength(0);
  });

  it('round-trips and saves a near-limit document without truncation (C2)', async () => {
    const blocks = paragraphs(4990);
    const source = docOf(blocks);
    const html = alterDocToEditorHtml(source);
    const parsed = parseLegacyHtml(html);
    expect(parsed.blocks).toHaveLength(4990);
    expect(parsed.blocks[0]?.id).toBe('blk_段_0');
    expect(parsed.blocks.at(-1)?.id).toBe('blk_段_4989');
    const bytes = Buffer.byteLength(serializeDocument(source), 'utf8');
    expect(bytes).toBeLessThan(512 * 1024);
    expect(bytes).toBeLessThan(512 * 1024);

    const harness = setup({ doc: docOf([]) });
    harness.state.html = html;
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    expect(harness.applyOperations).toHaveBeenCalledTimes(1);
    const input = harness.applyOperations.mock.calls[0]![0] as ApplyInput;
    expect(input.ops.length).toBe(1);
    expect(harness.server.doc.blocks).toHaveLength(4990);
    // Re-open: the stored blocks project back to the same ids/content.
    const reopened = parseLegacyHtml(
      alterDocToEditorHtml(harness.server.doc),
    );
    expect(reopened.blocks).toHaveLength(4990);
    expect(reopened.blocks[123]?.id).toBe('blk_段_123');
  });

  it('keeps local content when the Host rejects an oversized document (C2)', async () => {
    const harness = setup({
      applyOverride: async () => {
        throw new SpaceRemoteError('doc/too-large', '文档超过上限');
      },
    });
    const huge = 'x'.repeat(600_000);
    harness.state.html = alterDocToEditorHtml(
      docOf([paragraph('blk_huge', huge)]),
    );
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    const status = harness.statuses.at(-1);
    expect(status?.kind).toBe('failed');
    if (status?.kind === 'failed') {
      expect(status.message).toContain('体量上限');
    }
    expect(harness.controller.hasPending()).toBe(true);
    expect(readLegacyDraft('doc-1', harness.storage)?.html).toContain(
      huge.slice(0, 100),
    );
    expect(harness.state.html).toContain(huge.slice(0, 100));
  });

  it('keeps local content when the Host rejects too many blocks (C2)', async () => {
    const harness = setup({
      applyOverride: async () => {
        throw new SpaceRemoteError('doc/schema-invalid', '文档 block 数量超过上限');
      },
    });
    harness.state.html = alterDocToEditorHtml(docOf(paragraphs(5001, '超')));
    harness.controller.notifyChange();
    await tick(700);
    await settle();
    const status = harness.statuses.at(-1);
    expect(status?.kind).toBe('failed');
    if (status?.kind === 'failed') {
      expect(status.message).toContain('block 数量超过上限');
    }
    expect(harness.controller.hasPending()).toBe(true);
    expect(readLegacyDraft('doc-1', harness.storage)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Storage format contract
// ---------------------------------------------------------------------------

describe('legacy draft storage', () => {
  it('uses the documented key and payload shape', () => {
    const harness = setup();
    harness.state.html = '<p data-block-id="blk_p">内容</p>';
    harness.state.title = '草稿标题';
    harness.controller.notifyChange();
    harness.controller.persistDraftNow();
    const raw = harness.storage.map.get(legacyDraftStorageKey('doc-1'));
    expect(raw).toBeDefined();
    const draft = JSON.parse(raw!) as LegacyDocumentDraft;
    expect(draft).toMatchObject({
      format: LEGACY_DRAFT_FORMAT,
      docId: 'doc-1',
      title: '草稿标题',
      baseRevision: 1,
    });
    expect(typeof draft.savedAt).toBe('number');
    expect(draft.html).toContain('内容');
  });

  it('ignores foreign or corrupt drafts', () => {
    const storage = memoryStorage();
    storage.map.set(legacyDraftStorageKey('doc-1'), '{"format":"other"}');
    expect(readLegacyDraft('doc-1', storage)).toBeUndefined();
    storage.map.set(legacyDraftStorageKey('doc-1'), 'not json');
    expect(readLegacyDraft('doc-1', storage)).toBeUndefined();
  });
});
