/**
 * Collapsible comment rail next to the document body.
 *
 * Lists open comments (anchored comments first, in document order), the
 * selection composer and a collapsible 「已解决」 section. Narrow layouts stack
 * the rail under the body through CSS.
 *
 * @module @alter-dsh/space/document/comments/CommentRail
 */
import { useState } from 'react';
import type { Comment } from '@alter/protocol';
import { CommentCard } from './CommentCard';
import { CommentComposer } from './CommentComposer';
import styles from './comments.module.css';

export interface CommentRailProps {
  /** All comments of the document, already sorted in document order. */
  comments: readonly Comment[];
  activeCommentId: string | null;
  /** Comment ids whose stored anchor no longer points at a text range. */
  invalidCommentIds: ReadonlySet<string>;
  /** Selected text waiting for a comment, when the user made a selection. */
  pendingQuote: string | null;
  onActivate: (id: string | null) => void;
  onAddPending: (body: string) => Promise<void>;
  onCancelPending: () => void;
  onPendingDraftChange?: (hasContent: boolean) => void;
  onApprove: (id: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onSupplement: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onLocate: (comment: Comment) => void;
}

/** Document comment rail. */
export function CommentRail({
  comments,
  activeCommentId,
  invalidCommentIds,
  pendingQuote,
  onActivate,
  onAddPending,
  onCancelPending,
  onPendingDraftChange,
  onApprove,
  onEdit,
  onSupplement,
  onDelete,
  onLocate,
}: CommentRailProps) {
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const openComments = comments.filter((comment) => comment.status === 'open');
  const resolvedComments = comments.filter(
    (comment) => comment.status === 'resolved',
  );

  const card = (comment: Comment) => (
    <CommentCard
      key={comment.id}
      comment={comment}
      active={activeCommentId === comment.id}
      invalid={invalidCommentIds.has(comment.id)}
      onActivate={onActivate}
      onApprove={onApprove}
      onEdit={onEdit}
      onSupplement={onSupplement}
      onDelete={onDelete}
      onLocate={onLocate}
    />
  );

  return (
    <aside className={styles.rail} aria-label="评论">
      {pendingQuote === null ? null : (
        <CommentComposer
          key={pendingQuote}
          quote={pendingQuote}
          autoFocus
          onAdd={onAddPending}
          onCancel={onCancelPending}
          onDraftChange={onPendingDraftChange}
        />
      )}
      {openComments.length === 0 && pendingQuote === null ? (
        <p className={styles.empty}>还没有评论。评论仅当前空间可见。</p>
      ) : null}
      {openComments.map(card)}
      {resolvedComments.length === 0 ? null : (
        <section className={styles.resolved}>
          <button
            type="button"
            className={styles.resolvedToggle}
            aria-expanded={resolvedOpen}
            onClick={() => setResolvedOpen((open) => !open)}
          >
            已解决
            <span className={styles.resolvedCount}>
              {resolvedComments.length}
            </span>
          </button>
          {resolvedOpen ? resolvedComments.map(card) : null}
        </section>
      )}
    </aside>
  );
}
