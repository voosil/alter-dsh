/**
 * Link and table action bars for the AST-native kernel.
 *
 * Both bars are the frozen editor's dark `.linkBar` (the stylesheet class comes
 * from {@link KERNEL_CLASS}, because the frozen CSS is CSS Modules and a
 * literal class name would never match). Frozen behaviour
 * (`docs/acceptance/editor-experience-p0-p6.md` §2):
 *
 * - **链接操作** appears above `a[data-web-link]` / `[data-link-card]` on hover
 *   or focus, offers 转为卡片/转为行内 plus 编辑, hides 180ms after the pointer
 *   leaves the body (and immediately when a link is opened or edited);
 * - **表格操作** appears above a hovered table, offers 选中 first and then
 *   上移 / 下移 / 删除 once the table is the selected block;
 * - clicking a card / inline link / document link / file card activates it
 *   (the page owns browser integration through the callbacks below);
 * - moving and deleting a table change the document through a ProseMirror
 *   transaction, so the kernel's normal update/save path runs.
 *
 * Nothing here writes `data-selected` for dividers or images: that state
 * machine lives in `block-selection.ts` and both bars read it.
 *
 * @module @alter-dsh/space/document/editors/tiptap/overlays
 */
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { TextSelection, type Selection as PmSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { allocateBlockId } from './convert';
import {
  blockSelectionOf,
  resolveEditorView,
  type EditorTarget,
} from './block-selection';
import { KERNEL_CLASS } from './classes';

/** Delay before a bar hides after the pointer leaves (frozen 180ms). */
const HIDE_DELAY_MS = 180;

/** One overlay bar over a document target. */
export interface OverlayBar {
  element: HTMLElement;
  /** Re-measure and re-render the bar for the current state. */
  update(): void;
  /** Hide the bar immediately (an already scheduled shared hide is unaffected). */
  hide(): void;
  destroy(): void;
}

/** What the link bar reports to the page. */
export interface LinkOverlayHandlers {
  /** The document changed (card ⇄ inline conversion or a write-back). */
  onChange?(): void;
  /** The user asked to edit the hovered link's fields. */
  onEdit?(detail: {
    kind: 'card' | 'inline';
    href: string;
    pos: number;
    /** Display text (anchor text / card title); never empty, falls back to href. */
    label: string;
  }): void;
  /** Open a web URL (the page owns browser integration; `window.open` fallback). */
  onOpenWeb?(url: string): void;
  /** Navigate to another document in-app (the page owns its router). */
  onOpenDoc?(docId: string): void;
}

/** The link overlay additionally applies the page's dialog result. */
export interface LinkOverlayBar extends OverlayBar {
  /**
   * Write one edited link back into the document.
   *
   * `pos` is the position reported by `onEdit`; the node/mark is re-resolved
   * there so an intervening edit cannot make the write land on the wrong link.
   */
  applyEdit(input: {
    kind: 'card' | 'inline';
    pos: number;
    href: string;
    label: string;
  }): void;
}

/** Handles registered per editor view so IME/focus code can hide every bar. */
interface OverlayHandle {
  hide(): void;
}

const barsByView = new WeakMap<EditorView, Set<OverlayHandle>>();

/**
 * One hide timer per editor view.
 *
 * The frozen editor shares a single timer between both bars: leaving the body
 * or either bar hides both, entering either bar keeps both. Reproducing that
 * coupling here keeps the two overlays behaving as one surface.
 */
const hideTimers = new WeakMap<EditorView, number>();

function cancelPendingHide(view: EditorView): void {
  const timer = hideTimers.get(view);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  hideTimers.delete(view);
}

function schedulePendingHide(view: EditorView): void {
  cancelPendingHide(view);
  const timer = window.setTimeout(() => {
    hideTimers.delete(view);
    const handles = barsByView.get(view);
    if (handles === undefined) return;
    for (const handle of [...handles]) handle.hide();
  }, HIDE_DELAY_MS);
  hideTimers.set(view, timer);
}

/** Hide every body-level action bar of one editor (frozen clearFloatingUi). */
export function closeOverlayBars(target: EditorTarget): void {
  const view = resolveEditorView(target);
  cancelPendingHide(view);
  const handles = barsByView.get(view);
  if (handles === undefined) return;
  for (const handle of [...handles]) handle.hide();
}

function registerBar(view: EditorView, handle: OverlayHandle): void {
  const handles = barsByView.get(view) ?? new Set<OverlayHandle>();
  handles.add(handle);
  barsByView.set(view, handles);
}

function unregisterBar(view: EditorView, handle: OverlayHandle): void {
  barsByView.get(view)?.delete(handle);
}

/** The frozen metadata rule: known titles are absent, host name is the title. */
function webMetadata(url: string): { title: string; description: string } {
  try {
    const parsed = new URL(url);
    return { title: parsed.hostname.replace(/^www\./u, ''), description: url };
  } catch {
    return { title: url, description: url };
  }
}

/** True for the only URL shape the frozen editor opens (`http`/`https`). */
function isWebUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/iu.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Clamp one bar above a target rectangle (frozen per-bar constants). */
function placeBar(
  element: HTMLElement,
  rect: DOMRect,
  reservedWidth: number,
  lift: number,
): void {
  element.style.position = 'fixed';
  element.style.left = `${Math.min(
    Math.max(12, rect.left),
    Math.max(12, window.innerWidth - reservedWidth),
  )}px`;
  element.style.top = `${Math.max(10, rect.top - lift)}px`;
}

/** Build the dark bar shell with the frozen role/label pair. */
function createBar(ariaLabel: string): HTMLElement {
  const element = document.createElement('div');
  element.className = KERNEL_CLASS.linkBar;
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', ariaLabel);
  element.style.display = 'none';
  // Keep the caret while pressing a button (frozen `E:2737`): moving focus to
  // a button would blur the editable body and drop the block selection.
  element.addEventListener('mousedown', (event) => event.preventDefault());
  return element;
}

/** One bar button: visible label, aria-label and title can differ (frozen). */
function barButton(spec: {
  text: string;
  ariaLabel: string;
  title?: string;
  /** Unavailable table action: kept visible but not pressable. */
  disabled?: boolean;
  /** Toggle state (table header switch): exposed as `data-active` + aria-pressed. */
  active?: boolean;
  /** Stable hook for tests and diagnostics (never styled). */
  action?: string;
  onPress(): void;
}): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = spec.text;
  element.setAttribute('aria-label', spec.ariaLabel);
  element.title = spec.title ?? spec.ariaLabel;
  if (spec.disabled === true) element.disabled = true;
  if (spec.action !== undefined) element.dataset['tableAction'] = spec.action;
  if (spec.active !== undefined) {
    element.dataset['active'] = spec.active ? 'true' : 'false';
    element.setAttribute('aria-pressed', spec.active ? 'true' : 'false');
  }
  element.addEventListener('click', spec.onPress);
  return element;
}

