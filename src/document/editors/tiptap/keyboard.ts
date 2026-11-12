/**
 * Keyboard, IME and block-conversion parity with the frozen editor.
 *
 * The frozen editor implements its keyboard semantics by hand in one
 * the frozen editor's `handleKeyDown`
 * plus a composition lifecycle (`E:969-1064`, `E:2024-2041`). The pieces that
 * must survive the kernel swap are:
 *
 * - **IME**: every custom binding is off while composing, floating UI is
 *   dismissed on composition start, half-composed text never reaches the save
 *   layer, and the committed marker text is converted once on composition end
 *   (with a single change notification);
 * - **line conversions**: the confirming Space/Enter is swallowed for a whole
 *   marker line even when nothing converts; `---` also converts on Enter; three
 *   backticks become a code block;
 * - **line boundaries**: empty list item deletion (splitting a list, keeping
 *   ordered numbering), quote line-start Backspace (marker only), the single
 *   empty paragraph staying put on Backspace, table Tab/Shift+Tab (no wrap, no
 *   row creation), and Enter inside a code block inserting a literal newline.
 *
 * Block selection (divider/image/table) is a separate state machine owned by
 * `overlays.ts`; this module only dispatches its key handler at the frozen
 * editor's position in the key sequence. Todo keys are owned by the task node
 * extensions.
 *
 * @module @alter-dsh/space/document/editors/tiptap/keyboard
 */
import { Extension, type AnyExtension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { toggleMark } from '@tiptap/pm/commands';
import { KERNEL_CLASS } from './classes';
import { slashPluginKey } from './slash';
import {
  detectLineMarker,
  dividerTransaction,
  endPositionOf,
  isMarkerLineHost,
  markerTransaction,
} from './input-rules';

/** Plugin key of the keyboard/IME plugin. */
export const keyboardPluginKey = new PluginKey<KeyboardPluginState>(
  'alterSpaceKeyboard',
);

/** State the keyboard plugin exposes to the rest of the kernel. */
export interface KeyboardPluginState {
  /** Whether an IME composition currently owns the keyboard. */
  composing: boolean;
}

/** Options of {@link createKeyboardExtension}. */
export interface KeyboardExtensionOptions {
  /**
   * Report exactly one body change after an IME composition ends.
   *
   * Tiptap's `onUpdate` fires per transaction, so the composition path needs
   * this explicit hook for the "composition ended with no conversion" case (the
   * frozen editor calls `notifyChange()` once there too).
   */
  onChange?: () => void;
  /**
   * Block-selection key dispatcher (`overlays.ts`).
   *
   * Called at the frozen editor's position in `handleKeyDown`: after the IME
   * guard and before the line-boundary branches. It owns selection state and
   * returns true when it consumed the key.
   */
  handleBlockSelectionKey?: (view: EditorView, event: KeyboardEvent) => boolean;
  /** Drop any block selection (IME composition start). */
  clearBlockSelection?: (view: EditorView) => void;
  /** Close the link/table bars and their timers (IME composition start). */
  closeOverlayBars?: (view: EditorView) => void;
}

/** Whether an IME composition owns the editor at `view`. */
export function isComposingView(view: EditorView): boolean {
  return keyboardPluginKey.getState(view.state)?.composing ?? false;
}

/** Writable view of the optional modifier fields of a KeyboardEvent. */
type KeyboardEventLike = KeyboardEvent & { keyCode?: number };

/** Frozen `handleKeyDown` guard: composition swallows every binding. */
function compositionOwnsKeyboard(
  view: EditorView,
  event: KeyboardEvent,
): boolean {
  const native = event as KeyboardEventLike;
  return (
    view.composing ||
    native.isComposing === true ||
    native.keyCode === 229 ||
    isComposingView(view)
  );
}

/** Whether the event carries a platform shortcut modifier. */
function hasShortcutModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
}

