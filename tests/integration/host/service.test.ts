import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../../../host/authority/compose.js';
import { createDocumentService } from '../../../host/document/editors/legacy/service.js';
import { parseAlterDoc } from '../../../host/document/editors/legacy/types.js';
import { DEFAULT_SPACE_ID, openSpaceStore } from '../../../host/persistence/store.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-service-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date('2026-11-06T00:00:00.000Z');

/** Serialize a document body the way the document service stores it. */
function astContent(...paragraphs: string[]): string {
  return JSON.stringify({
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: paragraphs.map((text, index) => ({
      id: `blk_service_${index + 1}`,
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text }],
    })),
  });
}

describe('Space business service over SQLite', () => {
  it('persists documents, comments, versions and hub through a reopen', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const service = createSpaceAuthority(store, fixedNow).user;

    const space = await service.createSpace({ name: '写作' });
    const doc = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '第一篇',
    });
    await service.saveNode(doc.id, {
      content: astContent('hello world'),
    });
    const comment = await service.addComment({
      docId: doc.id,
      body: '留下评论',
    });
    await service.updateComment(comment.id, { body: '已修改' });
    const versions = await service.listVersions(doc.id);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const thought = await service.createThought({
      spaceId: space.id,
      content: '一个随想',
    });
    // Thoughts stay plain text and are searched without AST parsing.
    const thoughtHits = await service.search(space.id, '随想');
    expect(thoughtHits.some((hit) => hit.type === 'thought')).toBe(true);
    const converted = await service.convertThought(thought.id);
    expect(converted.node.spaceId).toBe(space.id);
    expect(converted.thought.convertedDocId).toBe(converted.node.id);
    const convertedDoc = parseAlterDoc(converted.node.content);
    expect(convertedDoc.revision).toBe(1);
    expect(convertedDoc.blocks).toEqual([]);
    // The converted note is immediately openable through the document model.
    const documents = createDocumentService({ store, now: fixedNow, actor: 'user' });
    const opened = await documents.get(converted.node.id);
    expect(opened.revision).toBe(1);
    expect(opened.doc.blocks).toEqual([]);
    await service.hub.setPolicy(space.id, 'judge');
    await service.hub.setPluginEnabled(space.id, 'config', true);
    await service.hub.summarize(space.id);
    const hub = await service.hub.get(space.id);
    expect(hub.policy).toBe('judge');
    expect(hub.plugins.map((plugin) => plugin.id)).toEqual([
      'overview',
      'config',
    ]);
    expect(hub.summary.content.length).toBeGreaterThan(0);
    expect(await service.search(space.id, 'hello')).not.toHaveLength(0);

    await store.close();
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    const restored = createSpaceAuthority(reopened, fixedNow).user;
    const spaces = await restored.listSpaces();
    expect(spaces.map((item) => item.id)).toContain(space.id);
    const nodes = await restored.listNodes(space.id);
    const reopenedDoc = nodes.find((node) => node.id === doc.id);
    expect(reopenedDoc).toBeDefined();
    expect(parseAlterDoc(reopenedDoc!.content).blocks).toHaveLength(1);
    const comments = await restored.listComments(doc.id);
    expect(comments[0]?.body).toBe('已修改');
    // convertThought marks the thought as converted and leaves an empty AST
    // document that the client fills through Document Operations.
    const convertedNode = (await restored.listNodes(space.id)).find(
      (node) => node.id === converted.node.id,
    );
    expect(convertedNode).toBeDefined();
    expect(parseAlterDoc(convertedNode!.content).blocks).toEqual([]);
    expect((await restored.hub.get(space.id)).policy).toBe('judge');
    await reopened.close();
  });

  it('archives, trashes and restores documents', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const service = createSpaceAuthority(store, fixedNow).user;
    const space = await service.createSpace({ name: '归档' });
    const doc = await service.createNode({ spaceId: space.id, kind: 'note' });
    const archived = await service.setArchived(doc.id, true);
    expect(archived.archived).toBe(true);
    await service.deleteNode(doc.id);
    const deleted = await service.listDeleted(space.id);
    expect(deleted.nodes.map((node) => node.id)).toContain(doc.id);
    const restored = await service.restoreNode(doc.id);
    expect(restored.id).toBe(doc.id);
    await service.archiveSpace(space.id);
    expect((await service.listSpaces()).some((item) => item.id === space.id)).toBe(
      false,
    );
    expect(
      (await service.listArchivedSpaces()).map((item) => item.id),
    ).toContain(space.id);
    await store.close();
  });

  it('creates collaborators and keeps them across a reopen', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const service = createSpaceAuthority(store, fixedNow).user;
    const space = await service.createSpace({ name: '协作' });
    expect(await service.listAgents()).toHaveLength(0);

    const agent = await service.createAgent({
      name: '研究助手',
      role: '资料检索与事实核对',
      description: '擅长公开资料检索与事实核对。',
      model: 'deepseek-reasoner',
      permissions: ['read', 'comment'],
    });
    expect(agent.id).toMatch(/^ag-/);
    expect(agent.name).toBe('研究助手');
    expect(agent.role).toBe('资料检索与事实核对');
    expect(agent.description).toBe('擅长公开资料检索与事实核对。');
    expect(agent.model).toBe('deepseek-reasoner');
    expect(agent.permissions).toEqual(['read', 'comment']);

    const minimal = await service.createAgent({ name: '轻量助手', role: '' });
    expect(minimal.description).toBeUndefined();
    expect(minimal.model).toBeUndefined();
    expect(minimal.permissions).toBeUndefined();
    expect(await service.listAgents()).toHaveLength(2);

    const updated = await service.updateSpace(space.id, {
      collaboratorIds: [agent.id],
    });
    expect(updated.collaboratorIds).toEqual([agent.id]);
    await expect(
      service.createAgent({ name: '   ', role: '' }),
    ).rejects.toThrow('协作者名称不能为空');
    await store.close();

    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    const restored = createSpaceAuthority(reopened, fixedNow).user;
    const restoredAgents = await restored.listAgents();
    expect(restoredAgents.map((item) => item.name)).toEqual([
      '研究助手',
      '轻量助手',
    ]);
    expect(restoredAgents[0]).toMatchObject({
      description: '擅长公开资料检索与事实核对。',
      model: 'deepseek-reasoner',
      permissions: ['read', 'comment'],
    });
    expect((await restored.getSpace(space.id))?.collaboratorIds).toEqual([
      agent.id,
    ]);
    await reopened.close();
  });

  it('records only noteworthy changes in the overview activity feed', async () => {
    const dir = await tempDir();
    let current = new Date('2026-11-01T09:00:00.000Z');
    const clock = () => current;
    const store = await openSpaceStore({ directory: dir, now: clock });
    const service = createSpaceAuthority(store, clock).user;
    const space = await service.createSpace({ name: '研究' });

    current = new Date('2026-11-01T09:05:00.000Z');
    const doc = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '访谈整理',
    });
    current = new Date('2026-11-01T09:10:00.000Z');
    await service.saveNode(doc.id, { content: astContent('第一版') });
    current = new Date('2026-11-01T09:20:00.000Z');
    await service.saveNode(doc.id, { content: astContent('第二版') });

    current = new Date('2026-11-01T10:00:00.000Z');
    const comment = await service.addComment({
      docId: doc.id,
      body: '这里的判断需要再确认',
    });
    current = new Date('2026-11-01T10:05:00.000Z');
    await service.updateComment(comment.id, { body: '这里的判断需要再确认。' });
    current = new Date('2026-11-01T10:10:00.000Z');
    await service.resolveComment(comment.id);

    current = new Date('2026-11-01T11:00:00.000Z');
    const thought = await service.createThought({
      spaceId: space.id,
      content: '先记下一个想法',
    });
    current = new Date('2026-11-01T11:30:00.000Z');
    const converted = await service.convertThought(thought.id);

    current = new Date('2026-11-01T12:00:00.000Z');
    const old = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '旧稿',
    });
    await service.saveNode(old.id, { content: astContent('旧内容') });
    current = new Date('2026-11-01T12:05:00.000Z');
    await service.setArchived(old.id, true);

    // 点开新建但从未写下内容的草稿，不算「值得记」。
    current = new Date('2026-11-01T13:00:00.000Z');
    await service.createNode({ spaceId: space.id, kind: 'note' });

    // 文档编辑确实产生了版本历史，只是不进活动记录。
    expect((await service.listVersions(doc.id)).length).toBeGreaterThanOrEqual(
      2,
    );

    current = new Date('2026-11-01T15:00:00.000Z');
    const overview = await service.getOverview(space.id);
    const entries = overview.activity.flatMap((day) => day.events);
    const titles = entries.map((event) => event.title);

    expect(titles).toContain('创建了空间「研究」');
    expect(titles).toContain('新建《访谈整理》');
    expect(titles).toContain('归档《旧稿》');
    // 随想转出的空 AST 文档没有正文，不算「新建文档」；客户端填充内容后才补记。
    expect(
      entries.some((event) => event.id === `act-doc-create-${converted.node.id}`),
    ).toBe(false);
    expect(titles).not.toContain('新建《未命名文档》');
    // 编辑、随想、评论与事项都不进入活动记录。
    expect(titles.some((title) => title.includes('更新'))).toBe(false);
    expect(titles.some((title) => title.includes('随想'))).toBe(false);
    expect(
      titles.some((title) => title.includes('评论') || title.includes('讨论')),
    ).toBe(false);
    expect(titles.some((title) => title.includes('事项'))).toBe(false);
    // 空白草稿（含随想转出的空文档）不记。
    expect(
      titles.filter(
        (title) => title.includes('新建') && title.includes('未命名文档'),
      ),
    ).toHaveLength(0);
    // 热力图的计数只统计这些值得记的事件。
    expect(
      overview.activity.reduce((sum, day) => sum + day.count, 0),
    ).toBe(entries.length);

    await store.close();
  });

  it('folds Alter-reported work into its event and ignores idle auto-archiving', async () => {
    const dir = await tempDir();
    let current = new Date('2026-11-02T09:00:00.000Z');
    const clock = () => current;
    const store = await openSpaceStore({ directory: dir, now: clock });
    const service = createSpaceAuthority(store, clock).user;
    const space = await service.createSpace({ name: '研究' });

    const doc = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '资料',
    });
    await service.saveNode(doc.id, { content: astContent('内容') });
    const idle = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '沉底旧文',
    });
    await service.saveNode(idle.id, { content: astContent('内容') });

    await store.updateAs('alter', (data) => {
      const node = data.nodes.find((item) => item.id === doc.id);
      if (!node) throw new Error('missing doc');
      // 同一个动作：Alter 的 AgentEvent 已经概括，文档新建不再重复记。
      data.events.push({
        id: 'ev-research',
        spaceId: space.id,
        title: '整理了《资料》',
        detail: 'Alter 读完资料并整理出三条判断',
        at: node.createdAt,
        docId: doc.id,
        taskId: null,
        source: 'agent',
      });
      const stale = data.nodes.find((item) => item.id === idle.id);
      if (!stale) throw new Error('missing idle doc');
      // 闲置自动归档由系统清理触发，不是用户或 Alter 的决定。
      stale.archived = true;
      stale.archivedBy = 'system';
      stale.archivedAt = new Date('2026-11-02T10:00:00.000Z').toISOString();
      stale.activity = 0;
      stale.activityAt = stale.archivedAt;
    });

    current = new Date('2026-11-02T11:00:00.000Z');
    const overview = await service.getOverview(space.id);
    const entries = overview.activity.flatMap((day) => day.events);
    const titles = entries.map((event) => event.title);

    expect(titles).toContain('整理了《资料》');
    expect(
      entries.some((event) => event.id === `act-doc-create-${doc.id}`),
    ).toBe(false);
    expect(
      entries.some((event) => event.id === `act-doc-archive-${idle.id}`),
    ).toBe(false);

    await store.close();
  });

  it('persists comment anchors and validates their shape', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const service = createSpaceAuthority(store, fixedNow).user;
    const space = await service.createSpace({ name: '评论' });
    const doc = await service.createNode({ spaceId: space.id, kind: 'note' });
    await service.saveNode(doc.id, { content: astContent('hello world') });

    const anchor = { blockId: 'blk_service_1', offset: 0, length: 5 };
    const comment = await service.addComment({
      docId: doc.id,
      body: '  定位评论  ',
      quote: 'hello',
      anchor,
    });
    expect(comment.anchor).toEqual(anchor);
    expect(comment.body).toBe('定位评论');
    expect((await service.listComments(doc.id))[0]?.anchor).toEqual(anchor);

    const moved = await service.updateComment(comment.id, {
      anchor: { blockId: 'blk_service_1', offset: 6, length: 5 },
      quote: 'world',
    });
    expect(moved.anchor).toEqual({
      blockId: 'blk_service_1',
      offset: 6,
      length: 5,
    });
    expect(moved.quote).toBe('world');
    // Resolving and supplementing keep the anchor attached.
    expect((await service.resolveComment(comment.id)).anchor).toEqual(
      moved.anchor,
    );
    expect(
      (await service.addCommentSupplement(comment.id, '补充')).anchor,
    ).toEqual(moved.anchor);
    // An explicit null clears the anchor; omitting it leaves no anchor at all.
    expect((await service.updateComment(comment.id, { anchor: null })).anchor).toBeNull();
    const whole = await service.addComment({
      docId: doc.id,
      body: '全文评论',
    });
    expect(whole.anchor).toBeNull();

    // Rows persisted before the anchor model read back as null.
    await store.update((data) => {
      const target = data.comments.find((item) => item.id === whole.id);
      if (target !== undefined)
        delete (target as { anchor?: unknown }).anchor;
    });
    const reloaded = await service.listComments(doc.id);
    expect(reloaded.find((item) => item.id === whole.id)?.anchor).toBeNull();

    const invalid: unknown[] = [
      { blockId: '   ', offset: 0, length: 1 },
      { blockId: 'blk_service_1', offset: -1, length: 1 },
      { blockId: 'blk_service_1', offset: 1.5, length: 1 },
      { blockId: 'blk_service_1', offset: 0, length: 0 },
      { blockId: 'blk_service_1', offset: 0, length: -2 },
      { blockId: 'blk_service_1', offset: 0, length: 1.5 },
    ];
    for (const bad of invalid) {
      await expect(
        service.addComment({
          docId: doc.id,
          body: '坏锚点',
          anchor: bad as never,
        }),
      ).rejects.toThrow();
      await expect(
        service.updateComment(comment.id, { anchor: bad as never }),
      ).rejects.toThrow();
    }
    await expect(
      service.addComment({ docId: doc.id, body: '坏锚点', anchor: 'x' as never }),
    ).rejects.toThrow('锚点');

    // Anchors persist across a store reopen.
    const persisted = await service.addComment({
      docId: doc.id,
      body: '持久化锚点',
      anchor: { blockId: 'blk_service_1', offset: 6, length: 5 },
    });
    await store.close();
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    const restored = createSpaceAuthority(reopened, fixedNow).user;
    expect(
      (await restored.listComments(doc.id)).find(
        (item) => item.id === persisted.id,
      )?.anchor,
    ).toEqual({ blockId: 'blk_service_1', offset: 6, length: 5 });
    await reopened.close();
  });

  it('keeps the default space immutable and rejects invalid operations', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const service = createSpaceAuthority(store, fixedNow).user;
    await expect(service.deleteSpace(DEFAULT_SPACE_ID)).rejects.toThrow();
    await expect(service.getSpace('sp-missing')).resolves.toBeUndefined();
    await expect(
      service.createNode({ spaceId: 'sp-missing', kind: 'note' }),
    ).rejects.toThrow('空间不存在');
    await store.close();
  });
});
