import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../../../host/authority/compose.js';
import { createDocumentAssets, MAX_ASSET_BYTES, MAX_FILE_BYTES } from '../../../host/document/asset-store.js';
import { createStructuredSpaceService } from '../../../host/document/editors/legacy/notes.js';
import { createDocumentService } from '../../../host/document/editors/legacy/service.js';
import { parseAlterDoc } from '../../../host/document/editors/legacy/types.js';
import {
  RPC_ENDPOINT,
  RPC_ROUTE_PATH,
  createSpaceFetchRoute,
  createSpaceRpc,
} from '../../../host/authority/rpc.js';
import { createSpaceStorage } from '../../../host/persistence/storage.js';
import { openSpaceStore } from '../../../host/persistence/store.js';
import {
  createSpaceWorkspaceSync,
  type SpaceWorkspaceSync,
} from '../../../host/workspace/sync.js';
import { FakeWorkspaceRegistry } from '../../support/workspace-fixtures.js';

const dirs: string[] = [];
const signal = new AbortController().signal;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-rpc-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date('2026-11-06T00:00:00.000Z');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_BASE64 = Buffer.from(png).toString('base64');
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 1, 2, 3]);
const PDF_BASE64 = Buffer.from(pdf).toString('base64');

async function createHandler(
  options: { workspaceSync?: boolean; assets?: boolean } = {},
) {
  const dir = await tempDir();
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const store = await openSpaceStore({ directory: dir, now: fixedNow });
  const stacks = createSpaceAuthority(store, fixedNow);
  const document = createDocumentService({ store, now: fixedNow, actor: 'user' });
  const agentDocument = createDocumentService({ store, now: fixedNow, actor: 'alter' });
  const service = createStructuredSpaceService(stacks.user, document);
  const agentService = createStructuredSpaceService(stacks.alter, agentDocument);
  const storage = createSpaceStorage({ store, directory: dir });
  const assets =
    options.assets === false
      ? undefined
      : createDocumentAssets({ store, directory: dir, now: fixedNow });
  let registry: FakeWorkspaceRegistry | undefined;
  let sync: SpaceWorkspaceSync | undefined;
  if (options.workspaceSync === true) {
    registry = new FakeWorkspaceRegistry();
    sync = createSpaceWorkspaceSync({
      registry,
      store,
      homeDirectory: home,
      now: fixedNow,
    });
  }
  const handler = createSpaceRpc({
    service,
    agentService,
    storage,
    workspaceSync: sync === undefined ? undefined : () => sync,
    document,
    agentDocument,
    assets,
  });
  return {
    dir,
    home,
    store,
    service,
    agentService,
    storage,
    document,
    agentDocument,
    assets,
    handler,
    registry,
    sync,
  };
}

type HandlerResult = {
  value?: unknown;
  error?: { code: string; message: string };
};

function valueOf(result: unknown): unknown {
  return (result as HandlerResult).value;
}

function errorOf(result: unknown): { code: string; message: string } | undefined {
  return (result as HandlerResult).error;
}