/** The collapsed caret's enclosing textblock, or `null`. */
function caretTextblock(
  state: EditorState,
): { $from: ReturnType<typeof state.doc.resolve>; parent: PmNode } | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection)) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  return { $from, parent: $from.parent };
}

/** Whole line text of the textblock containing the caret (frozen `line.textContent`). */
function lineTextOf(parent: PmNode): string {
  return parent.textBetween(0, parent.content.size);
}

/**
 * Build the transaction deleting one empty list item.
 *
 * Frozen behavior (`E:1907-1942`): the current line degrades to an empty
 * paragraph, the list splits around it, and an ordered tail keeps its displayed
 * numbers (`start = base + removedIndex + 1`). The caret lands at the new
 * paragraph's start.
 */
function emptyListItemTransaction(state: EditorState): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock || $from.parent.content.size > 0) return null;

  let itemDepth = -1;
  for (let depth = $from.depth; depth > 1; depth -= 1) {
    if ($from.node(depth).type.name === 'listItem') {
      itemDepth = depth;
      break;
    }
  }
  if (itemDepth <= 1) return null;
  const item = $from.node(itemDepth);
  const list = $from.node(itemDepth - 1);
  const listName = list.type.name;
  if (listName !== 'bulletList' && listName !== 'orderedList') return null;
  // Only a list item whose entire content is one empty paragraph: nested
  // content is not what the frozen single-line item model covers.
  if (item.childCount !== 1) return null;

  const index = $from.index(itemDepth - 1);
  const paragraph = state.schema.nodes['paragraph'];
  if (paragraph === undefined) return null;
  const emptyParagraph = paragraph.create({ id: null }, null, []);

  const before: PmNode[] = [];
  const after: PmNode[] = [];
  for (let child = 0; child < list.childCount; child += 1) {
    if (child === index) continue;
    const node = list.child(child);
    if (child < index) before.push(node);
    else after.push(node);
  }

  const listStart = $from.before(itemDepth - 1);
  const parts: PmNode[] = [];
  if (before.length > 0) {
    parts.push(
      list.type.create(
        { ...list.attrs, id: listTypeId(list) },
        before,
      ),
    );
  }
  parts.push(emptyParagraph);
  if (after.length > 0) {
    const baseStart =
      typeof list.attrs['start'] === 'number' ? list.attrs['start'] : 1;
    const tailAttrs: Record<string, unknown> = { ...list.attrs, id: null };
    if (listName === 'orderedList') {
      const start = baseStart + index + 1;
      if (start !== 1) tailAttrs['start'] = start;
    }
    parts.push(list.type.create(tailAttrs, after));
  }

  const tr = state.tr.replaceWith(
    listStart,
    listStart + list.nodeSize,
    parts,
  );
  // Find the paragraph we just inserted: it directly follows the prefix list.
  let paragraphPos = listStart;
  if (before.length > 0) {
    paragraphPos += parts[0]!.nodeSize;
  }
  tr.setSelection(TextSelection.create(tr.doc, paragraphPos + 1));
  return tr;
}

/** Keep the original list's block id on the prefix half (tail gets a new one). */
function listTypeId(list: PmNode): unknown {
  return list.attrs['id'] ?? null;
}

/** List blocks the backward jump treats as "the previous line". */
const PREVIOUS_LINE_LIST_TYPES: ReadonlySet<string> = new Set([
  'bulletList',
  'orderedList',
  'taskList',
]);

/**
 * Build the merge from an empty paragraph whose previous sibling is a list.
 *
 * Product requirement (2026-11-12): after an empty list/todo row has been
 * degraded to a paragraph, a second Backspace must drop that line and land at
 * the end of the previous line instead of letting ProseMirror merge the
 * paragraph back into the list (which re-creates a numbered row). When the
 * degrade had split one list around the paragraph, the two halves are joined
 * again so the blank line leaves no gap and the numbering stays continuous.
 */
