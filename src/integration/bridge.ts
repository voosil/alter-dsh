/**
 * Bridge between the Space UI (`vendor/ui-space`, which knows nothing about
 * DSH services) and the client integration modules.
 *
 * `src/entry.js` populates the bridge once at plugin apply time; the Space UI
 * reads it through `spaceBridge()` and degrades silently when a capability is
 * absent (e.g. tests render without DSH around them).
 */
import type { Chat } from '@alter/protocol';

/** What the Space main view can ask the DSH-side integration to do. */
export interface SpaceBridge {
  /** Toggle the DSH right sidebar (expand/collapse the on-screen session's panel). */
  toggleRightbar(): void;
  /**
   * Start a page conversation for one page (页面菜单「AI 对话」): creates an
   * ordinary DSH session in the space's workspace, records the chat + ref and
   * opens it. Resolves to the chat record; rejects with a message when the
   * session cannot be created.
   */
  startPageChat(input: {
    spaceId: string;
    /** Page the conversation is about; `null` opens a space-level conversation. */
    nodeId: string | null;
    nodeTitle: string;
    /**
     * Where the conversation opens: the main column (页面菜单「AI 对话」), the
     * right Sidebar beside the page (right-sidebar entries), or nowhere — the
     * Space panel's own workbench column embeds it in place (`record`).
     * Defaults to `main`.
     */
    open?: 'main' | 'aside' | 'record';
  }): Promise<Chat>;
  /**
   * All conversations that reference the given page or space, resolved with
   * current ref state (页面菜单「相关会话」).
   */
  relatedChats(ref: { spaceId: string; nodeId: string | null }): Promise<Chat[]>;
  /**
   * Open a page — or a space, when `nodeId` is `null` — in the right sidebar's
   * Space tab (在右侧栏打开 / 引用卡片点击).
   */
  openPageInRightbar(input: { spaceId: string; nodeId: string | null }): void;
  /**
   * Open one DSH session as a right-sidebar conversation tab, leaving the space
   * main view untouched. Used by 右栏「新建对话」.
   */
  openSessionAside(sessionId: string): void;
  /** Open one chat record (page chat → main conversation; side chat → rightbar). */
  openChat(chat: Chat): void;
  /** Delete one chat record from 相关会话 actions. */
  deleteChat(chatId: string): Promise<void>;
  /**
   * Whether a DSH session has left the session list (the 相关会话 row marks it
   * 「已删除」 and stops opening it). Optional: absent on a partial boot, where
   * rows simply stay openable and a failed open is the fallback.
   */
  sessionGone?(sessionId: string): boolean;
}

let current: SpaceBridge | null = null;

/** Install the bridge; returns the previous value (tests may swap it). */
export function setSpaceBridge(bridge: SpaceBridge | null): SpaceBridge | null {
  const previous = current;
  current = bridge;
  return previous;
}

/** The installed bridge, or null outside the DSH client. */
export function spaceBridge(): SpaceBridge | null {
  return current;
}
