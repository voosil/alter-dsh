/**
 * Slash menu for the AST-native kernel.
 *
 * Behavior parity with the frozen editor (`docs/acceptance/editor-experience-p0-p6.md` §2):
 *
 * - `/` typed at the start of an **empty** line opens the menu; the menu is
 *   pinned to the command line's left edge (not the caret), 12px inside the
 *   viewport, and keeps the side it first appeared on while the query filters
 *   the list. Escape closes it; a fresh menu decides its side again.
 * - `ArrowDown`/`ArrowUp` cycle the highlight, `Enter` runs the highlighted
 *   command (the first one when the list is empty), `Escape` closes. Hovering a
 *   row moves the highlight and the active row is scrolled into view.
 * - The menu restores itself after an IME composition if the line still starts
 *   with `/`, reusing the side it had before the composition started.
 * - Rows are `button[role=option][aria-selected]` with the same lucide icon and
 *   label as the frozen menu; a query without matches shows the frozen
 *   「没有匹配的指令」 empty state.
 *
 * The menu is a plain DOM overlay (never part of the editable body) and every
 * command maps onto ProseMirror commands; nothing here parses or rewrites HTML.
 *
 * @module @alter-dsh/space/document/editors/tiptap/slash
 */
import { Extension, type Editor } from '@tiptap/core';
import {
  TextSelection,
  Plugin,
  PluginKey,
  type Transaction,
} from '@tiptap/pm/state';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { filterSlashCommands, type SlashCommand } from '../slash-commands';
import type { EditorKernelProps } from '../kernel';
import { KERNEL_CLASS } from './classes';
import { createIcon, type IconName } from './icons';

/**
 * Kernel diagnostics sink.
 *
 * A failed insert must stay visible in the host console instead of failing
 * silently, and these call sites have no page-facing notice channel (user-facing
 * toasts are raised separately), so the kernel keeps exactly one `console.error`
 * call here.
 */
// eslint-disable-next-line no-console
const reportKernelError = (...args: unknown[]): void => console.error(...args);

/** Plugin key so the menu state can be read back from the view. */
export const slashPluginKey = new PluginKey<SlashMenuState>('alterSpaceSlash');

/** Side of its command line a slash menu is anchored to. */
export type SlashMenuSide = 'above' | 'below';

/** Open-menu state. */
export interface SlashMenuState {
  /** Document position of the `/` character. */
  from: number;
  /** Document position just after the typed query. */
  to: number;
  /** Current filter query (text after the `/`). */
  query: string;
  /** Highlighted index in the filtered command list. */
  index: number;
}

/** Asset uploader the page provides for image/file insertion. */
export type SlashImportAsset = NonNullable<EditorKernelProps['importAsset']>;

/** Options the kernel passes to the slash extension. */
export interface SlashOptions {
  /**
   * Open the page-owned asset picker.
   *
   * When the page wires this callback it owns the picker; otherwise the kernel
   * opens its own hidden `<input type=file>` and uploads through
   * {@link SlashOptions.importAsset}.
   */
  onPickAsset?: (kind: 'image' | 'file') => void;
  /** Upload one picked file as an asset (returns its content reference). */
  importAsset?: SlashImportAsset;
  /** Report a degraded interaction instead of hiding it. */
  onNotice?: (message: string) => void;
}

/** Closed state (ProseMirror plugin state is not nullable in its types). */
const CLOSED = null as unknown as SlashMenuState;

/** Typed accessor for the plugin state. */
export function readSlashState(view: EditorView): SlashMenuState | null {
  return slashPluginKey.getState(view.state) ?? null;
}

/** Lucide icon each slash command draws, in the frozen menu's mapping. */
const COMMAND_ICON: Readonly<Record<string, IconName>> = {
  text: 'text',
  h1: 'heading1',
  h2: 'heading2',
  h3: 'heading3',
  bullet: 'list',
  ordered: 'listOrdered',
  todo: 'listTodo',
  quote: 'quote',
  code: 'code2',
  divider: 'minus',
  table: 'table2',
  'table-plain': 'table2',
  image: 'imagePlus',
  file: 'paperclip',
};

