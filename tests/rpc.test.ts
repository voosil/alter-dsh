import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../host/authority.js';
import {
  RPC_ENDPOINT,
  RPC_ROUTE_PATH,
  createSpaceFetchRoute,
  createSpaceRpc,
} from '../host/rpc.js';
import { createSpaceStorage } from '../host/storage.js';
import { openSpaceStore } from '../host/store.js';
import {
  createSpaceWorkspaceSync,
  type SpaceWorkspaceSync,
} from '../host/workspace-sync.js';
import { FakeWorkspaceRegistry } from './workspace-fixtures.js';

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

async function createHandler(options: { workspaceSync?: boolean } = {}) {
  const dir = await tempDir();
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const store = await openSpaceStore({ directory: dir, now: fixedNow });
  const service = createSpaceAuthority(store, fixedNow);
  const storage = createSpaceStorage({ store, directory: dir });
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
    storage,
    workspaceSync: sync === undefined ? undefined : () => sync,
  });
  return { dir, home, store, service, storage, handler, registry, sync };
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
      { args: ['missing', { content: 'x' }] },
      signal,
      {},
    );
    expect(errorOf(failure)?.code).toBe('space/failed');
    expect(errorOf(failure)?.message).toContain('文档');
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
    const service = createSpaceAuthority(store, fixedNow);
    const storage = createSpaceStorage({ store, directory: dir });
    const route = createSpaceFetchRoute({ service, storage });
    const response = await route(
      new Request('http://dsh.internal/api/alter-space', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'alter-space',
          payload: { op: 'space.listSpaces', args: [] },
        }),
      }),
    );
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
