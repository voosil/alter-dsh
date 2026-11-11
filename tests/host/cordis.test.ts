/**
 * End-to-end Host wiring against the real Cordis kernel.
 *
 * The other host tests double the Cordis context; this one boots an actual
 * `Context` with a fake `connection` and `workspaceRegistry` service so the
 * `ctx.inject(['workspaceRegistry'])` attachment, the RPC route, and the
 * workspace-feed boundary run on the same plugin framework DSH uses.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';
import { apply, type HostContextLike } from '../../host/core/index.js';
import { RPC_ENDPOINT, RPC_ROUTE_PATH } from '../../host/authority/rpc.js';
import { FakeWorkspaceRegistry } from '../workspace/fixtures.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-cordis-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Harness {
  root: Context;
  registry: FakeWorkspaceRegistry;
  routePath: string;
  call: (op: string, args?: unknown[]) => Promise<unknown>;
  dispose: () => Promise<void>;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for route registration');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function boot(dataDir: string): Promise<Harness> {
  const registry = new FakeWorkspaceRegistry();
  let routePath = '';
  const routes = new Map<string, (request: Request) => Promise<Response>>();
  const root = new Context();
  // Stand-in for DSH Connection: owns the fetch route registry.
  root.plugin((ctx) => {
    ctx.provide('connection', {
      fetch: {
        register(route: {
          path: string;
          fetch: (request: Request) => Promise<Response>;
        }) {
          if (routePath === '') routePath = route.path;
          routes.set(route.path, route.fetch);
          return () => undefined;
        },
      },
    });
  });
  // Stand-in for the DSH workspace registry Host service.
  root.plugin((ctx) => {
    ctx.provide('workspaceRegistry', registry);
  });
  await root.plugin(
    {
      name: '@alter-dsh/space',
      inject: ['connection'],
      apply: (ctx: Context, config: { dataDir: string }) =>
        apply(ctx as unknown as HostContextLike, config),
    },
    { dataDir },
  );
  // The plugin opens SQLite and attaches injected services asynchronously; wait
  // for the route instead of assuming a fixed scheduling latency.
  await waitFor(() => routePath === RPC_ROUTE_PATH);
  return {
    root,
    registry,
    routePath,
    call: async (op, args = []) => {
      const rpcRoute = routes.get(RPC_ROUTE_PATH);
      if (rpcRoute === undefined) throw new Error('route is not registered');
      const response = await rpcRoute(
        new Request(`http://dsh.internal${routePath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'cordis-rpc',
            method: RPC_ENDPOINT,
            payload: { op, args },
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: { ok: boolean; value?: { value?: unknown; error?: unknown } };
      };
      expect(body.result.ok).toBe(true);
      const payload = body.result.value ?? {};
      if (payload.error !== undefined)
        throw new Error(JSON.stringify(payload.error));
      return payload.value ?? undefined;
    },
    dispose: async () => {
      await root.fiber.dispose();
    },
  };
}

describe('Host plugin on the real Cordis kernel', () => {
  it('injects the workspace registry and drives the mapping end to end', async () => {
    const dataDir = await tempDir();
    const workspaceDir = await tempDir();
    const harness = await boot(dataDir);
    expect(harness.routePath).toBe(RPC_ROUTE_PATH);

    const created = (await harness.call('space.createSpace', [
      { name: '内核空间', directories: [workspaceDir] },
    ])) as { id: string; name: string };
    expect(created.name).toBe('内核空间');
    expect(harness.registry.list()).toHaveLength(1);
    const workspace = harness.registry.list()[0]!;
    expect(workspace.path).toBe(await realpath(workspaceDir));
    expect(workspace.title).toBe('🪐 内核空间');

    await harness.call('space.updateSpace', [created.id, { name: '改名后' }]);
    expect(harness.registry.list()[0]?.title).toBe('🪐 改名后');

    await harness.call('space.deleteSpace', [created.id]);
    expect(harness.registry.list()).toHaveLength(1);
    expect(harness.registry.list()[0]?.title).toBe('改名后');
    await harness.dispose();
  });

  it('still creates Spaces without a registry service (degraded host)', async () => {
    const dataDir = await tempDir();
    const root = new Context();
    const routes = new Map<string, (request: Request) => Promise<Response>>();
    root.plugin((ctx) => {
      ctx.provide('connection', {
        fetch: {
          register(route: {
            path: string;
            fetch: (request: Request) => Promise<Response>;
          }) {
            routes.set(route.path, route.fetch);
            return () => undefined;
          },
        },
      });
    });
    await root.plugin(
      {
        name: '@alter-dsh/space',
        inject: ['connection'],
        apply: (ctx: Context, config: { dataDir: string }) =>
          apply(ctx as unknown as HostContextLike, config),
      },
      { dataDir },
    );
    await waitFor(() => routes.has(RPC_ROUTE_PATH));
    const response = await routes.get(RPC_ROUTE_PATH)!(
      new Request(`http://dsh.internal${RPC_ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'cordis-rpc',
          method: RPC_ENDPOINT,
          payload: { op: 'space.createSpace', args: [{ name: '降级空间' }] },
        }),
      }),
    );
    const body = (await response.json()) as {
      result: { ok: boolean; value: unknown };
    };
    expect(body.result.ok).toBe(true);
    expect(body.result.value).toBeTruthy();
    await root.fiber.dispose();
  });
});
