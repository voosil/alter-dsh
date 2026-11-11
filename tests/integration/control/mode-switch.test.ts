/**
 * Connection settings, mode switching and the settings/sync control plane,
 * including a real standalone server acting as the remote authority.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpaceModeController } from '../../../host/core/mode.js';
import { createSettingsRpcHandler } from '../../../host/control/settings-rpc.js';
import {
  ConnectionSettingsError,
  createConnectionSettingsStore,
  normalizeServerUrl,
  type ConnectionSettingsStore,
  type CredentialStoreLike,
} from '../../../host/control/connection-settings.js';
import { SPACE_TOKEN_CREDENTIAL_KEY } from '../../../host/control/connection-settings.js';
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
