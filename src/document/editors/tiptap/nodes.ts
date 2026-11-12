/**
 * Tiptap node/mark extensions derived from the client manifest.
 *
 * The visual contract is the frozen `Editor.module.css`: it styles plain
 * elements (`p`, `h1`, `pre > code`, `ul`, `blockquote`, `table`, `img`) and
 * `data-*` attributes (`data-todo`, `data-divider`, `data-file`, …), so the
 * kernel renders exactly those shapes and reuses the stylesheet unchanged.
 * The card DOM itself is built in `cards.ts` from the frozen loader projection
 * (`src/document/runtime/to-html.ts`), which is the frozen UX reference.
 *
 * No node here re-implements editor behavior beyond the block-level contract the
 * frozen editor implements by hand (todo row keys, card activation, task-list
 * conversion): input rules, selection handling and undo come from
 * Tiptap/ProseMirror extensions layered on in `editors/tiptap/editor.ts`.
 *
 * @module @alter-dsh/space/document/editors/tiptap/nodes
 */
import {
  Extension,
  Mark,
  Node,
  type AnyExtension,
  type Attribute,
  type Editor,
} from '@tiptap/core';
import { Table } from '@tiptap/extension-table';
import {
  Fragment,
  type Mark as PmMark,
  type Node as PmNode,
} from '@tiptap/pm/model';
import {
  Plugin,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  MARK_ORDER,
  NODE_MANIFEST,
  type NodeAttrSpec,
  type NodeManifestEntry,
} from '../../schema-manifest';
import {
  bookmarkCardSpec,
  calloutSpec,
  dividerSpec,
  docLinkCardSpec,
  fileCardSpec,
  imageSpec,
  objectCardSpec,
  type CardRenderContext,
} from './cards';
import {
  createTaskItemView,
  TODO_TEXT_ATTRIBUTES,
  todoBoxAttributes,
  todoRowAttributes,
} from './node-views';

/** Node types Tiptap provides natively (paragraph, heading, lists, blockquote, code). */
const NATIVE = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
]);

/** Node types rendered as atomic cards/placeholders (no in-place editing). */
const ATOM_TYPES = new Set([
  'image',
  'file',
  'bookmark',
  'docLink',
  'mindmap',
  'component',
]);

/** DOM tag the frozen stylesheet expects for one atom node type. */
const TAG_OF: Readonly<Record<string, string>> = {
  image: 'img',
  file: 'span',
  bookmark: 'a',
  docLink: 'a',
  mindmap: 'div',
  component: 'div',
};

/**
 * The stable block id, always rendered as `data-block-id`.
 *
 * The frozen stylesheet and the comment rail both locate blocks through
 * `[data-block-id]`, so a node that forgets it silently loses its anchor. The
 * value is an editor concern, never a raw AST attribute name, so the attribute
 * renders itself instead of leaking `id="…"`.
 */
const BLOCK_ID_ATTRIBUTE: Attribute = {
  default: null,
  rendered: false,
  parseHTML: (element: HTMLElement): string | null =>
    element.getAttribute('data-block-id'),
};

/** Where one AST attr is read from in pasted/loaded HTML. */
const DATA_SOURCE: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  image: {
    assetId: ['data-asset-id'],
    alt: ['alt'],
    caption: ['title', 'data-caption'],
    width: ['width'],
  },
  file: {
    assetId: ['data-asset-id'],
    name: ['data-name', 'data-file'],
    mime: ['data-mime'],
    bytes: ['data-bytes'],
  },
  bookmark: {
    url: ['data-href', 'data-link-card'],
    title: ['data-title'],
    description: ['data-description'],
    icon: ['data-icon'],
  },
  docLink: {
    docId: ['data-doc-id', 'data-doc-link'],
    title: ['data-title'],
  },
  mindmap: {
    objectId: ['data-object-id'],
    caption: ['data-caption'],
  },
  component: {
    objectId: ['data-object-id'],
    title: ['data-title'],
    description: ['data-description'],
  },
  callout: {
    tone: ['data-tone'],
    title: ['data-title'],
    icon: ['data-icon'],
    collapsed: ['data-collapsed'],
  },
};

