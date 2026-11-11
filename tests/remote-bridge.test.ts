/**
 * Remote bridge: read-through cache, optimistic queued edits, replay after
 * reconnect, conflicts and asset caching against a real standalone server.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteBridge, type RemoteBridge } from '../host/remote/bridge.js';
import { openRemoteCache } from '../host/remote/cache.js';
import { DatabaseSync } from 'node:sqlite';
import {
  RemoteClientError,
  RemoteSpaceClient,
} from '../host/remote/client.js';
import {
  startSpaceServer,
  type RunningSpaceServer,
} from '../server/index.js';
import type { Operation } from '../host/document/types.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'space-bridge-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => undefined);
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function quiet(): { info: (message: string) => void; warn: (message: string) => void } {
  return { info: () => undefined, warn: () => undefined };
}

interface Harness {
  server: RunningSpaceServer;
  bridge: RemoteBridge;
  dataDir: string;
  localDir: string;
  port: number;
}

async function startHarness(): Promise<Harness> {
  const dataDir = await tempDir();
  const localDir = await tempDir();
  const server = await startServer(dataDir, 0);
  const port = Number(new URL(server.url).port);
  const bridge = createRemoteBridge({
    baseUrl: server.url,
    token: TOKEN,
    directory: localDir,
    logger: quiet(),
  });
  cleanups.push(async () => {
    await bridge.close();
    await server.close();
  });
  await bridge.refresh();
  return { server, bridge, dataDir, localDir, port };
}

async function startServer(
  dataDir: string,
  port: number,
): Promise<RunningSpaceServer> {
  return startSpaceServer(
    {
      dataDir,
      host: '127.0.0.1',
      port,
      tokens: [{ label: 'test', token: TOKEN }],
      snapshots: false,
    },
    quiet(),
  );
}

function valueOf(result: unknown): Record<string, unknown> {
  const value = (result as { value?: unknown }).value;
  if (typeof value !== 'object' || value === null)
    throw new Error('expected business value');
  return value as Record<string, unknown>;
}

function rpcCall(
  endpoint: string,
  args: unknown[],
): { op: string; args: unknown[] } {
  return { op: endpoint, args };
}

async function createDoc(bridge: RemoteBridge): Promise<string> {
  const space = valueOf(
    await bridge.rpc(
      'space.createSpace',
      rpcCall('space.createSpace', [{ name: '远端空间' }]),
    ),
  );
  const generated = valueOf(
    await bridge.rpc(
      'doc.generate',
      rpcCall('doc.generate', [
        {
          spaceId: space.id as string,
          title: '远端文档',
          markdown: '# 标题\n\n第一段',
        },
      ]),
    ),
  );
  return generated.docId as string;
}

async function seedShadow(
  bridge: RemoteBridge,
  docId: string,
): Promise<number> {
  const read = valueOf(
    await bridge.rpc('doc.get', rpcCall('doc.get', [docId])),
  );
  return read.revision as number;
}

const INSERT_OP: Operation = {
  op: 'insert_markdown',
  index: 1,
  markdown: '离线追加的段落',
};

describe('remote bridge cache and outbox', () => {
  it('serves cached reads and queues document edits while offline', async () => {
    const harness = await startHarness();
    const docId = await createDoc(harness.bridge);
    const revision = await seedShadow(harness.bridge, docId);
    expect(revision).toBeGreaterThanOrEqual(1);

    // Read cache: a successful list read is available after the link drops.
    const spaces = valueOf(
      await harness.bridge.rpc(
        'space.listSpaces',
        rpcCall('space.listSpaces', []),
      ),
    );
    expect(Array.isArray(spaces)).toBe(true);

    await harness.server.close();

    const cachedSpaces = valueOf(
      await harness.bridge.rpc(
        'space.listSpaces',
        rpcCall('space.listSpaces', []),
      ),
    );
    expect(Array.isArray(cachedSpaces)).toBe(true);

    const queued = valueOf(
      await harness.bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          {
            docId,
            baseRevision: revision,
            ops: [INSERT_OP],
          },
        ]),
      ),
    );
    expect(queued.revision).toBe(revision + 1);
    expect(harness.bridge.status.state).toBe('offline');
    expect(harness.bridge.status.pendingWrites).toBe(1);

    // Offline reads of the document come from the local shadow with the edit.
    const shadow = valueOf(
      await harness.bridge.rpc('doc.get', rpcCall('doc.get', [docId])),
    );
    expect(shadow.revision).toBe(revision + 1);

    // Reconnect the same data directory and replay the queue.
    const restarted = await startServer(harness.dataDir, harness.port);
    cleanups.push(() => restarted.close());
    await harness.bridge.refresh();
    await harness.bridge.flush();
    expect(harness.bridge.status.state).toBe('online');
    expect(harness.bridge.status.pendingWrites).toBe(0);
    expect(harness.bridge.status.conflicts).toBe(0);

    const synced = valueOf(
      await harness.bridge.rpc('doc.get', rpcCall('doc.get', [docId])),
    );
    expect(synced.revision).toBe(revision + 1);
    expect(JSON.stringify(synced.doc)).toContain('离线追加的段落');
  });

  it('marks a queued edit as a conflict when another device wrote first', async () => {
    const harness = await startHarness();
    const docId = await createDoc(harness.bridge);
    const revision = await seedShadow(harness.bridge, docId);
    await harness.server.close();

    valueOf(
      await harness.bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          { docId, baseRevision: revision, ops: [INSERT_OP] },
        ]),
      ),
    );
    expect(harness.bridge.status.pendingWrites).toBe(1);

    const restarted = await startServer(harness.dataDir, harness.port);
    cleanups.push(() => restarted.close());

    // A second device writes at the same base revision before replay.
    const other = new RemoteSpaceClient({
      baseUrl: restarted.url,
      token: TOKEN,
    });
    await other.call('doc.applyOps', [
      {
        docId,
        baseRevision: revision,
        ops: [{ op: 'insert_markdown', index: 0, markdown: '另一台设备' }],
      },
    ]);

    await harness.bridge.refresh();
    await harness.bridge.flush();
    expect(harness.bridge.status.conflicts).toBe(1);
    expect(harness.bridge.status.pendingWrites).toBe(0);

    const serverDoc = valueOf(
      await harness.bridge.rpc('doc.get', rpcCall('doc.get', [docId])),
    );
    // The local optimistic content was not silently overwritten by the replay.
    expect(serverDoc.revision).toBe(revision + 1);
  });

  it('keeps the durable queue across a bridge restart and replays it', async () => {
    const harness = await startHarness();
    const docId = await createDoc(harness.bridge);
    const revision = await seedShadow(harness.bridge, docId);
    await harness.server.close();
    valueOf(
      await harness.bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          { docId, baseRevision: revision, ops: [INSERT_OP] },
        ]),
      ),
    );
    // Close the bridge (and its cache) exactly like a Host shutdown.
    await harness.bridge.close();
    const restartedBridge = createRemoteBridge({
      baseUrl: harness.server.url,
      token: TOKEN,
      directory: harness.localDir,
      logger: quiet(),
    });
    cleanups.push(() => restartedBridge.close());
    const restarted = await startServer(harness.dataDir, harness.port);
    cleanups.push(() => restarted.close());
    await restartedBridge.refresh();
    expect(restartedBridge.status.pendingWrites).toBe(1);
    await restartedBridge.flush();
    expect(restartedBridge.status.pendingWrites).toBe(0);
    const synced = valueOf(
      await restartedBridge.rpc('doc.get', rpcCall('doc.get', [docId])),
    );
    expect(JSON.stringify(synced.doc)).toContain('离线追加的段落');
  });

  it('does not reuse another server cache or replay its queue', async () => {
    const harness = await startHarness();
    const docId = await createDoc(harness.bridge);
    const revision = await seedShadow(harness.bridge, docId);
    await harness.server.close();
    valueOf(
      await harness.bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          { docId, baseRevision: revision, ops: [INSERT_OP] },
        ]),
      ),
    );
    expect(harness.bridge.status.pendingWrites).toBe(1);
    await harness.bridge.close();

    // A second, unrelated server must start from an empty queue/cache even
    // though it shares the same local data directory.
    const otherData = await tempDir();
    const otherServer = await startServer(otherData, 0);
    cleanups.push(() => otherServer.close());
    const otherBridge = createRemoteBridge({
      baseUrl: otherServer.url,
      token: TOKEN,
      directory: harness.localDir,
      logger: quiet(),
    });
    cleanups.push(() => otherBridge.close());
    await otherBridge.refresh();
    expect(otherBridge.status.pendingWrites).toBe(0);
    const read = (await otherBridge.rpc(
      'doc.get',
      rpcCall('doc.get', [docId]),
    )) as { error?: unknown };
    expect(read.error).toBeDefined();
    await otherBridge.flush();
    expect(otherBridge.status.pendingWrites).toBe(0);
  });

  it('classifies a replayed business rejection as failed, not offline', async () => {
    const localDir = await tempDir();
    const doc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [
        {
          id: 'blk_p',
          type: 'paragraph',
          attrs: {},
          content: [{ type: 'text', text: '原文' }],
        },
      ],
    };
    let online = false;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/version'))
        return new Response(
          JSON.stringify({
            product: '@alter-dsh/space',
            version: '0.0.0-test',
            protocolVersion: 1,
            databaseSchemaVersion: 3,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      const envelope = JSON.parse(String(init?.body ?? '{}')) as {
        rpcId: string;
        payload?: { op?: string };
      };
      const reply = (value: unknown) =>
        new Response(
          JSON.stringify({
            type: 'server-response',
            rpcId: envelope.rpcId,
            result: { ok: true, value },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      if (!online) throw new TypeError('network down');
      // The real route wraps the service result in `{ value }`; the envelope
      // result is that wrapper.
      if (envelope.payload?.op === 'doc.get')
        return reply({ value: { docId: 'doc-1', revision: 1, title: 'T', doc } });
      // The server rejects the replayed batch with a business error.
      return reply({ error: { code: 'node/not-found', message: '节点不存在' } });
    }) as typeof fetch;
    const bridge = createRemoteBridge({
      baseUrl: 'http://stub.invalid:8787',
      token: TOKEN,
      directory: localDir,
      fetchImpl,
      logger: quiet(),
    });
    cleanups.push(() => bridge.close());
    online = true;
    // Seed the shadow from one successful read, then go offline.
    valueOf(await bridge.rpc('doc.get', rpcCall('doc.get', ['doc-1'])));
    online = false;
    valueOf(
      await bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          {
            docId: 'doc-1',
            baseRevision: 1,
            ops: [
              {
                op: 'update_text',
                target: 'blk_p',
                edits: [{ oldText: '原文', newText: '改过' }],
              },
            ],
          },
        ]),
      ),
    );
    expect(bridge.status.pendingWrites).toBe(1);
    online = true;
    await bridge.flush();
    expect(bridge.status.state).toBe('online');
    expect(bridge.status.pendingWrites).toBe(0);
    expect(bridge.status.failed).toBe(1);
    expect(bridge.status.conflicts).toBe(0);
  });

  it('marks a corrupt queued payload failed without blocking the link', async () => {
    const harness = await startHarness();
    const docId = await createDoc(harness.bridge);
    const revision = await seedShadow(harness.bridge, docId);
    await harness.server.close();
    valueOf(
      await harness.bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          { docId, baseRevision: revision, ops: [INSERT_OP] },
        ]),
      ),
    );
    await harness.bridge.close();
    const cacheHandle = openRemoteCache(harness.localDir, harness.server.url);
    const cacheFile = cacheHandle.file;
    cacheHandle.close();
    const raw = new DatabaseSync(cacheFile);
    raw.exec("UPDATE outbox SET payload = '{' WHERE state = 'pending'");
    raw.close();
    const restartedBridge = createRemoteBridge({
      baseUrl: harness.server.url,
      token: TOKEN,
      directory: harness.localDir,
      logger: quiet(),
    });
    cleanups.push(() => restartedBridge.close());
    const restarted = await startServer(harness.dataDir, harness.port);
    cleanups.push(() => restarted.close());
    await restartedBridge.refresh();
    await restartedBridge.flush();
    expect(restartedBridge.status.state).toBe('online');
    expect(restartedBridge.status.pendingWrites).toBe(0);
    expect(restartedBridge.status.failed).toBe(1);
  });

  it('attributes Agent object writes to alter across the server hop', async () => {
    const harness = await startHarness();
    const space = valueOf(
      await harness.bridge.rpc(
        'space.createSpace',
        rpcCall('space.createSpace', [{ name: '归属空间' }]),
      ),
    );
    const generated = valueOf(
      await harness.bridge.rpc(
        'doc.generate',
        rpcCall('doc.generate', [
          {
            spaceId: space.id as string,
            title: '归属文档',
            markdown: ':::mindmap{objectId="obj_seed"}\n:::\n',
          },
        ]),
      ),
    );
    const docId = generated.docId as string;
    const read = await harness.bridge.document.read(docId);
    const block = read.blocks.find((entry) => entry.type === 'mindmap');
    expect(block).toBeDefined();

    const updated = await harness.bridge.document.updateObject({
      docId,
      blockId: block!.id,
      baseRevision: read.revision,
      payload: { root: { id: 'n1', text: '归属' } },
    });
    const record = await harness.bridge.document.getObject(
      updated.objectId,
    );
    // The server route downgrades a missing actor to `user`; the bridge must
    // stamp `alter` or an Agent edit is recorded as the user's own version.
    expect(record?.provenance?.generatedBy).toBe('alter');
  });

  it('caches asset bytes for offline reads', async () => {
    const harness = await startHarness();
    await createDoc(harness.bridge);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=',
      'base64',
    );
    const imported = await harness.bridge.assets.import({
      data: png,
      mime: 'image/png',
    });
    const url = `http://local/api/alter-space/asset?id=${encodeURIComponent(imported.id)}`;
    const first = await harness.bridge.fetchAsset(new Request(url));
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer()).equals(png)).toBe(true);

    await harness.server.close();
    const second = await harness.bridge.fetchAsset(new Request(url));
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer()).equals(png)).toBe(true);
    expect(harness.bridge.status.state).toBe('offline');
    void RemoteClientError;
  });
});
