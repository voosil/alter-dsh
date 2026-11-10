import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Download,
  FilePlus2,
  FileText,
  History,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import type { Comment, SpaceNode } from '@alter/protocol';
import {
  alterDocToEditorHtml,
  anchorForQuote,
  clearLegacyDraft,
  createLegacySaveController,
  legacyDraftMatchesSnapshot,
  parseDocumentContent,
  parseLegacyHtml,
  readDocumentSnapshot,
  readLegacyDraft,
  serializeDocument,
  type AlterDoc,
  type LegacyDocumentDraft,
  type LegacySaveController,
  type LegacySaveSnapshot,
} from '@alter-space/legacy-adapter';
import { useSpaceContext } from '../runtime';
import { documentModelOf } from '../document-model';
import { docPath, overviewPath } from '../space-route';
import { ancestorsOf, displayTitle } from '../utils/tree';
import { formatRelativeTime } from '../utils/date';
import { downloadMarkdown } from '../utils/markdown';
import { Editor } from '../components/editor/Editor';
import { CommentRail } from '../components/CommentRail';
import { DocumentComments } from '../components/DocumentComments';
import { HistoryPanel } from '../components/HistoryPanel';
import { HistoryCommentsModal } from '../components/HistoryCommentsModal';
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  type MenuAction,
} from '@alter/ui-system';
import { WorkbenchToggle } from '@alter/ui-workbench';
import { DirectoryButton } from '../components/DirectoryButton';
import styles from './DocumentView.module.css';

interface PendingQuoteSave {
  timer: number;
  quote: string;
}

function hasBodyContent(html: string) {
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
  return (
    text.length > 0 || /<(img|video|audio|iframe|figure|table|hr)\b/i.test(html)
  );
}

/** Empty AST document used when stored content cannot be parsed. */
const EMPTY_AST: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [],
};

/** Parse stored `node.content` (always `alter-doc/1`) defensively. */
function astOf(content: string): AlterDoc {
  return parseDocumentContent(content) ?? EMPTY_AST;
}

