/**
 * Remote bridge: read-through cache, optimistic queued edits, replay after
 * reconnect, conflicts and asset caching against a real standalone server.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteBridge, type RemoteBridge } from '../../../host/remote/bridge.js';
import { openRemoteCache } from '../../../host/remote/cache.js';
import { DatabaseSync } from 'node:sqlite';
import {
  RemoteClientError,
  RemoteSpaceClient,
} from '../../../host/remote/client.js';
import {
  startSpaceServer,
  type RunningSpaceServer,
} from '../../../server/core/index.js';
import type { Operation } from '../../../host/document/editors/legacy/types.js';
import { waitFor } from '../../support/lifecycle.js';

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
  // A fixed port re-uses the closed listener's port; the OS may still hold it
  // for a moment under parallel load, so a busy port is retried.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await startSpaceServer(
        {
          dataDir,
          host: '127.0.0.1',
          port,
          tokens: [{ label: 'test', token: TOKEN }],
          snapshots: false,
        },
        quiet(),
      );
    } catch (error) {
      const busy =
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!busy || port === 0 || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
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


/** Build one valid Connection response envelope around a business value. */
function envelopeReply(rpcId: string, value: unknown): Response {
  return new Response(
    JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: true, value },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

/** Public `/version` answer for one compatible stub server. */
function versionResponse(): Response {
  return new Response(
    JSON.stringify({
      product: '@alter-dsh/space',
      version: '0.0.0-test',
      protocolVersion: 1,
      databaseSchemaVersion: 3,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

/** One minimal AlterDoc used by the stub-server tests. */
const TEST_DOC = {
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

/** The business op carried by one RPC request body. */
function bodyOp(init: RequestInit | undefined): string {
  try {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as {
      payload?: { op?: unknown };
    };
    return typeof envelope.payload?.op === 'string' ? envelope.payload.op : '';
  } catch {
    return '';
  }
}

/** One parsed RPC request body. */
function bodyEnvelope(init: RequestInit | undefined): {
  rpcId: string;
  payload?: { op?: unknown; args?: unknown[] };
} {
  return JSON.parse(String(init?.body ?? '{}')) as {
    rpcId: string;
    payload?: { op?: unknown; args?: unknown[] };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // Rebind the same port so the base URL (and its per-server cache file)
    // still matches. The old listener released the port asynchronously, so a
    // busy port under parallel load is retried rather than treated as a bug.
    const restarted = await startServer(harness.dataDir, harness.port);
    cleanups.push(() => restarted.close());
    await restartedBridge.refresh();
    // Transient `offline` after restart only means the link has not been
    // re-established yet; the work under test is the outbox replay below.
    await waitFor(() => restartedBridge.status.state === 'online', {
      message: 'bridge did not come back online',
    });
    await restartedBridge.flush();
    await waitFor(() => restartedBridge.status.pendingWrites === 0, {
      message: 'outbox did not drain',
    });
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
    // Content-addressed bytes are immutable and cached, so the second read is
    // served without touching the (now closed) server: the link state was
    // never downgraded by a failed asset request.
    expect(harness.bridge.status.state).toBe('online');
    void RemoteClientError;
  });
  it('re-arms every conflicted edit against the current revision and drains the queue', async () => {
    const harness = await startHarness();
    const docId = await createDoc(harness.bridge);
    const revision = await seedShadow(harness.bridge, docId);
    await harness.server.close();

    // Two offline edits queued against consecutive revisions.
    valueOf(
      await harness.bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          {
            docId,
            baseRevision: revision,
            ops: [
              { op: 'insert_markdown', index: 1, markdown: '离线一' },
            ],
          },
        ]),
      ),
    );
    valueOf(
      await harness.bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          {
            docId,
            baseRevision: revision + 1,
            ops: [
              { op: 'insert_markdown', index: 2, markdown: '离线二' },
            ],
          },
        ]),
      ),
    );
    expect(harness.bridge.status.pendingWrites).toBe(2);

    const restarted = await startServer(harness.dataDir, harness.port);
    cleanups.push(() => restarted.close());
    // Another device writes first, so both queued entries are stale.
    const other = new RemoteSpaceClient({ baseUrl: restarted.url, token: TOKEN });
    await other.call('doc.applyOps', [
      {
        docId,
        baseRevision: revision,
        ops: [{ op: 'insert_markdown', index: 0, markdown: '另一台设备' }],
      },
    ]);

    await harness.bridge.refresh();
    await harness.bridge.flush();
    expect(harness.bridge.status.conflicts).toBe(2);
    expect(harness.bridge.status.pendingWrites).toBe(0);

    // Retry must rewrite the payload base revision; updating only the queue
    // column left the replay sending the stale base and conflicting forever.
    const resolved = await harness.bridge.resolveQueue(docId, 'retry');
    expect(resolved.resolved).toBe(2);
    expect(harness.bridge.status.pendingWrites).toBe(0);
    expect(harness.bridge.status.conflicts).toBe(0);

    const reader = new RemoteSpaceClient({ baseUrl: restarted.url, token: TOKEN });
    const synced = await reader.call<{ revision: number; doc: unknown }>(
      'doc.get',
      [docId],
    );
    expect(synced.revision).toBe(revision + 3);
    const text = JSON.stringify(synced.doc);
    expect(text).toContain('另一台设备');
    expect(text).toContain('离线一');
    expect(text).toContain('离线二');
  });

  it('replays a write whose response was lost without a false conflict', async () => {
    const dataDir = await tempDir();
    const localDir = await tempDir();
    const server = await startServer(dataDir, 0);
    cleanups.push(() => server.close());
    let dropApplyAck = false;
    const realFetch = globalThis.fetch;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const response = await realFetch(request);
      if (dropApplyAck && bodyOp(init) === 'doc.applyOps') {
        dropApplyAck = false;
        // The server applied the batch, but the response never comes back.
        throw new TypeError(
          'connection reset after the server applied the write',
        );
      }
      return response;
    }) as typeof fetch;
    const bridge = createRemoteBridge({
      baseUrl: server.url,
      token: TOKEN,
      directory: localDir,
      fetchImpl,
      logger: quiet(),
    });
    cleanups.push(() => bridge.close());
    const docId = await createDoc(bridge);
    const revision = await seedShadow(bridge, docId);

    dropApplyAck = true;
    valueOf(
      await bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          {
            docId,
            baseRevision: revision,
            ops: [
              { op: 'insert_markdown', index: 1, markdown: '丢失确认的编辑' },
            ],
          },
        ]),
      ),
    );
    expect(bridge.status.pendingWrites).toBe(1);

    const observer = new RemoteSpaceClient({
      baseUrl: server.url,
      token: TOKEN,
    });
    const applied = await observer.call<{ revision: number }>('doc.get', [
      docId,
    ]);
    expect(applied.revision).toBe(revision + 1);

    // Flush must replay the stored request (the server deduplicates by
    // idempotency key) instead of pre-checking the revision, which would see
    // the revision this very write created and mark a conflict.
    await bridge.flush();
    expect(bridge.status.pendingWrites).toBe(0);
    expect(bridge.status.conflicts).toBe(0);
    expect(bridge.status.failed).toBe(0);

    const synced = await observer.call<{ revision: number; doc: unknown }>(
      'doc.get',
      [docId],
    );
    expect(synced.revision).toBe(revision + 1);
    expect(JSON.stringify(synced.doc).split('丢失确认的编辑').length - 1).toBe(1);
  });

  it('forces browser document writes to user and keeps Agent writes as alter', async () => {
    const captured: Array<{ op: string; actor: unknown }> = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/version')) return versionResponse();
      const envelope = bodyEnvelope(init);
      const op = envelope.payload?.op ?? '';
      if (op === 'doc.get')
        return envelopeReply(envelope.rpcId, {
          value: { docId: 'doc-1', revision: 1, title: 'T', doc: TEST_DOC },
        });
      const inputArg = envelope.payload?.args?.[0];
      captured.push({
        op,
        actor:
          typeof inputArg === 'object' && inputArg !== null
            ? (inputArg as { actor?: unknown }).actor
            : undefined,
      });
      return envelopeReply(envelope.rpcId, {
        value: {
          docId: 'doc-1',
          revision: 2,
          changedBlockIds: [],
          diff: { added: [], updated: [], removed: [] },
          warnings: [],
        },
      });
    }) as typeof fetch;
    const bridge = createRemoteBridge({
      baseUrl: 'http://stub.invalid:8787',
      token: TOKEN,
      directory: await tempDir(),
      fetchImpl,
      logger: quiet(),
    });
    cleanups.push(() => bridge.close());

    // A browser body that claims to be the Agent is overridden at the RPC
    // boundary: the server route is passthrough and trusts the bridge.
    valueOf(
      await bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          {
            docId: 'doc-1',
            baseRevision: 1,
            ops: [INSERT_OP],
            actor: 'alter',
          },
        ]),
      ),
    );
    // The Agent document port calls the bridge itself and must stay `alter`.
    await bridge.document.applyOperations({
      docId: 'doc-1',
      baseRevision: 1,
      ops: [INSERT_OP],
    });
    expect(captured.map((entry) => entry.op)).toEqual([
      'doc.applyOps',
      'doc.applyOps',
    ]);
    expect(captured.map((entry) => entry.actor)).toEqual(['user', 'alter']);
  });

  it('serves a cached read immediately while offline and revalidates in the background', async () => {
    const oldSpaces = [{ id: 'space-1', name: '旧值' }];
    const newSpaces = [{ id: 'space-1', name: '新值' }];
    let mode: 'ok' | 'down' | 'slow' = 'ok';
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/version')) return versionResponse();
      const envelope = bodyEnvelope(init);
      if (envelope.payload?.op !== 'space.listSpaces')
        throw new TypeError('unexpected op');
      if (mode === 'down') throw new TypeError('network down');
      if (mode === 'slow') {
        await sleep(300);
        return envelopeReply(envelope.rpcId, { value: newSpaces });
      }
      return envelopeReply(envelope.rpcId, { value: oldSpaces });
    }) as typeof fetch;
    const bridge = createRemoteBridge({
      baseUrl: 'http://stub.invalid:8787',
      token: TOKEN,
      directory: await tempDir(),
      fetchImpl,
      logger: quiet(),
    });
    cleanups.push(() => bridge.close());

    // Prime the cache while online.
    expect(
      valueOf(
        await bridge.rpc(
          'space.listSpaces',
          rpcCall('space.listSpaces', []),
        ),
      ),
    ).toEqual(oldSpaces);
    // A failing read marks the link offline (fast rejection, not a timeout).
    mode = 'down';
    valueOf(
      await bridge.rpc('space.listSpaces', rpcCall('space.listSpaces', [])),
    );
    expect(bridge.status.state).toBe('offline');

    mode = 'slow';
    const startedAt = Date.now();
    const cached = valueOf(
      await bridge.rpc('space.listSpaces', rpcCall('space.listSpaces', [])),
    );
    const elapsed = Date.now() - startedAt;
    expect(cached).toEqual(oldSpaces);
    // Without stale-while-revalidate this awaited the 300ms request.
    expect(elapsed).toBeLessThan(150);

    await waitFor(() => bridge.status.state === 'online', {
      message: 'background revalidation did not recover the link',
    });
    // The background refresh replaced the cached value.
    mode = 'down';
    const refreshed = valueOf(
      await bridge.rpc('space.listSpaces', rpcCall('space.listSpaces', [])),
    );
    expect(refreshed).toEqual(newSpaces);
  });

  it('queues a write whose 200 response is unreadable and replays it', async () => {
    let applyCalls = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/version')) return versionResponse();
      const envelope = bodyEnvelope(init);
      const op = envelope.payload?.op ?? '';
      if (op === 'doc.get')
        return envelopeReply(envelope.rpcId, {
          value: { docId: 'doc-1', revision: 1, title: 'T', doc: TEST_DOC },
        });
      if (op !== 'doc.applyOps') throw new TypeError('unexpected op');
      applyCalls += 1;
      if (applyCalls === 1) {
        // 200 but not an envelope (proxy page / truncated body): the write
        // outcome is unknown, so it must be queued, not dropped.
        return new Response('<html>gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return envelopeReply(envelope.rpcId, {
        value: {
          docId: 'doc-1',
          revision: 2,
          changedBlockIds: [],
          diff: { added: [], updated: [], removed: [] },
          warnings: [],
        },
      });
    }) as typeof fetch;
    const bridge = createRemoteBridge({
      baseUrl: 'http://stub.invalid:8787',
      token: TOKEN,
      directory: await tempDir(),
      fetchImpl,
      logger: quiet(),
    });
    cleanups.push(() => bridge.close());
    // Seed the shadow so the queued write has a baseline.
    valueOf(await bridge.rpc('doc.get', rpcCall('doc.get', ['doc-1'])));

    const queued = valueOf(
      await bridge.rpc(
        'doc.applyOps',
        rpcCall('doc.applyOps', [
          { docId: 'doc-1', baseRevision: 1, ops: [INSERT_OP] },
        ]),
      ),
    );
    expect(queued.revision).toBe(2);
    expect(bridge.status.pendingWrites).toBe(1);

    await bridge.flush();
    expect(bridge.status.pendingWrites).toBe(0);
    expect(bridge.status.conflicts).toBe(0);
    expect(applyCalls).toBe(2);
  });

  it('keeps the original error code when retry cannot confirm the revision', async () => {
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/version')) return versionResponse();
      void init;
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const bridge = createRemoteBridge({
      baseUrl: 'http://stub.invalid:8787',
      token: TOKEN,
      directory: await tempDir(),
      fetchImpl,
      logger: quiet(),
    });
    cleanups.push(() => bridge.close());
    // A rejected token must surface as unauthorized (repair the token), not
    // be flattened into "server unavailable" (wait for the link).
    await expect(bridge.resolveQueue('doc-1', 'retry')).rejects.toMatchObject({
      code: 'remote/unauthorized',
    });
    expect(bridge.status.state).toBe('error');
  });

});
