import { Brush, FileText } from 'lucide-react';
import { Button } from '@alter/ui-system';
import { useSpaceContext } from '../runtime';
import { docPath, overviewPath } from '../space-route';
import { DirectoryButton } from '../components/DirectoryButton';
import { EmptyState } from '../components/EmptyState';
import styles from './SpaceHome.module.css';

export function SpaceHome() {
  const {
    service,
    router,
    space,
    spaceId,
    refresh,
    addNodeToState,
    openThoughtComposer,
  } = useSpaceContext();

  async function createDoc() {
    const node = await service.createNode({ spaceId, kind: 'note' });
    addNodeToState(node);
    refresh();
    router.navigate(docPath(spaceId, node.id));
  }

  return (
    <section className={styles.page} aria-label={space.name}>
      <header className={styles.toolbar}>
        <DirectoryButton />
      </header>
      <div className={styles.scroll}>
        <div className={styles.body}>
          <EmptyState
            icon={<FileText />}
            title="这个空间还没有文档"
            description="写下一篇文档，或先记下一条随想。"
            action={
              <div className={styles.actions}>
                <Button
                  variant="primary"
                  className={styles.homeAction}
                  onClick={() => void createDoc()}
                >
                  新建文档
                </Button>
                <Button
                  variant="secondary"
                  className={styles.homeAction}
                  onClick={openThoughtComposer}
                >
                  <Brush size={14} strokeWidth={1.7} aria-hidden="true" />
                  记录随想
                </Button>
              </div>
            }
          />
          <button
            type="button"
            className={styles.details}
            onClick={() => router.navigate(overviewPath(spaceId))}
          >
            查看空间详情与配置
          </button>
        </div>
      </div>
    </section>
  );
}
