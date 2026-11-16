/**
 * Deleting one recorded side chat.
 *
 * 删除侧边记录 = 移除 Space 侧的登记（chat 记录 + 引用行），并归档对应的 DSH
 * 分支会话：会话本身归 DSH，插件只能归档，不能删除。归档是「尽力而为」的副作用
 * —— 登记已经删了，归档失败也不该让删除动作失败（会话仍可从 DSH 归档/历史找
 * 回）。顺序固定为先删登记、后归档：反过来一旦删除失败就会出现「会话已归档、
 * 历史还在」的悬空行。
 *
 * 不依赖 React 或 DSH 模块，装配层（`src/entry.js`）把 store 与归档能力注入。
 */
import type { Chat } from '@alter/protocol';

/** Narrow store face the deletion needs. */
export interface ChatDeleteStore {
  readonly chats: {
    getSnapshot(): readonly Chat[];
  };
  readonly actions: {
    remove(chatId: string): Promise<void>;
  };
}

/** Injectable side effects of one deletion. */
export interface ChatDeleteDeps {
  readonly store: ChatDeleteStore;
  /**
   * Archive one branch session (DSH owns it). Absent on a partial boot/tests:
   * the record still goes away, the session simply stays in the active list.
   */
  readonly archiveSession?: (sessionId: string) => Promise<unknown> | unknown;
  /** Report a failed archive; defaults to ignoring it (best effort). */
  readonly onArchiveError?: (error: unknown) => void;
}

/**
 * Remove one chat record and archive its branch session.
 *
 * @param deps - store plus the archive capability.
 * @param chatId - the record to delete.
 * @returns resolves once the record is gone (the archive runs in the background).
 */
export async function deleteChatRecord(
  deps: ChatDeleteDeps,
  chatId: string,
): Promise<void> {
  const chat = deps.store.chats.getSnapshot().find((item) => item.id === chatId);
  await deps.store.actions.remove(chatId);
  const sessionId = chat?.sessionId ?? null;
  if (sessionId === null || deps.archiveSession === undefined) return;
  void Promise.resolve(deps.archiveSession(sessionId)).catch((error: unknown) => {
    deps.onArchiveError?.(error);
  });
}