describe('Space RPC dispatch', () => {
  it('exposes the fetch-route path and endpoint constants', () => {
    expect(RPC_ROUTE_PATH).toBe('/api/alter-space');
    expect(RPC_ENDPOINT).toBe('alter-space');
  });

  it('dispatches SpaceService calls with positional args', async () => {
    const { store, handler } = await createHandler();
    const spaces = valueOf(await handler('space.listSpaces', { args: [] }, signal, {}));
    expect(spaces).toHaveLength(1);
    const created = valueOf(
      await handler('space.createSpace', { args: [{ name: 'RPC' }] }, signal, {}),
    ) as { id: string };
    expect(created.id).toMatch(/^sp-/);
    const list = valueOf(await handler('space.listSpaces', { args: [] }, signal, {})) as Array<{
      id: string;
    }>;
    expect(list.map((space) => space.id)).toContain(created.id);
    await store.close();
  });

  it('maps business failures to error envelopes', async () => {
    const { store, handler } = await createHandler();
    const result = await handler('space.getNode', { args: ['missing'] }, signal, {});
    expect(errorOf(result)).toBeUndefined();
    expect(valueOf(result)).toBeNull();
    const failure = await handler(
      'space.saveNode',
      { args: ['missing', { title: 'x' }] },
      signal,
      {},
    );
    expect(errorOf(failure)?.code).toBe('space/failed');
    expect(errorOf(failure)?.message).toContain('文档');
    const blocked = await handler(
      'space.saveNode',
      { args: ['missing', { content: 'x' }] },
      signal,
      {},
    );
    expect(errorOf(blocked)?.code).toBe('node/not-writable');
    expect(errorOf(blocked)?.message).toContain('文档正文只能通过文档模型接口写入');
    await store.close();
  });

  it('creates notes as AST documents and keeps body writes on the document path', async () => {
    const { store, handler } = await createHandler();
    const spaces = valueOf(
      await handler('space.listSpaces', { args: [] }, signal, {}),
    ) as Array<{ id: string }>;
    const spaceId = spaces[0]!.id;
    const created = valueOf(
      await handler(
        'space.createNode',
        { args: [{ spaceId, kind: 'note', title: '新文档' }] },
        signal,
        {},
      ),
    ) as { id: string; content: string; creator: string; title: string };
    expect(created.id).toMatch(/^doc-/);
    expect(created.title).toBe('新文档');
    expect(created.creator).toBe('me');
    expect(created).not.toHaveProperty('contentFormat');
    const doc = parseAlterDoc(created.content);
    expect(doc.revision).toBe(1);
    expect(doc.blocks).toEqual([]);
    const loaded = valueOf(
      await handler('doc.get', { args: [created.id] }, signal, {}),
    ) as { revision: number };
    expect(loaded.revision).toBe(1);

    const blocked = await handler(
      'space.saveNode',
      { args: [created.id, { content: '<p>正文</p>' }] },
      signal,
      {},
    );
    expect(errorOf(blocked)?.code).toBe('node/not-writable');
    // The legacy Space-level restore writes `node.content` directly and never
    // advances the document revision, so it must stay unreachable.
    const blockedRestore = await handler(
      'space.restoreVersion',
      { args: [created.id, 'ver-legacy'] },
      signal,
      {},
    );
    expect(errorOf(blockedRestore)?.code).toBe('node/not-writable');
    expect(errorOf(blockedRestore)?.message).toContain('doc.restoreVersion');
    const renamed = valueOf(
      await handler(
        'space.saveNode',
        { args: [created.id, { title: '改名后' }] },
        signal,
        {},
      ),
    ) as { title: string };
    expect(renamed.title).toBe('改名后');

    const folder = valueOf(
      await handler(
        'space.createNode',
        { args: [{ spaceId, kind: 'folder' }] },
        signal,
        {},
      ),
    ) as { kind: string };
    expect(folder.kind).toBe('folder');
    await store.close();
  });

  it('does not expose the removed doc.migrate endpoint', async () => {
    const { store, handler } = await createHandler();
    const result = await handler('doc.migrate', { args: [] }, signal, {});
    expect(errorOf(result)?.code).toBe('space/not-found');
    await store.close();
  });

  it('rejects unknown endpoints and malformed payloads', async () => {
    const { store, handler } = await createHandler();
    const unknown = await handler('space.nope', { args: [] }, signal, {});
    expect(errorOf(unknown)?.code).toBe('space/not-found');
    const malformed = await handler('space.listSpaces', 'nope', signal, {});
    expect(errorOf(malformed)).toBeUndefined();
    expect(valueOf(malformed)).toHaveLength(1);
    await store.close();
  });

  it('creates collaborators through the whitelisted RPC endpoint', async () => {
    const { store, handler } = await createHandler();
    const agent = valueOf(
      await handler(
        'space.createAgent',
        { args: [{ name: '研究助手', role: '资料检索' }] },
        signal,
        {},
      ),
    ) as { id: string; name: string; role: string };
    expect(agent.id).toMatch(/^ag-/);
    expect(agent.name).toBe('研究助手');
    expect(agent.role).toBe('资料检索');
    const agents = valueOf(
      await handler('space.listAgents', { args: [] }, signal, {}),
    ) as Array<{ id: string }>;
    expect(agents.map((item) => item.id)).toEqual([agent.id]);
    await store.close();
  });

  it('serves the Connection fetch-route envelope', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const service = createSpaceAuthority(store, fixedNow).user;
    const storage = createSpaceStorage({ store, directory: dir });
    const assets = createDocumentAssets({ store, directory: dir, now: fixedNow });
    const route = createSpaceFetchRoute({ service, storage, assets });
    const post = (rpcId: string, payload: unknown) =>
      route(
        new Request('http://dsh.internal/api/alter-space', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method: 'alter-space',
            payload,
          }),
        }),
      );
    const response = await post('rpc-1', { op: 'space.listSpaces', args: [] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      type: string;
      rpcId: string;
      result: { ok: boolean; value: { value: unknown[] } };
    };
    expect(body.type).toBe('server-response');
    expect(body.rpcId).toBe('rpc-1');
    expect(body.result.ok).toBe(true);
    expect(body.result.value.value).toHaveLength(1);

    const uploaded = await post('rpc-2', {
      op: 'doc.importAsset',
      args: [{ mime: 'image/png', dataBase64: PNG_BASE64 }],
    });
    const uploadedBody = (await uploaded.json()) as {
      rpcId: string;
      result: {
        ok: boolean;
        value: {
          value?: { assetId: string; mime: string; bytes: number };
          error?: { code: string; message: string };
        };
      };
    };
    expect(uploadedBody.rpcId).toBe('rpc-2');
    expect(uploadedBody.result.value.value).toMatchObject({
      mime: 'image/png',
      bytes: png.byteLength,
    });
    const rejected = await post('rpc-3', {
      op: 'doc.importAsset',
      args: [{ mime: 'image/svg+xml', dataBase64: PNG_BASE64 }],
    });
    const rejectedBody = (await rejected.json()) as {
      result: { value: { error?: { code: string; message: string } } };
    };
    expect(rejectedBody.result.value.error?.code).toBe('object/invalid');

    const uploadedFile = await post('rpc-4', {
      op: 'doc.importFile',
      args: [
        { mime: 'application/pdf', dataBase64: PDF_BASE64, name: 'a.pdf' },
      ],
    });
    const uploadedFileBody = (await uploadedFile.json()) as {
      rpcId: string;
      result: {
        value: {
          value?: { assetId: string; mime: string; bytes: number; name?: string };
        };
      };
    };
    expect(uploadedFileBody.rpcId).toBe('rpc-4');
    expect(uploadedFileBody.result.value.value).toMatchObject({
      mime: 'application/pdf',
      bytes: pdf.byteLength,
      name: 'a.pdf',
    });

    const bad = await route(
      new Request('http://dsh.internal/api/alter-space', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(bad.status).toBe(400);
    await store.close();
  });

  it('serves and persists storage settings through the RPC layer', async () => {
    const { store, handler } = await createHandler();
    const state = valueOf(
      await handler('storage.get', { args: [] }, signal, {}),
    ) as {
      settings: { historyLimit: number; snapshotKeep: number };
      estimate: { documentCount: number; currentBytes: number; projectedBytes: number };
    };
    expect(state.settings).toEqual({ historyLimit: 10, snapshotKeep: 3 });
    expect(state.estimate.documentCount).toBe(0);
    expect(state.estimate.currentBytes).toBeGreaterThan(0);

    const estimate = valueOf(
      await handler('storage.estimate', { args: [{ historyLimit: 50 }] }, signal, {}),
    ) as { projectedBytes: number };
    expect(estimate.projectedBytes).toBeGreaterThanOrEqual(0);

    const updated = valueOf(
      await handler(
        'storage.set',
        { args: [{ historyLimit: 4, snapshotKeep: 2 }] },
        signal,
        {},
      ),
    ) as { settings: { historyLimit: number; snapshotKeep: number } };
    expect(updated.settings).toEqual({ historyLimit: 4, snapshotKeep: 2 });
    expect(store.getStorageSettings()).toEqual({
      historyLimit: 4,
      snapshotKeep: 2,
    });

    for (const patch of [{ historyLimit: 0 }, { snapshotKeep: 1.5 }, 'nope']) {
      const rejected = await handler('storage.set', { args: [patch] }, signal, {});
      expect(errorOf(rejected)?.code).toBe('space/invalid-input');
    }
    await store.close();
  });

  it('rejects unknown storage methods', async () => {
    const { store, handler } = await createHandler();
    const result = await handler('storage.nope', { args: [] }, signal, {});
    expect(errorOf(result)?.code).toBe('space/not-found');
    await store.close();
  });

  it('dispatches hub endpoints', async () => {
    const { store, handler } = await createHandler();
    const spaces = valueOf(await handler('space.listSpaces', { args: [] }, signal, {})) as Array<{
      id: string;
    }>;
    const spaceId = spaces[0]!.id;
    const snapshot = valueOf(
      await handler('hub.get', { args: [spaceId] }, signal, {}),
    ) as { plugins: unknown[] };
    expect(snapshot.plugins).toHaveLength(2);
    const policy = await handler(
      'hub.setPolicy',
      { args: [spaceId, 'judge'] },
      signal,
      {},
    );
    expect(errorOf(policy)).toBeUndefined();
    const updated = valueOf(
      await handler('hub.get', { args: [spaceId] }, signal, {}),
    ) as { policy: string };
    expect(updated.policy).toBe('judge');
    await store.close();
  });
});

