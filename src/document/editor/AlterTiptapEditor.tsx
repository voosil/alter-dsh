/**
 * Editable Tiptap surface for AST-backed Space documents.
 *
 * The component owns the editing interaction and the P0 save lifecycle: it
 * projects the Host `AlterDoc` into Tiptap (see `mapping.ts`), lets the user
 * edit, and autosaves through the schedule/pipeline in `autosave.ts`:
 *
 * - edits (body or title) are debounced ~700ms and saved silently;
 * - only one save request is in flight; edits made meanwhile queue the next
 *   cycle and the receipt never overwrites them;
 * - a failed save keeps the local content, persists a draft and shows a
 *   「保存失败，重试」action; a `doc/conflict` is reconciled against the Host
 *   snapshot first and otherwise kept as a draft with actionable next steps;
 * - switching documents / hiding the page flushes, and a crash draft is
 *   recovered by `AlterDocumentView`.
 *
 * External snapshots (parent refresh, version restore, draft recovery) are
 * adopted without recreating the editor, so cursor, selection and undo history
 * survive a save.
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
import type { AlterDoc } from '../types';
import {
  createAutosaveController,
  createDocumentSaver,
  describeSaveError,
  readSnapshot,
  type AutosaveController,
  type AutosaveStatus,
  type DocumentSaver,
  type DocumentSnapshotLike,
} from './autosave';
import {
  DRAFT_FORMAT,
  clearDocumentDraft,
  writeDocumentDraft,
} from './draft';
import { astToTiptap } from './mapping';
import { editorExtensions } from './schema';
import styles from './AlterTiptapEditor.module.css';

/** A draft injected into the editor by the surrounding view. */
export interface EditorRestoreRequest {
  /** Exact Tiptap JSON of the draft to restore. */
  editor: JSONContent;
  /** Revision the restored content must be saved against. */
  revision: number;
}

