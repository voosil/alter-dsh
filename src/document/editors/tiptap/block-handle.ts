/**
 * Block handle: the hover-only grip in the left gutter of a top-level block.
 *
 * Notion/飞书 style block affordance on top of the frozen editor surface:
 *
 * - hovering any **top-level** block (paragraph, heading, list, quote, code,
 *   table, divider, image, card) shows one 20px six-dot handle 26px left of the
 *   block's left edge, vertically aligned with its top;
 * - clicking the handle selects the whole block — a text block gets a
 *   `TextSelection` covering its content, an atom or a table gets a
 *   `NodeSelection` — and marks the block DOM with `data-block-selected`, an
 *   editing-surface attribute that never reaches the AST;
 * - dragging the handle reorders the block: while the pointer moves over other
 *   blocks an insertion line (`.kernelDropIndicator`) is shown at the target
 *   edge, and dropping moves the source node before/after the target with a
 *   plain ProseMirror transaction, so ids/attrs (and comment anchors) survive
 *   and the kernel's normal save path runs;
 * - dragging is cancelled with Escape or by leaving the body; dropping on the
 *   source block itself is ignored; top-level blocks only (list items are never
 *   split).
 *
 * The handle and the insertion line are body-level overlays: they must not be
 * serialized into the document, and CSS lives in `kernel.css` (owned by the
 * kernel, not the frozen stylesheet).
 *
 * @module @alter-dsh/space/document/editors/tiptap/block-handle
 */
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { closeOverlayBars } from './overlays';

/** Class of the handle shell (plain global class from `kernel.css`). */
const HANDLE_CLASS = 'kernelBlockHandle';

/** Class of the insertion line (plain global class from `kernel.css`). */
const INDICATOR_CLASS = 'kernelDropIndicator';

/** Handle sits this far left of the block's left edge. */
const HANDLE_LEFT_OFFSET_PX = 26;

/** Handle is aligned with the block top plus this offset. */
const HANDLE_TOP_OFFSET_PX = 2;

/** Smallest viewport distance kept for the handle (never off-screen). */
const HANDLE_MIN_LEFT_PX = 8;

/** Delay before the handle hides when the pointer leaves the body. */
const HIDE_DELAY_MS = 120;

/** Pointer travel that turns a press on the handle into a drag. */
const DRAG_THRESHOLD_PX = 4;

/** How far outside the body the pointer may travel and still drop. */
const DROP_TOLERANCE_PX = 48;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** One top-level block resolved against the current document. */
interface BlockRef {
  element: HTMLElement;
  pos: number;
  node: PmNode;
  index: number;
}

/** Where a dragged block would be inserted. */
interface DropTarget {
  element: HTMLElement;
  placement: 'before' | 'after';
}

/** One in-flight press/drag on the handle. */
interface DragState {
  block: HTMLElement;
  startX: number;
  startY: number;
  dragging: boolean;
  drop: DropTarget | null;
}

/** The block marked through the handle (editing state only). */
interface SelectedMark {
  element: HTMLElement;
  /** Selection kind (`text`, `node`, …) so table normalization still matches. */
  jsonID: string;
  from: number;
  to: number;
}

/** Options of {@link createBlockHandle}. */
export interface BlockHandleOptions {
  /**
   * Called when a block drag starts and ends.
   *
   * The frozen format bar is owned by the host, so it hides itself through
   * this hook while a block is being dragged. The kernel's own bars (link and
   * table) are hidden directly with {@link closeOverlayBars}.
   */
  onDragChange?(dragging: boolean): void;
}

/** The block handle bound to one editor view. */
export interface BlockHandle {
  /** The body-level handle button (exposed for tests and wiring). */
  element: HTMLButtonElement;
  /** Re-measure the handle for the block it currently points at. */
  refresh(): void;
  /** Remove the handle, the insertion line and every listener. */
  destroy(): void;
}

/** Six-dot grip icon (`grip-vertical` geometry), drawn without dependencies. */
function createGripIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'currentColor');
  const dots: ReadonlyArray<readonly [number, number]> = [
    [9, 5],
    [9, 12],
    [9, 19],
    [15, 5],
    [15, 12],
    [15, 19],
  ];
  for (const [cx, cy] of dots) {
    const dot = document.createElementNS(SVG_NAMESPACE, 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', '1.6');
    svg.append(dot);
  }
  return svg;
}

