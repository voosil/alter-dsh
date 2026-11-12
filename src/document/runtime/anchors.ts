/**
 * Comment anchors for the restored document UI (E4).
 *
 * Comments store `{ blockId, offset, length }` plus the quoted text. After
 * editing, reversions or version restores an anchor can point at the wrong
 * text, at a deleted block or outside the block. The helpers here:
 *
 * - {@link validateCommentAnchor} / {@link detectAnchorDrift} diagnose one
 *   comment against the current AST without throwing;
 * - {@link planReanchor} proposes a new anchor only when the quote matches
 *   exactly one place in the document (same block or a neighbouring one);
 * - {@link planCommentAnchorRepairs} classifies a whole comment list into
 *   auto-repairable anchors and unresolved ones, so the view can be explicit
 *   (toast) instead of silently highlighting the wrong text.
 *
 * `blockPlainText` keeps the historical quote convention: inline text with
 * hard breaks as `\n`, nested block children joined by `\n`. Whitespace and
 * truncated quotes are tolerated when comparing, but never used to guess a
 * position when the match is ambiguous.
 *
 * @module @alter-dsh/space/document/runtime/anchors
 */
import type { AlterDoc, BlockNode, InlineNode } from '../types';

/** Comment anchor shape stored on one top-level block. */
export interface CommentAnchor {
  blockId: string;
  offset: number;
  length: number;
}

/** Structural subset of one comment the anchor helpers need. */
export interface AnchorComment {
  id: string;
  quote: string | null;
  anchor: CommentAnchor | null;
}

/** Diagnosis of one stored comment anchor against the current document. */
export type CommentAnchorStatus =
  | 'valid'
  /** No anchor yet (or no stored anchor) but a quote exists. */
  | 'unanchored'
  /** The anchored block no longer exists. */
  | 'missing-block'
  /** Offset/length are not a non-empty range inside the block text. */
  | 'out-of-range'
  /** The range resolves, but the text there no longer matches the quote. */
  | 'text-mismatch';

/** Result of comparing one comment anchor with the current document. */
export interface AnchorDrift {
  status: CommentAnchorStatus;
  commentId: string;
  quote: string | null;
  anchor: CommentAnchor | null;
  /** Block id the anchor names, when present. */
  blockId?: string;
  /** Text currently under the anchor, when the range resolves. */
  currentText?: string;
}

/** One auto-repairable comment anchor. */
export interface AnchorRepair {
  commentId: string;
  anchor: CommentAnchor;
}

/** Classification of a comment list against one document snapshot. */
export interface AnchorRepairPlan {
  /** Anchors that can be rewritten automatically (unique quote match). */
  repairs: AnchorRepair[];
  /** Comment ids whose anchor could not be repaired (surface as invalid). */
  unresolvedIds: string[];
}

/** Shortest overlap accepted for truncated-quote tolerance. */
const TRUNCATION_TOLERANCE_MIN = 8;

/** Plain text of one block subtree, using the comment-anchor convention. */
export function blockPlainText(block: BlockNode): string {
  const parts: string[] = [];
  const collectInline = (content: InlineNode[] | undefined): void => {
    for (const node of content ?? []) {
      parts.push(node.type === 'text' ? node.text : '\n');
    }
  };
  collectInline(block.content);
  for (const child of block.children ?? []) {
    if (parts.length > 0) parts.push('\n');
    parts.push(blockPlainText(child));
  }
  return parts.join('');
}

/** Normalize a quote for comparison: trim and collapse whitespace runs. */
function normalizeQuote(quote: string | null | undefined): string {
  return (quote ?? '').replace(/\s+/gu, ' ').trim();
}

/** Whether an anchor's current text still represents the stored quote. */
export function quoteMatchesAnchorText(
  anchorText: string,
  quote: string | null,
): boolean {
  const expected = normalizeQuote(quote);
  if (expected === '') return true;
  const text = normalizeQuote(anchorText);
  if (text === expected) return true;
  // Tolerance for a quote that was truncated when it was stored: one side is
  // a prefix of the other. Only long enough overlaps count, so real drift on
  // short quotes is never hidden.
  const shorter = text.length <= expected.length ? text : expected;
  const longer = text.length <= expected.length ? expected : text;
  if (
    shorter.length >= TRUNCATION_TOLERANCE_MIN &&
    longer.startsWith(shorter)
  ) {
    return true;
  }
  // Same tolerance when the stored quote ends with an explicit ellipsis.
  const withoutEllipsis = expected.replace(/[.…]+$/u, '').trim();
  if (
    withoutEllipsis !== expected &&
    withoutEllipsis.length >= TRUNCATION_TOLERANCE_MIN &&
    (text === withoutEllipsis || text.startsWith(withoutEllipsis))
  ) {
    return true;
  }
  return false;
}

