/**
 * The Tiptap editor instance for one document body, and its wiring.
 *
 * The kernel is assembled from small modules rather than one hand-written
 * editor; each owns one page-visible surface and has a matching acceptance
 * entry in `docs/acceptance/editor-experience-p0-p6.md`:
 *
 * - `nodes.ts` / `cards.ts` / `node-views.ts` — AST node specs and the frozen
 *   DOM contract for every block (todo rows, cards, tables, code blocks);
 * - `input-rules.ts` — line conversions (`#`, `-`, `[]`, `>`, `N.`, ```, `---`);
 * - `keyboard.ts` — keyboard edges (Mod-U, table Tab, code-block Enter,
 *   empty-list/quote backspace) and IME timing;
 * - `paste.ts` — clipboard/drop sanitizing and asset upload;
 * - `slash.ts` / `toolbar.ts` / `overlays.ts` / `block-selection.ts` — the
 *   frozen floating surfaces and the block-selection state machine;
 * - `comments.ts` — comment painting (CSS Custom Highlight API) and quote
 *   maintenance;
 * - `block-ids.ts` — stable block identity across saves.
 *
 * This module only composes them, mounts the body, and exposes the page-facing
 * handle (link write-back, block conversion, reload). It owns no editing
 * behavior beyond that wiring.
 *
 * @module @alter-dsh/space/document/editors/tiptap/editor
 */
import { Editor, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Node as PmNode } from '@tiptap/pm/model';
import { documentAssetUrl } from '../../asset-url';
import type {
  EditorBlockType,
  EditorKernelComment,
  EditorKernelProps,
} from '../kernel';
import type { AlterDoc } from '../../types';
import { blocksToPmDoc } from './convert';
import { KernelTable, manifestExtensions } from './nodes';
import { createSlashExtension, type SlashOptions } from './slash';
import { createKeyboardExtension } from './keyboard';
import { createLineRulesExtension } from './input-rules';
import { createPasteExtension } from './paste';
import {
  blockSelectionOf,
  handleBlockSelectionKey,
} from './block-selection';
import { createBlockIdExtension } from './block-ids';
import {
  createCommentExtension,
  repaintComments,
  type CommentExtensionOptions,
} from './comments';
import { createFormatToolbar } from './toolbar';
import {
  closeOverlayBars,
  createLinkOverlay,
  createTableOverlay,
} from './overlays';
import { createBlockHandle } from './block-handle';
// Kernel-owned structural normalization (scoped to `.kernelSurface`).
import './kernel.css';

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
      // attribute is `language`, which the Host would reject as unknown. The
      // frozen DOM exposes it as `data-lang`, never as a bare `lang` attribute.
      const lang =
        this.name === 'codeBlock'
          ? {
              lang: {
                default: null,
                parseHTML: (element: HTMLElement): string | null =>
                  element.getAttribute('data-lang'),
                renderHTML: (
                  attrs: Record<string, unknown>,
                ): Record<string, string> => {
                  const value = attrs['lang'];
                  return typeof value === 'string' && value !== ''
                    ? { 'data-lang': value }
                    : {};
                },
              },
            }
          : {};
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
    // Dividers are AST nodes; the frozen editor types `---` to insert one.
    horizontalRule: false,
    // The frozen editor appends no trailing paragraph (documents may end with
    // a divider/image/table) and draws no drag insertion cursor.
    trailingNode: false,
    dropcursor: false,
    // The frozen editor's code block never exits on Enter/ArrowDown (Enter
    // inserts a literal newline) and its lists never sink/lift on Tab.
    codeBlock: { exitOnTripleEnter: false, exitOnArrowDown: false },
    listKeymap: false,
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

