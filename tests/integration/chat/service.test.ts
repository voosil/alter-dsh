/**
 * Chat service over the real SQLite store.
 *
 * Conversation records live in the `chats` / `chat_refs` side tables and their
 * space/page references are resolved against live authority state on every
 * read, so this suite drives the whole stack: real `openSpaceStore`, the
 * business service for spaces/pages, and `createChatService` on top.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../../../host/authority/compose.js';
import { createChatService } from '../../../host/chat/service.js';
import { openSpaceStore } from '../../../host/persistence/store.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-chat-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Shared business clock; each fixture resets it and tests move it forward. */
let clock = 0;
const now = () => new Date(clock);

function tick(ms = 1_000): void {
  clock += ms;
}

/**
 * Open one store with the space service and the chat service on top, all on
 * the same clock so `updatedAt` ordering is fully controlled by the test.
 */
async function openChatFixture() {
  clock = Date.parse('2026-11-13T00:00:00.000Z');
  const store = await openSpaceStore({ directory: await tempDir(), now });
  const service = createSpaceAuthority(store, now).user;
  const chats = createChatService({ store, now });
  return { store, service, chats };
}

/** One page chat opening a conversation on `page` inside `space`. */
function pageChatInput(spaceId: string, nodeId: string) {
  return {
    kind: 'page' as const,
    spaceId,
    nodeId,
    sessionId: `sess-${nodeId}`,
    title: `讨论：${nodeId}`,
  };
}

describe('createChat + listChats', () => {
  it('creates a page chat with live reference state and lists newest first', async () => {
    const { store, service, chats } = await openChatFixture();
    const space = await service.createSpace({ name: '写作' });
    const page = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '第一章',
    });

    const created = await chats.createChat({
      ...pageChatInput(space.id, page.id),
      title: '关于第一章',
      refs: [
        { kind: 'page', spaceId: space.id, nodeId: page.id },
        { kind: 'space', spaceId: space.id },
      ],
    });
    expect(created.kind).toBe('page');
    expect(created.sessionId).toBe(`sess-${page.id}`);
    expect(created.sideOf).toBeNull();
    expect(created.quote).toBeNull();
    expect(created.createdAt).toBe(created.updatedAt);
    expect(created.refs).toHaveLength(2);

    const [pageRef, spaceRef] = created.refs;
    expect(pageRef!.kind).toBe('page');
    expect(pageRef!.spaceId).toBe(space.id);
    expect(pageRef!.nodeId).toBe(page.id);
    expect(pageRef!.label).toBe('第一章');
    expect(pageRef!.state).toBe('current');
    expect(pageRef!.addedBy).toBe('me');
    expect(spaceRef!.kind).toBe('space');
    expect(spaceRef!.spaceId).toBe(space.id);
    expect(spaceRef!.nodeId).toBeNull();
    expect(spaceRef!.label).toBe('写作');
    expect(spaceRef!.state).toBe('current');

    // getChat projects the same resolved view as the list.
    expect(await chats.getChat(created.id)).toEqual(created);

    tick();
    const second = await chats.createChat(pageChatInput(space.id, page.id));
    tick();
    const third = await chats.createChat(pageChatInput(space.id, page.id));

    const listed = await chats.listChats();
    expect(listed.map((chat) => chat.id)).toEqual([
      third.id,
      second.id,
      created.id,
    ]);
    await store.close();
  });
});

describe('updateChat', () => {
  it('moves updatedAt forward, which reorders listChats', async () => {
    const { store, chats } = await openChatFixture();
    const older = await chats.createChat({
      kind: 'page',
      sessionId: 'sess-a',
      title: '旧会话',
    });
    tick();
    const newer = await chats.createChat({
      kind: 'page',
      sessionId: 'sess-b',
      title: '新会话',
    });
    expect((await chats.listChats()).map((chat) => chat.id)).toEqual([
      newer.id,
      older.id,
    ]);

    tick();
    const updated = await chats.updateChat(older.id, {
      title: '改名的新会话',
      sessionId: 'sess-a2',
    });
    expect(updated.title).toBe('改名的新会话');
    expect(updated.sessionId).toBe('sess-a2');
    expect(updated.createdAt).toBe(older.createdAt);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(
      Date.parse(older.updatedAt),
    );
    expect((await chats.listChats()).map((chat) => chat.id)).toEqual([
      older.id,
      newer.id,
    ]);

    await expect(
      chats.updateChat('ch-missing', { title: 'x' }),
    ).rejects.toThrow('chat/not-found');
    await store.close();
  });
});

