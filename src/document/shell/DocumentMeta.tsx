/**
 * Document metadata line: creator, relative last-update time, revision and the
 * archived badge with its restore entry.
 *
 * The old view derived these from the Space node (`creator`, `updatedAt`,
 * `archived`); the AST view keeps the same source and shows the revision P0
 * already exposed so save receipts stay observable.
 *
 * @module @alter-dsh/space/document/shell/DocumentMeta
 */
import { Archive } from 'lucide-react';
import type { Creator } from '@alter/protocol';
import { formatRelativeTime } from '../../../vendor/ui-space/src/utils/date';
import styles from './DocumentShell.module.css';

/** Props of {@link DocumentMeta}. */
export interface DocumentMetaProps {
  creator: Creator;
  /** ISO timestamp of the node's last update. */
  updatedAt: string;
  /** Current document revision, when the snapshot has loaded. */
  revision?: number;
  /** Whether the document is archived (shows the badge + restore entry). */
  archived: boolean;
  /** Restore (unarchive) action from the archived badge. */
  onRestore: () => void;
}

/** Render creator / updated-at / revision / archived state. */
export function DocumentMeta({
  creator,
  updatedAt,
  revision,
  archived,
  onRestore,
}: DocumentMetaProps) {
  return (
    <div className={styles.meta}>
      <span>{creator === 'alter' ? 'Alter 创建' : '我创建'}</span>
      <span className={styles.metaDot} aria-hidden="true">
        ·
      </span>
      <span>{formatRelativeTime(updatedAt)}更新</span>
      {revision === undefined ? null : (
        <>
          <span className={styles.metaDot} aria-hidden="true">
            ·
          </span>
          <span>{`revision ${revision}`}</span>
        </>
      )}
      {archived ? (
        <>
          <span className={styles.archivedBadge}>
            <Archive size={11} strokeWidth={1.7} aria-hidden="true" />
            已归档
          </span>
          <button
            type="button"
            className={styles.restoreAction}
            aria-label="恢复文档"
            title="恢复到目录"
            onClick={onRestore}
          >
            恢复
          </button>
        </>
      ) : null}
    </div>
  );
}