/** Geometry of the command line plus the viewport and measured menu box. */
export interface SlashMenuGeometry {
  lineTop: number;
  lineBottom: number;
  lineLeft: number;
  /** Measured menu width; `0` falls back to the frozen 290px CSS width. */
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Side the menu already appeared on; `null`/omitted means "decide now". */
  preferredSide?: SlashMenuSide | null;
  margin?: number;
  gap?: number;
}

/** Result of {@link placeSlashMenu}. */
export interface SlashMenuPlacement {
  top: number;
  left: number;
  side: SlashMenuSide;
}

/**
 * Place the menu against its command line, keeping the side it first appeared
 * on (frozen placement algorithm: line start, fixed side, viewport margins).
 *
 * Filtering changes the menu height, so a naive "below if it fits" rule makes
 * the menu jump across the line while typing. The direction is therefore
 * decided once, when the menu opens, and later measurements pass that side back
 * in; only the offset is recomputed.
 */
export function placeSlashMenu(geometry: SlashMenuGeometry): SlashMenuPlacement {
  const margin = geometry.margin ?? 12;
  const gap = geometry.gap ?? 4;
  const width = geometry.menuWidth || 290;
  const height = geometry.menuHeight;
  const left = Math.min(
    Math.max(margin, geometry.lineLeft),
    Math.max(margin, geometry.viewportWidth - width - margin),
  );
  const fitsBelow =
    geometry.lineBottom + gap + height <= geometry.viewportHeight - margin;
  const side: SlashMenuSide =
    geometry.preferredSide ?? (fitsBelow ? 'below' : 'above');
  const desired =
    side === 'below'
      ? geometry.lineBottom + gap
      : geometry.lineTop - gap - height;
  const top = Math.min(
    Math.max(margin, desired),
    Math.max(margin, geometry.viewportHeight - height - margin),
  );
  return { top, left, side };
}

/**
 * Refresh the open menu from the transaction.
 *
 * The frozen editor keeps the menu on the line it was opened on: an `input`
 * anywhere re-reads *that* line (`slash.line.textContent`), so moving the caret
 * elsewhere does not close it, while editing the line (or deleting the slash)
 * does. The ProseMirror port mirrors this by mapping the slash position through
 * the transaction and re-reading its textblock; the menu is only closed when
 * the line stops starting with `/` or disappears.
 *
 * The query spans the whole line (not just the text before the caret) and the
 * command deletes the whole line content, exactly like the frozen
 * `line.innerHTML = ''` execution path.
 */
function refreshSlashState(
  transaction: Transaction,
  previous: SlashMenuState,
): SlashMenuState | null {
  const position = transaction.mapping.map(previous.from, -1);
  if (position < 0 || position > transaction.doc.content.size) return null;
  const $pos = transaction.doc.resolve(position);
  if (!$pos.parent.isTextblock) return null;
  const text = $pos.parent.textContent;
  if (!text.startsWith('/')) return null;
  return {
    from: $pos.start(),
    to: $pos.end(),
    query: text.slice(1),
    index: 0,
  };
}

/**
 * Replace the command line with a divider followed by an empty paragraph
 * (the frozen `convertLineToDivider`).
 */
function replaceLineWithDivider(editor: Editor, from: number): void {
  const { state } = editor;
  const $from = state.doc.resolve(from);
  const depth = $from.depth;
  const dividerType = state.schema.nodes['divider'];
  const paragraphType = state.schema.nodes['paragraph'];
  if (!$from.parent.isTextblock || depth < 1 || !dividerType || !paragraphType) {
    return;
  }
  const start = $from.before(depth);
  const end = $from.after(depth);
  try {
    const divider = dividerType.create({ id: null });
    const paragraph = paragraphType.create();
    const tr = state.tr.replaceWith(start, end, [divider, paragraph]);
    const caret = start + divider.nodeSize + 1;
    tr.setSelection(TextSelection.create(tr.doc, Math.min(caret, tr.doc.content.size)));
    editor.view.dispatch(tr);
  } catch (error) {
    reportKernelError('[alter-space:slash-divider]', error);
  }
}