describe('doc.importAsset RPC', () => {
  it('imports a browser-uploaded image and returns only public fields', async () => {
    const { store, handler, assets } = await createHandler();
    const result = await handler(
      'doc.importAsset',
      { args: [{ mime: 'image/png', dataBase64: PNG_BASE64, name: ' 图.png ' }] },
      signal,
      {},
    );
    expect(errorOf(result)).toBeUndefined();
    const asset = valueOf(result) as Record<string, unknown>;
    expect(asset).toEqual({
      assetId: expect.stringMatching(/^asset_/),
      mime: 'image/png',
      bytes: png.byteLength,
    });
    expect(asset).not.toHaveProperty('sha256');
    expect(asset).not.toHaveProperty('createdAt');
    expect(asset).not.toHaveProperty('name');
    const stored = await assets!.read(String(asset.assetId));
    expect(stored?.record.name).toBe('图.png');
    expect(Buffer.from(stored!.data)).toEqual(Buffer.from(png));
    await store.close();
  });

  it('deduplicates identical uploads by content', async () => {
    const { store, handler } = await createHandler();
    const importOnce = async (bytes: Uint8Array) =>
      valueOf(
        await handler(
          'doc.importAsset',
          {
            args: [
              {
                mime: 'image/png',
                dataBase64: Buffer.from(bytes).toString('base64'),
              },
            ],
          },
          signal,
          {},
        ),
      ) as { assetId: string };
    const first = await importOnce(png);
    const again = await importOnce(png);
    const other = await importOnce(new Uint8Array([...png, 9]));
    expect(again.assetId).toBe(first.assetId);
    expect(other.assetId).not.toBe(first.assetId);
    await store.close();
  });

  it('rejects unsupported mime, malformed base64 and bad arguments', async () => {
    const { store, handler } = await createHandler();
    const importAsset = (args: unknown) =>
      handler('doc.importAsset', { args: [args] }, signal, {});

    const svg = await importAsset({
      mime: 'image/svg+xml',
      dataBase64: PNG_BASE64,
    });
    expect(errorOf(svg)?.code).toBe('object/invalid');
    expect(errorOf(svg)?.message).toContain('不支持的资产类型');
    // The image channel stays closed to file mimes.
    for (const mime of ['application/pdf', 'text/plain']) {
      const rejected = await importAsset({ mime, dataBase64: PNG_BASE64 });
      expect(errorOf(rejected)?.code).toBe('object/invalid');
      expect(errorOf(rejected)?.message).toContain('不支持的资产类型');
    }

    for (const dataBase64 of ['', 'abc', 'not base64!!', 'AAA A', 'A===']) {
      const bad = await importAsset({ mime: 'image/png', dataBase64 });
      expect(errorOf(bad)?.code).toBe('object/invalid');
      expect(errorOf(bad)?.message).toMatch(/资产内容|base64/);
    }

    const badArgs: unknown[] = [
      undefined,
      'nope',
      { dataBase64: PNG_BASE64 },
      { mime: 42, dataBase64: PNG_BASE64 },
      { mime: 'image/png' },
      { mime: 'image/png', dataBase64: PNG_BASE64, name: 7 },
    ];
    for (const args of badArgs) {
      const bad = await importAsset(args);
      expect(errorOf(bad)?.code).toBe('object/invalid');
    }
    await store.close();
  });

  it('rejects payloads larger than the asset limit', async () => {
    const { store, handler } = await createHandler();
    const importAsset = (dataBase64: string) =>
      handler(
        'doc.importAsset',
        { args: [{ mime: 'image/png', dataBase64 }] },
        signal,
        {},
      );
    const oversized = Buffer.alloc(MAX_ASSET_BYTES + 1).toString('base64');
    const decodedTooLarge = await importAsset(oversized);
    expect(errorOf(decodedTooLarge)?.code).toBe('object/invalid');
    expect(errorOf(decodedTooLarge)?.message).toContain(String(MAX_ASSET_BYTES));
    // Guarded before decoding so a pathological payload cannot be buffered.
    const encodedTooLarge = await importAsset(
      'A'.repeat(Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4),
    );
    expect(errorOf(encodedTooLarge)?.code).toBe('object/invalid');
    expect(errorOf(encodedTooLarge)?.message).toContain('资产超过上限');
    await store.close();
  });

  it('reports doc/unavailable when no asset store is attached', async () => {
    const { store, handler } = await createHandler({ assets: false });
    const result = await handler(
      'doc.importAsset',
      { args: [{ mime: 'image/png', dataBase64: PNG_BASE64 }] },
      signal,
      {},
    );
    expect(errorOf(result)?.code).toBe('doc/unavailable');
    await store.close();
  });
});