/** Page callbacks the extension set needs (cards, assets, notices). */
export interface KernelExtensionOptions {
  /** Open a web link (card or inline) in the host browser. */
  onOpenWeb?: (url: string) => void;
  /** Navigate to an in-app document link. */
  onOpenDoc?: (docId: string) => void;
  /** Upload one pasted/dropped file as an asset. */
  importAsset?: EditorKernelProps['importAsset'];
  /** Report a degraded/simplified input instead of hiding it. */
  onNotice?: (message: string) => void;
  /** One edit happened (IME commit needs an explicit notification). */
  onUpdate?: () => void;
  /** Whether a document id exists (pasted doc links become cards only then). */
  hasDoc?: (docId: string) => boolean;
  /** In-app path of a document id (doc-link card href). */
  docPath?: (docId: string) => string;
  /** Archived state of a document id (doc-link card badge). */
  resolveDoc?: (docId: string) => { archived: boolean } | undefined;
}

/**
 * Extensions every kernel instance declares (order matters for precedence).
 *
 * @param slash options for the `/` menu (asset picker callback).
 * @param comments comment ranges + commented-text click handling.
 * @param options page callbacks the node set and input layer need.
 */
export function kernelExtensions(
  slash: SlashOptions = {},
  comments: CommentExtensionOptions = { comments: [] },
  options: KernelExtensionOptions = {},
): AnyExtension[] {
  return [
    kernelStarterKit(),
    // `table` (commands + bare DOM) lives in nodes.ts; its row/cell parts are
    // declared by `manifestExtensions` below.
    KernelTable,
    ...manifestExtensions((assetId) => documentAssetUrl(assetId), {
      ...(options.onOpenWeb === undefined ? {} : { onOpenWeb: options.onOpenWeb }),
      ...(options.onOpenDoc === undefined ? {} : { onOpenDoc: options.onOpenDoc }),
      ...(options.docPath === undefined ? {} : { docPath: options.docPath }),
      ...(options.resolveDoc === undefined
        ? {}
        : { resolveDoc: options.resolveDoc }),
    }),
    createSlashExtension(slash),
    createKeyboardExtension({
      onChange: () => options.onUpdate?.(),
      handleBlockSelectionKey,
      clearBlockSelection: (target) => blockSelectionOf(target).clear(),
      closeOverlayBars,
    }),
    createLineRulesExtension(),
    createPasteExtension({
      ...(options.importAsset === undefined
        ? {}
        : { importAsset: options.importAsset }),
      ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
      ...(options.hasDoc === undefined ? {} : { hasDoc: options.hasDoc }),
    }),
    createBlockIdExtension(),
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
  /** Resolved frozen `.surface` class (CSS Modules hash) for the editable. */
  surfaceClassName?: string;
  /** Frozen empty-document placeholder text. */
  placeholder?: string;
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
  /** A web link was activated (the page opens it in the host browser). */
  onOpenWeb?: (url: string) => void;
  /** A document link was activated (the page navigates in-app). */
  onOpenDoc?: (docId: string) => void;
  /** The toolbar's 文本类型 button asked for the block-type menu. */
  onTextType?: (anchor: HTMLElement) => void;
  /** Upload one pasted/dropped file as an asset. */
  importAsset?: EditorKernelProps['importAsset'];
  /** Comment quotes changed through editing (the page persists them). */
  onCommentQuotesChange?: (updates: readonly { id: string; quote: string }[]) => void;
  /** Comment under the caret (the page keeps the rail card active). */
  onCommentAtCaretChange?: (commentId: string | null) => void;
  /** Whether a document id exists (pasted doc links become cards only then). */
  hasDoc?: (docId: string) => boolean;
  /** In-app path of a document id (doc-link card href). */
  docPath?: (docId: string) => string;
  /** Archived state of a document id (doc-link card badge). */
  resolveDoc?: (docId: string) => { archived: boolean } | undefined;
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
  /** Convert the block(s) at the caret (the page's 文本类型 menu result). */
  applyBlockType(type: EditorBlockType): void;
  /** Block type at the caret (the frozen 文本类型 menu's active item). */
  activeBlockType(): EditorBlockType;
  destroy(): void;
}

/**
 * Convert the block at the caret to one AST block type.
 *
 * The page's 文本类型 menu is a frozen React component, so the conversion comes
 * back through this function. Commands are resolved by name because a custom
 * kernel node (e.g. the task list) may not be registered on the Tiptap chain
 * type; a missing command is a no-op instead of a crash.
 */
export function activeBlockTypeOf(editor: Editor): EditorBlockType {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    switch (name) {
      case 'heading': {
        const level = $from.node(depth).attrs['level'];
        return level === 2 ? 'h2' : level === 3 ? 'h3' : 'h1';
      }
      case 'blockquote':
        return 'quote';
      case 'codeBlock':
        return 'code';
      case 'taskList':
        return 'todo';
      case 'bulletList':
        return 'bullet';
      case 'orderedList':
        return 'ordered';
      default:
        break;
    }
  }
  return 'p';
}

