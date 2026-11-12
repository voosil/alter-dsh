/**
 * Migration transfer against a real standalone server: pack/upload, verification,
 * server-side replacement, export and local restore.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, symlinkSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalSpaceRuntime } from '../../../host/core/runtime.js';
import { createSpaceMigrationTransfer } from '../../../host/control/migration/transfer.js';
import {
  isEmptySpaceDatabase,
  readSpaceDataCounts,
  snapshotSpaceDatabase,
} from '../../../host/control/migration/snapshot.js';
import { listAssetEntries, writeBundleFile } from '../../../host/control/migration/bundle.js';
import { RemoteSpaceClient } from '../../../host/remote/client.js';
import {
  startSpaceServer,
  type RunningSpaceServer,
} from '../../../server/core/index.js';
import {
  MIGRATION_PATH,
  createServerMigration,
} from '../../../server/migration/service.js';
import { sweepMigrationStaging } from '../../../host/control/migration/staging.js';
import { openRemoteCache } from '../../../host/remote/cache.js';

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

async function startServer(
  options: { snapshots?: boolean } = {},
): Promise<RunningSpaceServer> {
  const dataDir = await tempDir();
  const server = await startSpaceServer(
    {
      dataDir,
      host: '127.0.0.1',
      port: 0,
      tokens: [{ label: 'test', token: TOKEN }],
      snapshots: options.snapshots === true,
    },
    quiet(),
  );
  cleanups.push(() => server.close());
  return server;
}

/** Call one migration endpoint directly, the way the transfer does. */
async function migrationCall(
  server: RunningSpaceServer,
  endpoint: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${server.url}/api/alter-space/migrate/${endpoint}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
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
    // A write-stream failure (ENOSPC/EACCES/...) must reject the promise, not
    // crash the process through an unhandled 'error' event.
    await expect(
      writeBundleFile(join(destination, 'no-such-dir', 'broken.bundle'), [
        { path: 'space.db', source: file },
      ]),
    ).rejects.toThrow();
    const { unpackBundleTo } = await import('../../../host/control/migration/bundle.js');
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
    const events: string[] = [];
    const restored = await restore.fromServer({
      freeze: async () => {
        events.push('freeze');
      },
      unfreeze: async () => {
        events.push('unfreeze');
      },
      onProgress: (progress) => events.push(`phase:${progress.phase}`),
    });
    expect(restored.counts.nodes).toBeGreaterThanOrEqual(1);
    expect(restored.localBackup).not.toBeNull();
    // The freeze must precede the export request: a write acknowledged during
    // the download would otherwise be missing from the replaced database.
    expect(events[0]).toBe('phase:freeze');
    expect(events[1]).toBe('freeze');
    expect(events.indexOf('phase:download')).toBeGreaterThan(1);
    // On success the caller owns the switch, so the transfer does not unfreeze.
    expect(events).not.toContain('unfreeze');
    const localFacts = readSpaceDataCounts(join(restoredDir, 'space.db'));
    expect(localFacts.nodes).toBeGreaterThanOrEqual(1);
  });

  it('trims version history to one version per document when requested', async () => {
    const localDir = await tempDir();
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const runtime = await createLocalSpaceRuntime({
      directory: localDir,
      snapshots: false,
      now: () => clock,
    });
    try {
      const space = await runtime.service.createSpace({
        name: '版本空间',
        directories: [],
      });
      const generated = await runtime.document.generate({
        spaceId: space.id,
        title: '版本文档',
        markdown: '# 初版',
      });
      let revision = generated.revision;
      for (let index = 0; index < 3; index += 1) {
        clock = new Date(clock.getTime() + 6 * 60_000);
        const applied = await runtime.document.applyOperations({
          docId: generated.docId,
          baseRevision: revision,
          ops: [{ op: 'insert_markdown', markdown: `第 ${index + 2} 段` }],
        });
        revision = applied.revision;
      }
    } finally {
      await runtime.close();
    }
    const seeded = readSpaceDataCounts(join(localDir, 'space.db'));
    expect(seeded.nodes).toBe(1);
    expect(seeded.versions).toBeGreaterThan(1);

    const server = await startServer();
    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    const result = await transfer.toServer({ trimHistory: true });
    expect(result.counts.nodes).toBe(1);
    // One version row per migrated document, regardless of prior history.
    expect(result.counts.versions).toBe(1);
    expect(
      readSpaceDataCounts(join(server.config.dataDir, 'space.db')).versions,
    ).toBe(1);
  });
});

