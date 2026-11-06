import type { Thought } from '@alter/protocol';
import { Button, Dialog } from '@alter/ui-system';
import styles from './MoveThoughtDialog.module.css';

export function MoveThoughtDialog({
  thought,
  spaces,
  targetSpaceId,
  onTarget,
  onClose,
  onMove,
  moving,
  error,
}: {
  thought: Thought | null;
  spaces: { id: string; name: string; isDefault: boolean }[];
  targetSpaceId: string;
  onTarget: (id: string) => void;
  onClose: () => void;
  onMove: () => void;
  moving: boolean;
  error: string;
}) {
  if (!thought) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="移动随想"
      size="small"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={moving || !targetSpaceId}
            onClick={onMove}
          >
            {moving ? '正在移动…' : '移动'}
          </Button>
        </>
      }
    >
      {spaces.length ? (
        <div className={styles.spaceOptions}>
          {spaces.map((spaceItem) => (
            <label
              key={spaceItem.id}
              className={styles.spaceOption}
              data-selected={targetSpaceId === spaceItem.id || undefined}
            >
              <input
                type="radio"
                name="thought-space"
                checked={targetSpaceId === spaceItem.id}
                onChange={() => onTarget(spaceItem.id)}
              />
              <span>{spaceItem.name}</span>
              {spaceItem.isDefault ? (
                <span className={styles.defaultBadge}>默认</span>
              ) : null}
            </label>
          ))}
        </div>
      ) : (
        <p className={styles.empty}>还没有其他空间可以移动。</p>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
