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
 * On top of the P0 lifecycle this module owns the P1 writing surface:
 *
 * - the inline formatting toolbar (marks, H1–H3, lists, quote, code block,
 *   divider, callout, link, table, image, undo/redo);
 * - the `/` slash menu (`slash-menu.tsx`) for block insertion;
 * - the link editing bar (`link-bar.tsx`) for the `link` mark and for the
 *   `网页链接卡` URL prompt;
 * - image insertion (picker / paste / drop) through the optional
 *   `doc.importAsset` RPC, inserted as `alterImage` blocks;
 * - pasting an internal Space document link as an `alterDocLink` card and a
 *   bare web URL as an inline link;
 * - table insertion plus a contextual table toolbar.
 *
 * P3 rich blocks:
 *
 * - file cards (`alterFile`): picker → `doc.importFile` → `file` AST node with
 *   a downloadable attachment card;
 * - image attribute editing (alt / caption / CSS width) through the node view's
 *   `updateAttributes`, which the autosave diff persists as `update_attrs`;
 * - mindmap insertion/editing through Document Operations: one batch creates
 *   the `mindmap` block and its `obj_…` payload (`update_object`), later edits
 *   replace the object and reload the document revision.
 *
 * Markdown shortcuts (`# `, `- `, `1. `, `> `, ``` ```, `[ ] `) come from the
 * StarterKit input rules; paste is filtered by the editor schema.
 *
 * External snapshots (parent refresh, version restore, draft recovery) are
 * adopted without recreating the editor, so cursor, selection and undo history
 * survive a save.
 *
 * @module @alter-dsh/space/document/editor/AlterTiptapEditor
 */
import type { Editor, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { SpaceRemoteError, type SpaceDocumentClient } from '../../space-client';
import type { AlterDoc, JsonValue } from '../types';
import {
  createAutosaveController,
  createDocumentSaver,
  describeSaveError,
  readRevision,
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
import {
  commentSelectionAnchor,
  createCommentAnchorExtension,
  refreshCommentDecorations,
  scrollToCommentAnchor,
  type CommentAnchor,
  type CommentMarker,
  type CommentSelectionAnchor,
} from './comment-marks';
import { astToTiptap, newBlockId } from './mapping';
import { editorExtensions } from './schema';
import {
  LinkBar,
  isWebUrl,
  linkRangeFromElement,
  normalizeLinkHref,
  parseInternalDocLink,
  type InternalDocLink,
} from './link-bar';
import {
  MindmapEditor,
  MINDMAP_EDIT_EVENT,
  PENDING_OBJECT_ID,
  buildDeleteBlockOperation,
  buildPendingObjectInsertOperation,
  buildUpdateObjectOperation,
  createMindmapPayload,
  validateMindmapPayload,
  type MindmapEditRequest,
  type MindmapPayload,
} from '../objects';
import {
  COMPONENT_EDIT_EVENT,
  ComponentPicker,
  PropsEditor,
  componentPayloadErrors,
  componentPayloadOf,
  createDefaultComponentPayload,
  getComponentObjectState,
  setComponentObjectState,
  type ComponentEditRequest,
} from '../components';
import type { ComponentPayload } from '@alter/protocol';
import {
  SlashMenu,
  filterSlashCommands,
  slashCommands,
  slashMenuPosition,
  slashParagraphRange,
  slashQueryAtSelection,
  type SlashCommand,
  type SlashCommandContext,
  type SlashMenuState,
} from './slash-menu';
import styles from './AlterTiptapEditor.module.css';

/** A draft injected into the editor by the surrounding view. */
export interface EditorRestoreRequest {
  /** Exact Tiptap JSON of the draft to restore. */
  editor: JSONContent;
  /** Revision the restored content must be saved against. */
  revision: number;
}

/** Result returned by `doc.importAsset` for one uploaded image. */
export interface ImageAssetResult {
  assetId: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
}

/** Reads a browser `File` and returns the Host asset reference. */
export type ImageUploader = (file: File) => Promise<ImageAssetResult>;

/** MIME types accepted by the document asset channel. */
export const SUPPORTED_IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/** Maximum image size accepted by the document asset channel (4 MiB). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Readable validation error for a picked/pasted image, if any. */
export function validateImageFile(file: File): string | undefined {
  if (!(SUPPORTED_IMAGE_MIMES as readonly string[]).includes(file.type)) {
    return '不支持的文件类型：仅支持 PNG/JPEG/WebP/GIF 图片';
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return '图片过大：单张图片最大 4 MiB';
  }
  return undefined;
}

/** Structural view of the optional `doc.importAsset` RPC method. */
type AssetImporter = (input: {
  mime: string;
  dataBase64: string;
  name?: string;
}) => Promise<ImageAssetResult>;

/** Read the optional asset importer without widening the shared client type. */
function assetImporterOf(
  client: SpaceDocumentClient,
): AssetImporter | undefined {
  const candidate = (
    client as SpaceDocumentClient & { importAsset?: AssetImporter }
  ).importAsset;
  return typeof candidate === 'function' ? candidate.bind(client) : undefined;
}

function readFileAsDataUrl(file: File, label = '图片'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => reject(new Error(`读取${label}失败，请重试`));
    reader.readAsDataURL(file);
  });
}

/** Default uploader: base64 → `doc.importAsset` → `alterImage` attrs. */
export async function uploadImageWithClient(
  client: SpaceDocumentClient,
  file: File,
): Promise<ImageAssetResult> {
  const importAsset = assetImporterOf(client);
  if (importAsset === undefined) {
    throw new Error('图片上传未启用');
  }
  const dataUrl = await readFileAsDataUrl(file);
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('读取图片失败，请重试');
  const result = await importAsset({
    mime: file.type,
    dataBase64: dataUrl.slice(separator + 1),
    name: file.name,
  });
  if (
    result === null ||
    typeof result !== 'object' ||
    typeof result.assetId !== 'string' ||
    result.assetId === ''
  ) {
    throw new Error('图片上传失败：未返回资产 id');
  }
  return result;
}

function describeImageError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return '图片上传失败，请重试';
}

/** Result returned by `doc.importFile` for one uploaded attachment. */
export interface FileAssetResult {
  assetId: string;
  mime: string;
  bytes: number;
  name?: string;
}

/** Reads a browser `File` and returns the Host file-asset reference. */
export type FileUploader = (file: File) => Promise<FileAssetResult>;

/** MIME types accepted by the generic file-asset channel. */
export const SUPPORTED_FILE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

/** Maximum file size accepted by the file-asset channel (8 MiB). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Extensions the file picker offers; also used to infer a missing File.type. */
export const SUPPORTED_FILE_EXTENSIONS = [
  '.pdf',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.zip',
  '.docx',
  '.xlsx',
  '.pptx',
] as const;

/** Extension → MIME fallback for browsers that report an empty `File.type`. */
const FILE_EXTENSION_MIMES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Infer the upload MIME from `File.type`, falling back to the extension. */
export function inferFileMime(file: File): string | undefined {
  const declared = file.type.trim().toLowerCase();
  if ((SUPPORTED_FILE_MIMES as readonly string[]).includes(declared)) {
    return declared;
  }
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const extension = file.name.slice(dot + 1).trim().toLowerCase();
  return FILE_EXTENSION_MIMES[extension];
}