/** Parse one attribute from the first matching HTML attribute name. */
function readAttribute(
  element: HTMLElement,
  names: readonly string[],
  type: NodeAttrSpec['type'],
): unknown {
  for (const name of names) {
    const raw = element.getAttribute(name);
    if (raw === null) continue;
    if (type === 'number') {
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    }
    if (type === 'boolean') return raw === '' || raw === 'true';
    return raw;
  }
  return null;
}

/**
 * Registry attributes for one node, parsed from the frozen `data-*` names.
 *
 * `rendered: false` is deliberate: the node's `renderHTML` builds the frozen DOM
 * itself, so no attribute can slip into the DOM under its AST name.
 */
function attributesOf(
  entry: NodeManifestEntry,
  sources: Readonly<Record<string, readonly string[]>> = {},
): Record<string, Attribute> {
  const attrs: Record<string, Attribute> = { id: BLOCK_ID_ATTRIBUTE };
  for (const [key, spec] of Object.entries(entry.attrs)) {
    const names = sources[key] ?? [];
    attrs[key] = {
      default: spec.default ?? null,
      rendered: false,
      parseHTML: (element: HTMLElement): unknown =>
        readAttribute(element, names, spec.type),
    };
  }
  return attrs;
}

/** Parse rules for one atom node type (tag selectors from the frozen DOM). */
function atomParseRules(type: string): { tag: string }[] {
  switch (type) {
    case 'image':
      return [{ tag: 'img' }];
    case 'file':
      return [{ tag: 'span[data-file]' }];
    case 'bookmark':
      return [{ tag: 'a[data-link-card]' }];
    case 'docLink':
      return [{ tag: 'a[data-doc-link]' }];
    case 'mindmap':
      return [{ tag: 'div[data-object-card][data-kind="mindmap"]' }];
    case 'component':
      return [{ tag: 'div[data-object-card][data-kind="component"]' }];
    default:
      return [];
  }
}

/**
 * A divider renders as the frozen stylesheet expects: a selectable wrapper
 * carrying `data-divider` around an `<hr>` (`.surface [data-divider] hr`).
 *
 * The `---` input rule that creates one lives with the other line-prefix rules
 * (`input-rules.ts`), so this extension only owns the node and its DOM.
 */
const Divider = Node.create({
  name: 'divider',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return attributesOf(NODE_MANIFEST['divider']!);
  },
  parseHTML() {
    return [{ tag: 'div[data-divider]' }, { tag: 'hr' }];
  },
  renderHTML({ node }) {
    return dividerSpec(node.attrs);
  },
});

/** One atomic card/placeholder node rendered with the frozen card DOM. */
function atomNode(
  entry: NodeManifestEntry,
  context: CardRenderContext,
): AnyExtension {
  const tag = TAG_OF[entry.type] ?? 'div';
  return Node.create({
    name: entry.type,
    group: 'block',
    atom: true,
    selectable: true,
    addAttributes() {
      return attributesOf(entry, DATA_SOURCE[entry.type]);
    },
    parseHTML() {
      return atomParseRules(entry.type);
    },
    renderHTML({ node }) {
      switch (entry.type) {
        case 'image':
          return imageSpec(node.attrs, context);
        case 'file':
          return fileCardSpec(node.attrs, context);
        case 'bookmark':
          return bookmarkCardSpec(node.attrs);
        case 'docLink':
          return docLinkCardSpec(node.attrs, context);
        case 'mindmap':
        case 'component':
          return objectCardSpec(entry.type, node.attrs);
        default: {
          const id = node.attrs['id'];
          return [
            tag,
            typeof id === 'string' && id !== ''
              ? { 'data-block-id': id }
              : {},
          ];
        }
      }
    },
  });
}

/**
 * Task list: the AST container for todo rows.
 *
 * The frozen DOM has **no** list wrapper (each row is a top-level
 * `div[data-todo]`), but a ProseMirror node needs one container to own the
 * rows, so it renders a display-only `div[data-task-list]` that
 * `kernel.css` removes from the layout and the frozen stylesheet never sees.
 */
