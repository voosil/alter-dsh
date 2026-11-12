/**
 * React mount for the Tiptap kernel + the kernel-selection preference.
 *
 * Both kernels mount through the same shape (`EditorKernelProps`), so the shell
 * only decides which one to render. The choice is a UI preference and lives in
 * localStorage — business data never does (Host is the only authority).
 *
 * The new kernel is **off by default**: `legacy` stays the default until the
 * parity checklist is signed off (design §6). The switch exists so the parity
 * review can compare both kernels side by side on the same document.
 *
 * @module @alter-dsh/space/document/editors/tiptap/kernel
 */
import { useEffect, useRef, type ReactElement } from 'react';
import type {
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
  };
}

/** Former name of {@link MountedTiptapKernel}. */
export type TiptapKernelMount = MountedTiptapKernel;

/**
 * Mount the Tiptap kernel for one document body.
 *
 * The component renders an empty host element; the ProseMirror view is created
 * in an effect (it needs a real DOM node) and destroyed on unmount. `load`
 * replaces the body when the base revision changes, without reporting a change.
 */
export function mountTiptapKernel(
  props: EditorKernelProps,
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
    base: { doc: props.document, revision: props.revision },
    capture() {
      if (mounted === null) return props.document.blocks;
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
      });
      if (hooks.surfaceClassName !== undefined) {
        // The ProseMirror view creates its own editable element inside the
        // host; both carry the frozen surface class so the stylesheet applies.
        host.classList.add(hooks.surfaceClassName);
        instance.editor.view.dom.classList.add(hooks.surfaceClassName);
      }
      if (hooks.placeholder !== undefined) {
        instance.editor.view.dom.setAttribute(
          'data-placeholder',
          hooks.placeholder,
        );
      }
      mounted = { instance, host };
      // Expose the live view for diagnostics and wiring tests; it is a DOM
      // property, never serialized and never part of the document AST.
      (host as HTMLElement & { pmView?: unknown }).pmView = instance.editor.view;
      return () => {
        instance.destroy();
        if (mounted?.instance === instance) mounted = null;
      };
      // Only the document identity drives mount; edits go through the editor.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.docId]);

    useEffect(() => {
      // A new base revision means "external reload": replace the body without
      // reporting an edit (the save controller owns the base revision).
      if (mounted === null) return;
      mounted.instance.load(props.document);
    }, [props.docId, props.revision]);

    useEffect(() => {
      // Comment list / active id changes are decoration updates, not edits.
      if (mounted === null) return;
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
    },
  };
}