describe('setChatRefs / addChatRef', () => {
  it('replaces the set, keeps unchanged identity, drops removed targets', async () => {
    const { store, service, chats } = await openChatFixture();
    const spaceA = await service.createSpace({ name: '空间A' });
    const spaceB = await service.createSpace({ name: '空间B' });
    const pageA = await service.createNode({
      spaceId: spaceA.id,
      kind: 'note',
      title: '页A',
    });
    const pageC = await service.createNode({
      spaceId: spaceB.id,
      kind: 'note',
      title: '页C',
    });

    const chat = await chats.createChat({
      kind: 'page',
      spaceId: spaceA.id,
      nodeId: pageA.id,
      sessionId: 'sess-1',
      title: '讨论',
      refs: [
        { kind: 'page', spaceId: spaceA.id, nodeId: pageA.id },
        { kind: 'space', spaceId: spaceB.id },
      ],
    });
    const originalPageRef = chat.refs[0]!;
    const originalSpaceRef = chat.refs[1]!;

    tick();
    const replaced = await chats.setChatRefs(chat.id, [
      { kind: 'page', spaceId: spaceA.id, nodeId: pageA.id },
      { kind: 'page', spaceId: spaceB.id, nodeId: pageC.id },
    ]);
    expect(replaced.refs).toHaveLength(2);
    const kept = replaced.refs.find((ref) => ref.nodeId === pageA.id)!;
    // 未变目标保留引用身份（id / addedAt），不是删了重建。
    expect(kept.id).toBe(originalPageRef.id);
    expect(kept.addedAt).toBe(originalPageRef.addedAt);
    const added = replaced.refs.find((ref) => ref.nodeId === pageC.id)!;
    expect(added.id).not.toBe(originalPageRef.id);
    expect(added.addedAt).not.toBe(originalPageRef.addedAt);
    expect(
      replaced.refs.some(
        (ref) => ref.nodeId === null && ref.spaceId === spaceB.id,
      ),
    ).toBe(false);
    expect(originalSpaceRef.nodeId).toBeNull();

    // 空集合：全部移除。
    const emptied = await chats.setChatRefs(chat.id, []);
    expect(emptied.refs).toEqual([]);
    await store.close();
  });

  it('is idempotent for a duplicate target', async () => {
    const { store, service, chats } = await openChatFixture();
    const space = await service.createSpace({ name: '空间' });
    const page = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '页',
    });
    const chat = await chats.createChat({
      kind: 'page',
      spaceId: space.id,
      nodeId: page.id,
      sessionId: 'sess-1',
      title: '讨论',
      refs: [{ kind: 'page', spaceId: space.id, nodeId: page.id }],
    });
    const before = (await chats.getChat(chat.id))!;

    // 重复目标：返回原记录，不新增引用，也不前移 updatedAt。
    const again = await chats.addChatRef(chat.id, {
      kind: 'page',
      spaceId: space.id,
      nodeId: page.id,
    });
    expect(again.refs.map((ref) => ref.id)).toEqual(
      before.refs.map((ref) => ref.id),
    );
    expect(again.updatedAt).toBe(before.updatedAt);

    await expect(
      chats.addChatRef('ch-missing', { kind: 'space', spaceId: space.id }),
    ).rejects.toThrow('chat/not-found');
    await expect(
      chats.setChatRefs('ch-missing', []),
    ).rejects.toThrow('chat/not-found');
    await store.close();
  });

  it('appends a new ref while keeping the existing ones', async () => {
    const { store, service, chats } = await openChatFixture();
    const space = await service.createSpace({ name: '空间' });
    const pageA = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '页 A',
    });
    const pageC = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '页 C',
    });
    const chat = await chats.createChat({
      kind: 'page',
      spaceId: space.id,
      nodeId: pageA.id,
      sessionId: 'sess-1',
      title: '讨论',
      refs: [
        { kind: 'page', spaceId: space.id, nodeId: pageA.id },
        { kind: 'space', spaceId: space.id },
      ],
    });
    const before = (await chats.getChat(chat.id))!;

    const after = await chats.addChatRef(chat.id, {
      kind: 'page',
      spaceId: space.id,
      nodeId: pageC.id,
    });
    expect(after.refs).toHaveLength(3);
    const kept = after.refs.filter((ref) =>
      before.refs.some((old) => old.id === ref.id),
    );
    expect(kept).toHaveLength(2);
    expect(
      after.refs.find((ref) => ref.nodeId === pageC.id)?.label,
    ).toBe('页 C');
    // 反查对三个目标都成立。
    for (const ref of after.refs) {
      const hits = await chats.listChatsForRef({
        spaceId: ref.spaceId,
        nodeId: ref.nodeId,
      });
      expect(hits.map((item) => item.id)).toContain(chat.id);
    }
    await store.close();
  });
});