// ---------------------------------------------------------------------------
// Link targets
// ---------------------------------------------------------------------------

/** One contiguous text run carrying the same link mark. */
interface LinkRun {
  from: number;
  to: number;
  href: string;
}

/** Every contiguous link-mark run of the document, in document order. */
function collectLinkRuns(doc: PmNode): LinkRun[] {
  const runs: LinkRun[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const link = node.marks.find((mark) => mark.type.name === 'link');
    if (link === undefined) return true;
    const href = link.attrs['href'];
    if (typeof href !== 'string' || href === '') return true;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.to === pos && last.href === href) {
      last.to = pos + node.nodeSize;
    } else {
      runs.push({ from: pos, to: pos + node.nodeSize, href });
    }
    return true;
  });
  return runs;
}

/** The link-mark run rendered by one inline anchor. */
function linkRunAtElement(view: EditorView, anchor: HTMLElement): LinkRun | null {
  let raw: number;
  try {
    raw = view.posAtDOM(anchor, 0);
  } catch {
    return null;
  }
  if (raw < 0) return null;
  const runs = collectLinkRuns(view.state.doc);
  return (
    runs.find((run) => run.from <= raw && raw < run.to) ??
    runs.find((run) => run.from >= raw) ??
    null
  );
}

/**
 * The inline web-link anchor for one hovered/clicked element.
 *
 * The frozen editor only shows the link bar for `a[data-web-link]` and
 * `[data-link-card]` (never a bare `a[href]` or an in-app document link); the
 * AST's link mark renders exactly that marker.
 */
function inlineAnchorOf(target: HTMLElement): HTMLElement | null {
  const anchor = target.closest('a[data-web-link]');
  return anchor instanceof HTMLElement ? anchor : null;
}

/** The web-link card (`a[data-link-card]`) containing one element. */
function cardOf(target: HTMLElement): HTMLElement | null {
  const card = target.closest('[data-link-card]');
  return card instanceof HTMLElement ? card : null;
}

/** The URL a web-link card points at (frozen stored it as `data-link-card`). */
function cardUrl(card: HTMLElement): string {
  const value =
    card.getAttribute('data-href') ??
    card.getAttribute('href') ??
    card.getAttribute('data-link-card') ??
    '';
  return value.trim();
}

/** The card title (frozen card DOM: `strong` title + `span` description). */
function cardLabel(card: HTMLElement): string {
  return (card.querySelector('strong')?.textContent ?? '').trim();
}