const TaskList = Node.create({
  name: 'taskList',
  group: 'block',
  content: 'taskItem+',
  defining: true,
  addAttributes() {
    return { id: BLOCK_ID_ATTRIBUTE };
  },
  parseHTML() {
    return [{ tag: 'div[data-task-list]' }];
  },
  renderHTML({ node }) {
    const id = node.attrs['id'];
    return [
      'div',
      {
        'data-task-list': '',
        ...(typeof id === 'string' && id !== '' ? { 'data-block-id': id } : {}),
      },
      0,
    ];
  },
  addCommands() {
    return {
      toggleTaskList:
        () =>
        ({ state, tr, dispatch }): boolean =>
          toggleTaskListAtSelection(state, tr, dispatch),
    };
  },
});

/**
 * One todo row: `div[data-todo]` with a non-editable checkbox and a text span.
 *
 * The row keeps block content (the AST list item is a container), so the live
 * DOM comes from a node view (`node-views.ts`) that updates in place; the
 * `renderHTML` below is the serialized twin for undo/clipboard/HTML output.
 */
const TaskItemNode = Node.create({
  name: 'taskItem',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  addAttributes() {
    return {
      id: BLOCK_ID_ATTRIBUTE,
      checked: {
        default: false,
        rendered: false,
        parseHTML: (element: HTMLElement): boolean => {
          const raw = element.getAttribute('data-checked');
          return raw === '' || raw === 'true';
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-todo]' }];
  },
  renderHTML({ node }) {
    const checked = node.attrs['checked'] === true;
    return [
      'div',
      todoRowAttributes(node.attrs),
      ['span', todoBoxAttributes(checked)],
      ['span', { ...TODO_TEXT_ATTRIBUTES }, 0],
    ];
  },
  addNodeView() {
    return (props) => createTaskItemView(props);
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => handleTodoEnter(this.editor),
      Backspace: () => handleTodoBackspace(this.editor),
      ArrowLeft: () => handleTodoArrowLeft(this.editor),
    };
  },
});

/** The caret's todo row, only when it sits in the row's first paragraph. */
interface TaskItemContext {
  item: PmNode;
  itemPos: number;
  list: PmNode;
  listPos: number;
  index: number;
}

/** Locate the todo row around the current caret. */
function taskItemContext(state: EditorState): TaskItemContext | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  for (let depth = $from.depth; depth > 1; depth -= 1) {
    if ($from.node(depth).type.name !== 'taskItem') continue;
    // Only the row's first paragraph is the frozen "todo text" line; Enter in a
    // nested block keeps the browser default.
    if (
      $from.depth !== depth + 1 ||
      $from.index(depth) !== 0 ||
      $from.parent.type.name !== 'paragraph'
    ) {
      return null;
    }
    const list = $from.node(depth - 1);
    if (list.type.name !== 'taskList') return null;
    return {
      item: $from.node(depth),
      itemPos: $from.before(depth),
      list,
      listPos: $from.before(depth - 1),
      index: $from.index(depth - 1),
    };
  }
  return null;
}

/** Node types a new todo row is built from. */
function todoTypes(
  state: EditorState,
): { item: PmNode['type']; paragraph: PmNode['type']; list: PmNode['type'] } | null {
  const item = state.schema.nodes['taskItem'];
  const paragraph = state.schema.nodes['paragraph'];
  const list = state.schema.nodes['taskList'];
  if (item === undefined || paragraph === undefined || list === undefined) {
    return null;
  }
  return { item, paragraph, list };
}

/**
 * Enter on a todo row (frozen `E:1838-1868`).
 *
 * A row holding text continues as a new todo row below (caret moves into it); an
 * empty row turns back into an ordinary paragraph so the line can be typed
 * normally again.
 */
function handleTodoEnter(editor: Editor): boolean {
  const { state, view } = editor;
  const context = taskItemContext(state);
  if (context === null) return false;
  const types = todoTypes(state);
  if (types === null) return false;
  const first = context.item.firstChild;
  const { tr } = state;
  if (first !== null && (first.textContent ?? '').trim() !== '') {
    const row = types.item.create(
      { id: null, checked: false },
      types.paragraph.create({ id: null }, null),
    );
    const rowPos = context.itemPos + context.item.nodeSize;
    tr.insert(rowPos, row);
    tr.setSelection(TextSelection.create(tr.doc, rowPos + 2));
    view.dispatch(tr);
    return true;
  }
  // Empty row: retire only the checkbox, keeping the line box in place.
  return retireEmptyTodoRow(editor, context);
}

