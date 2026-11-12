/**
 * Table and link overlays for the AST-native kernel.
 *
 * Parity with the frozen editor's two dark bars (both reuse `.linkBar`):
 *
 * - **表格操作**: hovering a table offers 选中; once it is the selected block the
 *   bar offers 上移 / 下移 / 删除;
 * - **链接操作**: hovering a link offers 转为卡片 / 转为行内 and 编辑.
 *
 * Both are body-level overlays. Nothing here parses HTML: tables and links are
 * ProseMirror nodes, so the operations are node commands and node attribute
 * updates, and selection state lives in the kernel (never in the AST).
 *
 * @module @alter-dsh/space/document/editors/tiptap/overlays
 */
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';

/** The class both frozen bars share. */
const BAR_CLASS = 'linkBar';

/** One overlay bar over a document target. */
export interface OverlayBar {
  element: HTMLElement;
  update(): void;
  destroy(): void;
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

/** Build the bar shell with the frozen role/label. */
function bar(ariaLabel: string): HTMLElement {
  const element = document.createElement('div');
  element.className = BAR_CLASS;
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', ariaLabel);
  // Keep the caret while pressing a button (frozen behaviour).
  element.addEventListener('mousedown', (event) => event.preventDefault());
  return element;
}

/** One bar button with the frozen label/title pair. */
function button(label: string, onDown: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.setAttribute('aria-label', label);
  element.title = label;
  element.textContent = label;
  element.addEventListener('click', onDown);
  return element;
}

/** Position one bar above a rectangle, clamped into the viewport. */
function place(element: HTMLElement, rect: DOMRect): void {
  element.style.position = 'fixed';
  element.style.left = `${Math.min(Math.max(12, Math.round(rect.left)), Math.max(12, window.innerWidth - 200))}px`;
  element.style.top = `${Math.max(10, Math.round(rect.top - 34))}px`;
}

/** The DOM node for one table position (Tiptap wraps tables in `.tableWrapper`). */
function tableDomOf(editor: Editor, pos: number): HTMLElement | null {
  const dom = editor.view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  // Tiptap renders tables inside a wrapper div; the stylesheet targets `table`.
  return dom.querySelector('table') ?? (dom.tagName === 'TABLE' ? dom : null);
}

/** Position and size of one ProseMirror node's DOM, if rendered. */
function rectOf(editor: Editor, pos: number): DOMRect | null {
  const dom = editor.view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  return dom.getBoundingClientRect();
}

/** The table node position containing one DOM element, if any. */
function tablePosOf(editor: Editor, target: HTMLElement): number | null {
  const table = target.closest('table');
  if (!(table instanceof HTMLElement)) return null;
  const inside = editor.view.posAtDOM(table, 0);
  const $inside = editor.state.doc.resolve(inside);
  // `posAtDOM(table, 0)` resolves to a position inside the table (depth 1); the
  // node itself starts at `before(1)` (or at the document edge).
  if ($inside.depth < 1) return inside;
  return $inside.before(1);
}

/** One table located in the document: its top-level index, start and node. */
interface TableRef {
  index: number;
  start: number;
  node: PmNode;
}

/**
 * Create the table overlay: select / move / delete for one table at a time.
 *
 * Moving re-inserts the same node (ids preserved) at the sibling boundary, so
 * comment anchors on the table survive a move.
 */
export function createTableOverlay(editor: Editor): OverlayBar {
  const element = bar('表格操作');
  let hovered: number | null = null;
  let selected: number | null = null;

  function clearSelectionMark(): void {
    // `editor.view` throws once Tiptap destroyed it; teardown must be safe.
    if (!editor.isDestroyed) {
      editor.view.dom
        .querySelectorAll<HTMLElement>('table[data-selected]')
        .forEach((node) => delete node.dataset['selected']);
    }
  }

  function render(): void {
    element.replaceChildren();
    const target = hovered ?? selected;
    const rect = target === null ? null : rectOf(editor, target);
    if (target === null || rect === null) {
      element.style.display = 'none';
      return;
    }
    element.style.display = '';
    place(element, rect);
    if (selected === target) {
      element.append(
        button('上移', () => move(-1)),
        button('下移', () => move(1)),
        button('删除', () => remove()),
      );
    } else {
      element.append(button('选中', () => select(target)));
    }
  }

  function select(pos: number): void {
    clearSelectionMark();
    // Store the table node's own start position. `posAtDOM` yields a position
    // inside the table, so resolve it to the containing node's boundary once,
    // here, and every later action addresses the node itself.
    const $pos = editor.state.doc.resolve(pos);
    let nodePos = pos;
    if ($pos.depth >= 1) {
      const candidate = $pos.before(1);
      nodePos = editor.state.doc.nodeAt(candidate)?.type.name === 'table'
        ? candidate
        : pos;
    }
    tableDomOf(editor, nodePos)?.setAttribute('data-selected', '');
    selected = nodePos;
    render();
  }

  /**
   * Move the selected table one sibling up (-1) or down (+1).
   *
   * A downward move of the **last** block is a known limitation: ProseMirror
   * requires a trailing block for the caret, so inserting the table after the
   * final sibling appends a filler paragraph and the table no longer ends the
   * document. Upward moves (and downward moves before the last sibling) are
   * handled by "delete at the table's extent, insert at the neighbour's edge".
   */
  function move(delta: number): void {
    if (selected === null) return;
    const doc = editor.state.doc;

    const tables: TableRef[] = [];
    {
      let index = 0;
      let start = 0;
      doc.forEach((child) => {
        if (child.type.name === 'table') tables.push({ index, start, node: child });
        index += 1;
        start += child.nodeSize;
      });
    }
    if (tables.length === 0) return;
    const target = tables.reduce((best, candidate) =>
      Math.abs(candidate.start - selected!) < Math.abs(best.start - selected!)
        ? candidate
        : best,
    );
    const { index, start, node } = target;
    const neighbourIndex = index + delta;
    if (neighbourIndex < 0 || neighbourIndex >= doc.childCount) return;
    // A table cannot become the document's last block without a filler
    // paragraph appearing; keep the document shape stable instead.
    if (delta > 0 && neighbourIndex === doc.childCount - 1) return;

    let neighbourStart = 0;
    for (let step = 0; step < neighbourIndex; step += 1) {
      neighbourStart += doc.child(step).nodeSize;
    }
    const neighbour = doc.child(neighbourIndex);
    const end = start + node.nodeSize;

    const tr = editor.state.tr;
    tr.delete(start, end);
    const insertAt =
      delta > 0
        ? neighbourStart + neighbour.nodeSize - node.nodeSize
        : neighbourStart;
    tr.insert(insertAt, node);
    editor.view.dispatch(tr);

    selected = insertAt;
    clearSelectionMark();
    tableDomOf(editor, insertAt)?.setAttribute('data-selected', '');
    render();
  }

  function remove(): void {
    if (selected === null) return;
    const node = editor.state.doc.nodeAt(selected);
    if (node === null) return;
    editor.view.dispatch(
      editor.state.tr.delete(selected, selected + node.nodeSize),
    );
    selected = null;
    render();
  }

  const dom = editor.view.dom;
  const onMouseOver = (event: MouseEvent): void => {
    const pos = tablePosOf(editor, event.target as HTMLElement);
    if (pos === null || pos === hovered) return;
    hovered = pos;
    render();
  };
  const onMouseLeave = (): void => {
    hovered = null;
    render();
  };
  dom.addEventListener('mouseover', onMouseOver);
  dom.addEventListener('mouseleave', onMouseLeave);

  render();
  document.body.append(element);

  return {
    element,
    update: render,
    destroy() {
      dom.removeEventListener('mouseover', onMouseOver);
      dom.removeEventListener('mouseleave', onMouseLeave);
      clearSelectionMark();
      element.remove();
    },
  };
}

/** What the link bar can report to the page. */
export interface LinkOverlayHandlers {
  /** The document changed (card ⇄ inline conversion). */
  onChange(): void;
  /** The user asked to edit the hovered link's fields. */
  onEdit(detail: { kind: 'card' | 'inline'; href: string; pos: number }): void;
}

/**
 * Create the link overlay: convert between card and inline, and edit.
 *
 * The two AST shapes are a `bookmark` node (card) and a `link` mark (inline);
 * converting rewrites one into the other so the Host never sees a third shape.
 */
export function createLinkOverlay(
  editor: Editor,
  handlers: LinkOverlayHandlers,
): LinkOverlayBar {
  const element = bar('链接操作');
  let hovered: { kind: 'card' | 'inline'; pos: number; href: string } | null =
    null;

  /** Resolve the link under one DOM element. */
  function resolve(target: HTMLElement): typeof hovered {
    const card = target.closest('[data-block-type="bookmark"]');
    if (card instanceof HTMLElement) {
      // Match the node by its rendered DOM element instead of by position:
      // an atom's `posAtDOM` is ambiguous at the document edge, while
      // `nodeDOM(start)` is exactly the card that was hovered.
      const doc = editor.state.doc;
      const cards: { start: number; node: PmNode }[] = [];
      let cursor = 0;
      doc.forEach((child) => {
        if (child.type.name === 'bookmark') cards.push({ start: cursor, node: child });
        cursor += child.nodeSize;
      });
      const found = cards.find((candidate) => {
        const dom = editor.view.nodeDOM(candidate.start);
        return dom instanceof HTMLElement && dom === card;
      });
      if (found === undefined) return null;
      const url = found.node.attrs['url'];
      return typeof url === 'string'
        ? { kind: 'card', pos: found.start, href: url }
        : null;
    }
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLElement)) return null;
    // Resolve by document position instead of DOM identity: `posAtDOM` gives a
    // boundary position where `marks()` is empty, so take the anchor's position
    // and read the link mark from the text that starts there.
    const anchorPos = editor.view.posAtDOM(anchor, 0);
    const links: { pos: number; href: string }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || pos < anchorPos) return true;
      const link = node.marks.find((mark) => mark.type.name === 'link');
      const href = link?.attrs['href'];
      if (typeof href === 'string') links.push({ pos, href });
      // Stop after the first link-bearing text node at/after the anchor.
      return links.length === 0;
    });
    const found = links[0];
    return found === undefined
      ? null
      : { kind: 'inline', pos: found.pos, href: found.href };
  }

  function render(): void {
    element.replaceChildren();
    if (hovered === null) {
      element.style.display = 'none';
      return;
    }
    // Measure the hovered element itself. For an inline link the text node's
    // own DOM is not an element, so the anchor is found by position instead.
    const rect =
      hovered.kind === 'card'
        ? rectOf(editor, hovered.pos)
        : (() => {
            const dom = editor.view.nodeDOM(hovered.pos);
            if (dom instanceof HTMLElement) return dom.getBoundingClientRect();
            if (dom !== null && dom.parentElement !== null) {
              return dom.parentElement.getBoundingClientRect();
            }
            return null;
          })();
    if (rect === null) {
      element.style.display = 'none';
      return;
    }
    element.style.display = '';
    place(element, rect);
    element.append(
      button(hovered.kind === 'card' ? '转为行内' : '转为卡片', () => convert()),
      button('编辑', () => {
        const current = hovered;
        if (current === null) return;
        handlers.onEdit({
          kind: current.kind,
          href: current.href,
          pos: current.pos,
        });
      }),
    );
  }

  /** Card ⇄ inline conversion, preserving the URL and label. */
  function convert(): void {
    if (hovered === null) return;
    const current = hovered;
    if (current.kind === 'card') {
      const node = editor.state.doc.nodeAt(current.pos);
      if (node === null) return;
      const title = node.attrs['title'];
      const label =
        typeof title === 'string' && title !== '' ? title : current.href;
      editor
        .chain()
        .focus()
        .deleteRange({ from: current.pos, to: current.pos + node.nodeSize })
        .insertContent({
          type: 'text',
          text: label,
          marks: [{ type: 'link', attrs: { href: current.href } }],
        })
        .run();
    } else {
      // Replace the whole block holding the link with a card node: an inline
      // mark cannot live inside an atom, and the frozen editor swaps the line.
      const $pos = editor.state.doc.resolve(current.pos);
      const start = $pos.start();
      const end = $pos.end();
      editor
        .chain()
        .focus()
        .deleteRange({ from: start, to: end })
        .insertContent({
          type: 'bookmark',
          attrs: { url: current.href, title: current.href, id: null },
        })
        .run();
    }
    handlers.onChange();
  }

  /**
   * Apply the page's link dialog result.
   *
   * A card updates its own attributes in place (ids and siblings untouched); an
   * inline link replaces just the linked text, keeping the surrounding run.
   */
  function applyEdit(input: {
    kind: 'card' | 'inline';
    pos: number;
    href: string;
    label: string;
  }): void {
    const doc = editor.state.doc;
    const label = input.label.trim() === '' ? input.href : input.label.trim();
    if (input.kind === 'card') {
      const node = doc.nodeAt(input.pos);
      if (node === null || node.type.name !== 'bookmark') return;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(input.pos, undefined, {
          ...node.attrs,
          url: input.href,
          title: label,
        }),
      );
      handlers.onChange();
      return;
    }

    // Inline: replace the text run that carries the link mark at `pos`.
    let from = -1;
    let to = -1;
    doc.descendants((node, pos) => {
      if (from >= 0) return false;
      if (!node.isText) return true;
      const link = node.marks.find((mark) => mark.type.name === 'link');
      if (link === undefined || pos < input.pos) return true;
      from = pos;
      to = pos + node.nodeSize;
      return false;
    });
    if (from < 0 || to < 0) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, {
        type: 'text',
        text: label,
        marks: [{ type: 'link', attrs: { href: input.href } }],
      })
      .run();
    handlers.onChange();
  }

  const dom = editor.view.dom;
  const onMouseOver = (event: MouseEvent): void => {
    const resolved = resolve(event.target as HTMLElement);
    if (resolved === null) return;
    hovered = resolved;
    render();
  };
  const onMouseLeave = (): void => {
    hovered = null;
    render();
  };
  dom.addEventListener('mouseover', onMouseOver);
  dom.addEventListener('mouseleave', onMouseLeave);

  render();
  document.body.append(element);

  return {
    element,
    update: render,
    applyEdit,
    destroy() {
      dom.removeEventListener('mouseover', onMouseOver);
      dom.removeEventListener('mouseleave', onMouseLeave);
      element.remove();
    },
  };
}

