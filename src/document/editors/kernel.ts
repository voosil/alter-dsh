/**
 * Editor-kernel contract: the seam between the document page shell and one
 * editor kernel implementation.
 *
 * The shell (`vendor/ui-space` `DocumentView`) owns chrome, CSS and routes; a
 * kernel owns only the editable body. Kernels may keep any internal document
 * state (legacy: contentEditable HTML; ProseMirror: its node tree), but they
 * speak AST at this boundary:
 *
 * - {@link EditorKernel.load} replaces the whole document body;
 * - {@link EditorKernel.capture} reports the current body as `alter-doc/1`
 *   blocks (this is what the save controller diffs against the base revision);
 * - {@link EditorKernel.subscribe} reports dirty/composing/selection events,
 *   which the shell turns into save scheduling and comment anchors.
 *
 * Mounting is deliberately React-shaped rather than imperative: every kernel is
 * a component that receives the same props, mounts through `createElement` and
 * exposes a handle through the callback ref. React is the only allowed external
 * dependency of the client bundle, so this contract stays dependency-free to
 * keep it usable from unit tests without a DOM.
 *
 * @module @alter-dsh/space/document/editors/kernel
 */
import type { AlterDoc, BlockNode } from '../types';

/** Kernel identifiers selectable through the UI-preference switch. */
export type EditorKernelKind = 'legacy' | 'tiptap';

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
   * Replacing the body is a remount by `revision` (the shell passes a new
   * `document`), not a method: a kernel that reloads a live body in place would
   * have to reset its own undo stack, selection and comment anchors, and those
   * rules are the kernel's. The shell therefore reloads through props and keeps
   * this handle purely for reads and caret placement.
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
   * The user asked to comment on the current selection.
   *
   * `quote` is the selected plain text; the page opens the comment composer
   * with it, exactly as the frozen editor's toolbar button does.
   */
  onCommentRequest?(quote: string): void;
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
  }): void;
}

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
  /** Base document the body starts from; reloads when `revision` changes. */
  document: AlterDoc;
  /** Base revision of `document`; a change means "reload the body". */
  revision: number;
  /**
   * Legacy kernels render HTML instead of reading the AST directly; the shell
   * projects `document` once and passes the result here. AST-native kernels
   * ignore it.
   */
  baseHtml: string;
  /** Initial caret placement (`end` only for the new-document flow). */
  caret: 'none' | 'end';
  comments: readonly EditorKernelComment[];
  activeCommentId?: string | null;
  disabled?: boolean;
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