/**
 * Retire one empty todo row into an empty paragraph, in place.
 *
 * Shared by Enter (frozen behavior) and Backspace (product 2026-11-12): the row
 * leaves the task list, the list splits around the paragraph, a single-row list
 * collapses to the paragraph, and the caret lands at the paragraph's start.
 * Nested blocks the row carried follow the paragraph and are never dropped.
 */
function retireEmptyTodoRow(editor: Editor, context: TaskItemContext): boolean {
  const { state, view } = editor;
  const types = todoTypes(state);
  if (types === null) return false;
  // The paragraph inherits the row's block id, so comment anchors and the
  // frozen `data-block-id` identity survive the checkbox removal.
  const paragraph = types.paragraph.create(
    { id: context.item.attrs['id'] ?? null },
    null,
  );
  const nested: PmNode[] = [];
  context.item.forEach((child, _offset, index) => {
    if (index > 0) nested.push(child);
  });
  const replacement = retireRowReplacement(context, types, paragraph, nested);
  const tr = state.tr;
  tr.replaceWith(
    context.listPos,
    context.listPos + context.list.nodeSize,
    Fragment.fromArray(replacement.nodes),
  );
  tr.setSelection(
    TextSelection.create(tr.doc, context.listPos + replacement.caretOffset),
  );
  view.dispatch(tr);
  return true;
}

/**
 * Nodes that replace one row's list when the row leaves the list.
 *
 * A row can only live inside a task list, so retiring one splits the list into
 * `[rows before] empty paragraph [rows after]`; a single-row list collapses to
 * just the paragraph. Returns the replacement nodes and the paragraph's offset
 * from the list start (for caret placement).
 */
function retireRowReplacement(
  context: TaskItemContext,
  types: NonNullable<ReturnType<typeof todoTypes>>,
  paragraph: PmNode,
  nested: readonly PmNode[],
): { nodes: PmNode[]; caretOffset: number } {
  const before: PmNode[] = [];
  const after: PmNode[] = [];
  context.list.forEach((child, _offset, index) => {
    if (index < context.index) before.push(child);
    if (index > context.index) after.push(child);
  });
  const nodes: PmNode[] = [];
  let caretOffset = 0;
  if (before.length > 0) {
    nodes.push(
      types.list.create({ id: context.list.attrs['id'] ?? null }, Fragment.fromArray(before)),
    );
  }
  caretOffset = nodes.reduce((size, node) => size + node.nodeSize, 0);
  nodes.push(paragraph, ...nested);
  caretOffset += 1;
  if (after.length > 0) {
    nodes.push(types.list.create({ id: null }, Fragment.fromArray(after)));
  }
  return { nodes, caretOffset };
}

/** End position of the previous editable line before `pos`, if any. */
function previousTextblockEnd(state: EditorState, pos: number): number | null {
  let found: number | null = null;
  let cursor = 0;
  for (let index = 0; index < state.doc.childCount; index += 1) {
    const child = state.doc.child(index);
    if (cursor >= pos) break;
    if (child.isTextblock) found = cursor + child.content.size + 1;
    cursor += child.nodeSize;
  }
  return found;
}

/**
 * Backspace in an empty todo row: remove only the checkbox.
 *
 * Product requirement (2026-11-12, overriding the frozen "delete the row and
 * jump to the previous line" baseline): the first Backspace turns the row into
 * an empty paragraph in place (a task list splits around it, a single-row list
 * collapses), with the caret at the paragraph's start. The second Backspace is
 * handled by the kernel's generic "empty paragraph after a list" rule, which
 * parks the caret at the end of the previous line without merging nodes.
 *
 * Rows holding text keep the default backward-merge behavior.
 */
function handleTodoBackspace(editor: Editor): boolean {
  const { state } = editor;
  const context = taskItemContext(state);
  if (context === null) return false;
  const { $from } = state.selection;
  if ($from.parentOffset !== 0) return false;
  const first = context.item.firstChild;
  if (first === null || first.content.size !== 0) return false;
  return retireEmptyTodoRow(editor, context);
}

/**
 * ArrowLeft at the start of a todo text line (frozen `E:1560-1571`).
 *
 * The caret jumps to the previous line; on the first document block it stays
 * where it is (`preventDefault` without moving).
 */
