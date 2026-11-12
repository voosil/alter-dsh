/**
 * DOM text helpers kept for the frozen UI surfaces that still need them: the
 * history diff preview (`utils/diff.ts`) and the comment rail
 * (`components/CommentRail.tsx`). They were moved verbatim out of the retired
 * contentEditable editor utilities, so behavior must stay unchanged.
 */

const blockTags = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'IMG',
  'HR',
  'A',
]);

/**
 * Wrap loose inline nodes into paragraphs so stored HTML renders as blocks.
 * Used by the history diff preview to compare block markup.
 */
export function normalizeBlocks(editor: HTMLElement) {
  let paragraph: HTMLParagraphElement | null = null;
  for (const node of [...editor.childNodes]) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (blockTags.has(element.tagName)) {
        paragraph = null;
        continue;
      }
    }
    if (!paragraph) {
      paragraph = document.createElement('p');
      node.before(paragraph);
    }
    paragraph.append(node);
  }
  // Stored documents can predate the non-editable checkbox marker.
  for (const box of editor.querySelectorAll('[data-todo-box]')) {
    box.setAttribute('contenteditable', 'false');
  }
}

/**
 * Resolve a character offset in `root`'s text content to a DOM text node and
 * offset pair. Used by the comment rail to paint quote ranges.
 */
export function pointAtOffset(
  root: HTMLElement,
  offset: number,
): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return null;
}

/** Character range inside a text content string. */
export interface TextAnchor {
  start: number;
  end: number;
}

/**
 * Locate `quote` in `text`, falling back to a whitespace-insensitive match.
 * Used by the comment rail to anchor stored comment quotes.
 */
export function findQuoteOffsets(
  text: string,
  quote: string,
): TextAnchor | null {
  const normalized = quote.trim();
  if (!normalized) return null;
  let index = text.indexOf(normalized);
  let length = normalized.length;
  if (index < 0) {
    const compact = normalized.replace(/\s+/g, '');
    if (!compact) return null;
    let stripped = '';
    const offsets: number[] = [];
    for (let position = 0; position < text.length; position += 1) {
      const character = text[position] ?? '';
      if (/\s/.test(character)) continue;
      stripped += character;
      offsets.push(position);
    }
    const compactIndex = stripped.indexOf(compact);
    if (compactIndex < 0) return null;
    const startOffset = offsets[compactIndex];
    const endOffset = offsets[compactIndex + compact.length - 1];
    if (startOffset === undefined || endOffset === undefined) return null;
    index = startOffset;
    length = endOffset - startOffset + 1;
  }
  return { start: index, end: index + length };
}

/**
 * Resolve a stored comment quote to a DOM range over `root`. Used by the
 * comment rail to render quote highlights over the frozen document shell.
 */
export function findQuoteRange(root: HTMLElement, quote: string) {
  const offsets = findQuoteOffsets(root.textContent ?? '', quote);
  if (!offsets) return null;
  const start = pointAtOffset(root, offsets.start);
  const end = pointAtOffset(root, offsets.end);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}