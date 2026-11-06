import type { Thought } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { Dialog } from '@alter/ui-system';
import { ThoughtComposer } from './ThoughtComposer';

export function ThoughtEditModal({
  thought,
  onClose,
  onSaved,
}: {
  thought: Thought | null;
  onClose: () => void;
  onSaved?: (thought: Thought) => void;
}) {
  const { service, refresh, toast } = useSpaceContext();

  async function save(html: string) {
    if (!thought) return;
    const updated = await service.updateThought(thought.id, html);
    refresh();
    toast('已保存');
    onSaved?.(updated);
    onClose();
  }

  return (
    <Dialog
      open={Boolean(thought)}
      onClose={onClose}
      title="随想"
      size="medium"
    >
      {thought ? (
        <ThoughtComposer
          key={thought.id}
          initialContent={thought.content}
          submitLabel="保存"
          autoFocus
          onSubmit={save}
          onCancel={onClose}
        />
      ) : null}
    </Dialog>
  );
}
