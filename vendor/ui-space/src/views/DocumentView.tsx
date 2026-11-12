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
  Code2,
  Download,
  FilePlus2,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  History,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Quote,
  Text,
} from 'lucide-react';
import type { Comment, SpaceNode } from '@alter/protocol';
import {
  alterDocToEditorHtml,
  anchorForQuote,
  clearDraft,
  createDocumentSaveController,
  draftMatchesSnapshot,
  parseDocumentContent,
  planCommentAnchorRepairs,
  readDocumentSnapshot,
  readDocumentDraft,
  TiptapBody,
  reportDocumentError,
  serializeDocument,
  type AlterDoc,
  type BlockNode,
  type EditorBlockType,
  type DocumentDraft,
  type DocumentSaveController,
  type DocumentSaveSnapshot,
} from '@alter-space/document-runtime';
import { useSpaceContext } from '../runtime';
import { documentModelOf } from '../document-model';
import { docPath, overviewPath } from '../space-route';
import { ancestorsOf, displayTitle } from '../utils/tree';
import { formatRelativeTime } from '../utils/date';
import { downloadMarkdown } from '../utils/markdown';
import editorStyles from '../components/editor/Editor.module.css';
import { CommentRail } from '../components/CommentRail';
import { DocumentErrorBoundary } from '../components/DocumentErrorBoundary';
import { DocumentComments } from '../components/DocumentComments';
import { HistoryPanel } from '../components/HistoryPanel';
import {
  HistoryCommentsModal,
  historyCommentAt,
} from '../components/HistoryCommentsModal';
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

/**
 * Comments the editor/rail may still write for: only open ones.
 *
 * Host treats writes against resolved/deleted comments as no-ops, and the
 * views must not mirror live state (anchors, quotes) onto comments that are
 * already history.
 */
function isLiveComment(comment: Comment): boolean {
  return comment.status === 'open';
}

/**
 * Whether an AST body has any visible content.
 *
 * Same semantics as the HTML check below (strip tags, trim): the legacy page
 * decided from the editor's `textContent`, and an AST body must not flip the
 * page into "has content" for a blank paragraph or a lone divider. Nodes whose
 * HTML renders text (file name, link-card title, doc-link title, object cards,
 * table cells) count; images/dividers/rules do not.
 */
function blocksHaveContent(blocks: readonly BlockNode[]): boolean {
  for (const block of blocks) {
    for (const node of block.content ?? []) {
      if (node.type === 'text' && node.text.trim() !== '') return true;
    }
    const attrs = block.attrs ?? {};
    for (const key of ['name', 'title', 'description', 'caption'] as const) {
      const value = attrs[key];
      if (typeof value === 'string' && value.trim() !== '') return true;
    }
    if (block.children !== undefined && blocksHaveContent(block.children)) {
      return true;
    }
  }
  return false;
}

/** Empty AST document used when there is no stored content yet. */
const EMPTY_AST: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [],
};

/** Visible failure state of the document page (E1: never a silent blank doc). */
interface DocumentLoadFailure {
  title: string;
  message: string;
  /** Original error, kept for structured diagnostics. */
  error: Error;
}