describe('doc.importFile RPC', () => {
  it('imports a browser-uploaded file and returns its public fields', async () => {
    const { store, handler, assets } = await createHandler();
    const result = await handler(
      'doc.importFile',
      {
        args: [
          {
            mime: 'application/pdf',
            dataBase64: PDF_BASE64,
            name: ' 报告.pdf ',
          },
        ],
      },
      signal,
      {},
    );
    expect(errorOf(result)).toBeUndefined();
    const file = valueOf(result) as Record<string, unknown>;
    expect(file).toEqual({
      assetId: expect.stringMatching(/^asset_/),
      mime: 'application/pdf',
      bytes: pdf.byteLength,
      name: '报告.pdf',
    });
    expect(file).not.toHaveProperty('sha256');
    expect(file).not.toHaveProperty('createdAt');
    expect(file).not.toHaveProperty('width');
    const stored = await assets!.read(String(file.assetId));
    expect(stored?.record.name).toBe('报告.pdf');
    expect(Buffer.from(stored!.data)).toEqual(Buffer.from(pdf));
    await store.close();
  });

  it('accepts image mimes through the file channel', async () => {
    const { store, handler } = await createHandler();
    const result = await handler(
      'doc.importFile',
      { args: [{ mime: 'image/png', dataBase64: PNG_BASE64 }] },
      signal,
      {},
    );
    expect(errorOf(result)).toBeUndefined();
    expect(valueOf(result)).toMatchObject({
      mime: 'image/png',
      bytes: png.byteLength,
    });
    expect(valueOf(result)).not.toHaveProperty('name');
    await store.close();
  });

  it('deduplicates identical file uploads by content', async () => {
    const { store, handler } = await createHandler();
    const importOnce = async (bytes: Uint8Array) =>
      valueOf(
        await handler(
          'doc.importFile',
          {
            args: [
              {
                mime: 'application/pdf',
                dataBase64: Buffer.from(bytes).toString('base64'),
              },
            ],
          },
          signal,
          {},
        ),
      ) as { assetId: string };
    const first = await importOnce(pdf);
    const again = await importOnce(pdf);
    const other = await importOnce(new Uint8Array([...pdf, 9]));
    expect(again.assetId).toBe(first.assetId);
    expect(other.assetId).not.toBe(first.assetId);
    await store.close();
  });

  it('downgrades unknown or executable mime to a generic attachment', async () => {
    const { store, handler, assets } = await createHandler();
    const mimes = [
      'text/html',
      'image/svg+xml',
      'application/javascript',
      'application/octet-stream',
      'application/x-sketch',
    ];
    for (const [index, mime] of mimes.entries()) {
      const result = await handler(
        'doc.importFile',
        {
          args: [
            {
              mime,
              name: `设计稿-${index}.sketch`,
              dataBase64: Buffer.from([index + 1, 9, 4]).toString('base64'),
            },
          ],
        },
        signal,
        {},
      );
      expect(errorOf(result)).toBeUndefined();
      const file = valueOf(result) as Record<string, unknown>;
      expect(file['mime']).toBe('application/octet-stream');
      expect(file['name']).toBe(`设计稿-${index}.sketch`);
      const stored = await assets!.read(String(file['assetId']));
      expect(stored?.record.mime).toBe('application/octet-stream');
      expect(stored?.record.name).toBe(`设计稿-${index}.sketch`);
    }
    await store.close();
  });

  it('rejects malformed base64 and bad arguments', async () => {
    const { store, handler } = await createHandler();
    const importFile = (args: unknown) =>
      handler('doc.importFile', { args: [args] }, signal, {});

    for (const dataBase64 of ['', 'abc', 'not base64!!', 'AAA A', 'A===']) {
      const bad = await importFile({ mime: 'application/pdf', dataBase64 });
      expect(errorOf(bad)?.code).toBe('object/invalid');
      expect(errorOf(bad)?.message).toMatch(/文件内容|base64/);
    }

    const badArgs: unknown[] = [
      undefined,
      'nope',
      { dataBase64: PDF_BASE64 },
      { mime: 42, dataBase64: PDF_BASE64 },
      { mime: 'application/pdf' },
      { mime: 'application/pdf', dataBase64: PDF_BASE64, name: 7 },
    ];
    for (const args of badArgs) {
      const bad = await importFile(args);
      expect(errorOf(bad)?.code).toBe('object/invalid');
    }
    await store.close();
  });

  it('rejects payloads larger than the file limit', async () => {
    const { store, handler } = await createHandler();
    const importFile = (dataBase64: string) =>
      handler(
        'doc.importFile',
        { args: [{ mime: 'application/pdf', dataBase64 }] },
        signal,
        {},
      );
    const oversized = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
    const decodedTooLarge = await importFile(oversized);
    expect(errorOf(decodedTooLarge)?.code).toBe('doc/too-large');
    expect(errorOf(decodedTooLarge)?.message).toContain(String(MAX_FILE_BYTES));
    // Guarded before decoding so a pathological payload cannot be buffered.
    const encodedTooLarge = await importFile(
      'A'.repeat(Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4),
    );
    expect(errorOf(encodedTooLarge)?.code).toBe('doc/too-large');
    expect(errorOf(encodedTooLarge)?.message).toContain('文件超过上限');
    await store.close();
  });

  it('reports doc/unavailable when no asset store is attached', async () => {
    const { store, handler } = await createHandler({ assets: false });
    const result = await handler(
      'doc.importFile',
      { args: [{ mime: 'application/pdf', dataBase64: PDF_BASE64 }] },
      signal,
      {},
    );
    expect(errorOf(result)?.code).toBe('doc/unavailable');
    await store.close();
  });
});

