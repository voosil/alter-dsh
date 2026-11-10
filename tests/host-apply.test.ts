import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apply,
  resolveDataDirectory,
  type HostContextLike,
} from '../host/index.js';
import { parseAlterDoc } from '../host/document/types.js';
import { RPC_ENDPOINT, RPC_ROUTE_PATH } from '../host/rpc.js';
import { SPACE_DB_FILE, openSpaceStore } from '../host/store.js';
import type { SpaceRpcHandler } from '../host/rpc.js';
import { FakeWorkspaceRegistry } from './workspace-fixtures.js';

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
      'space_doc_generate',
      'space_doc_ops',
      'space_doc_outline',
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

  it('resolves the data directory from config, DSH_HOME or the home directory', () => {
    expect(resolveDataDirectory({ dataDir: '/tmp/custom' }, {}, '/home/u')).toBe(
      '/tmp/custom',
    );
    expect(
      resolveDataDirectory(undefined, { DSH_HOME: '/srv/dsh' }, '/home/u'),
    ).toBe('/srv/dsh/data/space');
    expect(resolveDataDirectory(undefined, {}, '/home/u')).toBe(
      '/home/u/.dsh/data/space',
    );
  });
});