/** Props of the editable document surface. */
export interface AlterTiptapEditorProps {
  /** Space node id of the document. */
  docId: string;
  /** Canonical document snapshot loaded from the Host. */
  initialDoc: AlterDoc;
  /** Revision the snapshot was loaded at; used as the CAS base. */
  baseRevision: number;
  /** Server title of the loaded snapshot (title-diff baseline). */
  initialTitle: string;
  /** Controlled title; changes are autosaved together with the body. */
  title: string;
  /** Document RPC client (see `SpaceDocumentClient`). */
  client: SpaceDocumentClient;
  /** Persist the title through `space.saveNode` (metadata only). */
  saveTitle?: (title: string) => Promise<unknown>;
  /** Called after a confirmed save with the new revision and document. */
  onSaved: (revision: number, doc: AlterDoc, title: string) => void;
  /** Ask the view to adopt a server-side title (reload/discard actions). */
  onAdoptTitle?: (title: string) => void;
  /** Draft content to inject (view recovery banner). */
  restore?: EditorRestoreRequest | null;
  /** Read-only while the view resolves a draft banner. */
  readOnly?: boolean;
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
  initialTitle,
  title,
  client,
  saveTitle,
  onSaved,
  onAdoptTitle,
  restore,
  readOnly = false,
}: AlterTiptapEditorProps) {
  const [status, setStatus] = useState<AutosaveStatus>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);

  const loadingRef = useRef(false);
  const disposedRef = useRef(false);
  const latestEditorJsonRef = useRef<JSONContent | undefined>(undefined);
  const currentTitleRef = useRef(title);
  currentTitleRef.current = title;
  const lastSeenTitleRef = useRef(initialTitle);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onAdoptTitleRef = useRef(onAdoptTitle);
  onAdoptTitleRef.current = onAdoptTitle;
  const saveTitleRef = useRef(saveTitle);
  saveTitleRef.current = saveTitle;
  const clientRef = useRef(client);
  clientRef.current = client;

  const externalToken = `${docId}#${baseRevision}#${initialDoc.revision}`;
  const lastExternalTokenRef = useRef(externalToken);

  // Project the snapshot once per loaded document; re-renders caused by
  // toolbar state must not re-run the AST projection for large documents.
  const projectedContent = useMemo(() => astToTiptap(initialDoc), [initialDoc]);
  if (latestEditorJsonRef.current === undefined) {
    latestEditorJsonRef.current = projectedContent;
  }

  // Save pipeline + scheduler are created once per mounted document. Their
  // callbacks read refs, so they always see the latest editor/title state.
  const saverRef = useRef<DocumentSaver | null>(null);
  if (saverRef.current === null) {
    saverRef.current = createDocumentSaver({
      docId,
      client,
      initialDoc,
      baseRevision,
      initialTitle,
      getEditorJson: () => latestEditorJsonRef.current,
      getTitle: () => currentTitleRef.current,
      saveTitle: (next) =>
        saveTitleRef.current === undefined
          ? Promise.resolve()
          : saveTitleRef.current(next),
      onSaved: (revision, doc, savedTitle) => {
        // Our own save echo must not be treated as an external snapshot.
        lastExternalTokenRef.current = `${docId}#${revision}#${revision}`;
        if (disposedRef.current) return;
        onSavedRef.current(revision, doc, savedTitle);
      },
    });
  }
  const saver = saverRef.current;

  const controllerRef = useRef<AutosaveController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createAutosaveController({
      captureDraft: () => {
        const editorJson = latestEditorJsonRef.current;
        if (editorJson === undefined) return undefined;
        const { baseRevision: base, savedRevision } = saverRef.current!.context();
        return {
          format: DRAFT_FORMAT,
          docId,
          title: currentTitleRef.current,
          editor: editorJson,
          baseRevision: base,
          savedRevision,
        };
      },
      writeDraft: (draft) => writeDocumentDraft(draft),
      clearDraft: () => clearDocumentDraft(docId),
      save: () => saverRef.current!.save(),
      onStatus: (next) => {
        if (disposedRef.current) return;
        setStatus(next);
        setDirty(next.kind !== 'idle');
      },
    });
  }
  const controller = controllerRef.current;

  const editor = useEditor({
    extensions: editorExtensions,
    content: projectedContent,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: styles.tiptap,
        'data-doc-format': 'alter-doc/1',
        'aria-label': '结构化文档正文',
      },
    },
    onUpdate: () => {
      if (loadingRef.current) return;
      latestEditorJsonRef.current = editor.getJSON() as JSONContent;
      controller.notifyChange();
    },
  });

  // Adopt external snapshots (initial load, parent-driven refresh, restore)
  // without clobbering the editor while the user is typing.
  useEffect(() => {
    if (lastExternalTokenRef.current === externalToken) return;
    lastExternalTokenRef.current = externalToken;
    saver.adopt(initialDoc, baseRevision, initialTitle);
    lastSeenTitleRef.current = initialTitle;
    latestEditorJsonRef.current = projectedContent;
    controller.reset();
    loadingRef.current = true;
    editor.commands.setContent(projectedContent, { emitUpdate: false });
    loadingRef.current = false;
  }, [
    externalToken,
    editor,
    projectedContent,
    baseRevision,
    initialTitle,
    initialDoc,
    saver,
    controller,
  ]);

  // Title edits go through the same debounced save cycle as the body.
  useEffect(() => {
    if (title === lastSeenTitleRef.current) return;
    lastSeenTitleRef.current = title;
    controller.notifyChange();
  }, [title, controller]);

  // A draft chosen in the view's recovery banner is injected here.
  const appliedRestoreRef = useRef<EditorRestoreRequest | null>(null);
  useEffect(() => {
    if (restore === null || restore === undefined) {
      appliedRestoreRef.current = null;
      return;
    }
    if (appliedRestoreRef.current === restore) return;
    appliedRestoreRef.current = restore;
    loadingRef.current = true;
    editor.commands.setContent(restore.editor, { emitUpdate: false });
    loadingRef.current = false;
    latestEditorJsonRef.current = restore.editor;
    controller.notifyChange();
  }, [restore, editor, controller]);

  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // Cmd/Ctrl+S flushes immediately; leaving/hiding the page saves or drafts.
  useEffect(() => {
    const flush = (): void => {
      void controller.flush();
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onPageHide = (): void => flush();
    const onBeforeUnload = (event: Event): void => {
      if (!controller.hasPending()) return;
      controller.persistDraftNow();
      event.preventDefault();
      (event as unknown as { returnValue?: string }).returnValue = '';
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        flush();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [controller]);

  // Switching documents / unmounting: persist the draft and try one last save.
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      controller.dispose();
    };
  }, [controller]);

  /** Replace the editor content with a freshly loaded Host snapshot. */
  const applyServerSnapshot = useCallback(
    (snapshot: DocumentSnapshotLike): void => {
      const nextTitle = snapshot.title ?? lastSeenTitleRef.current;
      saver.adopt(snapshot.doc, snapshot.revision, nextTitle);
      lastSeenTitleRef.current = nextTitle;
      lastExternalTokenRef.current = `${docId}#${snapshot.revision}#${snapshot.revision}`;
      const nextContent = astToTiptap(snapshot.doc);
      latestEditorJsonRef.current = nextContent;
      loadingRef.current = true;
      editor.commands.setContent(nextContent, { emitUpdate: false });
      loadingRef.current = false;
      controller.reset();
      if (!disposedRef.current) {
        onSavedRef.current(snapshot.revision, snapshot.doc, nextTitle);
        onAdoptTitleRef.current?.(nextTitle);
      }
    },
    [controller, docId, editor, saver],
  );

  const handleRetry = useCallback(() => {
    void controller.retry();
  }, [controller]);

  const handleReload = useCallback(async () => {
    try {
      const snapshot = readSnapshot(await clientRef.current.get(docId));
      if (snapshot === undefined) {
        throw new Error('服务端返回的文档结构无法识别');
      }
      applyServerSnapshot(snapshot);
    } catch (error) {
      controller.fail(describeSaveError(error));
    }
  }, [applyServerSnapshot, controller, docId]);

  // Conflict: keep the local content, adopt the latest Host revision as the
  // new CAS base and save the local content over it (explicit user choice).
  const handleKeepLocal = useCallback(async () => {
    try {
      const snapshot = readSnapshot(await clientRef.current.get(docId));
      if (snapshot === undefined) {
        throw new Error('服务端返回的文档结构无法识别');
      }
      const nextTitle = snapshot.title ?? lastSeenTitleRef.current;
      saver.adopt(snapshot.doc, snapshot.revision, nextTitle);
      lastExternalTokenRef.current = `${docId}#${snapshot.revision}#${snapshot.revision}`;
      if (!disposedRef.current) {
        onSavedRef.current(snapshot.revision, snapshot.doc, nextTitle);
      }
      await controller.retry();
    } catch (error) {
      controller.fail(describeSaveError(error));
    }
  }, [controller, docId, saver]);

  // Conflict: drop the local content and load the current Host document.
  const handleDiscardLocal = useCallback(async () => {
    try {
      const snapshot = readSnapshot(await clientRef.current.get(docId));
      if (snapshot === undefined) {
        throw new Error('服务端返回的文档结构无法识别');
      }
      clearDocumentDraft(docId);
      applyServerSnapshot(snapshot);
    } catch (error) {
      controller.fail(describeSaveError(error));
    }
  }, [applyServerSnapshot, docId]);

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
    <section className={styles.editor} data-doc-editor="tiptap" data-dirty={dirty ? 'true' : 'false'}>
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
        {status.kind === 'saving' ? (
          <span className={styles.savingHint}>保存中…</span>
        ) : null}
      </div>

      {status.kind === 'failed' ? (
        <div className={styles.status} data-kind="error" role="alert">
          <span className={styles.statusText}>{status.message}</span>
          <button
            type="button"
            className={styles.statusAction}
            onClick={handleRetry}
          >
            保存失败，重试
          </button>
          <button
            type="button"
            className={styles.statusAction}
            onClick={() => void handleReload()}
          >
            重新加载
          </button>
        </div>
      ) : status.kind === 'conflict' ? (
        <div className={styles.status} data-kind="conflict" role="alert">
          <span className={styles.statusText}>{status.message}</span>
          <button
            type="button"
            className={styles.statusAction}
            onClick={() => void handleKeepLocal()}
          >
            保留本地草稿并重新加载
          </button>
          <button
            type="button"
            className={styles.statusAction}
            onClick={() => void handleDiscardLocal()}
          >
            丢弃草稿
          </button>
        </div>
      ) : null}

      <div className={styles.surface}>
        <EditorContent editor={editor} className={styles.content} />
      </div>
    </section>
  );
}