describe('Space RPC with the workspace bridge', () => {
  it('rejects a new Space without a primary working directory', async () => {
    const { store, handler } = await createHandler({ workspaceSync: true });
    const result = await handler(
      'space.createSpace',
      { args: [{ name: '无目录' }] },
      signal,
      {},
    );
    expect(errorOf(result)?.code).toBe('space/workspace-required');
    const spaces = valueOf(
      await handler('space.listSpaces', { args: [] }, signal, {}),
    ) as Array<{ name: string }>;
    expect(spaces.map((space) => space.name)).not.toContain('无目录');
    await store.close();
  });

  it('creates, renames and releases the workspace through the RPC seam', async () => {
    const { home, store, handler, registry } = await createHandler({
      workspaceSync: true,
    });
    await mkdir(join(home, 'work'), { recursive: true });
    const created = valueOf(
      await handler(
        'space.createSpace',
        { args: [{ name: 'RPC 空间', directories: ['~/work'] }] },
        signal,
        {},
      ),
    ) as { id: string };
    expect(registry?.list()).toHaveLength(1);
    expect(registry?.list()[0]?.title).toBe('🪐 RPC 空间');
    expect(store.getWorkspaceLink(created.id)?.workspaceId).toBe(
      registry?.list()[0]?.id,
    );

    valueOf(
      await handler(
        'space.updateSpace',
        { args: [created.id, { name: '新名字' }] },
        signal,
        {},
      ),
    );
    expect(registry?.list()[0]?.title).toBe('🪐 新名字');

    valueOf(
      await handler('space.deleteSpace', { args: [created.id] }, signal, {}),
    );
    expect(registry?.list()).toHaveLength(1);
    expect(registry?.list()[0]?.title).toBe('新名字');
    expect(store.getWorkspaceLink(created.id)).toBeUndefined();
    await store.close();
  });

  it('keeps the legacy behaviour when no workspace registry is attached', async () => {
    const { store, handler, registry } = await createHandler();
    const created = valueOf(
      await handler(
        'space.createSpace',
        { args: [{ name: '无工作区' }] },
        signal,
        {},
      ),
    ) as { id: string };
    expect(created.id).toMatch(/^sp-/);
    expect(registry).toBeUndefined();
    expect(store.getWorkspaceLink(created.id)).toBeUndefined();
    await store.close();
  });
});

