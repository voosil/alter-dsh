/**
 * Connection settings, mode switching and the settings/sync control plane,
 * including a real standalone server acting as the remote authority.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalSpaceRuntime } from '../host/runtime.js';
import { SpaceModeController } from '../host/mode.js';
import { createSettingsRpcHandler } from '../host/settings-rpc.js';
import {
  ConnectionSettingsError,
  createConnectionSettingsStore,
  normalizeServerUrl,
  type ConnectionSettingsStore,
  type CredentialStoreLike,
} from '../host/connection-settings.js';
import { SPACE_TOKEN_CREDENTIAL_KEY } from '../host/connection-settings.js';
import {
  startSpaceServer,
  type RunningSpaceServer,
} from '../server/index.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'space-mode-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function quietLogger(): { info: (message: string) => void; warn: (message: string) => void } {
  return { info: () => undefined, warn: () => undefined };
}

async function startServer(): Promise<RunningSpaceServer> {
  const dataDir = await tempDir();
  const server = await startSpaceServer(
    {
      dataDir,
      host: '127.0.0.1',
      port: 0,
      tokens: [{ label: 'test', token: TOKEN }],
      snapshots: false,
    },
    quietLogger(),
  );
  cleanups.push(() => server.close());
  return server;
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
    const mode = (await stat(tokenFile)).mode & 0o777;
    expect(mode).toBe(0o600);
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
    cleanups.push(() => mode.close());
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
    })) as { value: { mode: string; capabilities: { remoteDirectories: boolean } } };
    expect(switched.value.mode).toBe('server');
    expect(switched.value.capabilities.remoteDirectories).toBe(true);
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
      args: [{ mode: 'local' }],
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
    cleanups.push(() => mode.close());
    const handler = createSettingsRpcHandler({ settings, mode, directory });
    await mode.open();

    const failed = (await handler('settings.update', {
      op: 'settings.update',
      args: [
        {
          mode: 'server',
          serverUrl: 'http://127.0.0.1:1',
          token: TOKEN,
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
    const directory = await tempDir();
    const runtime = await createLocalSpaceRuntime({
      directory,
      snapshots: false,
    });
    const spaces = await runtime.service.listSpaces();
    expect(spaces.map((space) => space.name)).toContain('日常');
    await runtime.close();
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
      args: [{ mode: 'server', serverUrl: 'http://127.0.0.1:1', token: TOKEN }],
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
