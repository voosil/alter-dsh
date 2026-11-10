/**
 * Comments and version-history side panel for AST-backed documents.
 *
 * Comments use the existing SpaceService comment API (quote anchoring stays
 * optional in v0). The history tab is delegated to `history/HistoryView`:
 * version list, AST block diff preview and restore through the document RPC
 * (`doc.restoreVersion`), which keeps revision CAS monotonic.
 *
 * @module @alter-dsh/space/document/DocumentSidePanel
 */
import { useCallback, useEffect, useState } from 'react';
import type { Comment, DocVersion, SpaceService } from '@alter/protocol';
import type { SpaceDocumentClient } from '../space-client';
import { HistoryView } from './history';
import styles from './DocumentSidePanel.module.css';

export interface DocumentSidePanelProps {
  docId: string;
  revision: number;
  service: SpaceService;
  client: SpaceDocumentClient;
  onRestored: (revision: number) => void;
}

type Tab = 'comments' | 'history';

type Status =
  | { kind: 'idle' }
  | { kind: 'info' | 'success'; message: string }
  | { kind: 'error'; message: string };

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Render the comments/history panel. */
export function DocumentSidePanel({
  docId,
  revision,
  service,
  client,
  onRestored,
}: DocumentSidePanelProps) {
  const [tab, setTab] = useState<Tab>('comments');
  const [comments, setComments] = useState<Comment[]>([]);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const reloadComments = useCallback(async () => {
    try {
      setComments(await service.listComments(docId));
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [service, docId]);

  const reloadVersions = useCallback(async () => {
    try {
      const list = await service.listVersions(docId);
      setVersions(list);
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [service, docId]);

  useEffect(() => {
    void reloadComments();
  }, [reloadComments, revision]);

  useEffect(() => {
    void reloadVersions();
  }, [reloadVersions, revision]);

  useEffect(() => {
    setStatus({ kind: 'idle' });
  }, [docId]);

  async function addComment() {
    const body = draft.trim();
    if (body === '') return;
    setBusy(true);
    setStatus({ kind: 'idle' });
    try {
      await service.addComment({ docId, body });
      setDraft('');
      setStatus({ kind: 'success', message: '评论已发布' });
      await reloadComments();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function resolveComment(id: string) {
    setBusy(true);
    try {
      await service.resolveComment(id);
      await reloadComments();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const openComments = comments.filter((comment) => comment.status === 'open');
  const resolvedComments = comments.filter((comment) => comment.status === 'resolved');

  return (
    <aside className={styles.panel} aria-label="评论与版本历史">
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'comments'}
          className={tab === 'comments' ? styles.tabActive : styles.tab}
          onClick={() => setTab('comments')}
        >
          评论 {comments.length > 0 ? `(${comments.length})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={tab === 'history' ? styles.tabActive : styles.tab}
          onClick={() => setTab('history')}
        >
          历史 {versions.length > 0 ? `(${versions.length})` : ''}
        </button>
      </div>

      {status.kind !== 'idle' ? (
        <div
          className={status.kind === 'error' ? styles.error : styles.notice}
          role={status.kind === 'error' ? 'alert' : undefined}
        >
          {status.message}
        </div>
      ) : null}

      {tab === 'comments' ? (
        <div className={styles.comments}>
          <div className={styles.commentList}>
            {openComments.length === 0 && resolvedComments.length === 0 ? (
              <p className={styles.empty}>还没有评论。</p>
            ) : null}
            {[...openComments, ...resolvedComments].map((comment) => (
              <article
                key={comment.id}
                className={
                  comment.status === 'resolved'
                    ? styles.commentResolved
                    : styles.comment
                }
              >
                <header className={styles.commentHead}>
                  <span>{comment.author === 'alter' ? 'Alter' : '我'}</span>
                  <span className={styles.commentTime}>
                    {formatTime(comment.createdAt)}
                  </span>
                  {comment.status === 'resolved' ? (
                    <span className={styles.badge}>已解决</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.textButton}
                      disabled={busy}
                      onClick={() => void resolveComment(comment.id)}
                    >
                      解决
                    </button>
                  )}
                </header>
                {comment.quote === null ? null : (
                  <blockquote className={styles.quote}>{comment.quote}</blockquote>
                )}
                <p className={styles.commentBody}>{comment.body}</p>
              </article>
            ))}
          </div>
          <div className={styles.composer}>
            <textarea
              className={styles.textarea}
              value={draft}
              rows={3}
              placeholder="写下评论…"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="button"
              className={styles.primary}
              disabled={busy || draft.trim() === ''}
              onClick={() => void addComment()}
            >
              发布评论
            </button>
          </div>
        </div>
      ) : (
        <HistoryView
          docId={docId}
          revision={revision}
          versions={versions}
          client={client}
          onRestored={onRestored}
          onReloadVersions={reloadVersions}
        />
      )}
    </aside>
  );
}
