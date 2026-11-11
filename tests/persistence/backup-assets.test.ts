import { createGunzip } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocumentAssets } from '../../host/document/asset-store.js';
import {
  assetArchiveFileName,
  createDailySnapshot,
  listAssetArchives,
  snapshotFileName,
} from '../../host/persistence/backup.js';
import { openSpaceStore } from '../../host/persistence/store.js';

const dirs: string[] = [];
const fixedNow = () => new Date('2026-11-09T10:00:00.000Z');

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-backup-'));
  dirs.push(dir);
  const store = await openSpaceStore({ directory: dir, now: fixedNow });
  return { dir, store };
}

describe('daily snapshot with assets', () => {
  it('writes a database snapshot and an asset archive side by side', async () => {
    const { dir, store } = await setup();
    const assets = createDocumentAssets({ store, directory: dir, now: fixedNow });
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const record = await assets.import({ data: bytes, mime: 'image/png', name: 'x.png' });

    const outcome = await createDailySnapshot({
      store,
      directory: dir,
      now: fixedNow,
      logger: { warn: () => undefined, info: () => undefined },
    });
    expect(outcome.status).toBe('created');
    expect(outcome.file).toContain(snapshotFileName(fixedNow()));
    expect(outcome.assetsFile).toContain(assetArchiveFileName(fixedNow()));

    const backups = join(dir, 'backups');
    const names = await readdir(backups);
    expect(names).toContain(snapshotFileName(fixedNow()));
    expect(names).toContain(assetArchiveFileName(fixedNow()));

    const archives = await listAssetArchives(dir);
    expect(archives).toHaveLength(1);
    const compressed = await readFile(archives[0]!.path);
    const chunks: Buffer[] = [];
    for await (const chunk of Readable.from(compressed).pipe(createGunzip()))
      chunks.push(Buffer.from(chunk));
    const tar = Buffer.concat(chunks);
    expect(tar.includes(Buffer.from(record.sha256))).toBe(true);
    expect(tar.includes(Buffer.from('image/png')) || tar.length > 1024).toBe(true);
    await store.close();
  });

  it('skips the asset archive when no assets exist', async () => {
    const { dir, store } = await setup();
    const outcome = await createDailySnapshot({
      store,
      directory: dir,
      now: fixedNow,
      logger: { warn: () => undefined, info: () => undefined },
    });
    expect(outcome.status).toBe('created');
    expect(outcome.assetsFile).toBeUndefined();
    expect(await listAssetArchives(dir)).toEqual([]);
    await store.close();
  });
});
