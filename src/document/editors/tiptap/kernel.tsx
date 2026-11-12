/**
 * React mount for the AST-native editor kernel.
 *
 * This is the only kernel the document page mounts (`EditorKernelProps` is the
 * whole seam). The mount keeps the page-facing handle and lifecycle: a prop
 * revision change rebuilds the editor in place (external reload), comment
 * updates repaint without editing, and unmount destroys everything.
 *
 * @module @alter-dsh/space/document/editors/tiptap/kernel
 */
import { useEffect, useRef, type ReactElement } from 'react';
import type {
  EditorBlockType,
  EditorKernel,
  EditorKernelListener,
  EditorKernelProps,
} from '../kernel';
import { pmDocToBlocks } from './convert';
import { updateCommentExtensionOptions } from './comments';
import { createKernelEditor, type KernelEditor } from './editor';

/** One mounted AST-native kernel: its contract handle plus page-facing extras. */
export interface MountedTiptapKernel {
  kernel: EditorKernel;
  Component: () => ReactElement;
  /**
   * Imperative handle for page-owned UI that must write back into the body.
   *
   * Today that is the link dialog: the page renders the form, the kernel owns
   * the document mutation.
   */
  editorApi: {
    applyLinkEdit(input: {
      kind: 'card' | 'inline';
      pos: number;
      href: string;
      label: string;
    }): void;
    /**
     * Apply one block conversion chosen from the page's 文本类型 menu.
     *
     * The menu is a page-owned frozen component (it needs the React `Menu`
     * from `@alter/ui-system`), so the page sends the choice back here.
     */
    applyBlockType(type: EditorBlockType): void;
    /** Block type at the caret, for the menu's active item. */
    activeBlockType(): EditorBlockType;
  };
}

/** Former name of {@link MountedTiptapKernel}. */
export type TiptapKernelMount = MountedTiptapKernel;

/**
 * Mount the Tiptap kernel for one document body.
 *
 * `getProps` is read on every render instead of capturing the first props: the
 * page reloads the body by passing a new `document`/`revision` (version
 * restore, conflict reload, draft recovery), and a frozen snapshot would leave
 * the live body stale — the next save would then overwrite the restored
 * content with what the kernel kept showing.
 *
 * The component renders an empty host element; the ProseMirror view is created
 * in an effect (it needs a real DOM node) and destroyed on unmount. `load`
 * replaces the body when the base revision changes, without reporting a change.
 */
