/**
 * Space → ancestor documents/folders → current title breadcrumb.
 *
 * Same tree semantics as the old HTML document view: the space name and note
 * ancestors are clickable, folder ancestors are plain text (folders have no
 * route), and the current document is a non-clickable label showing
 * 「无标题」 when the title is empty.
 *
 * @module @alter-dsh/space/document/shell/DocumentBreadcrumbs
 */
import { ChevronRight } from 'lucide-react';
import type { SpaceNode } from '@alter/protocol';
import { docPath, overviewPath } from '../../../vendor/ui-space/src/space-route';
import { ancestorsOf, displayTitle } from '../../../vendor/ui-space/src/utils/tree';
import styles from './DocumentShell.module.css';

/** Props of {@link DocumentBreadcrumbs}. */
export interface DocumentBreadcrumbsProps {
  spaceId: string;
  /** Display name of the active space. */
  spaceName: string;
  /** All nodes of the active space (used to resolve ancestors). */
  nodes: readonly SpaceNode[];
  /** Current document id. */
  docId: string;
  /** Current (controlled) title, raw. */
  title: string;
  /** Navigate to a route path; supplied by the view from `useSpaceContext()`. */
  onNavigate: (path: string) => void;
}

/** Render the document breadcrumb navigation. */
export function DocumentBreadcrumbs({
  spaceId,
  spaceName,
  nodes,
  docId,
  title,
  onNavigate,
}: DocumentBreadcrumbsProps) {
  const ancestors = ancestorsOf([...nodes], docId);

  return (
    <nav className={styles.crumbs} aria-label="目录层级">
      <button
        type="button"
        className={styles.crumb}
        onClick={() => onNavigate(overviewPath(spaceId))}
      >
        {spaceName}
      </button>
      {ancestors.map((ancestor) => (
        <span key={ancestor.id} className={styles.crumbGroup}>
          <ChevronRight
            size={10}
            strokeWidth={1.8}
            className={styles.crumbChevron}
            aria-hidden="true"
          />
          {ancestor.kind === 'note' ? (
            <button
              type="button"
              className={styles.crumb}
              onClick={() => onNavigate(docPath(spaceId, ancestor.id))}
            >
              {displayTitle(ancestor.title)}
            </button>
          ) : (
            <span className={styles.crumbText} aria-disabled="true">
              {ancestor.title}
            </span>
          )}
        </span>
      ))}
      <ChevronRight
        size={10}
        strokeWidth={1.8}
        className={styles.crumbChevron}
        aria-hidden="true"
      />
      <span className={styles.currentCrumb}>{displayTitle(title)}</span>
    </nav>
  );
}
