import { Archive, ArchiveRestore, MoreHorizontal, Pencil } from 'lucide-react';
import type { Thought } from '@alter/protocol';
import { formatTime } from '../utils/date';
import { IconButton } from '@alter/ui-system';
import styles from './ThoughtRow.module.css';

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
  return (
    <article className={styles.row} onClick={onOpen}>
      <time className={styles.time} dateTime={thought.createdAt}>
        {formatTime(thought.createdAt)}
      </time>
      <div
        className={styles.text}
        dangerouslySetInnerHTML={{ __html: thought.content }}
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
