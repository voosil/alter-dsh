import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocumentAssetRoute } from '../../../host/document/asset-route.js';
import {
  ASSET_ROUTE_PATH,
  GENERIC_FILE_MIME,
  MAX_ASSET_BYTES,
  MAX_FILE_BYTES,
  assetFilePath,
  createDocumentAssets,
} from '../../../host/document/asset-store.js';
import { openSpaceStore } from '../../../host/persistence/store.js';

const dirs: string[] = [];
const fixedNow = () => new Date('2026-11-09T00:00:00.000Z');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 1, 2, 3]);

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
    // The image channel stays closed to file mimes.
    await expect(
      assets.import({ data: pdf, mime: 'application/pdf' }),
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

  it('imports and deduplicates downloadable file assets', async () => {
    const { dir, store, assets } = await setup();
    const first = await assets.importFile({
      data: pdf,
      mime: 'application/pdf',
      name: '报告.pdf',
    });
    expect(first.id).toMatch(/^asset_/);
    expect(first.mime).toBe('application/pdf');
    expect(first.bytes).toBe(pdf.byteLength);
    const file = assetFilePath(dir, first);
    expect(file.endsWith('.pdf')).toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from(pdf));

    const again = await assets.importFile({ data: pdf, mime: 'application/pdf' });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('报告.pdf');
    expect((await assets.read(first.id))?.record.mime).toBe('application/pdf');

    const other = await assets.importFile({
      data: new Uint8Array([...pdf, 9]),
      mime: 'application/pdf',
    });
    expect(other.id).not.toBe(first.id);
    await store.close();
  });

  it('maps every whitelisted file mime to a stable extension', async () => {
    const { dir, store, assets } = await setup();
    const cases: Array<[string, string]> = [
      ['image/png', 'png'],
      ['application/pdf', 'pdf'],
      ['text/plain', 'txt'],
      ['text/markdown', 'md'],
      ['text/csv', 'csv'],
      ['application/json', 'json'],
      ['application/zip', 'zip'],
      [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'docx',
      ],
      [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xlsx',
      ],
      [
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'pptx',
      ],
    ];
    for (const [index, [mime, extension]] of cases.entries()) {
      const record = await assets.importFile({
        data: new Uint8Array([index + 1, index + 2]),
        mime,
      });
      expect(record.mime).toBe(mime);
      expect(assetFilePath(dir, record).endsWith(`.${extension}`)).toBe(true);
    }
    // Generic/unknown mimes store as `octet-stream` and land on the `bin` fallback.
    expect(
      assetFilePath(dir, {
        sha256: 'ab'.repeat(32),
        mime: 'application/octet-stream',
      }).endsWith('.bin'),
    ).toBe(true);
    await store.close();
  });

  it('imports unknown or executable file types as generic attachments', async () => {
    const { dir, store, assets } = await setup();
    const cases: Array<[string, string]> = [
      ['text/html', '页面.html'],
      ['image/svg+xml', '图标.svg'],
      ['application/javascript', '脚本.js'],
      ['application/octet-stream', '未知.bin'],
      ['application/x-sketch', '设计.sketch'],
      // Browsers report an empty type for many extensions (e.g. .log/.heic).
      ['', '日志.log'],
    ];
    for (const [index, [mime, name]] of cases.entries()) {
      const record = await assets.importFile({
        data: new Uint8Array([index + 11, 7]),
        mime,
        name,
      });
      // Executable/inline types are never kept: they become a download.
      expect(record.mime).toBe(GENERIC_FILE_MIME);
      expect(record.name).toBe(name);
      expect(assetFilePath(dir, record).endsWith('.bin')).toBe(true);
      expect((await assets.read(record.id))?.record.mime).toBe(
        GENERIC_FILE_MIME,
      );
    }
    await store.close();
  });

  it('rejects empty or oversized files with readable Chinese errors', async () => {
    const { store, assets } = await setup();
    await expect(
      assets.importFile({ data: new Uint8Array(0), mime: 'application/pdf' }),
    ).rejects.toMatchObject({ code: 'object/invalid', message: '文件内容为空' });
    const tooLarge = assets.importFile({
      data: new Uint8Array(MAX_FILE_BYTES + 1),
      mime: 'application/pdf',
    });
    await expect(tooLarge).rejects.toMatchObject({
      code: 'doc/too-large',
      message: expect.stringContaining('文件超过 8 MiB 上限'),
    });
    await expect(tooLarge).rejects.toMatchObject({
      message: expect.stringContaining(String(MAX_FILE_BYTES)),
    });
    // The file channel applies its own 8 MiB limit: 4 MiB + 1 is fine here.
    await expect(
      assets.importFile({
        data: new Uint8Array(MAX_ASSET_BYTES + 1),
        mime: 'application/pdf',
      }),
    ).resolves.toMatchObject({ mime: 'application/pdf' });
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
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('content-disposition')).toBeNull();
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

  it('serves file assets as attachments with a safe filename', async () => {
    const { store, assets } = await setup();
    const route = createDocumentAssetRoute(assets);
    const named = await assets.importFile({
      data: pdf,
      mime: 'application/pdf',
      name: '报告 "v1"\r\nX-Injected: 1.pdf',
    });
    const response = await route(
      new Request(`http://dsh.internal${ASSET_ROUTE_PATH}?id=${named.id}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('immutable');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).not.toContain('"v1"');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain(encodeURIComponent('报告'));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(pdf));

    // Without a display name the asset id is the download filename.
    const anonymous = await assets.importFile({
      data: new Uint8Array([...pdf, 7]),
      mime: 'application/pdf',
    });
    const fallback = await route(
      new Request(`http://dsh.internal${ASSET_ROUTE_PATH}?id=${anonymous.id}`),
    );
    expect(fallback.headers.get('content-disposition')).toContain(
      `filename="${anonymous.id}"`,
    );
    await store.close();
  });

  it('serves generic file types as octet-stream attachments', async () => {
    const { store, assets } = await setup();
    const route = createDocumentAssetRoute(assets);
    const record = await assets.importFile({
      data: pdf,
      mime: 'application/x-sketch',
      name: '设计.sketch',
    });
    expect(record.mime).toBe(GENERIC_FILE_MIME);
    const response = await route(
      new Request(`http://dsh.internal${ASSET_ROUTE_PATH}?id=${record.id}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(GENERIC_FILE_MIME);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).toContain(encodeURIComponent('设计.sketch'));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(pdf));
    await store.close();
  });
});
