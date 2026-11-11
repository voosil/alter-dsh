/**
 * Migration transfer against a real standalone server: pack/upload, verification,
 * server-side replacement, export and local restore.
 */
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalSpaceRuntime } from '../../host/core/runtime.js';
import { createSpaceMigrationTransfer } from '../../host/control/migration/transfer.js';
import { readSpaceDataCounts } from '../../host/control/migration/snapshot.js';
import { listAssetEntries, writeBundleFile } from '../../host/control/migration/bundle.js';
import { RemoteSpaceClient } from '../../host/remote/client.js';
import {
  startSpaceServer,
  type RunningSpaceServer,
} from '../../server/core/index.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'space-migration-'));
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

async function seedLocalData(directory: string): Promise<void> {
  const runtime = await createLocalSpaceRuntime({
    directory,
    snapshots: false,
  });
  try {
    const space = await runtime.service.createSpace({
      name: '迁移空间',
      directories: [],
    });
    await runtime.document.generate({
      spaceId: space.id,
      title: '迁移文档',
      markdown: '# 迁移标题\n\n迁移正文',
    });
    await runtime.assets.import({
      data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=',
        'base64',
      ),
      mime: 'image/png',
      name: 'pixel.png',
    });
  } finally {
    await runtime.close();
  }
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
    quiet(),
  );
  cleanups.push(() => server.close());
  return server;
}

describe('migration bundle format', () => {
  it('round-trips files with nested asset paths', async () => {
    const source = await tempDir();
    const destination = await tempDir();
    await mkdir(join(source, 'assets/ab'), { recursive: true });
    const file = join(source, 'assets/ab/hash.png');
    await (await import('node:fs/promises')).writeFile(file, Buffer.from('pixel'));
    const bundle = join(source, 'part.bundle');
    const written = await writeBundleFile(bundle, [
      { path: 'assets/ab/hash.png', source: file },
    ]);
    expect(written.fileCount).toBe(1);
    const { unpackBundleTo } = await import('../../host/control/migration/bundle.js');
    const unpacked = await unpackBundleTo(bundle, destination);
    expect(unpacked.fileCount).toBe(1);
    const restored = await (
      await import('node:fs/promises')
    ).readFile(join(destination, 'assets/ab/hash.png'), 'utf8');
    expect(restored).toBe('pixel');
    expect(await listAssetEntries(source)).toHaveLength(1);
  });
});

describe('local → server → local migration', () => {
  it('migrates data, switches the server and restores it locally', async () => {
    const localDir = await tempDir();
    await seedLocalData(localDir);
    const server = await startServer();
    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });

    const preflight = await transfer.preflight();
    expect(preflight.ok).toBe(true);
    expect(preflight.server.empty).toBe(true);
    expect(preflight.local.hasUserData).toBe(true);
    expect(preflight.local.assetCount).toBeGreaterThan(0);

    const freezes: string[] = [];
    const result = await transfer.toServer({
      freeze: async () => {
        freezes.push('freeze');
      },
      unfreeze: async () => {
        freezes.push('unfreeze');
      },
    });
    expect(freezes).toEqual(['freeze', 'unfreeze']);
    expect(result.counts.nodes).toBeGreaterThanOrEqual(1);

    const remote = new RemoteSpaceClient({
      baseUrl: server.url,
      token: TOKEN,
    });
    const spaces = (await remote.call('space.listSpaces', [])) as Array<{
      name: string;
    }>;
    expect(spaces.map((space) => space.name)).toContain('迁移空间');
    const serverCounts = readSpaceDataCounts(
      join(server.config.dataDir, 'space.db'),
    );
    expect(serverCounts.nodes).toBeGreaterThanOrEqual(1);
    expect((await readdir(join(server.config.dataDir, 'assets'))).length).toBeGreaterThan(0);

    // A second overwrite attempt without confirmation is refused.
    const again = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    await expect(again.toServer()).rejects.toThrow(/已有空间数据/);

    // Reverse: restore into a fresh local directory.
    const restoredDir = await tempDir();
    const restore = createSpaceMigrationTransfer({
      directory: restoredDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    const restored = await restore.fromServer({});
    expect(restored.counts.nodes).toBeGreaterThanOrEqual(1);
    const localFacts = readSpaceDataCounts(join(restoredDir, 'space.db'));
    expect(localFacts.nodes).toBeGreaterThanOrEqual(1);
  });

  it('trims version history when requested', async () => {
    const localDir = await tempDir();
    await seedLocalData(localDir);
    const server = await startServer();
    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    const result = await transfer.toServer({ trimHistory: true });
    expect(result.counts.nodes).toBeGreaterThan(0);
  });
});