/** Document position of the bookmark node rendered by one card element. */
function bookmarkPositionOf(view: EditorView, card: HTMLElement): number | null {
  const doc = view.state.doc;
  let raw: number;
  try {
    raw = view.posAtDOM(card, 0);
  } catch {
    return null;
  }
  if (doc.nodeAt(raw)?.type.name === 'bookmark') return raw;
  const $raw = doc.resolve(raw);
  if ($raw.depth >= 1) {
    const before = $raw.before(1);
    if (doc.nodeAt(before)?.type.name === 'bookmark') return before;
  }
  return null;
}

/** One link the bar can act on. */
interface LinkTarget {
  element: HTMLElement;
  kind: 'card' | 'inline';
  href: string;
  pos: number;
  label: string;
}

/** Resolve the link under one element, if the bar applies to it. */
function resolveLinkTarget(
  view: EditorView,
  target: HTMLElement,
): LinkTarget | null {
  const card = cardOf(target);
  if (card !== null) {
    const href = cardUrl(card);
    const pos = bookmarkPositionOf(view, card);
    if (href === '' || pos === null) return null;
    return { element: card, kind: 'card', href, pos, label: cardLabel(card) };
  }
  const anchor = inlineAnchorOf(target);
  if (anchor === null) return null;
  const href = (anchor.getAttribute('href') ?? '').trim();
  const run = linkRunAtElement(view, anchor);
  if (href === '' || run === null) return null;
  return {
    element: anchor,
    kind: 'inline',
    href: run.href === '' ? href : run.href,
    pos: run.from,
    label: view.state.doc.textBetween(run.from, run.to, ' '),
  };
}

// ---------------------------------------------------------------------------
// Link bar
// ---------------------------------------------------------------------------

/**
 * Create the link bar: card ⇄ inline conversion, edit, and link activation.
 *
 * The two AST shapes are a `bookmark` block (card) and a `link` mark (inline).
 * An inline link is converted by splitting its paragraph around the link run
 * (the AST has no block-level card inside a paragraph), which is the closest
 * expressible form of the frozen in-place replacement.
 */
