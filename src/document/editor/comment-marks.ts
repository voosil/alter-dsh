/**
 * Comment anchors for the AST document editor (P2).
 *
 * A comment is anchored to one **top-level block** by its stable `blockId`
 * plus a plain-text `offset`/`length` inside that block's flattened text. The
 * editor is the only place that understands ProseMirror positions, so this
 * module owns the whole mapping:
 *
 * - selection → anchor ({@link resolveCommentAnchor}): the top-level block that
 *   contains the selection start (or the first text-bearing top-level block
 *   the selection touches) wins; the range is clamped to that block's text.
 *   Blocks inserted by the user carry no `blockId` until the mapping runs on
 *   save, so a missing id is assigned on demand (a metadata-only transaction)
 *   to keep the anchor addressable right away.
 * - anchor → decorations ({@link buildCommentDecorations}): anchors are
 *   resolved against the current document on every marker change and every
 *   doc change. Invalid anchors (missing block, out-of-range offset) are
 *   skipped and reported through `invalidIds` — rendering never throws.
 * - anchor → scroll/selection ({@link scrollToCommentAnchor}): used when the
 *   comment rail sets `activeCommentId`.
 *
 * P2 deliberately does **not** re-anchor: when text before an anchor changes,
 * offsets drift and the highlight may point at different text. The decoration
 * layer only reports/renders what is still resolvable; re-anchoring and
 * "anchor invalid" surfacing belong to the comment rail/history work.
 *
 * Flattened block text convention: inline text as-is, `hardBreak` as `"\n"`,
 * nested block children joined by `"\n"` (empty leading children contribute no
 * separator). Offsets are always relative to that flattened string.
 *
 * @module @alter-dsh/space/document/editor/comment-marks
 */
import { Extension, type Editor } from '@tiptap/core';
import type { CommentAnchor } from '@alter/protocol';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { newBlockId } from './mapping';

/** Longest quote reported for a selection. */
export const MAX_COMMENT_QUOTE_LENGTH = 500;

/** Class name of one comment highlight (styled from the editor CSS module). */
export const COMMENT_MARK_CLASS = 'alter-comment-mark';

/** Extra class name of the highlight of the active comment. */
export const COMMENT_MARK_ACTIVE_CLASS = 'alter-comment-mark-active';

/** Extra class name of a resolved comment highlight. */
export const COMMENT_MARK_RESOLVED_CLASS = 'alter-comment-mark-resolved';

/**
 * Anchor of one comment inside the document.
 *
 * Re-exported from the shared protocol (`Comment.anchor`) so the editor and the
 * comment rail cannot drift apart; the editor maps it to ProseMirror positions.
 */
export type { CommentAnchor };

/** One comment highlight marker supplied by the comment rail. */
export interface CommentMarker {
  /** Comment id; passed back to `onCommentClick`. */
  id: string;
  anchor: CommentAnchor;
  /** Optional status hint: resolved comments are rendered de-emphasized. */
  resolved?: boolean;
}

/** Selection anchor plus the selected plain text. */
export interface CommentSelectionAnchor extends CommentAnchor {
  quote: string;
}

/** One resolvable range of an anchor (a block can span several text nodes). */
export interface CommentAnchorRange {
  from: number;
  to: number;
}

// ---------------------------------------------------------------------------
// Flattened block text
// ---------------------------------------------------------------------------

type SegmentKind = 'text' | 'break' | 'separator';

interface TextSegment {
  kind: SegmentKind;
  /** Doc positions consumed by this segment (text length, 1 for breaks, 0 for separators). */
  docSpan: number;
  /** Start position relative to the block content start. */
  start: number;
  text: string;
}

interface BlockTextIndex {
  /** Flattened plain text of the whole top-level block subtree. */
  text: string;
  segments: TextSegment[];
}

/** Flatten one top-level block subtree into text + position segments. */
function blockTextIndex(block: PMNode): BlockTextIndex {
  const segments: TextSegment[] = [];
  let text = '';
  const visit = (node: PMNode, contentStart: number): void => {
    node.forEach((child, offset) => {
      const childPos = contentStart + offset;
      if (child.isText) {
        const value = child.text ?? '';
        if (value === '') return;
        segments.push({
          kind: 'text',
          docSpan: value.length,
          start: childPos,
          text: value,
        });
        text += value;
        return;
      }
      if (child.isInline) {
        segments.push({ kind: 'break', docSpan: 1, start: childPos, text: '\n' });
        text += '\n';
        return;
      }
      if (child.isBlock) {
        if (text.length > 0) {
          segments.push({
            kind: 'separator',
            docSpan: 0,
            start: childPos,
            text: '\n',
          });
          text += '\n';
        }
        visit(child, childPos + 1);
      }
    });
  };
  visit(block, 0);
  return { text, segments };
}

