import { useEffect, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import styles from './CommentComposer.module.css';

export function CommentComposer({
  quote = null,
  variant = 'inline',
  autoFocus = false,
  onAdd,
  onCancel,
  onDraftChange,
}: {
  quote?: string | null;
  variant?: 'inline' | 'full';
  autoFocus?: boolean;
  onAdd: (body: string) => Promise<void> | void;
  onCancel?: () => void;
  onDraftChange?: (hasContent: boolean) => void;
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    // Wait until the rail's width/visibility transition has made the input focusable.
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
      if (variant === 'full') textareaRef.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '评论失败，请重试');
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className={styles.composer}
      data-variant={variant}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onCancel) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      {quote ? (
        <div className={styles.quoteRow}>
          <p className={styles.quote}>{quote}</p>
          {onCancel ? (
            <button
              type="button"
              className={styles.cancel}
              aria-label="取消引用"
              title="取消引用"
              onClick={onCancel}
            >
              <X size={13} strokeWidth={1.7} />
            </button>
          ) : null}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={body}
        rows={2}
        aria-label={quote ? '评论内容' : '全文评论内容'}
        placeholder={quote ? '回应这段文字…' : '写下对整篇文档的评论…'}
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
      <div className={styles.footer}>
        {error ? (
          <span className={styles.error} role="alert">
            {error}
          </span>
        ) : (
          <span className={styles.hint}>⌘↵ 发送</span>
        )}
        <button
          type="button"
          className={styles.send}
          disabled={sending || !body.trim()}
          aria-label={quote ? '发送评论' : '发送全文评论'}
          title={quote ? '发送评论' : '发送全文评论'}
          onClick={() => void submit()}
        >
          <Send size={13} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}
