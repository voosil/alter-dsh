/**
 * Connection settings, mode switching and the settings/sync control plane,
 * including a real standalone server acting as the remote authority.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpaceModeController } from '../../../host/core/mode.js';
import {
  controlPlaneOf,
  createSpaceRpcDispatch,
  createSpaceRpcGate,
} from '../../../host/core/index.js';
import {
  RPC_ENDPOINT,
  createConnectionFetchRoute,
} from '../../../host/authority/rpc.js';
import { createSettingsRpcHandler } from '../../../host/control/settings-rpc.js';
import { createConnectionAudit } from '../../../host/control/connection-audit.js';
import {
  ConnectionSettingsError,
  createConnectionSettingsStore,
  normalizeServerUrl,
  type ConnectionSettingsStore,
  type CredentialStoreLike,
} from '../../../host/control/connection-settings.js';
import { SPACE_TOKEN_CREDENTIAL_KEY } from '../../../host/control/connection-settings.js';
import {
  openRemoteCache,
  readRemoteQueueCounts,
} from '../../../host/remote/cache.js';
import { RemoteClientError } from '../../../host/remote/client.js';
import {
  TEST_TOKEN as TOKEN,
  startRuntime,
  startTestServer,
  type SpaceServerHandle,
} from '../../support/harness.js';
import { dispose, quietLogger, tempDir } from '../../support/lifecycle.js';

function startServer(): Promise<SpaceServerHandle> {
  return startTestServer();
}

/** Fake DSH credentials service used to prove the token stays out of files. */
function fakeCredentials(): CredentialStoreLike & {
  records: Map<string, { kind: string; payload?: unknown }>;
} {
  const records = new Map<string, { kind: string; payload?: unknown }>();
  return {
    records,
    async readRecord(key) {
      return records.get(key);
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, next);
      return next;
    },
    async deleteRecord(key) {
      records.delete(key);
    },
  };
}