function handleTodoArrowLeft(editor: Editor): boolean {
  const { state, view } = editor;
  const context = taskItemContext(state);
  if (context === null) return false;
  const { $from } = state.selection;
  if ($from.parentOffset !== 0) return false;
  const { tr } = state;
  if (context.index > 0) {
    const previous = context.list.child(context.index - 1);
    const previousPos = context.itemPos - previous.nodeSize;
    const previousFirst = previous.firstChild;
    const end =
      previousFirst === null
        ? previousPos + 2
        : previousPos + 2 + previousFirst.content.size;
    tr.setSelection(TextSelection.create(tr.doc, end));
    view.dispatch(tr);
    return true;
  }
  const previousLine = previousTextblockEnd(state, context.listPos);
  if (previousLine === null) return true;
  tr.setSelection(TextSelection.create(tr.doc, previousLine));
  view.dispatch(tr);
  return true;
}

/**
 * Convert the block at the caret into a one-row todo list (and back).
 *
 * Shared by the `/` menu's 待办 command and the toolbar's 文本类型 menu; the
 * frozen editor converts the current line in place, which is what this does.
 */
function toggleTaskListAtSelection(
  state: EditorState,
  tr: EditorState['tr'],
  dispatch: ((transaction: EditorState['tr']) => void) | undefined,
): boolean {
  const types = todoTypes(state);
  if (types === null) return false;
  const { $from } = state.selection;

  // Already in a todo: flatten every row back into normal blocks.
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'taskList') continue;
    const list = $from.node(depth);
    const listPos = $from.before(depth);
    const blocks: PmNode[] = [];
    let caretOffset: number | null = null;
    let outputSize = 0;
    let itemPos = listPos + 1;
    list.forEach((item) => {
      let childPos = itemPos + 1;
      item.forEach((child) => {
        if (
          caretOffset === null &&
          $from.pos >= childPos &&
          $from.pos <= childPos + child.nodeSize
        ) {
          caretOffset = outputSize + ($from.pos - childPos);
        }
        blocks.push(child);
        outputSize += child.nodeSize;
        childPos += child.nodeSize;
      });
      itemPos += item.nodeSize;
    });
    const caret =
      caretOffset === null
        ? Math.min(listPos + 1, tr.doc.content.size)
        : Math.min(listPos + caretOffset, tr.doc.content.size);
    tr.replaceWith(listPos, listPos + list.nodeSize, Fragment.fromArray(blocks));
    tr.setSelection(TextSelection.create(tr.doc, caret));
    dispatch?.(tr);
    return true;
  }

  // Wrap the top-level textblock at the caret into a one-row todo list.
  if ($from.depth < 1) return false;
  const block = $from.node(1);
  if (!block.isTextblock || block.type.name === 'codeBlock') return false;
  const start = $from.before(1);
  const offset = $from.parentOffset;
  const paragraph = types.paragraph.create(
    { id: block.attrs['id'] ?? null },
    block.content,
  );
  const row = types.item.create({ id: null, checked: false }, paragraph);
  const list = types.list.create({ id: null }, row);
  tr.replaceWith(start, start + block.nodeSize, list);
  tr.setSelection(TextSelection.create(tr.doc, start + 3 + offset));
  dispatch?.(tr);
  return true;
}

/**
 * Callout container: its children are real blocks, unlike the atom cards.
 *
 * The frozen UI has no callout visual; it renders as a neutral
 * `div[data-object-card]` so content is never hidden.
 */
const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block*',
  defining: true,
  addAttributes() {
    return attributesOf(NODE_MANIFEST['callout']!, DATA_SOURCE['callout']);
  },
  parseHTML() {
    return [{ tag: 'div[data-object-card][data-kind="callout"]' }];
  },
  renderHTML({ node }) {
    return calloutSpec(node.attrs);
  },
});

/**
 * Bridge one editor node's `prosemirror-tables` role into its schema spec.
 *
 * Tiptap's own table extensions carry the role through `extendNodeSchema`, and
 * that hook runs for **every** node extension, so the returned object must be
 * keyed by the node it is meant for.
 */
function tableRole(
  name: string,
  role: 'table' | 'row' | 'header_cell' | 'cell',
): { extendNodeSchema(extension: { name: string }): Record<string, unknown> } {
  return {
    extendNodeSchema(extension) {
      return extension.name === name ? { tableRole: role } : {};
    },
  };
}