export function DocumentView({
  node,
  embedded = false,
}: {
  node: SpaceNode;
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
    updateNodeInState,
    workbench,
    openWeb,
  } = useSpaceContext();
  // The document body is an `alter-doc/1` AST; the restored editor still works
  // on HTML, so the adapter projects it once per mounted document.
  const mountDocRef = useRef<AlterDoc | null>(null);
  if (mountDocRef.current === null) mountDocRef.current = astOf(node.content);
  const mountDoc = mountDocRef.current;
  const mountHtml = useMemo(
    () =>
      alterDocToEditorHtml(mountDoc, {
        docPath: (docId) => docPath(spaceId, docId),
      }),
    [mountDoc, spaceId],
  );
  const [title, setTitle] = useState(node.title);
  const [editorHtml, setEditorHtml] = useState(mountHtml);
  const [revision, setRevision] = useState(mountDoc.revision);
  const [bodyHasContent, setBodyHasContent] = useState(() =>
    hasBodyContent(mountHtml),
  );
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [footerTab, setFooterTab] = useState<'children' | 'comments'>(
    'children',
  );
  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  const [pendingDraftHasContent, setPendingDraftHasContent] = useState(false);
  const [caretCommentId, setCaretCommentId] = useState<string | null>(null);
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyCommentsOpen, setHistoryCommentsOpen] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>(
    'saved',
  );
  const [conflictPrompt, setConflictPrompt] = useState<{
    message: string;
    serverRevision?: number;
  } | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<{
    draft: LegacyDocumentDraft;
    kind: 'same' | 'conflict';
    latest?: LegacySaveSnapshot;
  } | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const childrenTabRef = useRef<HTMLButtonElement>(null);
  const commentsTabRef = useRef<HTMLButtonElement>(null);
  const draftRef = useRef({ title: node.title, content: mountHtml });
  const lastSavedDocRef = useRef<AlterDoc>(mountDoc);
  const baseRevisionRef = useRef(mountDoc.revision);
  const lastSavedTitleRef = useRef(node.title);
  const loadedContentRef = useRef(node.content);
  const aliveRef = useRef(true);
  const controllerRef = useRef<LegacySaveController | null>(null);
  const draftCheckedRef = useRef(false);
  /** Project one AST snapshot into the legacy editor HTML. */
  function editorHtmlOf(doc: AlterDoc): string {
    return alterDocToEditorHtml(doc, {
      docPath: (docId) => docPath(spaceId, docId),
    });
  }

  /** Adopt one server snapshot into the editor (external reload/restore). */
  function applyExternalSnapshot(snapshot: LegacySaveSnapshot): void {
    lastSavedDocRef.current = snapshot.doc;
    baseRevisionRef.current = snapshot.revision;
    lastSavedTitleRef.current = snapshot.title;
    loadedContentRef.current = serializeDocument(snapshot.doc);
    const html = editorHtmlOf(snapshot.doc);
    draftRef.current = { title: snapshot.title, content: html };
    if (!aliveRef.current) return;
    setRevision(snapshot.revision);
    setEditorHtml(html);
    setTitle(snapshot.title);
    setBodyHasContent(hasBodyContent(html));
    setEditorRevision((value) => value + 1);
    setSaveState('saved');
  }

  if (controllerRef.current === null) {
    controllerRef.current = createLegacySaveController({
      docId: node.id,
      initial: {
        doc: mountDoc,
        revision: mountDoc.revision,
        title: node.title,
      },
      getClient: () => documentModelOf(service),
      capture: () => ({
        html: draftRef.current.content,
        title: draftRef.current.title,
      }),
      onStatus: (status) => {
        if (!aliveRef.current) return;
        setSaveState(
          status.kind === 'failed' || status.kind === 'conflict'
            ? 'error'
            : status.kind === 'saving'
              ? 'saving'
              : 'saved',
        );
        if (status.kind === 'conflict') {
          setConflictPrompt({
            message: status.message,
            ...(status.serverRevision === undefined
              ? {}
              : { serverRevision: status.serverRevision }),
          });
        }
      },
      onBaseChanged: (snapshot) => {
        lastSavedDocRef.current = snapshot.doc;
        baseRevisionRef.current = snapshot.revision;
        lastSavedTitleRef.current = snapshot.title;
      },
      onSaved: (snapshot) => {
        lastSavedDocRef.current = snapshot.doc;
        baseRevisionRef.current = snapshot.revision;
        lastSavedTitleRef.current = snapshot.title;
        loadedContentRef.current = serializeDocument(snapshot.doc);
        if (!aliveRef.current) return;
        setRevision(snapshot.revision);
        setEditorHtml(editorHtmlOf(snapshot.doc));
        setBodyHasContent(hasBodyContent(draftRef.current.content));
        refresh();
      },
      onExternalSnapshot: applyExternalSnapshot,
      notify: (message) => {
        if (aliveRef.current) toast(message);
      },
      saveTitle: async (title) => {
        await service.saveNode(node.id, { title });
      },
    });
  }

  const quoteSavesRef = useRef(new Map<string, PendingQuoteSave>());
  const pageRef = useRef<HTMLElement>(null);
  const [anchorRoot, setAnchorRoot] = useState<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(true);
  const workbenchScope = useSyncExternalStore(
    workbench?.controller.subscribe ?? (() => () => undefined),
    () => workbench?.controller.getScope(workbench.scopeKey),
  );
  const workbenchOpen = Boolean(workbenchScope?.open);
  const stacked = narrow;
  useEffect(() => {
    const element = pageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setNarrow(element.clientWidth < 720),
    );
    observer.observe(element);
    setNarrow(element.clientWidth < 720);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = titleRef.current;
    if (!element) return;
    let width = 0;
    const fit = () => {
      const nextWidth = element.clientWidth;
      // 隐藏的 Workbench 标签或尚未完成布局时宽度为 0，此时测量会把每个字符
      // 都排成一行并锁成很高的内联高度，等拿到真实宽度后再计算。
      if (nextWidth === 0 || nextWidth === width) return;
      width = nextWidth;
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [title]);

  useEffect(() => {
    let alive = true;
    void service.listComments(node.id).then((items) => {
      if (alive) setComments(items);
    });
    return () => {
      alive = false;
    };
  }, [service, node.id]);

  useEffect(() => {
    let alive = true;
    void service.recordOpen(node.id).then(() => {
      if (alive) refresh();
    });
    return () => {
      alive = false;
    };
  }, [service, node.id, refresh]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // Persist a final crash draft and try one last save attempt.
      controllerRef.current?.dispose();
    };
  }, [service, node.id]);

  useEffect(() => {
    if (!controllerRef.current?.hasPending()) {
      setTitle(node.title);
      draftRef.current.title = node.title;
    }
  }, [node.title]);

  useEffect(() => {
    const current = controllerRef.current;
    if (current === null || current.hasPending()) return;
    if (node.content === loadedContentRef.current) return;
    loadedContentRef.current = node.content;
    const doc = astOf(node.content);
    const snapshot: LegacySaveSnapshot = {
      doc,
      revision: doc.revision,
      title: node.title,
    };
    const ownEcho = doc.revision === current.getBase().revision;
    current.adopt(snapshot);
    if (ownEcho) {
      // Own-save echo at the revision we already adopted (the Host may
      // canonicalize attrs). Keep the editor DOM and cursor untouched.
      setEditorHtml(editorHtmlOf(doc));
      return;
    }
    // External revision (version restore, another writer): reload the editor.
    applyExternalSnapshot(snapshot);
  }, [node.content, node.title, spaceId]);

  // Force a crash-draft write before the page is hidden/unloaded.
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        controllerRef.current?.persistDraftNow();
      }
    };
    const onPageHide = (): void => {
      controllerRef.current?.persistDraftNow();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  // Crash-draft recovery on open: same revision → restore/discard; stale
  // revision → keep-local-overwrite / discard-and-reload. Never silent.
  useEffect(() => {
    if (draftCheckedRef.current) return;
    draftCheckedRef.current = true;
    const draft = readLegacyDraft(node.id);
    if (draft === undefined) return;
    if (legacyDraftMatchesSnapshot(draft, { doc: mountDoc, title: node.title })) {
      // The save landed but the receipt was lost: nothing to resolve.
      clearLegacyDraft(node.id);
      return;
    }
    if (draft.baseRevision === mountDoc.revision) {
      setDraftPrompt({ draft, kind: 'same' });
      return;
    }
    void (async () => {
      const client = documentModelOf(service);
      let latest: LegacySaveSnapshot | undefined;
      if (client !== undefined) {
        try {
          const raw = readDocumentSnapshot(await client.get(node.id));
          if (raw !== undefined) {
            latest = {
              doc: raw.doc,
              revision: raw.revision,
              title: raw.title ?? node.title,
            };
          }
        } catch {
          latest = undefined;
        }
      }
      if (draft.baseRevision === (latest?.revision ?? mountDoc.revision)) {
        setDraftPrompt({ draft, kind: 'same', latest });
      } else {
        setDraftPrompt({ draft, kind: 'conflict', latest });
      }
    })();
  }, [node.id]);

  // While a recovery/conflict dialog is open the editor must not accept
  // input; only the `contenteditable` attribute changes (no DOM/CSS change).
  useEffect(() => {
    const page = pageRef.current;
    if (page === null) return;
    const surface = page.querySelector<HTMLElement>(
      '[role="textbox"][aria-label="文档正文"]',
    );
    if (surface === null) return;
    const locked = draftPrompt !== null || conflictPrompt !== null;
    surface.setAttribute('contenteditable', locked ? 'false' : 'true');
    return () => {
      surface.setAttribute('contenteditable', 'true');
    };
  }, [draftPrompt, conflictPrompt]);

  useEffect(() => {
    const saves = quoteSavesRef.current;
    return () => {
      for (const [id, pending] of saves) {
        window.clearTimeout(pending.timer);
        void service
          .updateComment(id, { quote: pending.quote })
          .catch(() => undefined);
      }
      saves.clear();
    };
  }, [service]);

  const openComments = useMemo(
    () => comments.filter((comment) => comment.status === 'open'),
    [comments],
  );
  const resolvedComments = useMemo(
    () => comments.filter((comment) => comment.status === 'resolved'),
    [comments],
  );

  function scheduleSave(): void {
    controllerRef.current?.notifyChange();
  }

  async function flush(): Promise<void> {
    await controllerRef.current?.flush();
  }

  function retrySave(): void {
    void controllerRef.current?.retry();
  }

  /** Force a crash-draft write (history restore / unload paths). */
  function persistDraftNow(): void {
    controllerRef.current?.persistDraftNow();
  }

  /** Download the current draft as an HTML recovery file. */
  function downloadDraft(): void {
    const draft = controllerRef.current?.exportDraft();
    if (draft === undefined) return;
    const blob = new Blob([draft.html], {
      type: 'text/html;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(draft.title || '无标题').replace(
      /[\\/:*?"<>|]/g,
      ' ',
    )}.draft.html`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter') event.preventDefault();
  }

  function scheduleQuoteSave(id: string, quote: string) {
    const previous = quoteSavesRef.current.get(id);
    if (previous) window.clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      quoteSavesRef.current.delete(id);
      void service.updateComment(id, { quote }).catch(() => undefined);
    }, 450);
    quoteSavesRef.current.set(id, { timer, quote });
  }

  function cancelQuoteSave(id: string) {
    const pending = quoteSavesRef.current.get(id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    quoteSavesRef.current.delete(id);
  }

  async function flushQuoteSave(id: string) {
    const pending = quoteSavesRef.current.get(id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    quoteSavesRef.current.delete(id);
    await service.updateComment(id, { quote: pending.quote });
  }

  function handleCommentQuotesChange(updates: { id: string; quote: string }[]) {
    if (!updates.length) return;
    const quotes = new Map(updates.map((update) => [update.id, update.quote]));
    setComments((items) =>
      items.map((comment) => {
        const quote = quotes.get(comment.id);
        return quote === undefined ? comment : { ...comment, quote };
      }),
    );
    for (const update of updates) scheduleQuoteSave(update.id, update.quote);
  }

  async function addComment(body: string, quote: string | null) {
    // Comments anchor to a top-level block; derive it from the current draft
    // when the quote matches exactly one block, otherwise store no anchor.
    const parsed = parseLegacyHtml(draftRef.current.content);
    const anchor = anchorForQuote(parsed.blocks, quote);
    const comment = await service.addComment({
      docId: node.id,
      body,
      quote,
      anchor,
    });
    setComments((items) => [...items, comment]);
    setPendingQuote(null);
    setPendingDraftHasContent(false);
  }

  async function approveComment(id: string) {
    await flushQuoteSave(id);
    const updated = await service.resolveComment(id);
    setComments((items) =>
      items.map((comment) => (comment.id === id ? updated : comment)),
    );
    if (hoveredCommentId === id) setHoveredCommentId(null);
    if (caretCommentId === id) setCaretCommentId(null);
    toast('评论已采纳');
  }

  async function editComment(id: string, body: string) {
    const updated = await service.updateComment(id, { body });
    setComments((items) =>
      items.map((comment) =>
        comment.id === id ? { ...updated, quote: comment.quote } : comment,
      ),
    );
  }

  async function supplementComment(id: string, body: string) {
    const updated = await service.addCommentSupplement(id, body);
    setComments((items) =>
      items.map((comment) =>
        comment.id === id ? { ...updated, quote: comment.quote } : comment,
      ),
    );
  }

  async function deleteComment(id: string) {
    cancelQuoteSave(id);
    await service.deleteComment(id);
    setComments((items) => items.filter((comment) => comment.id !== id));
    if (hoveredCommentId === id) setHoveredCommentId(null);
    if (caretCommentId === id) setCaretCommentId(null);
    toast('评论已删除');
  }

  function toggleComments() {
    if (commentsOpen) {
      if (pendingQuote !== null && !pendingDraftHasContent)
        setPendingQuote(null);
      setCommentsOpen(false);
      setHoveredCommentId(null);
      return;
    }
    setCommentsOpen(true);
  }

  function startComment(quote: string) {
    setPendingQuote(quote);
    setPendingDraftHasContent(false);
    setCommentsOpen(true);
  }

  function cancelPendingComment() {
    setPendingQuote(null);
    setPendingDraftHasContent(false);
  }

  async function createChild() {
    const child = await service.createNode({
      spaceId,
      parentId: node.id,
      kind: 'note',
    });
    addNodeToState(child);
    refresh();
    router.navigate(docPath(spaceId, child.id));
  }

  async function handleRestored() {
    const fresh = await service.getNode(node.id);
    if (!fresh) return;
    updateNodeInState(fresh);
    const doc = astOf(fresh.content);
    const snapshot: LegacySaveSnapshot = {
      doc,
      revision: doc.revision,
      title: fresh.title,
    };
    loadedContentRef.current = fresh.content;
    // Keep the crash draft: the user may want to restore their unsaved edits
    // again after inspecting the historical version.
    controllerRef.current?.adopt(snapshot);
    applyExternalSnapshot(snapshot);
    refresh();
  }

  /** Draft recovery: restore the local draft (same revision). */
  function restoreDraft(): void {
    const prompt = draftPrompt;
    if (prompt === null) return;
    const snapshot: LegacySaveSnapshot = prompt.latest ?? {
      doc: mountDoc,
      revision: mountDoc.revision,
      title: node.title,
    };
    const controller = controllerRef.current;
    controller?.adopt(snapshot);
    const html = prompt.draft.html;
    draftRef.current = { title: prompt.draft.title, content: html };
    setTitle(prompt.draft.title);
    setBodyHasContent(hasBodyContent(html));
    setEditorHtml(html);
    setEditorRevision((value) => value + 1);
    setSaveState('saved');
    setDraftPrompt(null);
    controller?.notifyChange();
  }

  /** Draft recovery: discard the local draft. */
  function discardDraft(): void {
    clearLegacyDraft(node.id);
    setDraftPrompt(null);
  }

  /** Stale draft: keep local content and save it over the latest revision. */
  async function keepDraftOverwrite(): Promise<void> {
    const prompt = draftPrompt;
    if (prompt === null) return;
    let latest = prompt.latest;
    if (latest === undefined) {
      const client = documentModelOf(service);
      if (client !== undefined) {
        try {
          const raw = readDocumentSnapshot(await client.get(node.id));
          if (raw !== undefined) {
            latest = {
              doc: raw.doc,
              revision: raw.revision,
              title: raw.title ?? node.title,
            };
          }
        } catch {
          latest = undefined;
        }
      }
    }
    if (latest === undefined) {
      toast('无法读取服务端最新内容，本地草稿已保留');
      return;
    }
    const controller = controllerRef.current;
    controller?.adoptForOverwrite(latest);
    const html = prompt.draft.html;
    draftRef.current = { title: prompt.draft.title, content: html };
    setTitle(prompt.draft.title);
    setBodyHasContent(hasBodyContent(html));
    setEditorHtml(html);
    setEditorRevision((value) => value + 1);
    setDraftPrompt(null);
    controller?.notifyChange();
    void controller?.flush();
  }

  /** Stale draft: discard local content and reload the latest server state. */
  async function discardDraftAndReload(): Promise<void> {
    setDraftPrompt(null);
    const controller = controllerRef.current;
    const reloaded = await controller?.reloadServerSnapshot({ clearDraft: true });
    if (reloaded !== undefined) return;
    clearLegacyDraft(node.id);
    applyExternalSnapshot({
      doc: mountDoc,
      revision: mountDoc.revision,
      title: node.title,
    });
  }

  /** Conflict: keep local edits and save them over the latest revision. */
  function keepLocalConflict(): void {
    setConflictPrompt(null);
    void controllerRef.current?.keepLocalOverwrite();
  }

  /** Conflict: reload the latest server revision and discard local edits. */
  async function discardConflict(): Promise<void> {
    setConflictPrompt(null);
    const reloaded = await controllerRef.current?.reloadServerSnapshot({
      clearDraft: true,
    });
    if (reloaded === undefined) {
      controllerRef.current?.persistDraftNow();
      toast('无法读取服务端最新内容，本地草稿已保留');
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}${location.pathname}${docPath(spaceId, node.id)}`,
      );
      toast('链接已复制');
    } catch {
      toast('复制失败，请检查浏览器权限');
    }
  }

  async function unarchive() {
    await service.setArchived(node.id, false);
    refresh();
    toast('已恢复');
  }

  const ancestors = ancestorsOf(nodes, node.id);
  const children = nodes
    .filter((item) => item.parentId === node.id && item.kind === 'note')
    .sort(
      (a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt),
    );
  const activeCommentId = hoveredCommentId ?? caretCommentId;
  const inlineComments = openComments.filter(
    (comment) => comment.quote !== null,
  );
  const fullCommentCount = openComments.filter(
    (comment) => comment.quote === null,
  ).length;
  const railHasContent = pendingQuote !== null || inlineComments.length > 0;
  const railOpen = commentsOpen && railHasContent;

  function handleFooterTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = footerTab === 'children' ? 'comments' : 'children';
    setFooterTab(next);
    (next === 'children' ? childrenTabRef : commentsTabRef).current?.focus();
  }

  const documentEmpty = title.trim().length === 0 && !bodyHasContent;
  const showFooter =
    bodyHasContent || children.length > 0 || comments.length > 0;
  const menuActions: MenuAction[] = [
    {
      id: 'copy',
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
      id: 'history',
      label: '历史记录',
      icon: <History />,
      separatorBefore: true,
      onSelect: () => setHistoryOpen(true),
    },
    {
      id: 'history-comments',
      label: '历史评论',
      icon: <MessageSquare />,
      disabled: !resolvedComments.length,
      onSelect: () => setHistoryCommentsOpen(true),
    },
    {
      id: 'export',
      label: '导出 Markdown',
      icon: <Download />,
      onSelect: () => {
        downloadMarkdown(
          title || node.title || '无标题',
          draftRef.current.content,
        );
        toast('Markdown 已导出');
      },
    },
  ];
  if (node.archived)
    menuActions.push({
      id: 'unarchive',
      label: '取消归档',
      icon: <ArchiveRestore />,
      separatorBefore: true,
      onSelect: () => void unarchive(),
    });

  const rail = (
    <CommentRail
      comments={comments}
      activeCommentId={activeCommentId}
      pendingQuote={pendingQuote}
      anchorRoot={anchorRoot}
      open={railOpen}
      stacked={stacked}
      onActivate={setHoveredCommentId}
      onAddPending={(body, quote) => addComment(body, quote)}
      onCancelPending={cancelPendingComment}
      onPendingDraftChange={setPendingDraftHasContent}
      onApprove={approveComment}
      onEdit={editComment}
      onSupplement={supplementComment}
      onDelete={deleteComment}
    />
  );

  return (
    <section
      ref={pageRef}
      className={styles.page}
      aria-label={displayTitle(node.title)}
    >
      <header className={styles.toolbar}>
        {!embedded ? <DirectoryButton /> : null}
        <nav className={styles.crumbs} aria-label="目录层级">
          <button
            type="button"
            className={styles.crumb}
            onClick={() => router.navigate(overviewPath(spaceId))}
          >
            {space.name}
          </button>
          {ancestors.map((ancestor) => (
            <span key={ancestor.id} className={styles.crumbGroup}>
              <ChevronRight
                size={10}
                strokeWidth={1.8}
                className={styles.crumbChevron}
                aria-hidden="true"
              />
              {ancestor.kind === 'note' ? (
                <button
                  type="button"
                  className={styles.crumb}
                  onClick={() => router.navigate(docPath(spaceId, ancestor.id))}
                >
                  {displayTitle(ancestor.title)}
                </button>
              ) : (
                <span className={styles.crumbText} aria-disabled="true">
                  {ancestor.title}
                </span>
              )}
            </span>
          ))}
          <ChevronRight
            size={10}
            strokeWidth={1.8}
            className={styles.crumbChevron}
            aria-hidden="true"
          />
          <span className={styles.currentCrumb}>{title || '无标题'}</span>
        </nav>
        <div className={styles.actions}>
          {/* Auto-save stays silent: the editor shows errors only. */}
          {saveState === 'error' ? (
            <button
              type="button"
              className={styles.saveError}
              onClick={retrySave}
            >
              保存失败，重试
            </button>
          ) : null}
          <IconButton
            label="文档菜单"
            icon={<MoreHorizontal />}
            aria-haspopup="menu"
            aria-expanded={Boolean(menuAnchor)}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          />
          {workbench && !workbenchOpen ? (
            <WorkbenchToggle
              controller={workbench.controller}
              scopeKey={workbench.scopeKey}
            />
          ) : null}
        </div>
      </header>

      <div className={styles.scroller}>
        <div
          className={styles.canvas}
          data-columns={!stacked || undefined}
          data-comments={railOpen || undefined}
        >
          <article className={styles.paper}>
            <header
              className={styles.header}
              data-empty={documentEmpty || undefined}
            >
              <textarea
                ref={titleRef}
                className={styles.title}
                value={title}
                rows={1}
                placeholder="无标题"
                aria-label="文档标题"
                onChange={(event) => {
                  const next = event.target.value;
                  setTitle(next);
                  draftRef.current.title = next;
                  scheduleSave();
                }}
                onKeyDown={handleTitleKeyDown}
                onBlur={() => void flush()}
              />
              <div className={styles.meta}>
                {documentEmpty ? null : (
                  <>
                    <span>
                      {node.creator === 'alter' ? 'Alter 创建' : '我创建'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{formatRelativeTime(node.updatedAt)}更新</span>
                  </>
                )}
                {node.archived ? (
                  <button
                    type="button"
                    className={styles.archivedBadge}
                    title="恢复到目录"
                    aria-label="恢复文档"
                    onClick={() => void unarchive()}
                  >
                    <Archive
                      size={11}
                      strokeWidth={1.7}
                      className={styles.archivedIcon}
                      aria-hidden="true"
                    />
                    <ArchiveRestore
                      size={11}
                      strokeWidth={1.7}
                      className={styles.restoreIcon}
                      aria-hidden="true"
                    />
                    <span className={styles.archivedLabel}>已归档</span>
                    <span className={styles.restoreLabel}>恢复</span>
                  </button>
                ) : null}
              </div>
            </header>

            <div className={styles.commentAnchorLayout}>
              <div ref={setAnchorRoot} className={styles.body}>
                <Editor
                  docId={node.id}
                  initialHtml={editorHtml}
                  externalRevision={editorRevision}
                  findDoc={(id) => nodes.find((item) => item.id === id)}
                  onOpenWeb={openWeb}
                  onOpenDoc={(id) => router.navigate(docPath(spaceId, id))}
                  onChange={(html) => {
                    draftRef.current.content = html;
                    setBodyHasContent(hasBodyContent(html));
                    scheduleSave();
                  }}
                  onComment={startComment}
                  comments={comments}
                  activeCommentId={activeCommentId}
                  onCommentAtCaretChange={setCaretCommentId}
                  onCommentQuotesChange={handleCommentQuotesChange}
                  onCommentedTextClick={() => setCommentsOpen(true)}
                  onNotice={(message) => toast(message)}
                />
              </div>

              {stacked ? (
                <div
                  className={styles.stackedComments}
                  data-open={railOpen || undefined}
                >
                  <div>{rail}</div>
                </div>
              ) : null}
            </div>
            {showFooter ? (
              <section className={styles.footer} aria-label="文档附加内容">
                <div
                  className={styles.footerTabs}
                  role="tablist"
                  aria-label="文档附加内容"
                  onKeyDown={handleFooterTabKeyDown}
                >
                  <button
                    ref={childrenTabRef}
                    type="button"
                    role="tab"
                    id="doc-children-tab"
                    className={styles.footerTab}
                    aria-selected={footerTab === 'children'}
                    aria-controls="doc-children-panel"
                    tabIndex={footerTab === 'children' ? 0 : -1}
                    onClick={() => setFooterTab('children')}
                  >
                    子文档
                  </button>
                  <button
                    ref={commentsTabRef}
                    type="button"
                    role="tab"
                    id="doc-comments-tab"
                    className={styles.footerTab}
                    aria-selected={footerTab === 'comments'}
                    aria-controls="doc-comments-panel"
                    tabIndex={footerTab === 'comments' ? 0 : -1}
                    onClick={() => setFooterTab('comments')}
                  >
                    全文评论
                    {fullCommentCount ? (
                      <span className={styles.footerCount}>
                        {fullCommentCount}
                      </span>
                    ) : null}
                  </button>
                </div>
                <div
                  className={styles.footerPanel}
                  role="tabpanel"
                  id="doc-children-panel"
                  aria-labelledby="doc-children-tab"
                  hidden={footerTab !== 'children'}
                >
                  <section className={styles.children} aria-label="子文档">
                    {children.length
                      ? children.map((child) => (
                          <button
                            key={child.id}
                            type="button"
                            className={styles.childRow}
                            onClick={() =>
                              router.navigate(docPath(spaceId, child.id))
                            }
                          >
                            <FileText
                              size={15}
                              strokeWidth={1.5}
                              aria-hidden="true"
                            />
                            <span className={styles.childTitle}>
                              {displayTitle(child.title)}
                            </span>
                            {child.archived ? (
                              <Archive
                                size={12}
                                strokeWidth={1.6}
                                className={styles.childArchived}
                                aria-label="已归档"
                              />
                            ) : null}
                          </button>
                        ))
                      : null}
                    {node.archived ? null : (
                      <button
                        type="button"
                        className={styles.addChild}
                        onClick={() => void createChild()}
                      >
                        <Plus size={14} strokeWidth={1.7} aria-hidden="true" />
                        新建子文档
                      </button>
                    )}
                  </section>
                </div>
                <div
                  className={styles.footerPanel}
                  role="tabpanel"
                  id="doc-comments-panel"
                  aria-labelledby="doc-comments-tab"
                  hidden={footerTab !== 'comments'}
                >
                  <DocumentComments
                    comments={comments}
                    activeCommentId={activeCommentId}
                    onActivate={setHoveredCommentId}
                    onAdd={(body) => addComment(body, null)}
                    onApprove={approveComment}
                    onEdit={editComment}
                    onSupplement={supplementComment}
                    onDelete={deleteComment}
                  />
                </div>
              </section>
            ) : null}
          </article>
          {!stacked ? <div className={styles.commentColumn}>{rail}</div> : null}
        </div>
      </div>

      {railHasContent ? (
        <div className={styles.commentLayer}>
          <button
            type="button"
            className={styles.commentsButton}
            data-active={commentsOpen || undefined}
            aria-pressed={commentsOpen}
            title="行内评论"
            aria-label={`评论${inlineComments.length ? ` ${inlineComments.length}` : ''}`}
            aria-expanded={commentsOpen}
            onClick={toggleComments}
          >
            <MessageSquare size={15} strokeWidth={1.6} aria-hidden="true" />
            {inlineComments.length ? (
              <span className={styles.commentCount}>
                {inlineComments.length}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}
      <Menu
        anchor={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={() => setMenuAnchor(null)}
        align="end"
        width={196}
        actions={menuActions}
      />
      {historyOpen ? (
        <HistoryPanel
          open
          doc={node}
          baseRevision={revision}
          hasUnsavedChanges={() =>
            controllerRef.current?.hasPending() ?? false
          }
          onPersistDraft={persistDraftNow}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => void handleRestored()}
        />
      ) : null}
      <HistoryCommentsModal
        open={historyCommentsOpen}
        comments={comments}
        onClose={() => setHistoryCommentsOpen(false)}
      />
      <Dialog
        open={draftPrompt !== null}
        onClose={() => setDraftPrompt(null)}
        title={
          draftPrompt?.kind === 'conflict'
            ? '检测到旧版本草稿'
            : '发现未保存草稿'
        }
        size="small"
        footer={
          draftPrompt?.kind === 'conflict' ? (
            <>
              <Button variant="secondary" onClick={() => setDraftPrompt(null)}>
                取消
              </Button>
              <Button
                variant="secondary"
                onClick={() => void discardDraftAndReload()}
              >
                丢弃并重载
              </Button>
              <Button variant="secondary" onClick={downloadDraft}>
                导出草稿
              </Button>
              <Button variant="primary" onClick={() => void keepDraftOverwrite()}>
                保留本地并覆盖
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setDraftPrompt(null)}>
                取消
              </Button>
              <Button variant="secondary" onClick={discardDraft}>
                丢弃
              </Button>
              <Button variant="primary" onClick={restoreDraft}>
                恢复
              </Button>
            </>
          )
        }
      >
        <p>
          {draftPrompt?.kind === 'conflict'
            ? '发现基于旧版本的未保存草稿，服务端已有更新。可保留本地草稿并覆盖，或丢弃后重载最新内容。'
            : '检测到上次未保存的内容，可恢复本地草稿或丢弃。'}
        </p>
        {draftPrompt === null ? null : (
          <p>
            {draftPrompt.draft.title.trim() || '无标题'} ·{' '}
            {draftPrompt.kind === 'conflict'
              ? '基于 revision ' + String(draftPrompt.draft.baseRevision)
              : '未保存'}
          </p>
        )}
      </Dialog>
      <Dialog
        open={conflictPrompt !== null}
        onClose={() => setConflictPrompt(null)}
        title="文档已被其他修改"
        size="small"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConflictPrompt(null)}>
              仅保留草稿
            </Button>
            <Button variant="secondary" onClick={downloadDraft}>
              导出草稿
            </Button>
            <Button
              variant="secondary"
              onClick={() => void discardConflict()}
            >
              重新加载并丢弃本地
            </Button>
            <Button variant="primary" onClick={keepLocalConflict}>
              保留本地草稿并覆盖
            </Button>
          </>
        }
      >
        <p>{conflictPrompt?.message ?? ''}</p>
        <p>本地内容已写入草稿；选择覆盖会基于最新 revision 重新保存。</p>
      </Dialog>
    </section>
  );
}