describe('migration pre-commit verification and rollback', () => {
  it('rejects a tampered part and a count mismatch without touching the target', async () => {
    const localDir = await tempDir();
    await seedLocalData(localDir);
    const server = await startServer();

    const prepared = await migrationCall(server, 'prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overwrite: false }),
    });
    const id = prepared.body.id as string;
    expect(prepared.status).toBe(200);

    // Build the same bundle the transfer would upload.
    const work = await tempDir();
    const snapshot = join(work, 'space.db');
    snapshotSpaceDatabase(join(localDir, 'space.db'), snapshot);
    const bundleFile = join(work, 'part-final.bundle');
    const written = await writeBundleFile(bundleFile, [
      { path: 'space.db', source: snapshot },
      ...(await listAssetEntries(localDir)),
    ]);
    const bytes = await readFile(bundleFile);
    const uploaded = await fetch(
      `${server.url}/api/alter-space/migrate/part?id=${id}&name=part-final.bundle&offset=0`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: bytes,
      },
    );
    expect(uploaded.status).toBe(200);
    const expectedCounts = readSpaceDataCounts(snapshot);
    const countsBefore = readSpaceDataCounts(
      join(server.config.dataDir, 'space.db'),
    );

    const tampered = await migrationCall(server, 'commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        parts: [
          {
            name: 'part-final.bundle',
            size: written.size,
            sha256: '0'.repeat(64),
          },
        ],
        expected: { counts: expectedCounts, fileCount: written.fileCount },
      }),
    });
    expect(tampered.status).toBe(400);
    expect(tampered.body.error).toBe('part_hash_mismatch');
    const afterTamper = await migrationCall(server, 'status');
    expect(afterTamper.body.empty).toBe(true);
    expect(
      readSpaceDataCounts(join(server.config.dataDir, 'space.db')),
    ).toEqual(countsBefore);

    const mismatched = await migrationCall(server, 'commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        parts: [
          {
            name: 'part-final.bundle',
            size: written.size,
            sha256: written.sha256,
          },
        ],
        expected: {
          counts: { ...expectedCounts, nodes: expectedCounts.nodes + 7 },
          fileCount: written.fileCount,
        },
      }),
    });
    expect(mismatched.status).toBe(400);
    expect(mismatched.body.error).toBe('commit_counts_mismatch');
    const afterMismatch = await migrationCall(server, 'status');
    expect(afterMismatch.body.empty).toBe(true);
    expect(
      readSpaceDataCounts(join(server.config.dataDir, 'space.db')),
    ).toEqual(countsBefore);
    // No backup was created because the target was never replaced.
    const staging = await readdir(join(server.config.dataDir, '.migration'));
    expect(staging.filter((name) => name === `backup-${id}`)).toHaveLength(0);

    const fileMismatch = await migrationCall(server, 'commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        parts: [
          {
            name: 'part-final.bundle',
            size: written.size,
            sha256: written.sha256,
          },
        ],
        expected: { counts: expectedCounts, fileCount: written.fileCount + 1 },
      }),
    });
    expect(fileMismatch.status).toBe(400);
    expect(fileMismatch.body.error).toBe('commit_files_mismatch');
  });

  it('restores the pre-migration server database through the rollback endpoint', async () => {
    const localDir = await tempDir();
    await seedLocalData(localDir);
    const server = await startServer();
    const remote = new RemoteSpaceClient({ baseUrl: server.url, token: TOKEN });
    await remote.call('space.createSpace', [{ name: '服务端旧空间' }]);
    const before = readSpaceDataCounts(join(server.config.dataDir, 'space.db'));
    expect(before.nodes).toBe(0);
    expect(before.spaces).toBeGreaterThanOrEqual(2);

    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    const result = await transfer.toServer({ overwrite: true });
    expect(result.serverBackup).not.toBeNull();
    const committed = readSpaceDataCounts(
      join(server.config.dataDir, 'space.db'),
    );
    expect(committed.nodes).toBeGreaterThanOrEqual(1);

    await result.rollback();
    const restored = readSpaceDataCounts(
      join(server.config.dataDir, 'space.db'),
    );
    expect(restored.nodes).toBe(0);
    expect(restored.spaces).toBe(before.spaces);
    const spaces = (await remote.call('space.listSpaces', [])) as Array<{
      name: string;
    }>;
    expect(spaces.map((space) => space.name)).toContain('服务端旧空间');
    // The consumed backup must not linger for the seven-day sweep.
    const staging = await readdir(join(server.config.dataDir, '.migration'));
    expect(staging.filter((name) => name.startsWith('backup-'))).toHaveLength(0);
  });

  it('rolls the server back when the post-commit counts disagree', async () => {
    const localDir = await tempDir();
    await seedLocalData(localDir);
    const server = await startServer();
    // Simulate a server whose resumed data differs from the verified bundle:
    // the commit itself succeeds, but the reported counts are wrong.
    const tamperingFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const response = await fetch(input, init);
      if (url.endsWith(`${MIGRATION_PATH}/commit`) && init?.method === 'POST') {
        const body = (await response.clone().json()) as {
          counts?: Record<string, number>;
          [key: string]: unknown;
        };
        const counts = body.counts ?? {};
        return new Response(
          JSON.stringify({
            ...body,
            counts: { ...counts, nodes: (counts.nodes ?? 0) + 3 },
          }),
          {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return response;
    };
    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
      fetchImpl: tamperingFetch,
    });
    await expect(transfer.toServer({})).rejects.toThrow(/迁移后校验不一致/);
    // The defense-in-depth path rolled the target back instead of leaving two
    // authorities on different data sets.
    expect(
      readSpaceDataCounts(join(server.config.dataDir, 'space.db')).nodes,
    ).toBe(0);
  });

  it('creates an initial snapshot of the new database after a commit', async () => {
    const localDir = await tempDir();
    await seedLocalData(localDir);
    const server = await startServer({ snapshots: true });
    // A snapshot of the previous (empty) data already exists for today.
    const preexisting = await readdir(
      join(server.config.dataDir, 'backups'),
    ).catch(() => [] as string[]);
    expect(
      preexisting.some((name) => /^space-\d{8}\.db\.gz$/.test(name)),
    ).toBe(false);

    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    await transfer.toServer({});
    const names = await readdir(join(server.config.dataDir, 'backups'));
    expect(names.some((name) => /^space-\d{8}\.db\.gz$/.test(name))).toBe(true);
  });
});

