import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocumentAssets } from '../host/document/assets.js';
import { createDocumentMigration } from '../host/document/migrate.js';
import { createDocumentService } from '../host/document/service.js';
import { parseAlterDoc, type AlterDoc } from '../host/document/types.js';
import { DEFAULT_SPACE_ID, openSpaceStore } from '../host/store.js';

const dirs: string[] = [];
const fixedNow = () => new Date('2026-11-09T00:00:00.000Z');
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function legacyNode(id: string, html: string): Record<string, unknown> {
  return {
    id,
    spaceId: DEFAULT_SPACE_ID,
    kind: 'note',
    title: `旧文档 ${id}`,
    parentId: null,
    creator: 'me',
    pinned: false,
    archived: false,
    archivedBy: null,
    archivedAt: null,
    deletedAt: null,
    deletedRoot: false,
    originalParentId: null,
    unread: false,
    content: html,
    activity: 10,
    activityAt: fixedNow().toISOString(),
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: fixedNow().toISOString(),
    updatedAt: fixedNow().toISOString(),
    order: 0,
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-migrate-'));
  dirs.push(dir);
  const store = await openSpaceStore({ directory: dir, now: fixedNow });
  const assets = createDocumentAssets({ store, directory: dir, now: fixedNow });
  return { dir, store, assets };
}

const HTML = [
  '<h1>标题</h1>',
  '<p>正文 <strong>加粗</strong> 和 <mark>高亮</mark></p>',
  '<ul><li>一</li><li>二</li></ul>',
  '<blockquote><p>引用</p></blockquote>',
  '<pre><code>const a = 1;</code></pre>',
  '<hr>',
  '<table><tr><th>列1</th><th>列2</th></tr><tr><td>a</td><td>b</td></tr></table>',
  `<p><img src="${IMAGE}" alt="图"></p>`,
].join('');

describe('legacy HTML migration', () => {
  it('converts one legacy document, imports inline images and records a version', async () => {
    const { dir, store, assets } = await setup();
    await store.update((data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(
        legacyNode('doc-legacy', HTML),
      );
    });
    const migration = createDocumentMigration({ store, assets, now: fixedNow });
    expect(migration.countLegacy()).toBe(1);

    const result = await migration.migrateDocument('doc-legacy');
    expect(result.migrated).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.assetsImported).toBe(1);

    const node = store.read().nodes.find((item) => item.id === 'doc-legacy')!;
    expect((node as { contentFormat?: string }).contentFormat).toBe('alter-doc/1');
    const stored = parseAlterDoc(node.content);
    expect(stored.kind).toBe('alter-doc');
    const doc = (stored as { doc: AlterDoc }).doc;
    const types = doc.blocks.map((block) => block.type);
    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('bulletList');
    expect(types).toContain('blockquote');
    expect(types).toContain('codeBlock');
    expect(types).toContain('divider');
    expect(types).toContain('table');
    expect(types).toContain('image');
    const image = doc.blocks.find((block) => block.type === 'image')!;
    const assetId = image.attrs.assetId;
    expect(typeof assetId).toBe('string');
    expect(await assets.get(assetId as string)).toBeDefined();
    expect(
      store.read().versions.some((version) => version.docId === 'doc-legacy'),
    ).toBe(true);

    const again = await migration.migrateDocument('doc-legacy');
    expect(again.migrated).toBe(false);
    expect(again.reason).toBe('already-ast');
    expect(migration.countLegacy()).toBe(0);
    expect(dir).toBeTruthy();
    await store.close();
  });

  it('migrates every legacy note and isolates per-document failures', async () => {
    const { store, assets } = await setup();
    await store.update((data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(
        legacyNode('doc-a', '<p>甲</p>'),
        legacyNode('doc-b', '<h2>乙</h2>'),
      );
    });
    const migration = createDocumentMigration({ store, assets, now: fixedNow });
    const batch = await migration.migrateAll();
    expect(batch.migrated).toBe(2);
    expect(batch.failed).toEqual([]);
    await expect(migration.migrateDocument('doc-missing')).rejects.toMatchObject({
      code: 'doc/not-found',
    });

    const service = createDocumentService({ store, now: fixedNow });
    const outline = await service.outline('doc-a');
    expect(outline.totalBlocks).toBeGreaterThan(0);
    await store.close();
  });
});