/** Readable validation error for a picked attachment, if any. */
export function validateFileCard(file: File): string | undefined {
  if (inferFileMime(file) === undefined) {
    return '不支持的文件类型：仅支持 PDF/文本/Markdown/CSV/JSON/ZIP/Office 文档';
  }
  if (file.size > MAX_FILE_BYTES) {
    return '文件过大：单个附件最大 8 MiB';
  }
  return undefined;
}

/** Structural view of the optional `doc.importFile` RPC method. */
type FileImporter = (input: {
  mime: string;
  dataBase64: string;
  name?: string;
}) => Promise<FileAssetResult>;

/** Read the optional file importer without widening the shared client type. */
function fileImporterOf(
  client: SpaceDocumentClient,
): FileImporter | undefined {
  const candidate = (
    client as SpaceDocumentClient & { importFile?: FileImporter }
  ).importFile;
  return typeof candidate === 'function' ? candidate.bind(client) : undefined;
}

/** Default file uploader: base64 → `doc.importFile` → `alterFile` attrs. */
export async function uploadFileWithClient(
  client: SpaceDocumentClient,
  file: File,
): Promise<FileAssetResult> {
  const importFile = fileImporterOf(client);
  if (importFile === undefined) {
    throw new Error('文件上传未启用');
  }
  const mime = inferFileMime(file);
  if (mime === undefined) {
    throw new Error('不支持的文件类型：仅支持 PDF/文本/Markdown/CSV/JSON/ZIP/Office 文档');
  }
  const dataUrl = await readFileAsDataUrl(file, '文件');
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('读取文件失败，请重试');
  const result = await importFile({
    mime,
    dataBase64: dataUrl.slice(separator + 1),
    name: file.name,
  });
  if (
    result === null ||
    typeof result !== 'object' ||
    typeof result.assetId !== 'string' ||
    result.assetId === ''
  ) {
    throw new Error('文件上传失败：未返回资产 id');
  }
  return result;
}

function describeFileError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return '文件上传失败，请重试';
}

/** Readable message for a Document-Operations failure outside the save loop. */
function describeOperationError(error: unknown): string {
  if (error instanceof SpaceRemoteError) {
    if (error.code === 'doc/conflict') {
      return '文档已被其他修改更新，请重新加载后再试';
    }
    return error.message;
  }
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return '操作失败，请重试';
}

/** Id of the top-level block that contains the current selection. */
function topLevelBlockIdAt(editor: Editor): string | undefined {
  const { selection } = editor.state;
  let found: string | undefined;
  editor.state.doc.forEach((node, offset) => {
    if (found !== undefined) return;
    if (selection.from >= offset && selection.from <= offset + node.nodeSize) {
      const blockId = node.attrs['blockId'];
      if (typeof blockId === 'string' && blockId !== '') found = blockId;
    }
  });
  return found;
}

/** Find the top-level mindmap block that references `objectId`. */
function findMindmapBlockId(
  editor: Editor,
  objectId: string,
): string | undefined {
  let found: string | undefined;
  editor.state.doc.descendants((node) => {
    if (found !== undefined) return false;
    if (node.type.name !== 'alterMindmap') return true;
    if (node.attrs['objectId'] !== objectId) return true;
    const blockId = node.attrs['blockId'];
    if (typeof blockId === 'string' && blockId !== '') found = blockId;
    return false;
  });
  return found;
}

/** Read the object payload out of a `doc.getObject` / `object.get` result. */
function readObjectPayload(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)['payload'];
}

/** Find the component block that references `objectId`. */
function findComponentBlockId(
  editor: Editor,
  objectId: string,
): string | undefined {
  let found: string | undefined;
  editor.state.doc.descendants((node) => {
    if (found !== undefined) return false;
    if (node.type.name !== 'alterComponent') return true;
    if (node.attrs['objectId'] !== objectId) return true;
    const blockId = node.attrs['blockId'];
    if (typeof blockId === 'string' && blockId !== '') found = blockId;
    return false;
  });
  return found;
}

/** Stable empty marker list so effects do not re-run on every render. */
const EMPTY_COMMENT_MARKERS: readonly CommentMarker[] = [];

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
  /** Override the image uploader (tests / integrations with a custom channel). */
  uploadImage?: ImageUploader;
  /** Override the generic file uploader (tests / integrations). */
  uploadFile?: FileUploader;
  /** Receives the editor instance once mounted (tests / integrations). */
  onEditorReady?: (editor: Editor) => void;
  /** Comment highlights supplied by the comment rail (P2). */
  commentMarkers?: readonly CommentMarker[];
  /** Reports the current selection anchor (null when there is none). */
  onCommentAnchorChange?: (
    anchor: (CommentAnchor & { quote: string }) | null,
  ) => void;
  /** Called when a comment highlight is clicked. */
  onCommentClick?: (id: string) => void;
  /** Comment to select/scroll to; set by the comment rail. */
  activeCommentId?: string | null;
}

/** Dialog state of the mindmap tree editor. */
interface MindmapEditorState {
  blockId: string;
  objectId: string;
  payload: MindmapPayload | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflict: boolean;
}

/** Dialog state of the component props editor. */
interface ComponentEditorState {
  blockId: string;
  objectId: string;
  payload: ComponentPayload | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflict: boolean;
}

/** Dialog state of the component picker (insert flow). */
interface ComponentPickerState {
  inserting: boolean;
  error: string | null;
}

interface LinkBarState {
  mode: 'link' | 'bookmark';
  href: string;
  error: string | null;
  range: { from: number; to: number };
  hasLink: boolean;
}

interface EditorNotice {
  kind: 'info' | 'error';
  message: string;
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

/** Clamp a drop position into the current document. */
function clampPosition(editor: Editor, position: number): number {
  return Math.max(0, Math.min(position, editor.state.doc.content.size));
}

/** Insert a bookmark card, degrading to an inline link when not registered. */
function insertBookmarkCard(
  editor: Editor,
  url: string,
  notify: (message: string) => void,
): void {
  if (editor.schema.nodes['alterBookmark'] !== undefined) {
    editor
      .chain()
      .focus()
      .insertContent({ type: 'alterBookmark', attrs: { url } })
      .run();
    return;
  }
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'paragraph',
      content: [
        { type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] },
      ],
    })
    .run();
  notify('网页链接卡尚未启用，已插入普通链接');
}

/** Insert a document-link card, degrading to an inline link when absent. */
function insertDocLinkCard(
  editor: Editor,
  link: InternalDocLink,
  fallbackUrl: string,
  notify: (message: string) => void,
): void {
  if (editor.schema.nodes['alterDocLink'] !== undefined) {
    editor
      .chain()
      .focus()
      .insertContent({ type: 'alterDocLink', attrs: { docId: link.docId } })
      .run();
    return;
  }
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: fallbackUrl,
          marks: [{ type: 'link', attrs: { href: fallbackUrl } }],
        },
      ],
    })
    .run();
  notify('文档内链卡尚未启用，已插入普通链接');
}

