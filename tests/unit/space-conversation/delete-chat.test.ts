/**
 * 删除侧边记录（`src/space-conversation/delete-chat.ts`）。
 *
 * 规范 §4.3：删除历史项只移除 Space 侧登记，并把分支会话归档；DSH 拥有会话，
 * 插件不能删除会话。归档是尽力而为的副作用 —— 登记删掉之后归档失败不能把删除
 * 变成失败，也不能阻止记录消失。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Chat } from '../../../vendor/protocol/src/index';
import { deleteChatRecord } from '../../../src/space-conversation/delete-chat';

/** One recorded branch (the fields the deletion reads). */
function sideChat(id: string, sessionId: string | null): Chat {
  return {
    id,
    kind: 'side',
    sessionId,
    title: '花絮',
    sideOf: { sessionId: 'main-1', title: '主对话' },
    refs: [],
    quote: null,
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
  };
}

/** Store double recording the removal, with a fixed record list. */
function storeDouble(chats: readonly Chat[]) {
  const removed: string[] = [];
  return {
    removed,
    store: {
      chats: { getSnapshot: () => chats },
      actions: {
        remove: async (chatId: string) => {
          removed.push(chatId);
        },
      },
    },
  };
}

describe('deleteChatRecord', () => {
  it('removes the record first, then archives the branch session', async () => {
    const order: string[] = [];
    const { store, removed } = storeDouble([sideChat('chat-1', 'se-1')]);
    const remove = store.actions.remove;
    store.actions.remove = async (chatId: string) => {
      order.push(`remove:${chatId}`);
      await remove(chatId);
    };
    const archive = vi.fn(async (sessionId: string) => {
      order.push(`archive:${sessionId}`);
    });
    await deleteChatRecord({ store, archiveSession: archive }, 'chat-1');
    expect(removed).toEqual(['chat-1']);
    expect(archive).toHaveBeenCalledWith('se-1');
    expect(order).toEqual(['remove:chat-1', 'archive:se-1']);
  });

  it('does not archive a record that has no session yet', async () => {
    const { store } = storeDouble([sideChat('chat-1', null)]);
    const archive = vi.fn(async () => undefined);
    await deleteChatRecord({ store, archiveSession: archive }, 'chat-1');
    expect(archive).not.toHaveBeenCalled();
  });

  it('deletes an unknown record without archiving anything', async () => {
    const { store, removed } = storeDouble([sideChat('chat-1', 'se-1')]);
    const archive = vi.fn(async () => undefined);
    await deleteChatRecord({ store, archiveSession: archive }, 'chat-missing');
    expect(removed).toEqual(['chat-missing']);
    expect(archive).not.toHaveBeenCalled();
  });

  it('keeps the deletion successful when the archive fails', async () => {
    const { store, removed } = storeDouble([sideChat('chat-1', 'se-1')]);
    const onArchiveError = vi.fn();
    await deleteChatRecord({
      store,
      archiveSession: async () => {
        throw new Error('archived refused');
      },
      onArchiveError,
    }, 'chat-1');
    expect(removed).toEqual(['chat-1']);
    // The rejection lands in the injected reporter, not in the caller's promise.
    await Promise.resolve();
    expect(onArchiveError).toHaveBeenCalledTimes(1);
  });

  it('works without the archive capability (partial boot)', async () => {
    const { store, removed } = storeDouble([sideChat('chat-1', 'se-1')]);
    await expect(deleteChatRecord({ store }, 'chat-1')).resolves.toBeUndefined();
    expect(removed).toEqual(['chat-1']);
  });
});