/** Flat text of a block tree, used for the draft download fallback. */
function blocksToDraftText(blocks: readonly BlockNode[]): string {
  const lines: string[] = [];
  const walk = (nodes: readonly BlockNode[]): void => {
    for (const node of nodes) {
      const inline = (node.content ?? [])
        .map((item) => (item.type === 'text' ? item.text : '\n'))
        .join('');
      if (inline.trim() !== '') lines.push(inline);
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(blocks);
  return lines.join('\n\n');
}

/**
 * Parse the stored `alter-doc/1` content for the initial mount.
 *
 * Corrupted/failed content becomes an explicit load failure (E1) instead of a
 * silent empty document, so the page can offer retry/back-to-directory.
 */
function readMountDocument(
  content: string,
): { doc: AlterDoc; failure: DocumentLoadFailure | null } {
  const raw = typeof content === 'string' ? content : '';
  if (raw.trim() === '') {
    return { doc: EMPTY_AST, failure: null };
  }
  const parsed = parseDocumentContent(raw);
  if (parsed === undefined) {
    return {
      doc: EMPTY_AST,
      failure: {
        title: '无法显示文档',
        message:
          '文档内容不是合法的结构化文档，已停止加载以避免覆盖现有数据。可重试或返回空间目录。',
        error: new Error(
          'doc/schema-invalid: stored content is not a valid alter-doc/1 document',
        ),
      },
    };
  }
  try {
    return { doc: parsed, failure: null };
  } catch (cause) {
    return {
      doc: EMPTY_AST,
      failure: {
        title: '无法显示文档',
        message:
          '文档内容无法渲染，已停止加载以避免覆盖现有数据。可重试或返回空间目录。',
        error: cause instanceof Error ? cause : new Error(String(cause)),
      },
    };
  }
}

export function DocumentView({
  node,
  embedded = false,
  autoFocusTitle = false,
}: {
  node: SpaceNode;
  embedded?: boolean;
  /** 新建文档首次打开：挂载后把光标放进标题；重新打开已有文档不抢焦点。 */
  autoFocusTitle?: boolean;
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
  // on HTML, so the adapter projects it once per mounted document. Corrupt
  // content surfaces an explicit failure state instead of an empty document.
  const mountRef = useRef<ReturnType<typeof readMountDocument> | null>(null);
  if (mountRef.current === null) {
    mountRef.current = readMountDocument(node.content);
  }
  const mountDoc = mountRef.current.doc;
  const mountDocRef = useRef<AlterDoc>(mountDoc);
  const initialFailureRef = useRef(mountRef.current.failure);
  const [loadFailure, setLoadFailure] = useState<DocumentLoadFailure | null>(
    mountRef.current.failure,
  );
  const [title, setTitle] = useState(node.title);
  const [revision, setRevision] = useState(mountDoc.revision);
  const [bodyHasContent, setBodyHasContent] = useState(() =>
    blocksHaveContent(mountDoc.blocks),
  );
  const [comments, setComments] = useState<Comment[]>([]);
  /**
   * Comments the AST-native body draws, as the kernel needs them.
   *
   * The kernel contract only knows quoted comments; legacy keeps its own
   * filtering, so this is derived here instead of changing `comments`. A
   * deleted comment is a tombstone: it no longer paints its quote in the body
   * (resolved comments keep painting, as they always have).
   */
  const commentsWithQuote = useMemo(
    () =>
      comments.filter(
        (item): item is Comment & { quote: string } =>
          typeof item.quote === 'string' && item.status !== 'deleted',
      ),
    [comments],
  );
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
  /** Distinguishes ordinary save failures from conflicts for error actions. */
  const [saveFailureKind, setSaveFailureKind] = useState<
    'failed' | 'conflict' | null
  >(null);
  const [conflictPrompt, setConflictPrompt] = useState<{
    message: string;
    serverRevision?: number;
  } | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<{
    draft: DocumentDraft;
    kind: 'same' | 'conflict';
    latest?: DocumentSaveSnapshot;
  } | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  /**
   * Document the AST-native kernel renders.
   *
   * The retired contentEditable kernel renders `editorHtml`; an AST kernel needs the document
   * itself. It changes only on an explicit reload (external revision, version
   * restore, draft recovery), never on a save echo — a save echo must not
   * rebuild the live body.
   */
  const [bodyDocument, setBodyDocument] = useState<AlterDoc>(mountDoc);
  /**
   * Link being edited from the AST-native body's link bar.
   *
   * The kernel reports the link, the page owns the form (the same dialog shape
   * the frozen editor uses), and the result goes back through the kernel.
   */
  const [linkEdit, setLinkEdit] = useState<{
    kind: 'card' | 'inline';
    pos: number;
    href: string;
    label: string;
  } | null>(null);
  /**
   * 文本类型菜单的锚点（工具栏第一个按钮）。
   *
   * The menu itself is the frozen `Menu` component from `@alter/ui-system`: the
   * kernel reports the anchor and applies the chosen conversion, so the visual
   * stays exactly the pre-rebuild one.
   */
  const [textTypeAnchor, setTextTypeAnchor] = useState<HTMLElement | null>(null);
  const [textTypeActive, setTextTypeActive] = useState<EditorBlockType>('p');
  /** 链接编辑表单的校验错误（旧编辑器同一套文案）。 */
  const [linkError, setLinkError] = useState('');
  /** Imperative handle of the mounted AST-native body (link write-back). */
  const tiptapHandleRef = useRef<{
    applyLinkEdit(input: {
      kind: 'card' | 'inline';
      pos: number;
      href: string;
      label: string;
    }): void;
    applyBlockType(type: EditorBlockType): void;
    activeBlockType(): EditorBlockType;
  } | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const childrenTabRef = useRef<HTMLButtonElement>(null);
  const commentsTabRef = useRef<HTMLButtonElement>(null);
  const draftRef = useRef<{
    title: string;
    /** Canonical AST blocks of the current body (reported on every edit). */
    blocks: BlockNode[];
  }>({ title: node.title, blocks: mountDoc.blocks });
  const lastSavedDocRef = useRef<AlterDoc>(mountDoc);
  const baseRevisionRef = useRef(mountDoc.revision);
  const lastSavedTitleRef = useRef(node.title);
  const loadedContentRef = useRef(node.content);
  const aliveRef = useRef(true);
  const controllerRef = useRef<DocumentSaveController | null>(null);
  const draftCheckedRef = useRef(false);
  const commentsRef = useRef<Comment[]>([]);
  const anchorSweepRef = useRef(false);
  const anchorWarnedRef = useRef(false);
  commentsRef.current = comments;
  /** Open comment ids — the only ones the page may still write to. */
  const liveIdsRef = useRef(new Set<string>());
  liveIdsRef.current = new Set(
    comments.filter(isLiveComment).map((comment) => comment.id),
  );

  // Report the initial load failure once (structured, content-free).
  useEffect(() => {
    const failure = initialFailureRef.current;
    if (failure === null) return;
    reportDocumentError('load', failure.error, { docId: node.id });
  }, [node.id]);

  /** Adopt one server snapshot into the editor (external reload/restore). */
  function applyExternalSnapshot(snapshot: DocumentSaveSnapshot): void {
    lastSavedDocRef.current = snapshot.doc;
    baseRevisionRef.current = snapshot.revision;
    lastSavedTitleRef.current = snapshot.title;
    loadedContentRef.current = serializeDocument(snapshot.doc);
    draftRef.current = { title: snapshot.title, blocks: snapshot.doc.blocks };
    if (!aliveRef.current) return;
    setRevision(snapshot.revision);
    setBodyDocument(snapshot.doc);
    setTitle(snapshot.title);
    setBodyHasContent(blocksHaveContent(snapshot.doc.blocks));
    setEditorRevision((value) => value + 1);
    setSaveState('saved');
  }

  if (controllerRef.current === null) {
    controllerRef.current = createDocumentSaveController({
      docId: node.id,
      initial: {
        doc: mountDoc,
        revision: mountDoc.revision,
        title: node.title,
      },
      getClient: () => documentModelOf(service),
      capture: () => ({
        // The kernel reports canonical AST blocks on every edit; they are the
        // one body shape the save pipeline ever sees.
        blocks: draftRef.current.blocks,
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
        if (status.kind === 'failed') {
          setSaveFailureKind('failed');
          reportDocumentError('save', new Error(status.message), {
            docId: node.id,
            revision: baseRevisionRef.current,
          });
          return;
        }
        if (status.kind === 'conflict') {
          setSaveFailureKind('conflict');
          setConflictPrompt({
            message: status.message,
            ...(status.serverRevision === undefined
              ? {}
              : { serverRevision: status.serverRevision }),
          });
          reportDocumentError('conflict', new Error(status.message), {
            docId: node.id,
            ...(status.serverRevision === undefined
              ? {}
              : { serverRevision: status.serverRevision }),
          });
          return;
        }
        setSaveFailureKind(null);
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
        setBodyHasContent(blocksHaveContent(draftRef.current.blocks));
        refresh();
        // E4: re-check open comment anchors once new content is authoritative.
        void repairCommentAnchors(commentsRef.current, snapshot.doc).then(
          // The save may have cascaded deletes on the Host; re-read after the
          // anchor repair so its writes are not overwritten by the refresh.
          () => reloadComments(),
        );
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

  // 新建文档挂载后把光标放进标题，用户可以直接开始输入；重新打开已有文档不抢焦点
  // （`autoFocusTitle` 只由新建流程一次性传入，见 `SpaceApp` 的聚焦请求）。
  useEffect(() => {
    if (!autoFocusTitle) return;
    const element = titleRef.current;
    if (element === null) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [autoFocusTitle]);

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
    void service
      .listComments(node.id)
      .then((items) => {
        if (!alive) return;
        // Every status is kept: the rails/body filter to open, the history
        // panel shows resolved + deleted tombstones.
        setComments(items);
        // E4: repair drifted anchors of open comments once after loading.
        void repairCommentAnchors(items, lastSavedDocRef.current);
      })
      .catch((error: unknown) => {
        reportDocumentError('comments', error, { docId: node.id });
        if (alive) toast('评论加载失败，请稍后重试');
      });
    return () => {
      alive = false;
    };
  }, [service, node.id]);

  useEffect(() => {
    let alive = true;
    void service
      .recordOpen(node.id)
      .then(() => {
        if (alive) refresh();
      })
      .catch((error: unknown) => {
        reportDocumentError('load', error, {
          docId: node.id,
          operation: 'recordOpen',
        });
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
    const parsedContent = parseDocumentContent(node.content);
    if (parsedContent === undefined) {
      reportDocumentError(
        'load',
        new Error('doc/schema-invalid: external content is not valid'),
        { docId: node.id },
      );
      setLoadFailure({
        title: '无法显示文档',
        message:
          '服务端返回的文档内容无法解析，已停止加载以避免覆盖现有数据。可重试或返回空间目录。',
        error: new Error('doc/schema-invalid: external content is not valid'),
      });
      return;
    }
    const snapshot: DocumentSaveSnapshot = {
      doc: parsedContent,
      revision: parsedContent.revision,
      title: node.title,
    };
    const ownEcho = parsedContent.revision === current.getBase().revision;
    current.adopt(snapshot);
    setLoadFailure(null);
    if (ownEcho) {
      // Own-save echo at the revision we already adopted (the Host may
      // canonicalize attrs). Keep the live body and cursor untouched.
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
    const draft = readDocumentDraft(node.id);
    if (draft === undefined) return;
    if (draftMatchesSnapshot(draft, { doc: mountDoc, title: node.title })) {
      // The save landed but the receipt was lost: nothing to resolve.
      clearDraft(node.id);
      return;
    }
    if (draft.baseRevision === mountDoc.revision) {
      setDraftPrompt({ draft, kind: 'same' });
      return;
    }
    void (async () => {
      const client = documentModelOf(service);
      let latest: DocumentSaveSnapshot | undefined;
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
        // A resolved/deleted comment is never written back on unmount.
        if (!liveIdsRef.current.has(id)) continue;
        void service
          .updateComment(id, { quote: pending.quote })
          .catch((error: unknown) => {
            reportDocumentError('comments', error, {
              docId: node.id,
              commentId: id,
              operation: 'flushQuote',
            });
          });
      }
      saves.clear();
    };
  }, [service]);

  const openComments = useMemo(
    () => comments.filter((comment) => comment.status === 'open'),
    [comments],
  );
  /**
   * Comments that left the live rails: resolved (采纳) and soft-deleted
   * (已删除) share the history panel, newest first by when each happened.
   */
  const historyComments = useMemo(
    () =>
      comments
        .filter(
          (comment) =>
            comment.status === 'resolved' || comment.status === 'deleted',
        )
        .sort(
          (a, b) =>
            Date.parse(historyCommentAt(b)) - Date.parse(historyCommentAt(a)),
        ),
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

  /** Download the current draft as a recovery file. */
  function downloadDraft(): void {
    const draft = controllerRef.current?.exportDraft();
    if (draft === undefined) return;
    // Drafts are canonical AST blocks (never HTML), exported as plain text.
    const blob = new Blob([blocksToDraftText(draft.blocks)], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(draft.title || '无标题').replace(
      /[\\/:*?"<>|]/g,
      ' ',
    )}.draft.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /**
   * E4: repair drifted comment anchors against one authoritative document.
   *
   * Only semantically unique quotes are rewritten (via `service.updateComment`);
   * failures keep the stored anchor silently (reported to diagnostics only).
   * Unrepairable anchors surface exactly one transient toast per mount — no
   * permanent UI is added.
   */
  async function repairCommentAnchors(
    items: readonly Comment[],
    doc: AlterDoc,
  ): Promise<void> {
    if (anchorSweepRef.current) return;
    // Anchor repair is a live-comment repair: resolved/deleted tombstones must
    // not be rewritten (the Host rejects writes on them).
    const plan = planCommentAnchorRepairs(items.filter(isLiveComment), doc);
    if (plan.repairs.length === 0 && plan.unresolvedIds.length === 0) return;
    anchorSweepRef.current = true;
    try {
      for (const repair of plan.repairs) {
        try {
          await service.updateComment(repair.commentId, {
            anchor: repair.anchor,
          });
          if (!aliveRef.current) continue;
          setComments((current) =>
            current.map((comment) =>
              comment.id === repair.commentId
                ? { ...comment, anchor: repair.anchor }
                : comment,
            ),
          );
        } catch (error) {
          reportDocumentError('anchor', error, {
            docId: node.id,
            commentId: repair.commentId,
          });
        }
      }
      if (
        plan.unresolvedIds.length > 0 &&
        !anchorWarnedRef.current &&
        aliveRef.current
      ) {
        anchorWarnedRef.current = true;
        toast('部分评论锚点已失效');
      }
    } finally {
      anchorSweepRef.current = false;
    }
  }

  /**
   * Re-read the comment list after a body save.
   *
   * Deleting commented text cascades on the Host (the tombstone goes with the
   * block), so the page cannot derive the list from the body it just sent —
   * it has to ask. Only called from the save-success path (never from an
   * effect on `comments`), so a refresh cannot loop. Errors stay silent: the
   * rails keep the last known list and the next save retries.
   */
  async function reloadComments(): Promise<void> {
    try {
      const items = await service.listComments(node.id);
      if (!aliveRef.current) return;
      // Leave the composer (its own state) and the open history dialog alone;
      // only the mirrored list is replaced.
      setComments(items);
    } catch (error) {
      reportDocumentError('comments', error, {
        docId: node.id,
        operation: 'reloadComments',
      });
    }
  }

  /**
   * E1: recover from the explicit load-failure state. Prefers a fresh Host
   * snapshot, then falls back to re-parsing the stored content.
   */
  async function retryLoadDocument(): Promise<void> {
    const client = documentModelOf(service);
    let snapshot: DocumentSaveSnapshot | null = null;
    if (client !== undefined) {
      try {
        const raw = readDocumentSnapshot(await client.get(node.id));
        if (raw !== undefined) {
          snapshot = {
            doc: raw.doc,
            revision: raw.revision,
            title: raw.title ?? node.title,
          };
        }
      } catch (error) {
        reportDocumentError('load', error, { docId: node.id });
      }
    }
    if (snapshot === null) {
      const parsed = readMountDocument(node.content);
      if (parsed.failure !== null) {
        reportDocumentError('load', parsed.failure.error, {
          docId: node.id,
        });
        setLoadFailure(parsed.failure);
        return;
      }
      snapshot = {
        doc: parsed.doc,
        revision: parsed.doc.revision,
        title: node.title,
      };
    }
    try {
      mountDocRef.current = snapshot.doc;
      lastSavedDocRef.current = snapshot.doc;
      baseRevisionRef.current = snapshot.revision;
      loadedContentRef.current = serializeDocument(snapshot.doc);
      draftRef.current = { title: snapshot.title, blocks: snapshot.doc.blocks };
      controllerRef.current?.adopt(snapshot);
      applyExternalSnapshot(snapshot);
      setLoadFailure(null);
    } catch (cause) {
      const failure: DocumentLoadFailure = {
        title: '无法显示文档',
        message:
          '文档内容无法渲染，已停止加载以避免覆盖现有数据。可重试或返回空间目录。',
        error: cause instanceof Error ? cause : new Error(String(cause)),
      };
      reportDocumentError('load', failure.error, { docId: node.id });
      setLoadFailure(failure);
    }
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter') event.preventDefault();
  }

  function scheduleQuoteSave(id: string, quote: string) {
    const previous = quoteSavesRef.current.get(id);
    if (previous) window.clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      quoteSavesRef.current.delete(id);
      void service.updateComment(id, { quote }).catch((error: unknown) => {
        reportDocumentError('comments', error, {
          docId: node.id,
          commentId: id,
          operation: 'quote',
        });
      });
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
    // Two updates are dropped here:
    // - a comment that is no longer open (the kernel reports its live set
    //   asynchronously, so a just-approved/deleted row must not be written);
    // - an empty quote: the kernel reports it when the quoted text was
    //   deleted, which is the Host's cue to cascade the comment on save. It is
    //   not UI state: the row keeps its old quote until the post-save
    //   `reloadComments` returns the tombstone.
    const accepted = updates.filter(
      (update) =>
        update.quote !== '' &&
        comments.some(
          (comment) => comment.id === update.id && isLiveComment(comment),
        ),
    );
    if (!accepted.length) return;
    const quotes = new Map(accepted.map((update) => [update.id, update.quote]));
    setComments((items) =>
      items.map((comment) => {
        const quote = quotes.get(comment.id);
        return quote === undefined ? comment : { ...comment, quote };
      }),
    );
    for (const update of accepted) scheduleQuoteSave(update.id, update.quote);
  }

  async function addComment(body: string, quote: string | null) {
    try {
      // Comments anchor to a top-level block; derive it from the live body when
      // the quote matches exactly one block, otherwise store no anchor.
      const anchor = anchorForQuote(draftRef.current.blocks, quote);
      const comment = await service.addComment({
        docId: node.id,
        body,
        quote,
        anchor,
      });
      setComments((items) => [...items, comment]);
      setPendingQuote(null);
      setPendingDraftHasContent(false);
    } catch (error) {
      reportDocumentError('comments', error, {
        docId: node.id,
        operation: 'addComment',
      });
      throw error instanceof Error
        ? error
        : new Error('评论发布失败，请重试');
    }
  }

  async function approveComment(id: string) {
    try {
      await flushQuoteSave(id);
      const updated = await service.resolveComment(id);
      setComments((items) =>
        items.map((comment) => (comment.id === id ? updated : comment)),
      );
      if (hoveredCommentId === id) setHoveredCommentId(null);
      if (caretCommentId === id) setCaretCommentId(null);
      toast('评论已采纳');
    } catch (error) {
      reportDocumentError('comments', error, {
        docId: node.id,
        commentId: id,
        operation: 'approveComment',
      });
      throw error instanceof Error
        ? error
        : new Error('评论采纳失败，请重试');
    }
  }

  async function editComment(id: string, body: string) {
    try {
      const updated = await service.updateComment(id, { body });
      setComments((items) =>
        items.map((comment) =>
          comment.id === id ? { ...updated, quote: comment.quote } : comment,
        ),
      );
    } catch (error) {
      reportDocumentError('comments', error, {
        docId: node.id,
        commentId: id,
        operation: 'editComment',
      });
      throw error instanceof Error
        ? error
        : new Error('评论修改失败，请重试');
    }
  }

  async function supplementComment(id: string, body: string) {
    try {
      const updated = await service.addCommentSupplement(id, body);
      setComments((items) =>
        items.map((comment) =>
          comment.id === id ? { ...updated, quote: comment.quote } : comment,
        ),
      );
    } catch (error) {
      reportDocumentError('comments', error, {
        docId: node.id,
        commentId: id,
        operation: 'supplementComment',
      });
      throw error instanceof Error
        ? error
        : new Error('评论补充失败，请重试');
    }
  }

  async function deleteComment(id: string) {
    cancelQuoteSave(id);
    try {
      await service.deleteComment(id);
      if (!aliveRef.current) return;
      // Soft delete: the row stays in `comments` as a tombstone so the history
      // panel can show it. Every live view filters on `status === 'open'`.
      // The timestamp stays unset here — the Host owns it (a tombstone written
      // on another device may be older) and the reload below brings it in.
      setComments((items) =>
        items.map((comment) =>
          comment.id === id ? { ...comment, status: 'deleted' } : comment,
        ),
      );
      if (hoveredCommentId === id) setHoveredCommentId(null);
      if (caretCommentId === id) setCaretCommentId(null);
      toast('评论已删除');
      void reloadComments();
    } catch (error) {
      reportDocumentError('comments', error, {
        docId: node.id,
        commentId: id,
        operation: 'deleteComment',
      });
      throw error instanceof Error
        ? error
        : new Error('评论删除失败，请重试');
    }
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
    try {
      const child = await service.createNode({
        spaceId,
        parentId: node.id,
        kind: 'note',
      });
      addNodeToState(child);
      refresh();
      router.navigate(docPath(spaceId, child.id));
    } catch (error) {
      // The button is fire-and-forget (`void createChild()`), so an uncaught
      // rejection here used to be completely silent: no document, no message.
      // Report the failure and tell the user instead.
      reportDocumentError('create', error, { docId: node.id });
      toast(
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : '新建子文档失败，请重试',
      );
    }
  }

  async function handleRestored() {
    try {
      const fresh = await service.getNode(node.id);
      if (!fresh) return;
      const parsed = parseDocumentContent(fresh.content);
      if (parsed === undefined) {
        throw new Error('doc/schema-invalid: restored content is not valid');
      }
      updateNodeInState(fresh);
      const snapshot: DocumentSaveSnapshot = {
        doc: parsed,
        revision: parsed.revision,
        title: fresh.title,
      };
      loadedContentRef.current = fresh.content;
      // Keep the crash draft: the user may want to restore their unsaved edits
      // again after inspecting the historical version.
      controllerRef.current?.adopt(snapshot);
      applyExternalSnapshot(snapshot);
      refresh();
    } catch (error) {
      reportDocumentError('restore', error, { docId: node.id });
      toast('版本恢复后刷新失败，请重试');
    }
  }

  /** Draft recovery: restore the local draft (same revision). */
  function restoreDraft(): void {
    const prompt = draftPrompt;
    if (prompt === null) return;
    const snapshot: DocumentSaveSnapshot = prompt.latest ?? {
      doc: mountDoc,
      revision: mountDoc.revision,
      title: node.title,
    };
    const controller = controllerRef.current;
    controller?.adopt(snapshot);
    const blocks = prompt.draft.blocks;
    draftRef.current = { title: prompt.draft.title, blocks };
    setTitle(prompt.draft.title);
    setBodyHasContent(blocksHaveContent(blocks));
    setBodyDocument({
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: snapshot.revision,
      blocks,
    });
    setEditorRevision((value) => value + 1);
    setSaveState('saved');
    setDraftPrompt(null);
    controller?.notifyChange();
  }

  /** Draft recovery: discard the local draft. */
  function discardDraft(): void {
    clearDraft(node.id);
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
    const blocks = prompt.draft.blocks;
    draftRef.current = { title: prompt.draft.title, blocks };
    setTitle(prompt.draft.title);
    setBodyHasContent(blocksHaveContent(blocks));
    setBodyDocument({
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: latest.revision,
      blocks,
    });
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
    clearDraft(node.id);
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
      disabled: !historyComments.length,
      onSelect: () => setHistoryCommentsOpen(true),
    },
    {
      id: 'export',
      label: '导出 Markdown',
      icon: <Download />,
      onSelect: () => {
        // Export always reflects the live body: project the current blocks
        // through the frozen HTML projection the exporter understands.
        const projected = alterDocToEditorHtml(
          {
            format: 'alter-doc/1',
            schemaVersion: 1,
            revision: baseRevisionRef.current,
            blocks: draftRef.current.blocks,
          },
          { docPath: (docId) => docPath(spaceId, docId) },
        );
        downloadMarkdown(title || node.title || '无标题', projected);
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

  if (loadFailure !== null) {
    return (
      <section className={styles.page} aria-label={displayTitle(node.title)}>
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
            <ChevronRight
              size={10}
              strokeWidth={1.8}
              className={styles.crumbChevron}
              aria-hidden="true"
            />
            <span className={styles.currentCrumb}>{title || '无标题'}</span>
          </nav>
          <div className={styles.actions} />
        </header>
        <div className={styles.scroller}>
          <article className={styles.paper}>
            <header className={styles.header}>
              <h1 className={styles.title}>{loadFailure.title}</h1>
            </header>
            <div className={styles.body}>
              <p>{loadFailure.message}</p>
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  onClick={() => void retryLoadDocument()}
                >
                  重试
                </Button>
                <Button
                  variant="primary"
                  onClick={() => router.navigate(overviewPath(spaceId))}
                >
                  返回空间目录
                </Button>
              </div>
            </div>
          </article>
        </div>
      </section>
    );
  }

  /**
   * 文本类型菜单的动作。
   *
   * Same nine entries, order and icons as the pre-rebuild editor's block menu;
   * the frozen `Menu` component renders it, so the look is unchanged.
   */
  const textTypeActions: MenuAction[] = [
    { id: 'p', label: '正文', icon: <Text />, active: textTypeActive === 'p', onSelect: () => chooseBlockType('p') },
    { id: 'h1', label: '标题 1', icon: <Heading1 />, active: textTypeActive === 'h1', onSelect: () => chooseBlockType('h1') },
    { id: 'h2', label: '标题 2', icon: <Heading2 />, active: textTypeActive === 'h2', onSelect: () => chooseBlockType('h2') },
    { id: 'h3', label: '标题 3', icon: <Heading3 />, active: textTypeActive === 'h3', onSelect: () => chooseBlockType('h3') },
    { id: 'bullet', label: '无序列表', icon: <List />, active: textTypeActive === 'bullet', onSelect: () => chooseBlockType('bullet') },
    { id: 'ordered', label: '有序列表', icon: <ListOrdered />, active: textTypeActive === 'ordered', onSelect: () => chooseBlockType('ordered') },
    { id: 'todo', label: '待办', icon: <ListTodo />, active: textTypeActive === 'todo', separatorBefore: true, onSelect: () => chooseBlockType('todo') },
    { id: 'quote', label: '引用', icon: <Quote />, active: textTypeActive === 'quote', onSelect: () => chooseBlockType('quote') },
    { id: 'code', label: '代码块', icon: <Code2 />, active: textTypeActive === 'code', onSelect: () => chooseBlockType('code') },
  ];

  /** The toolbar asked for the block-type menu: snapshot the active type once. */
  function openTextTypeMenu(anchor: HTMLElement): void {
    setTextTypeActive(tiptapHandleRef.current?.activeBlockType() ?? 'p');
    setTextTypeAnchor(anchor);
  }

  /** Apply one menu choice through the mounted AST-native kernel. */
  function chooseBlockType(type: EditorBlockType): void {
    tiptapHandleRef.current?.applyBlockType(type);
    setTextTypeAnchor(null);
  }

  /**
   * Upload one pasted/dropped file as an asset for the AST-native body.
   *
   * The AST has no place for a base64 payload, so the kernel reports the file
   * and the document client stores it; the returned reference goes into the
   * inserted block.
   */
  async function importDocumentAsset(input: {
    kind: 'image' | 'file';
    mime: string;
    dataBase64: string;
    name?: string;
  }): Promise<{ assetId: string; mime: string; bytes: number; name?: string }> {
    const client = documentModelOf(service);
    if (client === undefined) throw new Error('当前环境不支持上传附件');
    const importer =
      input.kind === 'image' ? client.importAsset : client.importFile;
    if (importer === undefined) throw new Error('当前环境不支持上传附件');
    try {
      return await importer.call(client, {
        mime: input.mime,
        dataBase64: input.dataBase64,
        ...(input.name === undefined ? {} : { name: input.name }),
      });
    } catch (error) {
      // Host business errors carry the user-facing Chinese message (size limit,
      // unsupported image type, storage disabled, …); forward it unchanged so
      // the body's upload notice shows the real reason instead of a generic
      // "upload failed" line. Only a message-less rejection gets a fallback.
      if (error instanceof Error) throw error;
      throw new Error(
        typeof error === 'string' && error.trim() !== ''
          ? error
          : '附件上传失败，请重试',
      );
    }
  }

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
            <>
              <button
                type="button"
                className={styles.saveError}
                onClick={retrySave}
              >
                保存失败，重试
              </button>
              {saveFailureKind === 'failed' ? (
                <button
                  type="button"
                  className={styles.saveError}
                  onClick={downloadDraft}
                >
                  导出草稿
                </button>
              ) : null}
            </>
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

      <DocumentErrorBoundary
        docId={node.id}
        resetKey={`${node.id}:${revision}`}
        title="文档界面出现异常"
        message="编辑器或侧栏渲染失败，可重试；若持续失败，请返回空间目录后重新打开。"
        classNames={{
          scroller: styles.scroller,
          paper: styles.paper,
          header: styles.header,
          title: styles.title,
          body: styles.body,
          actions: styles.actions,
        }}
        onGoOverview={() => router.navigate(overviewPath(spaceId))}
      >
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
                <TiptapBody
                  docId={node.id}
                  document={bodyDocument}
                  revision={editorRevision}
                  caret="none"
                  comments={commentsWithQuote}
                  activeCommentId={activeCommentId}
                  onBlocks={(blocks) => {
                    draftRef.current.blocks = blocks;
                    setBodyHasContent(blocksHaveContent(blocks));
                    scheduleSave();
                  }}
                  onCommentedTextClick={() => setCommentsOpen(true)}
                  onCommentAtCaretChange={setCaretCommentId}
                  onCommentRequest={startComment}
                  onCommentQuotesChange={handleCommentQuotesChange}
                  onSelectionChange={() => {
                    // The quote for a new comment comes from the kernel's
                    // toolbar action, never from merely selecting text: a
                    // selection alone must not open the composer.
                  }}
                  onLinkEditRequest={(detail) => {
                    setLinkError('');
                    setLinkEdit({
                      kind: detail.kind,
                      pos: detail.pos,
                      href: detail.href,
                      label: detail.label ?? detail.href,
                    });
                  }}
                  onReady={(handle) => {
                    tiptapHandleRef.current = handle;
                  }}
                  onOpenWeb={
                    openWeb ??
                    ((url: string) =>
                      window.open(url, '_blank', 'noopener,noreferrer'))
                  }
                  onOpenDoc={(id) => router.navigate(docPath(spaceId, id))}
                  onTextTypeRequest={(anchor) => openTextTypeMenu(anchor)}
                  importAsset={importDocumentAsset}
                  hasDoc={(docId) => nodes.some((item) => item.id === docId)}
                  docPath={(docId) => docPath(spaceId, docId)}
                  resolveDoc={(docId) =>
                    nodes.find((item) => item.id === docId) === undefined
                      ? undefined
                      : {
                          archived:
                            nodes.find((item) => item.id === docId)?.archived ===
                            true,
                        }
                  }
                  onNotice={(message) => toast(message)}
                />
              </div>
              <Menu
                anchor={textTypeAnchor}
                open={Boolean(textTypeAnchor)}
                onClose={() => setTextTypeAnchor(null)}
                align="start"
                width={172}
                actions={textTypeActions}
              />

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
        comments={historyComments}
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
      <Dialog
        open={linkEdit !== null}
        onClose={() => setLinkEdit(null)}
        title="编辑链接"
        size="small"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLinkEdit(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const current = linkEdit;
                if (current === null) return;
                const href = current.href.trim();
                if (href === '') {
                  setLinkError('填写链接地址');
                  return;
                }
                if (!/^https?:\/\//iu.test(href)) {
                  setLinkError('链接地址格式不正确');
                  return;
                }
                setLinkError('');
                tiptapHandleRef.current?.applyLinkEdit({
                  ...current,
                  href,
                });
                setLinkEdit(null);
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <div className={editorStyles.linkForm}>
          <label className={editorStyles.linkField}>
            <span>显示文本</span>
            <input
              aria-label="显示文本"
              value={linkEdit?.label ?? ''}
              onChange={(event) =>
                setLinkEdit((current) =>
                  current === null ? current : { ...current, label: event.target.value },
                )
              }
            />
          </label>
          <label className={editorStyles.linkField}>
            <span>链接地址</span>
            <input
              aria-label="链接地址"
              value={linkEdit?.href ?? ''}
              onChange={(event) =>
                setLinkEdit((current) =>
                  current === null ? current : { ...current, href: event.target.value },
                )
              }
            />
          </label>
          {linkError === '' ? null : (
            <p role="alert" className={editorStyles.linkError}>
              {linkError}
            </p>
          )}
        </div>
      </Dialog>
      </DocumentErrorBoundary>
    </section>
  );
}