/** Flattened plain text of one top-level block subtree. */
export function blockText(block: PMNode): string {
  return blockTextIndex(block).text;
}

/** Map a position (relative to the block content start) to a text offset. */
function positionToOffset(index: BlockTextIndex, relativePosition: number): number {
  let flat = 0;
  for (const segment of index.segments) {
    if (relativePosition < segment.start) return flat;
    if (relativePosition <= segment.start + segment.docSpan) {
      return flat + (relativePosition - segment.start);
    }
    flat += segment.text.length;
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Block lookup
// ---------------------------------------------------------------------------

interface BlockLocation {
  node: PMNode;
  /** Doc position before the top-level block node. */
  pos: number;
}

/** Find a top-level block by its `blockId` attribute. */
export function findCommentBlock(
  doc: PMNode,
  blockId: string,
): BlockLocation | undefined {
  if (blockId === '') return undefined;
  let found: BlockLocation | undefined;
  doc.forEach((node, offset) => {
    if (found !== undefined) return;
    if (node.attrs['blockId'] === blockId) found = { node, pos: offset };
  });
  return found;
}

/** Read the `blockId` attribute of a node, when it has one. */
function blockIdOf(node: PMNode): string | undefined {
  const value = node.attrs['blockId'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Top-level block that contains `position`, when it is inside one. */
function topLevelBlockAt(doc: PMNode, position: number): BlockLocation | undefined {
  if (position < 0 || position > doc.content.size) return undefined;
  const resolved = doc.resolve(position);
  if (resolved.depth < 1) return undefined;
  return { node: resolved.node(1), pos: resolved.before(1) };
}

// ---------------------------------------------------------------------------
// Anchor ↔ ranges
// ---------------------------------------------------------------------------

/** Validate an anchor and return its resolvable text ranges. */
export function commentAnchorRanges(
  doc: PMNode,
  anchor: CommentAnchor,
): CommentAnchorRange[] | undefined {
  const location = findCommentBlock(doc, anchor.blockId);
  if (location === undefined) return undefined;
  const { offset, length } = anchor;
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length <= 0
  ) {
    return undefined;
  }
  const index = blockTextIndex(location.node);
  if (offset >= index.text.length || offset + length > index.text.length) {
    return undefined;
  }
  const contentStart = location.pos + 1;
  const ranges: CommentAnchorRange[] = [];
  let flat = 0;
  for (const segment of index.segments) {
    const segmentStart = flat;
    const segmentEnd = flat + segment.text.length;
    flat = segmentEnd;
    if (segment.kind === 'separator') continue;
    const overlapStart = Math.max(offset, segmentStart);
    const overlapEnd = Math.min(offset + length, segmentEnd);
    if (overlapStart >= overlapEnd) continue;
    ranges.push({
      from: contentStart + segment.start + (overlapStart - segmentStart),
      to: contentStart + segment.start + (overlapEnd - segmentStart),
    });
  }
  return ranges.length === 0 ? undefined : ranges;
}

/** Plain text currently addressed by an anchor, when it is resolvable. */
export function commentAnchorText(
  doc: PMNode,
  anchor: CommentAnchor,
): string | undefined {
  const location = findCommentBlock(doc, anchor.blockId);
  if (location === undefined) return undefined;
  const index = blockTextIndex(location.node);
  if (
    anchor.offset < 0 ||
    anchor.length <= 0 ||
    anchor.offset + anchor.length > index.text.length
  ) {
    return undefined;
  }
  return index.text.slice(anchor.offset, anchor.offset + anchor.length);
}

// ---------------------------------------------------------------------------
// Selection → anchor
// ---------------------------------------------------------------------------

function ensureBlockId(
  editor: Editor,
  location: BlockLocation,
): string | undefined {
  const existing = blockIdOf(location.node);
  if (existing !== undefined) return existing;
  // A block created by the user (split/paste) has no id until the save mapping
  // runs. Assign one now so the comment can be anchored immediately; this is a
  // metadata-only transaction and is persisted by the normal autosave.
  if (!editor.isEditable || editor.isDestroyed) return undefined;
  const generated = newBlockId();
  try {
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(location.pos, undefined, {
        ...location.node.attrs,
        blockId: generated,
      }),
    );
  } catch {
    return undefined;
  }
  return generated;
}

/** Resolve a document range into a comment anchor (no quote). */
export function commentAnchorFromRange(
  editor: Editor,
  from: number,
  to: number,
): CommentAnchor | undefined {
  if (to <= from) return undefined;
  const doc = editor.state.doc;
  let result: CommentAnchor | undefined;
  doc.forEach((node, offset) => {
    if (result !== undefined) return;
    const contentStart = offset + 1;
    const contentEnd = offset + node.nodeSize - 1;
    if (contentEnd < from) return;
    if (contentStart > to) return;
    const blockFrom = Math.max(from, contentStart);
    const blockTo = Math.min(to, contentEnd);
    if (blockTo <= blockFrom) return;
    const index = blockTextIndex(node);
    if (index.text.length === 0) return;
    const offsetStart = positionToOffset(index, blockFrom - contentStart);
    const offsetEnd = positionToOffset(index, blockTo - contentStart);
    const length = offsetEnd - offsetStart;
    if (length <= 0) return;
    const blockId = ensureBlockId(editor, { node, pos: offset });
    if (blockId === undefined) return;
    result = { blockId, offset: offsetStart, length };
  });
  return result;
}

/**
 * Anchor for the current editor selection.
 *
 * Returns `undefined` for empty selections, IME compositions and selections
 * that touch no text (e.g. an image-only block).
 */
export function resolveCommentAnchor(editor: Editor): CommentAnchor | undefined {
  if (editor.isDestroyed || editor.view.composing) return undefined;
  const { from, to } = editor.state.selection;
  return commentAnchorFromRange(editor, from, to);
}

/** Selected plain text (flattened, capped at {@link MAX_COMMENT_QUOTE_LENGTH}). */
export function commentSelectionQuote(
  doc: PMNode,
  from: number,
  to: number,
): string {
  const quote = doc.textBetween(
    from,
    to,
    '\n',
    (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : '\uFFFC'),
  );
  return quote.length > MAX_COMMENT_QUOTE_LENGTH
    ? quote.slice(0, MAX_COMMENT_QUOTE_LENGTH)
    : quote;
}

/** Anchor plus quote for the current selection. */
export function commentSelectionAnchor(
  editor: Editor,
): CommentSelectionAnchor | undefined {
  const anchor = resolveCommentAnchor(editor);
  if (anchor === undefined) return undefined;
  const { from, to } = editor.state.selection;
  return { ...anchor, quote: commentSelectionQuote(editor.state.doc, from, to) };
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

interface CommentDecorationState {
  markers: readonly CommentMarker[];
  activeCommentId: string | null;
  decorations: DecorationSet;
  /** Ids whose anchors cannot be resolved against the current document. */
  invalidIds: string[];
}

interface CommentDecorationPayload {
  markers: readonly CommentMarker[];
  activeCommentId: string | null;
}

/** Plugin key of the comment decoration state. */
export const COMMENT_DECORATION_PLUGIN_KEY =
  new PluginKey<CommentDecorationState>('alterCommentDecorations');

function decorationAttributes(
  marker: CommentMarker,
  active: boolean,
): Record<string, string> {
  const classes = [COMMENT_MARK_CLASS];
  if (active) classes.push(COMMENT_MARK_ACTIVE_CLASS);
  if (marker.resolved === true) classes.push(COMMENT_MARK_RESOLVED_CLASS);
  return {
    class: classes.join(' '),
    'data-comment-id': marker.id,
    ...(active ? { 'data-comment-active': 'true' } : {}),
    ...(marker.resolved === true ? { 'data-comment-resolved': 'true' } : {}),
  };
}

/** Build the decoration set for the current markers and document. */
export function buildCommentDecorations(
  doc: PMNode,
  markers: readonly CommentMarker[],
  activeCommentId: string | null = null,
): CommentDecorationState {
  const decorations: Decoration[] = [];
  const invalidIds: string[] = [];
  for (const marker of markers) {
    const ranges = commentAnchorRanges(doc, marker.anchor);
    if (ranges === undefined) {
      invalidIds.push(marker.id);
      continue;
    }
    const active = marker.id === activeCommentId;
    for (const range of ranges) {
      decorations.push(
        Decoration.inline(
          range.from,
          range.to,
          decorationAttributes(marker, active),
        ),
      );
    }
  }
  // PM requires position-sorted inline decorations; markers may arrive in any
  // order from the rail.
  decorations.sort((left, right) => left.from - right.from || left.to - right.to);
  return {
    markers,
    activeCommentId,
    decorations: DecorationSet.create(doc, decorations),
    invalidIds,
  };
}

function buildState(
  doc: PMNode,
  markers: readonly CommentMarker[],
  activeCommentId: string | null,
): CommentDecorationState {
  return buildCommentDecorations(doc, markers, activeCommentId);
}

/** The comment decoration state of one editor state, when mounted. */
export function getCommentDecorationState(
  editor: Editor,
): CommentDecorationState | undefined {
  if (editor.isDestroyed) return undefined;
  return COMMENT_DECORATION_PLUGIN_KEY.getState(editor.state);
}

/** Plugin that keeps comment highlights in sync with markers/doc changes. */
function createCommentDecorationPlugin(): Plugin<CommentDecorationState> {
  return new Plugin<CommentDecorationState>({
    key: COMMENT_DECORATION_PLUGIN_KEY,
    state: {
      init: () => ({
        markers: [],
        activeCommentId: null,
        decorations: DecorationSet.empty,
        invalidIds: [],
      }),
      apply: (transaction, previous, _oldState, newState) => {
        const payload = transaction.getMeta(
          COMMENT_DECORATION_PLUGIN_KEY,
        ) as CommentDecorationPayload | undefined;
        if (payload !== undefined) {
          return buildState(
            newState.doc,
            payload.markers,
            payload.activeCommentId,
          );
        }
        if (transaction.docChanged) {
          // Offsets are not re-anchored (P2): re-resolve them against the new
          // document so highlights follow still-valid anchors and invalid ones
          // are dropped instead of crashing.
          return buildState(
            newState.doc,
            previous.markers,
            previous.activeCommentId,
          );
        }
        return previous;
      },
    },
    props: {
      decorations: (state) =>
        COMMENT_DECORATION_PLUGIN_KEY.getState(state)?.decorations ?? null,
    },
  });
}

/**
 * Tiptap extension registering the comment decoration plugin.
 *
 * Markers/active id are pushed through {@link refreshCommentDecorations}; the
 * plugin keeps them for doc-change rebuilds.
 */
export function createCommentAnchorExtension(): Extension {
  return Extension.create({
    name: 'alterCommentDecorations',
    addProseMirrorPlugins() {
      return [createCommentDecorationPlugin()];
    },
  });
}

/** Push the current markers/active comment into the decoration plugin. */
export function refreshCommentDecorations(
  editor: Editor,
  markers: readonly CommentMarker[],
  activeCommentId: string | null,
): void {
  if (editor.isDestroyed) return;
  try {
    editor.view.dispatch(
      editor.state.tr.setMeta(COMMENT_DECORATION_PLUGIN_KEY, {
        markers,
        activeCommentId,
      } satisfies CommentDecorationPayload),
    );
  } catch {
    // A decoration refresh must never break the editor.
  }
}

// ---------------------------------------------------------------------------
// Scroll / selection
// ---------------------------------------------------------------------------

/**
 * Scroll to a comment anchor and select its text.
 *
 * Returns `false` for invalid anchors (missing block / out-of-range offset)
 * without touching the current selection.
 */
export function scrollToCommentAnchor(
  editor: Editor,
  anchor: CommentAnchor,
): boolean {
  if (editor.isDestroyed) return false;
  const ranges = commentAnchorRanges(editor.state.doc, anchor);
  if (ranges === undefined) return false;
  const from = ranges[0]!.from;
  const to = ranges[ranges.length - 1]!.to;
  try {
    const transaction = editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, from, to),
    );
    transaction.scrollIntoView();
    editor.view.dispatch(transaction);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the top-level block that contains a document position (helper). */
export function commentBlockAtPosition(
  doc: PMNode,
  position: number,
): string | undefined {
  const location = topLevelBlockAt(doc, position);
  if (location === undefined) return undefined;
  return blockIdOf(location.node);
}