function previousListJumpTransaction(state: EditorState): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $from = selection.$from;
  // The rule is about top-level line boxes only: a paragraph nested in a quote,
  // list item or cell keeps the default merge semantics.
  if ($from.depth !== 1) return null;
  if ($from.parent.type.name !== 'paragraph') return null;
  if ($from.parent.content.size > 0 || $from.parentOffset !== 0) return null;
  const index = $from.index(0);
  if (index <= 0) return null;
  const previous = state.doc.child(index - 1);
  if (!PREVIOUS_LINE_LIST_TYPES.has(previous.type.name)) return null;

  const paragraphStart = $from.before(1);
  const paragraphEnd = paragraphStart + $from.parent.nodeSize;
  const previousPos = paragraphStart - previous.nodeSize;
  // The last editable line of the list, i.e. its deepest last textblock.
  const end = endPositionOf(previous, previousPos);
  const tr = state.tr.delete(paragraphStart, paragraphEnd);
  // Rejoin the two halves the degrade split apart (same list type only; the
  // prefix keeps its id and, for ordered lists, its numbering).
  const nextIndex = index + 1;
  const next = nextIndex < state.doc.childCount ? state.doc.child(nextIndex) : null;
  if (next !== null && next.type === previous.type) {
    tr.join(paragraphStart);
  }
  return tr.setSelection(TextSelection.create(tr.doc, end));
}

/**
 * Build the transaction that drops a quote marker at the start of a quote line.
 *
 * Frozen behavior (`E:1660-1686`): the quote becomes a paragraph in place, with
 * its content and the caret kept. Nested quotes are left to the default merge,
 * and a leading inline atom (image/file) is never swallowed.
 */
function quoteMarkerTransaction(state: EditorState): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $from = selection.$from;
  if ($from.depth !== 2) return null;
  const quote = $from.node(1);
  if (quote.type.name !== 'blockquote') return null;
  const line = $from.parent;
  if (line.type.name !== 'paragraph') return null;
  // The caret must be before every inline child, and the quote must hold only
  // this line (a nested quote cannot be flattened into one paragraph).
  if ($from.parentOffset !== 0 || $from.index(1) !== 0) return null;
  if (quote.childCount !== 1) return null;
  const paragraph = state.schema.nodes['paragraph'];
  if (paragraph === undefined) return null;
  const start = $from.before(1);
  const tr = state.tr.replaceWith(
    start,
    start + quote.nodeSize,
    paragraph.create({ id: null }, line.content),
  );
  tr.setSelection(TextSelection.create(tr.doc, start + 1));
  return tr;
}

/** True when the document is exactly one empty paragraph (frozen 第 11 项). */
function isEmptyDocumentLine(state: EditorState): boolean {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const doc = state.doc;
  if (doc.childCount !== 1) return false;
  const only = doc.firstChild;
  if (only === null || only.type.name !== 'paragraph') return false;
  return only.content.size === 0;
}

/** One cell of the enclosing table, with its absolute start position. */
interface TableCellRef {
  start: number;
  node: PmNode;
}

/** Collect the cells of one table in document order. */
function tableCells(table: PmNode, tableStart: number): TableCellRef[] {
  const cells: TableCellRef[] = [];
  let rowStart = tableStart + 1;
  table.forEach((row) => {
    let cellStart = rowStart + 1;
    row.forEach((cell) => {
      cells.push({ start: cellStart, node: cell });
      cellStart += cell.nodeSize;
    });
    rowStart += row.nodeSize;
  });
  return cells;
}

/**
 * Tab / Shift+Tab inside a table: jump to the next/previous cell's end.
 *
 * Frozen behavior (`E:1757-1773`): no wrap at the edges, no row creation; when
 * there is no target the key is not intercepted at all.
 */
