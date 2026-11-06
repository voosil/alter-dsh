import { useState } from 'react';
import {
  ArchiveRestore,
  FolderInput,
  Link2,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import type { SpaceNode } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { docPath } from '../space-route';
import { displayTitle } from '../utils/tree';
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  type MenuAction,
} from '@alter/ui-system';
import { MoveDialog } from './MoveDialog';
import styles from './ArchiveDocMenu.module.css';

/**
 * 归档文档的操作菜单，与目录中的文档菜单保持一致：取消归档、复制链接、
 * 移动到…、删除；不提供新建子文档、归档，也没有历史记录与导出。
 */
export function ArchiveDocMenu({
  node,
  triggerClassName,
  onRestored,
  onDeleted,
}: {
  node: SpaceNode;
  triggerClassName?: string;
  onRestored: () => void;
  onDeleted: () => void;
}) {
  const { service, spaceId, refresh, toast } = useSpaceContext();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}${location.pathname}${docPath(spaceId, node.id)}`,
      );
      toast('链接已复制');
    } catch {
      toast('复制失败，请检查浏览器权限');
    }
  }

  async function unarchive() {
    await service.setArchived(node.id, false);
    refresh();
    toast('已恢复');
    onRestored();
  }

  async function remove() {
    setDeleting(true);
    try {
      await service.deleteNode(node.id);
      setDeleteOpen(false);
      refresh();
      toast('已移到回收站');
      onDeleted();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '删除失败，请重试');
    } finally {
      setDeleting(false);
    }
  }

  const actions: MenuAction[] = [
    {
      id: 'unarchive',
      label: '取消归档',
      icon: <ArchiveRestore />,
      onSelect: () => void unarchive(),
    },
    {
      id: 'copy',
      label: '复制链接',
      icon: <Link2 />,
      onSelect: () => void copyLink(),
    },
    {
      id: 'move',
      label: '移动到…',
      icon: <FolderInput />,
      separatorBefore: true,
      onSelect: () => setMoveOpen(true),
    },
    {
      id: 'delete',
      label: '删除',
      icon: <Trash2 />,
      danger: true,
      separatorBefore: true,
      onSelect: () => setDeleteOpen(true),
    },
  ];

  return (
    <>
      <IconButton
        label="文档操作"
        size="sm"
        tooltipPlacement="top"
        className={`${styles.trigger} ${triggerClassName ?? ''}`.trim()}
        icon={<MoreHorizontal />}
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(event.currentTarget)}
      />
      <Menu
        anchor={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        align="end"
        width={196}
        heading={displayTitle(node.title)}
        actions={actions}
      />
      {moveOpen ? (
        <MoveDialog node={node} onClose={() => setMoveOpen(false)} />
      ) : null}
      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="删除文档？"
        size="small"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? '正在删除…' : '删除'}
            </Button>
          </>
        }
      >
        <p className={styles.confirmText}>
          “{displayTitle(node.title)}”将移到回收站，可以随时还原。
        </p>
      </Dialog>
    </>
  );
}