describe('migration data counts', () => {
  it('counts agents as user content for empty-target detection', async () => {
    const directory = await tempDir();
    const runtime = await createLocalSpaceRuntime({
      directory,
      snapshots: false,
    });
    try {
      await runtime.service.createAgent({ name: '协作者', role: '助手' });
    } finally {
      await runtime.close();
    }
    const counts = readSpaceDataCounts(join(directory, 'space.db'));
    expect(counts.agents).toBe(1);
    expect(counts.tasks).toBe(0);
    expect(counts.milestones).toBe(0);
    expect(isEmptySpaceDatabase(join(directory, 'space.db'))).toBe(false);
  });

  it('treats an agent-only server as a non-empty migration target', async () => {
    const server = await startServer();
    const remote = new RemoteSpaceClient({ baseUrl: server.url, token: TOKEN });
    await remote.call('space.createAgent', [{ name: '服务端协作者', role: '助手' }]);
    const localDir = await tempDir();
    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    const preflight = await transfer.preflight();
    expect(preflight.server.empty).toBe(false);
    expect(preflight.needsOverwrite).toBe(true);
    // A collaborator the local side lacks is a row the overwrite would drop,
    // but the preflight counts read the local side of an empty directory, which
    // has no database to compare against; the flag stays false there and the
    // overwrite confirmation carries the warning instead.
    expect(preflight.overwriteDropsServerData).toBe(false);
  });

  it('flags an overwrite that would drop server rows the local copy lacks', async () => {
    const server = await startServer();
    const localDir = await tempDir();
    await seedLocalData(localDir);
    // The server knows a collaborator the local database does not.
    const remote = new RemoteSpaceClient({ baseUrl: server.url, token: TOKEN });
    await remote.call('space.createAgent', [{ name: '服务端协作者', role: '助手' }]);
    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    const preflight = await transfer.preflight();
    expect(preflight.needsOverwrite).toBe(true);
    expect(preflight.overwriteDropsServerData).toBe(true);
  });

  it('does not flag an overwrite that only rewrites the same rows', async () => {
    const server = await startServer();
    const localDir = await tempDir();
    await seedLocalData(localDir);
    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    // Push the local database once, then migrate from the same copy: the server
    // holds exactly what the local side has, so overwriting drops nothing.
    await transfer.toServer();
    const again = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
    });
    const preflight = await again.preflight();
    expect(preflight.needsOverwrite).toBe(true);
    expect(preflight.overwriteDropsServerData).toBe(false);
  });
});

