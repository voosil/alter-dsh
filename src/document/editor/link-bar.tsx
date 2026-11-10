/**
 * Link editing bar and URL helpers for the AST document editor.
 *
 * The bar edits the inline `link` mark (URL, confirm, remove) and doubles as
 * the URL prompt for the `网页链接卡` slash command. The URL helpers are pure
 * so paste handling and tests can reuse them:
 *
 * - `normalizeLinkHref` accepts absolute http(s)/mailto URLs, site-relative
 *   paths and bare domains (promoted to `https://`);
 * - `isWebUrl` recognizes an absolute web URL pasted as plain text;
 * - `parseInternalDocLink` recognizes a Space document link
 *   (`/space/<spaceId>/doc/<docId>`, absolute or relative) for the
 *   document-link card.
 *
 * @module @alter-dsh/space/document/editor/link-bar
 */
import type { EditorView } from '@tiptap/pm/view';
import type { ReactNode } from 'react';
import styles from './link-bar.module.css';

/** Space document link extracted from pasted text. */
export interface InternalDocLink {
  spaceId: string;
  docId: string;
}

/** A bare domain such as `example.com` or `example.com/path`. */
const BARE_DOMAIN = /^[\w-]+(?:\.[\w-]+)+(?:[/?#][^\s]*)?$/;

/** An absolute web URL. */
const WEB_URL = /^https?:\/\/[^\s]+$/i;

/** An absolute mail address URL. */
const MAIL_URL = /^mailto:[^\s]+$/i;

/** A site-relative path (`/space/...`). */
const SITE_PATH = /^\/[^\s]*$/;

/** Recognize an absolute web URL. */
export function isWebUrl(value: string): boolean {
  return WEB_URL.test(value.trim());
}

/**
 * Normalize user input to a link href; `undefined` means the input is not a
 * usable URL.
 */
export function normalizeLinkHref(raw: string): string | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  if (WEB_URL.test(value) || MAIL_URL.test(value) || SITE_PATH.test(value)) {
    return value;
  }
  if (BARE_DOMAIN.test(value)) return `https://${value}`;
  return undefined;
}

/**
 * Extract a Space document reference from a pasted link. Supports relative
 * (`/space/sp-1/doc/doc-2`) and absolute
 * (`https://host/space/sp-1/doc/doc-2`) forms, ignoring query/hash.
 */
export function parseInternalDocLink(text: string): InternalDocLink | undefined {
  const value = text.trim();
  if (value === '' || /\s/.test(value)) return undefined;
  const path = value.split(/[?#]/, 1)[0] ?? '';
  const match = /(?:^|\/)space\/([A-Za-z0-9_-]+)\/doc\/([A-Za-z0-9_-]+)\/?$/.exec(
    path,
  );
  if (match === null) return undefined;
  return { spaceId: match[1]!, docId: match[2]! };
}

/**
 * Range of an inline link element inside the editor document. Used by the
 * hover/click affordance so the bar can edit the exact link.
 */
export function linkRangeFromElement(
  view: EditorView,
  element: Element,
): { from: number; to: number } | undefined {
  try {
    const from = view.posAtDOM(element, 0);
    const length = (element.textContent ?? '').length;
    if (length === 0) return undefined;
    return { from, to: from + length };
  } catch {
    return undefined;
  }
}

/** Props of the link editing bar. */
export interface LinkBarProps {
  /** `link` edits the inline mark; `bookmark` inserts a web link card. */
  mode: 'link' | 'bookmark';
  href: string;
  error: string | null;
  /** Whether the current selection already has a link mark. */
  hasLink: boolean;
  onHrefChange: (value: string) => void;
  onConfirm: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/**
 * Inline bar below the toolbar: URL field, confirm, remove (link mode only)
 * and cancel. Enter confirms and Escape closes unless an IME composition is
 * active.
 */
export function LinkBar({
  mode,
  href,
  error,
  hasLink,
  onHrefChange,
  onConfirm,
  onRemove,
  onClose,
}: LinkBarProps): ReactNode {
  return (
    <div
      className={styles.bar}
      data-mode={mode}
      role="dialog"
      aria-label={mode === 'bookmark' ? '插入网页链接卡' : '编辑链接'}
    >
      <span className={styles.label}>
        {mode === 'bookmark' ? '网页链接' : '链接'}
      </span>
      <input
        className={styles.input}
        value={href}
        aria-label="链接地址"
        placeholder="https://example.com"
        spellCheck={false}
        onChange={(event) => onHrefChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            onConfirm();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <button type="button" className={styles.action} onClick={onConfirm}>
        确认
      </button>
      {mode === 'link' ? (
        <button
          type="button"
          className={styles.action}
          onClick={onRemove}
          disabled={!hasLink}
        >
          移除
        </button>
      ) : null}
      <button type="button" className={styles.action} onClick={onClose}>
        取消
      </button>
      {error === null ? null : (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
