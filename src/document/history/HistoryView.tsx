/**
 * Version-history tab: version list + AST block diff + restore.
 *
 * The list is loaded by the side panel (`service.listVersions`, newest first);
 * this view parses the selected snapshot and its immediate predecessor into AST
 * and shows a bounded per-block diff. The current document snapshot
 * (`client.get`) is read as well so a version that already equals the current
 * content disables the restore action instead of bumping the revision for a
 * no-op.
 *
 * Restore goes through `doc.restoreVersion` with the editor's current revision
 * as the CAS base; success calls the existing `onRestored` callback and reloads
 * the version list, failures stay visible with a readable message.
 *
 * @module @alter-dsh/space/document/history/HistoryView
 */
import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { DocVersion } from '@alter/protocol';
import type { SpaceDocumentClient } from '../../space-client';
import { parseAlterDocContent } from '../types';
import {
  BLOCK_DIFF_KIND_LABELS,
  EMPTY_ALTER_DOC,
  attrLabel,
  blockTypeName,
  diffAlterDocs,
  documentsEquivalent,
  type BlockDiffEntry,
} from './diff';
import {
  describeRestoreError,
  formatVersionTime,
  readHistorySnapshot,
  readRestoredRevision,
  versionTitle,
  type HistorySnapshot,
} from './snapshot';
import styles from './HistoryView.module.css';

