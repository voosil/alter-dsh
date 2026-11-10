import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderInput,
  Link2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Creator, SpaceNode } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import {
  childrenMap,
  descendantIds,
  displayTitle,
  flattenTree,
} from '../utils/tree';
import { docPath } from '../space-route';
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  type MenuAction,
} from '@alter/ui-system';
import { MoveDialog } from './MoveDialog';
import styles from './Directory.module.css';

type DropZone = 'before' | 'after' | 'inside';
type RowSection = 'pinned' | 'tree';

function sortByActivity(a: SpaceNode, b: SpaceNode) {
  return (
    b.activity - a.activity || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
}

function FolderNameInput({
  node,
  onDone,
}: {
  node: SpaceNode;
  onDone: () => void;
}) {
  const { service, refresh, toast } = useSpaceContext();
  const [name, setName] = useState(node.title);
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, []);

  async function commit() {
    if (settledRef.current) return;
    const title = name.trim();
    if (!title) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    if (title === node.title) {
      settledRef.current = true;
      onDone();
      return;
    }
    settledRef.current = true;
    setSaving(true);
    try {
      await service.saveNode(node.id, { title });
      refresh();
      toast('已重命名');
      onDone();
    } catch (cause) {
      settledRef.current = false;
      setSaving(false);
      setInvalid(true);
      toast(cause instanceof Error ? cause.message : '重命名失败，请重试');
      inputRef.current?.focus();
    }
  }

  function cancel() {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // An IME uses Enter/Escape to confirm or discard candidates while composing.
    // Committing here would save the raw pinyin instead of the chosen text.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }

  return (
    <input
      ref={inputRef}
      className={styles.renameInput}
      value={name}
      aria-label="文件夹名称"
      aria-invalid={invalid || undefined}
      readOnly={saving}
      onChange={(event) => {
        setName(event.target.value);
        setInvalid(false);
      }}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!name.trim()) cancel();
        else void commit();
      }}
    />
  );
}

