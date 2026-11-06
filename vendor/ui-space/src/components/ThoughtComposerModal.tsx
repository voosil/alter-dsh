import { useSpaceContext } from '../runtime';
import { thoughtsPath } from '../space-route';
import { Dialog } from '@alter/ui-system';
import { ThoughtComposer } from './ThoughtComposer';
import styles from './ThoughtComposerModal.module.css';

export function ThoughtComposerModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { service, router, space, spaceId, refresh, toast } = useSpaceContext();

  async function submit(html: string) {
    await service.createThought({ spaceId, content: html });
    refresh();
    toast('随想已记录');
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title="随想" size="medium">
      <ThoughtComposer
        autoFocus
        compact
        onSubmit={submit}
        placeholder="此刻想到什么…"
      />
      <div className={styles.footer}>
        <span>记录到「{space.name}」</span>
        <button
          type="button"
          onClick={() => {
            onClose();
            router.navigate(thoughtsPath(spaceId));
          }}
        >
          打开随想页
        </button>
      </div>
    </Dialog>
  );
}
