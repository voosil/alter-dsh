import type { Comment } from '@alter/protocol';
import { CommentCard } from './CommentCard';
import { CommentComposer } from './CommentComposer';
import styles from './DocumentComments.module.css';

export function DocumentComments({
  comments,
  activeCommentId,
  onActivate,
  onAdd,
  onApprove,
  onEdit,
  onSupplement,
  onDelete,
}: {
  comments: Comment[];
  activeCommentId: string | null;
  onActivate: (id: string | null) => void;
  onAdd: (body: string) => Promise<void>;
  onApprove: (id: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onSupplement: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const fullComments = comments.filter(
    (comment) => comment.status === 'open' && comment.quote === null,
  );

  return (
    <section className={styles.section} aria-label="全文评论">
      <CommentComposer variant="full" onAdd={onAdd} />
      {fullComments.length ? (
        <div className={styles.list}>
          {fullComments.map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              active={activeCommentId === comment.id}
              variant="document"
              onActivate={onActivate}
              onApprove={onApprove}
              onEdit={onEdit}
              onSupplement={onSupplement}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
