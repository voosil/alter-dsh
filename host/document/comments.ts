/**
 * Cascade comment deletion on document body writes (Host authority).
 *
 * A comment quotes a span of text. When a body write makes that text
 * disappear from the document, the comment loses its subject and is
 * soft-deleted into the history panel instead of pointing at nothing. The
 * rule is deliberately document-wide and text-based so every write shape
 * shares one judgement — deleting a block, an `update_text` edit, a whole
 * block replacement, or an unwrap all look the same here:
 *
 * - only `open` comments with a non-empty quote are considered; `resolved`
 *   comments are already history and `deleted` tombstones are skipped, so a
 *   cascade never repeats or grows;
 * - the quote is looked up by substring in the whole document's flattened
 *   text (all top-level blocks, nested children included, joined by newlines,
 *   whitespace collapsed on both sides). A quote that still occurs anywhere
 *   survives — two occurrences are an ambiguity, not a deletion;
 * - only `status` / `deletedAt` change: body, quote, anchor and supplements
 *   stay for the history view. Undo does not resurrect a cascaded comment
 *   (comments live outside the operation log).
 *
 * Callers run this inside the same store transaction as the body write and
 * only when the body text actually changed.
 *
 * @module @alter-dsh/space/document/comments
 */
import type { Comment } from '@alter/protocol';
import { plainTextOfBlock } from './ast/schema.js';
import type { BlockNode } from './editors/legacy/types.js';

/** Collapse whitespace so stored quotes and live text compare alike. */
function normalizeSpace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Flattened plain text of a whole document body, whitespace-collapsed. */
export function documentText(blocks: readonly BlockNode[]): string {
  return normalizeSpace(blocks.map((block) => blockPlainText(block)).join('\n'));
}

/** Plain text of one block subtree (nested children joined by newlines). */
function blockPlainText(block: BlockNode): string {
  const own = plainTextOfBlock(block);
  if (block.children === undefined || block.children.length === 0) return own;
  return [own, ...block.children.map((child) => blockPlainText(child))].join(
    '\n',
  );
}

/**
 * Whether one comment's quoted text still occurs in the document body.
 *
 * Comments without a quote have no text subject and always survive.
 */
export function commentQuoteSurvives(
  comment: Pick<Comment, 'quote'>,
  text: string,
): boolean {
  const quote = normalizeSpace(comment.quote ?? '');
  if (quote === '') return true;
  return text.includes(quote);
}

/**
 * Soft-delete the comments whose quote vanished from the body.
 *
 * Mutates the given comment list in place and returns the tombstones it
 * created; an empty array means nothing cascaded.
 *
 * @param comments - the Space store's comment list (mutated).
 * @param docId - document whose body just changed.
 * @param after - the document body after the write.
 * @param at - ISO timestamp recorded as `deletedAt`.
 */
export function cascadeDeletedComments(
  comments: Comment[],
  docId: string,
  after: readonly BlockNode[],
  at: string,
): Comment[] {
  const text = documentText(after);
  const cascaded: Comment[] = [];
  for (const comment of comments) {
    if (comment.docId !== docId) continue;
    if (comment.status !== 'open') continue;
    if (commentQuoteSurvives(comment, text)) continue;
    comment.status = 'deleted';
    comment.deletedAt = at;
    cascaded.push(comment);
  }
  return cascaded;
}