export function createLinkOverlay(
  editor: Editor,
  handlers: LinkOverlayHandlers = {},
): LinkOverlayBar {
  const view = editor.view;
  const element = createBar('链接操作');
  let hovered: LinkTarget | null = null;

  function render(): void {
    element.replaceChildren();
    const target = hovered;
    if (target === null || !target.element.isConnected) {
      element.style.display = 'none';
      return;
    }
    element.style.display = '';
    // Frozen link-bar placement: clamp into the viewport, sit 42px above.
    placeBar(element, target.element.getBoundingClientRect(), 260, 42);
    const isCard = target.kind === 'card';
    element.append(
      barButton({
        text: isCard ? '转为行内' : '转为卡片',
        ariaLabel: isCard ? '转为行内链接' : '转为卡片链接',
        onPress: () => convert(),
      }),
      barButton({
        text: '编辑',
        ariaLabel: '编辑链接',
        onPress: () => edit(),
      }),
    );
  }

  function show(target: LinkTarget): void {
    cancelPendingHide(view);
    if (
      hovered !== null &&
      hovered.element === target.element &&
      hovered.kind === target.kind
    ) {
      return;
    }
    hovered = target;
    render();
  }

  function hide(): void {
    hovered = null;
    render();
  }

  function scheduleHide(): void {
    schedulePendingHide(view);
  }

  /** Open a URL through the page's browser integration, or a new tab. */
  function openWeb(url: string): void {
    const value = url.trim();
    if (!isWebUrl(value)) return;
    if (handlers.onOpenWeb !== undefined) {
      handlers.onOpenWeb(value);
      return;
    }
    window.open(value, '_blank', 'noopener,noreferrer');
  }

  /** Frozen click activation (§3.4): cards, inline links, doc links, files. */
  function activate(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const card = cardOf(target);
    if (card !== null) {
      const url = cardUrl(card);
      if (url === '') return;
      event.preventDefault();
      hide();
      openWeb(url);
      return;
    }
    const anchor = inlineAnchorOf(target);
    if (anchor !== null) {
      const url = (anchor.getAttribute('href') ?? '').trim();
      if (url === '') return;
      event.preventDefault();
      hide();
      openWeb(url);
      return;
    }
    const docLink = target.closest('[data-doc-link]');
    if (docLink instanceof HTMLElement) {
      const docId = (
        docLink.getAttribute('data-doc-id') ??
        docLink.getAttribute('data-doc-link') ??
        ''
      ).trim();
      if (docId === '') return;
      event.preventDefault();
      hide();
      handlers.onOpenDoc?.(docId);
      return;
    }
    const file = target.closest('[data-file]');
    if (file instanceof HTMLElement) {
      const href = (file.getAttribute('data-href') ?? '').trim();
      if (href === '') return;
      event.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  }

  /** Replace the inline link run with a bookmark block (card). */
  function convertInlineToCard(run: LinkRun): void {
    const doc = view.state.doc;
    const $from = doc.resolve(run.from);
    if (!$from.parent.isTextblock) return;
    const block = $from.parent;
    const depth = $from.depth;
    const blockStart = $from.before(depth);
    const localFrom = run.from - blockStart - 1;
    const localTo = run.to - blockStart - 1;
    const cardType = doc.type.schema.nodes['bookmark'];
    if (cardType === undefined) return;
    const label = doc.textBetween(run.from, run.to, ' ').trim();
    const metadata = webMetadata(run.href);
    const card = cardType.create({
      id: allocateBlockId(),
      url: run.href,
      // The frozen conversion keeps the anchor text as the card title.
      title: label === '' ? metadata.title : label,
      description: metadata.description,
    });
    const before = block.content.cut(0, localFrom);
    const after = block.content.cut(localTo);
    const replacement: PmNode[] = [];
    if (before.size > 0) {
      replacement.push(block.type.create(block.attrs, before, block.marks));
    }
    const cardIndex = replacement.length;
    replacement.push(card);
    if (after.size > 0) {
      replacement.push(
        block.type.create(
          { ...block.attrs, id: allocateBlockId() },
          after,
          block.marks,
        ),
      );
    }
    const tr = view.state.tr.replaceWith(
      blockStart,
      blockStart + block.nodeSize,
      replacement,
    );
    let cardPos = blockStart;
    for (let index = 0; index < cardIndex; index += 1) {
      cardPos += replacement[index]!.nodeSize;
    }
    if (replacement.length > cardIndex + 1) {
      // Keep writing in the paragraph after the card.
      tr.setSelection(
        TextSelection.create(tr.doc, cardPos + card.nodeSize + 1),
      );
    } else if (cardIndex > 0) {
      tr.setSelection(TextSelection.create(tr.doc, cardPos - 1));
    }
    view.dispatch(tr);
    view.focus();
  }

  /** Replace the bookmark block with a paragraph holding an inline link. */
  function convertCardToInline(target: LinkTarget): void {
    const doc = view.state.doc;
    const pos = target.pos;
    const node = doc.nodeAt(pos);
    if (node === null || node.type.name !== 'bookmark') return;
    const paragraphType = doc.type.schema.nodes['paragraph'];
    const linkMark = doc.type.schema.marks['link'];
    if (paragraphType === undefined || linkMark === undefined) return;
    const url =
      typeof node.attrs['url'] === 'string' && node.attrs['url'] !== ''
        ? node.attrs['url']
        : target.href;
    const storedTitle =
      typeof node.attrs['title'] === 'string' ? node.attrs['title'] : '';
    const metadata = webMetadata(url);
    // The frozen conversion keeps the card title as the link text.
    const label = storedTitle.trim() === '' ? metadata.title : storedTitle;
    const paragraph = paragraphType.create(
      { id: allocateBlockId() },
      doc.type.schema.text(label, [linkMark.create({ href: url })]),
    );
    const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, paragraph);
    tr.setSelection(TextSelection.create(tr.doc, pos + 1 + label.length));
    view.dispatch(tr);
    view.focus();
  }

  function convert(): void {
    const target = hovered;
    if (target === null) return;
    hide();
    if (target.kind === 'card') {
      convertCardToInline(target);
    } else {
      const run = linkRunAtElement(view, target.element);
      if (run !== null) convertInlineToCard(run);
    }
    handlers.onChange?.();
  }

  function edit(): void {
    const target = hovered;
    if (target === null) return;
    hide();
    const label = target.label.trim() === '' ? target.href : target.label;
    handlers.onEdit?.({
      kind: target.kind,
      href: target.href,
      pos: target.pos,
      label,
    });
  }

  /**
   * Apply the page's link dialog result.
   *
   * A card updates its own attributes in place (ids and siblings untouched) and
   * recomputes its description from the URL, as the frozen save does; an inline
   * link replaces the linked run, keeping the surrounding text.
   */
  function applyEdit(input: {
    kind: 'card' | 'inline';
    pos: number;
    href: string;
    label: string;
  }): void {
    const url = input.href.trim();
    if (url === '') return;
    hide();
    const metadata = webMetadata(url);
    const doc = view.state.doc;
    if (input.kind === 'card') {
      const node = doc.nodeAt(input.pos);
      if (node === null || node.type.name !== 'bookmark') return;
      const label =
        input.label.trim() === '' ? metadata.title : input.label.trim();
      view.dispatch(
        view.state.tr.setNodeMarkup(input.pos, undefined, {
          ...node.attrs,
          url,
          title: label,
          description: metadata.description,
        }),
      );
      handlers.onChange?.();
      return;
    }
    const linkMark = doc.type.schema.marks['link'];
    if (linkMark === undefined) return;
    const runs = collectLinkRuns(doc);
    const run =
      runs.find(
        (candidate) =>
          candidate.from <= input.pos && input.pos < candidate.to,
      ) ?? runs.find((candidate) => candidate.from >= input.pos);
    if (run === undefined) return;
    const label =
      input.label.trim() === '' ? metadata.title : input.label.trim();
    view.dispatch(
      view.state.tr.replaceWith(
        run.from,
        run.to,
        doc.type.schema.text(label, [linkMark.create({ href: url })]),
      ),
    );
    handlers.onChange?.();
  }

  const onMouseOver = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const resolved = resolveLinkTarget(view, target);
    if (resolved !== null) show(resolved);
  };

  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const resolved = resolveLinkTarget(view, target);
    if (resolved !== null) show(resolved);
  };

  const onMouseLeave = (): void => scheduleHide();
  const onClick = (event: MouseEvent): void => activate(event);
  const onBarEnter = (): void => cancelPendingHide(view);
  const onBarLeave = (): void => scheduleHide();

  element.addEventListener('mouseenter', onBarEnter);
  element.addEventListener('mouseleave', onBarLeave);
  view.dom.addEventListener('mouseover', onMouseOver);
  view.dom.addEventListener('focusin', onFocusIn);
  view.dom.addEventListener('mouseleave', onMouseLeave);
  view.dom.addEventListener('click', onClick);
  document.body.append(element);

  const handle: OverlayHandle = { hide };
  registerBar(view, handle);

  return {
    element,
    update: render,
    hide,
    applyEdit,
    destroy() {
      unregisterBar(view, handle);
      view.dom.removeEventListener('mouseover', onMouseOver);
      view.dom.removeEventListener('focusin', onFocusIn);
      view.dom.removeEventListener('mouseleave', onMouseLeave);
      view.dom.removeEventListener('click', onClick);
      element.remove();
    },
  };
}
// ---------------------------------------------------------------------------
// Table bar
// ---------------------------------------------------------------------------

