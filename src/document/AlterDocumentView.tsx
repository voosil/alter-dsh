/**
 * Structured renderer/editor for Space documents.
 *
 * Every note is an `alter-doc/1` AST document: the view loads the canonical
 * snapshot over the document RPC and hands it to the Tiptap surface, which
 * autosaves through Document Operations. The view owns the document shell —
 * directory entry, breadcrumbs, the auto-growing title (autosaved with the
 * body), document menu, metadata/archive state, workbench entry and the
 * comments/history panel.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Download,
  FilePlus2,
  Link2,
  MessageSquare,
} from 'lucide-react';
import type { MenuAction } from '@alter/ui-system';
import type { Comment, CommentAnchor, SpaceNode } from '@alter/protocol';
import { DirectoryButton } from '../../vendor/ui-space/src/components/DirectoryButton';
import { useSpaceContext } from '../../vendor/ui-space/src/runtime';
import { displayTitle } from '../../vendor/ui-space/src/utils/tree';
import { documentClientOf } from './client-access';
import {
  anchorText,
  CommentRail,
  isCommentAnchorValid,
  sortCommentsByAnchor,
} from './comments';
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
import {
  copyDocumentLink,
  createChildDocument,
  DocumentBreadcrumbs,
  DocumentMenu,
  DocumentMeta,
  DocumentTitle,
  downloadMarkdownFile,
  readDocumentMarkdown,
  WorkbenchEntry,
} from './shell';
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
export function AlterDocumentView({
  node,
  embedded = false,
}: {
  node: SpaceNode;
  /** Rendered inside a Workbench preview pane: no directory entry. */
  embedded?: boolean;
}) {
  const {
    service,
    router,
    space,
    spaceId,
    nodes,
    refresh,
    toast,
    addNodeToState,
    workbench,
  } = useSpaceContext();
  const client = documentClientOf(service);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [title, setTitle] = useState(node.title);
  const [panelOpen, setPanelOpen] = useState(false);
  const [banner, setBanner] = useState<DraftBanner | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [restore, setRestore] = useState<EditorRestoreRequest | null>(null);
  const [archived, setArchived] = useState(node.archived);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<
    (CommentAnchor & { quote: string }) | null
  >(null);
  const [pendingDraft, setPendingDraft] = useState(false);

  const loadedRef = useRef(false);
  const titleEditedRef = useRef(false);
  const commentsRef = useRef<Comment[]>([]);
  commentsRef.current = comments;
  const pendingDraftRef = useRef(false);
  pendingDraftRef.current = pendingDraft;

  useEffect(() => {
    setArchived(node.archived);
  }, [node.archived]);

  // Opening a document clears its unread state in the Space app (old view
  // behaviour). Guarded: the document shell must render even when a minimal
  // SpaceService stub lacks `recordOpen` (unit tests, older assemblies).
  useEffect(() => {
    const recordOpen = service.recordOpen;
    if (typeof recordOpen !== 'function') return;
    let alive = true;
    void recordOpen
      .call(service, node.id)
      .then(() => {
        if (!alive) return;
        try {
          refresh();
        } catch {
          // Refreshing the node list is best effort; unread state is cosmetic.
        }
      })
      .catch(() => {
        // Opening the document must not fail because the read receipt failed.
      });
    return () => {
      alive = false;
    };
  }, [service, node.id, refresh]);

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

  const reloadComments = useCallback(async () => {
    const listComments = service.listComments;
    if (typeof listComments !== 'function') return;
    try {
      setComments(await listComments.call(service, node.id));
    } catch (error) {
      toast(`评论加载失败：${describeError(error)}`);
    }
  }, [service, node.id, toast]);

  useEffect(() => {
    void reloadComments();
  }, [reloadComments]);

  /** Comment ids whose stored anchor no longer points inside the document. */
  const invalidCommentIds = useMemo(() => {
    const invalid = new Set<string>();
    if (state.kind !== 'ready') return invalid;
    for (const comment of comments) {
      if (
        comment.anchor !== null &&
        comment.anchor !== undefined &&
        !isCommentAnchorValid(state.snapshot.doc, comment.anchor)
      )
        invalid.add(comment.id);
    }
    return invalid;
  }, [comments, state]);

  const sortedComments = useMemo(
    () =>
      sortCommentsByAnchor(
        comments,
        state.kind === 'ready' ? state.snapshot.doc : undefined,
      ),
    [comments, state],
  );

  /** Markers handed to the editor for in-body comment highlighting. */
  const commentMarkers = useMemo(
    () =>
      sortedComments
        .filter(
          (comment) =>
            comment.status === 'open' &&
            comment.anchor !== null &&
            comment.anchor !== undefined &&
            !invalidCommentIds.has(comment.id),
        )
        .map((comment) => ({
          id: comment.id,
          anchor: comment.anchor as CommentAnchor,
        })),
    [sortedComments, invalidCommentIds],
  );

  const openCommentCount = comments.filter(
    (comment) => comment.status === 'open',
  ).length;

  /** Keep stored quotes in sync with the text currently under each anchor. */
  const syncCommentQuotes = useCallback(
    (doc: AlterDoc) => {
      const updates: { id: string; quote: string }[] = [];
      for (const comment of commentsRef.current) {
        if (comment.anchor == null || comment.status !== 'open') continue;
        const text = anchorText(doc, comment.anchor);
        if (text === undefined || text === '' || text === comment.quote) continue;
        updates.push({ id: comment.id, quote: text });
      }
      if (updates.length === 0) return;
      void (async () => {
        let changed = false;
        for (const update of updates) {
          try {
            await service.updateComment(update.id, { quote: update.quote });
            changed = true;
          } catch {
            // A failed quote refresh must not disturb editing or saving.
          }
        }
        if (changed) await reloadComments();
      })();
    },
    [service, reloadComments],
  );

  const handleCommentAnchorChange = useCallback(
    (next: (CommentAnchor & { quote: string }) | null) => {
      if (next === null) {
        if (!pendingDraftRef.current) setPendingAnchor(null);
        return;
      }
      setPendingAnchor(next);
      setCommentsOpen(true);
    },
    [],
  );

  const handleCommentClick = useCallback((id: string) => {
    setActiveCommentId(id);
    setCommentsOpen(true);
  }, []);

  const cancelPendingComment = useCallback(() => {
    setPendingAnchor(null);
    setPendingDraft(false);
  }, []);

  const addPendingComment = useCallback(
    async (body: string) => {
      const anchor = pendingAnchor;
      await service.addComment({
        docId: node.id,
        body,
        quote: anchor === null ? null : anchor.quote,
        anchor:
          anchor === null
            ? null
            : {
                blockId: anchor.blockId,
                offset: anchor.offset,
                length: anchor.length,
              },
      });
      setPendingAnchor(null);
      setPendingDraft(false);
      await reloadComments();
    },
    [service, node.id, pendingAnchor, reloadComments],
  );

  const approveComment = useCallback(
    async (id: string) => {
      await service.resolveComment(id);
      await reloadComments();
    },
    [service, reloadComments],
  );

  const editComment = useCallback(
    async (id: string, body: string) => {
      await service.updateComment(id, { body });
      await reloadComments();
    },
    [service, reloadComments],
  );

  const supplementComment = useCallback(
    async (id: string, body: string) => {
      await service.addCommentSupplement(id, body);
      await reloadComments();
    },
    [service, reloadComments],
  );

  const deleteComment = useCallback(
    async (id: string) => {
      await service.deleteComment(id);
      await reloadComments();
    },
    [service, reloadComments],
  );

  /**
   * Activate one comment; the editor selects and scrolls to the matching
   * highlight when `activeCommentId` changes.
   */
  const locateComment = useCallback((comment: Comment) => {
    setActiveCommentId(comment.id);
  }, []);

  const handleSaved = (revision: number, doc: AlterDoc, savedTitle: string) => {
    setState((current) =>
      current.kind === 'ready'
        ? {
            kind: 'ready',
            snapshot: { ...current.snapshot, revision, doc, title: savedTitle },
          }
        : current,
    );
    syncCommentQuotes(doc);
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

  const copyLink = async () => {
    const copied = await copyDocumentLink(spaceId, node.id);
    toast(copied ? '链接已复制' : '复制失败，请检查浏览器权限');
  };

  const createChild = async () => {
    try {
      await createChildDocument({
        service,
        router,
        spaceId,
        parentId: node.id,
        addNodeToState,
        refresh,
      });
    } catch (error) {
      toast(`新建子文档失败：${describeError(error)}`);
    }
  };

  const exportMarkdown = async () => {
    if (client === undefined) {
      toast('文档模型客户端未装配：请刷新页面或重新安装插件');
      return;
    }
    try {
      const result = await readDocumentMarkdown(client, node.id);
      downloadMarkdownFile(title.trim() || node.title, result.markdown);
      toast(
        result.truncated
          ? '文档过长，Markdown 已导出（内容已截断）'
          : 'Markdown 已导出',
      );
    } catch (error) {
      toast(`导出失败：${describeError(error)}`);
    }
  };

  const setDocumentArchived = async (next: boolean) => {
    try {
      await service.setArchived(node.id, next);
      setArchived(next);
      refresh();
      toast(next ? '已归档' : '已恢复');
    } catch (error) {
      toast(`${next ? '归档' : '恢复'}失败：${describeError(error)}`);
    }
  };

  const menuActions: MenuAction[] = [
    {
      id: 'copy-link',
      label: '复制链接',
      icon: <Link2 />,
      onSelect: () => void copyLink(),
    },
    {
      id: 'new-child',
      label: '新建子文档',
      icon: <FilePlus2 />,
      onSelect: () => void createChild(),
    },
    {
      id: 'export-markdown',
      label: '导出 Markdown',
      icon: <Download />,
      separatorBefore: true,
      onSelect: () => void exportMarkdown(),
    },
    archived
      ? {
          id: 'unarchive',
          label: '取消归档',
          icon: <ArchiveRestore />,
          separatorBefore: true,
          onSelect: () => void setDocumentArchived(false),
        }
      : {
          id: 'archive',
          label: '归档',
          icon: <Archive />,
          separatorBefore: true,
          onSelect: () => void setDocumentArchived(true),
        },
  ];

  const titleLocked = banner !== null;

  return (
    <article
      className={styles.page}
      data-doc-format="alter-doc/1"
      aria-label={displayTitle(title)}
    >
      <header className={styles.header}>
        <div className={styles.toolbar}>
          {embedded ? null : <DirectoryButton />}
          <DocumentBreadcrumbs
            spaceId={spaceId}
            spaceName={space.name}
            nodes={nodes}
            docId={node.id}
            title={title}
            onNavigate={(path) => router.navigate(path)}
          />
          <div className={styles.actions}>
            {workbench === undefined ? null : (
              <WorkbenchEntry
                controller={workbench.controller}
                scopeKey={workbench.scopeKey}
              />
            )}
            <button
              type="button"
              className={
                commentsOpen ? styles.panelToggleActive : styles.panelToggle
              }
              aria-pressed={commentsOpen}
              aria-label="评论"
              title="评论"
              onClick={() => setCommentsOpen((open) => !open)}
            >
              <MessageSquare size={13} strokeWidth={1.7} aria-hidden="true" />
              评论
              {openCommentCount > 0 ? (
                <span className={styles.commentCount}>{openCommentCount}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={panelOpen ? styles.panelToggleActive : styles.panelToggle}
              aria-pressed={panelOpen}
              onClick={() => setPanelOpen((open) => !open)}
            >
              评论与历史
            </button>
            <DocumentMenu actions={menuActions} />
          </div>
        </div>
        <div className={styles.titleBlock}>
          <DocumentTitle
            value={title}
            disabled={titleLocked}
            onChange={(next) => {
              titleEditedRef.current = true;
              setTitle(next);
            }}
            onBlur={() => {
              if (title.trim() !== '') return;
              setTitle(
                state.kind === 'ready' ? state.snapshot.title : node.title,
              );
              titleEditedRef.current = false;
            }}
          />
          <DocumentMeta
            creator={node.creator}
            updatedAt={node.updatedAt}
            revision={
              state.kind === 'ready' ? state.snapshot.revision : undefined
            }
            archived={archived}
            onRestore={() => void setDocumentArchived(false)}
          />
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
              commentMarkers={commentMarkers}
              activeCommentId={activeCommentId}
              onCommentAnchorChange={handleCommentAnchorChange}
              onCommentClick={handleCommentClick}
            />
          )}
        </div>
        {commentsOpen ? (
          <CommentRail
            comments={sortedComments}
            activeCommentId={activeCommentId}
            invalidCommentIds={invalidCommentIds}
            pendingQuote={pendingAnchor === null ? null : pendingAnchor.quote}
            onActivate={setActiveCommentId}
            onAddPending={addPendingComment}
            onCancelPending={cancelPendingComment}
            onPendingDraftChange={setPendingDraft}
            onApprove={approveComment}
            onEdit={editComment}
            onSupplement={supplementComment}
            onDelete={deleteComment}
            onLocate={locateComment}
          />
        ) : null}
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
