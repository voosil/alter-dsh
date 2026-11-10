import { useMemo, useState } from 'react';
import {
  Archive,
  Brush,
  ChevronRight,
  FilePlus2,
  MoveRight,
  Trash2,
} from 'lucide-react';
import type { Thought } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import {
  archivePath,
  docPath,
  overviewPath,
  thoughtsPath,
} from '../space-route';
import { groupByDay } from '../utils/date';
import { ThoughtComposer } from '../components/ThoughtComposer';
import { ThoughtEditModal } from '../components/ThoughtEditModal';
import { ThoughtRow } from '../components/ThoughtRow';
import { DeleteThoughtDialog } from '../components/DeleteThoughtDialog';
import { MoveThoughtDialog } from '../components/MoveThoughtDialog';
import { Menu, type MenuAction } from '@alter/ui-system';
import { EmptyState } from '../components/EmptyState';
import { DirectoryButton } from '../components/DirectoryButton';
import {
  DocumentModelUnavailableError,
  convertThoughtToDocument,
  createDocumentFromHtml,
} from '../thought-conversion';
import styles from './ThoughtsView.module.css';

export function ThoughtsView({ selectedId }: { selectedId?: string }) {
  const {
    service,
    router,
    space,
    spaceId,
    spaces,
    thoughts,
    refresh,
    toast,
    addNodeToState,
  } = useSpaceContext();
  const [menu, setMenu] = useState<{
    thought: Thought;
    anchor: HTMLElement;
  } | null>(null);
  const [moveThought, setMoveThought] = useState<Thought | null>(null);
  const [targetSpaceId, setTargetSpaceId] = useState('');
  const [deleteThought, setDeleteThought] = useState<Thought | null>(null);
  const [openThought, setOpenThought] = useState<Thought | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState('');

  const routedThought = selectedId
    ? thoughts.find((thought) => thought.id === selectedId)
    : undefined;
  const activeModalThought = openThought ?? routedThought ?? null;
  const activeThoughts = useMemo(
    () =>
      thoughts.filter(
        (thought) => !thought.archived && !thought.convertedDocId,
      ),
    [thoughts],
  );
  const archivedCount = useMemo(
    () =>
      thoughts.filter((thought) => thought.archived && !thought.convertedDocId)
        .length,
    [thoughts],
  );
  const groups = useMemo(
    () => groupByDay(activeThoughts, (thought) => thought.createdAt),
    [activeThoughts],
  );

  function closeThoughtModal() {
    setOpenThought(null);
    if (selectedId) router.navigate(thoughtsPath(spaceId));
  }

  async function createThought(html: string) {
    await service.createThought({ spaceId, content: html });
    refresh();
    toast('随想已记下');
  }

  async function convertDraft(html: string) {
    const node = await createDocumentFromHtml(service, { spaceId, html });
    addNodeToState(node);
    refresh();
    toast('已转为文档');
    router.navigate(docPath(spaceId, node.id));
  }

  async function convert(thought: Thought) {
    try {
      const node = await convertThoughtToDocument(service, thought);
      addNodeToState(node);
      setOpenThought(null);
      refresh();
      toast('已转为文档');
      router.navigate(docPath(spaceId, node.id));
    } catch (cause) {
      toast(
        cause instanceof DocumentModelUnavailableError
          ? cause.message
          : '转换失败，请重试',
      );
    }
  }

  async function archive(thought: Thought, archived: boolean) {
    await service.setThoughtArchived(thought.id, archived);
    refresh();
    toast(archived ? '已归档' : '已恢复');
    if (archived && activeModalThought?.id === thought.id) closeThoughtModal();
  }

  async function moveSelected() {
    if (!moveThought || !targetSpaceId) return;
    setMoving(true);
    setMoveError('');
    try {
      await service.moveThought(moveThought.id, targetSpaceId);
      if (activeModalThought?.id === moveThought.id) setOpenThought(null);
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
        onSelect: () => void convert(thought),
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
    <section className={styles.page} aria-label="随想">
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
          <span className={styles.currentCrumb}>随想</span>
        </nav>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.archiveLink}
            title="在归藏中查看已归档随想"
            onClick={() => router.navigate(archivePath(spaceId, 'thoughts'))}
          >
            <Archive size={14} strokeWidth={1.7} aria-hidden="true" />
            归藏{archivedCount ? ` ${archivedCount}` : ''}
          </button>
        </div>
      </header>

      <div className={styles.scroll}>
        <div className={styles.body}>
          <header className={styles.head}>
            <h1 className={styles.title}>随想</h1>
            <span className={styles.count}>
              {activeThoughts.length} 条
              {archivedCount ? ` · ${archivedCount} 条已归档` : ''}
            </span>
          </header>
          <ThoughtComposer
            onSubmit={createThought}
            onConvertToDocument={convertDraft}
          />
          {groups.length ? (
            <div className={styles.timeline}>
              {groups.map((group) => (
                <section key={group.label} className={styles.group}>
                  <div className={styles.groupLabel}>
                    <span>{group.label}</span>
                  </div>
                  {group.items.map((thought) => (
                    <ThoughtRow
                      key={thought.id}
                      thought={thought}
                      onOpen={() => setOpenThought(thought)}
                      onEdit={() => setOpenThought(thought)}
                      onToggleArchive={() =>
                        void archive(thought, !thought.archived)
                      }
                      onMenu={(anchor) => setMenu({ thought, anchor })}
                    />
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Brush />}
              title="还没有随想"
              description="随手记下的片段会按时间出现在这里。按 ⌘E 可以在任何地方快速记录。"
            />
          )}
        </div>
      </div>

      <ThoughtEditModal
        thought={activeModalThought}
        onClose={closeThoughtModal}
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
          if (activeModalThought?.id === thought.id) setOpenThought(null);
        }}
      />
    </section>
  );
}
