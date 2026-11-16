import type { Chat, ChatRef } from '@alter/protocol';
import { Dialog } from '@alter/ui-system';
import { displayTitle } from '../utils/tree';
import { formatRelativeTime } from '../utils/date';
import styles from './RelatedChatsDialog.module.css';

/**
 * 相关会话弹层（页面菜单「相关会话」）。
 *
 * 纯展示组件：列表数据由页面预取后传入，打开/删除经回调交还页面处理。
 * 行内失效引用（`state !== 'current'`）置灰加删除线；会话已从 DSH 列表消失
 * 的行标注「已删除」且不可打开（删除记录仍可用）；空态固定为「暂无相关会话」
 * （列表被删空时仍在此呈现，菜单项随数量归零消失）。
 */
export function RelatedChatsDialog({
  open,
  chats,
  loading = false,
  error = null,
  onClose,
  onOpenChat,
  onDeleteChat,
  sessionGone,
}: {
  open: boolean;
  chats: Chat[];
  /** Whether the row's DSH session has left the session list. */
  sessionGone?: (chat: Chat) => boolean;
  /** 桥请求进行中：弹层内行内提示，不用 toast。 */
  loading?: boolean;
  /** 桥请求失败的行内错误文案；`null` 表示无错误。 */
  error?: string | null;
  onClose: () => void;
  onOpenChat: (chat: Chat) => void;
  onDeleteChat: (chatId: string) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="相关会话"
      size="small"
    >
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className={styles.empty}>正在加载…</p>
      ) : chats.length === 0 ? (
        <p className={styles.empty}>暂无相关会话</p>
      ) : (
        <div className={styles.list}>
          {chats.map((chat) => {
            const gone = sessionGone?.(chat) === true;
            return (
            <div key={chat.id} className={styles.row} data-gone={gone || undefined}>
              <button
                type="button"
                className={styles.rowMain}
                disabled={gone}
                title={gone ? '该会话已删除' : undefined}
                onClick={() => {
                  if (!gone) onOpenChat(chat);
                }}
              >
                <span className={styles.rowTop}>
                  <span className={styles.badge}>
                    {chat.kind === 'side' ? '侧边对话' : '页面对话'}
                  </span>
                  <span className={styles.rowTitle}>
                    {displayTitle(chat.title)}
                  </span>
                  {gone ? (
                    <span className={styles.rowGone}>已删除</span>
                  ) : null}
                  <span className={styles.rowTime}>
                    {formatRelativeTime(chat.updatedAt)}
                  </span>
                </span>
                <ChatSource chat={chat} />
              </button>
              <button
                type="button"
                className={styles.rowDelete}
                aria-label={`删除对话 ${displayTitle(chat.title)}`}
                onClick={() => onDeleteChat(chat.id)}
              >
                删除
              </button>
            </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

/** 一行的来源说明：侧边对话显示分支来源，页面对话显示引用页面串。 */
function ChatSource({ chat }: { chat: Chat }) {
  if (chat.kind === 'side') {
    if (chat.sideOf === null) return null;
    return (
      <span className={styles.rowMeta}>
        <span className={styles.refLabel}>
          分支自《{displayTitle(chat.sideOf.title)}》
        </span>
      </span>
    );
  }
  if (chat.refs.length === 0) return null;
  return (
    <span className={styles.rowMeta}>
      {chat.refs.map((ref) => (
        <RefLabel key={ref.id} chatRef={ref} />
      ))}
    </span>
  );
}

/** 单条引用标签：失效（非 current）引用置灰加删除线。 */
function RefLabel({ chatRef }: { chatRef: ChatRef }) {
  return (
    <span
      className={styles.refLabel}
      data-stale={chatRef.state !== 'current' || undefined}
    >
      {chatRef.label.trim() || '无标题'}
    </span>
  );
}
