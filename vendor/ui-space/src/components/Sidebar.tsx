import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type MouseEvent,
  type Ref,
} from 'react';
import {
  Archive,
  Brush,
  ChevronDown,
  FolderPlus,
  FilePlus2,
  List,
  ListTree,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
  Link2,
  MoreHorizontal,
  Sun,
} from 'lucide-react';
import type { Creator, Space, SpaceNode } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import {
  parseSpaceRoute,
  archivePath,
  overviewPath,
  spacePath,
  thoughtsPath,
  trashPath,
} from '../space-route';
import { Directory } from './Directory';
import { IconButton, Menu, Popover, type MenuAnchor } from '@alter/ui-system';
import { SpaceIconGlyph } from './SpaceIconGlyph';
import styles from './Sidebar.module.css';

function copyText(value: string) {
  return navigator.clipboard.writeText(value);
}

function SpaceMark({ space }: { space: Space }) {
  const icon = space.icon ?? (space.isDefault ? 'inbox' : undefined);
  return (
    <span
      className={styles.spaceInitial}
      aria-hidden="true"
      data-space-icon={icon}
      style={
        space.color
          ? { color: space.color, background: `${space.color}1a` }
          : undefined
      }
    >
      {icon === 'inbox' ? (
        <Sun size={13} strokeWidth={1.8} />
      ) : icon ? (
        <SpaceIconGlyph name={icon} size={13} strokeWidth={1.8} />
      ) : (
        space.name.slice(0, 1)
      )}
    </span>
  );
}

