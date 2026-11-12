import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../../../host/authority/compose.js';
import { createDocumentService } from '../../../host/document/editors/legacy/service.js';
import { DocumentError, parseAlterDoc } from '../../../host/document/editors/legacy/types.js';
import { DEFAULT_SPACE_ID, openSpaceStore, type SpaceStoreHandle } from '../../../host/persistence/store.js';

const dirs: string[] = [];
const fixedNow = () => new Date('2026-11-09T00:00:00.000Z');

async function tempStore(): Promise<{ store: SpaceStoreHandle; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-doc-'));
  dirs.push(dir);
  const store = await openSpaceStore({ directory: dir, now: fixedNow });
  return { store, dir };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('document service', () => {
  it('generates, reads and edits an AST document with revision CAS', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const generated = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      title: '鉴权方案',
      markdown: '# 鉴权方案\n\n先做 P0。\n\n- 只读工具\n- 写入工具\n',
    });
    expect(generated.revision).toBe(1);
    expect(generated.changedBlockIds.length).toBeGreaterThan(0);
    expect(generated.title).toBe('鉴权方案');

    const outline = await service.outline(generated.docId);
    expect(outline.totalBlocks).toBeGreaterThanOrEqual(5);
    expect(outline.outline[0]?.type).toBe('heading');

    const read = await service.read(generated.docId);
    expect(read.markdown).toContain('<!-- blk:');
    expect(read.markdown).toContain('# 鉴权方案');
    expect(read.revision).toBe(1);
    const paragraph = read.blocks.find((block) => block.type === 'paragraph');
    expect(paragraph).toBeDefined();

    const edited = await service.applyOperations({
      docId: generated.docId,
      baseRevision: 1,
      ops: [
        {
          op: 'update_text',
          target: paragraph!.id,
          edits: [{ oldText: '先做 P0。', newText: '先做 P0，再评估。' }],
        },
      ],
    });
    expect(edited.revision).toBe(2);
    expect(edited.changedBlockIds).toContain(paragraph!.id);
    expect(edited.undoToken).toBeDefined();
    const after = await service.read(generated.docId);
    expect(after.markdown).toContain('先做 P0，再评估。');

    await expect(
      service.applyOperations({
        docId: generated.docId,
        baseRevision: 1,
        ops: [{ op: 'delete_block', target: paragraph!.id }],
      }),
    ).rejects.toMatchObject({ code: 'doc/conflict' });

    const replay = await service.applyOperations({
      docId: generated.docId,
      baseRevision: 2,
      idempotencyKey: 'turn-1',
      ops: [
        {
          op: 'update_text',
          target: paragraph!.id,
          edits: [{ oldText: '先做 P0，再评估。', newText: '先做 P0。' }],
        },
      ],
    });
    const again = await service.applyOperations({
      docId: generated.docId,
      baseRevision: 2,
      idempotencyKey: 'turn-1',
      ops: [
        {
          op: 'update_text',
          target: paragraph!.id,
          edits: [{ oldText: '先做 P0，再评估。', newText: '先做 P0。' }],
        },
      ],
    });
    expect(again.revision).toBe(replay.revision);
    await expect(
      service.applyOperations({
        docId: generated.docId,
        baseRevision: 2,
        idempotencyKey: 'turn-1',
        ops: [{ op: 'delete_block', target: paragraph!.id }],
      }),
    ).rejects.toMatchObject({ code: 'idempotency/conflict' });

    const dry = await service.applyOperations({
      docId: generated.docId,
      baseRevision: replay.revision,
      dryRun: true,
      ops: [{ op: 'delete_block', target: paragraph!.id }],
    });
    expect(dry.revision).toBe(replay.revision);
    expect((await service.read(generated.docId)).revision).toBe(replay.revision);
    await store.close();
  });

  it('reads full AST and undoes one operation batch', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '原文段落\n',
    });
    const loaded = await service.get(created.docId);
    expect(loaded.revision).toBe(1);
    expect(loaded.doc.blocks).toHaveLength(1);
    expect(loaded.doc.blocks[0]?.type).toBe('paragraph');

    const paragraphId = loaded.doc.blocks[0]!.id;
    const edited = await service.applyOperations({
      docId: created.docId,
      baseRevision: 1,
      ops: [
        {
          op: 'update_text',
          target: paragraphId,
          edits: [{ oldText: '原文段落', newText: '改后段落' }],
        },
      ],
    });
    expect(edited.revision).toBe(2);

    await expect(
      service.undo({ docId: created.docId, baseRevision: 1 }),
    ).rejects.toMatchObject({ code: 'doc/conflict' });
    await expect(
      service.undo({
        docId: created.docId,
        baseRevision: 2,
        undoToken: 'op_missing',
      }),
    ).rejects.toMatchObject({ code: 'op/invalid' });

    const undone = await service.undo({
      docId: created.docId,
      baseRevision: 2,
    });
    expect(undone.revision).toBe(3);
    const reread = await service.read(created.docId);
    expect(reread.markdown).toContain('原文段落');
    expect(reread.markdown).not.toContain('改后段落');
    await store.close();
  });

  it('inserts new markdown into an existing document via generate', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '# 标题\n',
    });
    const inserted = await service.generate({
      docId: created.docId,
      markdown: '新的章节内容\n',
    });
    expect(inserted.revision).toBe(2);
    const read = await service.read(created.docId);
    expect(read.markdown).toContain('新的章节内容');
    await store.close();
  });

  it('updates structured objects atomically and keeps them immutable', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: ':::mindmap{objectId="obj_seed"}\n:::\n',
    });
    const read = await service.read(created.docId);
    const block = read.blocks.find((entry) => entry.type === 'mindmap');
    expect(block).toBeDefined();

    const updated = await service.updateObject({
      docId: created.docId,
      blockId: block!.id,
      baseRevision: created.revision,
      payload: { root: { id: 'n1', text: '目标' } },
    });
    expect(updated.objectId).toMatch(/^obj_/);
    const record = await service.getObject(updated.objectId);
    expect(record?.payload).toEqual({ root: { id: 'n1', text: '目标' } });
    expect(await service.getObject('obj_seed')).toBeUndefined();

    const reread = await service.read(created.docId);
    expect(reread.markdown).toContain(`objectId="${updated.objectId}"`);
    await store.close();
  });

  it('restores an older AST version through operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-restore-'));
    dirs.push(dir);
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    let clock = new Date('2026-11-09T00:00:00.000Z');
    const service = createDocumentService({ store, now: () => clock, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '原始内容\n',
    });
    const originalVersion = store
      .read()
      .versions.filter((version) => version.docId === created.docId)[0];
    expect(originalVersion).toBeDefined();

    clock = new Date('2026-11-09T00:10:00.000Z');
    const paragraph = (await service.get(created.docId)).doc.blocks[0]!;
    await service.applyOperations({
      docId: created.docId,
      baseRevision: 1,
      ops: [
        {
          op: 'update_text',
          target: paragraph.id,
          edits: [{ oldText: '原始内容', newText: '修改后的内容' }],
        },
      ],
    });
    expect((await service.read(created.docId)).markdown).toContain('修改后的内容');

    await expect(
      service.restoreVersion({
        docId: created.docId,
        versionId: originalVersion!.id,
        baseRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'doc/conflict' });
    await expect(
      service.restoreVersion({
        docId: created.docId,
        versionId: 'ver_missing',
        baseRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'op/invalid' });

    clock = new Date('2026-11-09T00:20:00.000Z');
    const restored = await service.restoreVersion({
      docId: created.docId,
      versionId: originalVersion!.id,
      baseRevision: 2,
    });
    expect(restored.revision).toBe(3);
    const read = await service.read(created.docId);
    expect(read.markdown).toContain('原始内容');
    expect(read.markdown).not.toContain('修改后的内容');
    await store.close();
  });

  it('restores a version that needs more than 64 operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-restore-large-'));
    dirs.push(dir);
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    let clock = new Date('2026-11-09T00:00:00.000Z');
    const service = createDocumentService({ store, now: () => clock, actor: 'user' });
    const lines = Array.from({ length: 80 }, (_, index) => `第 ${index} 行`).join(
      '\n\n',
    );
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: `${lines}\n`,
    });
    expect((await service.get(created.docId)).doc.blocks).toHaveLength(80);
    const initialVersion = store
      .read()
      .versions.filter((version) => version.docId === created.docId)[0];
    expect(initialVersion).toBeDefined();

    clock = new Date('2026-11-09T00:10:00.000Z');
    const firstBlock = (await service.get(created.docId)).doc.blocks[0]!;
    await service.applyOperations({
      docId: created.docId,
      baseRevision: 1,
      ops: [
        {
          op: 'update_text',
          target: firstBlock.id,
          edits: [{ oldText: '第 0 行', newText: '改过的第一行' }],
        },
      ],
    });
    expect((await service.read(created.docId)).markdown).toContain('改过的第一行');

    clock = new Date('2026-11-09T00:20:00.000Z');
    const restored = await service.restoreVersion({
      docId: created.docId,
      versionId: initialVersion!.id,
      baseRevision: 2,
    });
    expect(restored.revision).toBe(3);
    const doc = await service.get(created.docId);
    expect(doc.doc.blocks).toHaveLength(80);
    expect((await service.read(created.docId)).markdown).toContain('第 0 行');
    expect((await service.read(created.docId)).markdown).not.toContain(
      '改过的第一行',
    );
    await store.close();
  });

  it('keeps a way back after a restore, even at the minimum history limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-restore-undo-'));
    dirs.push(dir);
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    // The tightest policy the product allows: exactly one version per document.
    const policy = { historyLimit: 1, snapshotKeep: 1 };
    let clock = new Date('2026-11-09T00:00:00.000Z');
    const service = createDocumentService({
      store,
      now: () => clock,
      actor: 'user',
      settings: policy,
    });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '第一版\n',
    });
    const firstVersion = store
      .read()
      .versions.filter((version) => version.docId === created.docId)[0];
    expect(firstVersion).toBeDefined();

    clock = new Date('2026-11-09T00:10:00.000Z');
    const block = (await service.get(created.docId)).doc.blocks[0]!;
    await service.applyOperations({
      docId: created.docId,
      baseRevision: 1,
      ops: [
        {
          op: 'update_text',
          target: block.id,
          edits: [{ oldText: '第一版', newText: '第二版' }],
        },
      ],
    });

    clock = new Date('2026-11-09T00:20:00.000Z');
    await service.restoreVersion({
      docId: created.docId,
      versionId: firstVersion!.id,
      baseRevision: 2,
    });
    expect((await service.read(created.docId)).markdown).toContain('第一版');

    // The restore recorded the body it replaced, and trimming must not drop it:
    // this is the undo point that makes "restore the wrong version" recoverable.
    const versions = store
      .read()
      .versions.filter((version) => version.docId === created.docId);
    const preRestore = versions.find((version) =>
      version.content.includes('第二版'),
    );
    expect(preRestore).toBeDefined();

    // Restoring that undo point brings the newer body back.
    clock = new Date('2026-11-09T00:30:00.000Z');
    await service.restoreVersion({
      docId: created.docId,
      versionId: preRestore!.id,
      baseRevision: 3,
    });
    expect((await service.read(created.docId)).markdown).toContain('第二版');
    await store.close();
  });

  it('rewrites a large body in one restore and keeps its undo point', async () => {
    // Restore rewrites the body as "delete every top-level block + insert the
    // stored one", so the batch cap has to cover a whole large document.
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-restore-big-'));
    dirs.push(dir);
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    let clock = new Date('2026-11-09T00:00:00.000Z');
    const service = createDocumentService({ store, now: () => clock, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '小版本\n',
    });
    clock = new Date('2026-11-09T00:10:00.000Z');
    const filler = Array.from({ length: 3_000 }, (_, index) => `行 ${index}\n`)
      .join('\n');
    await service.generate({ docId: created.docId, markdown: filler });
    const grown = await service.get(created.docId);
    expect(grown.doc.blocks.length).toBeGreaterThan(2_000);
    // The body that is about to be replaced is exactly what a restore must be
    // able to undo, so capture it the way a version restore does.
    const bigVersion = store
      .read()
      .versions.filter((version) => version.docId === created.docId)
      .filter((version) => version.content.includes('行 2999'))[0];
    expect(bigVersion).toBeDefined();

    clock = new Date('2026-11-09T00:20:00.000Z');
    const restored = await service.restoreVersion({
      docId: created.docId,
      versionId: bigVersion!.id,
      baseRevision: grown.revision,
    });
    expect(restored.revision).toBe(grown.revision + 1);
    const doc = await service.get(created.docId);
    expect(doc.doc.blocks.length).toBe(grown.doc.blocks.length);
    // The undo point survives the restore even though two large bodies exceed
    // the per-document byte budget: a restore must stay reversible.
    const versions = store
      .read()
      .versions
      .filter((version) => version.docId === created.docId)
      .filter((version) => version.content.includes('行 2999'));
    expect(versions.length).toBeGreaterThan(0);
    await store.close();
  });

  it('searches AST text and skips non-AST content', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      title: '搜索文档',
      markdown: 'token 刷新策略\n',
    });
    const hits = await service.search({ query: 'token', docId: created.docId });
    expect(hits.hits[0]?.blockId).toBeDefined();

    const nested = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      title: '嵌套搜索',
      markdown: ':::callout{tone="info" title="说明"}\n这是真实 Agent 复验。\n:::\n',
    });
    const nestedHits = await service.search({
      query: '真实',
      docId: nested.docId,
    });
    expect(nestedHits.hits.length).toBeGreaterThan(0);
    for (const hit of nestedHits.hits) expect(hit.preview).toContain('真实');

    await store.updateAs('user', (data) => {
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
        content: '<p>旧内容</p>',
        activity: 0,
        activityAt: fixedNow().toISOString(),
        lastOpenCreditAt: null,
        lastEditCreditAt: null,
        createdAt: fixedNow().toISOString(),
        updatedAt: fixedNow().toISOString(),
        order: 0,
      });
    });
    await expect(service.outline('doc-plain')).rejects.toMatchObject({
      code: 'doc/schema-invalid',
    });
    await expect(service.get('doc-plain')).rejects.toMatchObject({
      code: 'doc/schema-invalid',
    });
    const plainHits = await service.search({
      query: '旧内容',
      spaceId: DEFAULT_SPACE_ID,
    });
    expect(plainHits.hits.some((hit) => hit.docId === 'doc-plain')).toBe(false);
    await expect(service.outline('doc-missing')).rejects.toMatchObject({
      code: 'doc/not-found',
    });
    expect(DocumentError).toBeDefined();
    await store.close();
  });

  it('searches card titles through structured attributes', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '正文\n',
    });
    await service.applyOperations({
      docId: created.docId,
      baseRevision: 1,
      ops: [
        {
          op: 'insert_blocks',
          index: 1,
          blocks: [
            {
              id: 'blk_card_bookmark',
              type: 'bookmark',
              attrs: {
                url: 'https://example.com/ops',
                title: '卡片标题',
                description: '卡片描述',
              },
            },
            {
              id: 'blk_card_doclink',
              type: 'docLink',
              attrs: { docId: 'doc-target', title: '内链文档标题' },
            },
          ],
        },
      ],
    });
    const bookmarkHits = await service.search({
      query: '卡片标题',
      docId: created.docId,
    });
    expect(
      bookmarkHits.hits.some((hit) => hit.blockId === 'blk_card_bookmark'),
    ).toBe(true);
    const docLinkHits = await service.search({
      query: '内链文档标题',
      docId: created.docId,
    });
    expect(
      docLinkHits.hits.some((hit) => hit.blockId === 'blk_card_doclink'),
    ).toBe(true);
    await store.close();
  });

  it('creates an empty AST note that document operations can edit', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const created = await service.createNote({
      spaceId: DEFAULT_SPACE_ID,
      title: '  空白文档  ',
    });
    expect(created.id).toMatch(/^doc-/);
    expect(created.kind).toBe('note');
    expect(created.title).toBe('空白文档');
    expect(created.creator).toBe('me');
    expect(created.parentId).toBeNull();
    expect(created).not.toHaveProperty('contentFormat');
    const doc = parseAlterDoc(created.content);
    expect(doc.format).toBe('alter-doc/1');
    expect(doc.revision).toBe(1);
    expect(doc.blocks).toEqual([]);

    const read = await service.read(created.id);
    expect(read.revision).toBe(1);
    expect(read.markdown).toBe('');
    const edited = await service.applyOperations({
      docId: created.id,
      baseRevision: 1,
      ops: [{ op: 'insert_markdown', markdown: '第一段\n' }],
    });
    expect(edited.revision).toBe(2);
    expect((await service.read(created.id)).markdown).toContain('第一段');
    await store.close();
  });

  it('places new notes in a folder or under another note and rejects invalid parents', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const space = createSpaceAuthority(store, fixedNow).user;
    const folder = await space.createNode({
      spaceId: DEFAULT_SPACE_ID,
      kind: 'folder',
    });
    const inFolder = await service.createNote({
      spaceId: DEFAULT_SPACE_ID,
      parentId: folder.id,
    });
    expect(inFolder.parentId).toBe(folder.id);
    const note = await service.createNote({ spaceId: DEFAULT_SPACE_ID });
    // A note may also be a sub-document of another note: the page's 子文档
    // footer and the sidebar quick-add create exactly this shape.
    const subDocument = await service.createNote({
      spaceId: DEFAULT_SPACE_ID,
      parentId: note.id,
    });
    expect(subDocument.parentId).toBe(note.id);
    expect(subDocument.kind).toBe('note');
    await expect(
      service.createNote({ spaceId: DEFAULT_SPACE_ID, parentId: 'missing' }),
    ).rejects.toMatchObject({ code: 'op/invalid' });
    await expect(
      service.createNote({ spaceId: 'sp-missing' }),
    ).rejects.toMatchObject({ code: 'doc/not-found' });
    await store.close();
  });

  it('persists merged-table cell spans and rejects invalid spans', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      title: '表格文档',
      markdown: '# 表格文档\n\n正文\n',
    });
    const mergedTable = {
      id: 'blk_merged_table',
      type: 'table',
      attrs: { headerRows: 1 },
      children: [
        {
          id: 'blk_merged_row1',
          type: 'tableRow',
          attrs: {},
          children: [
            {
              id: 'blk_merged_cell1',
              type: 'tableCell',
              attrs: { colspan: 2, rowspan: 2 },
              content: [{ type: 'text', text: '合并' }],
            },
          ],
        },
        // Covered by the rowspan above; ProseMirror's merge model leaves it empty.
        { id: 'blk_merged_row2', type: 'tableRow', attrs: {} },
      ],
    };
    const applied = await service.applyOperations({
      docId: created.docId,
      baseRevision: created.revision,
      ops: [{ op: 'insert_blocks', blocks: [mergedTable] }],
    });
    const stored = await service.get(created.docId);
    const table = stored.doc.blocks.find((item) => item.type === 'table')!;
    expect(table.children?.[0]?.children?.[0]?.attrs).toEqual({
      colspan: 2,
      rowspan: 2,
    });
    expect(table.children?.[1]?.children ?? []).toEqual([]);

    for (const [colspan, rowspan] of [
      [0, 1],
      [51, 1],
      [2, 99],
      [1.5, 1],
    ]) {
      const invalid = {
        ...mergedTable,
        id: 'blk_invalid_table',
        children: [
          {
            id: 'blk_invalid_row',
            type: 'tableRow',
            attrs: {},
            children: [
              {
                id: 'blk_invalid_cell',
                type: 'tableCell',
                attrs: { colspan, rowspan },
                content: [{ type: 'text', text: 'x' }],
              },
            ],
          },
        ],
      };
      await expect(
        service.applyOperations({
          docId: created.docId,
          baseRevision: applied.revision,
          ops: [{ op: 'insert_blocks', blocks: [invalid] }],
        }),
      ).rejects.toMatchObject({
        code: 'node/schema-invalid',
        message: expect.stringMatching(/colspan|rowspan/),
      });
    }
    await store.close();
  });

  it('rejects restoring a historical version that is not a valid AST', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '原文\n',
    });
    await store.updateAs('user', (data) => {
      data.versions.push({
        id: 'ver-plain',
        docId: created.docId,
        title: '旧快照',
        content: '<p>旧内容</p>',
        author: 'me',
        at: fixedNow().toISOString(),
      });
    });
    await expect(
      service.restoreVersion({
        docId: created.docId,
        versionId: 'ver-plain',
        baseRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'doc/schema-invalid' });
    await store.close();
  });

  it('refuses to open a stored document above the write limit', async () => {
    const { store } = await tempStore();
    const service = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const created = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      title: '超大文档',
      markdown: '# 超大文档\n\n内容\n',
    });
    // A row can outgrow the limit through repeated appends; opening it must
    // fail with an actionable code instead of arming a document that can
    // never be saved again.
    await store.updateAs('user', (data) => {
      const node = data.nodes.find((item) => item.id === created.docId);
      if (node === undefined) throw new Error('fixture document missing');
      node.content = JSON.stringify({
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: 1,
        blocks: [
          {
            id: 'blk-huge',
            type: 'paragraph',
            content: [{ type: 'text', text: 'x'.repeat(600 * 1024) }],
          },
        ],
      });
    });
    await expect(service.get(created.docId)).rejects.toMatchObject({
      code: 'doc/too-large',
    });
    await store.close();
  });
});
