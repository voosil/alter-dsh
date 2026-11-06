import { useEffect, useRef, useState } from 'react';
import { Check, MessageSquarePlus, MoreHorizontal } from 'lucide-react';
import type { Comment } from '@alter/protocol';
import { Menu, type MenuAction } from '@alter/ui-system';
import { formatFullDate, formatRelativeTime } from '../utils/date';
import styles from './CommentCard.module.css';

export function CommentCard({
  comment,
  active,
  variant = 'rail',
  onActivate,
  onApprove,
  onEdit,
  onSupplement,
  onDelete,
}: {
  comment: Comment;
  active: boolean;
  variant?: 'rail' | 'document';
  onActivate: (id: string | null) => void;
  onApprove: (id: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onSupplement: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [supplementing, setSupplementing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState(comment.body);
  const [supplementDraft, setSupplementDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cardRef = useRef<HTMLElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const supplementRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => editRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);
  useEffect(() => {
    if (supplementing) supplementRef.current?.focus();
  }, [supplementing]);

  const author = comment.author === 'alter' ? 'Alter' : '我';
  const supplements = comment.supplements ?? [];
  const menuActions: MenuAction[] = [
    {
      id: 'edit',
      label: '编辑',
      onSelect: beginEdit,
    },
    {
      id: 'delete',
      label: '删除',
      danger: true,
      onSelect: () => {
        setError('');
        setConfirmingDelete(true);
      },
    },
  ];
  const time = `${comment.editedAt ? '已编辑 · ' : ''}${formatRelativeTime(
    comment.createdAt,
  )}`;

  function releaseIfInactive() {
    window.requestAnimationFrame(() => {
      const card = cardRef.current;
      if (
        card &&
        !card.matches(':hover') &&
        !card.contains(document.activeElement)
      )
        onActivate(null);
    });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  function beginEdit() {
    setDraft(comment.body);
    setError('');
    setConfirmingDelete(false);
    setEditing(true);
  }

  function saveEdit() {
    const body = draft.trim();
    if (!body) {
      setError('写下评论内容');
      editRef.current?.focus();
      return;
    }
    void run(async () => {
      await onEdit(comment.id, body);
      setEditing(false);
      releaseIfInactive();
    });
  }

  function saveSupplement() {
    const body = supplementDraft.trim();
    if (!body) {
      setError('写下补充内容');
      supplementRef.current?.focus();
      return;
    }
    void run(async () => {
      await onSupplement(comment.id, body);
      setSupplementDraft('');
      setSupplementing(false);
      releaseIfInactive();
    });
  }

  return (
    <article
      ref={cardRef}
      className={styles.card}
      data-active={active || undefined}
      data-variant={variant}
      data-confirming={confirmingDelete || undefined}
      onMouseEnter={() => onActivate(comment.id)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement))
          onActivate(null);
      }}
      onFocusCapture={() => onActivate(comment.id)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!event.currentTarget.contains(next)) onActivate(null);
      }}
    >
      <header className={styles.header}>
        <span className={styles.author}>{author}</span>
        <span
          className={styles.time}
          title={formatFullDate(comment.editedAt ?? comment.createdAt)}
        >
          {time}
        </span>
        {!editing && !supplementing ? (
          <div className={styles.actions}>
            {confirmingDelete ? (
              <span className={styles.confirm}>
                删除？
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => {
                    setConfirmingDelete(false);
                    releaseIfInactive();
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={`${styles.textButton} ${styles.danger}`}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await onDelete(comment.id);
                    })
                  }
                >
                  删除
                </button>
              </span>
            ) : (
              <>
                <button
                  type="button"
                  className={`${styles.action} ${styles.approve}`}
                  aria-label="采纳评论"
                  title="采纳"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await onApprove(comment.id);
                    })
                  }
                >
                  <Check size={13} strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  className={styles.action}
                  aria-label="补充评论"
                  title="补充"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setConfirmingDelete(false);
                    setSupplementing(true);
                  }}
                >
                  <MessageSquarePlus size={13} strokeWidth={1.7} />
                </button>
                <button
                  type="button"
                  className={styles.action}
                  aria-label="更多评论操作"
                  title="更多"
                  aria-haspopup="menu"
                  aria-expanded={Boolean(menuAnchor)}
                  disabled={busy}
                  onClick={(event) => setMenuAnchor(event.currentTarget)}
                >
                  <MoreHorizontal size={14} strokeWidth={1.7} />
                </button>
              </>
            )}
          </div>
        ) : null}
      </header>

      {comment.quote ? <p className={styles.quote}>{comment.quote}</p> : null}

      {editing ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            saveEdit();
          }}
        >
          <textarea
            ref={editRef}
            value={draft}
            aria-label="编辑评论内容"
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                saveEdit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
                setError('');
                releaseIfInactive();
              }
            }}
          />
          <div className={styles.formFoot}>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => {
                setEditing(false);
                setError('');
                releaseIfInactive();
              }}
            >
              取消
            </button>
            <button
              type="submit"
              className={`${styles.textButton} ${styles.primary}`}
              disabled={busy}
            >
              保存
            </button>
          </div>
        </form>
      ) : (
        <p className={styles.body}>{comment.body}</p>
      )}

      {supplements.length ? (
        <div className={styles.supplements}>
          {supplements.map((supplement) => (
            <div key={supplement.id} className={styles.supplement}>
              <span className={styles.supplementMeta}>
                {supplement.author === 'alter' ? 'Alter' : '我'} 补充 ·{' '}
                {formatRelativeTime(supplement.createdAt)}
              </span>
              <p className={styles.supplementBody}>{supplement.body}</p>
            </div>
          ))}
        </div>
      ) : null}

      {supplementing ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            saveSupplement();
          }}
        >
          <textarea
            ref={supplementRef}
            value={supplementDraft}
            aria-label="补充评论内容"
            rows={2}
            placeholder="补充说明…"
            onChange={(event) => setSupplementDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                saveSupplement();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setSupplementing(false);
                setError('');
                releaseIfInactive();
              }
            }}
          />
          <div className={styles.formFoot}>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => {
                setSupplementing(false);
                setError('');
                releaseIfInactive();
              }}
            >
              取消
            </button>
            <button
              type="submit"
              className={`${styles.textButton} ${styles.primary}`}
              disabled={busy}
            >
              补充
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <Menu
        anchor={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={() => setMenuAnchor(null)}
        align="end"
        width={56}
        actions={menuActions}
      />
    </article>
  );
}
