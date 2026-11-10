/**
 * Inline comment composer used by the comment rail.
 *
 * When the editor reports a text selection the composer shows the quoted text
 * and posts an anchored comment; without a selection it is not rendered (the
 * comments/history panel owns whole-document comments).
 *
 * @module @alter-dsh/space/document/comments/CommentComposer
 */
import { useEffect, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import styles from './comments.module.css';

export interface CommentComposerProps {
  /** Selected text the comment will anchor to. */
  quote?: string | null;
  autoFocus?: boolean;
  onAdd: (body: string) => Promise<void> | void;
  onCancel?: () => void;
  /** Reports whether the draft has content (the view keeps the selection alive). */
  onDraftChange?: (hasContent: boolean) => void;
}

/** Anchored comment composer. */
export function CommentComposer({
  quote = null,
  autoFocus = false,
  onAdd,
  onCancel,
  onDraftChange,
}: CommentComposerProps) {
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    // Wait for the rail's open transition before focusing the input.
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 240);
    return () => window.clearTimeout(timer);
  }, [autoFocus, quote]);

  async function submit() {
    const content = body.trim();
    if (!content) {
      setError('写下评论内容');
      textareaRef.current?.focus();
      return;
    }
    setSending(true);
    setError('');
    try {
      await onAdd(content);
      setBody('');
      onDraftChange?.(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '评论失败，请重试');
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className={styles.composer}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onCancel) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      {quote === null ? null : (
        <div className={styles.quoteRow}>
          <p className={styles.quote}>{quote}</p>
          {onCancel === undefined ? null : (
            <button
              type="button"
              className={styles.cancel}
              aria-label="取消引用"
              title="取消引用"
              onClick={onCancel}
            >
              <X size={13} strokeWidth={1.7} />
            </button>
          )}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={body}
        rows={2}
        aria-label="评论内容"
        placeholder={quote === null ? '写下对整篇文档的评论…' : '回应这段文字…'}
        onChange={(event) => {
          setBody(event.target.value);
          onDraftChange?.(event.target.value.trim().length > 0);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className={styles.composerFooter}>
        {error === '' ? (
          <span className={styles.composerHint}>⌘↵ 发送</span>
        ) : (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
        <button
          type="button"
          className={styles.send}
          disabled={sending || !body.trim()}
          aria-label="发送评论"
          title="发送评论"
          onClick={() => void submit()}
        >
          <Send size={13} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}