/** First/last typable position inside one block, if it has any text block. */
function textblockRangeInside(
  doc: PmNode,
  pos: number,
  node: PmNode,
): { from: number; to: number } | null {
  let from: number | null = null;
  let to: number | null = null;
  doc.nodesBetween(pos, pos + node.nodeSize, (child, childPos) => {
    if (!child.isTextblock) return true;
    if (from === null) from = childPos + 1;
    to = childPos + child.nodeSize - 1;
    // A text block cannot contain blocks: stop descending into it.
    return false;
  });
  return from === null || to === null ? null : { from, to };
}

/**
 * Selection kind id (`text`, `node`, `cell`, …) used to match a marked block.
 *
 * ProseMirror's `Selection` base class does not declare the per-subclass
 * `jsonID`; reading it is how the table plugin's normalized `CellSelection`
 * still matches the `NodeSelection` the handle asked for.
 */
function selectionKind(selection: Selection): string {
  const withId = selection as Selection & { readonly jsonID?: string };
  return withId.jsonID ?? selection.constructor.name;
}

/** Selection that means "the whole block" for one node. */
function selectionForBlock(
  doc: PmNode,
  pos: number,
  node: PmNode,
): Selection | null {
  if (node.isTextblock) {
    return TextSelection.create(doc, pos + 1, pos + node.nodeSize - 1);
  }
  if (node.isAtom || node.type.name === 'table') {
    return NodeSelection.create(doc, pos);
  }
  const range = textblockRangeInside(doc, pos, node);
  if (range !== null) return TextSelection.create(doc, range.from, range.to);
  return Selection.near(doc.resolve(pos + 1), 1);
}

/** Caret that stays inside a block after it moved. */
function selectionInsideBlock(
  doc: PmNode,
  pos: number,
  node: PmNode,
): Selection | null {
  if (node.isTextblock) return TextSelection.create(doc, pos + 1);
  if (node.isAtom || node.type.name === 'table') {
    return NodeSelection.create(doc, pos);
  }
  const range = textblockRangeInside(doc, pos, node);
  if (range !== null) return TextSelection.create(doc, range.from);
  return Selection.near(doc.resolve(pos), 1);
}

/**
 * Create the block handle of one editor.
 *
 * The host wires it next to the other floating surfaces and calls `destroy()`
 * when the editor is torn down; it owns nothing in the document itself.
 */