/**
 * Build the frozen 3-column table.
 *
 * `headerRows: 1` is the frozen table (one header row plus two body rows);
 * `headerRows: 0` is the 表格（无表头） variant (three rows of body cells).
 */
function buildFrozenTable(
  schema: Editor['schema'],
  headerRows = 1,
): PmNode | null {
  const tableType = schema.nodes['table'];
  const rowType = schema.nodes['tableRow'];
  const cellType = schema.nodes['tableCell'];
  const headerType = schema.nodes['tableHeader'] ?? cellType;
  if (!tableType || !rowType || !cellType || !headerType) return null;
  const cell = (type: NonNullable<typeof cellType>): PmNode =>
    type.createAndFill() ?? type.create();
  const row = (type: NonNullable<typeof cellType>): PmNode =>
    rowType.create(
      null,
      Array.from({ length: 3 }, () => cell(type)),
    );
  const rows: PmNode[] = [];
  for (let index = 0; index < 3; index += 1) {
    rows.push(row(index < headerRows ? headerType : cellType));
  }
  return tableType.create(null, rows);
}

/**
 * Replace the command line with a 3-column table followed by an empty
 * paragraph (`createTable`, the frozen editor's table command).
 *
 * Both table variants leave the caret in the empty paragraph after the table so
 * the user can keep writing there; the frozen editor used to park it in the
 * first header cell, which the plain variant does not have.
 */
function replaceLineWithTable(
  editor: Editor,
  from: number,
  headerRows = 1,
): void {
  const { state } = editor;
  const $from = state.doc.resolve(from);
  const depth = $from.depth;
  const paragraphType = state.schema.nodes['paragraph'];
  if (!$from.parent.isTextblock || depth < 1 || !paragraphType) return;
  const start = $from.before(depth);
  const end = $from.after(depth);
  try {
    const table = buildFrozenTable(state.schema, headerRows);
    if (table === null) {
      reportKernelError('[alter-space:slash-table] table nodes are not registered');
      return;
    }
    const paragraph = paragraphType.create();
    const tr = state.tr.replaceWith(start, end, [table, paragraph]);
    const caret = start + table.nodeSize + 1;
    try {
      tr.setSelection(
        TextSelection.create(tr.doc, Math.min(caret, tr.doc.content.size)),
      );
    } catch {
      // An unusual table shape keeps the mapped selection instead.
    }
    editor.view.dispatch(tr);
  } catch (error) {
    reportKernelError('[alter-space:slash-table]', error);
  }
}

/**
 * Replace the command line with a one-item task list.
 *
 * The kernel's task list is a manifest-derived node, so the stock
 * `toggleTaskList` command is not registered; the node is built directly and
 * the caret lands in the item's paragraph (the frozen editor's caret behavior).
 */
function replaceLineWithTaskList(editor: Editor, from: number): void {
  const { state } = editor;
  const $from = state.doc.resolve(from);
  const depth = $from.depth;
  const listType = state.schema.nodes['taskList'];
  const paragraphType = state.schema.nodes['paragraph'];
  if (!$from.parent.isTextblock || depth < 1 || !listType || !paragraphType) {
    return;
  }
  const start = $from.before(depth);
  const end = $from.after(depth);
  const paragraph = paragraphType.create();
  const candidateItems = ['taskItem', 'listItem']
    .map((name) => state.schema.nodes[name])
    .filter((type) => type !== undefined);
  for (const itemType of candidateItems) {
    try {
      const item = itemType.create(null, paragraph);
      const list = listType.create(null, item);
      const tr = state.tr.replaceWith(start, end, list);
      const caret = start + 3;
      tr.setSelection(TextSelection.create(tr.doc, Math.min(caret, tr.doc.content.size)));
      editor.view.dispatch(tr);
      return;
    } catch {
      // Try the next item shape; the schema is owned by the nodes module.
    }
  }
  reportKernelError('[alter-space:slash-todo] no task item node accepted the command');
}