/** Render the stable block id on a table part (`data-block-id`). */
function blockIdAttributes(node: PmNode): Record<string, string> {
  const id = node.attrs['id'];
  return typeof id === 'string' && id !== ''
    ? { 'data-block-id': id }
    : {};
}

/**
 * HTML attributes of one table cell: the block id plus merged-cell spans.
 *
 * Spans are only emitted when they change the grid (`> 1`), matching the AST
 * contract where `1` is implicit: a plain table must not render
 * `colspan="1" rowspan="1"` noise into the frozen DOM or the serialized HTML.
 */
function cellAttributes(node: PmNode): Record<string, string> {
  const attrs = blockIdAttributes(node);
  for (const name of ['colspan', 'rowspan'] as const) {
    const value = node.attrs[name];
    if (typeof value === 'number' && Number.isInteger(value) && value > 1) {
      attrs[name] = String(value);
    }
  }
  return attrs;
}

/**
 * The frozen table node: a bare `<table data-block-id>`.
 *
 * Tiptap's table extension is kept for its commands (`insertTable`,
 * `deleteTable`, …) but its `TableView` node view is switched off: it wraps the
 * table in an unstyled `.tableWrapper` div, while the frozen DOM has the table
 * itself as the block.
 */
export const KernelTable: AnyExtension = Table.configure({
  resizable: false,
  View: null,
}).extend({
  ...tableRole('table', 'table'),
  addAttributes() {
    return { id: BLOCK_ID_ATTRIBUTE };
  },
  // The frozen editor implements Tab navigation itself and never creates a row
  // at the last cell; the stock table bindings would add one, so drop them and
  // let the kernel's keymap (`keyboard.ts`) own the frozen behavior.
  addKeyboardShortcuts() {
    return {};
  },
  parseHTML() {
    return [{ tag: 'table' }];
  },
  renderHTML({ node }) {
    return ['table', blockIdAttributes(node), 0];
  },
});

/**
 * One table row (`tr[data-block-id]`); header cells and body cells are mixed.
 *
 * The row may be empty: merging cells vertically deletes the covered cells from
 * the rows below (the surviving cell's `rowspan` covers them), which is the
 * document shape ProseMirror's table model produces. The AST allows an empty
 * `tableRow` for the same reason.
 */
export const KernelTableRow: AnyExtension = Node.create({
  name: 'tableRow',
  content: '(tableHeader | tableCell)*',
  ...tableRole('tableRow', 'row'),
  addAttributes() {
    return { id: BLOCK_ID_ATTRIBUTE };
  },
  parseHTML() {
    return [{ tag: 'tr' }];
  },
  renderHTML({ node }) {
    return ['tr', blockIdAttributes(node), 0];
  },
});

/** One header cell (`th[data-block-id]`). */
export const KernelTableHeader: AnyExtension = Node.create({
  name: 'tableHeader',
  content: 'block+',
  isolating: true,
  defining: true,
  ...tableRole('tableHeader', 'header_cell'),
  addAttributes() {
    return {
      id: BLOCK_ID_ATTRIBUTE,
      // Kept in the node attrs (convert reads them) but rendered manually and
      // only when > 1, so a plain table never gains `colspan="1" rowspan="1"`.
      colspan: { default: 1, rendered: false },
      rowspan: { default: 1, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'th' }];
  },
  renderHTML({ node }) {
    return ['th', cellAttributes(node), 0];
  },
});

/** One body cell (`td[data-block-id]`). */
export const KernelTableCell: AnyExtension = Node.create({
  name: 'tableCell',
  content: 'block+',
  isolating: true,
  defining: true,
  ...tableRole('tableCell', 'cell'),
  addAttributes() {
    return {
      id: BLOCK_ID_ATTRIBUTE,
      // Same rule as the header cell: stored on the node, rendered only when > 1.
      colspan: { default: 1, rendered: false },
      rowspan: { default: 1, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'td' }];
  },
  renderHTML({ node }) {
    return ['td', cellAttributes(node), 0];
  },
});

/** DOM tag for one AST mark, matching the frozen stylesheet. */
const MARK_TAG: Readonly<Record<string, string>> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
  highlight: 'mark',
  link: 'a',
};