describe('connection settings store', () => {
  it('defaults to local mode and normalizes URLs', async () => {
    const store = createConnectionSettingsStore({
      directory: await tempDir(),
      logger: quietLogger(),
    });
    const loaded = await store.load();
    expect(loaded.settings.mode).toBe('local');
    expect(loaded.settings.serverUrl).toBeNull();
    expect(loaded.token).toBeUndefined();

    expect(normalizeServerUrl('http://127.0.0.1:8787/')).toBe(
      'http://127.0.0.1:8787',
    );
    expect(normalizeServerUrl('https://example.com/base/')).toBe(
      'https://example.com/base',
    );
    expect(() => normalizeServerUrl('ftp://example.com')).toThrow(
      /http 或 https/,
    );

    const saved = await store.save({
      serverUrl: 'http://127.0.0.1:8787/',
    });
    expect(saved.settings.serverUrl).toBe('http://127.0.0.1:8787');
  });

  it('requires URL and token before entering server mode', async () => {
    const store = createConnectionSettingsStore({
      directory: await tempDir(),
      logger: quietLogger(),
    });
    await expect(store.save({ mode: 'server' })).rejects.toBeInstanceOf(
      ConnectionSettingsError,
    );
    await expect(
      store.save({ mode: 'server', serverUrl: 'http://127.0.0.1:9' }),
    ).rejects.toThrow(/token/);
  });

  it('stores the token in a 0600 file when no credential store exists', async () => {
    const directory = await tempDir();
    const store = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    await store.save({
      mode: 'server',
      serverUrl: 'http://127.0.0.1:8787',
      token: TOKEN,
    });
    const tokenFile = join(directory, 'connection.secret.json');
    expect(JSON.parse(await readFile(tokenFile, 'utf8'))).toEqual({
      token: TOKEN,
    });
    // Windows has no POSIX mode bits, so chmod(0600) is not observable there;
    // the file-content assertion above still runs on every platform.
    if (process.platform !== 'win32') {
      const mode = (await stat(tokenFile)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('writes the token first and restores it when the settings write fails', async () => {
    const directory = await tempDir();
    const store = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    await store.save({ token: 'old-token' });
    // Make the settings file un-writable without breaking the token file: the
    // rename onto an existing directory fails after the token was written.
    const { mkdir, rm } = await import('node:fs/promises');
    await rm(join(directory, 'connection.json'), { force: true });
    await mkdir(join(directory, 'connection.json'));
    await expect(
      store.save({
        mode: 'server',
        serverUrl: 'http://127.0.0.1:9',
        token: 'new-token',
      }),
    ).rejects.toBeDefined();
    // The previous token is back: a failed write must not leave the token
    // store and the mode/URL file disagreeing.
    expect((await store.load()).token).toBe('old-token');
    expect((await store.view()).mode).toBe('local');
  });

  it('prefers the DSH credential record over the file copy', async () => {
    const directory = await tempDir();
    const credentials = fakeCredentials();
    const store = createConnectionSettingsStore({
      directory,
      credentials,
      logger: quietLogger(),
    });
    await store.save({
      mode: 'server',
      serverUrl: 'http://127.0.0.1:8787',
      token: TOKEN,
    });
    expect(credentials.records.get(SPACE_TOKEN_CREDENTIAL_KEY)).toEqual({
      kind: 'grant',
      payload: { token: TOKEN },
    });
    await expect(
      stat(join(directory, 'connection.secret.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.load()).token).toBe(TOKEN);
  });
});

describe('mode switching and settings control plane', () => {
  it('switches local → server → local, routing all surfaces', async () => {
    const server = await startServer();
    const directory = await tempDir();
    const settings: ConnectionSettingsStore = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const mode = new SpaceModeController({
      directory,
      settings,
      logger: quietLogger(),
    });
    dispose(() => mode.close());
    const handler = createSettingsRpcHandler({ settings, mode, directory });

    await mode.open();
    expect(mode.current().kind).toBe('local');

    const initial = (await handler('settings.get', { op: 'settings.get', args: [] })) as {
      value: { mode: string; capabilities: { workspaceMapping: boolean } };
    };
    expect(initial.value.mode).toBe('local');
    expect(initial.value.capabilities.workspaceMapping).toBe(true);

    const test = (await handler('settings.test', {
      op: 'settings.test',
      args: [{ serverUrl: server.url, token: TOKEN }],
    })) as { value: { ok: boolean; authenticated: boolean } };
    expect(test.value.ok).toBe(true);
    expect(test.value.authenticated).toBe(true);

    const switched = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ mode: 'server', serverUrl: server.url, token: TOKEN }],
    })) as { value?: { mode: string; capabilities: { remoteDirectories: boolean } } };
    // A bare flip replaces the authority for every document, so the control
    // plane requires a migration (or an explicit `discard`) first.
    expect(switched.value?.mode).toBeUndefined();
    const required = switched as unknown as { error?: { code: string } };
    expect(required.error?.code).toBe('settings/migration-required');
    expect(mode.current().kind).toBe('local');

    const discarded = (await handler('settings.update', {
      op: 'settings.update',
      args: [
        {
          mode: 'server',
          serverUrl: server.url,
          token: TOKEN,
          discard: true,
        },
      ],
    })) as { value: { mode: string; capabilities: { remoteDirectories: boolean } } };
    expect(discarded.value.mode).toBe('server');
    expect(discarded.value.capabilities.remoteDirectories).toBe(true);
    expect(mode.current().kind).toBe('server');
    await mode.refresh();

    const created = (await mode.current().rpc('space.createSpace', {
      op: 'space.createSpace',
      args: [{ name: '远端空间' }],
    })) as { value?: { id: string; name: string } };
    expect(created.value?.name).toBe('远端空间');
    const remoteSpaces = (await mode.current().rpc('space.listSpaces', {
      op: 'space.listSpaces',
      args: [],
    })) as {
      value: Array<{ name: string }>;
    };
    expect(remoteSpaces.value.map((space) => space.name)).toContain('远端空间');

    // Agent tool surfaces run over the remote document adapter.
    const generated = await mode.current().document.generate({
      spaceId: created.value!.id,
      title: '远端文档',
      markdown: '# 标题\n\n正文',
    });
    expect(generated.docId).toMatch(/^doc-/);
    const outline = await mode.current().document.outline(generated.docId);
    expect(outline.title).toBe('远端文档');
    expect(outline.revision).toBeGreaterThanOrEqual(1);
    const imported = await mode.current().assets.import({
      data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=',
        'base64',
      ),
      mime: 'image/png',
    });
    expect(imported.id).toMatch(/^asset_/);
    expect(imported.bytes).toBeGreaterThan(0);

    const back = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ mode: 'local', discard: true }],
    })) as { value: { mode: string } };
    expect(back.value.mode).toBe('local');
    expect(mode.current().kind).toBe('local');
    const localSpaces = (await mode.current().rpc('space.listSpaces', {
      op: 'space.listSpaces',
      args: [],
    })) as {
      value: Array<{ name: string }>;
    };
    expect(localSpaces.value.map((space) => space.name)).not.toContain(
      '远端空间',
    );

    const status = (await handler('sync.status', {
      op: 'sync.status',
      args: [],
    })) as { value: { sync: { pendingWrites: number } } };
    expect(status.value.sync.pendingWrites).toBe(0);
  });

  it('reports an unreachable server and keeps the previous backend on bad config', async () => {
    const server = await startServer();
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const mode = new SpaceModeController({
      directory,
      settings,
      logger: quietLogger(),
    });
    dispose(() => mode.close());
    const handler = createSettingsRpcHandler({ settings, mode, directory });
    await mode.open();

    const failed = (await handler('settings.update', {
      op: 'settings.update',
      args: [
        {
          mode: 'server',
          serverUrl: 'http://127.0.0.1:1',
          token: TOKEN,
          discard: true,
        },
      ],
    })) as { value?: { connection: { state: string } } };
    // A remote backend is created even while offline; the initial probe may
    // already have failed by the time the settings response is built.
    expect(['connecting', 'offline']).toContain(
      failed.value?.connection.state,
    );
    await mode.refresh();
    expect(mode.status().state).toBe('offline');

    // Invalid mode is rejected without changing the committed settings.
    const rejected = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ mode: 'nonsense' }],
    })) as { error?: { code: string } };
    expect(rejected.error?.code).toBe('settings/invalid');
    expect(mode.current().kind).toBe('server');
    void server;
  });

  it('pre-configures a server URL/token in local mode without switching the authority', async () => {
    const server = await startServer();
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const mode = new SpaceModeController({
      directory,
      settings,
      logger: quietLogger(),
    });
    dispose(() => mode.close());
    const handler = createSettingsRpcHandler({ settings, mode, directory });
    await mode.open();
    const saved = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ serverUrl: server.url, token: TOKEN }],
    })) as {
      value: { mode: string; serverUrl: string; tokenConfigured: boolean };
    };
    // No `mode` in the patch: the URL/token become the migration target but
    // the local authority stays active.
    expect(saved.value.mode).toBe('local');
    expect(saved.value.serverUrl).toBe(server.url);
    expect(saved.value.tokenConfigured).toBe(true);
    expect(mode.current().kind).toBe('local');
    const again = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ serverUrl: server.url }],
    })) as { error?: { code: string }; value?: { mode: string } };
    expect(again.error).toBeUndefined();
    expect(again.value?.mode).toBe('local');
  });

  it('creates a local runtime when opening the default mode', async () => {
    const { runtime } = await startRuntime();
    const spaces = await runtime.service.listSpaces();
    expect(spaces.map((space) => space.name)).toContain('日常');
  });
});