describe('document write attribution', () => {
  async function attributedHandler(actorPolicy?: 'browser' | 'passthrough') {
    const dir = await tempDir();
    let clock = new Date('2026-11-06T00:00:00.000Z');
    const now = () => clock;
    const store = await openSpaceStore({ directory: dir, now });
    const stacks = createSpaceAuthority(store, now);
    const document = createDocumentService({ store, now, actor: 'user' });
    const agentDocument = createDocumentService({ store, now, actor: 'alter' });
    const service = createStructuredSpaceService(stacks.user, document);
    const agentService = createStructuredSpaceService(stacks.alter, agentDocument);
    const handler = createSpaceRpc({
      service,
      agentService,
      storage: createSpaceStorage({ store, directory: dir }),
      document,
      agentDocument,
      ...(actorPolicy === undefined ? {} : { actorPolicy }),
    });
    return { dir, store, handler, advance: () => (clock = new Date(clock.getTime() + 10 * 60_000)) };
  }

  it('records browser writes as the user even when the payload forges an actor', async () => {
    const { store, handler, advance } = await attributedHandler();
    const generated = valueOf(
      await handler('doc.generate', { args: [{ spaceId: 'sp-inbox', markdown: '原文' }] }, signal, {}),
    ) as { docId: string; revision: number };
    advance();
    const snapshot = valueOf(
      await handler('doc.get', { args: [generated.docId] }, signal, {}),
    ) as { revision: number; doc: { blocks: Array<{ id: string; type: string }> } };
    const paragraph = snapshot.doc.blocks.find((block) => block.type === 'paragraph')!;
    await handler(
      'doc.applyOps',
      {
        args: [
          {
            docId: generated.docId,
            baseRevision: snapshot.revision,
            ops: [
              {
                op: 'update_text',
                target: paragraph.id,
                edits: [{ oldText: '原文', newText: '改过' }],
              },
            ],
            actor: 'alter',
          },
        ],
      },
      signal,
      {},
    );
    const versions = valueOf(
      await handler('space.listVersions', { args: [generated.docId] }, signal, {}),
    ) as Array<{ author: string; at: string }>;
    expect(versions[0]?.author).toBe('me');
    await store.close();
  });

  it('honours the bridge actor on the standalone server route', async () => {
    const { store, handler, advance } = await attributedHandler('passthrough');
    const generated = valueOf(
      await handler('doc.generate', { args: [{ spaceId: 'sp-inbox', markdown: '原文' }] }, signal, {}),
    ) as { docId: string; revision: number };
    advance();
    const snapshot = valueOf(
      await handler('doc.get', { args: [generated.docId] }, signal, {}),
    ) as { revision: number; doc: { blocks: Array<{ id: string; type: string }> } };
    const paragraph = snapshot.doc.blocks.find((block) => block.type === 'paragraph')!;
    await handler(
      'doc.applyOps',
      {
        args: [
          {
            docId: generated.docId,
            baseRevision: snapshot.revision,
            ops: [
              {
                op: 'update_text',
                target: paragraph.id,
                edits: [{ oldText: '原文', newText: '改过' }],
              },
            ],
            actor: 'alter',
          },
        ],
      },
      signal,
      {},
    );
    const versions = valueOf(
      await handler('space.listVersions', { args: [generated.docId] }, signal, {}),
    ) as Array<{ author: string; at: string }>;
    expect(versions[0]?.author).toBe('alter');
    await store.close();
  });
});
