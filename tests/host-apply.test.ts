import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apply,
  resolveDataDirectory,
  type HostContextLike,
} from '../host/index.js';
import { RPC_ENDPOINT, RPC_ROUTE_PATH } from '../host/rpc.js';
import { SPACE_DB_FILE, openSpaceStore } from '../host/store.js';
import type { SpaceRpcHandler } from '../host/rpc.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-apply-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Harness {
  ctx: HostContextLike;
  routePath: () => string | undefined;
  call: (op: string, args?: unknown[]) => Promise<unknown>;
  teardown: () => Promise<void>;
}

function createHarness(): Harness {
  let registeredPath: string | undefined;
  let routeFetch: ((request: Request) => Promise<Response>) | undefined;
  const disposers: Array<() => unknown> = [];
  const ctx = {
    connection: {
      fetch: {
        register(route: {
          path: string;
          fetch: (request: Request) => Promise<Response>;
        }) {
          registeredPath = route.path;
          routeFetch = route.fetch;
          return () => undefined;
        },
      },
    },
    logger: { info: () => undefined, warn: () => undefined },
    effect: async (execute: () => unknown) => {
      const dispose = await execute();
      if (typeof dispose === 'function')
        disposers.push(dispose as () => unknown);
      return dispose;
    },
  } as unknown as HostContextLike;
  return {
    ctx,
    routePath: () => registeredPath,
    call: async (op: string, args: unknown[] = []) => {
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