/** Props of {@link HistoryView}. */
export interface HistoryViewProps {
  docId: string;
  /** Revision of the editor's current snapshot (CAS base for restore). */
  revision: number;
  /** Versions of the document, newest first (loaded by the side panel). */
  versions: DocVersion[];
  client: SpaceDocumentClient;
  /** Existing callback: the document view reloads after a successful restore. */
  onRestored: (revision: number) => void;
  /** Reload the version list after a restore. */
  onReloadVersions: () => Promise<void> | void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

function DiffEntry({ entry }: { entry: BlockDiffEntry }) {
  return (
    <li className={styles.entry} data-kind={entry.kind}>
      <div className={styles.entryHead}>
        <span className={styles.entryKind} data-kind={entry.kind}>
          {BLOCK_DIFF_KIND_LABELS[entry.kind]}
        </span>
        <span className={styles.entryType}>
          {entry.typeLabel}
          {entry.previousType === undefined
            ? null
            : `（原${blockTypeName(entry.previousType)}）`}
        </span>
        <span className={styles.entryIndex}>#{entry.index}</span>
      </div>
      {entry.title === undefined ? null : (
        <div className={styles.entryTitle}>{entry.title}</div>
      )}
      {entry.text === undefined || entry.text === '' ? null : (
        <div className={styles.entryText}>{entry.text}</div>
      )}
      {entry.previousText === undefined ||
      entry.previousText === '' ||
      entry.previousText === entry.text ? null : (
        <div className={styles.entryOld}>{entry.previousText}</div>
      )}
      {entry.changedAttrs === undefined || entry.changedAttrs.length === 0 ? null : (
        <div className={styles.entryAttrs}>
          属性：{entry.changedAttrs.map(attrLabel).join('、')}
        </div>
      )}
    </li>
  );
}

/** Render the history tab for one document. */
export function HistoryView({
  docId,
  revision,
  versions,
  client,
  onRestored,
  onReloadVersions,
}: HistoryViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [current, setCurrent] = useState<HistorySnapshot | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // `service.listVersions` is newest-first today; sort defensively so the
  // selection default and the "previous version" diff base stay correct if the
  // Host ever changes its ordering.
  const orderedVersions = useMemo(() => {
    const timeOf = (version: DocVersion): number => {
      const parsed = Date.parse(version.at);
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    return [...versions].sort((left, right) => timeOf(right) - timeOf(left));
  }, [versions]);

  // Keep the selection valid; default to the newest snapshot.
  useEffect(() => {
    if (orderedVersions.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) =>
      current !== null &&
      orderedVersions.some((version) => version.id === current)
        ? current
        : orderedVersions[0]!.id,
    );
  }, [orderedVersions]);

  // Current document AST: used for the "already current" restore guard and as
  // the freshest comparison anchor after a save/restore bumps the revision.
  useEffect(() => {
    let alive = true;
    setCurrentError(null);
    void client
      .get(docId)
      .then((value) => {
        if (!alive) return;
        const snapshot = readHistorySnapshot(value);
        if (snapshot === undefined) {
          setCurrent(null);
          setCurrentError('无法读取当前文档内容');
          return;
        }
        setCurrent(snapshot);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setCurrent(null);
        setCurrentError(describeRestoreError(error));
      });
    return () => {
      alive = false;
    };
  }, [client, docId, revision]);

  const selectedIndex = orderedVersions.findIndex(
    (version) => version.id === selectedId,
  );
  const selected =
    selectedIndex < 0 ? undefined : orderedVersions[selectedIndex];
  const baseVersion =
    selectedIndex < 0 ? undefined : orderedVersions[selectedIndex + 1];

  const selectedDoc = useMemo(
    () => (selected === undefined ? undefined : parseAlterDocContent(selected.content)),
    [selected],
  );
  const baseDoc = useMemo(
    () =>
      baseVersion === undefined
        ? undefined
        : parseAlterDocContent(baseVersion.content),
    [baseVersion],
  );

  const diff = useMemo(
    () =>
      selectedDoc === undefined
        ? null
        : diffAlterDocs(baseDoc ?? EMPTY_ALTER_DOC, selectedDoc),
    [baseDoc, selectedDoc],
  );

  const baseUnparsed = baseVersion !== undefined && baseDoc === undefined;
  const titleChanged =
    selected !== undefined &&
    baseVersion !== undefined &&
    selected.title !== baseVersion.title;
  const matchesCurrent = useMemo(() => {
    if (current === null || selected === undefined || selectedDoc === undefined)
      return false;
    return (
      selected.title.trim() === current.title.trim() &&
      documentsEquivalent(selectedDoc, current.doc)
    );
  }, [current, selected, selectedDoc]);

  const unparsed = selected !== undefined && selectedDoc === undefined;
  const canRestore =
    selected !== undefined && !unparsed && !matchesCurrent && !restoring;
  const restoreHint = restoring
    ? '正在恢复…'
    : unparsed
      ? '版本内容无法解析，不能恢复'
      : matchesCurrent
        ? '该版本与当前文档一致，无需恢复'
        : '恢复到该版本';

  async function restoreSelected(): Promise<void> {
    if (selected === undefined || selectedDoc === undefined) return;
    setRestoring(true);
    setStatus({ kind: 'idle' });
    try {
      const result = await client.restoreVersion({
        docId,
        versionId: selected.id,
        baseRevision: revision,
      });
      const nextRevision = readRestoredRevision(result) ?? revision + 1;
      setStatus({ kind: 'success', message: '已恢复到该版本' });
      try {
        await onReloadVersions();
      } catch {
        // The list refresh is best effort; the restore itself already landed.
      }
      onRestored(nextRevision);
    } catch (error) {
      setStatus({ kind: 'error', message: describeRestoreError(error) });
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className={styles.history}>
      {orderedVersions.length === 0 ? (
        <p className={styles.emptyState}>还没有版本快照。</p>
      ) : (
        <ol className={styles.versionList} aria-label="版本列表">
          {orderedVersions.map((version) => {
            const active = version.id === selectedId;
            return (
              <li key={version.id}>
                <button
                  type="button"
                  className={active ? styles.versionActive : styles.version}
                  aria-pressed={active}
                  onClick={() => {
                    setSelectedId(version.id);
                    setStatus({ kind: 'idle' });
                  }}
                >
                  <span className={styles.versionTime}>
                    {formatVersionTime(version.at)}
                  </span>
                  <span className={styles.versionMeta}>
                    {version.author === 'alter' ? 'Alter' : '我'} ·{' '}
                    {versionTitle(version.title)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {selected === undefined ? null : (
        <div className={styles.preview} aria-label="版本差异">
          <div className={styles.previewHead}>
            <span className={styles.previewLabel}>
              {baseVersion === undefined ? '最早版本' : '与上一版本对比'}
            </span>
            <button
              type="button"
              className={styles.restore}
              disabled={!canRestore}
              title={restoreHint}
              onClick={() => void restoreSelected()}
            >
              <RotateCcw size={13} strokeWidth={1.7} aria-hidden="true" />
              {restoring ? '正在恢复…' : '恢复此版本'}
            </button>
          </div>

          {status.kind === 'error' ? (
            <p className={styles.error} role="alert">
              {status.message}
            </p>
          ) : status.kind === 'success' ? (
            <p className={styles.notice} role="status">
              {status.message}
            </p>
          ) : null}

          {unparsed ? (
            <p className={styles.unparsed} role="alert">
              该版本内容无法解析（旧格式或已损坏），无法预览差异或恢复。
            </p>
          ) : diff === null ? null : (
            <>
              <p className={styles.summary} aria-label="差异摘要">
                <span className={styles.summaryCount}>
                  共 {diff.targetBlocks} 块（上一版本 {diff.baseBlocks} 块）
                </span>
                <span className={styles.summaryItem} data-diff-kind="added">
                  新增 {diff.added}
                </span>
                <span className={styles.summaryItem} data-diff-kind="removed">
                  删除 {diff.removed}
                </span>
                <span className={styles.summaryItem} data-diff-kind="modified">
                  修改 {diff.modified}
                </span>
                {diff.moved === 0 ? null : (
                  <span className={styles.summaryItem} data-diff-kind="moved">
                    移动 {diff.moved}
                  </span>
                )}
              </p>

              {baseUnparsed ? (
                <p className={styles.hint}>
                  上一版本内容无法解析，仅显示当前版本的块清单。
                </p>
              ) : null}

              {titleChanged && baseVersion !== undefined ? (
                <p className={styles.titleDiff}>
                  <span className={styles.titleLabel}>标题</span>
                  <del>{versionTitle(baseVersion.title)}</del>
                  <span aria-hidden="true">→</span>
                  <ins>{versionTitle(selected.title)}</ins>
                </p>
              ) : null}

              {matchesCurrent ? (
                <p className={styles.hint}>
                  该版本与当前文档一致，无需恢复。
                </p>
              ) : null}

              {currentError === null ? null : (
                <p className={styles.hint}>
                  {currentError}（仍可尝试恢复）
                </p>
              )}

              {diff.entries.length === 0 ? (
                <p className={styles.empty}>与上一版本相比没有块级差异。</p>
              ) : (
                <ol className={styles.entryList} aria-label="逐块差异">
                  {diff.entries.map((entry) => (
                    <DiffEntry
                      key={`${entry.kind}:${entry.blockId}:${entry.index}`}
                      entry={entry}
                    />
                  ))}
                </ol>
              )}

              {diff.truncated ? (
                <p className={styles.truncated}>
                  仅显示前 {diff.maxEntries} 条，共 {diff.total} 条变更。
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