describe('derived reference state', () => {
  it('reflects page archive, page soft delete and space deletion', async () => {
    const { store, service, chats } = await openChatFixture();
    const space = await service.createSpace({ name: '项目' });
    const page = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '设计稿',
    });
    const chat = await chats.createChat({
      kind: 'page',
      spaceId: space.id,
      nodeId: page.id,
      sessionId: 'sess-1',
      title: '讨论设计稿',
      refs: [{ kind: 'page', spaceId: space.id, nodeId: page.id }],
    });

    // 归档：引用不再是 current，但标题仍可读，会话仍被反查列出。
    await service.setArchived(page.id, true);
    let ref = (await chats.getChat(chat.id))!.refs[0]!;
    expect(ref.state).toBe('archived');
    expect(ref.label).toBe('设计稿');
    expect(
      (await chats.listChatsForRef({ spaceId: space.id, nodeId: page.id })).map(
        (item) => item.id,
      ),
    ).toEqual([chat.id]);

    // 软删除进回收站：引用 missing，会话从反查里消失。
    await service.setArchived(page.id, false);
    await service.deleteNode(page.id);
    ref = (await chats.getChat(chat.id))!.refs[0]!;
    expect(ref.state).toBe('missing');
    expect(ref.label).toBe('设计稿');
    expect(
      await chats.listChatsForRef({ spaceId: space.id, nodeId: page.id }),
    ).toEqual([]);

    // 空间删除：space 引用 missing；该空间内的页面引用同样 missing。
    const doomed = await service.createSpace({ name: '临时' });
    const doomedPage = await service.createNode({
      spaceId: doomed.id,
      kind: 'note',
      title: '临时页',
    });
    const doomedChat = await chats.createChat({
      kind: 'page',
      spaceId: doomed.id,
      sessionId: 'sess-2',
      title: '空间讨论',
      refs: [
        { kind: 'space', spaceId: doomed.id },
        { kind: 'page', spaceId: doomed.id, nodeId: doomedPage.id },
      ],
    });
    await service.deleteSpace(doomed.id);
    const doomedRefs = (await chats.getChat(doomedChat.id))!.refs;
    expect(doomedRefs.map((item) => item.state)).toEqual([
      'missing',
      'missing',
    ]);
    expect(await chats.listChatsForRef({ spaceId: doomed.id })).toEqual([]);
    await store.close();
  });
});

describe('deleteChat', () => {
  it('removes the record and its reverse-index entries', async () => {
    const { store, service, chats } = await openChatFixture();
    const space = await service.createSpace({ name: '日常' });
    const page = await service.createNode({
      spaceId: space.id,
      kind: 'note',
      title: '笔记',
    });
    const chat = await chats.createChat({
      ...pageChatInput(space.id, page.id),
      refs: [{ kind: 'page', spaceId: space.id, nodeId: page.id }],
    });

    await chats.deleteChat(chat.id);
    expect(await chats.getChat(chat.id)).toBeUndefined();
    expect((await chats.listChats()).map((item) => item.id)).not.toContain(
      chat.id,
    );
    expect(
      await chats.listChatsForRef({ spaceId: space.id, nodeId: page.id }),
    ).toEqual([]);
    await store.close();
  });
});

describe('cross-space registration', () => {
  it('registers a page ref whose node belongs to another space', async () => {
    const { store, service, chats } = await openChatFixture();
    const home = await service.createSpace({ name: '主页' });
    const foreign = await service.createSpace({ name: '别处' });
    const node = await service.createNode({
      spaceId: home.id,
      kind: 'note',
      title: '跨空间页',
    });

    const chat = await chats.createChat({
      kind: 'page',
      spaceId: foreign.id,
      nodeId: node.id,
      sessionId: 'sess-1',
      title: '跨空间讨论',
      refs: [{ kind: 'page', spaceId: foreign.id, nodeId: node.id }],
    });
    const ref = chat.refs[0]!;
    expect(ref.kind).toBe('page');
    expect(ref.spaceId).toBe(foreign.id);
    expect(ref.nodeId).toBe(node.id);
    expect(ref.state).toBe('current');
    expect(ref.label).toBe('跨空间页');
    // 反查按登记的 (spaceId, nodeId) 对匹配，同样不做跨空间校验。
    expect(
      (
        await chats.listChatsForRef({ spaceId: foreign.id, nodeId: node.id })
      ).map((item) => item.id),
    ).toEqual([chat.id]);

    // 指向不存在空间的引用解析为 missing。
    const ghost = await chats.createChat({
      kind: 'page',
      sessionId: 'sess-2',
      title: '幽灵引用',
      refs: [{ kind: 'space', spaceId: 'sp-ghost' }],
    });
    expect(ghost.refs[0]!.state).toBe('missing');
    await store.close();
  });
});
