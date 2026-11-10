/**
 * Multi-line, auto-growing document title.
 *
 * Mirrors the old HTML editor title: a `rows=1` textarea that grows with its
 * content (so long titles wrap instead of scrolling sideways), keeps the
 * 「无标题」 placeholder, and never inserts a newline on Enter. Saving is not
 * this component's job: the surrounding view keeps the controlled value and the
 * editor's P0 autosave queue persists it (see `AlterTiptapEditor`).
 *
 * @module @alter-dsh/space/document/shell/DocumentTitle
 */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
} from 'react';
import styles from './DocumentShell.module.css';

/** Props of {@link DocumentTitle}. */
export interface DocumentTitleProps {
  /** Controlled title value (raw, not trimmed). */
  value: string;
  /** Called on every keystroke; the view owns autosave scheduling. */
  onChange: (next: string) => void;
  /** Blur handler; the view decides whether an empty title is reverted. */
  onBlur?: () => void;
  /** Read-only while the view resolves a crash-draft banner. */
  disabled?: boolean;
}

/** Auto-growing title textarea (placeholder 「无标题」). */
export function DocumentTitle({
  value,
  onChange,
  onBlur,
  disabled = false,
}: DocumentTitleProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fitToContent = useCallback(() => {
    const element = textareaRef.current;
    if (element === null) return;
    // A hidden container (collapsed pane, pre-layout) measures every glyph on
    // its own line and would lock a huge inline height; retry after layout.
    if (element.clientWidth === 0) return;
    element.style.height = 'auto';
    const height = element.scrollHeight;
    if (height > 0) element.style.height = `${height}px`;
  }, []);

  useLayoutEffect(() => {
    fitToContent();
    if (typeof ResizeObserver !== 'function') return;
    const element = textareaRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(fitToContent);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitToContent, value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Titles are single logical lines: Enter must not insert a newline.
    if (event.key === 'Enter') event.preventDefault();
  };

  return (
    <textarea
      ref={textareaRef}
      className={styles.title}
      value={value}
      rows={1}
      placeholder="无标题"
      aria-label="文档标题"
      spellCheck={false}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      onKeyDown={handleKeyDown}
    />
  );
}
