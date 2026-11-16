/**
 * Side conversations (侧边对话): the 侧边对话历史 view on the conversation page.
 *
 * A `conversation.view` registration is static, but the entry's lifetime is
 * ours: the inject callback below subscribes to the chat store's side-chat
 * list and re-asserts the registration — present while at least one side chat
 * exists, disposed when the list drains to zero, so the View tab row follows
 * the history instead of showing an always-empty tab.
 *
 * The view is a no-selection view: it renders no conversation data and reads
 * the chat store directly (injected as a module instance by
 * `registerSideHistoryView`), while the facts that need the DSH world —
 * opening a branch in the right sidebar, whether a branch session is running,
 * and whether its last completion was seen — arrive through the entry's own
 * inject face so this module stays free of `@deepseek-ai/*` imports. The
 * running marker is read from the Host session list on every render and never
 * guessed: a row the list does not hold shows no marker at all. The completed
 * marker comes from the unread tracker, which owns the acknowledgement state
 * (see `side-status.ts`).
 */
import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { Chat } from '@alter/protocol';
import {
  SIDE_CHAT_TAB_KIND,
  chatRowTitle,
  chatSourceLabel,
  type SideSessionListSource,
  type SideSessionServiceFace,
} from './side';
import { buildSpaceChatAddress } from './address';
import { formatRelativeTime } from './format';
import type { SideUnreadStore } from './side-status';
import styles from './side.module.css';

/** Conversation view seat. */
export const SIDE_VIEW_SLOT = 'conversation.view';

/** This view's registration id in the View roster. */
export const SIDE_HISTORY_VIEW_ID = 'space-side-history';

/** View tab label (and the in-view heading). */
export const SIDE_HISTORY_LABEL = '侧边对话历史';

/** Maximum characters of a quoted selection shown in a history row. */
export const SIDE_HISTORY_QUOTE_MAX = 60;

export { formatRelativeTime } from './format';

/**
 * Quoted-selection fragment of a history row: whitespace collapsed, trimmed,
 * cut at 60 characters with an ellipsis when longer.
 */
export function quoteFragment(
  quote: string | null,
  max: number = SIDE_HISTORY_QUOTE_MAX,
): string | null {
  if (quote === null) return null;
  const collapsed = quote.replace(/\s+/gu, ' ').trim();
  if (collapsed === '') return null;
  if (collapsed.length <= max) return collapsed;
  return `${Array.from(collapsed).slice(0, max).join('')}…`;
}

// --- Row status -------------------------------------------------------------

/** Run state of one branch session, as the history row marks it. */
export type SideRowStatus = 'running' | 'completed' | 'idle' | 'unknown';

/**
 * Map the session list's running bit and the unread tracker's verdict onto a
 * row marker. A running branch always reads 「生成中」; a stopped one with an
 * unseen completion reads 「已完成」; a known-idle one reads 「空闲」.
 * `unknown` (no list row for the session) renders nothing at all rather than
 * guessing a state.
 * @param running - Host running state, or undefined when the row is absent.
 * @param completed - Whether the last stop still needs acknowledgement.
 * @returns the marker to render.
 */
export function sideRowStatus(
  running: boolean | undefined,
  completed = false,
): SideRowStatus {
  if (running === undefined) return 'unknown';
  if (running) return 'running';
  return completed ? 'completed' : 'idle';
}

/** Copy of one row marker. */
export function sideRowStatusLabel(status: SideRowStatus): string {
  switch (status) {
    case 'running':
      return '生成中';
    case 'completed':
      return '已完成';
    case 'idle':
      return '空闲';
    default:
      return '';
  }
}

// --- P1: 搜索与按来源分组 ---------------------------------------------------

/** One source group of the history list. */
export interface SideHistoryGroup {
  /** Stable key: the source session id, or `none` for records without one. */
  readonly key: string;
  /** Group heading copy. */
  readonly label: string;
  /** Member rows, in the incoming (newest-first) order. */
  readonly chats: readonly Chat[];
}