export function Sidebar({
  open,
  onClose,
  onCreateSpace,
  asideRef,
}: {
  open: boolean;
  onClose: () => void;
  onCreateSpace: () => void;
  asideRef?: Ref<HTMLElement>;
}) {
  const {
    service,
    router,
    spaces,
    space,
    spaceId,
    nodes,
    thoughts,
    version,
    refresh,
    toast,
    openSearch,
    addNodeToState,
  } = useSpaceContext();
  const path = useSyncExternalStore(router.subscribe, router.getPath);
  const route = parseSpaceRoute(path);
  const [tab, setTab] = useState<Creator>('me');
  const [viewMode, setViewMode] = useState<'tree' | 'list'>('tree');
  const [showArchived, setShowArchived] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherAnchor, setSwitcherAnchor] = useState<HTMLElement | null>(
    null,
  );
  const [plusAnchor, setPlusAnchor] = useState<HTMLElement | null>(null);
  const [spaceMenu, setSpaceMenu] = useState<{
    anchor: MenuAnchor;
    space: Space;
  } | null>(null);
  const [spaceDrag, setSpaceDrag] = useState<string | null>(null);
  const [spaceDrop, setSpaceDrop] = useState<{
    id: string;
    position: 'before' | 'after';
  } | null>(null);
  const [deletedCount, setDeletedCount] = useState(0);
  const [folderToRename, setFolderToRename] = useState<SpaceNode | null>(null);
  const lastDocRef = useRef<string | undefined>(undefined);

  const unread = nodes.some((node) => node.creator === 'alter' && node.unread);
  const archivedCount =
    nodes.filter((node) => node.archived).length +
    thoughts.filter((thought) => thought.archived).length;

  useEffect(() => {
    let active = true;
    void service.listDeleted(spaceId).then((result) => {
      if (active) setDeletedCount(result.nodes.length + result.thoughts.length);
    });
    return () => {
      active = false;
    };
  }, [service, spaceId, version]);

  useEffect(() => {
    if (route.view !== 'doc' || !route.id) {
      lastDocRef.current = undefined;
      return;
    }
    if (lastDocRef.current === route.id) return;
    lastDocRef.current = route.id;
    const node = nodes.find((item) => item.id === route.id);
    if (!node) return;
    const timer = window.setTimeout(() => setTab(node.creator), 0);
    return () => window.clearTimeout(timer);
  }, [route.id, route.view, nodes]);

  async function createDoc(parentId: string | null) {
    setPlusAnchor(null);
    const node = await service.createNode({
      spaceId,
      parentId,
      kind: 'note',
    });
    addNodeToState(node);
    setTab('me');
    refresh();
    router.navigate(`#/space/${spaceId}/doc/${node.id}`);
  }

  async function createFolder() {
    setPlusAnchor(null);
    const folder = await service.createNode({
      spaceId,
      kind: 'folder',
      parentId: null,
    });
    setTab('me');
    setViewMode('tree');
    refresh();
    setFolderToRename(folder);
  }

  async function copySpaceLink(target: Space) {
    try {
      await copyText(
        `${location.origin}${location.pathname}${spacePath(target.id)}`,
      );
      toast('空间链接已复制');
    } catch {
      toast('复制失败，请检查浏览器权限');
    }
  }

  /**
   * 空间操作菜单是空间下拉的子菜单：横向从下拉浮层右缘向右展开，纵向对齐
   * 触发行。若直接以触发按钮为锚点，菜单会落在浮层内部盖住空间列表。
   */
  function openSpaceMenu(event: MouseEvent<HTMLButtonElement>, target: Space) {
    const trigger = event.currentTarget;
    const panel = trigger.closest<HTMLElement>('[role="dialog"]');
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    setSpaceMenu({
      anchor: panelRect
        ? {
            top: triggerRect.top,
            left: panelRect.right,
            width: 0,
            height: triggerRect.height,
          }
        : trigger,
      space: target,
    });
  }

  function closeSwitcher() {
    setSpaceMenu(null);
    setSwitcherOpen(false);
  }

  function selectSpace(id: string) {
    closeSwitcher();
    setFolderToRename(null);
    onClose();
    router.navigate(spacePath(id));
  }

  function handleSpaceDragStart(
    event: DragEvent<HTMLDivElement>,
    target: Space,
  ) {
    setSpaceDrag(target.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', target.id);
  }

  function handleSpaceDragOver(
    event: DragEvent<HTMLDivElement>,
    target: Space,
  ) {
    if (!spaceDrag || spaceDrag === target.id) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setSpaceDrop({
      id: target.id,
      position: event.clientY - rect.top < rect.height / 2 ? 'before' : 'after',
    });
  }

  async function handleSpaceDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const dragged = spaceDrag;
    const drop = spaceDrop;
    setSpaceDrag(null);
    setSpaceDrop(null);
    if (!dragged || !drop) return;
    const ids = spaces.map((item) => item.id).filter((id) => id !== dragged);
    const index = ids.indexOf(drop.id);
    if (index < 0) return;
    ids.splice(drop.position === 'before' ? index : index + 1, 0, dragged);
    await service.reorderSpaces(ids);
    refresh();
  }

  const selectedPath = route.view === 'doc' && route.id ? route.id : undefined;

  return (
    <aside
      ref={asideRef}
      className={styles.sidebar}
      data-open={open || undefined}
      aria-label="空间目录"
    >
      <header className={styles.head}>
        <div className={styles.spaceLine}>
          <button
            type="button"
            className={styles.spaceSwitch}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            onClick={(event) => {
              setSwitcherAnchor(event.currentTarget);
              setSwitcherOpen((value) => !value);
            }}
          >
            <SpaceMark space={space} />
            <span className={styles.spaceName}>{space.name}</span>
            <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <div className={styles.headActions}>
            <IconButton
              label="搜索空间"
              tooltip="搜索空间 · ⌘K"
              icon={<Search />}
              className={styles.searchButton}
              onClick={openSearch}
            />
            <IconButton
              label="关闭目录"
              icon={<X />}
              className={styles.closeButton}
              onClick={onClose}
            />
          </div>
        </div>
        <div className={styles.tabs} role="tablist" aria-label="文档来源">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'me'}
            className={styles.tab}
            onClick={() => setTab('me')}
          >
            我创建的
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'alter'}
            className={styles.tab}
            onClick={() => setTab('alter')}
          >
            Alter 创建的
            {unread ? (
              <>
                <span className={styles.unreadDot} aria-hidden="true" />
                <span className={styles.srOnly}>有未查看的文档</span>
              </>
            ) : null}
          </button>
        </div>
        <div className={styles.controls}>
          <div className={styles.controlGroup}>
            <div
              className={styles.viewSwitch}
              role="group"
              aria-label="目录视图"
            >
              <IconButton
                label="树形视图"
                size="sm"
                className={styles.viewButton}
                aria-pressed={viewMode === 'tree'}
                icon={<ListTree size={15} strokeWidth={1.6} />}
                onClick={() => setViewMode('tree')}
              />
              <IconButton
                label="平铺视图"
                size="sm"
                className={styles.viewButton}
                aria-pressed={viewMode === 'list'}
                icon={<List size={15} strokeWidth={1.6} />}
                onClick={() => setViewMode('list')}
              />
            </div>
            <IconButton
              label={showArchived ? '隐藏归档文档' : '显示归档文档'}
              icon={<Archive />}
              size="sm"
              className={styles.archiveToggle}
              aria-pressed={showArchived}
              onClick={() => setShowArchived((value) => !value)}
            />
          </div>
          <IconButton
            label="新建"
            size="sm"
            className={styles.createButton}
            aria-haspopup="menu"
            aria-expanded={Boolean(plusAnchor)}
            icon={<Plus size={16} strokeWidth={1.7} />}
            onClick={(event) => {
              const anchor = event.currentTarget;
              setPlusAnchor((current) => (current ? null : anchor));
            }}
          />
          <Menu
            anchor={plusAnchor}
            open={Boolean(plusAnchor)}
            onClose={() => setPlusAnchor(null)}
            align="end"
            width={176}
            actions={[
              {
                id: 'note',
                label: '新建文档',
                icon: <FilePlus2 />,
                onSelect: () => void createDoc(null),
              },
              {
                id: 'folder',
                label: '新建文件夹',
                icon: <FolderPlus />,
                disabled: tab !== 'me',
                onSelect: () => void createFolder(),
              },
            ]}
          />
        </div>
      </header>

      <div className={styles.directoryScroll}>
        <Directory
          key={spaceId}
          creator={tab}
          viewMode={viewMode}
          showArchived={showArchived}
          selectedId={selectedPath}
          onCreateDoc={createDoc}
          renameFolder={folderToRename}
          onRenameHandled={() => setFolderToRename(null)}
        />
      </div>

      <nav className={styles.footer} aria-label="空间导航">
        <div className={styles.footerButtons}>
          <button
            type="button"
            className={styles.footerIcon}
            data-active={route.view === 'thoughts' || undefined}
            aria-current={route.view === 'thoughts' ? 'page' : undefined}
            aria-label="随想"
            onClick={() => {
              onClose();
              router.navigate(thoughtsPath(spaceId));
            }}
          >
            <Brush size={18} strokeWidth={1.6} aria-hidden="true" />
            <span className={styles.footerTooltip} role="tooltip">
              随想 · ⌘E
            </span>
          </button>
          <button
            type="button"
            className={styles.footerIcon}
            data-active={route.view === 'archive' || undefined}
            aria-current={route.view === 'archive' ? 'page' : undefined}
            aria-label={`归藏${archivedCount ? ` ${archivedCount}` : ''}`}
            onClick={() => {
              onClose();
              router.navigate(archivePath(spaceId));
            }}
          >
            <Archive size={18} strokeWidth={1.6} aria-hidden="true" />
            <span className={styles.footerTooltip} role="tooltip">
              归藏{archivedCount ? ` · ${archivedCount}` : ''}
            </span>
          </button>
          <button
            type="button"
            className={styles.footerIcon}
            data-active={route.view === 'trash' || undefined}
            aria-current={route.view === 'trash' ? 'page' : undefined}
            aria-label={`回收站${deletedCount ? ` ${deletedCount}` : ''}`}
            onClick={() => {
              onClose();
              router.navigate(trashPath(spaceId));
            }}
          >
            <Trash2 size={18} strokeWidth={1.6} aria-hidden="true" />
            <span className={styles.footerTooltip} role="tooltip">
              回收站{deletedCount ? ` · ${deletedCount}` : ''}
            </span>
          </button>
        </div>
      </nav>

      <Popover
        anchor={switcherAnchor}
        open={switcherOpen}
        onClose={closeSwitcher}
        align="start"
        width={244}
        className={styles.spaceSwitcherPanel}
        role="dialog"
        ariaLabel="选择空间"
      >
        <div className={styles.switcher}>
          <div className={styles.spaceList}>
            {spaces.map((item) => (
              <div
                key={item.id}
                className={styles.spaceRow}
                data-current={item.id === spaceId || undefined}
                data-dragging={spaceDrag === item.id || undefined}
                data-drop={
                  spaceDrop?.id === item.id ? spaceDrop.position : undefined
                }
                draggable
                onDragStart={(event) => handleSpaceDragStart(event, item)}
                onDragOver={(event) => handleSpaceDragOver(event, item)}
                onDrop={(event) => void handleSpaceDrop(event)}
                onDragEnd={() => {
                  setSpaceDrag(null);
                  setSpaceDrop(null);
                }}
              >
                <button
                  type="button"
                  className={styles.spaceMain}
                  aria-label={item.name}
                  onClick={() => selectSpace(item.id)}
                >
                  <SpaceMark space={item} />
                  <span className={styles.spaceText}>
                    <span className={styles.spaceRowName}>{item.name}</span>
                  </span>
                </button>
                {/* 空间详情是高频入口：hover 一级操作区直接给出图标，不必
                    再展开「空间操作」子菜单。 */}
                <IconButton
                  label={`${item.name} 的空间详情`}
                  tooltip="空间详情"
                  size="sm"
                  icon={<SlidersHorizontal />}
                  className={styles.spaceDetail}
                  tooltipPlacement="left"
                  onClick={() => {
                    closeSwitcher();
                    router.navigate(overviewPath(item.id));
                  }}
                />
                <IconButton
                  label="空间操作"
                  size="sm"
                  icon={<MoreHorizontal />}
                  className={styles.spaceAction}
                  tooltipPlacement="left"
                  aria-expanded={spaceMenu?.space.id === item.id}
                  onClick={(event) => openSpaceMenu(event, item)}
                />
              </div>
            ))}
          </div>
          <div className={styles.switcherFoot}>
            <button
              type="button"
              onClick={() => {
                closeSwitcher();
                onCreateSpace();
              }}
            >
              <Plus size={15} strokeWidth={1.6} aria-hidden="true" />
              新建空间
            </button>
          </div>
        </div>
        {/* 空间操作菜单必须嵌在下拉层内：作为兄弟节点时，菜单获得焦点会
            被下拉层判定为“焦点移出”，下拉列表随即关闭。 */}
        <Menu
          anchor={spaceMenu?.anchor ?? null}
          open={Boolean(spaceMenu)}
          onClose={() => setSpaceMenu(null)}
          side="right"
          align="start"
          width={190}
          heading={spaceMenu?.space.name}
          actions={[
            {
              id: 'copy',
              label: '复制空间链接',
              icon: <Link2 />,
              onSelect: () => {
                if (spaceMenu) void copySpaceLink(spaceMenu.space);
              },
            },
          ]}
        />
      </Popover>
    </aside>
  );
}
