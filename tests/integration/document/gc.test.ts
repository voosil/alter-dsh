import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assetFilePath, createDocumentAssets } from '../../../host/document/asset-store.js';
import { gcDocumentArtifacts } from '../../../host/document/gc.js';
import { createDocumentService } from '../../../host/document/editors/legacy/service.js';
import { DEFAULT_SPACE_ID, openSpaceStore } from '../../../host/persistence/store.js';

const dirs: string[] = [];
const fixedNow = () => new Date('2026-11-09T00:00:00.000Z');

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-gc-'));
  dirs.push(dir);
  const store = await openSpaceStore({ directory: dir, now: fixedNow });
  return { dir, store };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('document artifact GC', () => {
  it('removes unreferenced objects while keeping current and version references', async () => {
    const { dir, store } = await setup();
    const service = createDocumentService({ store, now: fixedNow });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: ':::mindmap{objectId="obj_seed"}\n:::\n',
    });
    const block = (await service.get(created.docId)).doc.blocks[0]!;
    const updated = await service.updateObject({
      docId: created.docId,
      blockId: block.id,
      baseRevision: created.revision,
      payload: { root: { id: 'n1', text: 'root' } },
    });
    const liveObjectId = updated.objectId;

    await store.transactDocument((_data, sidecar) => {
      sidecar.putObject({
        id: 'obj_orphan',
        docId: created.docId,
        type: 'mindmap',
        schemaVersion: 1,
        payload: { root: { id: 'n1', text: 'orphan' } },
        createdAt: fixedNow().toISOString(),
      });
      sidecar.putObject({
        id: 'obj_version_only',
        docId: created.docId,
        type: 'mindmap',
        schemaVersion: 1,
        payload: { root: { id: 'n1', text: 'version' } },
        createdAt: fixedNow().toISOString(),
      });
    });
    await store.update((data) => {
      data.versions.push({
        id: 'ver_gc',
        docId: created.docId,
        title: '历史',
        content: JSON.stringify({
          format: 'alter-doc/1',
          schemaVersion: 1,
          revision: 1,
          blocks: [
            {
              id: 'blk_version',
              type: 'mindmap',
              attrs: {
                objectId: 'obj_version_only',
              },
            },
          ],
        }),
        author: 'me',
        at: fixedNow().toISOString(),
      });
    });

    const result = await gcDocumentArtifacts({ store, directory: dir });
    expect(result.objectsRemoved).toBe(1);
    expect(await service.getObject(liveObjectId)).toBeDefined();
    expect(await service.getObject('obj_version_only')).toBeDefined();
    expect(await service.getObject('obj_orphan')).toBeUndefined();
    await store.close();
  });

  it('removes unreferenced asset bytes and metadata', async () => {
    const { dir, store } = await setup();
    const assets = createDocumentAssets({ store, directory: dir, now: fixedNow });
    const keep = await assets.import({
      data: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
    });
    const orphan = await assets.import({
      data: new Uint8Array([4, 5, 6]),
      mime: 'image/png',
    });
    const service = createDocumentService({ store, now: fixedNow });
    await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: `# 图\n\n![图](space-asset://${keep.id})\n`,
    });

    const result = await gcDocumentArtifacts({ store, directory: dir });
    expect(result.assetsRemoved).toBe(1);
    await expect(stat(assetFilePath(dir, keep))).resolves.toBeTruthy();
    await expect(readFile(assetFilePath(dir, orphan))).rejects.toBeTruthy();
    expect(await assets.get(orphan.id)).toBeUndefined();
    expect(await assets.get(keep.id)).toBeDefined();
    await store.close();
  });

  it('skips non-AST content instead of failing GC', async () => {
    const { dir, store } = await setup();
    await store.update((data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push({
        id: 'doc-plain',
        spaceId: DEFAULT_SPACE_ID,
        kind: 'note',
        title: '非结构化文档',
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
        content: '<p>obj_node_ref</p>',
        activity: 0,
        activityAt: fixedNow().toISOString(),
        lastOpenCreditAt: null,
        lastEditCreditAt: null,
        createdAt: fixedNow().toISOString(),
        updatedAt: fixedNow().toISOString(),
        order: 0,
      });
      data.versions.push({
        id: 'ver-plain',
        docId: 'doc-plain',
        title: '旧快照',
        content: '<p>obj_version_ref</p>',
        author: 'me',
        at: fixedNow().toISOString(),
      });
    });
    await store.transactDocument((_data, sidecar) => {
      for (const id of ['obj_node_ref', 'obj_version_ref']) {
        sidecar.putObject({
          id,
          docId: 'doc-plain',
          type: 'mindmap',
          schemaVersion: 1,
          payload: { root: { id: 'n1', text: id } },
          createdAt: fixedNow().toISOString(),
        });
      }
    });
    const result = await gcDocumentArtifacts({ store, directory: dir });
    expect(result.objectsRemoved).toBe(2);
    expect(await store.getDocumentObject('obj_node_ref')).toBeUndefined();
    expect(await store.getDocumentObject('obj_version_ref')).toBeUndefined();
    await store.close();
  });
});