export function applyBlockType(editor: Editor, type: EditorBlockType): void {
  const chain = editor.chain().focus();
  switch (type) {
    case 'p':
      chain.setParagraph().run();
      return;
    case 'h1':
      chain.setHeading({ level: 1 }).run();
      return;
    case 'h2':
      chain.setHeading({ level: 2 }).run();
      return;
    case 'h3':
      chain.setHeading({ level: 3 }).run();
      return;
    case 'bullet':
      chain.toggleBulletList().run();
      return;
    case 'ordered':
      chain.toggleOrderedList().run();
      return;
    case 'quote':
      chain.toggleBlockquote().run();
      return;
    case 'code':
      chain.toggleCodeBlock().run();
      return;
    case 'todo': {
      const commands = chain as unknown as Record<
        string,
        (() => { run(): boolean }) | undefined
      >;
      commands['toggleTaskList']?.()?.run();
      return;
    }
  }
}

/**
 * Create one Tiptap editor bound to an element.
 *
 * The content is converted from AST before mounting (never parsed from HTML),
 * which is what removes the lossy HTML round-trip the retired editor needed.
 */
export function createKernelEditor(options: CreateKernelEditorOptions): KernelEditor {
  /** One live editor plus the surfaces bound to its view. */
  interface KernelRuntime {
    editor: Editor;
    applyLinkEdit(input: {
      kind: 'card' | 'inline';
      pos: number;
      href: string;
      label: string;
    }): void;
    destroy(): void;
  }

  let runtime: KernelRuntime | null = null;
  /** Last built runtime, kept for read-only calls made after destroy(). */
  let lastRuntime: KernelRuntime | null = null;

  /**
   * Build one editor instance and its body-level surfaces.
   *
   * Rebuilding (rather than `setContent`) is what an external reload needs:
   * a fresh editor resets the undo stack, the selection and the comment
   * anchors, so a restored version cannot be undone into the pre-restore body
   * and stale comment offsets can never be applied to the new document.
   */
  function build(doc: AlterDoc, autofocusEnd: boolean): KernelRuntime {
    const converted = blocksToPmDoc(doc.blocks);
    for (const warning of converted.warnings) options.onNotice?.(warning);

    let refreshToolbar: (() => void) | undefined;
    const editor = new Editor({
      element: options.element,
      extensions: kernelExtensions(
        {
          ...(options.onPickAsset === undefined
            ? {}
            : { onPickAsset: options.onPickAsset }),
          ...(options.importAsset === undefined
            ? {}
            : { importAsset: options.importAsset }),
          ...(options.onNotice === undefined
            ? {}
            : { onNotice: options.onNotice }),
        },
        {
          comments: options.comments ?? [],
          activeCommentId: options.activeCommentId ?? null,
          ...(options.onCommentedTextClick === undefined
            ? {}
            : { onCommentedTextClick: options.onCommentedTextClick }),
          ...(options.onCommentQuotesChange === undefined
            ? {}
            : { onCommentQuotesChange: options.onCommentQuotesChange }),
          ...(options.onCommentAtCaretChange === undefined
            ? {}
            : { onCommentAtCaretChange: options.onCommentAtCaretChange }),
        },
        {
          ...(options.onOpenWeb === undefined
            ? {}
            : { onOpenWeb: options.onOpenWeb }),
          ...(options.onOpenDoc === undefined
            ? {}
            : { onOpenDoc: options.onOpenDoc }),
          ...(options.importAsset === undefined
            ? {}
            : { importAsset: options.importAsset }),
          ...(options.onNotice === undefined
            ? {}
            : { onNotice: options.onNotice }),
          ...(options.onUpdate === undefined
            ? {}
            : { onUpdate: options.onUpdate }),
          ...(options.hasDoc === undefined ? {} : { hasDoc: options.hasDoc }),
          ...(options.docPath === undefined
            ? {}
            : { docPath: options.docPath }),
          ...(options.resolveDoc === undefined
            ? {}
            : { resolveDoc: options.resolveDoc }),
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

    // The editable element carries the frozen DOM contract: the resolved
    // `.surface` class (CSS Modules hash), the editable-region attributes and
    // the placeholder. Rebuilding re-applies them to the new view.
    const editable = editor.view.dom;
    if (options.surfaceClassName !== undefined) {
      editable.classList.add(options.surfaceClassName);
    }
    editable.setAttribute('role', 'textbox');
    editable.setAttribute('aria-multiline', 'true');
    editable.setAttribute('aria-label', '文档正文');
    editable.setAttribute('spellcheck', 'false');
    if (options.placeholder !== undefined) {
      editable.setAttribute('data-placeholder', options.placeholder);
    }

    // Comment underlines are painted through the CSS Custom Highlight API, which
    // a plugin view cannot paint at construction time: do the first pass here.
    repaintComments(
      editor.view,
      options.comments ?? [],
      options.activeCommentId ?? null,
    );

    // The floating format bar lives outside the document body: it must survive
    // edits and be removed with the kernel, never serialized into the AST.
    const toolbar = createFormatToolbar({
      editor,
      onComment: (quote) => options.onComment?.(quote),
      ...(options.onTextType === undefined
        ? {}
        : { onTextType: options.onTextType }),
    });
    refreshToolbar = () => toolbar.update();

    // The block handle floats in the left gutter; dragging it must not leave
    // the format bar or the table/link bars hovering over the document.
    const blockHandle = createBlockHandle(editor, {
      onDragChange: (dragging) => {
        if (dragging) toolbar.hide();
      },
    });

    // Table / link overlays are body-level too: same lifetime as the kernel.
    const tableOverlay = createTableOverlay(editor);
    const linkOverlay = createLinkOverlay(editor, {
      onChange: () => options.onUpdate?.(),
      onEdit: (detail) => options.onLinkEdit?.(detail),
      ...(options.onOpenWeb === undefined
        ? {}
        : { onOpenWeb: options.onOpenWeb }),
      ...(options.onOpenDoc === undefined
        ? {}
        : { onOpenDoc: options.onOpenDoc }),
    });

    if (autofocusEnd) {
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

    const built: KernelRuntime = {
      editor,
      applyLinkEdit(input) {
        linkOverlay.applyEdit(input);
      },
      destroy() {
        dom.removeEventListener('compositionstart', handleCompositionStart);
        dom.removeEventListener('compositionend', handleCompositionEnd);
        // Body-level overlays must never outlive the editor they watch.
        toolbar.destroy();
        blockHandle.destroy();
        tableOverlay.destroy();
        linkOverlay.destroy();
        editor.destroy();
      },
    };
    lastRuntime = built;
    return built;
  }

  runtime = build(options.doc, options.autofocusEnd === true);

  return {
    get editor() {
      const current = runtime ?? lastRuntime;
      if (current === null) {
        throw new Error('editor kernel has not been built');
      }
      return current.editor;
    },
    load(doc: AlterDoc) {
      runtime?.destroy();
      runtime = build(doc, false);
    },
    capture() {
      return (
        runtime?.editor.state.doc ??
        lastRuntime?.editor.state.doc ??
        blocksToPmDoc(options.doc.blocks).value
      );
    },
    /** Write the page's link dialog result back into the body. */
    applyLinkEdit(input: {
      kind: 'card' | 'inline';
      pos: number;
      href: string;
      label: string;
    }) {
      runtime?.applyLinkEdit(input);
    },
    applyBlockType(type) {
      if (runtime !== null) applyBlockType(runtime.editor, type);
    },
    activeBlockType() {
      return runtime === null ? 'p' : activeBlockTypeOf(runtime.editor);
    },
    destroy() {
      runtime?.destroy();
      runtime = null;
    },
  };
}
