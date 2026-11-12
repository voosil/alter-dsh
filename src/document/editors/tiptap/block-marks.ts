/**
 * Transient block marks: `data-block-hover` / `data-block-selected` on the DOM
 * of top-level blocks.
 *
 * The marks are ProseMirror node decorations, never DOM attributes written by
 * hand: the editable DOM belongs to ProseMirror, and an attribute set directly
 * onto a block is read back as a foreign mutation on the next DOM observation,
 * after which the block is re-rendered without it. A DOM-attribute mark never
 * survives a frame in a real browser (jsdom does not run that DOM reader, which
 * is why the direct mutation looked fine in tests). A decoration is part of the
 * view state, so the view applies and keeps it itself.
 *
 * Marks carry no document data: the handle only patches this plugin state, and
 * an edit (or any body change) drops them because their positions are stale.
 *
 * @module @alter-dsh/space/document/editors/tiptap/block-marks
 */
import { Extension } from '@tiptap/core';
import type { Selection } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

/** Editing-surface attribute marking the block whose handle is hovered. */
export const HOVER_ATTRIBUTE = 'data-block-hover';

/** Editing-surface attribute marking the block selected through the handle. */
export const SELECTED_ATTRIBUTE = 'data-block-selected';

/** The block the handle marked through a click (editing state only). */
export interface SelectedBlockMark {
  /** Position of the marked top-level block. */
  pos: number;
  /** Selection kind (`text`, `node`, `cell`, …) the mark was drawn for. */
  jsonID: string;
  from: number;
  to: number;
}

/** Transient marks the handle paints on block DOM. */
export interface BlockMarks {
  /** Position of the top-level block whose handle is hovered. */
  hoveredPos: number | null;
  /** Block selected through the handle, kept while the selection matches. */
  selected: SelectedBlockMark | null;
}

/** No block is marked. */
export const EMPTY_BLOCK_MARKS: BlockMarks = {
  hoveredPos: null,
  selected: null,
};

/** Key of the transient block marks inside the editor state. */
export const blockMarksKey = new PluginKey<BlockMarks>('alterBlockMarks');

/**
 * Selection kind id (`text`, `node`, `cell`, …) used to match a marked block.
 *
 * ProseMirror's `Selection` base class does not declare the per-subclass
 * `jsonID`; reading it is how the table plugin's normalized `CellSelection`
 * still matches the `NodeSelection` the handle asked for.
 */
export function selectionKind(selection: Selection): string {
  const withId = selection as Selection & { readonly jsonID?: string };
  return withId.jsonID ?? selection.constructor.name;
}

/** Write one mark patch as a transient view update (no document change). */
export function patchBlockMarks(
  view: EditorView,
  patch: Partial<BlockMarks>,
): void {
  view.dispatch(view.state.tr.setMeta(blockMarksKey, patch));
}

/** Node decorations for the currently marked blocks (sorted, one per block). */
function markDecorations(
  state: EditorState,
  marks: BlockMarks,
): DecorationSet {
  const attributesByPos = new Map<number, Record<string, string>>();
  if (marks.hoveredPos !== null) {
    attributesByPos.set(marks.hoveredPos, { [HOVER_ATTRIBUTE]: '' });
  }
  if (marks.selected !== null) {
    attributesByPos.set(marks.selected.pos, {
      ...attributesByPos.get(marks.selected.pos),
      [SELECTED_ATTRIBUTE]: '',
    });
  }
  const decorations: Decoration[] = [];
  const positions = [...attributesByPos.keys()].sort((left, right) => left - right);
  for (const pos of positions) {
    const attributes = attributesByPos.get(pos);
    const node = state.doc.nodeAt(pos);
    if (attributes === undefined || node === null) continue;
    decorations.push(Decoration.node(pos, pos + node.nodeSize, attributes));
  }
  return decorations.length === 0
    ? DecorationSet.empty
    : DecorationSet.create(state.doc, decorations);
}

/**
 * The kernel's marks plugin.
 *
 * Declared as an extension with the rest of the editor (not registered after
 * mounting): adding a plugin to a live view reconfigures its plugin list and
 * tears down every existing plugin view, which would wipe the comment paint.
 */
function createBlockMarksPlugin(): Plugin<BlockMarks> {
  return new Plugin<BlockMarks>({
    key: blockMarksKey,
    state: {
      init: () => EMPTY_BLOCK_MARKS,
      apply(tr, previous) {
        // Edits invalidate positions and the selection: both marks are transient
        // UI state, so they simply drop instead of being mapped.
        let next = tr.docChanged ? EMPTY_BLOCK_MARKS : previous;
        const patch = tr.getMeta(blockMarksKey) as
          | Partial<BlockMarks>
          | undefined;
        if (patch !== undefined) next = { ...next, ...patch };
        const selected = next.selected;
        if (selected !== null) {
          const selection = tr.selection;
          const matches =
            selectionKind(selection) === selected.jsonID &&
            selection.from === selected.from &&
            selection.to === selected.to;
          if (!matches) next = { ...next, selected: null };
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        const marks = blockMarksKey.getState(state) ?? EMPTY_BLOCK_MARKS;
        return markDecorations(state, marks);
      },
    },
  });
}

/** Declares the transient block marks plugin on every kernel editor. */
export const BlockMarksExtension = Extension.create({
  name: 'alterBlockMarks',
  addProseMirrorPlugins() {
    return [createBlockMarksPlugin()];
  },
});