describe('migration transfer resilience', () => {
  it('retries a transient part-upload failure and keeps the resumable offset', async () => {
    const localDir = await tempDir();
    await seedLocalData(localDir);
    const server = await startServer();
    let failures = 0;
    const flaky: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('/migrate/part') && init?.method === 'PUT' && failures < 2) {
        failures += 1;
        throw new TypeError('fetch failed');
      }
      return fetch(input, init);
    };
    const transfer = createSpaceMigrationTransfer({
      directory: localDir,
      serverUrl: server.url,
      token: TOKEN,
      fetchImpl: flaky,
    });
    const result = await transfer.toServer({});
    expect(failures).toBe(2);
    expect(result.counts.nodes).toBeGreaterThanOrEqual(1);
    expect(
      readSpaceDataCounts(join(server.config.dataDir, 'space.db')).nodes,
    ).toBe(result.counts.nodes);
  });
});

describe('migration staging guards', () => {
  it('rejects duplicate and too many commit parts', async () => {
    const server = await startServer();
    const prepared = await migrationCall(server, 'prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overwrite: false }),
    });
    const id = prepared.body.id as string;
    const valid = {
      name: 'part-a.bundle',
      size: 1,
      sha256: '0'.repeat(64),
    };
    const duplicate = await migrationCall(server, 'commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, parts: [valid, valid] }),
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toBe('duplicate_part');

    const many = Array.from({ length: 17 }, (_, index) => ({
      name: `part-p${index}.bundle`,
      size: 1,
      sha256: '0'.repeat(64),
    }));
    const tooMany = await migrationCall(server, 'commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, parts: many }),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toBe('too_many_parts');
  });

  it('rejects a staging total above the server bound', async () => {
    const server = await startServer();
    const prepared = await migrationCall(server, 'prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overwrite: false }),
    });
    const id = prepared.body.id as string;
    const oversized = await migrationCall(server, 'commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        parts: [
          {
            name: 'part-a.bundle',
            size: 64 * 1024 * 1024 * 1024 + 1,
            sha256: '0'.repeat(64),
          },
        ],
      }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error).toBe('staging_too_large');
  });

  it('caps concurrent export staging jobs', async () => {
    const server = await startServer();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const exported = await migrationCall(server, 'export', { method: 'POST' });
      expect(exported.status).toBe(200);
      ids.push(exported.body.id as string);
    }
    const refused = await migrationCall(server, 'export', { method: 'POST' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('migration_busy');
    for (const id of ids) {
      await fetch(
        `${server.url}${MIGRATION_PATH}/export?id=${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      );
    }
    // After cleanup a new export is accepted again.
    const accepted = await migrationCall(server, 'export', { method: 'POST' });
    expect(accepted.status).toBe(200);
  });

  it('sweeps abandoned migration staging older than seven days', async () => {
    const dataDir = await tempDir();
    const staging = join(dataDir, '.migration');
    await mkdir(join(staging, 'import-old'), { recursive: true });
    await mkdir(join(staging, 'backup-new'), { recursive: true });
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(staging, 'import-old'), stale, stale);
    await sweepMigrationStaging(dataDir);
    expect(await readdir(staging)).toEqual(['backup-new']);
  });
});

describe('server migration lifecycle', () => {
  it('waits for an in-flight commit before closing', async () => {
    const sourceDir = await tempDir();
    await seedLocalData(sourceDir);
    const snapshot = join(sourceDir, 'snapshot.db');
    snapshotSpaceDatabase(join(sourceDir, 'space.db'), snapshot);
    const bundle = join(sourceDir, 'part.bundle');
    const written = await writeBundleFile(bundle, [
      { path: 'space.db', source: snapshot },
    ]);
    const payload = await readFile(bundle);

    const targetDir = await tempDir();
    let runtime = await createLocalSpaceRuntime({
      directory: targetDir,
      snapshots: false,
    });
    const targetCleanup = async (): Promise<void> => {
      await runtime.close().catch(() => undefined);
    };
    cleanups.push(targetCleanup);
    let pauseStartedResolve: (() => void) | undefined;
    const pauseStarted = new Promise<void>((resolve) => {
      pauseStartedResolve = resolve;
    });
    let releasePauseResolve: (() => void) | undefined;
    const pauseReleased = new Promise<void>((resolve) => {
      releasePauseResolve = resolve;
    });
    let blockNextPause = true;
    const migration = createServerMigration({
      dataDir: targetDir,
      forceInitialSnapshot: false,
      current: () => runtime,
      async pause() {
        pauseStartedResolve?.();
        if (blockNextPause) await pauseReleased;
        await runtime.close();
      },
      async resume() {
        runtime = await createLocalSpaceRuntime({
          directory: targetDir,
          snapshots: false,
        });
        return runtime;
      },
    });
    cleanups.push(() => migration.close());

    const prepareUrl = new URL(`http://space.internal${MIGRATION_PATH}/prepare`);
    const prepared = (await (
      await migration.handle(
        new Request(prepareUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ overwrite: false }),
        }),
        prepareUrl,
      )
    )?.json()) as { id: string };
    const partUrl = new URL(
      `http://space.internal${MIGRATION_PATH}/part?id=${prepared.id}&name=part-final.bundle&offset=0`,
    );
    const uploaded = await migration.handle(
      new Request(partUrl, { method: 'PUT', body: payload }),
      partUrl,
    );
    expect(uploaded?.status).toBe(200);

    const commitUrl = new URL(`http://space.internal${MIGRATION_PATH}/commit`);
    const commitPending = migration.handle(
      new Request(commitUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: prepared.id,
          parts: [
            {
              name: 'part-final.bundle',
              size: written.size,
              sha256: written.sha256,
            },
          ],
          expected: {
            counts: readSpaceDataCounts(snapshot),
            fileCount: written.fileCount,
          },
        }),
      }),
      commitUrl,
    );
    await pauseStarted;
    let closed = false;
    const closePending = migration.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(closed).toBe(false);
    expect(migration.inflight()).toBe(true);
    expect(migration.paused()).toBe(true);
    blockNextPause = false;
    releasePauseResolve?.();
    const committed = await commitPending;
    expect(committed?.status).toBe(200);
    await closePending;
    expect(migration.inflight()).toBe(false);
    expect(migration.paused()).toBe(false);
  });
});