/** Read one picked file as base64 (without the `data:` prefix). */
async function readFileAsBase64(file: File): Promise<string | null> {
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(',');
    return comma === -1 ? null : dataUrl.slice(comma + 1);
  } catch {
    return null;
  }
}

/**
 * Replace the (now empty) command line with an asset node and a paragraph to
 * keep typing in. Falls back to inserting after the line when the line sits in
 * a context that only accepts trailing block content.
 */
function insertAssetNode(
  editor: Editor,
  kind: 'image' | 'file',
  nodeTypeName: 'image' | 'file',
  attrs: Record<string, unknown>,
  insertAt: number,
): void {
  const { state } = editor;
  const nodeType = state.schema.nodes[nodeTypeName];
  const paragraphType = state.schema.nodes['paragraph'];
  if (!nodeType) {
    reportKernelError(`[alter-space:slash-${kind}] node type is not registered`);
    return;
  }
  try {
    const node = nodeType.create(attrs);
    const position = Math.min(Math.max(insertAt, 0), state.doc.content.size);
    const $pos = state.doc.resolve(position);
    const depth = $pos.depth;
    if (
      depth >= 1 &&
      $pos.parent.isTextblock &&
      $pos.parent.content.size === 0 &&
      paragraphType !== undefined
    ) {
      const start = $pos.before(depth);
      const end = $pos.after(depth);
      try {
        const tr = state.tr.replaceWith(start, end, [
          node,
          paragraphType.create(),
        ]);
        try {
          tr.setSelection(
            TextSelection.create(
              tr.doc,
              Math.min(start + node.nodeSize + 1, tr.doc.content.size),
            ),
          );
        } catch {
          // Keep the mapped selection when a paragraph cannot hold the caret.
        }
        editor.view.dispatch(tr);
        return;
      } catch {
        // Structures that must start with a paragraph take the card after the
        // line instead (e.g. a slash command inside a list item).
        editor.view.dispatch(state.tr.insert(end, node));
        return;
      }
    }
    // Inside a structure that needs its paragraph first: append the card after
    // the line instead of replacing it.
    if (depth >= 1) {
      const after = $pos.after(depth);
      editor.view.dispatch(state.tr.insert(after, node));
      return;
    }
    editor.view.dispatch(state.tr.insert(position, node));
  } catch (error) {
    reportKernelError(`[alter-space:slash-${kind}]`, error);
  }
}

/** Pick one file with the kernel's own hidden input. */
function pickFileWithInput(
  kind: 'image' | 'file',
  onFile: (file: File) => void,
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.setAttribute('data-slash-file-input', kind);
  input.style.display = 'none';
  if (kind === 'image') input.accept = 'image/*';
  const cleanup = (): void => input.remove();
  input.addEventListener(
    'change',
    () => {
      const file = input.files?.[0];
      cleanup();
      if (file) onFile(file);
    },
    { once: true },
  );
  input.addEventListener('cancel', cleanup, { once: true });
  document.body.append(input);
  input.click();
}

/**
 * User-facing message for a failed upload.
 *
 * The Host rejects with an actionable Chinese message (size limit, empty body,
 * unsupported image type, storage disabled) and the RPC client wraps it in an
 * `Error`; showing that beats the old generic "上传失败" line, which hid the
 * real cause.
 */
function uploadFailureNotice(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message.trim();
  }
  return fallback;
}

