/**
 * The Tiptap editor instance for one document body.
 *
 * Composition: Tiptap's native extensions (paragraph, heading, lists,
 * blockquote, code, table, hard break, history, IME guarding) plus the
 * manifest-derived nodes/marks (`nodes.ts`) and the input rules that reproduce
 * the frozen editor's markdown-ish shortcuts.
 *
 * The kernel deliberately keeps Zero behavior of its own beyond wiring: every
 * interaction here is either a Tiptap extension or a small input rule with a
 * matching acceptance entry in `docs/acceptance/editor-experience-p0-p6.md`.
 *
 * @module @alter-dsh/space/document/editors/tiptap/editor
 */
import { Editor, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { TaskItem } from '@tiptap/extension-task-item';
import type { Node as PmNode } from '@tiptap/pm/model';
import { documentAssetUrl } from '../../asset-url';
import type { EditorKernelComment } from '../kernel';
import type { AlterDoc } from '../../types';
import { blocksToPmDoc } from './convert';
import { manifestExtensions } from './nodes';
import { createSlashExtension, type SlashOptions } from './slash';
import { createKeyboardExtension } from './keyboard';
import {
  createCommentExtension,
  type CommentExtensionOptions,
} from './comments';
import { createFormatToolbar } from './toolbar';
import { createLinkOverlay, createTableOverlay } from './overlays';

/**
 * Give a native Tiptap node the stable AST block id.
 *
 * Every AST block carries `id` and comment anchors resolve to it, so a node
 * type without the attribute would silently lose its id on the first save.
 * Only block-level nodes get it: ProseMirror rejects attributes on the text
 * node, and inline nodes are not blocks in the AST either.
 *
 * The id is also rendered as `data-block-id`, because that is how the frozen
 * stylesheet and the comment rail locate a block in the DOM.
 */
function withBlockId<T extends AnyExtension>(extension: T): T {
  const candidate = extension as unknown as {
    extend?: (config: Record<string, unknown>) => T;
    type?: string;
  };
  if (candidate.type !== 'node' || typeof candidate.extend !== 'function') {
    return extension;
  }
  const extended = candidate.extend({
    addAttributes(this: {
      name: string;
      parent: (() => Record<string, unknown>) | null;
    }) {
      // The text node must never receive block attributes; ProseMirror rejects
      // the whole schema if it does.
      if (this.name === 'text') return this.parent?.() ?? {};
      const parent = this.parent?.() ?? {};
      // `codeBlock` stores its language as `lang` in the AST; Tiptap's default
      // attribute is `language`, which the Host would reject as unknown.
      const lang =
        this.name === 'codeBlock' ? { lang: { default: null } } : {};
      const id = {
        default: null,
        parseHTML: (element: HTMLElement): string | null =>
          element.getAttribute('data-block-id'),
        renderHTML: (attrs: Record<string, unknown>): Record<string, string> => {
          const value = attrs['id'];
          return typeof value === 'string' && value !== ''
            ? { 'data-block-id': value }
            : {};
        },
      };
      return { ...parent, ...lang, id };
    },
  });
  return extended;
}

/** StarterKit with every mark disabled and every node carrying a block id. */
function kernelStarterKit(): AnyExtension {
  const base = StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    // Dividers are AST nodes; the legacy editor types `---` to insert one.
    horizontalRule: false,
    // Every mark is declared once from the manifest below (no duplicates).
    bold: false,
    italic: false,
    strike: false,
    code: false,
    link: false,
    underline: false,
  });
  return base.extend({
    addExtensions(this: { parent: (() => AnyExtension[]) | null }) {
      const parent = this.parent?.() ?? [];
      return parent.map((extension) => withBlockId(extension));
    },
  });
}

/**
 * Extensions every kernel instance declares (order matters for precedence).
 *
 * @param slash options for the `/` menu (asset picker callback).
 * @param comments comment decorations + commented-text click handling.
 */
export function kernelExtensions(
  slash: SlashOptions = {},
  comments: CommentExtensionOptions = { comments: [] },
): AnyExtension[] {
  return [
    kernelStarterKit(),
    withBlockId(Table.configure({ resizable: false })),
    withBlockId(TableRow),
    withBlockId(TableHeader),
    withBlockId(TableCell),
    withBlockId(TaskItem.configure({ nested: true })),
    ...manifestExtensions((assetId) => documentAssetUrl(assetId)),
    createSlashExtension(slash),
    createKeyboardExtension(),
    createCommentExtension(comments),
  ];
}

/** Options of {@link createKernelEditor}. */
export interface CreateKernelEditorOptions {
  /** Mount point (the frozen `.surface` element). */
  element: HTMLElement;
  /** Document the body starts from. */
  doc: AlterDoc;
  /** Called whenever the user changes the body. */
  onUpdate?: () => void;
  /** Called when the body gains/loses an IME composition. */
  onCompositionChange?: (composing: boolean) => void;
  /** Called when the kernel degrades content instead of hiding it. */
  onNotice?: (message: string) => void;
  /**
   * Whether the body starts focused with the caret at the end (the
   * new-document flow).
   */
  autofocusEnd?: boolean;
  /** Open the asset picker for the slash menu's 图片/文件 commands. */
  onPickAsset?: SlashOptions['onPickAsset'];
  /** Comments to underline inside the body. */
  comments?: readonly EditorKernelComment[];
  activeCommentId?: string | null;
  /** Report the selection (the page turns it into a comment quote). */
  onSelectionChange?: (selection: {
    quote: string;
    collapsed: boolean;
  }) => void;
  /** Click on commented text inside the body. */
  onCommentedTextClick?: () => void;
  /** The toolbar's 添加评论 button asks the page to start a comment. */
  onComment?: (quote: string) => void;
  /** The link bar's 编辑 button asks the page to open its link dialog. */
  onLinkEdit?: (detail: {
    kind: 'card' | 'inline';
    href: string;
    pos: number;
  }) => void;
  /** Apply an edited link back into the body (after the dialog closes). */
  applyLinkEdit?: LinkEditHandler;
}

