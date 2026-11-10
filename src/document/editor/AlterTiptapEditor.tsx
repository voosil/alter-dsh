/**
 * Editable Tiptap surface for AST-backed Space documents.
 *
 * The component owns the interaction only: it projects the Host `AlterDoc`
 * into Tiptap (see `mapping.ts`), lets the user edit, and on save converts the
 * editor JSON back into blocks and turns the difference into Host Document
 * Operations (`operations.ts`). The Host stays the single source of truth;
 * `onSaved` hands the new revision and canonical document to the caller.
 *
 * Failure behaviour:
 * - `doc/conflict` (someone else wrote the document) and any other Host error
 *   are shown as readable Chinese messages, with a "重新加载" action that
 *   re-fetches the current document;
 * - oversized diffs throw `DocumentDiffError` from the client before any RPC;
 * - a no-op save reports "没有需要保存的变更" instead of calling the Host with
 *   an empty operation batch (the Host rejects empty batches).
 *
 * The dirty flag is reported through `onDirtyChange`; Cmd/Ctrl+S saves.
 *
 * @module @alter-dsh/space/document/editor/AlterTiptapEditor
 */
import type { JSONContent } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { SpaceDocumentClient } from '../../space-client';
import { SpaceRemoteError } from '../../space-client';
import type { AlterDoc } from '../types';
import { astToTiptap, tiptapToBlocks } from './mapping';
import {
  DocumentDiffError,
  MAX_DIFF_OPERATIONS,
  computeOperations,
} from './operations';
import { editorExtensions } from './schema';
import styles from './AlterTiptapEditor.module.css';

/** Props of the editable document surface. */
export interface AlterTiptapEditorProps {
  /** Space node id of the document. */
  docId: string;
  /** Canonical document snapshot loaded from the Host. */
  initialDoc: AlterDoc;
  /** Revision the snapshot was loaded at; used as the CAS base. */
  baseRevision: number;
  /** Document RPC client (see `SpaceDocumentClient`). */
  client: SpaceDocumentClient;
  /** Called after a successful save with the new revision and document. */
  onSaved: (revision: number, doc: AlterDoc) => void;
  /** Optional dirty-state report for the surrounding view. */
  onDirtyChange?: (dirty: boolean) => void;
}

type EditorStatus =
  | { kind: 'idle' }
  | { kind: 'info' | 'success'; message: string }
  | { kind: 'error'; message: string; reloadable?: boolean };

interface SnapshotLike {
  doc: AlterDoc;
  revision: number;
}

/** Turn any thrown value into a readable Chinese save error. */
function describeSaveError(error: unknown): string {
  if (error instanceof DocumentDiffError) return error.message;
  if (error instanceof SpaceRemoteError) {
    switch (error.code) {
      case 'doc/conflict':
        return '文档已被其他修改（revision 冲突）。请点「重新加载」获取最新内容后再编辑保存。';
      case 'doc/not-found':
        return '文档不存在或已被删除，请刷新页面后重试。';
      case 'doc/too-large':
        return '文档超过服务端体量上限，无法保存。请精简内容后重试。';
      case 'doc/schema-invalid':
      case 'node/schema-invalid':
        return `文档结构未通过服务端校验：${error.message}`;
      case 'node/not-found':
        return '编辑期间部分块已被其他操作删除，请重新加载后再保存。';
      case 'node/not-writable':
        return `当前节点类型不允许该修改：${error.message}`;
      case 'node/unsupported-transform':
        return `不支持该节点类型转换：${error.message}`;
      case 'op/invalid':
        return `保存操作未被服务端接受：${error.message}`;
      case 'idempotency/conflict':
        return '保存请求与之前的重复请求不一致，请重新加载后再保存。';
      default:
        return `保存失败：${error.message}`;
    }
  }
  if (error instanceof Error) {
    if (error.message.includes('变更过大')) return error.message;
    return `保存失败：${error.message}`;
  }
  return '保存失败：未知错误';
}

function describeEditError(error: unknown): string {
  if (error instanceof DocumentDiffError) return error.message;
  if (error instanceof Error) return `无法生成保存操作：${error.message}`;
  return '无法生成保存操作：未知错误';
}

function readRevision(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const revision = (value as Record<string, unknown>)['revision'];
  return typeof revision === 'number' &&
    Number.isInteger(revision) &&
    revision >= 0
    ? revision
    : undefined;
}

function readSnapshot(value: unknown): SnapshotLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const doc = record['doc'];
  if (typeof doc !== 'object' || doc === null) return undefined;
  const docRecord = doc as Record<string, unknown>;
  if (docRecord['format'] !== 'alter-doc/1') return undefined;
  if (!Array.isArray(docRecord['blocks'])) return undefined;
  const revision =
    readRevision(record) ?? readRevision(docRecord);
  if (revision === undefined) return undefined;
  return { doc: doc as AlterDoc, revision };
}

