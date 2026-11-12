/**
 * Editor-kernel contract: the seam between the document page shell and the
 * AST-native editor kernel.
 *
 * The shell (`vendor/ui-space` `DocumentView`) owns chrome, CSS, routes and the
 * save lifecycle; the kernel owns only the editable body. Its internal state is
 * a ProseMirror tree, but it speaks AST at this boundary:
 *
 * - {@link EditorKernel.load} replaces the whole document body (external reload,
 *   version restore, draft recovery);
 * - {@link EditorKernel.capture} reports the current body as `alter-doc/1`
 *   blocks (this is what the save controller diffs against the base revision);
 * - {@link EditorKernel.subscribe} reports dirty/composing/selection events,
 *   which the shell turns into save scheduling and comment anchors.
 *
 * Mounting is deliberately React-shaped rather than imperative: the kernel is a
 * component that receives props, mounts through `createElement` and exposes a
 * handle through the callback ref. React is the only allowed external
 * dependency of the client bundle, so this contract stays dependency-free to
 * keep it usable from unit tests without a DOM.
 *
 * @module @alter-dsh/space/document/editors/kernel
 */
import type { AlterDoc, BlockNode } from '../types';

/** The editor-kernel implementation in use (the AST-native kernel). */
export type EditorKernelKind = 'tiptap';

/** Comments rendered inside the editable body (marks/rings on quoted text). */
export interface EditorKernelComment {
  id: string;
  quote: string;
}

/** Imperative handle the shell keeps for one mounted kernel. */
export interface EditorKernel {
  readonly kind: EditorKernelKind;
  /**
   * Document the body was loaded from, plus its base revision.
   *
   * The shell reloads the body through props (`document` + `revision`); the
   * kernel rebuilds its editor in place, which resets the undo stack, the
   * selection and the comment anchors. This handle stays for reads and caret
   * placement.
   */
  readonly base: { doc: AlterDoc; revision: number };
  /** Current body as AST blocks (canonical: empty `content`/`children` omitted). */
  capture(): BlockNode[];
  /** Focus the body without moving the caret when it already has one. */
  focus(): void;
  /** Put the caret at the end of the body (new document flow). */
  placeCaretAtEnd(): void;
  /** Subscribe to body events; returns the unsubscribe function. */
  subscribe(listener: EditorKernelListener): () => void;
  /** Destroy the kernel (called on unmount before the DOM node is reused). */
  destroy(): void;
}

/** Body events a kernel reports to the shell. */
export interface EditorKernelListener {
  /** The user changed the body: schedule a debounced save + draft. */
  onChange?(): void;
  /** An IME composition started/ended: the save layer pauses meanwhile. */
  onCompositionChange?(composing: boolean): void;
  /**
   * The text selection inside the body changed. `quote` is the plain text of
   * the selection (empty when collapsed or outside the body); `blockId` is the
   * top-level block containing the selection start when the kernel knows it.
   */
  onSelectionChange?(selection: EditorKernelSelection): void;
  /** Body content was simplified or degraded; report it instead of hiding. */
  onNotice?(message: string): void;
  /**
   * The user clicked text that carries a comment.
   *
   * The page uses it to open the comment rail, matching the frozen editor's
   * "click commented text to reveal the annotation" behavior.
   */
  onCommentedTextClick?(): void;
  /**
   * The comment under the caret changed, or `null` when it left every comment.
   *
   * The page keeps the hovered/caret comment active, so the rail card and the
   * text tint follow the cursor, matching the frozen editor.
   */
  onCommentAtCaretChange?(commentId: string | null): void;
  /**
   * The user asked to comment on the current selection.
   *
   * `quote` is the selected plain text; the page opens the comment composer
   * with it, exactly as the frozen editor's toolbar button does.
   */
  onCommentRequest?(quote: string): void;
  /**
   * Comment quotes changed because the commented text was edited.
   *
   * The kernel maintains comment ranges as flat-text anchors (exactly like the
   * frozen editor); the page owns persistence and debounces the update.
   */
  onCommentQuotesChange?(updates: readonly { id: string; quote: string }[]): void;
  /**
   * The user asked to edit a link's fields.
   *
   * `pos` identifies the link so the page's dialog result can be written back
   * through the kernel (see the `applyLinkEdit` handle method).
   */
  onLinkEditRequest?(detail: {
    kind: 'card' | 'inline';
    href: string;
    pos: number;
    /** Current display text (the frozen dialog prefills it). */
    label?: string;
  }): void;
  /**
   * The user activated an external link (web-link card, inline web link).
   *
   * The page owns browser integration: it opens the URL in the host browser
   * (the frozen page routes this through the workbench's `openWeb`).
   */
  onOpenWeb?(url: string): void;
  /** The user activated an in-app document link: the page navigates. */
  onOpenDoc?(docId: string): void;
  /**
   * The toolbar's 文本类型 button asked for the block-type menu.
   *
   * The page renders the frozen `Menu` component anchored at `anchor`; the
   * chosen conversion is written back through the kernel handle's
   * `applyBlockType`.
   */
  onTextTypeRequest?(anchor: HTMLElement): void;
}

