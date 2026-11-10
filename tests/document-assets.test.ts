import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocumentAssetRoute } from '../host/document/asset-route.js';
import {
  ASSET_ROUTE_PATH,
  MAX_ASSET_BYTES,
  assetFilePath,
  createDocumentAssets,
} from '../host/document/assets.js';
import { openSpaceStore } from '../host/store.js';

const dirs: string[] = [];
const fixedNow = () => new Date('2026-11-09T00:00:00.000Z');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-assets-'));
  dirs.push(dir);
  const store = await openSpaceStore({ directory: dir, now: fixedNow });
  const assets = createDocumentAssets({ store, directory: dir, now: fixedNow });
  return { dir, store, assets };
}

describe('document assets', () => {
  it('imports, deduplicates and reads content-addressed images', async () => {
    const { dir, store, assets } = await setup();
    const first = await assets.import({ data: png, mime: 'image/png', name: 'a.png' });
    expect(first.id).toMatch(/^asset_/);
    expect(first.mime).toBe('image/png');
    expect(first.bytes).toBe(png.byteLength);
    const file = assetFilePath(dir, first);
    expect(await readFile(file)).toEqual(Buffer.from(png));

    const second = await assets.import({ data: png, mime: 'image/png' });
    expect(second.id).toBe(first.id);
    expect(await assets.get(first.id)).toMatchObject({ name: 'a.png' });

    const stored = await assets.read(first.id);
    expect(stored?.record.id).toBe(first.id);
    expect(Buffer.from(stored!.data)).toEqual(Buffer.from(png));

    await store.close();
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    const assets2 = createDocumentAssets({ store: reopened, directory: dir });
    expect((await assets2.read(first.id))?.record.id).toBe(first.id);
    await reopened.close();
  });

  it('rejects unsupported or oversized assets', async () => {
    const { store, assets } = await setup();
    await expect(
      assets.import({ data: png, mime: 'image/svg+xml' }),
    ).rejects.toMatchObject({ code: 'object/invalid' });
    await expect(
      assets.import({ data: new Uint8Array(0), mime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'object/invalid' });
    await expect(
      assets.import({ data: new Uint8Array(4 * 1024 * 1024 + 1), mime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'object/invalid' });
    await store.close();
  });

  it('normalizes mime casing and accepts exactly the size limit', async () => {
    const { dir, store, assets } = await setup();
    const data = new Uint8Array(MAX_ASSET_BYTES);
    data[0] = 0x89;
    const record = await assets.import({ data, mime: 'IMAGE/PNG' });
    expect(record.mime).toBe('image/png');
    expect(record.bytes).toBe(MAX_ASSET_BYTES);
    expect((await readFile(assetFilePath(dir, record))).byteLength).toBe(
      MAX_ASSET_BYTES,
    );
    await store.close();
  });

  it('serves bytes over the exact asset route and 404s unknown ids', async () => {
    const { store, assets } = await setup();
    const record = await assets.import({ data: png, mime: 'image/png' });
    const route = createDocumentAssetRoute(assets);

    const ok = await route(
      new Request(`http://dsh.internal${ASSET_ROUTE_PATH}?id=${record.id}`),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(Buffer.from(png));

    const missing = await route(
      new Request(`http://dsh.internal${ASSET_ROUTE_PATH}?id=asset_missing`),
    );
    expect(missing.status).toBe(404);
    const post = await route(
      new Request(`http://dsh.internal${ASSET_ROUTE_PATH}?id=${record.id}`, {
        method: 'POST',
      }),
    );
    expect(post.status).toBe(405);
    await store.close();
  });
});
