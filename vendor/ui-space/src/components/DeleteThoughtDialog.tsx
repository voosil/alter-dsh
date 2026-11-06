import { useState } from 'react';
import type { Thought } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { Button, Dialog } from '@alter/ui-system';
import styles from './DeleteThoughtDialog.module.css';

export function DeleteThoughtDialog({
  thought,
  onClose,
  onDeleted,
}: {
  thought: Thought | null;
  onClose: () => void;
  onDeleted?: (thought: Thought) => void;
}) {
  const { service, refresh, toast } = useSpaceContext();
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    if (!thought) return;
    setDeleting(true);
    try {
      await service.deleteThought(thought.id);
      refresh();
      toast('已移到回收站');
      onDeleted?.(thought);
      onClose();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '删除失败，请重试');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={Boolean(thought)}
      onClose={onClose}
      title="删除随想？"
      size="small"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
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
      <p className={styles.text}>这条随想将移到回收站，可以随时还原。</p>
    </Dialog>
  );
}