/** One table context resolved from the current selection. */
interface TableContext {
  /** The table's DOM node (the frozen stylesheet targets `table`). */
  element: HTMLElement;
  node: PmNode;
  /** Document position of the table node. */
  pos: number;
  /** Depth of the table in the selection's ancestor chain. */
  depth: number;
  /** Depth of the cell holding the selection, or `-1`. */
  cellDepth: number;
  /** Index of the row holding the selection (0-based), or `-1`. */
  rowIndex: number;
  /** Whether that row consists of header cells. */
  rowIsHeader: boolean;
  /** Whether the selection is a `CellSelection` (spans cells). */
  cellSelection: boolean;
}

/** Selection kind id (`text`, `node`, `cell`, …). */
function selectionKindOf(selection: PmSelection): string {
  const withId = selection as PmSelection & { readonly jsonID?: string };
  return withId.jsonID ?? selection.constructor.name;
}

/** Table DOM element rendered at one node position. */
function tableElementAt(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  if (dom.tagName === 'TABLE') return dom;
  const table = dom.querySelector('table');
  return table instanceof HTMLElement ? table : null;
}

/** The table containing the current selection, if the caret is inside one. */
function selectionTableContext(view: EditorView): TableContext | null {
  const $from = view.state.selection.$from;
  let depth = -1;
  for (let candidate = $from.depth; candidate > 0; candidate -= 1) {
    if ($from.node(candidate).type.name === 'table') {
      depth = candidate;
      break;
    }
  }
  if (depth < 0) return null;
  const node = $from.node(depth);
  const pos = $from.before(depth);
  const element = tableElementAt(view, pos);
  if (element === null) return null;
  let cellDepth = -1;
  let rowDepth = -1;
  for (let candidate = $from.depth - 1; candidate > 0; candidate -= 1) {
    const role = ($from.node(candidate).type.spec as { tableRole?: string })
      .tableRole;
    if (role === 'cell' || role === 'header_cell') {
      cellDepth = candidate;
      continue;
    }
    if (role === 'row') {
      rowDepth = candidate;
      break;
    }
  }
  const row = rowDepth > 0 ? $from.node(rowDepth) : null;
  let rowIndex = -1;
  let rowIsHeader = false;
  if (row !== null) {
    node.forEach((child, _offset, index) => {
      if (child === row) rowIndex = index;
    });
    rowIsHeader = row.childCount > 0;
    row.forEach((cell) => {
      if (cell.type.name !== 'tableHeader') rowIsHeader = false;
    });
  }
  return {
    element,
    node,
    pos,
    depth,
    cellDepth,
    rowIndex,
    rowIsHeader,
    cellSelection: selectionKindOf(view.state.selection) === 'cell',
  };
}

