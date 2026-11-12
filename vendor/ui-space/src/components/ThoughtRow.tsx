import { Archive, ArchiveRestore, MoreHorizontal, Pencil } from 'lucide-react';
import { useMemo } from 'react';
import type { Thought } from '@alter/protocol';
import { formatTime } from '../utils/date';
import { IconButton } from '@alter/ui-system';
import styles from './ThoughtRow.module.css';

/**
 * Tag and attribute allowlist for thought bodies.
 *
 * Thoughts are stored as the composer's rich-text HTML and rendered with
 * `dangerouslySetInnerHTML` (the frozen baseline behaviour), so the stored
 * string is untrusted: an Agent or a server-authority peer can write any string
 * through `space.createThought`. Only what the composer itself can produce
 * survives; scripts, event handlers, styles and external URLs are stripped
 * before the value ever reaches the DOM.
 */
const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DIV', 'EM', 'I', 'LI', 'OL', 'P',
  'PRE', 'S', 'SPAN', 'STRIKE', 'STRONG', 'U', 'UL',
]);
const ALLOWED_ATTRIBUTES = new Set(['href', 'class']);

function sanitizeThoughtHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walk = (parent: ParentNode): void => {
    for (const child of Array.from(parent.children)) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      for (const attribute of Array.from(child.attributes)) {
        const name = attribute.name.toLowerCase();
        const safeHref =
          name === 'href' &&
          /^(https?:\/\/|mailto:|#)/i.test(attribute.value.trim());
        if (!ALLOWED_ATTRIBUTES.has(name) || (name === 'href' && !safeHref))
          child.removeAttribute(attribute.name);
      }
      walk(child);
    }
  };
  walk(template.content);
  return template.innerHTML;
}

export function ThoughtRow({
  thought,
  onOpen,
  onEdit,
  onToggleArchive,
  onMenu,
}: {
  thought: Thought;
  onOpen: () => void;
  onEdit: () => void;
  onToggleArchive: () => void;
  onMenu: (anchor: HTMLElement) => void;
}) {
  const safeContent = useMemo(
    () => sanitizeThoughtHtml(thought.content),
    [thought.content],
  );
  return (
    <article className={styles.row} onClick={onOpen}>
      <time className={styles.time} dateTime={thought.createdAt}>
        {formatTime(thought.createdAt)}
      </time>
      <div
        className={styles.text}
        dangerouslySetInnerHTML={{ __html: safeContent }}
      />
      <div className={styles.actions}>
        <IconButton
          label="编辑"
          size="sm"
          tooltipPlacement="top"
          icon={<Pencil />}
          onClick={(event) => {
            event.stopPropagation();
            onEdit();
          }}
        />
        <IconButton
          label={thought.archived ? '恢复' : '归档'}
          size="sm"
          tooltipPlacement="top"
          icon={thought.archived ? <ArchiveRestore /> : <Archive />}
          onClick={(event) => {
            event.stopPropagation();
            onToggleArchive();
          }}
        />
        <IconButton
          label="随想操作"
          size="sm"
          tooltipPlacement="top"
          icon={<MoreHorizontal />}
          onClick={(event) => {
            event.stopPropagation();
            onMenu(event.currentTarget);
          }}
        />
      </div>
    </article>
  );
}