function tableTabTransaction(
  state: EditorState,
  backward: boolean,
): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $from = selection.$from;
  let cellDepth = -1;
  let tableDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (cellDepth < 0 && (name === 'tableCell' || name === 'tableHeader')) {
      cellDepth = depth;
    }
    if (name === 'table') {
      tableDepth = depth;
      break;
    }
  }
  if (cellDepth < 0 || tableDepth < 0) return null;
  const table = $from.node(tableDepth);
  const tableStart = $from.before(tableDepth);
  const cells = tableCells(table, tableStart);
  const currentStart = $from.before(cellDepth);
  const index = cells.findIndex((cell) => cell.start === currentStart);
  if (index < 0) return null;
  const target = cells[index + (backward ? -1 : 1)];
  if (target === undefined) return null;
  const tr = state.tr.setSelection(
    TextSelection.create(state.doc, endPositionOf(target.node, target.start)),
  );
  return tr;
}

/** Build the empty code block a typed ``` converts the current line into. */
function codeFenceTransaction(state: EditorState): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $from = selection.$from;
  if ($from.depth !== 1) return null;
  if ($from.parent.type.name !== 'paragraph' && $from.parent.type.name !== 'heading') {
    return null;
  }
  const codeBlock = state.schema.nodes['codeBlock'];
  if (codeBlock === undefined) return null;
  const start = $from.before(1);
  const current = $from.node(1);
  const block = codeBlock.create({ id: null, lang: null }, null, []);
  const tr = state.tr.replaceWith(start, start + current.nodeSize, block);
  tr.setSelection(TextSelection.create(tr.doc, start + 1));
  return tr;
}

/** Behavior of one keyboard event after parsing: consumed, or ignored. */
function handleKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  options: KeyboardExtensionOptions,
): boolean {
  if (compositionOwnsKeyboard(view, event)) return false;
  const state = view.state;
  const selection = state.selection;

  // 1. Block selection (divider/image/table) state machine, at the frozen
  //    editor's position: before the line-boundary branches.
  if (options.handleBlockSelectionKey?.(view, event) === true) return true;

  const noModifiers = !hasShortcutModifier(event);
  const line = caretTextblock(state);

  // 2. Empty list item deletion: Backspace/Delete degrade the line to a
  //    paragraph and split the list around it (frozen D3).
  if (
    noModifiers &&
    (event.key === 'Backspace' || event.key === 'Delete')
  ) {
    const emptyList = emptyListItemTransaction(state);
    if (emptyList !== null) {
      view.dispatch(emptyList);
      return true;
    }
    // 3. Backspace in the empty paragraph an emptied list/todo row left behind
    //    jumps to the previous line's end instead of merging back into the
    //    list (which would recreate a numbered row).
    if (event.key === 'Backspace') {
      const previousLine = previousListJumpTransaction(state);
      if (previousLine !== null) {
        view.dispatch(previousLine);
        return true;
      }
    }
    // 4. Backspace at the start of a quote line drops only the quote marker.
    if (event.key === 'Backspace') {
      const unquote = quoteMarkerTransaction(state);
      if (unquote !== null) {
        view.dispatch(unquote);
        return true;
      }
    }
    // 5. The single empty paragraph must survive Backspace (frozen 第 11 项).
    if (event.key === 'Backspace' && isEmptyDocumentLine(state)) {
      return true;
    }
  }

  // 5. Mod/Ctrl+U underlines by hand (the browser has no native command).
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === 'u'
  ) {
    if (!selection.empty) {
      const underline = state.schema.marks['underline'];
      if (underline !== undefined) {
        // Generic mark toggle: works for the manifest mark without the stock
        // Tiptap underline extension.
        toggleMark(underline)(state, view.dispatch);
      }
    }
    return true;
  }

  // 6. Tab inside a table jumps cells without wrapping or creating rows.
  if (event.key === 'Tab' && noModifiersForTab(event)) {
    const tableTab = tableTabTransaction(state, event.shiftKey);
    if (tableTab !== null) {
      view.dispatch(tableTab);
      return true;
    }
    return false;
  }

  // 7. Whole-line markers, converted on the confirming Space/Enter.
  if (line !== null && (event.key === ' ' || event.key === 'Enter')) {
    const text = lineTextOf(line.parent);
    const trimmed = text.trimEnd();
    const marker = detectLineMarker(trimmed);
    if (event.key === ' ' && marker !== null) {
      // Only convertible line hosts swallow the confirming space (a `#` typed
      // in a table cell or list item keeps ordinary Space behavior). On a host
      // the space is swallowed even when the caret is not at the line end.
      if (!isMarkerLineHost(state)) return false;
      if (selection.empty && selection.from === line.$from.end()) {
        const tr = markerTransaction(state, marker);
        if (tr !== null) view.dispatch(tr);
      }
      return true;
    }
    // `` ``` `` + Space/Enter turns a line into an empty code block.
    if (trimmed === '```' && (event.key === ' ' || event.key === 'Enter')) {
      const tr = codeFenceTransaction(state);
      if (tr !== null) {
        view.dispatch(tr);
        return true;
      }
    }
    // `---` + Enter converts regardless of the caret position (frozen branch);
    // a table cell has no frozen line host, so Enter falls through there.
    if (trimmed === '---' && event.key === 'Enter') {
      const tr = dividerTransaction(state, {
        requireCaretAtEnd: false,
        allowNested: true,
      });
      if (tr !== null) {
        view.dispatch(tr);
        return true;
      }
    }
  }

  // 8. Enter inside a code block inserts a literal newline and never exits.
  if (line !== null && line.parent.type.name === 'codeBlock') {
    if (event.key === 'Enter') {
      if (line.parent.content.size === 0) return true;
      const tr = state.tr.insertText(
        '\n',
        selection.from,
        selection.to,
      );
      view.dispatch(tr);
      return true;
    }
  }

  return false;
}