function RowMarker({
  label,
  icon,
  hoverIcon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  hoverIcon: ReactNode;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({
    top: 0,
    left: 0,
    visibility: 'hidden',
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const open = hovered || focused;

  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !tooltipRef.current) return;
    const anchor = buttonRef.current.getBoundingClientRect();
    const tooltip = tooltipRef.current.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    let top = anchor.top - tooltip.height - gap;
    if (top < margin) top = anchor.bottom + gap;
    let left = anchor.right - tooltip.width;
    left = Math.min(
      Math.max(margin, left),
      window.innerWidth - tooltip.width - margin,
    );
    setStyle({ top, left, visibility: 'visible' });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function hide() {
      setHovered(false);
      setFocused(false);
    }
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('dragstart', hide, true);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('dragstart', hide, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.marker}
        aria-label={label}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        {icon}
        {hoverIcon}
      </button>
      {open
        ? createPortal(
            <span
              ref={tooltipRef}
              className={styles.markerTooltip}
              role="tooltip"
              style={style}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

function flattenFrom(
  nodes: SpaceNode[],
  rootId: string,
  expanded: Set<string>,
) {
  const map = childrenMap(nodes);
  const result: { node: SpaceNode; depth: number }[] = [];
  const root = nodes.find((node) => node.id === rootId);
  if (!root) return result;
  function walk(node: SpaceNode, depth: number) {
    result.push({ node, depth });
    if (!expanded.has(node.id)) return;
    for (const child of map.get(node.id) ?? []) walk(child, depth + 1);
  }
  walk(root, 0);
  return result;
}

export function Directory({
  creator,
  viewMode,
  showArchived,
  selectedId,
  onCreateDoc,
  renameFolder,
  onRenameHandled,
}: {
  creator: Creator;
  viewMode: 'tree' | 'list';
  showArchived: boolean;
  selectedId?: string;
  onCreateDoc: (parentId: string | null) => void | Promise<void>;
  renameFolder?: SpaceNode | null;
  onRenameHandled?: () => void;
}) {
  const { service, router, spaceId, nodes, refresh, toast, closeDirectory } =
    useSpaceContext();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pinnedCollapsed, setPinnedCollapsed] = useState<Set<string>>(
    new Set(),
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; zone: DropZone } | null>(null);
  /** Drag state reaches drop before React commits; the drop handler must not
   * miss a move just because a refresh re-rendered between dragover and drop. */
  const dropRef = useRef<{ id: string; zone: DropZone } | null>(null);
  const [menu, setMenu] = useState<{
    node: SpaceNode;
    anchor: HTMLElement;
  } | null>(null);
  const [moveNode, setMoveNode] = useState<SpaceNode | null>(null);
  const [deleteNode, setDeleteNode] = useState<SpaceNode | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SpaceNode | null>(null);

  const creatorNodes = useMemo(
    () => nodes.filter((node) => node.creator === creator),
    [nodes, creator],
  );
  const visibleNodes = useMemo(
    () =>
      showArchived
        ? creatorNodes
        : creatorNodes.filter((node) => !node.archived),
    [creatorNodes, showArchived],
  );

  const map = useMemo(() => childrenMap(nodes), [nodes]);
  const expanded = useMemo(
    () =>
      new Set(
        nodes.filter((node) => !collapsed.has(node.id)).map((node) => node.id),
      ),
    [nodes, collapsed],
  );

  const pinnedExpanded = useMemo(
    () =>
      new Set(
        nodes
          .filter((node) => !pinnedCollapsed.has(node.id))
          .map((node) => node.id),
      ),
    [nodes, pinnedCollapsed],
  );

  const pinnedDocs = useMemo(
    () =>
      visibleNodes
        .filter((node) => node.kind === 'note' && node.pinned && !node.archived)
        .sort((a, b) => a.order - b.order),
    [visibleNodes],
  );

  const pinnedRows = useMemo(
    () =>
      pinnedDocs.map((doc) => ({
        doc,
        rows:
          viewMode === 'tree'
            ? flattenFrom(visibleNodes, doc.id, pinnedExpanded)
            : [{ node: doc, depth: 0 }],
      })),
    [pinnedDocs, visibleNodes, pinnedExpanded, viewMode],
  );

  const treeRows = useMemo(
    () => flattenTree(visibleNodes, expanded),
    [visibleNodes, expanded],
  );

  const flatNotes = useMemo(
    () =>
      visibleNodes
        .filter((node) => node.kind === 'note' && !node.pinned)
        .sort(sortByActivity),
    [visibleNodes],
  );

  function toggleSet(
    setter: (updater: (current: Set<string>) => Set<string>) => void,
    id: string,
  ) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSection(section: RowSection, id: string) {
    if (section === 'pinned') toggleSet(setPinnedCollapsed, id);
    else toggleSet(setCollapsed, id);
  }

  function expandSection(section: RowSection, id: string) {
    const setter = section === 'pinned' ? setPinnedCollapsed : setCollapsed;
    setter((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function openNode(node: SpaceNode, section: RowSection = 'tree') {
    if (node.kind === 'folder') {
      toggleSection(section, node.id);
      return;
    }
    closeDirectory();
    router.navigate(docPath(spaceId, node.id));
  }

  async function copyLink(node: SpaceNode) {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}${location.pathname}${docPath(spaceId, node.id)}`,
      );
      toast('链接已复制');
    } catch {
      toast('复制失败，请检查浏览器权限');
    }
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, node: SpaceNode) {
    setDragId(node.id);
    event.dataTransfer.effectAllowed = 'copyMove';
    if (node.kind === 'note')
      event.dataTransfer.setData('application/x-alter-document', node.id);
    event.dataTransfer.setData('text/plain', node.id);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, node: SpaceNode) {
    if (!dragId || dragId === node.id) return;
    const dragged = nodes.find((item) => item.id === dragId);
    if (!dragged) return;
    if (descendantIds(nodes, dragId).has(node.id)) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    let zone: DropZone;
    if (dragged.kind === 'folder') zone = ratio < 0.5 ? 'before' : 'after';
    else if (ratio < 0.28) zone = 'before';
    else if (ratio > 0.72) zone = 'after';
    else zone = 'inside';
    event.dataTransfer.dropEffect = 'move';
    dropRef.current = { id: node.id, zone };
    setDrop({ id: node.id, zone });
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>, node: SpaceNode) {
    event.preventDefault();
    const dragged = nodes.find((item) => item.id === dragId);
    const pending = dropRef.current ?? drop;
    const zone = pending?.id === node.id ? pending.zone : undefined;
    dropRef.current = null;
    setDragId(null);
    setDrop(null);
    if (!dragged || !zone || dragged.id === node.id) return;
    try {
      if (zone === 'inside') {
        if (dragged.kind === 'folder') return;
        const siblings = nodes.filter(
          (item) => item.parentId === node.id && item.id !== dragged.id,
        );
        const order = siblings.length
          ? Math.min(...siblings.map((item) => item.order)) - 1
          : 0;
        await service.moveNode(dragged.id, {
          spaceId,
          parentId: node.id,
          order,
        });
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete(node.id);
          return next;
        });
      } else {
        await service.moveNode(dragged.id, {
          spaceId,
          parentId: node.parentId,
          order: node.order + (zone === 'before' ? -0.5 : 0.5),
        });
      }
      refresh();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '移动失败，请重试');
    }
  }

  async function deleteSelected() {
    if (!deleteNode) return;
    setDeleting(true);
    try {
      await service.deleteNode(deleteNode.id);
      setDeleteNode(null);
      refresh();
      if (selectedId === deleteNode.id)
        router.navigate(`#/space/${spaceId}/doc`);
      toast('已移到回收站');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '删除失败，请重试');
    } finally {
      setDeleting(false);
    }
  }

  function actionsFor(node: SpaceNode): MenuAction[] {
    const actions: MenuAction[] = [];
    if (node.kind === 'folder') {
      actions.push({
        id: 'rename',
        label: '重命名',
        icon: <Pencil />,
        onSelect: () => setRenameTarget(node),
      });
      actions.push({
        id: 'move',
        label: '全部移动到…',
        icon: <FolderInput />,
        onSelect: () => setMoveNode(node),
      });
      actions.push({
        id: 'delete',
        label: '删除',
        icon: <Trash2 />,
        danger: true,
        separatorBefore: true,
        onSelect: () => setDeleteNode(node),
      });
      return actions;
    }
    if (!node.archived) {
      actions.push({
        id: 'pin',
        label: node.pinned ? '取消置顶' : '置顶',
        icon: node.pinned ? <PinOff /> : <Pin />,
        onSelect: () => {
          void service.setPinned(node.id, !node.pinned).then(() => refresh());
        },
      });
    }
    // 归档已提升为行内一级操作（hover 直接点归档图标），菜单里只保留
    // 归档文档的「取消归档」，避免同一动作出现两个入口。
    if (node.archived) {
      actions.push({
        id: 'unarchive',
        label: '取消归档',
        icon: <ArchiveRestore />,
        onSelect: () => {
          void service.setArchived(node.id, false).then(() => {
            refresh();
            toast('已取消归档');
          });
        },
      });
    }
    actions.push({
      id: 'copy',
      label: '复制链接',
      icon: <Link2 />,
      onSelect: () => void copyLink(node),
    });
    actions.push({
      id: 'move',
      label: '移动到…',
      icon: <FolderInput />,
      onSelect: () => setMoveNode(node),
    });
    actions.push({
      id: 'delete',
      label: '删除',
      icon: <Trash2 />,
      danger: true,
      separatorBefore: true,
      onSelect: () => setDeleteNode(node),
    });
    return actions;
  }

  function renderRow(
    node: SpaceNode,
    depth: number,
    section: RowSection = 'tree',
  ) {
    const hasChildren = Boolean(map.get(node.id)?.length);
    const isCollapsed = (
      section === 'pinned' ? pinnedCollapsed : collapsed
    ).has(node.id);
    const isActive = selectedId === node.id;
    const dropZone = drop?.id === node.id ? drop.zone : undefined;
    const canCreate =
      node.kind === 'folder' || (node.kind === 'note' && !node.archived);
    const canArchive = node.kind === 'note' && !node.archived;
    const editingFolder =
      node.kind === 'folder' &&
      (renameFolder?.id === node.id || renameTarget?.id === node.id);
    const showDisclosure = viewMode === 'tree' && hasChildren && !editingFolder;
    const nodeIcon =
      node.kind === 'folder' ? (
        <Folder size={15} strokeWidth={1.5} />
      ) : hasChildren ? (
        <FileText size={15} strokeWidth={1.5} />
      ) : (
        <File size={15} strokeWidth={1.5} />
      );
    return (
      <div
        key={node.id}
        className={styles.row}
        style={{ paddingLeft: depth * 13 }}
        data-active={isActive || undefined}
        data-actions={canCreate ? (canArchive ? 'three' : 'two') : 'one'}
        data-archived={node.archived || undefined}
        data-dragging={dragId === node.id || undefined}
        data-drop={dropZone}
        draggable={!editingFolder}
        onDragStart={(event) => handleDragStart(event, node)}
        onDragOver={(event) => handleDragOver(event, node)}
        onDrop={(event) => void handleDrop(event, node)}
        onDragEnd={() => {
          setDragId(null);
          setDrop(null);
        }}
      >
        {showDisclosure ? (
          <button
            type="button"
            className={styles.disclosure}
            aria-label={isCollapsed ? '展开' : '收起'}
            aria-expanded={!isCollapsed}
            onClick={(event) => {
              event.stopPropagation();
              toggleSection(section, node.id);
            }}
          >
            <span className={styles.disclosureSlot} aria-hidden="true">
              <span className={styles.disclosureIcon}>{nodeIcon}</span>
              <ChevronRight
                className={styles.disclosureChevron}
                size={12}
                strokeWidth={1.8}
                data-collapsed={isCollapsed || undefined}
              />
            </span>
          </button>
        ) : null}
        {editingFolder ? (
          <span className={`${styles.main} ${styles.mainEditing}`}>
            <span className={styles.icon} aria-hidden="true">
              <Folder size={15} strokeWidth={1.5} />
            </span>
            <FolderNameInput
              node={node}
              onDone={() => {
                setRenameTarget(null);
                onRenameHandled?.();
              }}
            />
          </span>
        ) : (
          <button
            type="button"
            className={styles.main}
            onClick={() => openNode(node, section)}
            title={displayTitle(node.title)}
          >
            {showDisclosure ? null : (
              <span className={styles.icon} aria-hidden="true">
                {nodeIcon}
              </span>
            )}
            <span className={styles.title}>{displayTitle(node.title)}</span>
            {node.unread ? (
              <span className={styles.unreadDot} aria-label="未查看" />
            ) : null}
            {node.pinned ? <span className={styles.srOnly}>已置顶</span> : null}
            {node.archived ? (
              <span className={styles.srOnly}>已归档</span>
            ) : null}
          </button>
        )}
        {editingFolder ? null : (
          <span className={styles.rowActions}>
            {canCreate ? (
              <IconButton
                label={`在「${displayTitle(node.title)}」下新建文档`}
                tooltip="新建子文档"
                size="sm"
                tooltipPlacement="top"
                className={styles.quickAdd}
                icon={<Plus size={13} strokeWidth={1.8} />}
                onClick={(event) => {
                  event.stopPropagation();
                  expandSection(section, node.id);
                  void onCreateDoc(node.id);
                }}
              />
            ) : null}
            {canArchive ? (
              <IconButton
                label={`归档「${displayTitle(node.title)}」`}
                tooltip="归档"
                size="sm"
                tooltipPlacement="top"
                className={styles.archive}
                icon={<Archive size={13} strokeWidth={1.8} />}
                onClick={(event) => {
                  event.stopPropagation();
                  void service
                    .setArchived(node.id, true)
                    .then(() => {
                      refresh();
                      toast('已归档');
                    })
                    .catch((cause: unknown) => {
                      toast(
                        cause instanceof Error
                          ? cause.message
                          : '归档失败，请重试',
                      );
                    });
                }}
              />
            ) : null}
            <IconButton
              label={`${displayTitle(node.title)} 的操作`}
              tooltip="更多操作"
              size="sm"
              tooltipPlacement="top"
              className={styles.more}
              icon={<MoreHorizontal size={14} strokeWidth={1.7} />}
              onClick={(event) => {
                event.stopPropagation();
                setMenu({ node, anchor: event.currentTarget });
              }}
            />
          </span>
        )}
        {!editingFolder && (node.pinned || node.archived) ? (
          <span className={styles.marks}>
            {node.pinned ? (
              <RowMarker
                label="取消置顶"
                icon={
                  <Pin
                    className={styles.markerIcon}
                    size={13}
                    strokeWidth={1.6}
                  />
                }
                hoverIcon={
                  <PinOff
                    className={styles.markerHoverIcon}
                    size={13}
                    strokeWidth={1.6}
                  />
                }
                onClick={() => {
                  void service.setPinned(node.id, false).then(() => {
                    refresh();
                    toast('已取消置顶');
                  });
                }}
              />
            ) : null}
            {node.archived ? (
              <RowMarker
                label="取消归档"
                icon={
                  <Archive
                    className={styles.markerIcon}
                    size={13}
                    strokeWidth={1.6}
                  />
                }
                hoverIcon={
                  <ArchiveRestore
                    className={styles.markerHoverIcon}
                    size={13}
                    strokeWidth={1.6}
                  />
                }
                onClick={() => {
                  void service.setArchived(node.id, false).then(() => {
                    refresh();
                    toast('已还原');
                  });
                }}
              />
            ) : null}
          </span>
        ) : null}
      </div>
    );
  }

  if (!visibleNodes.length) {
    return (
      <p className={styles.emptyHint}>
        {creator === 'alter' ? 'Alter 还没有创建文档' : '还没有文档'}
      </p>
    );
  }

  const deleteChildren = deleteNode
    ? descendantIds(nodes, deleteNode.id).size
    : 0;

  return (
    <div className={styles.directory} aria-label="空间文档">
      {pinnedDocs.length ? (
        <section className={styles.pinnedSection} aria-label="置顶文档">
          {pinnedRows.map(({ doc, rows }) => (
            <Fragment key={doc.id}>
              {rows.map((row) => renderRow(row.node, row.depth, 'pinned'))}
            </Fragment>
          ))}
        </section>
      ) : null}

      {viewMode === 'tree'
        ? treeRows.map((row) => renderRow(row.node, row.depth))
        : flatNotes.map((node) => renderRow(node, 0))}

      <Menu
        anchor={menu?.anchor ?? null}
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
        align="end"
        width={196}
        heading={menu ? displayTitle(menu.node.title) : undefined}
        actions={menu ? actionsFor(menu.node) : []}
      />

      {moveNode ? (
        <MoveDialog
          key={moveNode.id}
          node={moveNode}
          onClose={() => setMoveNode(null)}
        />
      ) : null}

      <Dialog
        open={Boolean(deleteNode)}
        onClose={() => setDeleteNode(null)}
        title={deleteNode?.kind === 'folder' ? '删除文件夹？' : '删除文档？'}
        size="small"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteNode(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={deleting}
              onClick={() => void deleteSelected()}
            >
              {deleting ? '正在删除…' : '删除'}
            </Button>
          </>
        }
      >
        <p className={styles.confirmText}>
          {deleteNode ? `“${displayTitle(deleteNode.title)}”` : ''}
          将移到回收站，可以随时还原。
        </p>
        {deleteChildren ? (
          <p className={styles.confirmNote}>
            其中 {deleteChildren} 篇文档会一起进入回收站。
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