/** Run the image/file command: delete the query first, then insert the asset. */
function runAssetCommand(
  editor: Editor,
  kind: 'image' | 'file',
  state: SlashMenuState,
  options: SlashOptions,
): void {
  editor
    .chain()
    .focus()
    .deleteRange({ from: state.from, to: state.to })
    .run();
  const insertAt = editor.state.selection.from;
  if (options.onPickAsset !== undefined) {
    options.onPickAsset(kind);
    return;
  }
  if (options.importAsset === undefined) {
    options.onNotice?.('当前环境不支持上传附件');
    return;
  }
  pickFileWithInput(kind, (file) => {
    void (async () => {
      const dataBase64 = await readFileAsBase64(file);
      if (dataBase64 === null) {
        options.onNotice?.(`该文件类型不支持：${file.name}`);
        return;
      }
      try {
        const asset = await options.importAsset?.({
          kind,
          mime: file.type !== '' ? file.type : 'application/octet-stream',
          dataBase64,
          name: file.name,
        });
        if (asset === undefined) return;
        if (kind === 'image') {
          insertAssetNode(
            editor,
            kind,
            'image',
            { assetId: asset.assetId, alt: file.name },
            insertAt,
          );
        } else {
          insertAssetNode(
            editor,
            kind,
            'file',
            {
              assetId: asset.assetId,
              name: asset.name ?? file.name,
              mime: asset.mime !== '' ? asset.mime : file.type,
              bytes: asset.bytes,
            },
            insertAt,
          );
        }
      } catch (error) {
        reportKernelError('[alter-space:slash-asset]', error);
        options.onNotice?.(
          uploadFailureNotice(error, '附件上传失败，请重试'),
        );
      }
    })();
  });
}

/** Run one command against the current line; the menu is already closed. */
function applyCommand(
  editor: Editor,
  command: SlashCommand,
  state: SlashMenuState,
  options: SlashOptions,
): void {
  if (command.kind === 'image' || command.kind === 'file') {
    runAssetCommand(editor, command.kind, state, options);
    return;
  }
  if (command.kind === 'table') {
    replaceLineWithTable(editor, state.from, command.headerRows ?? 1);
    return;
  }
  if (command.node === 'divider') {
    replaceLineWithDivider(editor, state.from);
    return;
  }
  if (command.node === 'taskList') {
    replaceLineWithTaskList(editor, state.from);
    return;
  }
  const base = editor
    .chain()
    .focus()
    .deleteRange({ from: state.from, to: state.to });
  switch (command.node) {
    case 'paragraph':
      base.setParagraph().run();
      return;
    case 'heading':
      base.setHeading({ level: (command.level ?? 1) as 1 | 2 | 3 }).run();
      return;
    case 'bulletList':
      base.toggleBulletList().run();
      return;
    case 'orderedList':
      base.toggleOrderedList().run();
      return;
    case 'blockquote':
      base.toggleBlockquote().run();
      return;
    case 'codeBlock':
      base.toggleCodeBlock().run();
      return;
    default:
      base.run();
  }
}

/** Close the menu (state + DOM). */
function closeMenu(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(slashPluginKey, CLOSED));
}

/** Open the menu for one textblock. */
function openMenu(
  view: EditorView,
  state: Pick<SlashMenuState, 'from' | 'to' | 'query'>,
): void {
  view.dispatch(
    view.state.tr.setMeta(slashPluginKey, {
      from: state.from,
      to: state.to,
      query: state.query,
      index: 0,
    }),
  );
}

/** Start position of the textblock that contains `pos`. */
function textblockStart(view: EditorView, pos: number): number | null {
  const { doc } = view.state;
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  return $pos.parent.isTextblock ? $pos.start() : null;
}

/**
 * The slash-menu extension.
 *
 * The editor instance is resolved inside `addProseMirrorPlugins` (`this.editor`),
 * which runs while the editor is being constructed; `onCreate` fires only after
 * the plugin view already exists, so capturing it there would leave the first
 * menu unrenderable.
 */
