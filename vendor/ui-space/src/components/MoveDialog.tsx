import { useMemo, useState } from 'react';
import { FileText, Folder } from 'lucide-react';
import type { SpaceNode } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { descendantIds, displayTitle, flattenTree } from '../utils/tree';
import { docPath, spacePath } from '../space-route';
import { Button, Dialog } from '@alter/ui-system';
import styles from './MoveDialog.module.css';

export function MoveDialog({
  node,
  onClose,
}: {
  node: SpaceNode | null;
  onClose: () => void;
}) {
  const { service, router, spaces, nodes, spaceId, refresh, toast } =
    useSpaceContext();
  const [targetSpaceId, setTargetSpaceId] = useState(spaceId);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const destinations = useMemo(() => {
    if (!node || node.kind === 'folder' || targetSpaceId !== spaceId) return [];
    const excluded = new Set([node.id, ...descendantIds(nodes, node.id)]);
    const expanded = new Set(nodes.map((item) => item.id));
    return flattenTree(nodes, expanded).filter(
      (row) => !excluded.has(row.node.id) && !row.node.archived,
    );
  }, [node, nodes, spaceId, targetSpaceId]);

  if (!node) return null;

  async function handleMove() {
    if (!node) return;
    setSaving(true);
    setError('');
    try {
      const sameSpace = targetSpaceId === spaceId;
      const parentId =
        node.kind === 'folder' || !sameSpace ? null : destinationId;
      let order: number | undefined;
      if (parentId) {
        const siblings = nodes.filter(
          (item) => item.parentId === parentId && item.id !== node.id,
        );
        order = siblings.length
          ? Math.min(...siblings.map((item) => item.order)) - 1
          : 0;
      }
      await service.moveNode(node.id, {
        spaceId: targetSpaceId,
        parentId,
        order,
      });
      onClose();
      refresh();
      toast('已移动');
      if (targetSpaceId !== spaceId) {
        router.navigate(
          node.kind === 'note'
            ? docPath(targetSpaceId, node.id)
            : spacePath(targetSpaceId),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移动失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  const destinationLabel = (row: { node: SpaceNode; depth: number }) => (
    <span
      className={styles.destination}
      style={{ paddingLeft: row.depth * 15 }}
    >
      <span className={styles.destinationIcon} aria-hidden="true">
        {row.node.kind === 'folder' ? (
          <Folder size={14} strokeWidth={1.5} />
        ) : (
          <FileText size={14} strokeWidth={1.5} />
        )}
      </span>
      <span className={styles.destinationTitle}>
        {displayTitle(row.node.title)}
      </span>
    </span>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={`移动「${displayTitle(node.title)}」`}
      size="medium"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => void handleMove()}
          >
            {saving ? '正在移动…' : '移动'}
          </Button>
        </>
      }
    >
      <fieldset className={styles.group}>
        <legend className={styles.legend}>目标空间</legend>
        <div className={styles.spaceOptions}>
          {spaces.map((space) => (
            <label
              key={space.id}
              className={styles.option}
              data-selected={targetSpaceId === space.id || undefined}
            >
              <input
                type="radio"
                name="target-space"
                checked={targetSpaceId === space.id}
                onChange={() => {
                  setTargetSpaceId(space.id);
                  setDestinationId(null);
                }}
              />
              <span className={styles.spaceName}>{space.name}</span>
              {space.isDefault ? (
                <span className={styles.badge}>默认</span>
              ) : null}
            </label>
          ))}
        </div>
      </fieldset>

      {node.kind === 'note' && targetSpaceId === spaceId ? (
        <fieldset className={styles.group}>
          <legend className={styles.legend}>位置</legend>
          <div className={styles.destinations}>
            <label
              className={styles.option}
              data-selected={destinationId === null || undefined}
            >
              <input
                type="radio"
                name="destination"
                checked={destinationId === null}
                onChange={() => setDestinationId(null)}
              />
              <span className={styles.destination}>空间根目录</span>
            </label>
            {destinations.map((row) => (
              <label
                key={row.node.id}
                className={styles.option}
                data-selected={destinationId === row.node.id || undefined}
              >
                <input
                  type="radio"
                  name="destination"
                  checked={destinationId === row.node.id}
                  onChange={() => setDestinationId(row.node.id)}
                />
                {destinationLabel(row)}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className={styles.hint}>
          {node.kind === 'folder'
            ? '文件夹会连同其中的文档移动到目标空间的根目录。'
            : '文档会移动到目标空间的根目录。'}
        </p>
      )}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
