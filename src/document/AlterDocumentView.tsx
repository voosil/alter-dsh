/**
 * Structured renderer/editor for Space documents.
 *
 * Every note is an `alter-doc/1` AST document: the view loads the canonical
 * snapshot over the document RPC and hands it to the Tiptap surface, which
 * autosaves through Document Operations. The view owns the document shell:
 * the title input (autosaved with the body), the crash-draft recovery banner
 * and the comments/history panel.
 *
 * Draft recovery contract (P0):
 * - a draft whose `baseRevision` matches the server revision offers
 *   「恢复 / 丢弃」;
 * - a draft based on an older revision means the server changed meanwhile, so
 *   the banner offers 「保留本地草稿并重新加载 / 丢弃草稿」 and never drops the
 *   local content silently;
 * - while a banner is open the body/title stay read-only so nothing is
 *   overwritten before the user chooses.
 *
 * @module @alter-dsh/space/document/AlterDocumentView
 */
import { useEffect, useRef, useState } from 'react';
import type { SpaceNode } from '@alter/protocol';
import { useSpaceContext } from '../../vendor/ui-space/src/runtime';
import { documentClientOf } from './client-access';
import {
  AlterTiptapEditor,
  astToTiptap,
  type EditorRestoreRequest,
} from './editor';
import {
  clearDocumentDraft,
  documentDraftMatchesSnapshot,
  readDocumentDraft,
  type DocumentDraft,
} from './editor/draft';
import { DocumentSidePanel } from './DocumentSidePanel';
import type { AlterDoc, DocumentSnapshot } from './types';
import styles from './AlterDocumentView.module.css';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; snapshot: DocumentSnapshot };

type DraftBanner =
  | { kind: 'draft'; draft: DocumentDraft }
  | { kind: 'conflict'; draft: DocumentDraft; serverRevision: number };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Structured renderer/editor for one Space note.
 */
