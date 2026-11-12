/**
 * Block selection state machine for the non-editable blocks the frozen editor
 * lets the user pick up with a delete key: dividers, images and whole tables.
 *
 * Frozen behaviour (`docs/acceptance/editor-experience-p0-p6.md` §2):
 *
 * - a **caret** at the start (Backspace) or end (Delete) of a line whose
 *   neighbouring sibling is a divider or a whole-line image selects that block
 *   on the first press and deletes it on the second; the first press never
 *   changes the document (so it never saves);
 * - a **selected block** ignores those adjacency checks: Backspace/Delete
 *   removes it, Escape cancels, any other key cancels first and then continues
 *   as a normal key;
 * - clicking an image or a divider selects it, clicking anywhere else clears
 *   the selection, and losing focus clears it too;
 * - `data-selected` is editing-surface state only: it lives on the DOM node
 *   (that is what the frozen CSS targets) and never reaches the AST.
 *
 * The keyboard entry point is `handleKeyDown`, exported for the keyboard
 * extension so the frozen priority order (IME guard → adjacency → block delete
 * → other custom branches) is decided in one place instead of being split over
 * several keymap entries.
 *
 * @module @alter-dsh/space/document/editors/tiptap/block-selection
 */
import type { Editor } from '@tiptap/core';
import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** Anything that can resolve to the ProseMirror view of one kernel editor. */
export type EditorTarget = Editor | EditorView;

/** Which non-editable block kind is selected. */
export type BlockKind = 'divider' | 'image' | 'table' | 'other';

/** One selected block, resolved against the current document state. */
export interface SelectedBlock {
  /** The DOM node carrying `data-selected` (the block the CSS targets). */
  readonly element: HTMLElement;
  /** Current top-level position of the block's node. */
  readonly pos: number;
  /** The block's node. */
  readonly node: PmNode;
  readonly kind: BlockKind;
}

/** Options of {@link BlockSelection.select}. */
export interface SelectBlockOptions {
  /**
   * Park the caret next to the block (the frozen table bar behaviour: the
   * caret leaves the table so the next delete key removes the whole table).
   */
  moveCaret?: boolean;
}

/** The block-selection controller for one mounted editor view. */
export interface BlockSelection {
  /** The selected block, or `null`; a stale selection clears itself. */
  selected(): SelectedBlock | null;
  /** Select one block. Re-selecting the current block is a no-op. */
  select(element: HTMLElement, options?: SelectBlockOptions): void;
  /** Drop the selection mark without touching content. */
  clear(): void;
  /** Re-apply the mark after the document moved under the selection. */
  refresh(): void;
  /** Delete the selected block and park the caret on a typable neighbour. */
  removeSelected(): boolean;
  /** Swap the selected block with an adjacent sibling in `delta` direction. */
  moveSelected(delta: -1 | 1): boolean;
  /**
   * Handle one keydown event.
   *
   * @returns `true` when the event was consumed (the handler already called
   * `preventDefault`; the caller must swallow the key). `false` means the key
   * must continue through the normal keymap.
   */
  handleKeyDown(event: KeyboardEvent): boolean;
  /** Subscribe to selection changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Detach listeners and drop the mark. */
  destroy(): void;
}

/** Attribute the frozen stylesheet keys the selected state off. */
const SELECTED_ATTRIBUTE = 'data-selected';

/** DOM tag one selectable node type renders as. */
const TAG_OF_NODE: Readonly<Record<string, string>> = {
  divider: 'DIV',
  image: 'IMG',
  table: 'TABLE',
};

/** Controllers per editor view (one state machine per mounted editor). */
const selections = new WeakMap<EditorView, BlockSelection>();

/** Resolve an editor-like target into its ProseMirror view. */
export function resolveEditorView(target: EditorTarget): EditorView {
  return 'view' in target ? target.view : target;
}