/**
 * Filter rows by one free-text query.
 *
 * Matches the row title, the quoted fragment and the stored source title, case
 * insensitively; a blank query keeps every row. Pure so the toolbar stays a
 * rendering shell.
 * @param chats - rows in display order.
 * @param query - what the reader typed.
 * @returns the rows that match.
 */
export function filterSideChats(
  chats: readonly Chat[],
  query: string,
): readonly Chat[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return chats;
  return chats.filter((chat) => {
    const haystack = [chat.title, chat.quote ?? '', chat.sideOf?.title ?? '']
      .join('\n')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Group rows by their source conversation.
 *
 * Group order follows the first member in the incoming (newest-first) order, so
 * the source of the most recent discussion leads. A source the session list no
 * longer holds is labelled 来源已删除 rather than showing a stale title.
 * @param chats - rows in display order.
 * @param missingSources - source session ids known to be gone.
 * @returns the groups, newest activity first.
 */
export function groupSideChats(
  chats: readonly Chat[],
  missingSources: ReadonlySet<string> = new Set<string>(),
): readonly SideHistoryGroup[] {
  const groups = new Map<string, { key: string; label: string; chats: Chat[] }>();
  for (const chat of chats) {
    const sourceId = chat.sideOf?.sessionId ?? '';
    const key = sourceId === '' ? 'none' : sourceId;
    let group = groups.get(key);
    if (group === undefined) {
      const title = chat.sideOf?.title ?? '';
      const label = sourceId === ''
        ? '未记录来源'
        : missingSources.has(sourceId)
          ? '来源已删除'
          : `来源：${title === '' ? '无标题' : title}`;
      group = { key, label, chats: [] };
      groups.set(key, group);
    }
    group.chats.push(chat);
  }
  return [...groups.values()];
}

// --- Store injection --------------------------------------------------------

/** Store slice the history view reads; injected by `registerSideHistoryView`. */
export interface SideHistoryStoreSource {
  readonly sideChats: {
    getSnapshot(): readonly Chat[];
    subscribe(listener: () => void): () => void;
  };
  readonly actions: {
    rename(chatId: string, title: string): Promise<void>;
    remove(chatId: string): Promise<void>;
    refresh(): Promise<void>;
  };
}

const EMPTY_CHATS: readonly Chat[] = [];

let sideHistoryStore: SideHistoryStoreSource | null = null;

function subscribeSideChats(listener: () => void): () => void {
  return sideHistoryStore?.sideChats.subscribe(listener) ?? (() => undefined);
}

/** The side-chat history list, newest first, through the injected store. */
function useSideChats(): readonly Chat[] {
  return useSyncExternalStore(
    subscribeSideChats,
    () => sideHistoryStore?.sideChats.getSnapshot() ?? EMPTY_CHATS,
    () => EMPTY_CHATS,
  );
}

/**
 * Force one re-render per Host session-list publication, so a run state that
 * changed while the history is on screen still shows. The list is read at
 * render time; a boot without it never re-renders from this source and marks
 * nothing.
 */
function useSessionListTicker(source: SideSessionListSource | undefined): void {
  const [, bump] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => source?.subscribe?.(bump), [source, bump]);
}

/** Stable empty set, so a boot without the tracker keeps one snapshot identity. */
const NO_UNREAD: ReadonlySet<string> = new Set();

/** Current unread branches, through the injected tracker (or none). */
function useUnreadSet(unread: SideUnreadStore | undefined): ReadonlySet<string> {
  const subscribe = useCallback(
    (listener: () => void) => unread?.subscribe(listener) ?? (() => undefined),
    [unread],
  );
  return useSyncExternalStore(
    subscribe,
    () => unread?.getSnapshot() ?? NO_UNREAD,
    () => NO_UNREAD,
  );
}

// --- View -------------------------------------------------------------------

/** Owner props of a conversation view entry (structural). */
export interface SideChatHistoryProps {
  /** Select a view and address an opaque focus identity to it. */
  readonly openView: (view: string, focus: string) => void;
  /** Acknowledge the one-shot focus request addressed to this view. */
  readonly completeViewRequest: () => void;
  /** The focus request, when one is pending. */
  readonly viewRequest: { readonly view: string; readonly focus: string } | null;
  /** Open one branch conversation as a right-sidebar tab (entry-injected). */
  readonly openSideChat: (sessionId: string) => void;
  /** Open one branch conversation in the main column (P1「在主对话中打开」). */
  readonly openMain?: (sessionId: string) => void;
  /**
   * Host session list the row markers read (entry-injected; absent on a boot
   * without the service, which marks nothing).
   */
  readonly sessionList?: SideSessionListSource;
  /** Unread branches (entry-injected; absent on a boot without the service). */
  readonly unread?: SideUnreadStore;
}

/**
 * 侧边对话历史: title / source / quote fragment / time per row, with inline
 * rename (Enter commits, Esc cancels) and delete (inline confirmation).
 */
export function SideChatHistory({
  openView,
  completeViewRequest,
  viewRequest,
  openSideChat,
  openMain,
  sessionList,
  unread,
}: SideChatHistoryProps) {
  const chats = useSideChats();
  useSessionListTicker(sessionList);
  const unreadIds = useUnreadSet(unread);
  const sessionsById = sessionList?.getSnapshot().byId;
  const [query, setQuery] = useState('');
  const [bySource, setBySource] = useState(false);
  const visible = filterSideChats(chats, query);
  /** Sources the session list no longer holds (unknown without the service). */
  const missingSources = new Set<string>();
  if (sessionsById !== undefined) {
    for (const chat of chats) {
      const sourceId = chat.sideOf?.sessionId;
      if (sourceId !== undefined && sessionsById[sourceId] === undefined) {
        missingSources.add(sourceId);
      }
    }
  }
  const groups = bySource ? groupSideChats(visible, missingSources) : [];
  useEffect(() => {
    if (viewRequest?.view === SIDE_HISTORY_VIEW_ID) completeViewRequest();
  }, [viewRequest, completeViewRequest]);
  const now = Date.now();
  /** Open one branch in the right column and put the main area back on 对话. */
  const openBranch = (sessionId: string): void => {
    openSideChat(sessionId);
    openView('chat', '');
  };
  /** One row with every fact the entry injects, shared by list and groups. */
  const historyRowOf = (chat: Chat) => (
    <SideChatHistoryRow
      key={chat.id}
      chat={chat}
      now={now}
      onOpen={openBranch}
      onOpenMain={openMain === undefined
        ? undefined
        : (sessionId: string) => {
          openMain(sessionId);
          openView('chat', '');
        }}
      running={chat.sessionId === null
        ? undefined
        : sessionsById?.[chat.sessionId]?.running}
      completed={chat.sessionId !== null && unreadIds.has(chat.sessionId)}
      // Only a known list may declare the source gone; without the service the
      // row keeps its stored source title.
      sourceGone={chat.sideOf !== null && missingSources.has(chat.sideOf.sessionId)}
    />
  );
  return (
    <div className={styles.history} data-side-chat-history="">
      <h2 className={styles.historyHeading}>{SIDE_HISTORY_LABEL} {chats.length}</h2>
      {chats.length === 0 ? (
        <div className={styles.historyEmpty}>
          <p className={styles.historyEmptyText}>暂无侧边对话</p>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => openView('chat', '')}
          >
            返回对话
          </button>
        </div>
      ) : (
        <>
          <div className={styles.historyToolbar}>
            <input
              type="search"
              className={styles.historySearch}
              placeholder="搜索侧边对话"
              aria-label="搜索侧边对话"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              type="button"
              className={styles.historyToggle}
              aria-pressed={bySource}
              onClick={() => setBySource((current) => !current)}
            >
              按来源分组
            </button>
          </div>
          {visible.length === 0 ? (
            <p className={styles.historyNoMatch}>没有匹配的侧边对话</p>
          ) : bySource ? (
            <div className={styles.historyGroups}>
              {groups.map((group) => (
                <section key={group.key} className={styles.historyGroup}>
                  <h3 className={styles.historyGroupHeading}>
                    {group.label} {group.chats.length}
                  </h3>
                  <ul className={styles.historyList}>
                    {group.chats.map((chat) => historyRowOf(chat))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <ul className={styles.historyList}>
              {visible.map((chat) => historyRowOf(chat))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** Faces one history row needs beyond the record itself. */
interface SideChatHistoryRowProps {
  readonly chat: Chat;
  readonly now: number;
  /** Open the branch and return the main area to the 对话 view. */
  readonly onOpen: (sessionId: string) => void;
  /** Open the branch as the main conversation (absent without the capability). */
  readonly onOpenMain?: (sessionId: string) => void;
  /** Host running state of the branch session, or undefined when unknown. */
  readonly running: boolean | undefined;
  /** Whether the branch's last completion still needs acknowledgement. */
  readonly completed: boolean;
  /** Whether the stored source conversation is gone from the session list. */
  readonly sourceGone: boolean;
}

/** One history row: metadata, an actions menu, inline rename and delete. */
function SideChatHistoryRow({
  chat,
  now,
  onOpen,
  onOpenMain,
  running,
  completed,
  sourceGone,
}: SideChatHistoryRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const quote = quoteFragment(chat.quote);
  const status = sideRowStatus(running, completed);
  const disabled = chat.sessionId === null;
  const beginRename = () => {
    setDraft(chat.title);
    setRenaming(true);
    setMenuOpen(false);
  };
  const commitRename = () => {
    setRenaming(false);
    const title = draft.trim();
    if (title === '' || title === chat.title) return;
    void sideHistoryStore?.actions.rename(chat.id, title).catch(() => undefined);
  };
  const cancelRename = () => {
    setRenaming(false);
  };
  const confirmDelete = () => {
    setConfirming(false);
    void sideHistoryStore?.actions.remove(chat.id).catch(() => undefined);
  };
  return (
    <li className={styles.historyRow}>
      <div className={styles.historyRowMain}>
        {renaming ? (
          <input
            type="text"
            className={styles.renameInput}
            value={draft}
            autoFocus
            aria-label="重命名侧边对话"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
              else if (event.key === 'Escape') cancelRename();
            }}
          />
        ) : (
          <span className={styles.historyRowTitle}>{chatRowTitle(chat)}</span>
        )}
        <span className={styles.historyRowSource}>
          {sourceGone ? '来源已删除' : chatSourceLabel(chat)}
        </span>
        {quote !== null ? (
          <span className={styles.historyRowQuote}>{quote}</span>
        ) : null}
      </div>
      <div className={styles.historyRowMeta}>
        <time className={styles.historyRowTime} dateTime={chat.updatedAt}>
          {formatRelativeTime(chat.updatedAt, now)}
        </time>
        {status === 'unknown' ? null : (
          <span
            className={styles.historyRowStatus}
            data-running={status === 'running' ? '' : undefined}
            data-completed={status === 'completed' ? '' : undefined}
          >
            {status === 'running' || status === 'completed' ? (
              <span
                className={status === 'running'
                  ? styles.historyRowStatusDot
                  : styles.historyRowStatusDotDone}
                aria-hidden="true"
              />
            ) : null}
            {sideRowStatusLabel(status)}
          </span>
        )}
      </div>
      {confirming ? (
        <div className={styles.confirmBar}>
          <span className={styles.confirmText}>
            删除后，这次侧边讨论将从历史中移除，主对话不受影响。
          </span>
          <span className={styles.confirmActions}>
            <button
              type="button"
              className={styles.dangerButton}
              onClick={confirmDelete}
            >
              删除
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
          </span>
        </div>
      ) : (
        <div className={styles.historyRowActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled}
            title={disabled ? '分支会话尚未创建完成' : undefined}
            onClick={() => {
              if (chat.sessionId !== null) onOpen(chat.sessionId);
            }}
          >
            打开
          </button>
          <div className={styles.menuAnchor}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="更多操作"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={16} strokeWidth={1.6} aria-hidden="true" />
            </button>
            {menuOpen ? (
              <div className={styles.menu} role="menu">
                <button
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  onClick={beginRename}
                >
                  重命名
                </button>
                {onOpenMain !== undefined && chat.sessionId !== null ? (
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenMain(chat.sessionId as string);
                    }}
                  >
                    在主对话中打开
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`${styles.menuItem} ${styles.menuItemDanger}`}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirming(true);
                  }}
                >
                  删除
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}

// --- Conditional registration ----------------------------------------------

/** Faces `registerSideHistoryView` needs (structural). */
export interface SideHistoryContext {
  readonly slots: {
    inject(key: string, callback: () => () => void): () => void;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  readonly sidebarRight: {
    openResource(address: string, options?: Record<string, unknown>): void;
  };
  /** Session service the row markers read (`list` only; absent on a bare boot). */
  readonly sessions?: SideSessionServiceFace;
  /** Unread tracker over the Session status service (absent on a bare boot). */
  readonly unread?: SideUnreadStore;
  /** Open a branch as the main conversation (P1; absent on a bare boot). */
  readonly openMain?: (sessionId: string) => void;
}

/**
 * Keep the 侧边对话历史 view registered exactly while side chats exist. The
 * conditional registration rides the view seat's declaration lifecycle, so a
 * conversation teardown re-asserts it and a plugin unload drops it.
 * @param ctx - client faces carrying the slots and the right-sidebar controller.
 * @param store - chat store the view reads.
 * @returns cleanup dropping the latest registration and the store injection.
 */
export function registerSideHistoryView(
  ctx: SideHistoryContext,
  store: SideHistoryStoreSource,
): () => void {
  sideHistoryStore = store;
  const sessionList = ctx.sessions?.list;
  let disposeView: (() => void) | null = null;
  let disposed = false;
  const sync = () => {
    if (disposed) return;
    const present = store.sideChats.getSnapshot().length > 0;
    if (present && disposeView === null) {
      disposeView = ctx.slots.register(
        {
          name: SIDE_VIEW_SLOT,
          id: SIDE_HISTORY_VIEW_ID,
          order: 100,
          label: () => SIDE_HISTORY_LABEL,
          inject: () => ({
            openSideChat: (sessionId: string) => {
              // Opening the branch puts it in front of the user; that is the
              // acknowledgement the 「已完成」 marker waits for.
              ctx.unread?.acknowledge(sessionId);
              ctx.sidebarRight.openResource(buildSpaceChatAddress(sessionId), {
                kind: SIDE_CHAT_TAB_KIND,
              });
            },
            sessionList,
            unread: ctx.unread,
            openMain: ctx.openMain,
          }),
        },
        SideChatHistory,
      );
    } else if (!present && disposeView !== null) {
      disposeView();
      disposeView = null;
    }
  };
  ctx.slots.inject(SIDE_VIEW_SLOT, () => {
    const unsubscribe = store.sideChats.subscribe(() => sync());
    sync();
    return () => {
      unsubscribe();
      if (disposeView !== null) {
        disposeView();
        disposeView = null;
      }
    };
  });
  return () => {
    disposed = true;
    if (disposeView !== null) {
      disposeView();
      disposeView = null;
    }
    sideHistoryStore = null;
  };
}