/** Tab only uses Shift as a direction modifier (Alt/Meta/Ctrl fall through). */
function noModifiersForTab(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** Hide the body-level floating UI the kernel owns, by frozen class name. */
function hideDomOverlays(): void {
  if (typeof document === 'undefined') return;
  const classes = [
    KERNEL_CLASS.floating,
    KERNEL_CLASS.wordCount,
    KERNEL_CLASS.linkBar,
  ];
  for (const className of classes) {
    for (const element of Array.from(
      document.getElementsByClassName(className),
    )) {
      if (element instanceof HTMLElement) element.style.display = 'none';
    }
  }
  for (const element of Array.from(
    document.getElementsByClassName(KERNEL_CLASS.slashMenu),
  )) {
    element.remove();
  }
}

/** Close every floating surface, mirroring the frozen `clearFloatingUi()`. */
function clearFloatingUi(view: EditorView, options: KeyboardExtensionOptions): void {
  options.clearBlockSelection?.(view);
  options.closeOverlayBars?.(view);
  hideDomOverlays();
  try {
    view.dispatch(view.state.tr.setMeta(slashPluginKey, null));
  } catch {
    // A destroyed view cannot close the menu; there is nothing left to close.
  }
}

/**
 * Convert committed IME text the way the frozen composition-end path does.
 *
 * `allowBareMarker` accepts `>`/`》` without the trailing space and `N. `
 * where the space was committed by the IME. Only the current top-level line is
 * converted (the frozen `convertMarkerShortcut` ignores quote lines too).
 */
function compositionEndTransaction(state: EditorState): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $from = selection.$from;
  if ($from.depth !== 1 || !$from.parent.isTextblock) return null;
  if (selection.from !== $from.end()) return null;
  const text = lineTextOf($from.parent);
  const ordered = /^(\d{1,7})\.\s$/.exec(text);
  if (ordered !== null) {
    const start = Number.parseInt(ordered[1]!, 10);
    return markerTransaction(
      state,
      start > 1 ? { kind: 'ordered', start } : { kind: 'ordered' },
    );
  }
  if (/^(?:>|》)\s?$/.test(text)) {
    return markerTransaction(state, { kind: 'quote' });
  }
  return dividerTransaction(state, { requireCaretAtEnd: true });
}