/** Find one top-level block by AST id. */
function findTopLevelBlock(
  blocks: readonly BlockNode[],
  blockId: string,
): BlockNode | undefined {
  return blocks.find((block) => block.id === blockId);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** All non-overlapping occurrences of a quote in one block text. */
function findQuoteOccurrences(
  text: string,
  quote: string,
): Array<{ start: number; end: number }> {
  const needle = quote.trim();
  if (needle === '') return [];
  const occurrences: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= text.length - needle.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    occurrences.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  if (occurrences.length > 0) return occurrences;
  // Whitespace-insensitive fallback (the old editor may normalize spaces).
  const compactNeedle = needle.replace(/\s+/gu, '');
  if (compactNeedle === '') return [];
  let stripped = '';
  const offsets: number[] = [];
  for (let position = 0; position < text.length; position += 1) {
    const character = text[position] ?? '';
    if (/\s/u.test(character)) continue;
    stripped += character;
    offsets.push(position);
  }
  let cursor = 0;
  while (cursor <= stripped.length - compactNeedle.length) {
    const at = stripped.indexOf(compactNeedle, cursor);
    if (at < 0) break;
    const start = offsets[at];
    const end = offsets[at + compactNeedle.length - 1];
    if (start !== undefined && end !== undefined) {
      occurrences.push({ start, end: end + 1 });
    }
    cursor = at + compactNeedle.length;
  }
  return occurrences;
}

/**
 * Map one comment quote to a top-level block anchor.
 *
 * The quote must match exactly one top-level block (the pre-rebuild comment
 * model anchors comments to a block range); ambiguous or missing matches
 * return null so the comment is stored without an anchor.
 */
export function anchorForQuote(
  blocks: readonly BlockNode[],
  quote: string | null | undefined,
): CommentAnchor | null {
  const normalized = (quote ?? '').trim();
  if (normalized === '') return null;
  const matches: CommentAnchor[] = [];
  for (const block of blocks) {
    const occurrences = findQuoteOccurrences(blockPlainText(block), normalized);
    if (occurrences.length === 0) continue;
    matches.push({
      blockId: block.id,
      offset: occurrences[0]!.start,
      length: occurrences[0]!.end - occurrences[0]!.start,
    });
  }
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Validate one stored comment anchor against the current document.
 *
 * @returns `valid` when the range resolves and its text matches the quote.
 */
export function validateCommentAnchor(
  comment: AnchorComment,
  doc: AlterDoc,
): CommentAnchorStatus {
  const anchor = comment.anchor;
  if (anchor === null) {
    return normalizeQuote(comment.quote) === '' ? 'valid' : 'unanchored';
  }
  if (typeof anchor.blockId !== 'string' || anchor.blockId.trim() === '') {
    return 'missing-block';
  }
  const block = findTopLevelBlock(doc.blocks, anchor.blockId.trim());
  if (block === undefined) return 'missing-block';
  if (
    !isFiniteInteger(anchor.offset) ||
    !isFiniteInteger(anchor.length) ||
    anchor.offset < 0 ||
    anchor.length <= 0
  ) {
    return 'out-of-range';
  }
  const text = blockPlainText(block);
  if (anchor.offset + anchor.length > text.length) return 'out-of-range';
  if (normalizeQuote(comment.quote) === '') return 'valid';
  return quoteMatchesAnchorText(
    text.slice(anchor.offset, anchor.offset + anchor.length),
    comment.quote,
  )
    ? 'valid'
    : 'text-mismatch';
}

/** Compare one comment anchor with the current document (no throwing). */
export function detectAnchorDrift(
  comment: AnchorComment,
  doc: AlterDoc,
): AnchorDrift {
  const status = validateCommentAnchor(comment, doc);
  const anchor = comment.anchor;
  const drift: AnchorDrift = {
    status,
    commentId: comment.id,
    quote: comment.quote,
    anchor,
  };
  if (anchor === null) return drift;
  const block = findTopLevelBlock(doc.blocks, anchor.blockId.trim());
  if (block === undefined) return drift;
  drift.blockId = block.id;
  const text = blockPlainText(block);
  if (
    isFiniteInteger(anchor.offset) &&
    isFiniteInteger(anchor.length) &&
    anchor.offset >= 0 &&
    anchor.length > 0 &&
    anchor.offset + anchor.length <= text.length
  ) {
    drift.currentText = text.slice(
      anchor.offset,
      anchor.offset + anchor.length,
    );
  }
  return drift;
}

/**
 * Propose a repaired anchor.
 *
 * Only a semantically unique quote match is accepted (exactly one position in
 * the whole document); ambiguous or missing quotes return null so an anchor is
 * never guessed.
 */
export function planReanchor(
  comment: AnchorComment,
  doc: AlterDoc,
): CommentAnchor | null {
  const quote = normalizeQuote(comment.quote);
  if (quote === '') return null;
  const matches: CommentAnchor[] = [];
  for (const block of doc.blocks) {
    const occurrences = findQuoteOccurrences(blockPlainText(block), quote);
    for (const occurrence of occurrences) {
      matches.push({
        blockId: block.id,
        offset: occurrence.start,
        length: occurrence.end - occurrence.start,
      });
      if (matches.length > 1) return null;
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Classify a comment list and plan the anchors that can be repaired.
 *
 * `unresolvedIds` contains only comments that should have an anchor (they have
 * a quote) but whose anchor is invalid and cannot be matched uniquely — the
 * view turns that into one visible 「部分评论锚点已失效」 notice.
 */
export function planCommentAnchorRepairs(
  comments: readonly AnchorComment[],
  doc: AlterDoc,
): AnchorRepairPlan {
  const repairs: AnchorRepair[] = [];
  const unresolvedIds: string[] = [];
  for (const comment of comments) {
    const status = validateCommentAnchor(comment, doc);
    if (status === 'valid') continue;
    if (normalizeQuote(comment.quote) === '') continue;
    const planned = planReanchor(comment, doc);
    if (planned === null) {
      unresolvedIds.push(comment.id);
      continue;
    }
    repairs.push({ commentId: comment.id, anchor: planned });
  }
  return { repairs, unresolvedIds };
}