/**
 * One inline mark whose DOM tag the frozen stylesheet already styles.
 *
 * Tiptap builds the ProseMirror mark spec from `addAttributes()`, so the link's
 * `href` must be declared there — setting `attrs` directly is ignored and the
 * attribute never reaches the document (it would silently render `href=""`).
 *
 * A link also carries `data-web-link=""`: the frozen editor renders plain
 * anchors with it (the link bar and the click handler both key off it) and the
 * AST has no extra attribute for it.
 */
function markExtension(name: (typeof MARK_ORDER)[number]): AnyExtension {
  const tag = MARK_TAG[name]!;
  const isLink = name === 'link';
  return Mark.create({
    name,
    ...(name === 'code' ? { excludes: '_' } : {}),
    ...(isLink
      ? {
          inclusive: false,
          addAttributes() {
            return {
              href: {
                default: null,
                parseHTML: (element: HTMLElement): string | null =>
                  element.getAttribute('href'),
                renderHTML: (attrs: Record<string, unknown>): Record<string, string> => {
                  const href = attrs['href'];
                  return typeof href === 'string' && href !== '' ? { href } : {};
                },
              },
            };
          },
        }
      : {}),
    parseHTML() {
      return [{ tag: isLink ? 'a[href]' : tag }];
    },
    renderHTML({ HTMLAttributes }) {
      return isLink
        ? [
            tag,
            mergeLinkAttributes(HTMLAttributes),
            0,
          ]
        : [tag, HTMLAttributes, 0];
    },
  });
}

/** Add `data-web-link` to a rendered link's attribute map. */
function mergeLinkAttributes(
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  return { ...attributes, 'data-web-link': '' };
}

/** Options the page passes into the kernel's node set. */
export interface ManifestExtensionOptions {
  /** Open a web link (card or inline) in the host browser. */
  onOpenWeb?: (url: string) => void;
  /** Navigate to an in-app document link. */
  onOpenDoc?: (docId: string) => void;
  /** Map a document id to its in-app path (doc-link card `href`). */
  docPath?: (docId: string) => string;
  /** Archived state of a document id (doc-link card badge). */
  resolveDoc?: (docId: string) => { archived: boolean } | undefined;
}

/** Default in-app path of a doc-link card (frozen loader fallback). */
function defaultDocPath(docId: string): string {
  return `#/space/doc/${docId}`;
}

/** Open a URL the way the frozen editor does when no host callback is wired. */
function openExternal(url: string): void {
  if (url === '') return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Activate one card from the keyboard (frozen `E:1976-1991`). */
function activateCard(card: HTMLElement, options: ManifestExtensionOptions): void {
  if (card.hasAttribute('data-doc-link')) {
    options.onOpenDoc?.(card.getAttribute('data-doc-id') ?? '');
    return;
  }
  const url =
    card.getAttribute('data-href') ?? card.getAttribute('href') ?? '';
  if (url === '') return;
  if (options.onOpenWeb !== undefined) {
    options.onOpenWeb(url);
    return;
  }
  openExternal(url);
}

/**
 * Keyboard activation for focusable cards and inline links.
 *
 * Clicking is the page's overlay's business, but Enter/Space on a focused card
 * must open it even though a non-editable atom receives no ProseMirror
 * selection: the frozen editor handles both keys on `[data-file]`/`[data-link-card]`/
 * `[data-doc-link]`.
 */
function createCardKeyboardExtension(
  options: ManifestExtensionOptions,
): AnyExtension {
  return Extension.create({
    name: 'alterSpaceCardKeyboard',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handleDOMEvents: {
              keydown: (_view, event): boolean => {
                const keyboard = event as KeyboardEvent;
                if (keyboard.isComposing) return false;
                if (keyboard.key !== 'Enter' && keyboard.key !== ' ') {
                  return false;
                }
                const target = keyboard.target;
                if (!(target instanceof HTMLElement)) return false;
                const card = target.closest<HTMLElement>(
                  '[data-file], a[data-link-card], a[data-doc-link], a[data-web-link]',
                );
                if (card === null) return false;
                keyboard.preventDefault();
                activateCard(card, options);
                return true;
              },
            },
          },
        }),
      ];
    },
  });
}

