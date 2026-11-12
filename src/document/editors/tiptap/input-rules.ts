/**
 * Markdown-ish line conversions typed at the start of a line.
 *
 * The frozen editor applies these rules itself from its `keydown` handler
 * in the retired frozen editor and again from
 * `input`/`compositionend` (`E:989-1064`). Parity details that must survive:
 *
 * - a rule only fires when the whole line (trimmed at the end) is exactly the
 *   marker — `#标题` and `- 内容` stay text;
 * - the confirming key is swallowed even when the caret is not at the line end
 *   (so a half-typed marker followed by space does not insert a space);
 * - `N.` keeps its number as the list's `start` (only when `N > 1`);
 * - `---` converts immediately on the third dash, while typing, without the
 *   Enter keystroke; later an Enter on a whole `---` line also converts.
 *
 * This module owns the conversion *transactions*; key dispatch stays in
 * `keyboard.ts`. Every conversion is one transaction so it stays a single undo
 * step and a single change notification.
 *
 * @module @alter-dsh/space/document/editors/tiptap/input-rules
 */
import { Extension, type AnyExtension } from '@tiptap/core';
import type { Node as PmNode, ResolvedPos, Schema } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** Plugin key of the typed-divider text-input rule. */
export const lineRulesPluginKey = new PluginKey('alterSpaceLineRules');

/** One line marker the frozen editor converts into a block. */
export interface LineMarker {
  kind: 'heading' | 'bullet' | 'ordered' | 'todo' | 'quote';
  /** Heading level (`#`..`###`). */
  level?: 1 | 2 | 3;
  /** Ordered-list first number (`N.`); omitted for `N <= 1`. */
  start?: number;
}

/** Heading markers, in the frozen editor's exact spelling. */
const HEADING_MARKERS: Readonly<Record<string, 1 | 2 | 3>> = {
  '#': 1,
  '##': 2,
  '###': 3,
};

/**
 * Detect one marker from the whole line text.
 *
 * Trailing whitespace is ignored (`line.textContent.trimEnd()` in the frozen
 * editor); leading whitespace is not.
 */
export function detectLineMarker(rawText: string): LineMarker | null {
  const text = rawText.trimEnd();
  const level = HEADING_MARKERS[text];
  if (level !== undefined) return { kind: 'heading', level };
  if (text === '-') return { kind: 'bullet' };
  if (text === '*') return { kind: 'bullet' };
  if (text === '[]') return { kind: 'todo' };
  if (text === '[ ]') return { kind: 'todo' };
  if (text === '>') return { kind: 'quote' };
  if (text === '》') return { kind: 'quote' };
  const ordered = /^(\d{1,7})\.$/.exec(text);
  if (ordered !== null) {
    const start = Number.parseInt(ordered[1]!, 10);
    // The frozen editor only writes `start` when the number is above one.
    return start > 1 ? { kind: 'ordered', start } : { kind: 'ordered' };
  }
  return null;
}

/** One empty paragraph, the content of every freshly converted empty block. */
function createParagraph(schema: Schema): PmNode | null {
  const paragraph = schema.nodes['paragraph'];
  if (paragraph === undefined) return null;
  return paragraph.create({ id: null }, null, []);
}

/**
 * Caret position at the end of the deepest textblock inside one node.
 *
 * Used to park the caret at the end of a freshly created list item / heading /
 * quote paragraph, mirroring the frozen `placeCaretAtEnd` after a conversion.
 *
 * @param node - the node that was just inserted.
 * @param nodePos - its position in the new document (before the node).
 */
export function endPositionOf(node: PmNode, nodePos: number): number {
  if (node.isTextblock) return nodePos + 1 + node.content.size;
  if (node.isLeaf || node.childCount === 0) return nodePos + 1;
  const last = node.child(node.childCount - 1);
  return endPositionOf(last, nodePos + 1 + (node.content.size - last.nodeSize));
}

/** Pick the item node type a task list accepts (`taskItem` wins when present). */
function taskItemType(schema: Schema): PmNode['type'] | null {
  const list = schema.nodes['taskList'];
  if (list === undefined) return null;
  for (const name of ['taskItem', 'listItem']) {
    const candidate = schema.nodes[name];
    if (candidate === undefined) continue;
    if (list.contentMatch.matchType(candidate) !== null) return candidate;
  }
  return null;
}

