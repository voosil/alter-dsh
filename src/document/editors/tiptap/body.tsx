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
import type { EditorKernelComment, EditorKernelProps } from '../kernel';
import { mountTiptapKernel } from './kernel';

/** Props the frozen document page passes to the AST-native body. */
export interface TiptapBodyProps {
  docId: string;
  /** Base document (authoritative AST the body was loaded from). */
  document: EditorKernelProps['document'];
  /** Bumps on every external reload (version restore, conflict adoption). */
  revision: number;
  /** Legacy projection used only as a cross-check input; never rendered. */
  baseHtml: string;
  caret: 'none' | 'end';
  comments: readonly EditorKernelComment[];
  activeCommentId?: string | null;
  /** Every edit reports the body as canonical AST blocks. */
  onBlocks(blocks: BlockNode[]): void;
  /** A click landed on text carrying a comment (open the rail). */
  onCommentedTextClick?(): void;
  /** The body's comment button asked for a new comment on `quote`. */
  onCommentRequest?(quote: string): void;
  /** The link bar's 编辑 button asked to edit a link. */
  onLinkEditRequest?(detail: {
    kind: 'card' | 'inline';
    href: string;
    pos: number;
  }): void;
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
        {
          docId: props.docId,
          document: props.document,
          revision: props.revision,
          baseHtml: props.baseHtml,
          caret: props.caret,
          comments: props.comments,
          ...(props.activeCommentId === undefined
            ? {}
            : { activeCommentId: props.activeCommentId }),
        },
        {
          // The frozen stylesheet targets `.surface` for the editable region.
          surfaceClassName: 'surface',
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
      onCommentRequest: (quote) => propsRef.current.onCommentRequest?.(quote),
      onLinkEditRequest: (detail) => propsRef.current.onLinkEditRequest?.(detail),
      onSelectionChange: (selection) =>
        propsRef.current.onSelectionChange?.(selection),
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
    });
  }, [mounted]);

  return mounted.Component();
}