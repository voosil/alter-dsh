/**
 * Migration service + mode switch: uploading the local database to a real
 * server, switching authority, then restoring it locally.
 */
import { describe, expect, it } from 'vitest';
import {
  createConnectionSettingsStore,
} from '../../../host/control/connection-settings.js';
import { createMigrationService } from '../../../host/control/migration/service.js';
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
  });
});