describe('migration CLI', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const cliScript = join(repoRoot, 'scripts/ops/space-migrate.mjs');

  function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it('prints help and exits 0 without any environment', () => {
    const result = spawnSync(process.execPath, [cliScript, '--help'], {
      cwd: repoRoot,
      env: {},
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--direction');
    expect(result.stdout).toContain('--overwrite');
  });

  it('exits 2 without the required environment', () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.SPACE_SERVER_URL;
    delete env.SPACE_TOKEN;
    const result = spawnSync(process.execPath, [cliScript], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('SPACE_SERVER_URL');
  });

  it('resolves the built host transfer module (import path)', async () => {
    const dataDir = await tempDir();
    const result = runCli(
      [cliScript, '--direction', 'to-server', '--data-dir', dataDir],
      {
        SPACE_SERVER_URL: 'http://127.0.0.1:9',
        SPACE_TOKEN: 'cli-test-token-1234567890',
      },
    );
    const built = join(repoRoot, 'lib/host/control/migration/transfer.js');
    if (!existsSync(built)) {
      // The host build has not run yet; the script reports that clearly and
      // must not fail with an unexplained import error.
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('找不到构建产物');
      return;
    }
    expect(result.stderr).not.toContain('找不到构建产物');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('预检失败');
  });

  it('refuses from-server without --overwrite', async () => {
    const dataDir = await tempDir();
    const result = runCli(
      [cliScript, '--direction', 'from-server', '--data-dir', dataDir],
      {
        SPACE_SERVER_URL: 'http://127.0.0.1:9',
        SPACE_TOKEN: 'cli-test-token-1234567890',
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--overwrite');
  });

  it('refuses from-server when the connection is still local', async () => {
    const dataDir = await tempDir();
    const result = runCli(
      [
        cliScript,
        '--direction',
        'from-server',
        '--overwrite',
        '--data-dir',
        dataDir,
      ],
      {
        SPACE_SERVER_URL: 'http://127.0.0.1:9',
        SPACE_TOKEN: 'cli-test-token-1234567890',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('不是服务端模式');
  });

  it('refuses from-server while the server queue has unsettled writes', async () => {
    const dataDir = await tempDir();
    await writeFile(
      join(dataDir, 'connection.json'),
      JSON.stringify({
        mode: 'server',
        serverUrl: 'http://127.0.0.1:9',
        updatedAt: new Date().toISOString(),
      }),
    );
    const cache = openRemoteCache(dataDir, 'http://127.0.0.1:9');
    try {
      cache.enqueue({
        docId: 'doc-cli-queue',
        endpoint: 'doc.applyOperations',
        payload: { docId: 'doc-cli-queue', baseRevision: 1, ops: [] },
        idempotencyKey: 'idem-cli-queue',
        baseRevision: 1,
        now: Date.now(),
      });
    } finally {
      cache.close();
    }
    const result = runCli(
      [
        cliScript,
        '--direction',
        'from-server',
        '--overwrite',
        '--data-dir',
        dataDir,
      ],
      {
        SPACE_SERVER_URL: 'http://127.0.0.1:9',
        SPACE_TOKEN: 'cli-test-token-1234567890',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('未同步');
  });

  it('starts through a symlinked bin entry', async () => {
    const built = join(repoRoot, 'lib/server/core/index.js');
    const source = join(repoRoot, 'server/core/index.ts');
    if (!existsSync(built)) return;
    // A stale build would not contain the realpath entry fix; the gate builds
    // before running tests, so only skip when the artifact predates the source.
    if (statSync(built).mtimeMs < statSync(source).mtimeMs) return;
    const linkDir = await tempDir();
    const link = join(linkDir, 'space-server.js');
    symlinkSync(built, link);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.SPACE_TOKENS;
    delete env.SPACE_DATA_DIR;
    delete env.SPACE_PORT;
    const result = spawnSync(process.execPath, [link], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    // Missing SPACE_TOKENS must fail configuration (exit 1); silently exiting
    // 0 would mean the symlinked entry point was not recognised.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('启动失败');
  });
});
