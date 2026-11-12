import type { Comment } from '@alter/protocol';
import { formatFullDate } from '../utils/date';
import { EmptyState } from './EmptyState';
import { Dialog } from '@alter/ui-system';
import styles from './HistoryCommentsModal.module.css';

/**
 * One history row: a comment that left the live rails, either resolved
 * (采纳) or soft-deleted (已删除).
 */
interface HistoryEntry {
  comment: Comment;
  /** When it left the rails: `deletedAt` / `resolvedAt`, else `createdAt`. */
  at: string;
  /** Status word shown after the time. */
  label: '采纳' | '已删除';
}

/**
 * When a comment left the live rails.
 *
 * Soft deletes use `deletedAt`, approvals `resolvedAt`; a row persisted before
 * either field falls back to its creation time. The page shares this rule with
 * the history panel so the menu state and the list never disagree.
 */
export function historyCommentAt(comment: Comment): string {
  return (
    (comment.status === 'deleted' ? comment.deletedAt : comment.resolvedAt) ??
    comment.createdAt
  );
}

/**
 * History entries, newest first.
 *
 * Resolved and deleted comments share one timeline ordered by when each of
 * them happened.
 */
function toHistoryEntries(comments: readonly Comment[]): HistoryEntry[] {
  return comments
    .flatMap((comment): HistoryEntry[] => {
      if (comment.status === 'deleted')
        return [{ comment, at: historyCommentAt(comment), label: '已删除' }];
      if (comment.status === 'resolved')
        return [{ comment, at: historyCommentAt(comment), label: '采纳' }];
      return [];
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function HistoryCommentsModal({
  open,
  comments,
  onClose,
}: {
  open: boolean;
  comments: Comment[];
  onClose: () => void;
}) {
  const entries = toHistoryEntries(comments);
  return (
    <Dialog open={open} onClose={onClose} title="历史评论" size="medium">
      {entries.length ? (
        <div className={styles.list}>
          {entries.map(({ comment, at, label }) => (
            <article key={comment.id} className={styles.comment}>
              <header className={styles.head}>
                <span className={styles.author}>
                  {comment.author === 'alter' ? 'Alter' : '我'}
                </span>
                <span className={styles.time}>
                  {formatFullDate(at)} {label}
                </span>
              </header>
              {comment.quote ? (
                <p className={styles.quote}>{comment.quote}</p>
              ) : null}
              <p className={styles.body}>{comment.body}</p>
              {comment.supplements?.length ? (
                <div className={styles.supplements}>
                  {comment.supplements.map((supplement) => (
                    <div key={supplement.id} className={styles.supplement}>
                      <span className={styles.supplementMeta}>
                        {supplement.author === 'alter' ? 'Alter' : '我'} 补充 ·{' '}
                        {formatFullDate(supplement.createdAt)}
                      </span>
                      <p className={styles.supplementBody}>{supplement.body}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="还没有历史评论"
          description="评论被采纳或删除后会保存在这里。"
        />
      )}
    </Dialog>
  );
}