/** Whether the table's first row consists of header cells. */
function tableHasHeaderRow(table: PmNode): boolean {
  const cell = table.firstChild?.firstChild ?? null;
  return cell?.type.name === 'tableHeader';
}

/** Row/column counts of one table (merged cells count as one column). */
function tableShape(table: PmNode): { rows: number; columns: number } {
  return {
    rows: table.childCount,
    columns: table.firstChild?.childCount ?? 0,
  };
}

/** The cell node at the selection (only meaningful for a table context). */
function contextCell(view: EditorView, context: TableContext): PmNode | null {
  if (context.cellDepth <= 0) return null;
  const cell = view.state.selection.$from.node(context.cellDepth);
  return cell.type.name === 'tableCell' || cell.type.name === 'tableHeader'
    ? cell
    : null;
}

/** Whether one cell is merged (spans more than one row or column). */
function cellIsMerged(cell: PmNode | null): boolean {
  if (cell === null) return false;
  const span = (name: string): number => {
    const value = cell.attrs[name];
    return typeof value === 'number' && value > 1 ? value : 1;
  };
  return span('colspan') > 1 || span('rowspan') > 1;
}

/** Run one built-in table command through a focused chain (never throws). */
function runTableCommand(editor: Editor, name: string): boolean {
  const chain = editor.chain().focus() as unknown as Record<
    string,
    (() => { run(): boolean }) | undefined
  >;
  const command = chain[name];
  if (command === undefined) return false;
  try {
    const step = command();
    return typeof step?.run === 'function' && step.run() === true;
  } catch {
    return false;
  }
}

/** Whether one built-in table command can run with the current selection. */
function canTableCommand(editor: Editor, name: string): boolean {
  const can = editor.can() as unknown as Record<
    string,
    (() => boolean) | undefined
  >;
  const command = can[name];
  if (command === undefined) return false;
  try {
    return command() === true;
  } catch {
    return false;
  }
}

/**
 * Create the table bar.
 *
 * Two surfaces share the one dark bar:
 *
 * - **hover / whole-table selected** (the frozen behaviour): hovering a table
 *   offers 选中; once the table is the selected block the bar offers
 *   上移 / 下移 / 删除;
 * - **caret inside a table** (professional-editor enhancement): the bar shows
 *   the full table toolbar anchored above that table — insert rows/columns,
 *   delete row/column, merge/split cells, toggle the header row, move the table
 *   and delete it. Every mutation is a built-in Tiptap table command, so ids,
 *   undo history and the kernel's save path keep working unchanged.
 *
 * The whole-table selection belongs to the shared block-selection controller, so
 * a table selected from this bar is deleted by the same Backspace branch as a
 * selected divider or image.
 */