export function AlterDocumentView({ node }: { node: SpaceNode }) {
  const { service } = useSpaceContext();
  const client = documentClientOf(service);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [title, setTitle] = useState(node.title);
  const [panelOpen, setPanelOpen] = useState(false);
  const [banner, setBanner] = useState<DraftBanner | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [restore, setRestore] = useState<EditorRestoreRequest | null>(null);

  const loadedRef = useRef(false);
  const titleEditedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    if (client === undefined) {
      setState({
        kind: 'error',
        message: '文档模型客户端未装配：请刷新页面或重新安装插件',
      });
      return () => {
        alive = false;
      };
    }
    setState({ kind: 'loading' });
    void client
      .get(node.id)
      .then((value) => {
        if (!alive) return;
        const snapshot = value as DocumentSnapshot;
        setState({ kind: 'ready', snapshot });
        if (loadedRef.current) return;
        loadedRef.current = true;
        if (!titleEditedRef.current) setTitle(snapshot.title);
        const draft = readDocumentDraft(node.id);
        if (draft === undefined) return;
        if (documentDraftMatchesSnapshot(draft, snapshot)) {
          // The save actually landed but the receipt was lost: nothing to do.
          clearDocumentDraft(node.id);
          return;
        }
        if (draft.baseRevision === snapshot.revision) {
          setBanner({ kind: 'draft', draft });
        } else {
          setBanner({
            kind: 'conflict',
            draft,
            serverRevision: snapshot.revision,
          });
        }
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setState({ kind: 'error', message: describeError(error) });
      });
    return () => {
      alive = false;
    };
  }, [service, node.id, node.updatedAt]);

  const handleSaved = (revision: number, doc: AlterDoc, savedTitle: string) => {
    setState((current) =>
      current.kind === 'ready'
        ? {
            kind: 'ready',
            snapshot: { ...current.snapshot, revision, doc, title: savedTitle },
          }
        : current,
    );
  };

  const handleRestoreDraft = () => {
    if (banner?.kind !== 'draft' || state.kind !== 'ready') return;
    setRestore({ editor: banner.draft.editor, revision: state.snapshot.revision });
    setTitle(banner.draft.title);
    titleEditedRef.current = true;
    setBanner(null);
    setBannerError(null);
  };

  const handleDiscardDraft = () => {
    if (banner === null) return;
    if (banner.kind === 'draft') {
      clearDocumentDraft(node.id);
      if (state.kind === 'ready') {
        // Revert the surface to the snapshot that is already loaded.
        setRestore({
          editor: astToTiptap(state.snapshot.doc),
          revision: state.snapshot.revision,
        });
        setTitle(state.snapshot.title);
      }
      setBanner(null);
      setBannerError(null);
      return;
    }
    if (client === undefined) return;
    void client
      .get(node.id)
      .then((value) => {
        const snapshot = value as DocumentSnapshot;
        clearDocumentDraft(node.id);
        setState({ kind: 'ready', snapshot });
        setTitle(snapshot.title);
        titleEditedRef.current = false;
        setRestore(null);
        setBanner(null);
        setBannerError(null);
      })
      .catch((error: unknown) => {
        setBannerError(describeError(error));
      });
  };

  const handleKeepConflictDraft = () => {
    if (banner?.kind !== 'conflict' || client === undefined) return;
    const draft = banner.draft;
    void client
      .get(node.id)
      .then((value) => {
        const snapshot = value as DocumentSnapshot;
        // Adopt the latest revision as the new CAS base, then keep the local
        // draft on top of it so the next autosave writes the user's content.
        setState({ kind: 'ready', snapshot });
        setTitle(draft.title);
        titleEditedRef.current = true;
        setRestore({ editor: draft.editor, revision: snapshot.revision });
        setBanner(null);
        setBannerError(null);
      })
      .catch((error: unknown) => {
        setBannerError(describeError(error));
      });
  };

  const handleRestored = (revision: number) => {
    const nextClient = documentClientOf(service);
    if (nextClient === undefined) return;
    void nextClient
      .get(node.id)
      .then((value) => {
        const snapshot = value as DocumentSnapshot;
        setState({ kind: 'ready', snapshot });
        setTitle(snapshot.title);
        titleEditedRef.current = false;
        setRestore(null);
      })
      .catch(() => {
        setState((current) =>
          current.kind === 'ready'
            ? { kind: 'ready', snapshot: { ...current.snapshot, revision } }
            : current,
        );
      });
  };

  const titleLocked = banner !== null;

  return (
    <article className={styles.page} data-doc-format="alter-doc/1">
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <input
            className={styles.titleInput}
            value={title}
            aria-label="文档标题"
            disabled={titleLocked}
            onChange={(event) => {
              titleEditedRef.current = true;
              setTitle(event.target.value);
            }}
            onBlur={() => {
              if (title.trim() !== '') return;
              setTitle(
                state.kind === 'ready' ? state.snapshot.title : node.title,
              );
              titleEditedRef.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <span className={styles.badge}>结构化文档</span>
          <button
            type="button"
            className={panelOpen ? styles.panelToggleActive : styles.panelToggle}
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen((open) => !open)}
          >
            评论与历史
          </button>
        </div>
        <div className={styles.meta}>
          {state.kind === 'ready'
            ? `revision ${state.snapshot.revision}`
            : state.kind === 'error'
              ? '加载失败'
              : '正在加载…'}
        </div>
      </header>
      <div className={styles.bodyRow}>
        <div className={styles.body}>
          {banner !== null ? (
            <div
              className={styles.draftBanner}
              data-kind={banner.kind}
              role="status"
            >
              <span className={styles.draftText}>
                {banner.kind === 'draft'
                  ? '检测到未保存草稿，可恢复本地内容或丢弃。'
                  : '检测到未保存草稿，但服务端已有更新。请保留本地草稿并重新加载，或丢弃草稿。'}
              </span>
              <span className={styles.draftActions}>
                {banner.kind === 'draft' ? (
                  <button
                    type="button"
                    className={styles.draftAction}
                    onClick={handleRestoreDraft}
                  >
                    恢复
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.draftAction}
                    onClick={handleKeepConflictDraft}
                  >
                    保留本地草稿并重新加载
                  </button>
                )}
                <button
                  type="button"
                  className={styles.draftAction}
                  onClick={handleDiscardDraft}
                >
                  {banner.kind === 'draft' ? '丢弃' : '丢弃草稿'}
                </button>
              </span>
              {bannerError === null ? null : (
                <span className={styles.draftError}>{bannerError}</span>
              )}
            </div>
          ) : null}
          {state.kind === 'loading' ? (
            <div className={styles.state}>正在读取结构化文档…</div>
          ) : state.kind === 'error' ? (
            <div className={styles.error} role="alert">
              无法加载文档：{state.message}
            </div>
          ) : client === undefined ? (
            <div className={styles.error} role="alert">
              文档模型客户端未装配：请刷新页面或重新安装插件
            </div>
          ) : (
            <AlterTiptapEditor
              key={node.id}
              docId={node.id}
              initialDoc={state.snapshot.doc}
              baseRevision={state.snapshot.revision}
              initialTitle={state.snapshot.title}
              title={title}
              client={client}
              saveTitle={(next) =>
                service.saveNode(node.id, { title: next }).then(() => undefined)
              }
              onSaved={handleSaved}
              onAdoptTitle={(next) => setTitle(next)}
              restore={restore}
              readOnly={titleLocked}
            />
          )}
        </div>
        {panelOpen && state.kind === 'ready' && client !== undefined ? (
          <DocumentSidePanel
            docId={node.id}
            revision={state.snapshot.revision}
            service={service}
            client={client}
            onRestored={handleRestored}
          />
        ) : null}
      </div>
    </article>
  );
}