export function createBlockHandle(
  editor: Editor,
  options: BlockHandleOptions = {},
): BlockHandle {
  const view: EditorView = editor.view;

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = HANDLE_CLASS;
  handle.dataset['visible'] = 'false';
  handle.setAttribute('aria-label', '块操作');
  handle.title = '拖动以移动块，点击以选中';
  handle.append(createGripIcon());

  const indicator = document.createElement('div');
  indicator.className = INDICATOR_CLASS;
  indicator.dataset['dropIndicator'] = '';
  indicator.style.display = 'none';

  document.body.append(handle, indicator);

  let handleBlock: HTMLElement | null = null;
  let hideTimer: number | null = null;
  let drag: DragState | null = null;
  let suppressClick = false;
  let selectedMark: SelectedMark | null = null;
  let destroyed = false;

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  function clearSelectedBlock(): void {
    if (selectedMark === null) return;
    selectedMark.element.removeAttribute('data-block-selected');
    selectedMark = null;
  }

  function markSelected(ref: BlockRef, selection: Selection): void {
    clearSelectedBlock();
    ref.element.setAttribute('data-block-selected', '');
    selectedMark = {
      element: ref.element,
      jsonID: selectionKind(selection),
      from: selection.from,
      to: selection.to,
    };
  }

  /** Keep the mark only while the editor selection still matches the block. */
  function syncSelectedBlock(): void {
    const mark = selectedMark;
    if (mark === null) return;
    // A table NodeSelection is normalized by the table plugin into a
    // CellSelection, so compare the selection kind/range instead of the class.
    const selection = view.state.selection;
    const matches =
      selectionKind(selection) === mark.jsonID &&
      selection.from === mark.from &&
      selection.to === mark.to;
    if (!matches) clearSelectedBlock();
  }

  function selectBlock(ref: BlockRef): void {
    const selection = selectionForBlock(view.state.doc, ref.pos, ref.node);
    if (selection === null) return;
    view.dispatch(view.state.tr.setSelection(selection));
    view.focus();
    markSelected(ref, selection);
  }

  // -------------------------------------------------------------------------
  // Blocks and geometry
  // -------------------------------------------------------------------------

  /** Resolve the document node rendered by one top-level block element. */
  function locate(element: HTMLElement): BlockRef | null {
    const doc = view.state.doc;
    let pos = 0;
    for (let index = 0; index < doc.childCount; index += 1) {
      const node = doc.child(index);
      if (view.nodeDOM(pos) === element) return { element, pos, node, index };
      pos += node.nodeSize;
    }
    return null;
  }

  /** The editable root's direct child that contains one event target. */
  function topLevelBlockOf(target: EventTarget | null): HTMLElement | null {
    const dom = view.dom;
    let element: HTMLElement | null =
      target instanceof HTMLElement
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
    while (element !== null && element.parentElement !== dom) {
      element = element.parentElement;
    }
    return element !== null && element.parentElement === dom ? element : null;
  }

  function positionHandle(element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    handle.style.left = `${Math.max(HANDLE_MIN_LEFT_PX, rect.left - HANDLE_LEFT_OFFSET_PX)}px`;
    handle.style.top = `${rect.top + HANDLE_TOP_OFFSET_PX}px`;
  }

  function showHandle(element: HTMLElement): void {
    handleBlock = element;
    positionHandle(element);
    handle.dataset['visible'] = 'true';
  }

  function hideHandle(): void {
    handleBlock = null;
    handle.dataset['visible'] = 'false';
  }

  function cancelScheduledHide(): void {
    if (hideTimer === null) return;
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  function scheduleHide(): void {
    cancelScheduledHide();
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      hideHandle();
    }, HIDE_DELAY_MS);
  }

  // -------------------------------------------------------------------------
  // Drag reorder
  // -------------------------------------------------------------------------

  function clearDropIndicator(): void {
    indicator.style.display = 'none';
    if (drag !== null) drag.drop = null;
  }

  function showDropIndicator(target: DropTarget): void {
    const rect = target.element.getBoundingClientRect();
    const editorRect = view.dom.getBoundingClientRect();
    const left = Math.min(rect.left, editorRect.left);
    const right = Math.max(rect.right, editorRect.right);
    indicator.style.display = '';
    indicator.style.left = `${left}px`;
    indicator.style.width = `${Math.max(0, right - left)}px`;
    indicator.style.top = `${target.placement === 'before' ? rect.top : rect.bottom}px`;
  }

  /**
   * Target block under one point and which edge of it the pointer is on.
   *
   * Rectangles are used instead of `elementFromPoint` so the behaviour is
   * identical for the editable (which jsdom does not lay out) and so a pointer
   * that leaves the body clears the target instead of picking the body itself.
   */
  function dropTargetAt(x: number, y: number): DropTarget | null {
    const editorRect = view.dom.getBoundingClientRect();
    if (
      x < editorRect.left - DROP_TOLERANCE_PX ||
      x > editorRect.right + DROP_TOLERANCE_PX ||
      y < editorRect.top - DROP_TOLERANCE_PX ||
      y > editorRect.bottom + DROP_TOLERANCE_PX
    ) {
      return null;
    }
    const children = [...view.dom.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    let last: HTMLElement | null = null;
    for (const child of children) {
      const rect = child.getBoundingClientRect();
      last = child;
      if (y < rect.top) return { element: child, placement: 'before' };
      if (y <= rect.bottom) {
        const middle = rect.top + rect.height / 2;
        return { element: child, placement: y < middle ? 'before' : 'after' };
      }
    }
    return last === null ? null : { element: last, placement: 'after' };
  }

  function updateDropTarget(x: number, y: number): void {
    if (drag === null) return;
    const target = dropTargetAt(x, y);
    if (target === null || target.element === drag.block) {
      clearDropIndicator();
      return;
    }
    drag.drop = target;
    showDropIndicator(target);
  }

  /** Move one top-level block before/after another one (same parent only). */
  function moveBlock(source: HTMLElement, target: DropTarget): void {
    const sourceRef = locate(source);
    const targetRef = locate(target.element);
    if (sourceRef === null || targetRef === null) return;
    if (sourceRef.pos === targetRef.pos) return;
    const insertAtOriginal =
      target.placement === 'before'
        ? targetRef.pos
        : targetRef.pos + targetRef.node.nodeSize;
    if (
      insertAtOriginal === sourceRef.pos ||
      insertAtOriginal === sourceRef.pos + sourceRef.node.nodeSize
    ) {
      return;
    }
    const tr = view.state.tr.delete(
      sourceRef.pos,
      sourceRef.pos + sourceRef.node.nodeSize,
    );
    const insertAt =
      insertAtOriginal > sourceRef.pos
        ? insertAtOriginal - sourceRef.node.nodeSize
        : insertAtOriginal;
    tr.insert(insertAt, sourceRef.node);
    const selection = selectionInsideBlock(tr.doc, insertAt, sourceRef.node);
    if (selection !== null) tr.setSelection(selection);
    view.dispatch(tr);
    view.focus();
    clearSelectedBlock();
  }

  function beginDrag(): void {
    if (drag === null || drag.dragging) return;
    drag.dragging = true;
    suppressClick = true;
    hideHandle();
    // Floating surfaces must not overlap the drag: both kernel bars are ours,
    // the frozen format bar is hidden by the host through `onDragChange`.
    closeOverlayBars(editor);
    options.onDragChange?.(true);
  }

  function finishDrag(): void {
    const wasDragging = drag?.dragging === true;
    drag = null;
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', onDragUp, true);
    document.removeEventListener('keydown', onDragKeyDown, true);
    indicator.style.display = 'none';
    if (wasDragging) options.onDragChange?.(false);
  }

  function onDragMove(event: MouseEvent): void {
    if (drag === null) return;
    if (!drag.dragging) {
      const travelled = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (travelled < DRAG_THRESHOLD_PX) return;
      beginDrag();
    }
    updateDropTarget(event.clientX, event.clientY);
  }

  function onDragUp(): void {
    if (drag === null) return;
    const state = drag;
    const wasDragging = state.dragging;
    finishDrag();
    if (!wasDragging) return;
    suppressClick = true;
    if (state.drop === null) return;
    moveBlock(state.block, state.drop);
  }

  function onDragKeyDown(event: KeyboardEvent): void {
    if (drag === null || event.key !== 'Escape') return;
    event.preventDefault();
    if (drag.dragging) suppressClick = true;
    finishDrag();
  }

  function startDrag(event: MouseEvent): void {
    if (event.button !== 0 || handleBlock === null) return;
    // Keep the editor selection: pressing the handle must not move the caret.
    event.preventDefault();
    cancelScheduledHide();
    drag = {
      block: handleBlock,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      drop: null,
    };
    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', onDragUp, true);
    document.addEventListener('keydown', onDragKeyDown, true);
  }

  // -------------------------------------------------------------------------
  // Handle interaction
  // -------------------------------------------------------------------------

  function onClick(): void {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (handleBlock === null) return;
    const ref = locate(handleBlock);
    if (ref === null) return;
    selectBlock(ref);
  }

  function onHandleEnter(): void {
    cancelScheduledHide();
  }

  function onHandleLeave(): void {
    if (drag === null) scheduleHide();
  }

  // -------------------------------------------------------------------------
  // Body listeners
  // -------------------------------------------------------------------------

  function onBodyMouseMove(event: MouseEvent): void {
    if (drag !== null && drag.dragging) return;
    cancelScheduledHide();
    const block = topLevelBlockOf(event.target);
    if (block === null) {
      hideHandle();
      return;
    }
    showHandle(block);
  }

  function onBodyMouseLeave(): void {
    if (drag !== null && drag.dragging) return;
    scheduleHide();
  }

  function onScroll(): void {
    cancelScheduledHide();
    hideHandle();
    if (drag !== null) clearDropIndicator();
  }

  function onResize(): void {
    cancelScheduledHide();
    hideHandle();
  }

  /** Losing the window mid-drag (alt-tab, OS drag) must not leave a stale drag. */
  function onWindowBlur(): void {
    if (drag === null) return;
    if (drag.dragging) suppressClick = true;
    finishDrag();
  }

  handle.addEventListener('mousedown', startDrag);
  handle.addEventListener('click', onClick);
  handle.addEventListener('mouseenter', onHandleEnter);
  handle.addEventListener('mouseleave', onHandleLeave);
  view.dom.addEventListener('mousemove', onBodyMouseMove);
  view.dom.addEventListener('mouseleave', onBodyMouseLeave);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onWindowBlur);
  editor.on('selectionUpdate', syncSelectedBlock);

  const onEditorDestroy = (): void => {
    destroy();
  };
  editor.on('destroy', onEditorDestroy);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    cancelScheduledHide();
    if (drag !== null) finishDrag();
    editor.off('selectionUpdate', syncSelectedBlock);
    editor.off('destroy', onEditorDestroy);
    view.dom.removeEventListener('mousemove', onBodyMouseMove);
    view.dom.removeEventListener('mouseleave', onBodyMouseLeave);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onWindowBlur);
    handle.removeEventListener('mousedown', startDrag);
    handle.removeEventListener('click', onClick);
    handle.removeEventListener('mouseenter', onHandleEnter);
    handle.removeEventListener('mouseleave', onHandleLeave);
    clearSelectedBlock();
    handle.remove();
    indicator.remove();
  }

  return {
    element: handle,
    refresh() {
      if (handleBlock !== null) positionHandle(handleBlock);
    },
    destroy,
  };
}