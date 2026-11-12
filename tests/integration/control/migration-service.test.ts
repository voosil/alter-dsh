/**
 * Migration service + mode switch: uploading the local database to a real
 * server, switching authority, then restoring it locally.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createConnectionSettingsStore,
} from '../../../host/control/connection-settings.js';
import { createMigrationService } from '../../../host/control/migration/service.js';
import { readSpaceDataCounts } from '../../../host/control/migration/snapshot.js';
import { listSnapshots } from '../../../host/persistence/backup.js';
import { openRemoteCache } from '../../../host/remote/cache.js';
import { SpaceModeController } from '../../../host/core/mode.js';
import {
  TEST_TOKEN as TOKEN,
  seedDataDirectory,
  startTestServer,
  waitForMigration,
} from '../../support/harness.js';
import { dispose, quietLogger, tempDir } from '../../support/lifecycle.js';

describe('migration service', () => {
  it('migrates local data to a server and back, switching the mode each way', async () => {
    const directory = await tempDir('space-migration-svc-');
    await seedDataDirectory(directory, '服务迁移');
    const server = await startTestServer();
    const settings = createConnectionSettingsStore({ directory, logger: quietLogger() });
    await settings.save({ serverUrl: server.url, token: TOKEN });
    const mode = new SpaceModeController({ directory, settings, logger: quietLogger() });
    await mode.open();
    dispose(() => mode.close());
    const migration = createMigrationService({ directory, settings, mode, logger: quietLogger() });

    const started = await migration.start({ direction: 'to-server' });
    expect(started.status).toBe('running');
    expect(await waitForMigration(() => migration.status())).toBe('done');
    expect(mode.current().kind).toBe('server');
    expect(mode.isMigrationLocked()).toBe(false);
    const remote = (await mode.current().rpc('space.listSpaces', {
      op: 'space.listSpaces',
      args: [],
    })) as { value: Array<{ name: string }> };
    expect(remote.value.map((space) => space.name)).toContain('服务迁移');

    const back = await migration.start({ direction: 'from-server' });
    expect(back.direction).toBe('from-server');
    expect(await waitForMigration(() => migration.status())).toBe('done');
    expect(mode.current().kind).toBe('local');
    expect(mode.isMigrationLocked()).toBe(false);
    const local = (await mode.current().rpc('space.listSpaces', {
      op: 'space.listSpaces',
      args: [],
    })) as { value: Array<{ name: string }> };
    expect(local.value.map((space) => space.name)).toContain('服务迁移');
    // The replaced local database got its own initial snapshot even though
    // the directory may already have had one for the day.
    expect((await listSnapshots(directory)).length).toBeGreaterThanOrEqual(1);
  });

  it('rolls the server back when the post-commit mode switch fails', async () => {
    const directory = await tempDir('space-migration-rollback-');
    await seedDataDirectory(directory, '回滚空间');
    const server = await startTestServer();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    await settings.save({ serverUrl: server.url, token: TOKEN });
    const mode = new SpaceModeController({
      directory,
      settings,
      logger: quietLogger(),
    });
    await mode.open();
    dispose(() => mode.close());
    const migration = createMigrationService({
      directory,
      settings,
      mode,
      logger: quietLogger(),
    });
    const originalApply = mode.apply.bind(mode);
    mode.apply = async (loaded) => {
      if (loaded.settings.mode === 'server') throw new Error('模拟切换失败');
      return originalApply(loaded);
    };

    await migration.start({ direction: 'to-server' });
    expect(await waitForMigration(() => migration.status())).toBe('failed');
    expect(migration.status().error).toMatch(/已回滚服务端数据/);
    // The server committed and then restored its pre-migration database.
    expect(
      readSpaceDataCounts(join(server.dataDir, 'space.db')).nodes,
    ).toBe(0);
    const staging = await readdir(join(server.dataDir, '.migration')).catch(
      () => [] as string[],
    );
    expect(staging.filter((name) => name.startsWith('backup-'))).toHaveLength(0);
    // The local authority is untouched and the lock is released.
    expect(mode.current().kind).toBe('local');
    expect(mode.isMigrationLocked()).toBe(false);
  });

  it('refuses from-server while queued writes are still unsettled', async () => {
    const directory = await tempDir('space-migration-queue-');
    await seedDataDirectory(directory, '队列空间');
    const server = await startTestServer();
    const settings = createConnectionSettingsStore({
      directory,
      logger: quietLogger(),
    });
    await settings.save({ serverUrl: server.url, token: TOKEN });
    const mode = new SpaceModeController({
      directory,
      settings,
      logger: quietLogger(),
    });
    await mode.open();
    dispose(() => mode.close());
    const migration = createMigrationService({
      directory,
      settings,
      mode,
      logger: quietLogger(),
    });
    await migration.start({ direction: 'to-server' });
    expect(await waitForMigration(() => migration.status())).toBe('done');
    const cache = openRemoteCache(directory, server.url);
    try {
      cache.enqueue({
        docId: 'doc-unsynced',
        endpoint: 'doc.applyOperations',
        payload: { docId: 'doc-unsynced', baseRevision: 1, ops: [] },
        idempotencyKey: 'idem-unsynced-test',
        baseRevision: 1,
        now: Date.now(),
      });
    } finally {
      cache.close();
    }
    await migration.start({ direction: 'from-server' });
    expect(await waitForMigration(() => migration.status())).toBe('failed');
    expect(migration.status().error).toMatch(/尚未同步/);
    expect(mode.current().kind).toBe('server');
  });
});