describe('settings control-plane recovery', () => {
  it('rolls the persisted choice back when the backend switch fails', async () => {
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const failing = {
      status: () => ({ state: 'local' as const }),
      flush: async () => undefined,
      apply: async () => {
        throw new Error('backend open failed');
      },
    };
    const handler = createSettingsRpcHandler({
      settings,
      mode: failing as unknown as SpaceModeController,
      directory,
    });
    const result = (await handler('settings.update', {
      op: 'settings.update',
      args: [
        {
          mode: 'server',
          serverUrl: 'http://127.0.0.1:1',
          token: TOKEN,
          discard: true,
        },
      ],
    })) as { error?: { code: string } };
    expect(result.error?.code).toBe('settings/failed');
    const view = await settings.view();
    expect(view.mode).toBe('local');
    expect(view.serverUrl).toBeNull();
    expect(view.tokenConfigured).toBe(false);
  });

  it('refuses settings writes when only the mode lock is set', async () => {
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const handler = createSettingsRpcHandler({
      settings,
      mode: {
        status: () => ({ state: 'local' as const }),
        flush: async () => undefined,
        apply: async () => undefined,
        isMigrationLocked: () => true,
      } as unknown as SpaceModeController,
      directory,
    });
    const result = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ token: 'x' }],
    })) as { error?: { code: string } };
    expect(result.error?.code).toBe('migration/busy');
    expect((await settings.view()).tokenConfigured).toBe(false);
  });

  it('rejects configuration changes while a migration owns the authority', async () => {
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const handler = createSettingsRpcHandler({
      settings,
      mode: {
        status: () => ({ state: 'local' as const }),
        flush: async () => undefined,
        apply: async () => undefined,
      } as unknown as SpaceModeController,
      directory,
      isMigrationRunning: () => true,
    });
    const result = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ mode: 'local' }],
    })) as { error?: { code: string } };
    expect(result.error?.code).toBe('migration/busy');
    const flush = (await handler('sync.flush', {
      op: 'sync.flush',
      args: [],
    })) as { error?: { code: string } };
    expect(flush.error?.code).toBe('migration/busy');
  });
});

