/**
 * The AST-native body bridge for the document page.
 *
 * The frozen page (`vendor/ui-space`) owns chrome, comments and the save
 * lifecycle; this bridge mounts the Tiptap kernel through the same contract and
 * reports canonical blocks on every edit. It exists so the vendor page never
 * imports a kernel directly: the page reaches this module and the kernel only
 * through the adapter alias.
 *
 * Geometry: the kernel renders inside the page's existing body container, so
 * the surrounding layout, comment rails and scroll behavior are untouched.
 * A parity gap in the body itself (slash menu, table bar, link editing) is a
 * known M3 remainder, not something this bridge papers over.
 *
 * @module @alter-dsh/space/document/editors/tiptap/body
 */
import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import type { BlockNode } from '../../types';
import type {
  EditorBlockType,
  EditorKernelComment,
  EditorKernelProps,
} from '../kernel';
import { KERNEL_CLASS } from './classes';
import { mountTiptapKernel } from './kernel';

/** Props the frozen document page passes to the AST-native body. */
export interface TiptapBodyProps {
  docId: string;
  /** Base document (authoritative AST the body was loaded from). */
  document: EditorKernelProps['document'];
  /** Bumps on every external reload (version restore, conflict adoption). */
  revision: number;
  caret: 'none' | 'end';
  comments: readonly EditorKernelComment[];
  activeCommentId?: string | null;
  /** Every edit reports the body as canonical AST blocks. */
  onBlocks(blocks: BlockNode[]): void;
  /** A click landed on text carrying a comment (open the rail). */
  onCommentedTextClick?(): void;
  /** Comment under the caret (the page highlights the matching rail card). */
  onCommentAtCaretChange?(commentId: string | null): void;
  /** The body's comment button asked for a new comment on `quote`. */
  onCommentRequest?(quote: string): void;
  /** Comment quotes changed through editing (the page persists them). */
  onCommentQuotesChange?(updates: readonly { id: string; quote: string }[]): void;
  /** The link bar's 编辑 button asked to edit a link. */
  onLinkEditRequest?(detail: {
    kind: 'card' | 'inline';
    href: string;
    pos: number;
    label?: string;
  }): void;
  /** A web link was activated: the page opens it in the host browser. */
  onOpenWeb?(url: string): void;
  /** A document link was activated: the page navigates in-app. */
  onOpenDoc?(docId: string): void;
  /** The toolbar's 文本类型 button asked for the block-type menu. */
  onTextTypeRequest?(anchor: HTMLElement): void;
  /** Upload one pasted/dropped file as an asset (see the kernel contract). */
  importAsset?: EditorKernelProps['importAsset'];
  /** Whether a document id exists (pasted doc links become cards only then). */
  hasDoc?: (docId: string) => boolean;
  /** In-app path of a document id (doc-link card href). */
  docPath?: (docId: string) => string;
  /** Archived state of a document id (doc-link card badge). */
  resolveDoc?: (docId: string) => { archived: boolean } | undefined;
  /** The selection inside the body changed (the page quotes it for comments). */
  onSelectionChange?(selection: { quote: string; collapsed: boolean }): void;
  /**
   * The mounted body's imperative handle (link write-back).
   *
   * Given once per mount so the page can push a dialog result into the kernel.
   */
  onReady?(handle: {
    applyLinkEdit(input: {
      kind: 'card' | 'inline';
      pos: number;
      href: string;
      label: string;
    }): void;
    applyBlockType(type: EditorBlockType): void;
    activeBlockType(): EditorBlockType;
  }): void;
  onNotice?(message: string): void;
}

/**
 * Mount the Tiptap kernel and forward edits to the page.
 *
 * The kernel handle is stable for the lifetime of one document page; the
 * component remounts when `docId` changes (a different document is a different
 * body), which is also when ProseMirror rebuilds its state.
 */
export function TiptapBody(props: TiptapBodyProps): ReactElement {
  const propsRef = useRef(props);
  propsRef.current = props;

  const mounted = useMemo(
    () =>
      mountTiptapKernel(
        // Live props: external reloads (revision/document) and comment updates
        // arrive as new props on this component, and a frozen snapshot would
        // leave the body stale (the next save would then overwrite the
        // restored content).
        () => propsRef.current,
        {
          // The frozen stylesheet's local classes are hashed by CSS Modules:
          // the editable region must carry the resolved `.surface` name.
          surfaceClassName: KERNEL_CLASS.surface,
          placeholder: '开始写点什么…',
        },
      ),
    // The body is remounted per document only; edits flow through the kernel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.docId],
  );

  useEffect(() => {
    const unsubscribe = mounted.kernel.subscribe({
      onChange: () => propsRef.current.onBlocks(mounted.kernel.capture()),
      onNotice: (message) => propsRef.current.onNotice?.(message),
      onCommentedTextClick: () => propsRef.current.onCommentedTextClick?.(),
      onCommentAtCaretChange: (commentId) =>
        propsRef.current.onCommentAtCaretChange?.(commentId),
      onCommentRequest: (quote) => propsRef.current.onCommentRequest?.(quote),
      onCommentQuotesChange: (updates) =>
        propsRef.current.onCommentQuotesChange?.(updates),
      onLinkEditRequest: (detail) => propsRef.current.onLinkEditRequest?.(detail),
      onSelectionChange: (selection) =>
        propsRef.current.onSelectionChange?.(selection),
      onOpenWeb: (url) => propsRef.current.onOpenWeb?.(url),
      onOpenDoc: (docId) => propsRef.current.onOpenDoc?.(docId),
      onTextTypeRequest: (anchor) => propsRef.current.onTextTypeRequest?.(anchor),
    });
    return () => {
      unsubscribe();
      mounted.kernel.destroy();
    };
  }, [mounted]);

  useEffect(() => {
    // Hand the imperative link writer to the page once per mount.
    propsRef.current.onReady?.({
      applyLinkEdit: (input) => mounted.editorApi.applyLinkEdit(input),
      applyBlockType: (type) => mounted.editorApi.applyBlockType(type),
      activeBlockType: () => mounted.editorApi.activeBlockType(),
    });
  }, [mounted]);

  // The frozen page renders `div.editor > div.surface`. `.editor` is the
  // relative-position context and carries the link-card arrow variable, so the
  // kernel reproduces that wrapper instead of relying on the page's layout.
  return (
    <div className={KERNEL_CLASS.editor}>{mounted.Component()}</div>
  );
}