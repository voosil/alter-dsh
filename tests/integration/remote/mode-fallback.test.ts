/**
 * Mode activation fallback: an unusable configured authority must degrade to
 * the local authority instead of rejecting plugin activation, while a merely
 * unreachable server keeps server mode (its backend opens offline).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createConnectionSettingsStore,
  type ConnectionSettingsStore,
} from '../../../host/control/connection-settings.js';
import { SpaceModeController } from '../../../host/core/mode.js';
import { cacheFileName } from '../../../host/remote/cache.js';
import { quietLogger, tempDir } from '../../support/lifecycle.js';

const UNREACHABLE = 'http://127.0.0.1:1';

async function settingsStore(directory: string): Promise<ConnectionSettingsStore> {
  return createConnectionSettingsStore({
    directory,
    logger: quietLogger(),
  });
}

describe('mode activation fallback', () => {
  it('degrades to the local authority when the server backend cannot open', async () => {
    const directory = await tempDir('space-mode-');
    const settings = await settingsStore(directory);
    await settings.save({
      mode: 'server',
      serverUrl: UNREACHABLE,
      token: 'token',
    });
    // Occupy the per-server cache file with a directory: opening the remote
    // backend fails for a local reason, and retrying the same settings on the
    // next boot would brick activation.
    await mkdir(join(directory, cacheFileName(UNREACHABLE)));

    const mode = new SpaceModeController({
      directory,
      settings,
      logger: quietLogger(),
    });
    try {
      const backend = await mode.open();
      expect(backend.kind).toBe('local');
      const degraded = mode.degraded();
      expect(degraded).toBeDefined();
      expect(degraded?.transient).toBe(false);
      // The degraded choice is persisted so the next boot starts cleanly.
      expect((await settings.load()).settings.mode).toBe('local');
      const spaces = (await backend.rpc('space.listSpaces', {
        op: 'space.listSpaces',
        args: [],
      })) as { value?: unknown };
      expect(Array.isArray(spaces.value)).toBe(true);
    } finally {
      await mode.close();
    }
  });

  it('keeps server mode when the server is merely unreachable', async () => {
    const directory = await tempDir('space-mode-');
    const settings = await settingsStore(directory);
    await settings.save({
      mode: 'server',
      serverUrl: UNREACHABLE,
      token: 'token',
    });
    const mode = new SpaceModeController({
      directory,
      settings,
      logger: quietLogger(),
    });
    try {
      const backend = await mode.open();
      // Opening a remote backend performs no network probe, so a pure outage
      // never changes the chosen authority; the backend reports itself offline.
      expect(backend.kind).toBe('server');
      expect(mode.degraded()).toBeUndefined();
      expect((await settings.load()).settings.mode).toBe('server');
    } finally {
      await mode.close();
    }
  });

  it('repairs an unusable server configuration by falling back to local', async () => {
    const directory = await tempDir('space-mode-');
    const settings = await settingsStore(directory);
    // Hand-written file: server mode without a token is a configuration error,
    // not a transient link failure.
    await writeFile(
      join(directory, 'connection.json'),
      JSON.stringify({
        mode: 'server',
        serverUrl: UNREACHABLE,
        updatedAt: new Date('2026-11-12T00:00:00.000Z').toISOString(),
      }),
    );
    const mode = new SpaceModeController({
      directory,
      settings,
      logger: quietLogger(),
    });
    try {
      const backend = await mode.open();
      expect(backend.kind).toBe('local');
      expect(mode.degraded()?.transient).toBe(false);
      expect((await settings.load()).settings.mode).toBe('local');
    } finally {
      await mode.close();
    }
  });
});