export function mountTiptapKernel(
  getProps: () => EditorKernelProps,
  hooks: {
    /** Extra surface class the frozen stylesheet expects (`.surface`). */
    surfaceClassName?: string;
    placeholder?: string;
  } = {},
): TiptapKernelMount {
  const listeners = new Set<EditorKernelListener>();
  let mounted: { instance: KernelEditor; host: HTMLElement } | null = null;

  function notify<Key extends Exclude<keyof EditorKernelListener, 'onChange'>>(
    event: Key,
    value: Parameters<NonNullable<EditorKernelListener[Key]>>[0],
  ): void {
    for (const listener of listeners) {
      const handler = listener[event] as
        | ((argument: typeof value) => void)
        | undefined;
      handler?.(value);
    }
  }

  function notifyChange(): void {
    for (const listener of listeners) listener.onChange?.();
  }

  const kernel: EditorKernel = {
    kind: 'tiptap',
    // Live view of the body identity: the page may reload the same doc.
    base: {
      get doc() {
        return getProps().document;
      },
      get revision() {
        return getProps().revision;
      },
    },
    capture() {
      if (mounted === null) return getProps().document.blocks;
      const captured = pmDocToBlocks(mounted.instance.capture());
      for (const warning of captured.warnings) notify('onNotice', warning);
      return captured.value;
    },
    focus() {
      mounted?.instance.editor.commands.focus();
    },
    placeCaretAtEnd() {
      const editor = mounted?.instance.editor;
      if (editor === undefined) return;
      editor.commands.focus(editor.state.doc.content.size);
    },
    subscribe(listener: EditorKernelListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      listeners.clear();
      mounted?.instance.destroy();
      mounted = null;
    },
  };

  const Component = function TiptapEditorKernel(): ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);
    // Fresh props for this render: `revision`/`comments` changes are handled by
    // the effects below instead of being frozen at mount time.
    const props = getProps();

    useEffect(() => {
      const host = hostRef.current;
      if (host === null) return;
      const instance = createKernelEditor({
        element: host,
        doc: props.document,
        autofocusEnd: props.caret === 'end',
        comments: props.comments,
        activeCommentId: props.activeCommentId ?? null,
        onUpdate: () => notifyChange(),
        onCompositionChange: (composing) =>
          notify('onCompositionChange', composing),
        onNotice: (message) => notify('onNotice', message),
        onSelectionChange: (selection) =>
          notify('onSelectionChange', {
            quote: selection.quote,
            collapsed: selection.collapsed,
          }),
        onCommentedTextClick: () => {
          for (const listener of listeners) listener.onCommentedTextClick?.();
        },
        onComment: (quote) => {
          for (const listener of listeners) listener.onCommentRequest?.(quote);
        },
        onLinkEdit: (detail) => {
          for (const listener of listeners) listener.onLinkEditRequest?.(detail);
        },
        onCommentQuotesChange: (updates) => {
          for (const listener of listeners) {
            listener.onCommentQuotesChange?.(updates);
          }
        },
        onCommentAtCaretChange: (commentId) => {
          for (const listener of listeners) {
            listener.onCommentAtCaretChange?.(commentId);
          }
        },
        onOpenWeb: (url) => {
          for (const listener of listeners) listener.onOpenWeb?.(url);
        },
        onOpenDoc: (docId) => {
          for (const listener of listeners) listener.onOpenDoc?.(docId);
        },
        onTextType: (anchor) => {
          for (const listener of listeners) listener.onTextTypeRequest?.(anchor);
        },
        ...(props.importAsset === undefined
          ? {}
          : { importAsset: props.importAsset }),
        ...(props.hasDoc === undefined ? {} : { hasDoc: props.hasDoc }),
        ...(props.docPath === undefined ? {} : { docPath: props.docPath }),
        ...(props.resolveDoc === undefined
          ? {}
          : { resolveDoc: props.resolveDoc }),
        ...(hooks.surfaceClassName === undefined
          ? {}
          : { surfaceClassName: hooks.surfaceClassName }),
        ...(hooks.placeholder === undefined
          ? {}
          : { placeholder: hooks.placeholder }),
      });
      mounted = { instance, host };
      // Expose the live view for diagnostics and wiring tests; it is a DOM
      // property, never serialized and never part of the document AST. It is a
      // getter because an external reload rebuilds the editor (new view).
      Object.defineProperty(host, 'pmView', {
        configurable: true,
        get: () => mounted?.instance.editor.view,
      });
      return () => {
        instance.destroy();
        if (mounted?.instance === instance) mounted = null;
      };
      // Only the document identity drives mount; edits go through the editor.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.docId]);

    // The body was created from the first document; only a *changed* identity
    // replaces it. Replacing on the first effect run would reset the undo stack
    // and the caret right after mount.
    const loadedKeyRef = useRef<string | null>(null);
    useEffect(() => {
      // A new base revision means "the document changed outside this editor".
      // How it is applied depends on the page's intent: another writer's update
      // swaps the body in place, while a session reset (version restore,
      // conflict adoption, draft recovery) rebuilds the editor.
      if (mounted === null) return;
      const key = `${props.docId}:${props.revision}`;
      if (loadedKeyRef.current === null) {
        loadedKeyRef.current = key;
        return;
      }
      if (loadedKeyRef.current === key) return;
      loadedKeyRef.current = key;
      if (props.reload === 'rebuild') {
        mounted.instance.load(props.document);
        return;
      }
      // An in-place refresh reports "unchanged" for an identical body; that is
      // the no-op an echo of our own save must be, never a rebuild (which would
      // throw away the editing session for no new content).
      mounted.instance.refresh(props.document);
    }, [props.docId, props.revision, props.reload]);

    // Comment updates are view-only repaints; an unchanged list (the page
    // re-renders on every edit) must not dispatch a transaction per keystroke.
    const commentSignatureRef = useRef<string | null>(null);
    useEffect(() => {
      if (mounted === null) return;
      const signature = JSON.stringify([
        props.activeCommentId ?? null,
        props.comments.map((comment) => [comment.id, comment.quote]),
      ]);
      if (commentSignatureRef.current === signature) return;
      commentSignatureRef.current = signature;
      updateCommentExtensionOptions(
        mounted.instance.editor.view,
        props.comments,
        props.activeCommentId ?? null,
      );
    }, [props.comments, props.activeCommentId]);

    return <div ref={hostRef} data-editor-kernel="tiptap" />;
  };
  Component.displayName = 'TiptapEditorKernel';

  return {
    kernel,
    Component,
    editorApi: {
      applyLinkEdit(input) {
        mounted?.instance.applyLinkEdit(input);
      },
      applyBlockType(type) {
        mounted?.instance.applyBlockType(type);
      },
      activeBlockType() {
        return mounted?.instance.activeBlockType() ?? 'p';
      },
    },
  };
}

