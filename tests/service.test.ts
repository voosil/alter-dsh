import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../host/authority.js';
import { DEFAULT_SPACE_ID, openSpaceStore } from '../host/store.js';

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

describe('Space business service over SQLite', () => {
  it('persists documents, comments, versions and hub through a reopen', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const service = createSpaceAuthority(store, fixedNow);

    const space = await service.createSpace({ name: '写作' });
    const doc = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '第一篇',
    });
    await service.saveNode(doc.id, {
      content: '<p>hello world</p>',
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
    const converted = await service.convertThought(thought.id);
    expect(converted.node.spaceId).toBe(space.id);
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
    const restored = createSpaceAuthority(reopened, fixedNow);
    const spaces = await restored.listSpaces();
    expect(spaces.map((item) => item.id)).toContain(space.id);
    const nodes = await restored.listNodes(space.id);
    expect(nodes[0]?.content).toBe('<p>hello world</p>');
    const comments = await restored.listComments(doc.id);
    expect(comments[0]?.body).toBe('已修改');
    // convertThought marks the thought as converted, so it leaves the list;
    // its content now lives in the converted document.
    expect(
      (await restored.listNodes(space.id)).some(
        (node) => node.content === '一个随想',
      ),
    ).toBe(true);
    expect((await restored.hub.get(space.id)).policy).toBe('judge');
    await reopened.close();
  });

  it('archives, trashes and restores documents', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const service = createSpaceAuthority(store, fixedNow);
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
    const service = createSpaceAuthority(store, fixedNow);
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
    const restored = createSpaceAuthority(reopened, fixedNow);
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
    const service = createSpaceAuthority(store, clock);
    const space = await service.createSpace({ name: '研究' });

    current = new Date('2026-11-01T09:05:00.000Z');
    const doc = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '访谈整理',
    });
    current = new Date('2026-11-01T09:10:00.000Z');
    await service.saveNode(doc.id, { content: '<p>第一版</p>' });
    current = new Date('2026-11-01T09:20:00.000Z');
    await service.saveNode(doc.id, { content: '<p>第二版</p>' });

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
    await service.saveNode(old.id, { content: '<p>旧内容</p>' });
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
    // 随想转成文档只按「新建文档」记一条，不单独记随想动作。
    expect(
      entries.some((event) => event.id === `act-doc-create-${converted.node.id}`),
    ).toBe(true);
    expect(titles).toContain('新建《未命名文档》');
    // 编辑、随想、评论与事项都不进入活动记录。
    expect(titles.some((title) => title.includes('更新'))).toBe(false);
    expect(titles.some((title) => title.includes('随想'))).toBe(false);
    expect(
      titles.some((title) => title.includes('评论') || title.includes('讨论')),
    ).toBe(false);
    expect(titles.some((title) => title.includes('事项'))).toBe(false);
    // 空白草稿不记；唯一的「未命名文档」来自随想转文档。
    expect(
      titles.filter(
        (title) => title.includes('新建') && title.includes('未命名文档'),
      ),
    ).toHaveLength(1);
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
    const service = createSpaceAuthority(store, clock);
    const space = await service.createSpace({ name: '研究' });

    const doc = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '资料',
    });
    await service.saveNode(doc.id, { content: '<p>内容</p>' });
    const idle = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '沉底旧文',
    });
    await service.saveNode(idle.id, { content: '<p>内容</p>' });

    await store.update((data) => {
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
      });
      const stale = data.nodes.find((item) => item.id === idle.id);
      if (!stale) throw new Error('missing idle doc');
      // 闲置自动归档由系统清理触发，不是用户的决定。
      stale.archived = true;
      stale.archivedBy = 'agent';
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

  it('keeps the default space immutable and rejects invalid operations', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    const service = createSpaceAuthority(store, fixedNow);
    await expect(service.deleteSpace(DEFAULT_SPACE_ID)).rejects.toThrow();
    await expect(service.getSpace('sp-missing')).resolves.toBeUndefined();
    await expect(
      service.createNode({ spaceId: 'sp-missing', kind: 'note' }),
    ).rejects.toThrow('空间不存在');
    await store.close();
  });
});