export function createSlashExtension(options: SlashOptions = {}): Extension {
  return Extension.create({
    name: 'alterSpaceSlash',
    addProseMirrorPlugins() {
      const editorRef = this.editor;
      // IME bookkeeping: the frozen editor closes the menu while composing and
      // restores it on `compositionend` with the side it had before.
      let composing = false;
      let imeLineStart: number | null = null;
      let imeSide: SlashMenuSide | null | undefined;
      let imeRestoreTimer: number | null = null;
      // Side of the menu currently on screen (set by the plugin view below).
      let menuSide: SlashMenuSide | null = null;
      // Side a follow-up open should start on (IME restore).
      let preferredSide: SlashMenuSide | null = null;

      const restoreAfterIme = (view: EditorView): void => {
        imeRestoreTimer = null;
        const side = imeSide;
        const lineStart = imeLineStart;
        imeSide = undefined;
        imeLineStart = null;
        if (side === undefined || view.isDestroyed) return;
        if (readSlashState(view) !== null) return;
        const { selection } = view.state;
        if (!selection.empty) return;
        const $pos = selection.$from;
        if (!$pos.parent.isTextblock) return;
        if (lineStart !== null && $pos.start() !== lineStart) return;
        const text = $pos.parent.textBetween(
          0,
          $pos.parent.content.size,
          undefined,
          '\ufffc',
        );
        if (!text.startsWith('/')) return;
        preferredSide = side;
        openMenu(view, {
          from: $pos.start(),
          to: selection.from,
          query: text.slice(1),
        });
      };

      const cancelImeRestore = (): void => {
        if (imeRestoreTimer !== null) {
          window.clearTimeout(imeRestoreTimer);
          imeRestoreTimer = null;
        }
        imeSide = undefined;
        imeLineStart = null;
      };

      return [
        new Plugin<SlashMenuState>({
          key: slashPluginKey,
          state: {
            init: () => CLOSED,
            apply(transaction, previous) {
              const meta = transaction.getMeta(slashPluginKey) as
                | SlashMenuState
                | null
                | undefined;
              if (meta === null) return CLOSED;
              if (meta !== undefined) return meta;
              if (composing) return CLOSED;
              if (!transaction.docChanged) return previous;
              // A document change outside the menu's line closes it; a change
              // inside it refreshes the query and resets the highlight, like
              // the frozen `input` handler.
              if (previous === null) return CLOSED;
              const next = refreshSlashState(transaction, previous);
              return next === null ? CLOSED : next;
            },
          },
          props: {
            handleDOMEvents: {
              compositionstart(view) {
                composing = true;
                cancelImeRestore();
                const state = readSlashState(view);
                if (state !== null) {
                  imeLineStart = textblockStart(view, state.from);
                  imeSide = menuSide;
                  closeMenu(view);
                }
                return false;
              },
              compositionend(view) {
                composing = false;
                if (imeSide === undefined) return false;
                if (imeRestoreTimer !== null) window.clearTimeout(imeRestoreTimer);
                imeRestoreTimer = window.setTimeout(
                  () => restoreAfterIme(view),
                  0,
                );
                return false;
              },
            },
            handleKeyDown(view, event) {
              if (event.isComposing || event.keyCode === 229) return false;
              const state = readSlashState(view);
              if (state === null) {
                if (
                  event.key === '/' &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  view.state.selection.empty
                ) {
                  const { selection } = view.state;
                  const $from = selection.$from;
                  // The frozen editor only opens on an empty line.
                  if (!$from.parent.isTextblock || $from.parent.content.size > 0) {
                    return false;
                  }
                  event.preventDefault();
                  const tr = view.state.tr.insertText('/', selection.from);
                  tr.setMeta(slashPluginKey, {
                    from: selection.from,
                    to: selection.from + 1,
                    query: '',
                    index: 0,
                  });
                  view.dispatch(tr);
                  return true;
                }
                return false;
              }
              const commands = filterSlashCommands(state.query);
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (commands.length === 0) return true;
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const index =
                  (state.index + delta + commands.length) % commands.length;
                view.dispatch(
                  view.state.tr.setMeta(slashPluginKey, { ...state, index }),
                );
                return true;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                const command = commands[state.index] ?? commands[0];
                if (command === undefined) return true;
                closeMenu(view);
                applyCommand(editorRef, command, state, options);
                return true;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu(view);
                return true;
              }
              return false;
            },
          },
          view() {
            let menu: HTMLElement | null = null;
            let items: HTMLButtonElement[] = [];
            let renderedQuery: string | null = null;
            let renderedIndex = -1;

            const reset = (): void => {
              menu?.remove();
              menu = null;
              items = [];
              renderedQuery = null;
              renderedIndex = -1;
              menuSide = null;
            };

            const syncActive = (index: number, force: boolean): void => {
              if (!force && renderedIndex === index) return;
              items.forEach((item, itemIndex) => {
                const active = itemIndex === index;
                item.setAttribute('aria-selected', String(active));
                if (active) item.dataset['active'] = '';
                else delete item.dataset['active'];
              });
              const active = items[index];
              if (active !== undefined && typeof active.scrollIntoView === 'function') {
                active.scrollIntoView({ block: 'nearest' });
              }
              renderedIndex = index;
            };

            const fillMenu = (view: EditorView, state: SlashMenuState): void => {
              if (menu === null) return;
              menu.replaceChildren();
              items = [];
              const commands = filterSlashCommands(state.query);
              if (commands.length === 0) {
                const empty = document.createElement('p');
                empty.className = KERNEL_CLASS.slashEmpty;
                empty.textContent = '没有匹配的指令';
                menu.append(empty);
                renderedQuery = state.query;
                renderedIndex = -1;
                return;
              }
              commands.forEach((command, index) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', 'false');
                item.className = KERNEL_CLASS.slashItem;
                item.dataset['commandId'] = command.id;
                const icon = document.createElement('span');
                icon.className = KERNEL_CLASS.slashIcon;
                icon.setAttribute('aria-hidden', 'true');
                const iconName = COMMAND_ICON[command.id];
                if (iconName !== undefined) icon.append(createIcon(iconName));
                item.append(icon, command.label);
                item.addEventListener('mouseenter', () => {
                  const current = readSlashState(view);
                  if (current === null || current.index === index) return;
                  view.dispatch(
                    view.state.tr.setMeta(slashPluginKey, {
                      ...current,
                      index,
                    }),
                  );
                });
                item.addEventListener('click', () => {
                  const current = readSlashState(view);
                  if (current === null) return;
                  closeMenu(view);
                  applyCommand(editorRef, command, current, options);
                });
                menu?.append(item);
                items.push(item);
              });
              renderedQuery = state.query;
              renderedIndex = -1;
            };

            const position = (view: EditorView, state: SlashMenuState): void => {
              if (menu === null) return;
              try {
                const coords = view.coordsAtPos(state.from);
                const rect = menu.getBoundingClientRect();
                const placement = placeSlashMenu({
                  lineTop: coords.top,
                  lineBottom: coords.bottom,
                  lineLeft: coords.left,
                  menuWidth: rect.width,
                  menuHeight: rect.height,
                  viewportWidth: window.innerWidth,
                  viewportHeight: window.innerHeight,
                  preferredSide: menuSide,
                });
                menuSide = placement.side;
                menu.dataset['side'] = placement.side;
                menu.style.position = 'fixed';
                menu.style.top = `${placement.top}px`;
                menu.style.left = `${placement.left}px`;
              } catch (error) {
                reportKernelError('[alter-space:slash-menu]', error);
                reset();
              }
            };

            return {
              update(view) {
                const state = readSlashState(view);
                if (state === null) {
                  reset();
                  return;
                }
                if (menu === null) {
                  menu = document.createElement('div');
                  menu.className = KERNEL_CLASS.slashMenu;
                  menu.setAttribute('role', 'listbox');
                  menu.setAttribute('aria-label', '插入内容');
                  menu.addEventListener('mousedown', (event) =>
                    event.preventDefault(),
                  );
                  document.body.append(menu);
                  // A fresh menu takes the side an IME restore asked for.
                  menuSide = preferredSide;
                  preferredSide = null;
                  renderedQuery = null;
                }
                if (renderedQuery !== state.query) fillMenu(view, state);
                syncActive(state.index, renderedIndex !== state.index);
                position(view, state);
              },
              destroy() {
                if (imeRestoreTimer !== null) window.clearTimeout(imeRestoreTimer);
                reset();
              },
            };
          },
        }),
      ];
    },
  });
}