/**
 * The block-selection controller of one editor (created on first use).
 *
 * It is memoized per view so the overlays, the keyboard dispatch and the
 * click handling all observe the same selection state.
 */
export function blockSelectionOf(target: EditorTarget): BlockSelection {
  const view = resolveEditorView(target);
  const existing = selections.get(view);
  if (existing !== undefined) return existing;
  const created = buildBlockSelection(view);
  selections.set(view, created);
  return created;
}

/** Former name kept for the parity checklist: same memoized controller. */
export function createBlockSelection(target: EditorTarget): BlockSelection {
  return blockSelectionOf(target);
}

/**
 * Handle one keydown for the block-selection state machine.
 *
 * The keyboard extension calls this before its own branches so the frozen
 * priority is preserved (see the module docblock).
 */
export function handleBlockSelectionKey(
  target: EditorTarget,
  event: KeyboardEvent,
): boolean {
  return blockSelectionOf(target).handleKeyDown(event);
}

/** True for modifiers the frozen editor treats as "not a plain delete key". */
function hasModifier(event: KeyboardEvent): boolean {
  return event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;
}

/** The kind of one ProseMirror node (only the selectable ones are named). */
function kindOfNode(node: PmNode): BlockKind {
  switch (node.type.name) {
    case 'divider':
      return 'divider';
    case 'image':
      return 'image';
    case 'table':
      return 'table';
    default:
      return 'other';
  }
}

/** True when the frozen editor would treat the image as a whole-line image. */
function holdsOnlyOneImage(block: PmNode): boolean {
  let images = 0;
  let other = false;
  block.forEach((child) => {
    if (child.type.name === 'image') {
      images += 1;
      return;
    }
    if (child.isText) {
      if ((child.text ?? '').replaceAll('\u00a0', '').trim() !== '') other = true;
      return;
    }
    if (child.type.name === 'hardBreak') return;
    other = true;
  });
  return images === 1 && !other;
}

/**
 * Document position of the selectable node rendered by one DOM element.
 *
 * `posAtDOM` resolves to a position *inside* non-leaf nodes (a table) and *just
 * before* leaf atoms (an image or divider), so the candidate node is compared
 * by type before falling back to the enclosing top-level node.
 */
function positionOfElement(view: EditorView, element: HTMLElement): number | null {
  const doc = view.state.doc;
  let raw: number;
  try {
    raw = view.posAtDOM(element, 0);
  } catch {
    return null;
  }
  if (raw < 0) return null;
  const direct = doc.nodeAt(raw);
  const expected = direct === null ? null : TAG_OF_NODE[direct.type.name];
  if (direct !== null && expected !== null && expected !== undefined) {
    if (
      element.tagName === expected ||
      element.querySelector(expected.toLowerCase()) !== null
    ) {
      return raw;
    }
  }
  const $raw = doc.resolve(raw);
  if ($raw.depth >= 1) return $raw.before(1);
  return direct === null ? null : raw;
}

/** The DOM node the frozen stylesheet marks as selected for one block. */
function selectableElementOf(
  view: EditorView,
  pos: number,
  node: PmNode,
): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  switch (node.type.name) {
    case 'divider':
      return dom.hasAttribute('data-divider')
        ? dom
        : (dom.querySelector<HTMLElement>('[data-divider]') ?? dom);
    case 'image':
      return dom.tagName === 'IMG'
        ? dom
        : dom.querySelector<HTMLElement>('img');
    case 'table':
      // Tiptap's table view may wrap the table; the frozen CSS targets `table`.
      return dom.tagName === 'TABLE'
        ? dom
        : dom.querySelector<HTMLElement>('table');
    default:
      return null;
  }
}

/** End position of the last typable block that ends at or before `limit`. */
function lastTypableEnd(doc: PmNode, limit: number): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (pos + node.nodeSize <= limit) found = pos + node.nodeSize - 1;
      return false;
    }
    return pos < limit;
  });
  return found;
}