export function createTableOverlay(editor: Editor): OverlayBar {
  const view = editor.view;
  const element = createBar('表格操作');
  const selection = blockSelectionOf(view);
  let hovered: HTMLElement | null = null;
  /** Set while the shared hide timer closed the bar; cleared on interaction. */
  let dismissed = false;

  function scheduleHide(): void {
    schedulePendingHide(view);
  }

  function hide(): void {
    dismissed = true;
    hovered = null;
    render();
  }

  function selectedTable(): HTMLElement | null {
    const selected = selection.selected();
    if (selected === null || selected.kind !== 'table') return null;
    return selected.element;
  }

  /** Frozen whole-table placement: clamp into the viewport, sit 34px above. */
  function placeLegacy(table: HTMLElement): void {
    placeBar(element, table.getBoundingClientRect(), 160, 34);
  }

  /** Full toolbar placement: anchored at the table top, clamped by its width. */
  function placeToolbar(table: HTMLElement): void {
    element.style.position = 'fixed';
    const rect = table.getBoundingClientRect();
    element.style.top = `${Math.max(10, rect.top - 42)}px`;
    const width =
      element.getBoundingClientRect().width || element.offsetWidth || 0;
    element.style.left = `${Math.min(
      Math.max(12, rect.left),
      Math.max(12, window.innerWidth - width - 12),
    )}px`;
  }

  /** Append one table action button (compact text, full aria-label/title). */
  function appendAction(spec: {
    action: string;
    text: string;
    ariaLabel: string;
    title?: string;
    disabled?: boolean;
    active?: boolean;
    onPress(): void;
  }): void {
    element.append(
      barButton({
        text: spec.text,
        ariaLabel: spec.ariaLabel,
        ...(spec.title === undefined ? {} : { title: spec.title }),
        ...(spec.disabled === undefined ? {} : { disabled: spec.disabled }),
        ...(spec.active === undefined ? {} : { active: spec.active }),
        action: spec.action,
        onPress: spec.onPress,
      }),
    );
  }

  /** Full toolbar rendered while the caret sits inside one table. */
  function renderFullToolbar(context: TableContext): void {
    const shape = tableShape(context.node);
    const cell = contextCell(view, context);
    const headerRow = tableHasHeaderRow(context.node);
    const mergeEnabled =
      context.cellSelection || canTableCommand(editor, 'mergeCells');
    const splitEnabled =
      cellIsMerged(cell) ||
      context.cellSelection ||
      canTableCommand(editor, 'splitCell');
    const runCommand = (name: string): void => {
      runTableCommand(editor, name);
      render();
    };
    appendAction({
      action: 'add-row-before',
      text: '↑行',
      ariaLabel: '上方插入行',
      // A body row inserted above the header row would push the header out of
      // the leading run and lose it on capture (the AST stores `headerRows`).
      disabled: context.rowIndex === 0 && headerRow,
      onPress: () => runCommand('addRowBefore'),
    });
    appendAction({
      action: 'add-row-after',
      text: '↓行',
      ariaLabel: '下方插入行',
      onPress: () => runCommand('addRowAfter'),
    });
    appendAction({
      action: 'add-column-before',
      text: '←列',
      ariaLabel: '左侧插入列',
      onPress: () => runCommand('addColumnBefore'),
    });
    appendAction({
      action: 'add-column-after',
      text: '→列',
      ariaLabel: '右侧插入列',
      onPress: () => runCommand('addColumnAfter'),
    });
    appendAction({
      action: 'delete-row',
      text: '删行',
      ariaLabel: '删除行',
      disabled: shape.rows <= 1,
      onPress: () => runCommand('deleteRow'),
    });
    appendAction({
      action: 'delete-column',
      text: '删列',
      ariaLabel: '删除列',
      disabled: shape.columns <= 1,
      onPress: () => runCommand('deleteColumn'),
    });
    appendAction({
      action: 'merge-cells',
      text: '合并',
      ariaLabel: '合并单元格',
      disabled: !mergeEnabled,
      onPress: () => runCommand('mergeCells'),
    });
    appendAction({
      action: 'split-cell',
      text: '拆分',
      ariaLabel: '拆分单元格',
      disabled: !splitEnabled,
      onPress: () => runCommand('splitCell'),
    });
    appendAction({
      action: 'toggle-header',
      text: '表头',
      ariaLabel: '表头开关',
      title: headerRow ? '取消表头' : '设为表头',
      active: headerRow,
      onPress: () => toggleFirstRowHeader(),
    });
    appendAction({
      action: 'move-up',
      text: '上移',
      ariaLabel: '上移表格',
      title: '上移',
      onPress: () => moveTable(-1),
    });
    appendAction({
      action: 'move-down',
      text: '下移',
      ariaLabel: '下移表格',
      title: '下移',
      onPress: () => moveTable(1),
    });
    appendAction({
      action: 'delete-table',
      text: '删表',
      ariaLabel: '删除表格',
      title: '删除',
      onPress: () => {
        runTableCommand(editor, 'deleteTable');
        hovered = null;
        render();
      },
    });
  }

  /** Frozen 3-button bar of a whole-table selection. */
  function renderSelectedTable(table: HTMLElement): void {
    placeLegacy(table);
    element.append(
      barButton({
        text: '上移',
        ariaLabel: '上移表格',
        title: '上移',
        onPress: () => moveSelectedTable(-1),
      }),
      barButton({
        text: '下移',
        ariaLabel: '下移表格',
        title: '下移',
        onPress: () => moveSelectedTable(1),
      }),
      barButton({
        text: '删除',
        ariaLabel: '删除表格',
        title: '删除',
        onPress: () => remove(),
      }),
    );
  }

  function render(): void {
    element.replaceChildren();
    const context = selectionTableContext(view);
    const selected = selectedTable();
    const hoveredTable =
      hovered !== null && hovered.isConnected ? hovered : null;

    // A caret inside a table wins: one full toolbar, never two bars.
    if (!dismissed && context !== null) {
      element.style.display = '';
      placeToolbar(context.element);
      renderFullToolbar(context);
      return;
    }
    if (hoveredTable !== null) {
      element.style.display = '';
      if (selected === hoveredTable) {
        renderSelectedTable(hoveredTable);
      } else {
        placeLegacy(hoveredTable);
        element.append(
          barButton({
            text: '选中',
            ariaLabel: '选中表格',
            title: '选中整表',
            onPress: () => selectTable(hoveredTable),
          }),
        );
      }
      return;
    }
    if (!dismissed && selected !== null && selected.isConnected) {
      element.style.display = '';
      renderSelectedTable(selected);
      return;
    }
    element.style.display = 'none';
  }

  function selectTable(table: HTMLElement): void {
    // The caret leaves the table, so the next delete key removes the table
    // instead of a character in a cell (frozen `E:938-950`).
    selection.select(table, { moveCaret: true });
    dismissed = false;
    render();
  }

  function moveSelectedTable(delta: -1 | 1): void {
    if (!selection.moveSelected(delta)) return;
    // ProseMirror re-creates the moved node's DOM, so the hovered element is
    // stale: follow the selection and keep the bar on the moved table.
    const selected = selection.selected();
    hovered =
      selected !== null && selected.kind === 'table' ? selected.element : null;
    render();
  }

  /**
   * Move the table whose caret is inside it, then put the caret back inside so
   * the full toolbar stays available.
   */
  function moveTable(delta: -1 | 1): void {
    const context = selectionTableContext(view);
    if (context === null) return;
    if (selection.selected()?.element !== context.element) {
      selection.select(context.element);
    }
    if (!selection.moveSelected(delta)) {
      selection.clear();
      render();
      return;
    }
    const moved = selection.selected();
    if (moved !== null) {
      try {
        const near = TextSelection.near(
          view.state.doc.resolve(moved.pos + 2),
          1,
        );
        view.dispatch(view.state.tr.setSelection(near));
        view.focus();
      } catch {
        // The mapped selection stays valid for unusual table shapes.
      }
    }
    selection.clear();
    hovered = moved?.element ?? null;
    dismissed = false;
    render();
  }

  /**
   * Toggle whether the table has a header row.
   *
   * The built-in `toggleHeaderRow` command always acts on the table's first row
   * (that is the model the AST can store: one leading `headerRows` count), so it
   * is called directly and the caret stays where it is.
   */
  function toggleFirstRowHeader(): void {
    runTableCommand(editor, 'toggleHeaderRow');
    render();
  }

  function remove(): void {
    if (!selection.removeSelected()) return;
    hovered = null;
    render();
  }

  const onMouseOver = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const table = target.closest('table');
    if (!(table instanceof HTMLElement)) return;
    dismissed = false;
    if (table === hovered) {
      render();
      return;
    }
    cancelPendingHide(view);
    hovered = table;
    render();
  };

  const onMouseLeave = (): void => scheduleHide();

  /** Re-entering the body re-opens a dismissed full toolbar. */
  const onBodyMouseMove = (): void => {
    if (!dismissed) return;
    dismissed = false;
    render();
  };

  /**
   * Clicking outside a table hides the bar (frozen `E:2289-2291`).
   *
   * The frozen handler returns early for task boxes, images and dividers, so a
   * click on those keeps the table bar open; everything else hides it.
   */
  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (element.contains(target)) return;
    if (target.closest('table') instanceof HTMLElement) return;
    if (
      target.closest('[data-todo-box], [data-todo], img, [data-divider]') !== null
    ) {
      return;
    }
    dismissed = true;
    if (hovered === null) return;
    hovered = null;
    render();
  };

  const onSelectionUpdate = (): void => {
    dismissed = false;
    render();
  };

  const onScroll = (): void => {
    if (element.style.display === 'none') return;
    render();
  };

  const onBarEnter = (): void => cancelPendingHide(view);
  const onBarLeave = (): void => scheduleHide();

  element.addEventListener('mouseenter', onBarEnter);
  element.addEventListener('mouseleave', onBarLeave);
  view.dom.addEventListener('mouseover', onMouseOver);
  view.dom.addEventListener('mousemove', onBodyMouseMove);
  view.dom.addEventListener('mouseleave', onMouseLeave);
  view.dom.addEventListener('click', onClick);
  editor.on('selectionUpdate', onSelectionUpdate);
  document.addEventListener('scroll', onScroll, true);
  const unsubscribe = selection.subscribe(render);
  document.body.append(element);
  render();

  const handle: OverlayHandle = { hide };
  registerBar(view, handle);

  return {
    element,
    update: render,
    hide,
    destroy() {
      unregisterBar(view, handle);
      view.dom.removeEventListener('mouseover', onMouseOver);
      view.dom.removeEventListener('mousemove', onBodyMouseMove);
      view.dom.removeEventListener('mouseleave', onMouseLeave);
      view.dom.removeEventListener('click', onClick);
      editor.off('selectionUpdate', onSelectionUpdate);
      document.removeEventListener('scroll', onScroll, true);
      unsubscribe();
      element.remove();
      selection.clear();
    },
  };
}