/**
 * The keyboard + IME extension.
 *
 * The extension registers one ProseMirror plugin (keydown dispatch + composed
 * state) and one `dispatchTransaction` wrapper: while an IME composition is
 * open, document transactions are marked `preventUpdate` so Tiptap's `onUpdate`
 * (which the page turns into a debounced save) cannot commit half-composed
 * text. The final save is reported exactly once by the composition-end path.
 */
export function createKeyboardExtension(
  options: KeyboardExtensionOptions = {},
): AnyExtension {
  let composing = false;
  let compositionEndScheduled = false;
  /** Guards a deferred composition-end conversion against a new composition. */
  let compositionGeneration = 0;

  /** Mirror the composition flag into plugin state for other modules. */
  function setComposing(view: EditorView, value: boolean): void {
    composing = value;
    if (view.isDestroyed) return;
    view.dispatch(
      view.state.tr.setMeta(keyboardPluginKey, { composing: value }),
    );
  }

  function finishComposition(view: EditorView, generation: number): void {
    compositionEndScheduled = false;
    if (view.isDestroyed || !composing) return;
    // A new composition may have started while this one's final flush was
    // pending; never convert the new composition's text.
    if (generation !== compositionGeneration) return;
    composing = false;
    if (!view.isDestroyed) {
      view.dispatch(
        view.state.tr.setMeta(keyboardPluginKey, { composing: false }),
      );
    }
    const tr = compositionEndTransaction(view.state);
    if (tr !== null) {
      view.dispatch(tr);
    } else {
      options.onChange?.();
    }
  }

  return Extension.create({
    name: 'alterSpaceKeyboard',
    // Register before StarterKit's keymap so Backspace/Enter/Tab reach the
    // frozen semantics before ProseMirror's baseKeymap joins blocks.
    priority: 1000,
    /**
     * Suppress `onUpdate` for transactions produced while composing.
     *
     * Returning early is not possible here: the wrapper is invoked at dispatch
     * time at the outermost layer (this extension has the highest priority),
     * and Tiptap skips its update event for `preventUpdate` transactions.
     */
    dispatchTransaction({ transaction, next }) {
      if (
        composing &&
        options.onChange !== undefined &&
        transaction.docChanged
      ) {
        transaction.setMeta('preventUpdate', true);
      }
      next(transaction);
    },
    addProseMirrorPlugins() {
      return [
        new Plugin<KeyboardPluginState>({
          key: keyboardPluginKey,
          state: {
            init: () => ({ composing: false }),
            apply(transaction, previous) {
              const meta = transaction.getMeta(keyboardPluginKey) as
                | KeyboardPluginState
                | null
                | undefined;
              if (meta !== null && meta !== undefined) return meta;
              return previous;
            },
          },
          props: {
            handleKeyDown(view, event) {
              return handleKeyDown(view, event, options);
            },
          },
          view(editorView) {
            const view = editorView;
            const onCompositionStart = (): void => {
              if (view.isDestroyed) return;
              compositionGeneration += 1;
              compositionEndScheduled = false;
              if (composing) return;
              clearFloatingUi(view, options);
              setComposing(view, true);
            };
            const onCompositionEnd = (): void => {
              if (view.isDestroyed) return;
              if (!composing || compositionEndScheduled) return;
              compositionEndScheduled = true;
              const generation = compositionGeneration;
              // The ProseMirror composition handler that runs before this one
              // flushes the committed text in a microtask; convert after it.
              Promise.resolve().then(() => {
                if (view.isDestroyed) return;
                finishComposition(view, generation);
              });
            };
            view.dom.addEventListener('compositionstart', onCompositionStart);
            view.dom.addEventListener('compositionend', onCompositionEnd);
            return {
              destroy() {
                view.dom.removeEventListener(
                  'compositionstart',
                  onCompositionStart,
                );
                view.dom.removeEventListener(
                  'compositionend',
                  onCompositionEnd,
                );
              },
            };
          },
        }),
      ];
    },
  });
}