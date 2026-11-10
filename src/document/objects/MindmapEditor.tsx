/**
 * Mindmap tree editor dialog.
 *
 * Opened by the `alterMindmap` node view (through the
 * `alter-mindmap-edit` window event) or by the slash-menu insert flow. It
 * edits a local draft of the object payload (rename / add child / delete
 * node), then hands the validated payload to the editor surface, which saves
 * it through the `update_object` Document Operation.
 *
 * The dialog is presentational: loading, saving, conflict and error states are
 * owned by the editor surface.
 *
 * @module @alter-dsh/space/document/objects/MindmapEditor
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  MINDMAP_MAX_NODES,
  MINDMAP_MAX_TEXT_LENGTH,
  addMindmapChild,
  cloneMindmapPayload,
  countMindmapNodes,
  deleteMindmapNode,
  findMindmapNode,
  flattenMindmap,
  renameMindmapNode,
  type MindmapPayload,
} from './mindmap';
import styles from './MindmapEditor.module.css';

/** Props of the mindmap tree editor dialog. */
export interface MindmapEditorProps {
  /** Whether the dialog is mounted. */
  open: boolean;
  /** Object payload to edit; `null` while loading. */
  initial: MindmapPayload | null;
  /** The object payload is being fetched. */
  loading?: boolean;
  /** The payload is being saved through `update_object`. */
  saving?: boolean;
  /** Save/load error owned by the editor surface. */
  error?: string | null;
  /** The last save hit `doc/conflict`; offer a document reload. */
  conflict?: boolean;
  onSave: (payload: MindmapPayload) => void;
  onClose: () => void;
  /** Reload the document after a conflict (editor surface owns the reload). */
  onReload?: () => void;
}

/** Modal tree editor for one mindmap object payload. */
export function MindmapEditor({
  open,
  initial,
  loading = false,
  saving = false,
  error = null,
  conflict = false,
  onSave,
  onClose,
  onReload,
}: MindmapEditorProps): ReactNode {
  const [tree, setTree] = useState<MindmapPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const draftSourceRef = useRef<MindmapPayload | null>(null);

  // Adopt a freshly loaded payload once per object; reopening the same object
  // keeps the user's in-dialog edits.
  useEffect(() => {
    if (!open) {
      draftSourceRef.current = null;
      return;
    }
    if (initial === null) return;
    if (draftSourceRef.current === initial) return;
    draftSourceRef.current = initial;
    const clone = cloneMindmapPayload(initial);
    setTree(clone);
    setSelectedId(clone.root.id);
    setLocalError(null);
  }, [open, initial]);

  if (!open || typeof document === 'undefined') return null;

  const busy = loading || saving;
  const message = error ?? localError;

  const rename = (id: string, value: string): void => {
    setLocalError(null);
    setTree((current) =>
      current === null ? current : renameMindmapNode(current, id, value),
    );
  };

  const addChild = (parentId: string): void => {
    if (tree === null) return;
    const next = addMindmapChild(tree, parentId);
    if (next === undefined) {
      setLocalError(`最多 ${MINDMAP_MAX_NODES} 个节点`);
      return;
    }
    setLocalError(null);
    setTree(next);
    const parent = findMindmapNode(next.root, parentId);
    const added = parent?.children?.[parent.children.length - 1];
    if (added !== undefined) setSelectedId(added.id);
  };

  const removeNode = (id: string): void => {
    if (tree === null) return;
    const next = deleteMindmapNode(tree, id);
    if (next === undefined) {
      setLocalError('根节点不能删除');
      return;
    }
    setLocalError(null);
    setTree(next);
    if (selectedId === id) setSelectedId(next.root.id);
  };

  const save = (): void => {
    if (tree === null || busy) return;
    if (countMindmapNodes(tree.root) > MINDMAP_MAX_NODES) {
      setLocalError(`最多 ${MINDMAP_MAX_NODES} 个节点`);
      return;
    }
    setLocalError(null);
    onSave(cloneMindmapPayload(tree));
  };

  const rows = tree === null ? [] : flattenMindmap(tree.root);

  return createPortal(
    <div className={styles.overlay}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="编辑思维导图"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || saving) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className={styles.header}>
          <span className={styles.title}>编辑思维导图</span>
          <span className={styles.counter}>
            {tree === null ? '—' : countMindmapNodes(tree.root)} /{' '}
            {MINDMAP_MAX_NODES} 节点
          </span>
        </header>

        <div className={styles.body}>
          {loading ? (
            <p className={styles.state}>正在加载思维导图…</p>
          ) : tree === null ? (
            <p className={styles.state}>暂无可编辑的思维导图数据</p>
          ) : (
            <div className={styles.tree} role="tree" aria-label="思维导图节点">
              {rows.map(({ node, depth }) => (
                <div
                  key={node.id}
                  className={styles.row}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-selected={node.id === selectedId}
                  data-selected={node.id === selectedId ? 'true' : undefined}
                  style={{ paddingLeft: `${depth * 18}px` }}
                  onClick={() => setSelectedId(node.id)}
                >
                  <input
                    className={styles.input}
                    value={node.text}
                    maxLength={MINDMAP_MAX_TEXT_LENGTH}
                    aria-label={`节点文本：${node.text}`}
                    disabled={busy}
                    onChange={(event) => rename(node.id, event.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.action}
                    aria-label={`新增子节点：${node.text}`}
                    title="新增子节点"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      addChild(node.id);
                    }}
                  >
                    + 子节点
                  </button>
                  {depth === 0 ? null : (
                    <button
                      type="button"
                      className={styles.remove}
                      aria-label={`删除节点：${node.text}`}
                      title="删除节点"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        removeNode(node.id);
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {message === null ? null : (
            <p className={styles.error} role="alert">
              {message}
            </p>
          )}
          {conflict && onReload !== undefined ? (
            <button
              type="button"
              className={styles.reload}
              disabled={busy}
              onClick={onReload}
            >
              重新加载文档
            </button>
          ) : null}
        </div>

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.button}
            disabled={saving}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={busy || tree === null}
            onClick={save}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
