import { useMemo, useState } from 'react';
import {
  ArchiveRestore,
  ChevronRight,
  FilePlus2,
  FileText,
  List,
  ListTree,
  MoveRight,
  Trash2,
} from 'lucide-react';
import type { SpaceNode, Thought } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { archivePath, docPath, overviewPath } from '../space-route';
import { formatShortDate } from '../utils/date';
import { displayTitle } from '../utils/tree';
import { DirectoryButton } from '../components/DirectoryButton';

import { ThoughtRow } from '../components/ThoughtRow';
import { ArchiveDocMenu } from '../components/ArchiveDocMenu';
import { ThoughtEditModal } from '../components/ThoughtEditModal';
import { MoveThoughtDialog } from '../components/MoveThoughtDialog';
import { DeleteThoughtDialog } from '../components/DeleteThoughtDialog';
import { IconButton, Menu, type MenuAction } from '@alter/ui-system';
import styles from './CollectionView.module.css';

export function ArchiveView({
  initialTab = 'docs',
}: {
  initialTab?: 'docs' | 'thoughts';
}) {
  const {
    service,
    router,
    space,
    spaceId,
    spaces,
    nodes,
    thoughts,
    refresh,
    toast,
    addNodeToState,
  } = useSpaceContext();
  const [tab, setTab] = useState<'docs' | 'thoughts'>(initialTab);
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openThought, setOpenThought] = useState<Thought | null>(null);
  const [menu, setMenu] = useState<{
    thought: Thought;
    anchor: HTMLElement;
  } | null>(null);
  const [moveThought, setMoveThought] = useState<Thought | null>(null);
  const [targetSpaceId, setTargetSpaceId] = useState('');
  const [deleteThought, setDeleteThought] = useState<Thought | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState('');

  const docs = nodes
    .filter((node) => node.archived)
    .sort(
      (a, b) =>
        Date.parse(b.archivedAt ?? b.updatedAt) -
        Date.parse(a.archivedAt ?? a.updatedAt),
    );
  const archivedThoughts = thoughts
    .filter((thought) => thought.archived && !thought.convertedDocId)
    .sort(
      (a, b) =>
        Date.parse(b.archivedAt ?? b.updatedAt) -
        Date.parse(a.archivedAt ?? a.updatedAt),
    );

  const docRows = useMemo(() => {
    if (viewMode === 'list') {
      return docs.map((node) => ({
        node,
        depth: 0,
        hasChildren: false,
      }));
    }
    const archivedIds = new Set(docs.map((node) => node.id));
    const children = new Map<string | null, SpaceNode[]>();
    for (const node of docs) {
      const parentId =
        node.parentId && archivedIds.has(node.parentId) ? node.parentId : null;
      const siblings = children.get(parentId) ?? [];
      siblings.push(node);
      children.set(parentId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort(
        (a, b) =>
          Date.parse(b.archivedAt ?? b.updatedAt) -
          Date.parse(a.archivedAt ?? a.updatedAt),
      );
    }
    const rows: { node: SpaceNode; depth: number; hasChildren: boolean }[] = [];
    function collect(parentId: string | null, depth: number) {
      for (const node of children.get(parentId) ?? []) {
        const nested = children.get(node.id) ?? [];
        rows.push({ node, depth, hasChildren: nested.length > 0 });
        if (nested.length && !collapsed.has(node.id)) {
          collect(node.id, depth + 1);
        }
      }
    }
    collect(null, 0);
    return rows;
  }, [collapsed, docs, viewMode]);

  function toggleCollapsed(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectTab(next: 'docs' | 'thoughts') {
    setTab(next);
    router.navigate(archivePath(spaceId, next));
  }

  async function unarchiveDoc(id: string) {
    await service.setArchived(id, false);
    refresh();
    toast('已恢复');
  }

  async function unarchiveThought(thought: Thought) {
    await service.setThoughtArchived(thought.id, false);
    setOpenThought(null);
    refresh();
    toast('已恢复');
  }

  async function convertThought(thought: Thought) {
    const result = await service.convertThought(thought.id);
    addNodeToState(result.node);
    setOpenThought(null);
    refresh();
    toast('已转为文档');
    router.navigate(docPath(spaceId, result.node.id));
  }

  async function moveSelected() {
    if (!moveThought || !targetSpaceId) return;
    setMoving(true);
    setMoveError('');
    try {
      await service.moveThought(moveThought.id, targetSpaceId);
      if (openThought?.id === moveThought.id) setOpenThought(null);
      setMoveThought(null);
      refresh();
      toast('已移动');
    } catch (cause) {
      setMoveError(cause instanceof Error ? cause.message : '移动失败，请重试');
    } finally {
      setMoving(false);
    }
  }

  function actionsFor(thought: Thought): MenuAction[] {
    return [
      {
        id: 'convert',
        label: '转为正式文档',
        icon: <FilePlus2 />,
        onSelect: () => void convertThought(thought),
      },
      {
        id: 'move',
        label: '移动到…',
        icon: <MoveRight />,
        onSelect: () => {
          setMoveThought(thought);
          setTargetSpaceId(
            spaces.find((item) => item.id !== spaceId)?.id ?? '',
          );
          setMoveError('');
        },
      },
      {
        id: 'delete',
        label: '删除',
        icon: <Trash2 />,
        danger: true,
        separatorBefore: true,
        onSelect: () => setDeleteThought(thought),
      },
    ];
  }

  const menuActions = menu ? actionsFor(menu.thought) : [];

  return (
    <section className={styles.page} aria-labelledby="archive-page-title">
      <header className={styles.toolbar}>
        <DirectoryButton />
        <nav className={styles.crumbs} aria-label="目录层级">
          <button
            type="button"
            className={styles.crumb}
            onClick={() => router.navigate(overviewPath(spaceId))}
          >
            {space.name}
          </button>
          <ChevronRight
            size={10}
            strokeWidth={1.8}
            className={styles.crumbChevron}
            aria-hidden="true"
          />
          <span className={styles.currentCrumb}>归藏</span>
        </nav>
      </header>

      <div className={styles.scroll}>
        <div className={styles.body}>
          <header className={styles.hero}>
            <h1 id="archive-page-title" className={styles.pageTitle}>
              归藏
            </h1>
          </header>
          <div className={styles.tabsRow}>
            <div className={styles.tabs} role="tablist" aria-label="归藏内容">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'docs'}
                className={styles.tab}
                onClick={() => selectTab('docs')}
              >
                文档
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'thoughts'}
                className={styles.tab}
                onClick={() => selectTab('thoughts')}
              >
                随想
              </button>
            </div>
            {tab === 'docs' ? (
              <div
                className={styles.viewSwitch}
                role="group"
                aria-label="归藏视图"
              >
                <IconButton
                  label="平铺视图"
                  size="sm"
                  className={styles.viewButton}
                  aria-pressed={viewMode === 'list'}
                  icon={<List size={15} strokeWidth={1.6} />}
                  onClick={() => setViewMode('list')}
                />
                <IconButton
                  label="树形视图"
                  size="sm"
                  className={styles.viewButton}
                  aria-pressed={viewMode === 'tree'}
                  icon={<ListTree size={15} strokeWidth={1.6} />}
                  onClick={() => setViewMode('tree')}
                />
              </div>
            ) : null}
          </div>

          {tab === 'docs' ? (
            docs.length ? (
              <div className={styles.list}>
                {docRows.map(({ node, depth, hasChildren }) => (
                  <div
                    key={node.id}
                    className={styles.row}
                    style={
                      viewMode === 'tree'
                        ? { paddingLeft: 2 + depth * 16 }
                        : undefined
                    }
                  >
                    {viewMode === 'tree' ? (
                      hasChildren ? (
                        <button
                          type="button"
                          className={styles.disclosure}
                          aria-label={collapsed.has(node.id) ? '展开' : '收起'}
                          aria-expanded={!collapsed.has(node.id)}
                          onClick={() => toggleCollapsed(node.id)}
                        >
                          <ChevronRight
                            size={12}
                            strokeWidth={1.8}
                            className={styles.disclosureChevron}
                            data-collapsed={collapsed.has(node.id) || undefined}
                            aria-hidden="true"
                          />
                        </button>
                      ) : (
                        <span className={styles.disclosureSlot} />
                      )
                    ) : null}
                    <span className={styles.rowIcon} aria-hidden="true">
                      <FileText size={15} strokeWidth={1.5} />
                    </span>
                    <button
                      type="button"
                      className={styles.rowMain}
                      onClick={() => router.navigate(docPath(spaceId, node.id))}
                    >
                      <span className={styles.title}>
                        {displayTitle(node.title)}
                      </span>
                      <span className={styles.meta}>
                        {node.archivedBy === 'agent' ? 'Alter' : '我'}归档
                        {node.archivedAt
                          ? ` · ${formatShortDate(node.archivedAt)}`
                          : ''}
                      </span>
                    </button>
                    <ArchiveDocMenu
                      node={node}
                      triggerClassName={styles.restoreAction}
                      onRestored={refresh}
                      onDeleted={refresh}
                    />
                    <IconButton
                      label="恢复"
                      size="sm"
                      tooltipPlacement="top"
                      className={styles.restoreAction}
                      icon={<ArchiveRestore />}
                      onClick={() => void unarchiveDoc(node.id)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.emptyNote}>归藏里还没有归档的文档。</p>
            )
          ) : archivedThoughts.length ? (
            <div className={styles.thoughtList}>
              {archivedThoughts.map((thought) => (
                <ThoughtRow
                  key={thought.id}
                  thought={thought}
                  onOpen={() => setOpenThought(thought)}
                  onEdit={() => setOpenThought(thought)}
                  onToggleArchive={() => void unarchiveThought(thought)}
                  onMenu={(anchor) => setMenu({ thought, anchor })}
                />
              ))}
            </div>
          ) : (
            <p className={styles.emptyNote}>归藏里还没有归档的随想。</p>
          )}
        </div>
      </div>

      <ThoughtEditModal
        thought={openThought}
        onClose={() => setOpenThought(null)}
      />

      <Menu
        anchor={menu?.anchor ?? null}
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
        align="end"
        width={196}
        actions={menuActions}
      />
      <MoveThoughtDialog
        thought={moveThought}
        spaces={spaces.filter((item) => item.id !== spaceId)}
        targetSpaceId={targetSpaceId}
        onTarget={setTargetSpaceId}
        onClose={() => setMoveThought(null)}
        onMove={() => void moveSelected()}
        moving={moving}
        error={moveError}
      />
      <DeleteThoughtDialog
        thought={deleteThought}
        onClose={() => setDeleteThought(null)}
        onDeleted={(thought) => {
          if (openThought?.id === thought.id) setOpenThought(null);
        }}
      />
    </section>
  );
}
