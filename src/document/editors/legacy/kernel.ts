/**
 * Legacy editor kernel: the frozen pre-rebuild contentEditable editor exposed
 * through the kernel-neutral contract.
 *
 * The restored `Editor` in `vendor/ui-space` keeps owning slash menus, table
 * bars, link editing, IME guards, undo and its own body reloading; this module
 * owns only the seam:
 *
 * - `createElement(Editor, …)` mounts it, so React stays the only client
 *   dependency and this module stays testable without a framework;
 * - the adapter's `capture` callback (which the editor calls with its own HTML)
 *   converts that HTML to canonical `alter-doc/1` blocks and caches them, so
 *   the save controller captures without reading the DOM.
 *
 * Nothing here touches the editor's DOM, CSS or JSX: the frozen-page rule is
 * unchanged while legacy is the default kernel. Reloading the body stays with
 * the editor's `externalRevision` handling, which is why the handle exposes
 * `base` (props) instead of a `load` method.
 *
 * @module @alter-dsh/space/document/editors/legacy/kernel
 */
import { createElement, type ComponentType, type ReactElement } from 'react';
import type { BlockNode } from '../../types';
import {
  EDITOR_KERNEL_ATTRIBUTE,
  type EditorKernel,
  type EditorKernelKind,
  type EditorKernelListener,
  type EditorKernelProps,
  type EditorKernelSelection,
} from '../kernel';
import { parseLegacyHtml } from './html-parser';

/** Props the frozen `Editor` accepts (the subset the adapter drives). */
export interface LegacyEditorProps {
  docId: string;
  initialHtml: string;
  externalRevision: number;
  findDoc: (id: string) => unknown;
  onOpenDoc: (id: string) => void;
  onOpenWeb?: (url: string) => void;
  onChange: (html: string) => void;
  onComment: (quote: string) => void;
  comments: readonly { id: string; quote: string }[];
  activeCommentId?: string | null;
  onCommentAtCaretChange?: (id: string | null) => void;
  onCommentQuotesChange?: (updates: { id: string; quote: string }[]) => void;
  onCommentedTextClick?: () => void;
  onNotice?: (message: string) => void;
  onCompositionChange?: (composing: boolean) => void;
}

/** The kernel kind this module implements. */
export const LEGACY_KERNEL_KIND: EditorKernelKind = 'legacy';

/** Attribute value the legacy kernel stamps on its mounted surface. */
export const LEGACY_KERNEL_ATTRIBUTE_VALUE = `${EDITOR_KERNEL_ATTRIBUTE}="legacy"`;

/**
 * Remove empty `content`/`children` arrays so a capture equals what the Host
 * stores (canonical form). Ids and order are preserved.
 */
export function normalizeCapturedBlocks(
  blocks: readonly BlockNode[],
): BlockNode[] {
  return blocks.map((node) => {
    const out: BlockNode = { id: node.id, type: node.type, attrs: node.attrs };
    if (node.content !== undefined && node.content.length > 0) {
      out.content = node.content;
    }
    if (node.children !== undefined && node.children.length > 0) {
      out.children = normalizeCapturedBlocks(node.children);
    }
    return out;
  });
}

/**
 * Capture one legacy editor body as AST blocks.
 *
 * Pure and testable without React: give it the HTML the frozen editor reports
 * and it returns canonical blocks. Parser warnings are returned alongside so
 * the caller surfaces them instead of silently degrading content.
 */
export function captureLegacyBlocks(html: string): {
  blocks: BlockNode[];
  warnings: string[];
} {
  const parsed = parseLegacyHtml(html);
  return {
    blocks: normalizeCapturedBlocks(parsed.blocks),
    warnings: parsed.warnings,
  };
}

/** Collaborators of {@link createLegacyKernel}. */
export interface LegacyKernelOptions {
  /** The frozen `Editor` component (`vendor/ui-space`). */
  Editor: ComponentType<LegacyEditorProps>;
  /** Kernel props from the shell. */
  props: EditorKernelProps;
  /** Forwarded host callbacks (doc links, comment rail, notices). */
  editorProps: Omit<
    LegacyEditorProps,
    'onChange' | 'onCompositionChange' | 'onNotice'
  >;
  /**
   * Read the body the way the frozen editor reports it (its `onChange` source),
   * for callers that need a capture before the next change event.
   */
  readBody?: () => string | undefined;
}

/** One mounted legacy kernel: the component to render and its handle. */
export interface MountedLegacyKernel {
  kernel: EditorKernel;
  Component: ComponentType;
}

/**
 * Mount the frozen editor and expose it as one {@link EditorKernel}.
 *
 * `capture()` returns the last body the editor reported, re-parsed to AST. When
 * nothing was reported yet the body is untouched, so it returns the base
 * document's blocks (the diff then yields no operations). Callers must never
 * turn "no edits" into "empty document".
 */
export function createLegacyKernel(
  options: LegacyKernelOptions,
): MountedLegacyKernel {
  const listeners = new Set<EditorKernelListener>();
  let lastBody: string | undefined;
  let destroyed = false;

  function notify<Key extends Exclude<keyof EditorKernelListener, 'onChange'>>(
    event: Key,
    value: Parameters<NonNullable<EditorKernelListener[Key]>>[0],
  ): void {
    if (destroyed) return;
    for (const listener of listeners) {
      const handler = listener[event] as
        | ((argument: typeof value) => void)
        | undefined;
      handler?.(value);
    }
  }

  /** `onChange` is a pure signal: listeners must receive no argument. */
  function notifyChange(): void {
    if (destroyed) return;
    for (const listener of listeners) listener.onChange?.();
  }

  const kernel: EditorKernel = {
    kind: LEGACY_KERNEL_KIND,
    base: {
      doc: options.props.document,
      revision: options.props.revision,
    },
    capture(): BlockNode[] {
      const html = options.readBody?.() ?? lastBody;
      if (html === undefined) {
        // Untouched body: nothing to diff against the base document.
        return normalizeCapturedBlocks(options.props.document.blocks);
      }
      return captureLegacyBlocks(html).blocks;
    },
    focus(): void {
      // The frozen editor owns its surface element; it focuses itself on the
      // new-document flow through the `caret` prop.
    },
    placeCaretAtEnd(): void {
      // Same: caret placement is the editor's own behavior (new-document flow).
    },
    subscribe(listener: EditorKernelListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy(): void {
      destroyed = true;
      listeners.clear();
      lastBody = undefined;
    },
  };

  const Component = function LegacyEditorKernel(): ReactElement {
    const { props, editorProps } = options;
    return createElement(options.Editor, {
      ...editorProps,
      docId: props.docId,
      initialHtml: props.baseHtml,
      externalRevision: props.revision,
      comments: props.comments,
      activeCommentId: props.activeCommentId,
      onChange: (html: string) => {
        lastBody = html;
        notifyChange();
      },
      onNotice: (message: string) => notify('onNotice', message),
      onCompositionChange: (composing: boolean) =>
        notify('onCompositionChange', composing),
    } as LegacyEditorProps);
  };
  Component.displayName = 'LegacyEditorKernel';

  return { kernel, Component };
}

/**
 * Normalize one reported selection.
 *
 * Kernels may report raw selections; the session layer expects trimmed quotes
 * and consistent collapse semantics.
 */
export function normalizeKernelSelection(
  selection: EditorKernelSelection,
): EditorKernelSelection {
  const quote = selection.quote.trim();
  return {
    quote,
    collapsed: selection.collapsed || quote === '',
    ...(selection.blockId === undefined ? {} : { blockId: selection.blockId }),
  };
}