/** The block one marker converts the current line into, or `null` if absent. */
function markerBlock(schema: Schema, marker: LineMarker): PmNode | null {
  const paragraph = createParagraph(schema);
  if (paragraph === null) return null;
  switch (marker.kind) {
    case 'heading': {
      const heading = schema.nodes['heading'];
      if (heading === undefined) return null;
      return heading.create(
        { id: null, level: marker.level ?? 1 },
        null,
        [],
      );
    }
    case 'bullet': {
      const list = schema.nodes['bulletList'];
      const item = schema.nodes['listItem'];
      if (list === undefined || item === undefined) return null;
      return list.create({ id: null }, item.create({ id: null }, paragraph));
    }
    case 'ordered': {
      const list = schema.nodes['orderedList'];
      const item = schema.nodes['listItem'];
      if (list === undefined || item === undefined) return null;
      const attrs =
        marker.start !== undefined ? { id: null, start: marker.start } : { id: null };
      return list.create(attrs, item.create({ id: null }, paragraph));
    }
    case 'todo': {
      const list = schema.nodes['taskList'];
      const item = taskItemType(schema);
      if (list === undefined || item === null) return null;
      const itemAttrs =
        (item as unknown as { attrs?: Record<string, unknown> }).attrs ?? {};
      const attrs: Record<string, unknown> = { id: null };
      if (itemAttrs['checked'] !== undefined) attrs['checked'] = false;
      return list.create({ id: null }, item.create(attrs, paragraph));
    }
    case 'quote': {
      const quote = schema.nodes['blockquote'];
      if (quote === undefined) return null;
      return quote.create({ id: null }, paragraph);
    }
  }
}

/**
 * Whether the caret is on a line the marker rules may convert.
 *
 * The frozen editor converts the line element it finds from the caret. For this
 * kernel that is the caret's own textblock at the document root, or a textblock
 * directly inside a quote (the frozen quote holds its line inline, so its
 * "line" is the quote itself). Markers typed inside a list item or table cell
 * are left to the default input path: replacing their sibling blocks would
 * destroy content the frozen DOM never had to preserve.
 */
function markerHostOf(
  $from: ResolvedPos,
): { start: number; node: PmNode } | null {
  if ($from.depth === 1) return { start: $from.before(1), node: $from.node(1) };
  if (
    $from.depth === 2 &&
    $from.node(1).type.name === 'blockquote'
  ) {
    return { start: $from.before(1), node: $from.node(1) };
  }
  return null;
}

/** Whether the line containing the caret is a marker-convertible host. */
export function isMarkerLineHost(state: EditorState): boolean {
  const selection = state.selection;
  if (!(selection instanceof TextSelection)) return false;
  return markerHostOf(selection.$from) !== null;
}

/**
 * Build the transaction that converts the current line for one marker.
 *
 * The whole textblock is replaced (the frozen editor clears `line.innerHTML`
 * before converting), so the marker itself never reaches the document. Returns
 * `null` when the caret is not on a convertible line.
 */
export function markerTransaction(
  state: EditorState,
  marker: LineMarker,
): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  const host = markerHostOf($from);
  if (host === null) return null;

  // A quote marker typed inside a quote cannot nest a second quote line the way
  // the frozen DOM would; keep the paragraph and just drop the marker text.
  if (
    marker.kind === 'quote' &&
    $from.depth === 2 &&
    $from.node(1).type.name === 'blockquote'
  ) {
    if ($from.start() === $from.end()) return null;
    return state.tr.delete($from.start(), $from.end());
  }

  const block = markerBlock(state.schema, marker);
  if (block === null) return null;
  const tr = state.tr.replaceWith(
    host.start,
    host.start + host.node.nodeSize,
    block,
  );
  const caret = endPositionOf(block, host.start);
  tr.setSelection(TextSelection.create(tr.doc, caret));
  return tr;
}

/** Options of {@link dividerTransaction}. */
export interface DividerOptions {
  /**
   * Whether the caret must already be at the line end.
   *
   * The immediate `input` path requires it; the frozen Enter path does not.
   */
  requireCaretAtEnd?: boolean;
  /** Line text to test instead of the textblock's current text. */
  lineText?: string;
  /**
   * Allow hosts outside P/H1-3/top-level BLOCKQUOTE (the Enter path converts a
   * whole line wherever the browser put it, including a list item).
   */
  allowNested?: boolean;
}

