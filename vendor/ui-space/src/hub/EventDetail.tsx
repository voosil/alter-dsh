import type { AgentEvent } from '@alter/protocol';
import type { WorkbenchTab } from '@alter/ui-workbench';
import { Button } from '@alter/ui-system';
import { useSpaceContext } from '../runtime';
import { dateText } from './context';
import styles from './Hub.module.css';

export function EventDetail({ tab }: { tab: WorkbenchTab }) {
  const { nodes, workbench } = useSpaceContext();
  let event: AgentEvent | null = null;
  try {
    event = JSON.parse(tab.draft || '') as AgentEvent;
  } catch {
    event = null;
  }
  if (!event?.title) return <p className={styles.empty}>活动已不可用。</p>;
  const doc = event.docId
    ? nodes.find((node) => node.id === event.docId && !node.deletedAt)
    : undefined;

  return (
    <div className={styles.detail}>
      <div className={styles.actions}>
        <span className={styles.status}>Alter 的活动</span>
        <span className={styles.note}>{dateText(event.at)}</span>
      </div>
      <h2>{event.title}</h2>
      <p>{event.detail}</p>
      {doc ? (
        <section className={styles.section}>
          <h3>相关文档</h3>
          <Button
            variant="ghost"
            className={styles.document}
            onClick={() =>
              workbench?.controller.launch(workbench.scopeKey, 'document', {
                documentId: doc.id,
                title: doc.title || '未命名文档',
              })
            }
          >
            {doc.title || '未命名文档'}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