describe('sync queue control plane', () => {
  it('lists unsettled documents and forwards retry/discard decisions', async () => {
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const resolved: Array<{ docId: string; action: string }> = [];
    const handler = createSettingsRpcHandler({
      settings,
      mode: {
        status: () => ({
          state: 'offline' as const,
          pendingWrites: 2,
          conflicts: 1,
          failed: 0,
        }),
        flush: async () => undefined,
        apply: async () => undefined,
        queueEntries: () => [
          {
            docId: 'doc-1',
            state: 'conflict' as const,
            entries: 2,
            baseRevision: 7,
            lastError: '版本冲突',
            updatedAt: '2026-11-11T00:00:00.000Z',
          },
        ],
        resolveQueue: async (docId: string, action: string) => {
          resolved.push({ docId, action });
          return { resolved: action === 'retry' ? 2 : 1 };
        },
      } as unknown as SpaceModeController,
      directory,
    });

    const queue = (await handler('sync.queue', {
      op: 'sync.queue',
      args: [],
    })) as { value: Array<{ docId: string; state: string }> };
    expect(queue.value).toHaveLength(1);
    expect(queue.value[0]).toMatchObject({ docId: 'doc-1', state: 'conflict' });

    const retried = (await handler('sync.resolve', {
      op: 'sync.resolve',
      args: [{ docId: 'doc-1', action: 'retry' }],
    })) as { value: { resolved: number; state: { sync: { pendingWrites: number } } } };
    expect(retried.value.resolved).toBe(2);
    expect(retried.value.state.sync.pendingWrites).toBe(2);

    const discarded = (await handler('sync.resolve', {
      op: 'sync.resolve',
      args: [{ docId: 'doc-1', action: 'discard' }],
    })) as { value: { resolved: number } };
    expect(discarded.value.resolved).toBe(1);
    expect(resolved).toEqual([
      { docId: 'doc-1', action: 'retry' },
      { docId: 'doc-1', action: 'discard' },
    ]);
  });

  it('rejects malformed decisions and refuses to resolve during a migration', async () => {
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const mode = {
      status: () => ({ state: 'offline' as const }),
      flush: async () => undefined,
      apply: async () => undefined,
      queueEntries: () => [],
      resolveQueue: async () => ({ resolved: 0 }),
    } as unknown as SpaceModeController;
    const handler = createSettingsRpcHandler({ settings, mode, directory });

    const missingDoc = (await handler('sync.resolve', {
      op: 'sync.resolve',
      args: [{ action: 'retry' }],
    })) as { error?: { code: string } };
    expect(missingDoc.error?.code).toBe('settings/invalid');

    const badAction = (await handler('sync.resolve', {
      op: 'sync.resolve',
      args: [{ docId: 'doc-1', action: 'merge' }],
    })) as { error?: { code: string } };
    expect(badAction.error?.code).toBe('settings/invalid');

    const frozen = createSettingsRpcHandler({
      settings,
      mode,
      directory,
      isMigrationRunning: () => true,
    });
    const busy = (await frozen('sync.resolve', {
      op: 'sync.resolve',
      args: [{ docId: 'doc-1', action: 'retry' }],
    })) as { error?: { code: string } };
    expect(busy.error?.code).toBe('migration/busy');
  });
});