/** True when the position sits inside a table cell. */
function inTableCell($from: ResolvedPos): boolean {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return true;
  }
  return false;
}

/**
 * Build the transaction that turns the current whole `---` line into one
 * divider followed by an empty paragraph, with the caret in that paragraph.
 */
export function dividerTransaction(
  state: EditorState,
  options: DividerOptions = {},
): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $from = selection.$from;
  const parent = $from.parent;
  if (!parent.isTextblock) return null;
  const lineText =
    options.lineText ?? parent.textBetween(0, parent.content.size);
  if (lineText.trimEnd() !== '---') return null;
  if ((options.requireCaretAtEnd ?? true) && selection.from !== $from.end()) {
    return null;
  }
  // The immediate input path only converts the frozen host line types
  // (P/H1-H3 and a quote line); list items, table cells and code blocks keep
  // their text until the Enter branch runs.
  if (!options.allowNested) {
    const host = parent.type.name;
    if (host !== 'paragraph' && host !== 'heading') return null;
  }
  const divider = state.schema.nodes['divider'];
  const paragraph = createParagraph(state.schema);
  if (divider === undefined || paragraph === null) return null;

  const nodes: [PmNode, PmNode] = [
    divider.create({ id: null }, null, []),
    paragraph,
  ];
  const depth = $from.depth;
  if (depth === 1 && parent.type.name !== 'blockquote') {
    const current = $from.node(1);
    return replaceLine(state, $from.before(1), current, nodes);
  }
  if (depth === 2 && $from.node(1).type.name === 'blockquote') {
    const quote = $from.node(1);
    if (quote.childCount === 1) {
      // The frozen quote line is the quote element itself: `---` inside it
      // replaces the whole quote with `[divider, p]`.
      return replaceLine(state, $from.before(1), quote, nodes);
    }
    if (!options.allowNested) return null;
    const current = $from.node(2);
    return replaceLine(state, $from.before(2), current, nodes);
  }
  if (!options.allowNested) return null;
  if (inTableCell($from)) return null;
  const current = $from.node(1);
  return replaceLine(state, $from.before(1), current, nodes);
}

/** Replace one line block with `[divider, paragraph]` and park the caret. */
function replaceLine(
  state: EditorState,
  start: number,
  current: PmNode,
  nodes: [PmNode, PmNode],
): Transaction {
  const tr = state.tr.replaceWith(start, start + current.nodeSize, nodes);
  const caret = start + nodes[0].nodeSize + 1;
  tr.setSelection(TextSelection.create(tr.doc, caret));
  return tr;
}

/**
 * The typed `---` rule: convert as soon as the third dash is typed.
 *
 * ProseMirror calls this before the dash reaches the document, so the line text
 * is rebuilt from the textblock plus the pending character.
 */
function applyTypedDivider(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean {
  if (text !== '-' || from !== to) return false;
  const state = view.state;
  const $from = state.doc.resolve(from);
  const parent = $from.parent;
  if (!parent.isTextblock) return false;
  // Only a dash inserted at the very end of the line can complete the gesture.
  if (from !== $from.end()) return false;
  const lineText =
    parent.textBetween(0, parent.content.size) + text;
  if (lineText.trimEnd() !== '---') return false;
  const tr = dividerTransaction(state, {
    lineText,
    requireCaretAtEnd: false,
  });
  if (tr === null) return false;
  view.dispatch(tr);
  return true;
}

/**
 * The input-rules extension: the immediate `---` conversion.
 *
 * Marker conversion on the confirming Space/Enter belongs to `keyboard.ts`
 * (the confirming key must be swallowed even when no conversion happens), and
 * `----`-style stale Tiptap rules are not registered: the frozen editor has no
 * such shortcut.
 */
export function createLineRulesExtension(): AnyExtension {
  return Extension.create({
    name: 'alterSpaceLineRules',
    // Run before StarterKit's own markdown rules and the core keymap.
    priority: 1000,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: lineRulesPluginKey,
          props: {
            handleTextInput(view, from, to, text) {
              // An open composition owns the input: never convert half-composed
              // text (the compositionend path converts explicitly instead).
              if (view.composing) return false;
              return applyTypedDivider(view, from, to, text);
            },
          },
        }),
      ];
    },
  });
}