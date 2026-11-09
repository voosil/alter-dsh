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