describe('migration freeze and the control plane', () => {
  it('keeps settings/sync/migration reachable while business writes are frozen', async () => {
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    let locked = false;
    const mode = {
      status: () => ({ state: 'local' as const }),
      flush: async () => undefined,
      apply: async () => undefined,
      queueEntries: () => [],
      isMigrationLocked: () => locked,
    } as unknown as SpaceModeController;
    const settingsHandler = createSettingsRpcHandler({
      settings,
      mode,
      directory,
      isMigrationRunning: () => locked,
    });
    const backendCalls: string[] = [];
    const route = createConnectionFetchRoute(
      createSpaceRpcDispatch({
        gate: createSpaceRpcGate(() => locked),
        settingsHandler,
        migrationHandler: async (endpoint) => ({ value: { migration: endpoint } }),
        backend: () => ({
          rpc: async (endpoint: string) => {
            backendCalls.push(endpoint);
            return { value: { endpoint } };
          },
        }),
      }),
    );
    async function call(
      op: string,
      args: unknown[] = [],
    ): Promise<{ value?: unknown; error?: { code?: string } }> {
      const response = await route(
        new Request('http://dsh.internal/api/alter-space', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'rpc-1',
            method: RPC_ENDPOINT,
            payload: { op, args },
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: { ok: boolean; value?: { value?: unknown; error?: { code?: string } } };
      };
      expect(body.result.ok).toBe(true);
      return body.result.value ?? {};
    }

    locked = true;
    // Control-plane endpoints stay reachable: that is how the user recovers
    // from a migration and how the panel shows its state.
    expect((await call('migration.status')).value).toEqual({
      migration: 'migration.status',
    });
    expect((await call('migration.preflight', [{ direction: 'to-server' }])).value)
      .toEqual({ migration: 'migration.preflight' });
    const snapshot = (await call('settings.get')).value as { mode?: string };
    expect(snapshot.mode).toBe('local');
    expect((await call('sync.status')).value).toMatchObject({ mode: 'local' });
    // Read-only business calls stay allowed.
    expect((await call('space.listSpaces')).value).toEqual({
      endpoint: 'space.listSpaces',
    });
    // Mutating business calls are frozen with a stable code.
    expect((await call('space.createSpace', [{ name: 'x' }])).error?.code).toBe(
      'migration/read-only',
    );
    expect(backendCalls).toEqual(['space.listSpaces']);
    // Control handlers still answer `migration/busy` for their own writes.
    expect(
      (await call('settings.update', [{ token: 'x' }])).error?.code,
    ).toBe('migration/busy');
    // Unknown control methods are served by the control handler (not treated
    // as business writes and not forwarded to the authority).
    expect((await call('settings.futureMethod')).error?.code).toBe(
      'settings/not-found',
    );
    // Unknown business endpoints are non-read-only: frozen while locked.
    expect((await call('space.futureWrite')).error?.code).toBe(
      'migration/read-only',
    );

    locked = false;
    expect((await call('space.futureWrite')).value).toEqual({
      endpoint: 'space.futureWrite',
    });
    expect(controlPlaneOf('settings.get')).toBe('settings');
    expect(controlPlaneOf('sync.resolve')).toBe('settings');
    expect(controlPlaneOf('migration.start')).toBe('migration');
    expect(controlPlaneOf('space.createSpace')).toBeUndefined();
  });

  it('drains admitted calls before a freeze completes and refuses new writes', async () => {
    let locked = false;
    const gate = createSpaceRpcGate(() => locked);
    const release = gate.admitCall(true);
    expect(release).toBeDefined();
    locked = true;
    let drained = false;
    const drain = gate.awaitDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(gate.admitCall(true)).toBeUndefined();
    const readRelease = gate.admitCall(false);
    expect(readRelease).toBeDefined();
    readRelease?.();
    release?.();
    await drain;
    expect(drained).toBe(true);
  });
});

describe('settings control-plane guards', () => {
  async function queueOneWrite(
    directory: string,
    serverUrl: string,
  ): Promise<void> {
    const cache = openRemoteCache(directory, serverUrl);
    cache.enqueue({
      docId: 'doc-queued',
      endpoint: 'doc.applyOps',
      payload: { docId: 'doc-queued', baseRevision: 1, ops: [] },
      idempotencyKey: 'idem-queued',
      baseRevision: 1,
      now: Date.now(),
    });
    cache.close();
  }

  /** Fake mode controller; `apply` is a no-op so the switch logic is isolated. */
  function fakeMode(): SpaceModeController {
    return {
      status: () => ({ state: 'offline' as const }),
      flush: async () => undefined,
      apply: async () => undefined,
      queueEntries: () => [],
      isMigrationLocked: () => false,
    } as unknown as SpaceModeController;
  }

  function handlerFor(
    directory: string,
    settings: ConnectionSettingsStore,
  ): ReturnType<typeof createSettingsRpcHandler> {
    const audit = createConnectionAudit(directory);
    return createSettingsRpcHandler({
      settings,
      mode: fakeMode(),
      directory,
      audit,
    });
  }

  /** Audit writes are fire-and-forget appends; wait for the expected line. */
  async function waitForAudit(
    directory: string,
    ready: (lines: Array<Record<string, unknown>>) => boolean,
  ): Promise<Array<Record<string, unknown>>> {
    const file = join(directory, 'connection-audit.jsonl');
    // The audit trail is appended off the request path (fire-and-forget), so a
    // loaded machine can delay the flush well past the first few hundred ms; a
    // tight deadline turned that into a rare red run.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const lines = (await readFile(file, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        if (ready(lines)) return lines;
      } catch {
        // The file does not exist yet; record() appends asynchronously.
      }
      if (Date.now() > deadline) throw new Error('audit trail was not flushed');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('requires an explicit discard when the old server scope still has queued writes', async () => {
    const directory = await tempDir();
    const oldUrl = 'http://127.0.0.1:9';
    const newUrl = 'http://127.0.0.1:10';
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    await settings.save({ mode: 'server', serverUrl: oldUrl, token: TOKEN });
    await queueOneWrite(directory, oldUrl);
    const handler = handlerFor(directory, settings);
    const rejected = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ serverUrl: newUrl }],
    })) as { error?: { code: string } };
    expect(rejected.error?.code).toBe('settings/migration-required');
    expect((await settings.view()).serverUrl).toBe(oldUrl);
    expect(readRemoteQueueCounts(directory, oldUrl).pending).toBe(1);

    const accepted = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ serverUrl: newUrl, discard: true }],
    })) as { value: { serverUrl: string } };
    expect(accepted.value.serverUrl).toBe(newUrl);
    // The old scope is no longer addressed: its queue is gone so it can never
    // be replayed against the new authority.
    expect(readRemoteQueueCounts(directory, oldUrl)).toEqual({
      pending: 0,
      conflicts: 0,
      failed: 0,
    });
    const lines = await waitForAudit(directory, (all) =>
      all.some((line) => line.action === 'sync'),
    );
    expect(lines.map((line) => line.action)).toContain('server');
    expect(lines.map((line) => line.action)).toContain('sync');
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it('removes the old remote cache when flipping back to local', async () => {
    const directory = await tempDir();
    const serverUrl = 'http://127.0.0.1:9';
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    await settings.save({ mode: 'server', serverUrl, token: TOKEN });
    await queueOneWrite(directory, serverUrl);
    const handler = handlerFor(directory, settings);
    const withoutDiscard = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ mode: 'local' }],
    })) as { error?: { code: string } };
    expect(withoutDiscard.error?.code).toBe('settings/migration-required');
    const flipped = (await handler('settings.update', {
      op: 'settings.update',
      args: [{ mode: 'local', discard: true }],
    })) as { value: { mode: string } };
    expect(flipped.value.mode).toBe('local');
    expect(readRemoteQueueCounts(directory, serverUrl)).toEqual({
      pending: 0,
      conflicts: 0,
      failed: 0,
    });
    const lines = await waitForAudit(directory, (all) =>
      all.some((line) => line.action === 'sync'),
    );
    expect(lines.map((line) => line.action)).toContain('mode');
    expect(lines.map((line) => line.action)).toContain('sync');
  });

  it('passes RemoteClientError codes through sync.resolve', async () => {
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const mode = {
      status: () => ({ state: 'offline' as const }),
      flush: async () => undefined,
      apply: async () => undefined,
      queueEntries: () => [],
      isMigrationLocked: () => false,
      resolveQueue: async () => {
        throw new RemoteClientError(
          'remote/unavailable',
          '重试需要连接服务端以确认最新版本；请恢复连接后重试',
        );
      },
    } as unknown as SpaceModeController;
    const handler = createSettingsRpcHandler({ settings, mode, directory });
    const result = (await handler('sync.resolve', {
      op: 'sync.resolve',
      args: [{ docId: 'doc-1', action: 'retry' }],
    })) as { error?: { code: string } };
    expect(result.error?.code).toBe('remote/unavailable');
  });

  it('audits distinct mode/server/token changes with tokenChanged and no token text', async () => {
    const directory = await tempDir();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    const handler = handlerFor(directory, settings);
    await handler('settings.update', {
      op: 'settings.update',
      args: [
        {
          mode: 'server',
          serverUrl: 'http://127.0.0.1:9',
          token: TOKEN,
          discard: true,
        },
      ],
    });
    const secondToken = 'audit-only-second-token';
    await handler('settings.update', {
      op: 'settings.update',
      args: [{ token: secondToken }],
    });
    const lines = await waitForAudit(directory, (all) =>
      all.some((line) => line.action === 'token'),
    );
    expect(lines.map((line) => line.action)).toContain('mode');
    expect(lines.map((line) => line.action)).toContain('server');
    expect(lines.map((line) => line.action)).toContain('token');
    expect(lines.some((line) => line.tokenChanged === true)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).not.toContain(secondToken);
  });
});