/** Block conversions the page's 文本类型 menu can request. */
export type EditorBlockType =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'todo'
  | 'quote'
  | 'code';

/** One reported selection. */
export interface EditorKernelSelection {
  quote: string;
  blockId?: string;
  /** Whether the selection is a caret (platform key semantics depend on it). */
  collapsed: boolean;
}

/**
 * Stable body identity for tests and diagnostics (never serialized).
 *
 * The shell mounts either kernel at the same place, so tests and the parity
 * checklist locate the body through this attribute instead of a CSS class.
 */
export const EDITOR_KERNEL_ATTRIBUTE = 'data-editor-kernel';

/** Props every kernel component accepts (structural, framework-agnostic). */
export interface EditorKernelProps {
  docId: string;
  /** Base document the body starts from; replaces the body when `revision` changes. */
  document: AlterDoc;
  /** Base revision of `document`; a change means "replace the body". */
  revision: number;
  /**
   * How a newer `revision` treats the live editing session.
   *
   * - `refresh`: another writer updated the document. Swap the body in place so
   *   the undo stack, the caret and the floating surfaces survive.
   * - `rebuild`: the session must reset (version restore, conflict adoption,
   *   crash-draft recovery). A fresh editor keeps a restored version from being
   *   undone back into the pre-restore body.
   */
  reload?: 'refresh' | 'rebuild';
  /** Initial caret placement (`end` only for the new-document flow). */
  caret: 'none' | 'end';
  comments: readonly EditorKernelComment[];
  activeCommentId?: string | null;
  disabled?: boolean;
  /**
   * Upload one pasted/dropped file and return its content-addressed reference.
   *
   * AST-native kernels cannot keep a `data:` payload in the body (the AST has
   * no such field; the Host rejects base64 blobs), so a pasted image is
   * uploaded before insertion. Legacy kernels ignore it: they keep the `data:`
   * URL in the DOM and materialize it at save time.
   */
  importAsset?(input: {
    kind: 'image' | 'file';
    mime: string;
    dataBase64: string;
    name?: string;
  }): Promise<{ assetId: string; mime: string; bytes: number; name?: string }>;
  /**
   * Whether a document id exists in the current space.
   *
   * Pasting an in-app document URL becomes a doc-link card only when the target
   * exists (the frozen editor passes `findDoc`); without this the kernel inserts
   * the card-shaped link anyway.
   */
  hasDoc?(docId: string): boolean;
  /** In-app path of a document id (doc-link card href). */
  docPath?(docId: string): string;
  /** Archived state of a document id (doc-link card badge). */
  resolveDoc?(docId: string): { archived: boolean } | undefined;
}

/**
 * What a save cycle needs from the mounted kernel.
 *
 * The save controller's snapshot is kernel-independent, so any kernel plugs
 * into the same save/conflict/draft state machine through this shape.
 */
export interface EditorKernelCaptureSource {
  /** Current body + title. Must never throw for a healthy kernel. */
  capture(): { blocks: BlockNode[]; title: string };
}