import type { Comment } from '@alter/protocol';
import { formatFullDate } from '../utils/date';
import { EmptyState } from './EmptyState';
import { Dialog } from '@alter/ui-system';
import styles from './HistoryCommentsModal.module.css';

export function HistoryCommentsModal({
  open,
  comments,
  onClose,
}: {
  open: boolean;
  comments: Comment[];
  onClose: () => void;
}) {
  const resolved = comments
    .filter((comment) => comment.status === 'resolved')
    .sort(
      (a, b) =>
        Date.parse(b.resolvedAt ?? b.createdAt) -
        Date.parse(a.resolvedAt ?? a.createdAt),
    );
  return (
    <Dialog open={open} onClose={onClose} title="历史评论" size="medium">
      {resolved.length ? (
        <div className={styles.list}>
          {resolved.map((comment) => (
            <article key={comment.id} className={styles.comment}>
              <header className={styles.head}>
                <span className={styles.author}>
                  {comment.author === 'alter' ? 'Alter' : '我'}
                </span>
                <span className={styles.time}>
                  {formatFullDate(comment.resolvedAt ?? comment.createdAt)} 采纳
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
          description="评论被采纳后会保存在这里。"
        />
      )}
    </Dialog>
  );
}