/** Insert a pasted web URL as an inline link at the current selection. */
function insertWebLink(editor: Editor, url: string): void {
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'text',
      text: url,
      marks: [{ type: 'link', attrs: { href: url } }],
    })
    .run();
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
  uploadImage,
  uploadFile,
  onEditorReady,
  commentMarkers,
  onCommentAnchorChange,
  onCommentClick,
  activeCommentId,
}: AlterTiptapEditorProps) {
  const [status, setStatus] = useState<AutosaveStatus>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);
  const [slash, setSlash] = useState<SlashMenuState | null>(null);
  const [linkBar, setLinkBar] = useState<LinkBarState | null>(null);
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [uploading, setUploading] = useState<'image' | 'file' | null>(null);
  const [mindmapEditor, setMindmapEditor] = useState<MindmapEditorState | null>(
    null,
  );
  const [componentPicker, setComponentPicker] =
    useState<ComponentPickerState | null>(null);
  const [componentEditor, setComponentEditor] =
    useState<ComponentEditorState | null>(null);

  const loadingRef = useRef(false);
  const disposedRef = useRef(false);
  const latestEditorJsonRef = useRef<JSONContent | undefined>(undefined);
  const editorRef = useRef<Editor | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  const onCommentAnchorChangeRef = useRef(onCommentAnchorChange);
  onCommentAnchorChangeRef.current = onCommentAnchorChange;
  const onCommentClickRef = useRef(onCommentClick);
  onCommentClickRef.current = onCommentClick;
  const lastReportedCommentRef = useRef('');
  const suppressCommentSelectionRef = useRef(false);
  const composingRef = useRef(false);

  const uploadImageRef = useRef<ImageUploader>((file) =>
    uploadImageWithClient(clientRef.current, file),
  );
  uploadImageRef.current =
    uploadImage ?? ((file) => uploadImageWithClient(clientRef.current, file));
  const uploadFileRef = useRef<FileUploader>((file) =>
    uploadFileWithClient(clientRef.current, file),
  );
  uploadFileRef.current =
    uploadFile ?? ((file) => uploadFileWithClient(clientRef.current, file));

  const slashRef = useRef<SlashMenuState | null>(null);
  slashRef.current = slash;
  const linkBarRef = useRef<LinkBarState | null>(null);
  linkBarRef.current = linkBar;
  const filteredCommandsRef = useRef<readonly SlashCommand[]>([]);
  const executeSlashRef = useRef<(command: SlashCommand) => void>(() => {});
  const insertMindmapRef = useRef<() => void>(() => {});
  const insertComponentRef = useRef<() => void>(() => {});
  /** Object ids whose `object.get` request is already in flight. */
  const componentLoadsRef = useRef<Set<string>>(new Set());

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

  /** Show a transient, readable message in the editor status area. */
  const showNotice = useCallback(
    (message: string, kind: EditorNotice['kind'] = 'info'): void => {
      setNotice({ kind, message });
    },
    [],
  );

  /**
   * Fetch and validate one component object payload. Throws a readable error
   * when the object is missing, unreadable or violates the catalog schema.
   */
  const fetchComponentPayload = useCallback(
    async (objectId: string): Promise<ComponentPayload> => {
      const record = await clientRef.current.getObject(objectId);
      const payload = componentPayloadOf(record);
      if (payload === undefined)
        throw new Error('组件对象不存在或格式不受支持');
      const errors = componentPayloadErrors(payload);
      if (errors.length > 0) throw new Error(errors[0] ?? '组件数据无效');
      return payload;
    },
    [],
  );

  /**
   * Load every component object referenced by the editor document into the
   * preview cache. Node views subscribe to the cache, so late fetches update
   * the preview without recreating the Tiptap node; unknown/broken payloads
   * are cached as readable errors instead of being retried on every render.
   */
  const syncComponentObjects = useCallback(
    (instance: Editor): void => {
      const objectIds = new Set<string>();
      instance.state.doc.descendants((node) => {
        if (node.type.name !== 'alterComponent') return true;
        const objectId = node.attrs['objectId'];
        if (
          typeof objectId === 'string' &&
          objectId !== '' &&
          objectId !== PENDING_OBJECT_ID
        )
          objectIds.add(objectId);
        return true;
      });
      for (const objectId of objectIds) {
        if (
          getComponentObjectState(objectId) !== undefined ||
          componentLoadsRef.current.has(objectId)
        )
          continue;
        componentLoadsRef.current.add(objectId);
        setComponentObjectState(objectId, { status: 'loading' });
        void (async () => {
          try {
            const payload = await fetchComponentPayload(objectId);
            setComponentObjectState(objectId, { status: 'ready', payload });
          } catch (error) {
            setComponentObjectState(objectId, {
              status: 'error',
              message: describeOperationError(error),
            });
          } finally {
            componentLoadsRef.current.delete(objectId);
          }
        })();
      }
    },
    [fetchComponentPayload],
  );

  /**
   * Keep the slash menu in sync with the caret: open it when `/` is typed in
   * an empty paragraph, filter while the query grows, close when the caret
   * leaves that paragraph. IME composition never opens or updates the menu.
   */
  const syncSlashState = useCallback((editorInstance: Editor): void => {
    if (editorInstance.view.composing) return;
    const detected = slashQueryAtSelection(editorInstance);
    if (detected === undefined) {
      if (slashRef.current !== null) setSlash(null);
      return;
    }
    if (slashRef.current === null) {
      // Only a freshly typed `/` in an empty paragraph opens the menu.
      if (detected.text !== '/') return;
      const position = slashMenuPosition(editorInstance);
      setSlash({ query: '', index: 0, top: position.top, left: position.left });
      return;
    }
    const position = slashMenuPosition(editorInstance);
    setSlash((current) => {
      if (current === null) return current;
      const queryChanged = current.query !== detected.query;
      return {
        query: detected.query,
        index: queryChanged ? 0 : current.index,
        top: position.top,
        left: position.left,
      };
    });
  }, []);

  /** Validate, upload and insert image blocks (picker / paste / drop). */
  const insertImageFiles = useCallback(
    async (files: readonly File[], position?: number): Promise<void> => {
      const current = editorRef.current;
      if (current === null || !current.isEditable) return;
      const pending: File[] = [];
      for (const file of files) {
        const invalid = validateImageFile(file);
        if (invalid !== undefined) {
          showNotice(invalid, 'error');
          continue;
        }
        pending.push(file);
      }
      if (pending.length === 0) return;
      setUploading('image');
      try {
        let insertAt = position;
        for (const file of pending) {
          try {
            const uploaded = await uploadImageRef.current(file);
            if (current.isDestroyed) return;
            const node: JSONContent = {
              type: 'alterImage',
              attrs: {
                assetId: uploaded.assetId,
                alt: file.name.trim() === '' ? '图片' : file.name.trim(),
              },
            };
            const chain = current.chain().focus();
            if (insertAt === undefined) {
              chain.insertContent([node, { type: 'paragraph' }]).run();
            } else {
              chain
                .insertContentAt(clampPosition(current, insertAt), [
                  node,
                  { type: 'paragraph' },
                ])
                .run();
            }
            insertAt = undefined;
          } catch (error) {
            showNotice(describeImageError(error), 'error');
          }
        }
      } finally {
        setUploading(null);
      }
    },
    [showNotice],
  );

  /** Validate, upload and insert file cards (picker entry). */
  const insertFileFiles = useCallback(
    async (files: readonly File[], position?: number): Promise<void> => {
      const current = editorRef.current;
      if (current === null || !current.isEditable) return;
      const pending: File[] = [];
      for (const file of files) {
        const invalid = validateFileCard(file);
        if (invalid !== undefined) {
          showNotice(invalid, 'error');
          continue;
        }
        pending.push(file);
      }
      if (pending.length === 0) return;
      setUploading('file');
      try {
        let insertAt = position;
        for (const file of pending) {
          try {
            const mime = inferFileMime(file);
            const uploaded = await uploadFileRef.current(file);
            if (current.isDestroyed) return;
            const node: JSONContent = {
              type: 'alterFile',
              attrs: {
                assetId: uploaded.assetId,
                name: file.name.trim() === '' ? '附件' : file.name.trim(),
                mime: uploaded.mime ?? mime ?? 'application/octet-stream',
                bytes:
                  typeof uploaded.bytes === 'number'
                    ? uploaded.bytes
                    : file.size,
              },
            };
            const chain = current.chain().focus();
            if (insertAt === undefined) {
              chain.insertContent([node, { type: 'paragraph' }]).run();
            } else {
              chain
                .insertContentAt(clampPosition(current, insertAt), [
                  node,
                  { type: 'paragraph' },
                ])
                .run();
            }
            insertAt = undefined;
          } catch (error) {
            showNotice(describeFileError(error), 'error');
          }
        }
      } finally {
        setUploading(null);
      }
    },
    [showNotice],
  );

  const closeLinkBar = useCallback((): void => {
    setLinkBar(null);
  }, []);

  const openLinkBar = useCallback(
    (mode: LinkBarState['mode']): void => {
      const current = editorRef.current;
      if (current === null || !current.isEditable) return;
      const hasLink = current.isActive('link');
      const href =
        mode === 'link' && hasLink
          ? String(current.getAttributes('link')['href'] ?? '')
          : '';
      const { from, to } = current.state.selection;
      setLinkBar({ mode, href, error: null, range: { from, to }, hasLink });
    },
    [],
  );

  /** Apply the link bar URL to the captured selection (or insert it). */
  const confirmLinkBar = useCallback((): void => {
    const bar = linkBarRef.current;
    const current = editorRef.current;
    if (bar === null || current === null) return;
    const href = normalizeLinkHref(bar.href);
    if (href === undefined) {
      setLinkBar((existing) =>
        existing === null
          ? existing
          : { ...existing, error: '链接地址格式不正确' },
      );
      return;
    }
    setLinkBar(null);
    if (bar.mode === 'bookmark') {
      insertBookmarkCard(current, href, showNotice);
      return;
    }
    const chain = current.chain().focus();
    if (bar.range.from !== bar.range.to) chain.setTextSelection(bar.range);
    if (bar.hasLink) chain.extendMarkRange('link');
    if (bar.range.from === bar.range.to && !bar.hasLink) {
      chain.insertContent({
        type: 'text',
        text: href,
        marks: [{ type: 'link', attrs: { href } }],
      });
    } else {
      chain.setLink({ href });
    }
    chain.run();
  }, [showNotice]);

  /** Remove the inline link mark from the captured selection. */
  const removeLink = useCallback((): void => {
    const bar = linkBarRef.current;
    const current = editorRef.current;
    if (bar === null || current === null) return;
    setLinkBar(null);
    const chain = current.chain().focus();
    if (bar.range.from !== bar.range.to) chain.setTextSelection(bar.range);
    chain.extendMarkRange('link').unsetLink().run();
  }, []);

  /** Execute one slash command against the typed `/query` paragraph. */
  const executeSlashCommand = useCallback(
    (command: SlashCommand): void => {
      const current = editorRef.current;
      setSlash(null);
      if (current === null || !current.isEditable) return;
      const range = slashParagraphRange(current);
      if (range === undefined) return;
      const context: SlashCommandContext = {
        editor: current,
        range,
        pickImage: () => imageInputRef.current?.click(),
        pickFile: () => fileInputRef.current?.click(),
        insertMindmap: () => insertMindmapRef.current(),
        insertComponent: () => insertComponentRef.current(),
        promptBookmark: () => openLinkBar('bookmark'),
        notify: (message) => showNotice(message),
      };
      command.run(context);
    },
    [openLinkBar, showNotice],
  );

  /**
   * Drop the typed `/query` when a toolbar action takes over, so no stray
   * slash text is left behind in the paragraph.
   */
  const clearSlashQuery = useCallback((): void => {
    const current = editorRef.current;
    if (current === null || slashRef.current === null) return;
    const range = slashParagraphRange(current);
    setSlash(null);
    if (range !== undefined) current.chain().focus().deleteRange(range).run();
  }, []);

  const filteredCommands =
    slash === null ? [] : filterSlashCommands(slashCommands, slash.query);
  filteredCommandsRef.current = filteredCommands;
  executeSlashRef.current = executeSlashCommand;

  const commentExtension = useMemo(() => createCommentAnchorExtension(), []);
  const extensions = useMemo(
    () => [...editorExtensions, commentExtension],
    [commentExtension],
  );

  const reportCommentSelection = useCallback(
    (next: CommentSelectionAnchor | null): void => {
      const handler = onCommentAnchorChangeRef.current;
      if (handler === undefined) return;
      const key =
        next === null
          ? ''
          : `${next.blockId}:${next.offset}:${next.length}:${next.quote}`;
      if (key === lastReportedCommentRef.current) return;
      lastReportedCommentRef.current = key;
      handler(next);
    },
    [],
  );

  const syncCommentSelection = useCallback(
    (instance: Editor): void => {
      if (instance.isDestroyed) return;
      if (suppressCommentSelectionRef.current) return;
      if (instance.view.composing || composingRef.current) return;
      reportCommentSelection(commentSelectionAnchor(instance) ?? null);
    },
    [reportCommentSelection],
  );

  const editor = useEditor({
    extensions,
    content: projectedContent,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: styles.tiptap,
        'data-doc-format': 'alter-doc/1',
        'aria-label': '结构化文档正文',
      },
      handleKeyDown: (view, event) => {
        // Never steal keys from an active IME composition.
        if (event.isComposing || event.keyCode === 229 || view.composing) {
          return false;
        }
        const menu = slashRef.current;
        if (menu === null) return false;
        const commands = filteredCommandsRef.current;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSlash((current) =>
            current === null
              ? current
              : {
                  ...current,
                  index:
                    commands.length === 0
                      ? 0
                      : (current.index + 1) % commands.length,
                },
          );
          return true;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSlash((current) =>
            current === null
              ? current
              : {
                  ...current,
                  index:
                    commands.length === 0
                      ? 0
                      : (current.index - 1 + commands.length) %
                        commands.length,
                },
          );
          return true;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const command = commands[menu.index] ?? commands[0];
          if (command !== undefined) executeSlashRef.current(command);
          return true;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setSlash(null);
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const current = editorRef.current;
        if (current === null || !current.isEditable) return false;
        const data = event.clipboardData;
        if (data === null) return false;
        const files = Array.from(data.files ?? []);
        if (files.length > 0) {
          for (const file of files) {
            const invalid = validateImageFile(file);
            if (invalid !== undefined) showNotice(invalid, 'error');
          }
          const images = files.filter(
            (file) => validateImageFile(file) === undefined,
          );
          if (images.length === 0) return false;
          event.preventDefault();
          void insertImageFiles(images);
          return true;
        }
        const text = data.getData('text/plain');
        if (text === '') return false;
        const docLink = parseInternalDocLink(text);
        if (docLink !== undefined) {
          event.preventDefault();
          insertDocLinkCard(
            current,
            docLink,
            text.trim(),
            (message) => showNotice(message),
          );
          return true;
        }
        if (isWebUrl(text)) {
          event.preventDefault();
          insertWebLink(current, text.trim());
          return true;
        }
        // Everything else (rich HTML or plain text) falls through to the
        // default ProseMirror paste, which filters unknown nodes/marks by the
        // editor schema.
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        const current = editorRef.current;
        if (moved || current === null || !current.isEditable) return false;
        const data = event.dataTransfer;
        if (data === null) return false;
        const files = Array.from(data.files ?? []);
        if (files.length === 0) return false;
        const images = files.filter(
          (file) => validateImageFile(file) === undefined,
        );
        if (images.length === 0) {
          // Consume the drop so the browser does not navigate to the file.
          event.preventDefault();
          showNotice('仅支持 PNG/JPEG/WebP/GIF 图片', 'error');
          return true;
        }
        event.preventDefault();
        let position: number | undefined;
        try {
          position = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          })?.pos;
        } catch {
          position = undefined;
        }
        void insertImageFiles(images, position);
        return true;
      },
      handleClick: (view, _pos, event) => {
        const current = editorRef.current;
        if (current === null || !current.isEditable) return false;
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest?.('a[href]');
        if (anchor === null || anchor === undefined) return false;
        // File-card download links are node-view controls, not inline links.
        if (anchor.hasAttribute('download')) return false;
        const range = linkRangeFromElement(view, anchor);
        if (range === undefined) return false;
        setLinkBar({
          mode: 'link',
          href: anchor.getAttribute('href') ?? '',
          error: null,
          range,
          hasLink: true,
        });
        return false;
      },
    },
    onUpdate: () => {
      if (loadingRef.current) return;
      latestEditorJsonRef.current = editor.getJSON() as JSONContent;
      controller.notifyChange();
      syncSlashState(editor);
    },
    onSelectionUpdate: () => {
      if (loadingRef.current) return;
      syncSlashState(editor);
      syncCommentSelection(editor);
    },
    onBlur: ({ event }) => {
      setSlash(null);
      // Focusing the comment rail is how an anchored comment gets written; the
      // blur it causes must not drop the selection the comment quotes.
      const next = event.relatedTarget;
      if (
        next !== null &&
        next instanceof Element &&
        next.closest('[data-space-comment-rail]') !== null
      )
        return;
      reportCommentSelection(null);
    },
  });
  editorRef.current = editor;

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
    syncComponentObjects(editor);
  }, [
    externalToken,
    editor,
    projectedContent,
    baseRevision,
    initialTitle,
    initialDoc,
    saver,
    controller,
    syncComponentObjects,
  ]);

  // Load the object payloads of component blocks once the editor exists (and
  // after every wholesale content replacement above/below).
  useEffect(() => {
    syncComponentObjects(editor);
  }, [editor, syncComponentObjects]);

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
    syncComponentObjects(editor);
  }, [restore, editor, controller, syncComponentObjects]);

  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // Comment highlights follow the rail's markers without recreating the
  // editor: the plugin rebuilds decorations from the current doc.
  const markers = commentMarkers ?? EMPTY_COMMENT_MARKERS;
  const activeComment = activeCommentId ?? null;
  useEffect(() => {
    refreshCommentDecorations(editor, markers, activeComment);
  }, [editor, markers, activeComment]);

  // IME composition must not report half-composed selections as anchors.
  useEffect(() => {
    const dom = editor.view.dom;
    const onCompositionStart = (): void => {
      composingRef.current = true;
    };
    const onCompositionEnd = (): void => {
      composingRef.current = false;
      syncCommentSelection(editor);
    };
    dom.addEventListener('compositionstart', onCompositionStart);
    dom.addEventListener('compositionend', onCompositionEnd);
    return () => {
      dom.removeEventListener('compositionstart', onCompositionStart);
      dom.removeEventListener('compositionend', onCompositionEnd);
    };
  }, [editor, syncCommentSelection]);

  // The comment rail's active comment selects and scrolls to its anchor.
  const lastScrolledCommentRef = useRef('');
  useEffect(() => {
    if (activeComment === null) {
      lastScrolledCommentRef.current = '';
      return;
    }
    const marker = markers.find((item) => item.id === activeComment);
    if (marker === undefined) return;
    const key = `${activeComment}:${marker.anchor.blockId}:${marker.anchor.offset}:${marker.anchor.length}`;
    if (lastScrolledCommentRef.current === key) return;
    lastScrolledCommentRef.current = key;
    suppressCommentSelectionRef.current = true;
    try {
      scrollToCommentAnchor(editor, marker.anchor);
    } finally {
      suppressCommentSelectionRef.current = false;
    }
  }, [activeComment, editor, markers]);

  // Hand the editor instance to test/integration seams once.
  const readyNotifiedRef = useRef(false);
  useEffect(() => {
    if (readyNotifiedRef.current) return;
    readyNotifiedRef.current = true;
    onEditorReadyRef.current?.(editor);
  }, [editor]);

  // Auto-dismiss transient notices.
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // A fixed-position menu must not drift away from the caret on scroll.
  const slashOpen = slash !== null;
  useEffect(() => {
    if (!slashOpen) return;
    const close = (): void => setSlash(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [slashOpen]);

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
      syncComponentObjects(editor);
      controller.reset();
      if (!disposedRef.current) {
        onSavedRef.current(snapshot.revision, snapshot.doc, nextTitle);
        onAdoptTitleRef.current?.(nextTitle);
      }
    },
    [controller, docId, editor, saver, syncComponentObjects],
  );

  /** Load the current Host snapshot and adopt it without recreating the editor. */
  const reloadDocumentSnapshot = useCallback(async (): Promise<void> => {
    const snapshot = readSnapshot(await clientRef.current.get(docId));
    if (snapshot === undefined) {
      throw new Error('服务端返回的文档结构无法识别');
    }
    applyServerSnapshot(snapshot);
  }, [applyServerSnapshot, docId]);

  /**
   * Flush the autosave queue and return the revision an out-of-band
   * Document-Operations batch must be based on. A failed save aborts the batch
   * so local edits are never dropped by the following reload.
   */
  const prepareOperationBase = useCallback(async (): Promise<number> => {
    await controller.flush();
    const flushStatus = controller.getStatus();
    if (
      flushStatus.kind === 'failed' ||
      flushStatus.kind === 'conflict' ||
      controller.hasPending()
    ) {
      throw new Error('当前编辑尚未保存成功，请先处理保存错误后再继续');
    }
    return saver.context().baseRevision;
  }, [controller, saver]);

  /**
   * Insert a mindmap block in two Document-Operations batches.
   *
   * The Host resolves `update_object` targets against the batch's base
   * document, so the block must be inserted (batch 1) before its object can be
   * created (batch 2). If batch 2 fails, the placeholder block is removed on a
   * best-effort third batch so no block is left with a dangling
   * `obj_pending` ref.
   */
  const insertMindmapBlock = useCallback(async (): Promise<void> => {
    const current = editorRef.current;
    if (current === null || !current.isEditable) return;
    const blockId = newBlockId();
    const payload = createMindmapPayload();
    let baseRevision: number;
    try {
      baseRevision = await prepareOperationBase();
    } catch (error) {
      showNotice(`插入思维导图失败：${describeOperationError(error)}`, 'error');
      return;
    }
    const after = topLevelBlockIdAt(current);
    // Lock the surface while the two batches are in flight so edits typed
    // between the round-trips cannot be overwritten by the reload below.
    const wasEditable = current.isEditable;
    current.setEditable(false);
    try {
      let insertedRevision: number;
      try {
        const insertResult = await clientRef.current.applyOperations({
          docId,
          baseRevision,
          ops: [
            buildPendingObjectInsertOperation({
              blockId,
              kind: 'mindmap',
              ...(after === undefined ? {} : { after }),
            }),
          ],
        });
        insertedRevision = readRevision(insertResult) ?? baseRevision + 1;
      } catch (error) {
        showNotice(
          `插入思维导图失败：${describeOperationError(error)}`,
          'error',
        );
        return;
      }
      try {
        await clientRef.current.applyOperations({
          docId,
          baseRevision: insertedRevision,
          ops: [
            buildUpdateObjectOperation(
              blockId,
              payload as unknown as JsonValue,
            ),
          ],
        });
      } catch (error) {
        let cleanupHint = '';
        try {
          await clientRef.current.applyOperations({
            docId,
            baseRevision: insertedRevision,
            ops: [buildDeleteBlockOperation(blockId)],
          });
          cleanupHint = '（占位块已清理）';
        } catch {
          cleanupHint = '（占位块清理失败，请刷新后手动删除）';
        }
        showNotice(
          `插入思维导图失败：${describeOperationError(error)}${cleanupHint}`,
          'error',
        );
        return;
      }
      try {
        await reloadDocumentSnapshot();
        showNotice('已插入思维导图');
      } catch (error) {
        showNotice(
          `思维导图已插入，但刷新文档失败：${describeOperationError(error)}`,
          'error',
        );
      }
    } finally {
      if (!current.isDestroyed) current.setEditable(wasEditable);
    }
  }, [
    docId,
    prepareOperationBase,
    reloadDocumentSnapshot,
    showNotice,
  ]);
  insertMindmapRef.current = () => {
    void insertMindmapBlock();
  };

  /** Load one mindmap object payload and open the tree editor. */
  const openMindmapEditor = useCallback(
    async (request: MindmapEditRequest): Promise<void> => {
      const current = editorRef.current;
      if (current === null || !current.isEditable) return;
      const blockId =
        request.blockId ?? findMindmapBlockId(current, request.objectId);
      if (blockId === undefined) {
        showNotice('无法定位思维导图块，请刷新后重试', 'error');
        return;
      }
      setMindmapEditor({
        blockId,
        objectId: request.objectId,
        payload: null,
        loading: true,
        saving: false,
        error: null,
        conflict: false,
      });
      try {
        const record = await clientRef.current.getObject(request.objectId);
        if (record === undefined || record === null) {
          setMindmapEditor((state) =>
            state === null
              ? state
              : {
                  ...state,
                  loading: false,
                  error: '思维导图对象不存在或已被删除',
                },
          );
          return;
        }
        const validated = validateMindmapPayload(readObjectPayload(record));
        setMindmapEditor((state) =>
          state === null
            ? state
            : validated.ok
              ? { ...state, loading: false, payload: validated.payload }
              : { ...state, loading: false, error: validated.error },
        );
      } catch (error) {
        setMindmapEditor((state) =>
          state === null
            ? state
            : {
                ...state,
                loading: false,
                error: describeOperationError(error),
              },
        );
      }
    },
    [showNotice],
  );

  /** Save the edited mindmap payload through `update_object`, then reload. */
  const saveMindmapEditor = useCallback(
    async (payload: MindmapPayload): Promise<void> => {
      const state = mindmapEditor;
      if (state === null || state.saving) return;
      setMindmapEditor({ ...state, saving: true, error: null, conflict: false });
      try {
        const baseRevision = await prepareOperationBase();
        await clientRef.current.applyOperations({
          docId,
          baseRevision,
          ops: [
            { op: 'update_object', target: state.blockId, payload },
          ],
        });
        await reloadDocumentSnapshot();
        setMindmapEditor(null);
        showNotice('思维导图已保存');
      } catch (error) {
        const conflict =
          error instanceof SpaceRemoteError && error.code === 'doc/conflict';
        setMindmapEditor((current) =>
          current === null
            ? current
            : {
                ...current,
                saving: false,
                conflict,
                error: conflict
                  ? '文档已被其他修改更新，请重新加载后再保存'
                  : describeOperationError(error),
              },
        );
      }
    },
    [
      docId,
      mindmapEditor,
      prepareOperationBase,
      reloadDocumentSnapshot,
      showNotice,
    ],
  );

  /** Conflict recovery: reload the document revision, then reopen the editor. */
  const reloadMindmapDocument = useCallback(async (): Promise<void> => {
    setMindmapEditor((current) =>
      current === null
        ? current
        : { ...current, loading: true, error: null, conflict: false },
    );
    try {
      await reloadDocumentSnapshot();
      setMindmapEditor(null);
      showNotice('文档已重新加载，请重新打开思维导图编辑');
    } catch (error) {
      setMindmapEditor((current) =>
        current === null
          ? current
          : { ...current, loading: false, error: describeOperationError(error) },
      );
    }
  }, [reloadDocumentSnapshot, showNotice]);

  const closeMindmapEditor = useCallback((): void => {
    setMindmapEditor(null);
  }, []);

  // The mindmap node view asks the surface to open its tree editor.
  useEffect(() => {
    const onEditRequest = (event: Event): void => {
      const detail = (event as CustomEvent<MindmapEditRequest>).detail;
      if (
        detail === undefined ||
        typeof detail.objectId !== 'string' ||
        detail.objectId === ''
      ) {
        return;
      }
      void openMindmapEditor(detail);
    };
    window.addEventListener(MINDMAP_EDIT_EVENT, onEditRequest);
    return () => {
      window.removeEventListener(MINDMAP_EDIT_EVENT, onEditRequest);
    };
  }, [openMindmapEditor]);

  /** Open the component picker from the slash menu's 「插入组件」 command. */
  insertComponentRef.current = () => {
    setComponentPicker({ inserting: false, error: null });
  };

  /**
   * Insert a component block in two Document-Operations batches: batch 1
   * inserts the placeholder block, batch 2 creates the real object and
   * rewrites the reference. A failed batch 2 deletes the placeholder again.
   */
  const insertComponentBlock = useCallback(
    async (componentId: string): Promise<void> => {
      const current = editorRef.current;
      if (current === null || !current.isEditable) return;
      const payload = createDefaultComponentPayload(componentId);
      if (payload === undefined) {
        setComponentPicker((state) =>
          state === null ? state : { ...state, error: '未知组件' },
        );
        return;
      }
      const blockId = newBlockId();
      let baseRevision: number;
      try {
        baseRevision = await prepareOperationBase();
      } catch (error) {
        setComponentPicker((state) =>
          state === null
            ? state
            : {
                ...state,
                inserting: false,
                error: `插入组件失败：${describeOperationError(error)}`,
              },
        );
        return;
      }
      const after = topLevelBlockIdAt(current);
      const wasEditable = current.isEditable;
      current.setEditable(false);
      setComponentPicker((state) =>
        state === null ? state : { ...state, inserting: true, error: null },
      );
      try {
        let insertedRevision: number;
        try {
          const insertResult = await clientRef.current.applyOperations({
            docId,
            baseRevision,
            ops: [
              buildPendingObjectInsertOperation({
                blockId,
                kind: 'component',
                ...(after === undefined ? {} : { after }),
              }),
            ],
          });
          insertedRevision = readRevision(insertResult) ?? baseRevision + 1;
        } catch (error) {
          setComponentPicker((state) =>
            state === null
              ? state
              : {
                  ...state,
                  inserting: false,
                  error: `插入组件失败：${describeOperationError(error)}`,
                },
          );
          return;
        }
        try {
          await clientRef.current.applyOperations({
            docId,
            baseRevision: insertedRevision,
            ops: [
              buildUpdateObjectOperation(
                blockId,
                payload as unknown as JsonValue,
              ),
            ],
          });
        } catch (error) {
          let cleanupHint = '';
          try {
            await clientRef.current.applyOperations({
              docId,
              baseRevision: insertedRevision,
              ops: [buildDeleteBlockOperation(blockId)],
            });
            cleanupHint = '（占位块已清理）';
          } catch {
            cleanupHint = '（占位块清理失败，请刷新后手动删除）';
          }
          setComponentPicker((state) =>
            state === null
              ? state
              : {
                  ...state,
                  inserting: false,
                  error: `插入组件失败：${describeOperationError(error)}${cleanupHint}`,
                },
          );
          return;
        }
        try {
          await reloadDocumentSnapshot();
          setComponentPicker(null);
          showNotice('已插入组件');
        } catch (error) {
          setComponentPicker((state) =>
            state === null
              ? state
              : {
                  ...state,
                  inserting: false,
                  error: `组件已插入，但刷新文档失败：${describeOperationError(error)}`,
                },
          );
        }
      } finally {
        if (!current.isDestroyed) current.setEditable(wasEditable);
      }
    },
    [docId, prepareOperationBase, reloadDocumentSnapshot, showNotice],
  );

  const closeComponentPicker = useCallback((): void => {
    setComponentPicker(null);
  }, []);

  /** Load one component payload and open the props editor. */
  const openComponentEditor = useCallback(
    async (request: ComponentEditRequest): Promise<void> => {
      const current = editorRef.current;
      if (current === null || !current.isEditable) return;
      const blockId =
        request.blockId ?? findComponentBlockId(current, request.objectId);
      if (blockId === undefined) {
        showNotice('无法定位组件块，请刷新后重试', 'error');
        return;
      }
      setComponentEditor({
        blockId,
        objectId: request.objectId,
        payload: request.payload ?? null,
        loading: request.payload === undefined,
        saving: false,
        error: null,
        conflict: false,
      });
      if (request.payload !== undefined) return;
      const cached = getComponentObjectState(request.objectId);
      if (cached?.status === 'ready') {
        setComponentEditor((state) =>
          state === null
            ? state
            : { ...state, payload: cached.payload, loading: false },
        );
        return;
      }
      try {
        const payload = await fetchComponentPayload(request.objectId);
        setComponentEditor((state) =>
          state === null ? state : { ...state, loading: false, payload },
        );
      } catch (error) {
        setComponentEditor((state) =>
          state === null
            ? state
            : { ...state, loading: false, error: describeOperationError(error) },
        );
      }
    },
    [fetchComponentPayload, showNotice],
  );

  /** Save edited props through `update_object`, then reload the document. */
  const saveComponentEditor = useCallback(
    async (payload: ComponentPayload): Promise<void> => {
      const state = componentEditor;
      if (state === null || state.saving) return;
      setComponentEditor({
        ...state,
        saving: true,
        error: null,
        conflict: false,
      });
      try {
        const baseRevision = await prepareOperationBase();
        await clientRef.current.applyOperations({
          docId,
          baseRevision,
          ops: [
            {
              op: 'update_object',
              target: state.blockId,
              payload: payload as unknown as JsonValue,
            },
          ],
        });
        await reloadDocumentSnapshot();
        setComponentEditor(null);
        showNotice('组件已保存');
      } catch (error) {
        const conflict =
          error instanceof SpaceRemoteError && error.code === 'doc/conflict';
        setComponentEditor((current) =>
          current === null
            ? current
            : {
                ...current,
                saving: false,
                conflict,
                error: conflict
                  ? '文档已被其他修改更新，请重新加载后再保存'
                  : describeOperationError(error),
              },
        );
      }
    },
    [
      componentEditor,
      docId,
      prepareOperationBase,
      reloadDocumentSnapshot,
      showNotice,
    ],
  );

  /** Conflict recovery: reload the document revision, then close the dialog. */
  const reloadComponentDocument = useCallback(async (): Promise<void> => {
    setComponentEditor((current) =>
      current === null
        ? current
        : { ...current, loading: true, error: null, conflict: false },
    );
    try {
      await reloadDocumentSnapshot();
      setComponentEditor(null);
      showNotice('文档已重新加载，请重新打开组件编辑');
    } catch (error) {
      setComponentEditor((current) =>
        current === null
          ? current
          : { ...current, loading: false, error: describeOperationError(error) },
      );
    }
  }, [reloadDocumentSnapshot, showNotice]);

  const closeComponentEditor = useCallback((): void => {
    setComponentEditor(null);
  }, []);

  // The component node view asks the surface to open its props editor.
  useEffect(() => {
    const onEditRequest = (event: Event): void => {
      const detail = (event as CustomEvent<ComponentEditRequest>).detail;
      if (
        detail === undefined ||
        typeof detail.objectId !== 'string' ||
        detail.objectId === ''
      ) {
        return;
      }
      void openComponentEditor(detail);
    };
    window.addEventListener(COMPONENT_EDIT_EVENT, onEditRequest);
    return () => {
      window.removeEventListener(COMPONENT_EDIT_EVENT, onEditRequest);
    };
  }, [openComponentEditor]);

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
      link: current.isActive('link'),
      heading1: current.isActive('heading', { level: 1 }),
      heading2: current.isActive('heading', { level: 2 }),
      heading3: current.isActive('heading', { level: 3 }),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      taskList: current.isActive('taskList'),
      blockquote: current.isActive('blockquote'),
      codeBlock: current.isActive('codeBlock'),
      table: current.isActive('table'),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });

  const toolsDisabled = readOnly;

  const insertCallout = (): void => {
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

  const handleImageInputChange = (
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length > 0) void insertImageFiles(files);
  };

  const handleFileInputChange = (
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length > 0) void insertFileFiles(files);
  };

  const handleSurfaceClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement | null;
      const marked =
        target === null ? null : target.closest('[data-comment-id]');
      const id = marked?.getAttribute('data-comment-id') ?? '';
      if (id === '') return;
      onCommentClickRef.current?.(id);
    },
    [],
  );

  const handleEditorMouseOver = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (readOnly) return;
    const current = editorRef.current;
    if (current === null) return;
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.('a[href]');
    if (anchor === null || anchor === undefined) return;
    // Do not treat the file-card download control as an inline link.
    if (anchor.hasAttribute('download')) return;
    const range = linkRangeFromElement(current.view, anchor);
    if (range === undefined) return;
    setLinkBar((existing) =>
      existing !== null && existing.mode === 'link'
        ? existing
        : {
            mode: 'link',
            href: anchor.getAttribute('href') ?? '',
            error: null,
            range,
            hasLink: true,
          },
    );
  };

  return (
    <section
      className={styles.editor}
      data-doc-editor="tiptap"
      data-dirty={dirty ? 'true' : 'false'}
    >
      <div
        className={styles.toolbar}
        role="toolbar"
        aria-label="文档编辑工具栏"
        onMouseDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest?.('button') === null) return;
          clearSlashQuery();
        }}
      >
        <ToolGroup>
          <ToolButton
            label="B"
            title="粗体"
            active={active.bold}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <ToolButton
            label="I"
            title="斜体"
            active={active.italic}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <ToolButton
            label="U"
            title="下划线"
            active={active.underline}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          />
          <ToolButton
            label="S"
            title="删除线"
            active={active.strike}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
          <ToolButton
            label="高亮"
            title="高亮"
            active={active.highlight}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleHighlight().run()}
          />
          <ToolButton
            label="代码"
            title="行内代码"
            active={active.code}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleCode().run()}
          />
          <ToolButton
            label="链接"
            title="链接"
            active={active.link}
            disabled={toolsDisabled}
            onClick={() => openLinkBar('link')}
          />
        </ToolGroup>
        <ToolGroup>
          <ToolButton
            label="H1"
            title="一级标题"
            active={active.heading1}
            disabled={toolsDisabled}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 1 }).run()
            }
          />
          <ToolButton
            label="H2"
            title="二级标题"
            active={active.heading2}
            disabled={toolsDisabled}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
          />
          <ToolButton
            label="H3"
            title="三级标题"
            active={active.heading3}
            disabled={toolsDisabled}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 3 }).run()
            }
          />
        </ToolGroup>
        <ToolGroup>
          <ToolButton
            label="无序列表"
            title="无序列表"
            active={active.bulletList}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          />
          <ToolButton
            label="有序列表"
            title="有序列表"
            active={active.orderedList}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          />
          <ToolButton
            label="任务列表"
            title="任务列表"
            active={active.taskList}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleTaskList().run()}
          />
          <ToolButton
            label="引用"
            title="引用块"
            active={active.blockquote}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          />
          <ToolButton
            label="代码块"
            title="代码块"
            active={active.codeBlock}
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          />
        </ToolGroup>
        <ToolGroup>
          <ToolButton
            label="表格"
            title="插入表格"
            disabled={toolsDisabled}
            onClick={() =>
              editor
                .chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run()
            }
          />
          <ToolButton
            label="图片"
            title="插入图片"
            disabled={toolsDisabled}
            onClick={() => imageInputRef.current?.click()}
          />
          <ToolButton
            label="文件"
            title="插入文件"
            disabled={toolsDisabled}
            onClick={() => fileInputRef.current?.click()}
          />
          <ToolButton
            label="分割线"
            title="插入分割线"
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          />
          <ToolButton
            label="高亮块"
            title="插入高亮信息块"
            disabled={toolsDisabled}
            onClick={insertCallout}
          />
        </ToolGroup>
        <ToolGroup>
          <ToolButton
            label="撤销"
            title="撤销"
            disabled={toolsDisabled || !active.canUndo}
            onClick={() => editor.chain().focus().undo().run()}
          />
          <ToolButton
            label="重做"
            title="重做"
            disabled={toolsDisabled || !active.canRedo}
            onClick={() => editor.chain().focus().redo().run()}
          />
        </ToolGroup>
        <div className={styles.toolbarSpacer} />
        {uploading === null ? null : (
          <span className={styles.savingHint}>
            {uploading === 'image' ? '图片上传中…' : '文件上传中…'}
          </span>
        )}
        {status.kind === 'saving' ? (
          <span className={styles.savingHint}>保存中…</span>
        ) : null}
      </div>

      {active.table ? (
        <div className={styles.tableBar} role="toolbar" aria-label="表格操作">
          <span className={styles.tableLabel}>表格</span>
          <ToolButton
            label="下方加行"
            title="下方插入行"
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().addRowAfter().run()}
          />
          <ToolButton
            label="右侧加列"
            title="右侧插入列"
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          />
          <ToolButton
            label="删除行"
            title="删除当前行"
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().deleteRow().run()}
          />
          <ToolButton
            label="删除列"
            title="删除当前列"
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().deleteColumn().run()}
          />
          <ToolButton
            label="删除表格"
            title="删除表格"
            disabled={toolsDisabled}
            onClick={() => editor.chain().focus().deleteTable().run()}
          />
        </div>
      ) : null}

      {linkBar === null ? null : (
        <LinkBar
          mode={linkBar.mode}
          href={linkBar.href}
          error={linkBar.error}
          hasLink={linkBar.hasLink}
          onHrefChange={(value) =>
            setLinkBar((current) =>
              current === null
                ? current
                : { ...current, href: value, error: null },
            )
          }
          onConfirm={confirmLinkBar}
          onRemove={removeLink}
          onClose={closeLinkBar}
        />
      )}

      {notice === null ? null : (
        <div
          className={styles.status}
          data-kind={notice.kind === 'error' ? 'error' : 'info'}
          data-notice="true"
          role="status"
        >
          <span className={styles.statusText}>{notice.message}</span>
          <button
            type="button"
            className={styles.statusAction}
            onClick={() => setNotice(null)}
          >
            关闭
          </button>
        </div>
      )}

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

      <div
        className={styles.surface}
        onMouseOver={handleEditorMouseOver}
        onClick={handleSurfaceClick}
      >
        <EditorContent editor={editor} className={styles.content} />
      </div>

      <input
        ref={imageInputRef}
        type="file"
        className={styles.fileInput}
        aria-label="选择图片"
        accept={SUPPORTED_IMAGE_MIMES.join(',')}
        multiple
        onChange={handleImageInputChange}
      />

      <input
        ref={fileInputRef}
        type="file"
        className={styles.fileInput}
        aria-label="选择文件"
        accept={SUPPORTED_FILE_EXTENSIONS.join(',')}
        multiple
        onChange={handleFileInputChange}
      />

      {slash === null ? null : (
        <SlashMenu
          commands={filteredCommands}
          index={slash.index}
          position={{ top: slash.top, left: slash.left }}
          onHover={(index) =>
            setSlash((current) =>
              current === null ? current : { ...current, index },
            )
          }
          onSelect={executeSlashCommand}
        />
      )}

      <MindmapEditor
        open={mindmapEditor !== null}
        initial={mindmapEditor?.payload ?? null}
        loading={mindmapEditor?.loading ?? false}
        saving={mindmapEditor?.saving ?? false}
        error={mindmapEditor?.error ?? null}
        conflict={mindmapEditor?.conflict ?? false}
        onSave={(payload) => {
          void saveMindmapEditor(payload);
        }}
        onClose={closeMindmapEditor}
        onReload={() => {
          void reloadMindmapDocument();
        }}
      />

      <ComponentPicker
        open={componentPicker !== null}
        busy={componentPicker?.inserting ?? false}
        error={componentPicker?.error ?? null}
        onSelect={(componentId) => {
          void insertComponentBlock(componentId);
        }}
        onClose={closeComponentPicker}
      />

      <PropsEditor
        open={componentEditor !== null}
        initial={componentEditor?.payload ?? null}
        loading={componentEditor?.loading ?? false}
        saving={componentEditor?.saving ?? false}
        error={componentEditor?.error ?? null}
        conflict={componentEditor?.conflict ?? false}
        onSave={(payload) => {
          void saveComponentEditor(payload);
        }}
        onClose={closeComponentEditor}
        onReload={() => {
          void reloadComponentDocument();
        }}
      />
    </section>
  );
}