/** Start position of the first typable block that starts at or after `limit`. */
function firstTypableStart(doc: PmNode, limit: number): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock) {
      if (pos >= limit) found = pos + 1;
      return false;
    }
    return pos + node.nodeSize > limit;
  });
  return found;
}

/**
 * Park the caret right outside one block: previous typable end, else next
 * typable start, else (deletions only) a fresh empty paragraph at the end.
 *
 * @returns whether a caret was placed.
 */
function placeCaretAround(
  tr: Transaction,
  pos: number,
  size: number,
  allowAppend: boolean,
): boolean {
  const doc = tr.doc;
  const before = lastTypableEnd(doc, pos);
  if (before !== null) {
    tr.setSelection(TextSelection.create(doc, before));
    return true;
  }
  const after = firstTypableStart(doc, pos + size);
  if (after !== null) {
    tr.setSelection(TextSelection.create(doc, after));
    return true;
  }
  if (!allowAppend) return false;
  const paragraph = doc.type.schema.nodes['paragraph'];
  if (paragraph === undefined) return false;
  const at = doc.content.size;
  tr.insert(at, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, at + 1));
  return true;
}

/** Build the controller bound to one editor view. */
function buildBlockSelection(view: EditorView): BlockSelection {
  const listeners = new Set<() => void>();
  let current: HTMLElement | null = null;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function isDestroyed(): boolean {
    return (
      (view as EditorView & { isDestroyed?: boolean }).isDestroyed === true
    );
  }

  function readSelected(): SelectedBlock | null {
    const element = current;
    if (element === null) return null;
    if (!element.isConnected) {
      clear();
      return null;
    }
    const pos = positionOfElement(view, element);
    if (pos === null) {
      clear();
      return null;
    }
    const node = view.state.doc.nodeAt(pos);
    if (node === null) {
      clear();
      return null;
    }
    return { element, pos, node, kind: kindOfNode(node) };
  }

  function clear(): void {
    const element = current;
    if (element === null) return;
    current = null;
    element.removeAttribute(SELECTED_ATTRIBUTE);
    if (!isDestroyed()) {
      // A node view may have re-rendered and left a stale mark behind; the
      // attribute is editing state, so dropping every copy is always correct.
      view.dom
        .querySelectorAll<HTMLElement>(`[${SELECTED_ATTRIBUTE}]`)
        .forEach((node) => node.removeAttribute(SELECTED_ATTRIBUTE));
    }
    notify();
  }

  /** Move the caret out of a block without changing the document. */
  function moveCaretOutside(element: HTMLElement): void {
    const pos = positionOfElement(view, element);
    if (pos === null) return;
    const node = view.state.doc.nodeAt(pos);
    if (node === null) return;
    const tr = view.state.tr;
    // Selecting a block never appends content: if nothing is typable around it
    // the caret simply stays where it was (the frozen editor does the same).
    if (placeCaretAround(tr, pos, node.nodeSize, false)) {
      // A selection-only transaction reports no document change, so this never
      // schedules a save.
      view.dispatch(tr);
    }
    view.focus();
  }

  function select(element: HTMLElement, options: SelectBlockOptions = {}): void {
    if (!element.isConnected) return;
    if (element === current) {
      if (options.moveCaret === true) moveCaretOutside(element);
      return;
    }
    const previous = current;
    current = element;
    if (previous !== null) previous.removeAttribute(SELECTED_ATTRIBUTE);
    element.setAttribute(SELECTED_ATTRIBUTE, '');
    if (options.moveCaret === true) moveCaretOutside(element);
    notify();
  }

  function refresh(): void {
    const element = current;
    if (element === null) return;
    if (!element.isConnected) {
      clear();
      return;
    }
    element.setAttribute(SELECTED_ATTRIBUTE, '');
    notify();
  }

  /** Delete one block node (and its whole line for a whole-line image). */
  function removeSelected(): boolean {
    const selected = readSelected();
    if (selected === null) return false;
    const { element, pos, node } = selected;
    const doc = view.state.doc;
    const $pos = doc.resolve(pos);
    const paragraph = doc.type.schema.nodes['paragraph'];
    const tr = view.state.tr;

    // An image inside running text: the paragraph stays, only the `<img>` goes.
    const inlineImage =
      node.type.name === 'image' && $pos.depth > 0 && $pos.parent.isTextblock;
    current = null;
    element.removeAttribute(SELECTED_ATTRIBUTE);

    if (inlineImage && !holdsOnlyOneImage($pos.parent)) {
      tr.delete(pos, pos + node.nodeSize);
      tr.setSelection(TextSelection.create(tr.doc, pos));
      view.dispatch(tr);
      view.focus();
      notify();
      return true;
    }

    // A whole-line image is removed with its line box (frozen `E:863-902`).
    let removePos = pos;
    let removeNode = node;
    if (inlineImage) {
      removePos = $pos.before($pos.depth);
      removeNode = $pos.parent;
    }

    // A container that requires content (the document itself, a list, a table
    // cell) cannot simply lose its last child; an empty paragraph keeps the
    // document valid and the caret usable (frozen `caretAfterRemoval`).
    const $remove = doc.resolve(removePos);
    const owner = $remove.parent;
    const removesCleanly = owner.canReplace(
      $remove.index(),
      $remove.index() + 1,
      Fragment.empty,
    );
    if (!removesCleanly) {
      if (paragraph === undefined) return false;
      tr.replaceWith(removePos, removePos + removeNode.nodeSize, paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, removePos + 1));
    } else {
      tr.delete(removePos, removePos + removeNode.nodeSize);
      placeCaretAround(tr, removePos, 0, true);
    }
    view.dispatch(tr);
    view.focus();
    notify();
    return true;
  }

  /**
   * Keep the caret out of a block that was just clicked.
   *
   * ProseMirror selects a selectable atom on mousedown (a `NodeSelection`);
   * typing then would replace the block, while the frozen contentEditable editor
   * only ever left the caret beside it. Collapse such a selection to the
   * nearest text position around the block.
   */
  function collapseNodeSelection(element: HTMLElement): void {
    const selection = view.state.selection;
    if (!(selection instanceof NodeSelection)) return;
    const pos = positionOfElement(view, element);
    if (pos === null || selection.from !== pos) return;
    const node = view.state.doc.nodeAt(pos);
    if (node === null) return;
    const tr = view.state.tr;
    if (!placeCaretAround(tr, pos, node.nodeSize, false)) return;
    view.dispatch(tr);
  }

  /** Re-apply the mark after a structural change re-resolved the block. */
  function reattach(pos: number, node: PmNode): void {
    const element = selectableElementOf(view, pos, node);
    if (element === null) {
      current = null;
      return;
    }
    current = element;
    element.setAttribute(SELECTED_ATTRIBUTE, '');
  }

  function moveSelected(delta: -1 | 1): boolean {
    const selected = readSelected();
    if (selected === null) return false;
    const doc = view.state.doc;
    const $pos = doc.resolve(selected.pos);
    const parent = $pos.parent;
    const index = $pos.index();
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= parent.childCount) return false;
    const node = parent.child(index);
    const neighbour = parent.child(targetIndex);

    let neighbourStart = $pos.start();
    for (let step = 0; step < targetIndex; step += 1) {
      neighbourStart += parent.child(step).nodeSize;
    }
    const start = selected.pos;
    const tr = view.state.tr.delete(start, start + node.nodeSize);
    const insertAt =
      delta < 0 ? neighbourStart : neighbourStart + neighbour.nodeSize - node.nodeSize;
    tr.insert(insertAt, node);
    placeCaretAround(tr, insertAt, node.nodeSize, false);

    current = null;
    selected.element.removeAttribute(SELECTED_ATTRIBUTE);
    view.dispatch(tr);
    reattach(insertAt, node);
    notify();
    return true;
  }

  /** The selectable block adjacent to the caret, if any (frozen `E:781-805`). */
  function adjacentSelectable(
    direction: 'backward' | 'forward',
  ): HTMLElement | null {
    const { selection } = view.state;
    if (!selection.empty) return null;
    const $from = selection.$from;
    let depth = $from.depth;
    while (depth > 0 && !$from.node(depth).isTextblock) depth -= 1;
    if (depth === 0) return null;
    const block = $from.node(depth);
    if (!block.isTextblock) return null;
    const atEdge =
      direction === 'backward'
        ? $from.pos === $from.start(depth)
        : $from.pos === $from.end(depth);
    if (!atEdge) return null;
    const parent = $from.node(depth - 1);
    const index = $from.index(depth - 1);
    const siblingIndex = direction === 'backward' ? index - 1 : index + 1;
    if (siblingIndex < 0 || siblingIndex >= parent.childCount) return null;
    const sibling = parent.child(siblingIndex);
    const siblingPos =
      direction === 'backward'
        ? $from.before(depth) - sibling.nodeSize
        : $from.before(depth) + block.nodeSize;
    // Only dividers and whole-line images are pickable by the caret; a table is
    // selected from its own bar, never by pressing a delete key next to it.
    const kind = kindOfNode(sibling);
    if (kind === 'divider' || kind === 'image') {
      return selectableElementOf(view, siblingPos, sibling);
    }
    // Legacy kept pasted images inside their paragraph; treat a line holding
    // nothing but one image as a whole-line image too.
    if (sibling.isTextblock && holdsOnlyOneImage(sibling)) {
      const dom = view.nodeDOM(siblingPos);
      if (dom instanceof HTMLElement) {
        return dom.querySelector<HTMLElement>('img');
      }
    }
    return null;
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229) return false;
    const selected = readSelected();
    if (selected !== null) {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        // The frozen editor deletes the selected block without looking at
        // modifiers (only the adjacency branch below is modifier-sensitive).
        event.preventDefault();
        removeSelected();
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        clear();
        return true;
      }
      // Any other key returns to normal caret editing.
      clear();
      return false;
    }
    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      !hasModifier(event)
    ) {
      const element = adjacentSelectable(
        event.key === 'Backspace' ? 'backward' : 'forward',
      );
      if (element !== null) {
        event.preventDefault();
        // Selecting must not change the document, so the first press neither
        // deletes nor schedules a save.
        select(element);
        return true;
      }
    }
    return false;
  }

  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Task rows own their own click behaviour (their node view toggles and
    // saves); everything else that is a card or link is cleared here and then
    // activated by the link overlay.
    if (target.closest('[data-todo-box], [data-todo]') !== null) return;
    const image = target.closest('img');
    if (image !== null) {
      event.preventDefault();
      select(image);
      collapseNodeSelection(image);
      return;
    }
    const divider = target.closest('[data-divider]');
    if (divider instanceof HTMLElement) {
      event.preventDefault();
      select(divider);
      collapseNodeSelection(divider);
      return;
    }
    clear();
  };

  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && view.dom.contains(next)) return;
    if (next === null) {
      const active = document.activeElement;
      if (active instanceof Node && view.dom.contains(active)) return;
    }
    clear();
  };

  view.dom.addEventListener('click', onClick);
  view.dom.addEventListener('focusout', onFocusOut);

  return {
    selected: readSelected,
    select,
    clear,
    refresh,
    removeSelected,
    moveSelected,
    handleKeyDown,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      view.dom.removeEventListener('click', onClick);
      view.dom.removeEventListener('focusout', onFocusOut);
      const element = current;
      current = null;
      element?.removeAttribute(SELECTED_ATTRIBUTE);
      listeners.clear();
      selections.delete(view);
    },
  };
}
