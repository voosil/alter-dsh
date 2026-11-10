/**
 * 「历史评论」dialog: resolved (accepted) comments of one document.
 *
 * Mirrors the old HTML view modal: resolved comments newest-first, each showing
 * author, resolution time, the quoted text (when present), body and
 * supplements. The entry point lives in the document menu and is disabled while
 * there is no resolved comment.
 *
 * @module @alter-dsh/space/document/footer/HistoryCommentsDialog
 */
import type { Comment } from '@alter/protocol';
import { Dialog } from '@alter/ui-system';
import { formatFullDate } from '../../../vendor/ui-space/src/utils/date';
import styles from './footer.module.css';

/** Props of {@link HistoryCommentsDialog}. */
export interface HistoryCommentsDialogProps {
  open: boolean;
  /** All comments of the document; resolved ones are listed. */
  comments: readonly Comment[];
  onClose: () => void;
}

/** Resolved comments of one document, newest first. */
export function resolvedCommentsOf(
  comments: readonly Comment[],
): Comment[] {
  return comments
    .filter((comment) => comment.status === 'resolved')
    .sort(
      (left, right) =>
        Date.parse(right.resolvedAt ?? right.createdAt) -
        Date.parse(left.resolvedAt ?? left.createdAt),
    );
}

/** History-comments modal. */
export function HistoryCommentsDialog({
  open,
  comments,
  onClose,
}: HistoryCommentsDialogProps) {
  const resolved = resolvedCommentsOf(comments);

  return (
    <Dialog open={open} onClose={onClose} title="历史评论" size="medium">
      {resolved.length === 0 ? (
        <p className={styles.dialogEmpty}>还没有历史评论。</p>
      ) : (
        <div className={styles.dialogList}>
          {resolved.map((comment) => (
            <article key={comment.id} className={styles.dialogComment}>
              <header className={styles.dialogHead}>
                <span className={styles.author}>
                  {comment.author === 'alter' ? 'Alter' : '我'}
                </span>
                <span className={styles.time}>
                  {formatFullDate(comment.resolvedAt ?? comment.createdAt)} 采纳
                </span>
              </header>
              {comment.quote === null || comment.quote.trim() === '' ? null : (
                <p className={styles.dialogQuote}>{comment.quote}</p>
              )}
              <p className={styles.dialogBody}>{comment.body}</p>
              {comment.supplements === undefined ||
              comment.supplements.length === 0 ? null : (
                <div className={styles.dialogSupplements}>
                  {comment.supplements.map((supplement) => (
                    <div key={supplement.id} className={styles.dialogSupplement}>
                      <span className={styles.dialogSupplementMeta}>
                        {supplement.author === 'alter' ? 'Alter' : '我'} 补充 ·{' '}
                        {formatFullDate(supplement.createdAt)}
                      </span>
                      <p className={styles.dialogSupplementBody}>
                        {supplement.body}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </Dialog>
  );
}
