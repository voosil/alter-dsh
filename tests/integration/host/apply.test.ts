import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apply,
  resolveDataDirectory,
  type HostContextLike,
} from '../../../host/core/index.js';
import { parseAlterDoc } from '../../../host/document/editors/legacy/types.js';
import { RPC_ENDPOINT, RPC_ROUTE_PATH } from '../../../host/authority/rpc.js';
import { SPACE_DB_FILE, openSpaceStore } from '../../../host/persistence/store.js';
import { FakeWorkspaceRegistry } from '../../support/workspace-fixtures.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-apply-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fakeTools(): {
  definitions: Map<string, unknown>;
  tools: { register: (definition: { name: string }) => () => void };
} {
  const definitions = new Map<string, unknown>();
  return {
    definitions,
    tools: {
      register(definition: { name: string }) {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
    },
  };
}

interface RegisteredTool {
  execute(
    args: unknown,
    exec: {
      callId: string;
      name: string;
      arguments: unknown;
      signal: AbortSignal;
    },
  ): Promise<unknown>;
}

/** Look up one tool definition captured from the Host registration. */
function toolOf(
  definitions: Map<string, unknown>,
  name: string,
): RegisteredTool {
  const found = definitions.get(name);
  if (found === undefined) throw new Error(`tool ${name} is not registered`);
  return found as RegisteredTool;
}

const toolExec = (name: string) => ({
  callId: `${name}-1`,
  name,
  arguments: {},
  signal: new AbortController().signal,
});

interface AstBlockLike {
  id: string;
  type: string;
  content?: Array<{ type: string; text?: string }>;
}

interface AstSnapshotLike {
  revision: number;
  doc: { blocks: AstBlockLike[] };
}

function astBlockText(block: AstBlockLike): string {
  return (block.content ?? [])
    .map((node) => (node.type === 'text' ? node.text ?? '' : ''))
    .join('');
}

interface Harness {
  ctx: HostContextLike;
  routePath: () => string | undefined;
  call: (op: string, args?: unknown[]) => Promise<unknown>;
  teardown: () => Promise<void>;
}

function createHarness(
  options: { registry?: unknown; tools?: unknown } = {},
): Harness {
  let registeredPath: string | undefined;
  const routes = new Map<string, (request: Request) => Promise<Response>>();
  const disposers: Array<() => unknown> = [];
  const childEffect = async (execute: () => unknown) => {
    const dispose = await execute();
    if (typeof dispose === 'function')
      disposers.push(dispose as () => unknown);
    return dispose;
  };
  const ctx = {
    connection: {
      fetch: {
        register(route: {
          path: string;
          fetch: (request: Request) => Promise<Response>;
        }) {
          if (registeredPath === undefined) registeredPath = route.path;
          routes.set(route.path, route.fetch);
          return () => undefined;
        },
      },
    },
    logger: { info: () => undefined, warn: () => undefined },
    effect: childEffect,
    ...(options.registry === undefined && options.tools === undefined
      ? {}
      : {
          inject(names: string[], callback: (child: unknown) => void) {
            callback({
              ...(options.registry === undefined
                ? {}
                : { workspaceRegistry: options.registry }),
              ...(options.tools === undefined ? {} : { tools: options.tools }),
              effect: childEffect,
            });
          },
        }),
  } as unknown as HostContextLike;
  return {
    ctx,
    routePath: () => registeredPath,
    call: async (op: string, args: unknown[] = []) => {
      const routeFetch = routes.get(RPC_ROUTE_PATH);
      if (!routeFetch) throw new Error('route is not registered yet');
      const rpcId = 'test-rpc';
      const response = await routeFetch(
        new Request(`http://dsh.internal${registeredPath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method: RPC_ENDPOINT,
            payload: { op, args },
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        rpcId: string;
        result: { ok: boolean; value?: { value?: unknown; error?: unknown } };
      };
      expect(body.rpcId).toBe(rpcId);
      expect(body.result.ok).toBe(true);
      const payload = body.result.value ?? {};
      if (payload.error !== undefined)
        throw new Error(JSON.stringify(payload.error));
      return payload.value ?? undefined;
    },
    teardown: async () => {
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}

describe('host plugin apply', () => {
  it('opens SQLite, registers the RPC channel and closes on teardown', async () => {
    const dir = await tempDir();
    const harness = createHarness();
    await apply(harness.ctx, { dataDir: dir });
    expect(harness.routePath()).toBe(RPC_ROUTE_PATH);
    const files = await readdir(dir);
    expect(files).toContain(SPACE_DB_FILE);
    const listed = (await harness.call('space.listSpaces')) as unknown[];
    expect(listed).toHaveLength(1);
    const storage = (await harness.call('storage.get')) as {
      settings: { historyLimit: number; snapshotKeep: number };
      estimate: { documentCount: number; projectedBytes: number };
    };
    expect(storage.settings).toEqual({ historyLimit: 10, snapshotKeep: 3 });
    expect(storage.estimate.documentCount).toBe(0);
    expect(storage.estimate.projectedBytes).toBeGreaterThan(0);
    await harness.call('storage.set', [{ historyLimit: 6 }]);
    await harness.call('space.createSpace', [{ name: '持久化' }]);
    await harness.teardown();
    const reopened = await openSpaceStore({ directory: dir });
    expect(reopened.read().spaces.some((space) => space.name === '持久化')).toBe(
      true,
    );
    expect(reopened.getStorageSettings().historyLimit).toBe(6);
    await reopened.close();
  });

  it('creates the DSH workspace through the RPC seam when a registry is available', async () => {
    const dir = await tempDir();
    const workspaceDir = await mkdtemp(join(tmpdir(), 'alter-space-apply-ws-'));
    dirs.push(workspaceDir);
    const registry = new FakeWorkspaceRegistry();
    const harness = createHarness({ registry });
    await apply(harness.ctx, { dataDir: dir });
    const created = (await harness.call('space.createSpace', [
      { name: '工作空间', directories: [workspaceDir] },
    ])) as { id: string };
    const workspace = registry.list()[0] as
      | { id: string; path: string; title: string }
      | undefined;
    expect(workspace).toBeDefined();
    expect(workspace?.path).toBe(await realpath(workspaceDir));
    expect(workspace?.title).toBe('🪐 工作空间');
    await harness.teardown();
    const reopened = await openSpaceStore({ directory: dir });
    expect(reopened.getWorkspaceLink(created.id)?.workspaceId).toBe(
      workspace?.id,
    );
    await reopened.close();
  });

  it('registers document tools and serves the document RPC endpoints', async () => {
    const dir = await tempDir();
    const fake = fakeTools();
    const harness = createHarness({ tools: fake.tools });
    await apply(harness.ctx, { dataDir: dir });
    expect([...fake.definitions.keys()].sort()).toEqual([
      'space_asset_import',
      'space_component_catalog',
      'space_doc_generate',
      'space_doc_ops',
      'space_doc_outline',
      'space_doc_patch',
      'space_doc_read',
      'space_doc_search',
      'space_doc_undo',
      'space_object_get',
      'space_object_update',
    ]);

    const generated = (await harness.call('doc.generate', [
      {
        spaceId: 'sp-inbox',
        title: 'RPC 文档',
        markdown: '# 标题\n\n正文段落\n',
      },
    ])) as { docId: string; revision: number; changed_block_ids?: unknown };
    expect(generated.docId).toMatch(/^doc-/);
    expect(generated.revision).toBe(1);

    const outline = (await harness.call('doc.outline', [generated.docId])) as {
      revision: number;
      outline: Array<{ id: string; type: string }>;
    };
    expect(outline.revision).toBe(1);
    expect(outline.outline.length).toBeGreaterThan(0);

    const read = (await harness.call('doc.read', [generated.docId])) as {
      revision: number;
      markdown: string;
      blocks: Array<{ id: string; type: string }>;
    };
    expect(read.markdown).toContain('# 标题');
    const paragraph = read.blocks.find((block) => block.type === 'paragraph');
    expect(paragraph).toBeDefined();

    const applied = (await harness.call('doc.applyOps', [
      {
        docId: generated.docId,
        baseRevision: 1,
        ops: [
          {
            op: 'update_text',
            target: paragraph!.id,
            edits: [{ oldText: '正文段落', newText: '改过的正文' }],
          },
        ],
      },
    ])) as { revision: number; changedBlockIds: string[] };
    expect(applied.revision).toBe(2);
    expect(applied.changedBlockIds).toContain(paragraph!.id);

    await expect(
      harness.call('doc.applyOps', [
        {
          docId: generated.docId,
          baseRevision: 1,
          ops: [{ op: 'delete_block', target: paragraph!.id }],
        },
      ]),
    ).rejects.toThrow('doc/conflict');

    const ast = (await harness.call('doc.get', [generated.docId])) as {
      revision: number;
      doc: { blocks: Array<{ id: string; type: string }> };
    };
    expect(ast.revision).toBe(2);
    expect(ast.doc.blocks.length).toBeGreaterThan(0);

    const undone = (await harness.call('doc.undo', [
      { docId: generated.docId, baseRevision: 2 },
    ])) as { revision: number; changedBlockIds: string[] };
    expect(undone.revision).toBe(3);
    const restored = (await harness.call('doc.read', [generated.docId])) as {
      markdown: string;
    };
    expect(restored.markdown).toContain('正文段落');

    // Note creation goes through the document service: empty AST, no format tag.
    const note = (await harness.call('space.createNode', [
      { spaceId: 'sp-inbox', kind: 'note', title: '新建文档' },
    ])) as { id: string; content: string };
    expect(note).not.toHaveProperty('contentFormat');
    const noteDoc = parseAlterDoc(note.content);
    expect(noteDoc.revision).toBe(1);
    expect(noteDoc.blocks).toEqual([]);
    await expect(
      harness.call('space.saveNode', [note.id, { content: '<p>正文</p>' }]),
    ).rejects.toThrow('node/not-writable');
    await expect(harness.call('doc.migrate', [])).rejects.toThrow(
      'space/not-found',
    );

    await harness.teardown();
    expect(fake.definitions.size).toBe(0);
  });

  it('patches one block through space_doc_patch (CAS, dry_run, idempotency, undo)', async () => {
    const dir = await tempDir();
    const fake = fakeTools();
    const harness = createHarness({ tools: fake.tools });
    await apply(harness.ctx, { dataDir: dir });

    const markdown = [
      '# P5 文档',
      '',
      ...Array.from(
        { length: 12 },
        (_, index) => `段落${index + 1}：可精确改写的正文内容。`,
      ),
    ].join('\n\n');
    const generated = (await harness.call('doc.generate', [
      { spaceId: 'sp-inbox', title: 'P5 文档', markdown },
    ])) as { docId: string; revision: number };
    const docId = generated.docId;

    const before = (await harness.call('doc.get', [docId])) as AstSnapshotLike;
    expect(before.doc.blocks.length).toBeGreaterThanOrEqual(10);
    const target = before.doc.blocks.find(
      (block) => block.type === 'paragraph' && astBlockText(block).startsWith('段落1：'),
    );
    expect(target).toBeDefined();
    const oldText = astBlockText(target!);
    expect(oldText.length).toBeGreaterThan(0);
    const newText = '已精确改写的内容';

    const patch = toolOf(fake.definitions, 'space_doc_patch');
    const patched = (await patch.execute(
      {
        doc_id: docId,
        base_revision: before.revision,
        block_id: target!.id,
        old_text: oldText,
        new_text: newText,
      },
      toolExec('space_doc_patch'),
    )) as {
      revision: number;
      changed_block_ids: string[];
      diff: { applied?: unknown[] };
      undo_token?: string;
      dry_run?: boolean;
    };
    expect(patched.revision).toBe(before.revision + 1);
    expect(patched.changed_block_ids).toEqual([target!.id]);
    expect(patched.undo_token).toBeTruthy();
    expect(patched.dry_run).toBeUndefined();
    expect(Array.isArray(patched.diff.applied)).toBe(true);
    expect(patched.diff.applied!.length).toBeGreaterThan(0);

    // Only the target block changed; every other block is byte-identical.
    const after = (await harness.call('doc.get', [docId])) as AstSnapshotLike;
    expect(after.revision).toBe(patched.revision);
    expect(astBlockText(after.doc.blocks.find((block) => block.id === target!.id)!)).toBe(
      newText,
    );
    expect(
      after.doc.blocks.filter((block) => block.id !== target!.id),
    ).toEqual(before.doc.blocks.filter((block) => block.id !== target!.id));
    const read = (await harness.call('doc.read', [docId])) as { markdown: string };
    expect(read.markdown).toContain(newText);
    expect(read.markdown).not.toContain(oldText);

    // dry_run previews the diff without writing or bumping the revision.
    const preview = (await patch.execute(
      {
        doc_id: docId,
        base_revision: after.revision,
        block_id: target!.id,
        old_text: newText,
        new_text: '预览内容',
        dry_run: true,
      },
      toolExec('space_doc_patch'),
    )) as { revision: number; dry_run?: boolean; undo_token?: string };
    expect(preview.dry_run).toBe(true);
    expect(preview.revision).toBe(after.revision);
    expect(preview.undo_token).toBeUndefined();
    const afterPreview = (await harness.call('doc.get', [docId])) as AstSnapshotLike;
    expect(afterPreview.revision).toBe(after.revision);
    expect(
      astBlockText(afterPreview.doc.blocks.find((block) => block.id === target!.id)!),
    ).toBe(newText);

    // A stale base_revision explains how to recover.
    const conflict = await patch
      .execute(
        {
          doc_id: docId,
          base_revision: before.revision,
          block_id: target!.id,
          old_text: newText,
          new_text: '不应写入',
        },
        toolExec('space_doc_patch'),
      )
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).message).toContain('space_doc_read');
    expect((conflict as Error).message).toContain('space_doc_outline');
    expect((conflict as Error).message).toContain('重试');

    // Ambiguous old_text is rejected with a replace_all hint.
    const duplicate = (await harness.call('doc.generate', [
      { spaceId: 'sp-inbox', title: '重复', markdown: '重复内容重复内容\n' },
    ])) as { docId: string; revision: number };
    const duplicateSnapshot = (await harness.call('doc.get', [
      duplicate.docId,
    ])) as AstSnapshotLike;
    const duplicateBlock = duplicateSnapshot.doc.blocks.find(
      (block) => block.type === 'paragraph',
    )!;
    const ambiguous = await patch
      .execute(
        {
          doc_id: duplicate.docId,
          base_revision: duplicateSnapshot.revision,
          block_id: duplicateBlock.id,
          old_text: '重复内容',
          new_text: '替换',
        },
        toolExec('space_doc_patch'),
      )
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(ambiguous).toBeInstanceOf(Error);
    expect((ambiguous as Error).message).toContain('replace_all');
    const replaced = (await patch.execute(
      {
        doc_id: duplicate.docId,
        base_revision: duplicateSnapshot.revision,
        block_id: duplicateBlock.id,
        old_text: '重复内容',
        new_text: '替换',
        replace_all: true,
      },
      toolExec('space_doc_patch'),
    )) as { revision: number };
    expect(replaced.revision).toBe(duplicateSnapshot.revision + 1);
    const duplicateRead = (await harness.call('doc.read', [duplicate.docId])) as {
      markdown: string;
    };
    expect(duplicateRead.markdown).toContain('替换替换');

    // Replaying the same idempotency_key returns the original result and does
    // not write a second time.
    const idempotentArgs = {
      doc_id: docId,
      base_revision: after.revision,
      block_id: target!.id,
      old_text: newText,
      new_text: '幂等结果',
      idempotency_key: 'patch-key-1',
    };
    const first = (await patch.execute(
      idempotentArgs,
      toolExec('space_doc_patch'),
    )) as { revision: number; undo_token?: string };
    const replay = (await patch.execute(
      idempotentArgs,
      toolExec('space_doc_patch'),
    )) as { revision: number; undo_token?: string };
    expect(replay.revision).toBe(first.revision);
    expect(replay.undo_token).toBe(first.undo_token);
    const afterReplay = (await harness.call('doc.get', [docId])) as AstSnapshotLike;
    expect(afterReplay.revision).toBe(first.revision);

    // space_doc_undo reverts the patch through the inverse operations.
    const undone = (await harness.call('doc.undo', [
      { docId, baseRevision: first.revision },
    ])) as { revision: number };
    expect(undone.revision).toBe(first.revision + 1);
    const undoneRead = (await harness.call('doc.read', [docId])) as {
      markdown: string;
    };
    expect(undoneRead.markdown).toContain(newText);
    expect(undoneRead.markdown).not.toContain('幂等结果');

    await harness.teardown();
  });

  it('applies three consecutive patches to a long document without full rewrites', async () => {
    const dir = await tempDir();
    const fake = fakeTools();
    const harness = createHarness({ tools: fake.tools });
    await apply(harness.ctx, { dataDir: dir });

    const markdown = [
      '# 多 patch 文档',
      '',
      ...Array.from(
        { length: 12 },
        (_, index) => `目标${index + 1}：多轮 patch 的正文。`,
      ),
    ].join('\n\n');
    const generated = (await harness.call('doc.generate', [
      { spaceId: 'sp-inbox', title: '多 patch 文档', markdown },
    ])) as { docId: string; revision: number };
    const docId = generated.docId;
    const before = (await harness.call('doc.get', [docId])) as AstSnapshotLike;
    const targets = before.doc.blocks
      .filter((block) => block.type === 'paragraph')
      .slice(0, 3);
    expect(targets).toHaveLength(3);

    const patch = toolOf(fake.definitions, 'space_doc_patch');
    const replacement = ['改写甲', '改写乙', '改写丙'];
    let revision = before.revision;
    for (const [index, block] of targets.entries()) {
      const result = (await patch.execute(
        {
          doc_id: docId,
          base_revision: revision,
          block_id: block.id,
          old_text: astBlockText(block),
          new_text: replacement[index],
        },
        toolExec('space_doc_patch'),
      )) as { revision: number; changed_block_ids: string[] };
      expect(result.revision).toBe(revision + 1);
      expect(result.changed_block_ids).toEqual([block.id]);
      revision = result.revision;
    }

    const after = (await harness.call('doc.get', [docId])) as AstSnapshotLike;
    expect(after.revision).toBe(before.revision + 3);
    expect(after.doc.blocks).toHaveLength(before.doc.blocks.length);
    for (const [index, block] of targets.entries()) {
      expect(
        astBlockText(after.doc.blocks.find((item) => item.id === block.id)!),
      ).toBe(replacement[index]);
    }
    const untouchedIds = new Set(targets.map((block) => block.id));
    expect(
      after.doc.blocks.filter((block) => !untouchedIds.has(block.id)),
    ).toEqual(before.doc.blocks.filter((block) => !untouchedIds.has(block.id)));
    const read = (await harness.call('doc.read', [docId])) as { markdown: string };
    for (const text of replacement) expect(read.markdown).toContain(text);

    await harness.teardown();
  });

  it('resolves the data directory from config, DSH_HOME or the home directory', () => {
    // The helper anchors against the platform root, so the expectations are
    // built with the same primitives instead of hard-coding POSIX paths.
    expect(resolveDataDirectory({ dataDir: '/tmp/custom' }, {}, '/home/u')).toBe(
      resolve('/tmp/custom'),
    );
    expect(
      resolveDataDirectory(undefined, { DSH_HOME: '/srv/dsh' }, '/home/u'),
    ).toBe(join(resolve('/srv/dsh'), 'data', 'space'));
    expect(resolveDataDirectory(undefined, {}, '/home/u')).toBe(
      join('/home/u', '.dsh', 'data', 'space'),
    );
  });
});
