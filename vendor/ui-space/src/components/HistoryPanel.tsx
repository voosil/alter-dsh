import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { DocVersion, SpaceNode } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { formatShortDate } from '../utils/date';
import { diffHtml } from '../utils/diff';
import { Dialog } from '@alter/ui-system';
import { EmptyState } from './EmptyState';
import editorStyles from './editor/Editor.module.css';
import styles from './HistoryPanel.module.css';

interface HistoryEntry {
  id: string;
  title: string;
  content: string;
  at: string;
  author: DocVersion['author'];
}

export function HistoryPanel({
  open,
  doc,
  onClose,
  onRestored,
}: {
  open: boolean;
  doc: SpaceNode;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { service, toast } = useSpaceContext();
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void service.listVersions(doc.id).then((items) => {
      if (!active) return;
      setVersions(items);
      setSelectedId(items[0]?.id ?? null);
      setLoadedDocId(doc.id);
    });
    return () => {
      active = false;
    };
  }, [open, doc.id, service]);

  const entries = useMemo<HistoryEntry[]>(
    () =>
      versions.map((version) => ({
        id: version.id,
        title: version.title,
        content: version.content,
        at: version.at,
        author: version.author,
      })),
    [versions],
  );

  const loading = loadedDocId !== doc.id;
  const selectedIndex = entries.findIndex((entry) => entry.id === selectedId);
  const selected = selectedIndex >= 0 ? entries[selectedIndex] : null;
  const base = selectedIndex >= 0 ? (entries[selectedIndex + 1] ?? null) : null;
  const diff = useMemo(
    () => (selected && base ? diffHtml(base.content, selected.content) : null),
    [base, selected],
  );
  const unchanged =
    !selected ||
    (selected.content === doc.content && selected.title === doc.title);

  async function restore() {
    if (!selected) return;
    setRestoring(true);
    try {
      await service.restoreVersion(doc.id, selected.id);
      onRestored();
      onClose();
      toast('已还原到这版内容');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '还原失败，请重试');
    } finally {
      setRestoring(false);
    }
  }

  const previewHtml = diff
    ? diff
        .map((block) =>
          block.kind === 'same'
            ? block.html
            : `<div class="${
                block.kind === 'added' ? styles.diffAdded : styles.diffRemoved
              }">${block.html}</div>`,
        )
        .join('')
    : (selected?.content ?? '');
  const titleChanged =
    Boolean(selected && base) && selected?.title !== base?.title;

  return (
    <Dialog open={open} onClose={onClose} title="历史记录" size="wide">
      {loading ? (
        <p className={styles.loading}>正在读取版本…</p>
      ) : versions.length ? (
        <div className={styles.history}>
          <aside className={styles.list} aria-label="版本列表">
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={styles.version}
                data-selected={entry.id === selectedId || undefined}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className={styles.versionTime}>
                  {formatShortDate(entry.at)}
                </span>
                <span className={styles.versionMeta}>
                  {entry.author === 'alter' ? 'Alter' : '我'}保存
                </span>
              </button>
            ))}
          </aside>
          <section className={styles.preview} aria-label="版本内容">
            <div className={styles.previewActions}>
              <button
                type="button"
                className={styles.restore}
                disabled={restoring || unchanged}
                onClick={() => void restore()}
              >
                <RotateCcw size={13} strokeWidth={1.7} />
                还原到此版本
              </button>
            </div>
            {titleChanged && selected && base ? (
              <p className={styles.titleDiff}>
                <span>标题</span>
                <del>{base.title || '无标题'}</del>
                <span aria-hidden="true">→</span>
                <ins>{selected.title || '无标题'}</ins>
              </p>
            ) : null}
            <div
              className={`${styles.document} ${editorStyles.surface}`}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </section>
        </div>
      ) : (
        <EmptyState
          title="还没有历史版本"
          description="继续编辑并保存后，这里会出现可以还原的版本。"
        />
      )}
    </Dialog>
  );
}
