/**
 * Migration service + mode switch: uploading the local database to a real
 * server, switching authority, then restoring it locally.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConnectionSettingsStore,
} from '../host/connection-settings.js';
import { createMigrationService } from '../host/migration/service.js';
import { SpaceModeController } from '../host/mode.js';
import { createLocalSpaceRuntime } from '../host/runtime.js';
import {
  startSpaceServer,
  type RunningSpaceServer,
} from '../server/index.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'space-migration-svc-'));
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

async function seed(directory: string): Promise<void> {
  const runtime = await createLocalSpaceRuntime({ directory, snapshots: false });
  try {
    const space = await runtime.service.createSpace({
      name: '服务迁移',
      directories: [],
    });
    await runtime.document.generate({
      spaceId: space.id,
      title: '迁移文档',
      markdown: '# 标题\n\n正文',
    });
  } finally {
    await runtime.close();
  }
}

async function waitFor(
  service: ReturnType<typeof createMigrationService>,
): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = service.status();
    if (state.status === 'done' || state.status === 'failed' || state.status === 'cancelled')
      return state.status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('migration did not settle');
}

describe('migration service', () => {
  it('migrates local data to a server and back, switching the mode each way', async () => {
    const directory = await tempDir();
    await seed(directory);
    const serverDir = await tempDir();
    const server: RunningSpaceServer = await startSpaceServer(
      {
        dataDir: serverDir,
        host: '127.0.0.1',
        port: 0,
        tokens: [{ label: 'test', token: TOKEN }],
        snapshots: false,
      },
      quiet(),
    );
    cleanups.push(() => server.close());
    const settings = createConnectionSettingsStore({ directory, logger: quiet() });
    await settings.save({ serverUrl: server.url, token: TOKEN });
    const mode = new SpaceModeController({ directory, settings, logger: quiet() });
    await mode.open();
    cleanups.push(() => mode.close());
    const migration = createMigrationService({ directory, settings, mode, logger: quiet() });

    const started = await migration.start({ direction: 'to-server' });
    expect(started.status).toBe('running');
    expect(await waitFor(migration)).toBe('done');
    expect(mode.current().kind).toBe('server');
    expect(mode.isMigrationLocked()).toBe(false);
    const remote = (await mode.current().rpc('space.listSpaces', {
      op: 'space.listSpaces',
      args: [],
    })) as { value: Array<{ name: string }> };
    expect(remote.value.map((space) => space.name)).toContain('服务迁移');

    const back = await migration.start({ direction: 'from-server' });
    expect(back.direction).toBe('from-server');
    expect(await waitFor(migration)).toBe('done');
    expect(mode.current().kind).toBe('local');
    expect(mode.isMigrationLocked()).toBe(false);
    const local = (await mode.current().rpc('space.listSpaces', {
      op: 'space.listSpaces',
      args: [],
    })) as { value: Array<{ name: string }> };
    expect(local.value.map((space) => space.name)).toContain('服务迁移');
  });
});
