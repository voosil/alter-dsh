/**
 * Comment soft deletion and body-write cascade (Host authority).
 *
 * Deleting a comment leaves a tombstone that `listComments` keeps returning
 * for the history panel; a body write that removes the quoted text
 * soft-deletes the open comments quoting it in the same transaction.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../../../host/authority/compose.js';
import { createDocumentService } from '../../../host/document/editors/legacy/service.js';
import { DEFAULT_SPACE_ID, openSpaceStore } from '../../../host/persistence/store.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('comment soft delete', () => {
  it('keeps a deleted comment in listComments as a tombstone, also after reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-comment-'));
    dirs.push(dir);
    let current = new Date('2026-11-10T09:00:00.000Z');
    const now = () => current;
    let store = await openSpaceStore({ directory: dir, now });
    let service = createSpaceAuthority(store, now).user;

    const space = await service.createSpace({ name: '复盘' });
    const doc = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '结论',
    });
    const comment = await service.addComment({
      docId: doc.id,
      body: '这行要补充数据',
      quote: '结论待定',
      anchor: { blockId: 'blk_1', offset: 0, length: 4 },
    });
    expect(comment.status).toBe('open');
    expect(comment.deletedAt).toBeNull();

    current = new Date('2026-11-10T09:05:00.000Z');
    await service.deleteComment(comment.id);

    const listed = await service.listComments(doc.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(comment.id);
    expect(listed[0]?.status).toBe('deleted');
    expect(listed[0]?.deletedAt).toBe('2026-11-10T09:05:00.000Z');
    // The tombstone keeps its content for the history panel.
    expect(listed[0]?.body).toBe('这行要补充数据');
    expect(listed[0]?.quote).toBe('结论待定');
    expect(listed[0]?.anchor).toEqual({ blockId: 'blk_1', offset: 0, length: 4 });
    // Deleting twice is idempotent and keeps the first timestamp.
    current = new Date('2026-11-10T09:30:00.000Z');
    await service.deleteComment(comment.id);
    expect((await service.listComments(doc.id))[0]?.deletedAt).toBe(
      '2026-11-10T09:05:00.000Z',
    );
    await expect(service.deleteComment('cm-missing')).rejects.toThrow(
      '评论不存在',
    );

    // The tombstone survives a reopen (it is a row, not a transient state).
    await store.close();
    store = await openSpaceStore({ directory: dir, now });
    service = createSpaceAuthority(store, now).user;
    const reopened = await service.listComments(doc.id);
    expect(reopened.map((item) => item.status)).toEqual(['deleted']);
    expect(reopened[0]?.deletedAt).toBe('2026-11-10T09:05:00.000Z');
    await store.close();
  });

  it('treats a tombstone as a no-op for update, supplement and resolve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-comment-'));
    dirs.push(dir);
    const store = await openSpaceStore({
      directory: dir,
      now: () => new Date('2026-11-10T10:00:00.000Z'),
    });
    const service = createSpaceAuthority(store, () => new Date()).user;
    const space = await service.createSpace({ name: '复盘' });
    const doc = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '结论',
    });
    const comment = await service.addComment({ docId: doc.id, body: '意见' });
    await service.deleteComment(comment.id);

    // Writes against a tombstone return it untouched instead of failing: the
    // client may race the body cascade with its own quote write-back.
    const updated = await service.updateComment(comment.id, { body: '改内容' });
    expect(updated.status).toBe('deleted');
    expect(updated.body).toBe('意见');
    expect(updated.editedAt).toBeNull();
    const supplemented = await service.addCommentSupplement(comment.id, '补充');
    expect(supplemented.supplements).toEqual([]);
    const [tombstone] = await service.listComments(doc.id);
    const resolved = await service.resolveComment(comment.id);
    expect(resolved.status).toBe('deleted');
    expect(resolved.resolvedAt).toBeNull();
    expect(resolved.deletedAt).toBe(tombstone?.deletedAt);
    expect(resolved.deletedAt).not.toBeNull();

    // Nothing leaked into storage.
    const listed = await service.listComments(doc.id);
    expect(listed[0]?.status).toBe('deleted');
    expect(listed[0]?.body).toBe('意见');
    expect(listed[0]?.supplements).toEqual([]);
    expect(listed[0]?.resolvedAt).toBeNull();
    await store.close();
  });

  it('resolves only an open comment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-comment-'));
    dirs.push(dir);
    const store = await openSpaceStore({
      directory: dir,
      now: () => new Date('2026-11-10T11:00:00.000Z'),
    });
    const service = createSpaceAuthority(store, () => new Date()).user;
    const space = await service.createSpace({ name: '复盘' });
    const doc = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '结论',
    });
    const comment = await service.addComment({ docId: doc.id, body: '意见' });
    const resolved = await service.resolveComment(comment.id);
    expect(resolved.status).toBe('resolved');
    expect(resolved.deletedAt).toBeNull();
    await expect(service.resolveComment(comment.id)).rejects.toThrow('评论已解决');
    await store.close();
  });
});

describe('comment cascade on body writes', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-cascade-'));
    dirs.push(dir);
    const fixedNow = () => new Date('2026-11-11T09:00:00.000Z');
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const documents = createDocumentService({
      store,
      now: fixedNow,
      actor: 'user',
    });
    const space = createSpaceAuthority(store, fixedNow).user;
    const doc = await documents.generate({
      spaceId: DEFAULT_SPACE_ID,
      title: '发布计划',
      markdown: '第一段正文。\n\n第二段要删掉的内容。\n\n第三段正文。\n',
    });
    const outline = await documents.outline(doc.docId);
    return { store, documents, space, doc, outline };
  }

  it('soft-deletes open comments whose quote disappears with a deleted block', async () => {
    const { store, documents, space, doc } = await setup();
    const read = await documents.read(doc.docId);
    const target = read.blocks.filter((block) => block.type === 'paragraph')[1]!;
    const kept = read.blocks.filter((block) => block.type === 'paragraph')[0]!;

    const onDeleted = await space.addComment({
      docId: doc.docId,
      body: '这句有问题',
      quote: '第二段要删掉的内容。',
      anchor: { blockId: target.id, offset: 0, length: 9 },
    });
    const unaffected = await space.addComment({
      docId: doc.docId,
      body: '第一段不错',
      quote: '第一段正文。',
      anchor: { blockId: kept.id, offset: 0, length: 5 },
    });
    const noQuote = await space.addComment({
      docId: doc.docId,
      body: '总评',
    });

    await documents.applyOperations({
      docId: doc.docId,
      baseRevision: doc.revision,
      ops: [{ op: 'delete_block', target: target.id }],
    });

    const listed = await space.listComments(doc.docId);
    const byId = new Map(listed.map((comment) => [comment.id, comment]));
    expect(byId.get(onDeleted.id)?.status).toBe('deleted');
    expect(byId.get(onDeleted.id)?.deletedAt).toBe(
      '2026-11-11T09:00:00.000Z',
    );
    // Tombstone content is kept for the history panel.
    expect(byId.get(onDeleted.id)?.quote).toBe('第二段要删掉的内容。');
    expect(byId.get(unaffected.id)?.status).toBe('open');
    expect(byId.get(noQuote.id)?.status).toBe('open');
    // The tombstone stays listed.
    expect(listed).toHaveLength(3);
    await store.close();
  });

  it('cascades on an update_text edit that erases the quoted span', async () => {
    const { store, documents, space, doc } = await setup();
    const read = await documents.read(doc.docId);
    const target = read.blocks.filter((block) => block.type === 'paragraph')[0]!;
    const comment = await space.addComment({
      docId: doc.docId,
      body: '这句要确认',
      quote: '第一段正文。',
      anchor: { blockId: target.id, offset: 0, length: 5 },
    });

    await documents.applyOperations({
      docId: doc.docId,
      baseRevision: doc.revision,
      ops: [
        {
          op: 'update_text',
          target: target.id,
          edits: [{ oldText: '第一段正文。', newText: '换了写法。' }],
        },
      ],
    });

    const [listed] = await space.listComments(doc.docId);
    expect(listed?.id).toBe(comment.id);
    expect(listed?.status).toBe('deleted');
    expect(listed?.deletedAt).not.toBeNull();
    await store.close();
  });

  it('does not cascade on unrelated edits, and leaves resolved comments alone', async () => {
    const { store, documents, space, doc } = await setup();
    const read = await documents.read(doc.docId);
    const paragraphs = read.blocks.filter((block) => block.type === 'paragraph');
    const first = paragraphs[0]!;
    const second = paragraphs[1]!;
    const open = await space.addComment({
      docId: doc.docId,
      body: '第二段不错',
      quote: '第二段要删掉的内容。',
      anchor: { blockId: second.id, offset: 0, length: 9 },
    });
    const resolved = await space.addComment({
      docId: doc.docId,
      body: '历史结论',
      quote: '第三段正文。',
    });
    await space.resolveComment(resolved.id);

    // An edit in a different paragraph never touches either comment.
    await documents.applyOperations({
      docId: doc.docId,
      baseRevision: doc.revision,
      ops: [
        {
          op: 'update_text',
          target: first.id,
          edits: [{ oldText: '第一段正文。', newText: '第一段正文，改写。' }],
        },
      ],
    });
    let listed = await space.listComments(doc.docId);
    expect(listed.find((item) => item.id === open.id)?.status).toBe('open');
    expect(listed.find((item) => item.id === resolved.id)?.status).toBe(
      'resolved',
    );

    // Deleting the block behind the resolved comment must not delete it:
    // resolved is already history. The open comment still has its quote, so
    // it survives this write too.
    const outline = await documents.outline(doc.docId);
    const third = outline.outline.filter((block) => block.type === 'paragraph')[2]!;
    await documents.applyOperations({
      docId: doc.docId,
      baseRevision: outline.revision,
      ops: [{ op: 'delete_block', target: third.id }],
    });
    listed = await space.listComments(doc.docId);
    expect(listed.find((item) => item.id === resolved.id)?.status).toBe('resolved');
    expect(listed.find((item) => item.id === resolved.id)?.deletedAt).toBeNull();
    expect(listed.find((item) => item.id === open.id)?.status).toBe('open');
    await store.close();
  });

  it('keeps a quote write-back after the cascade a silent no-op', async () => {
    const { store, documents, space, doc } = await setup();
    const read = await documents.read(doc.docId);
    const target = read.blocks.filter((block) => block.type === 'paragraph')[0]!;
    const comment = await space.addComment({
      docId: doc.docId,
      body: '这句要确认',
      quote: '第一段正文。',
      anchor: { blockId: target.id, offset: 0, length: 5 },
    });

    await documents.applyOperations({
      docId: doc.docId,
      baseRevision: doc.revision,
      ops: [
        {
          op: 'update_text',
          target: target.id,
          edits: [{ oldText: '第一段正文。', newText: '换了写法。' }],
        },
      ],
    });
    const cascaded = (await space.listComments(doc.docId))[0]!;
    expect(cascaded.status).toBe('deleted');

    // The client's trailing write-back must not throw nor revive the row.
    const writtenBack = await space.updateComment(comment.id, { quote: '' });
    expect(writtenBack.status).toBe('deleted');
    const [listed] = await space.listComments(doc.docId);
    expect(listed?.status).toBe('deleted');
    expect(listed?.quote).toBe('第一段正文。');
    expect(listed?.deletedAt).toBe(cascaded.deletedAt);
    await store.close();
  });

  it('does not cascade on a dry-run preview', async () => {
    const { store, documents, space, doc } = await setup();
    const read = await documents.read(doc.docId);
    const target = read.blocks.filter((block) => block.type === 'paragraph')[1]!;
    const comment = await space.addComment({
      docId: doc.docId,
      body: '这句有问题',
      quote: '第二段要删掉的内容。',
      anchor: { blockId: target.id, offset: 0, length: 9 },
    });

    await documents.applyOperations({
      docId: doc.docId,
      baseRevision: doc.revision,
      ops: [{ op: 'delete_block', target: target.id }],
      dryRun: true,
    });

    const [listed] = await space.listComments(doc.docId);
    expect(listed?.id).toBe(comment.id);
    expect(listed?.status).toBe('open');
    await store.close();
  });
});