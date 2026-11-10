/**
 * Document footer: 「子文档 / 全文评论」tabs after the editor body.
 *
 * Mirrors the old HTML document view footer:
 * - the footer only exists when the document has child notes or full-document
 *   comments (view decides with `showFooter` semantics);
 * - child notes navigate to their document; archived children keep an
 *   「已归档」marker;
 * - full comments are the comments without a text anchor (`anchor === null`);
 *   the tab carries the unresolved count and the list is display-only.
 *
 * Presentational: the view filters/sorts the data from `useSpaceContext()` and
 * `service.listComments` before passing it in.
 *
 * @module @alter-dsh/space/document/footer/DocumentFooter
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Archive, FileText } from 'lucide-react';
import type { Comment, SpaceNode } from '@alter/protocol';
import {
  formatFullDate,
  formatRelativeTime,
} from '../../../vendor/ui-space/src/utils/date';
import { displayTitle } from '../../../vendor/ui-space/src/utils/tree';
import styles from './footer.module.css';

type FooterTab = 'children' | 'comments';

/** Props of {@link DocumentFooter}. */
export interface DocumentFooterProps {
  /** Child notes of the current document, already filtered and sorted. */
  children: readonly SpaceNode[];
  /** Comments without a text anchor (full-document comments). */
  comments: readonly Comment[];
  /** Navigate to one child document. */
  onOpenDocument: (docId: string) => void;
}

/** Footer with the children and full-comment tabs. */
export function DocumentFooter({
  children,
  comments,
  onOpenDocument,
}: DocumentFooterProps) {
  const [tab, setTab] = useState<FooterTab>('children');
  const childrenTabRef = useRef<HTMLButtonElement>(null);
  const commentsTabRef = useRef<HTMLButtonElement>(null);
  const unresolvedCount = comments.filter(
    (comment) => comment.status === 'open',
  ).length;

  function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: FooterTab = tab === 'children' ? 'comments' : 'children';
    setTab(next);
    (next === 'children' ? childrenTabRef : commentsTabRef).current?.focus();
  }

  return (
    <section className={styles.footer} aria-label="文档附加内容">
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="文档附加内容"
        onKeyDown={handleTabKeyDown}
      >
        <button
          ref={childrenTabRef}
          type="button"
          role="tab"
          id="doc-children-tab"
          className={styles.tab}
          aria-selected={tab === 'children'}
          aria-controls="doc-children-panel"
          tabIndex={tab === 'children' ? 0 : -1}
          onClick={() => setTab('children')}
        >
          子文档
        </button>
        <button
          ref={commentsTabRef}
          type="button"
          role="tab"
          id="doc-full-comments-tab"
          className={styles.tab}
          aria-selected={tab === 'comments'}
          aria-controls="doc-full-comments-panel"
          tabIndex={tab === 'comments' ? 0 : -1}
          onClick={() => setTab('comments')}
        >
          全文评论
          {unresolvedCount > 0 ? (
            <span className={styles.count}>{unresolvedCount}</span>
          ) : null}
        </button>
      </div>

      {tab === 'children' ? (
        <div
          className={styles.panel}
          role="tabpanel"
          id="doc-children-panel"
          aria-labelledby="doc-children-tab"
        >
          {children.length === 0 ? (
            <p className={styles.empty}>暂无子文档</p>
          ) : (
            <ul className={styles.childList}>
              {children.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    className={styles.childRow}
                    onClick={() => onOpenDocument(child.id)}
                  >
                    <FileText
                      size={15}
                      strokeWidth={1.5}
                      className={styles.childIcon}
                      aria-hidden="true"
                    />
                    <span className={styles.childTitle}>
                      {displayTitle(child.title)}
                    </span>
                    {child.archived ? (
                      <span className={styles.childArchived}>
                        <Archive
                          size={12}
                          strokeWidth={1.6}
                          aria-hidden="true"
                        />
                        已归档
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div
          className={styles.panel}
          role="tabpanel"
          id="doc-full-comments-panel"
          aria-labelledby="doc-full-comments-tab"
        >
          {comments.length === 0 ? (
            <p className={styles.empty}>暂无全文评论</p>
          ) : (
            <ul className={styles.commentList}>
              {comments.map((comment) => (
                <li key={comment.id} className={styles.comment}>
                  <header className={styles.commentHead}>
                    <span className={styles.author}>
                      {comment.author === 'alter' ? 'Alter' : '我'}
                    </span>
                    <span
                      className={styles.time}
                      title={formatFullDate(comment.createdAt)}
                    >
                      {formatRelativeTime(comment.createdAt)}
                    </span>
                    {comment.status === 'resolved' ? (
                      <span className={styles.resolvedBadge}>已解决</span>
                    ) : null}
                  </header>
                  <p className={styles.commentBody}>{comment.body}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