function createIdempotencyKey(): string | undefined {
  const cryptoApi = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  return typeof cryptoApi?.randomUUID === 'function'
    ? `editor-${cryptoApi.randomUUID()}`
    : undefined;
}

function ToolButton(props: {
  label: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={styles.toolButton}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active === undefined ? undefined : props.active}
      data-active={props.active === true ? 'true' : undefined}
      disabled={props.disabled === true}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function ToolGroup({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.toolGroup}>{children}</div>;
}

/** Editable Tiptap surface for one AST-backed document. */
export function AlterTiptapEditor({
  docId,
  initialDoc,
  baseRevision,
  client,
  onSaved,
  onDirtyChange,
}: AlterTiptapEditorProps) {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedRevision, setSavedRevision] = useState(baseRevision);
  const [status, setStatus] = useState<EditorStatus>({ kind: 'idle' });

  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const loadingRef = useRef(false);
  const oldDocRef = useRef<AlterDoc>(initialDoc);
  const baseRevisionRef = useRef(baseRevision);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const externalToken = `${docId}#${baseRevision}#${initialDoc.revision}`;
  const lastExternalTokenRef = useRef(externalToken);

  const markDirty = useCallback((next: boolean) => {
    if (dirtyRef.current === next) return;
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  // Project the snapshot once per loaded document; re-renders caused by
  // toolbar state must not re-run the AST projection for large documents.
  const projectedContent = useMemo(() => astToTiptap(initialDoc), [initialDoc]);

  const editor = useEditor({
    extensions: editorExtensions,
    content: projectedContent,
    editorProps: {
      attributes: {
        class: styles.tiptap,
        'data-doc-format': 'alter-doc/1',
        'aria-label': '结构化文档正文',
      },
      handleKeyDown: (_view, event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 's'
        ) {
          event.preventDefault();
          void saveRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: () => {
      if (loadingRef.current) return;
      markDirty(true);
    },
  });

  // Adopt external snapshots (initial load, parent-driven refresh, restore)
  // without clobbering the editor while the user is typing.
  useEffect(() => {
    if (lastExternalTokenRef.current === externalToken) return;
    lastExternalTokenRef.current = externalToken;
    oldDocRef.current = initialDoc;
    baseRevisionRef.current = baseRevision;
    setSavedRevision(baseRevision);
    markDirty(false);
    setStatus({ kind: 'idle' });
    loadingRef.current = true;
    editor.commands.setContent(projectedContent, { emitUpdate: false });
    loadingRef.current = false;
  }, [externalToken, editor, projectedContent, baseRevision, markDirty]);

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const handleSave = useCallback(async () => {
    if (savingRef.current) return;
    if (!dirtyRef.current) {
      setStatus({ kind: 'info', message: '没有需要保存的变更。' });
      return;
    }
    const base = baseRevisionRef.current;
    const currentDoc = oldDocRef.current;
    let newDoc: AlterDoc;
    let ops: ReturnType<typeof computeOperations>;
    let savedEditorJson: JSONContent;
    try {
      savedEditorJson = editor.getJSON() as JSONContent;
      newDoc = {
        format: 'alter-doc/1',
        schemaVersion: currentDoc.schemaVersion,
        revision: base,
        blocks: tiptapToBlocks(savedEditorJson),
      };
      ops = computeOperations(currentDoc, newDoc);
    } catch (error) {
      setStatus({ kind: 'error', message: describeEditError(error) });
      return;
    }
    if (ops.length === 0) {
      markDirty(false);
      setStatus({ kind: 'info', message: '没有需要保存的变更。' });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setStatus({ kind: 'info', message: '正在保存…' });
    try {
      const result = await client.applyOperations({
        docId,
        baseRevision: base,
        ops,
        idempotencyKey: createIdempotencyKey(),
      });
      const revision = readRevision(result) ?? base + 1;
      const savedDoc: AlterDoc = { ...newDoc, revision };
      oldDocRef.current = savedDoc;
      baseRevisionRef.current = revision;
      setSavedRevision(revision);
      // The parent will re-render with this revision; do not reset the editor
      // (and its undo history) for our own save echo.
      lastExternalTokenRef.current = `${docId}#${revision}#${revision}`;
      // Keep the surface dirty when the user typed while the request was in
      // flight: those edits are not part of `savedDoc`.
      const stillSame =
        JSON.stringify(editor.getJSON()) === JSON.stringify(savedEditorJson);
      markDirty(!stillSame);
      onSavedRef.current(revision, savedDoc);
      setStatus({
        kind: 'success',
        message: `已保存（revision ${revision}）。`,
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: describeSaveError(error),
        reloadable: true,
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [client, docId, editor, markDirty]);

  saveRef.current = handleSave;

  const handleReload = useCallback(async () => {
    setStatus({ kind: 'info', message: '正在重新加载…' });
    try {
      const snapshot = readSnapshot(await client.get(docId));
      if (snapshot === undefined) {
        throw new Error('服务端返回的文档结构无法识别');
      }
      oldDocRef.current = snapshot.doc;
      baseRevisionRef.current = snapshot.revision;
      setSavedRevision(snapshot.revision);
      loadingRef.current = true;
      editor.commands.setContent(astToTiptap(snapshot.doc), {
        emitUpdate: false,
      });
      loadingRef.current = false;
      markDirty(false);
      setStatus({
        kind: 'success',
        message: `已重新加载（revision ${snapshot.revision}）。`,
      });
    } catch (error) {
      setStatus({ kind: 'error', message: describeSaveError(error) });
    }
  }, [client, docId, editor, markDirty]);

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      strike: current.isActive('strike'),
      highlight: current.isActive('highlight'),
      code: current.isActive('code'),
      heading1: current.isActive('heading', { level: 1 }),
      heading2: current.isActive('heading', { level: 2 }),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      taskList: current.isActive('taskList'),
      blockquote: current.isActive('blockquote'),
      codeBlock: current.isActive('codeBlock'),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });

  const insertCallout = () => {
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'alterCallout',
        attrs: { tone: 'info' },
        content: [{ type: 'paragraph' }],
      })
      .run();
  };

  return (
    <section className={styles.editor} data-doc-editor="tiptap">
      <div className={styles.toolbar} role="toolbar" aria-label="文档编辑工具栏">
        <ToolGroup>
          <ToolButton
            label="B"
            title="粗体"
            active={active.bold}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <ToolButton
            label="I"
            title="斜体"
            active={active.italic}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <ToolButton
            label="U"
            title="下划线"
            active={active.underline}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          />
          <ToolButton
            label="S"
            title="删除线"
            active={active.strike}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
          <ToolButton
            label="高亮"
            title="高亮"
            active={active.highlight}
            onClick={() => editor.chain().focus().toggleHighlight().run()}
          />
          <ToolButton
            label="代码"
            title="行内代码"
            active={active.code}
            onClick={() => editor.chain().focus().toggleCode().run()}
          />
        </ToolGroup>
        <ToolGroup>
          <ToolButton
            label="H1"
            title="一级标题"
            active={active.heading1}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 1 }).run()
            }
          />
          <ToolButton
            label="H2"
            title="二级标题"
            active={active.heading2}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
          />
        </ToolGroup>
        <ToolGroup>
          <ToolButton
            label="无序列表"
            title="无序列表"
            active={active.bulletList}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          />
          <ToolButton
            label="有序列表"
            title="有序列表"
            active={active.orderedList}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          />
          <ToolButton
            label="任务列表"
            title="任务列表"
            active={active.taskList}
            onClick={() => editor.chain().focus().toggleTaskList().run()}
          />
          <ToolButton
            label="引用"
            title="引用块"
            active={active.blockquote}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          />
          <ToolButton
            label="代码块"
            title="代码块"
            active={active.codeBlock}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          />
          <ToolButton
            label="分割线"
            title="插入分割线"
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          />
          <ToolButton
            label="高亮块"
            title="插入高亮信息块"
            onClick={insertCallout}
          />
        </ToolGroup>
        <ToolGroup>
          <ToolButton
            label="撤销"
            title="撤销"
            disabled={!active.canUndo}
            onClick={() => editor.chain().focus().undo().run()}
          />
          <ToolButton
            label="重做"
            title="重做"
            disabled={!active.canRedo}
            onClick={() => editor.chain().focus().redo().run()}
          />
        </ToolGroup>
        <div className={styles.toolbarSpacer} />
        <span
          className={styles.dirtyState}
          data-dirty={dirty ? 'true' : 'false'}
          aria-live="polite"
        >
          {saving ? '保存中…' : dirty ? '未保存' : '已同步'}
        </span>
        <button
          type="button"
          className={styles.saveButton}
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      {status.kind === 'idle' ? null : (
        <div
          className={styles.status}
          data-kind={status.kind}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          <span className={styles.statusText}>{status.message}</span>
          {status.kind === 'error' && status.reloadable === true ? (
            <button
              type="button"
              className={styles.statusAction}
              onClick={() => void handleReload()}
            >
              重新加载
            </button>
          ) : null}
        </div>
      )}

      <div className={styles.surface}>
        <EditorContent editor={editor} className={styles.content} />
      </div>

      <footer className={styles.footer}>
        <span>revision {savedRevision}</span>
        <span className={styles.footerDivider}>·</span>
        <span>保存会转换为 Document Operations（单次最多 {MAX_DIFF_OPERATIONS} 个）</span>
        <span className={styles.footerDivider}>·</span>
        <span>⌘/Ctrl + S 保存</span>
      </footer>
    </section>
  );
}