/**
 * Apply one edited link to the body.
 *
 * Registered by the kernel and called with the dialog's result, so the page
 * keeps ownership of the form while the kernel owns the document mutation.
 */
export type LinkEditHandler = (input: {
  kind: 'card' | 'inline';
  href: string;
  label: string;
}) => void;

/** The body the kernel exposes to the contract. */
export interface KernelEditor {
  editor: Editor;
  /** Replace the whole body without reporting an update. */
  load(doc: AlterDoc): void;
  /** Current body. */
  capture(): PmNode;
  /** Write the page's link dialog result back into the body. */
  applyLinkEdit(input: {
    kind: 'card' | 'inline';
    pos: number;
    href: string;
    label: string;
  }): void;
  destroy(): void;
}

/**
 * Create one Tiptap editor bound to an element.
 *
 * The content is converted from AST before mounting (never parsed from HTML),
 * which is what removes the lossy round-trip the legacy kernel needs.
 */
export function createKernelEditor(options: CreateKernelEditorOptions): KernelEditor {
  const converted = blocksToPmDoc(options.doc.blocks);
  if (converted.warnings.length > 0) {
    for (const warning of converted.warnings) options.onNotice?.(warning);
  }
  let refreshToolbar: (() => void) | undefined;
  const editor = new Editor({
    element: options.element,
    extensions: kernelExtensions(
      options.onPickAsset === undefined
        ? {}
        : { onPickAsset: options.onPickAsset },
      {
        comments: options.comments ?? [],
        activeCommentId: options.activeCommentId ?? null,
        ...(options.onCommentedTextClick === undefined
          ? {}
          : { onCommentedTextClick: options.onCommentedTextClick }),
      },
    ),
    // Tiptap accepts a ProseMirror JSON document; the AST is converted once,
    // so no HTML string ever becomes the source of truth.
    content: converted.value.toJSON(),
    // The kernel owns the DOM class names through the frozen stylesheet.
    editorProps: {
      attributes: {
        class: 'kernelSurface',
      },
    },
    onUpdate: () => {
      options.onUpdate?.();
      refreshToolbar?.();
    },
    onSelectionUpdate: ({ editor: current }) => {
      // The page turns a non-empty selection into a comment quote.
      const { selection } = current.state;
      const quote = selection.empty
        ? ''
        : current.state.doc.textBetween(selection.from, selection.to, '\n');
      options.onSelectionChange?.({ quote, collapsed: selection.empty });
      refreshToolbar?.();
    },
  });

  // The floating format bar lives outside the document body: it must survive
  // edits and be removed with the kernel, never serialized into the AST.
  const toolbar = createFormatToolbar({
    editor,
    onComment: (quote) => options.onComment?.(quote),
  });
  // Bound after creation so the callbacks above stay free of an ordering
  // dependency on the toolbar instance.
  refreshToolbar = () => toolbar.update();

  // Table / link overlays are body-level too: same lifetime as the kernel.
  const tableOverlay = createTableOverlay(editor);
  const linkOverlay = createLinkOverlay(editor, {
    onChange: () => options.onUpdate?.(),
    onEdit: (detail) => options.onLinkEdit?.(detail),
  });

  if (options.autofocusEnd === true) {
    const end = editor.state.doc.content.size;
    editor.commands.focus(end);
  }

  let composing = false;
  const handleCompositionStart = () => {
    if (composing) return;
    composing = true;
    options.onCompositionChange?.(true);
  };
  const handleCompositionEnd = () => {
    if (!composing) return;
    composing = false;
    options.onCompositionChange?.(false);
  };
  const dom = editor.view.dom;
  dom.addEventListener('compositionstart', handleCompositionStart);
  dom.addEventListener('compositionend', handleCompositionEnd);

  return {
    editor,
    load(doc: AlterDoc) {
      const next = blocksToPmDoc(doc.blocks);
      for (const warning of next.warnings) options.onNotice?.(warning);
      // Replace content without reporting an update (external reload).
      editor.commands.setContent(next.value.toJSON(), { emitUpdate: false });
    },
    capture() {
      return editor.state.doc;
    },
    /** Write the page's link dialog result back into the body. */
    applyLinkEdit(input: { kind: 'card' | 'inline'; pos: number; href: string; label: string }) {
      linkOverlay.applyEdit(input);
    },
    destroy() {
      dom.removeEventListener('compositionstart', handleCompositionStart);
      dom.removeEventListener('compositionend', handleCompositionEnd);
      // Body-level overlays must never outlive the kernel.
      toolbar.destroy();
      tableOverlay.destroy();
      linkOverlay.destroy();
      editor.destroy();
    },
  };
}