/**
 * Create the frozen archived badge element for a doc-link card.
 *
 * The frozen stylesheet styles `a[data-doc-link][data-archived]` and the
 * `[data-doc-archived-icon]` wrapper; the SVG mirrors the frozen icon markup so
 * an archived link is recognizable without opening it.
 */
function createArchivedBadge(): HTMLElement {
  const badge = document.createElement('span');
  badge.setAttribute('data-doc-archived-icon', '');
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', '已归档');
  badge.setAttribute('contenteditable', 'false');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [name, value] of Object.entries({
    width: '20',
    height: '5',
    x: '2',
    y: '3',
    rx: '1',
  })) {
    rect.setAttribute(name, value);
  }
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8');
  const handle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  handle.setAttribute('d', 'M10 12h4');
  svg.append(rect, body, handle);
  badge.append(svg);
  return badge;
}

/** Paint the archived state of every doc-link card in the body. */
function paintDocLinkBadges(
  view: EditorView,
  options: ManifestExtensionOptions,
): void {
  for (const link of view.dom.querySelectorAll<HTMLAnchorElement>(
    'a[data-doc-link]',
  )) {
    const docId = link.getAttribute('data-doc-id') ?? '';
    const info = options.resolveDoc?.(docId);
    if (info?.archived === true) {
      link.setAttribute('data-archived', '');
      if (link.querySelector('[data-doc-archived-icon]') === null) {
        link.append(createArchivedBadge());
      }
      continue;
    }
    link.removeAttribute('data-archived');
    link.querySelector('[data-doc-archived-icon]')?.remove();
  }
}

/**
 * Keep doc-link archived badges in sync with the page's document catalog.
 *
 * Archived state lives on the page (the node list), not in the AST, so a card
 * re-render can never own it; this view-level pass re-applies it after every
 * update.
 */
function createDocLinkBadgeExtension(
  options: ManifestExtensionOptions,
): AnyExtension {
  return Extension.create({
    name: 'alterSpaceDocLinkBadges',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          view(view) {
            const paint = (): void => paintDocLinkBadges(view, options);
            paint();
            return { update: () => paint() };
          },
        }),
      ];
    },
  });
}

/**
 * Every extension this kernel adds to the native Tiptap set.
 *
 * @param documentAssetUrl maps a stored `asset_…` id to a servable URL.
 * @param options page callbacks the cards need (open web/doc links).
 */
export function manifestExtensions(
  documentAssetUrl: (assetId: string) => string,
  options: ManifestExtensionOptions = {},
): AnyExtension[] {
  const context: CardRenderContext = {
    documentAssetUrl,
    docPath: options.docPath ?? defaultDocPath,
  };
  const atoms = Object.values(NODE_MANIFEST)
    .filter((entry) => ATOM_TYPES.has(entry.type))
    .map((entry) => atomNode(entry, context));
  return [
    Divider,
    ...atoms,
    TaskList,
    TaskItemNode,
    Callout,
    KernelTableRow,
    KernelTableHeader,
    KernelTableCell,
    ...MARK_ORDER.map((name) => markExtension(name)),
    createCardKeyboardExtension(options),
    createDocLinkBadgeExtension(options),
  ];
}

/**
 * Node names this module owns (the kernel asserts coverage in tests).
 *
 * `table`, `tableRow`, `tableCell` and `tableHeader` come from the Tiptap table
 * extensions; they are listed so the coverage check can prove every registry
 * block has exactly one extension (and the capture knows the header cells).
 */
export const MANIFEST_NODE_NAMES: readonly string[] = [
  'divider',
  ...ATOM_TYPES,
  'taskList',
  'taskItem',
  'callout',
  'table',
  'tableHeader',
  'tableRow',
  'tableCell',
];

/** Native node names the kernel relies on Tiptap for. */
export const NATIVE_NODE_NAMES: readonly string[] = [...NATIVE];

/** Marks the kernel declares (must equal the AST mark order). */
export const MANIFEST_MARK_NAMES: readonly string[] = MARK_ORDER;

/** Read the link target of one ProseMirror mark. */
export function linkHrefOf(mark: PmMark): string | undefined {
  const href = mark.attrs['href'];
  return typeof href === 'string' && href !== '' ? href : undefined;
}