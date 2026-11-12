import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { DocVersion, SpaceNode } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { documentModelOf } from '../document-model';
import { alterDocToEditorHtml, parseDocumentContent } from '@alter-space/document-runtime';
import { formatShortDate } from '../utils/date';
import { diffHtml } from '../utils/diff';
import { Button, Dialog } from '@alter/ui-system';
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

/** Version bodies are `alter-doc/1`; the preview still renders old HTML. */
function versionHtml(content: string): string {
  const parsed = parseDocumentContent(content);
  return parsed === undefined ? '' : alterDocToEditorHtml(parsed);
}

export function HistoryPanel({
  open,
  doc,
  baseRevision,
  hasUnsavedChanges,
  onPersistDraft,
  onClose,
  onRestored,
}: {
  open: boolean;
  doc: SpaceNode;
  /** Current document revision used as the restore CAS base. */
  baseRevision: number;
  /** Live check for unsaved editor changes (evaluated on restore click). */
  hasUnsavedChanges?: () => boolean;
  /** Force a crash-draft write before restoring (B4). */
  onPersistDraft?: () => void;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { service, toast } = useSpaceContext();
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);

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
    () =>
      selected && base
        ? diffHtml(versionHtml(base.content), versionHtml(selected.content))
        : null,
    [base, selected],
  );
  const unchanged =
    !selected ||
    (selected.content === doc.content && selected.title === doc.title);

  async function restore() {
    if (!selected) return;
    if (hasUnsavedChanges?.() === true) {
      // B4: never replace unsaved edits without an explicit confirmation.
      setConfirmRestoreOpen(true);
      return;
    }
    await performRestore();
  }

  async function performRestore() {
    if (!selected) return;
    const client = documentModelOf(service);
    if (client?.restoreVersion === undefined) {
      toast('文档模型客户端未装配：请刷新页面或重新安装插件');
      return;
    }
    setRestoring(true);
    try {
      // Version restore is a Document Operation on the Host (revision + 1);
      // the old `space.restoreVersion` direct content write is not used.
      await client.restoreVersion({
        docId: doc.id,
        versionId: selected.id,
        baseRevision,
      });
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
    : selected === null
      ? ''
      : versionHtml(selected.content);
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
      <Dialog
        open={confirmRestoreOpen}
        onClose={() => setConfirmRestoreOpen(false)}
        title="存在未保存修改"
        size="small"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirmRestoreOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmRestoreOpen(false);
                onPersistDraft?.();
                void performRestore();
              }}
            >
              继续恢复
            </Button>
          </>
        }
      >
        <p>
          当前文档存在未保存修改。将先把内容保存为本地草稿，再恢复所选历史版本；草稿仍可在重新打开文档时恢复。
        </p>
      </Dialog>
    </Dialog>
  );
}
