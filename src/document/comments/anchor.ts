/**
 * Comment anchors over `alter-doc/1` documents.
 *
 * A comment anchor is `{ blockId, offset, length }`: plain-text offsets inside
 * one top-level block's flattened text. The flattened convention is shared with
 * the editor (`src/document/editor/comment-marks.ts`): inline text as-is,
 * `hardBreak` as `"\n"`, nested block children joined by `"\n"` (an empty
 * leading child contributes no separator). These helpers locate blocks, read
 * the anchored text, decide whether an anchor is still valid and order
 * comments the way they appear in the document.
 *
 * Anchor validity only proves the range is still inside its block; it cannot
 * detect text shifted by edits elsewhere. The editor owns live anchor mapping
 * and highlight rendering; the rail degrades to 「锚点已失效」 when the range
 * no longer exists.
 *
 * @module @alter-dsh/space/document/comments/anchor
 */
import type { Comment, CommentAnchor } from '@alter/protocol';
import type { AlterDoc, BlockNode } from '../types';

/**
 * Flattened plain text of one top-level block subtree, matching the editor's
 * anchor convention (see the module note).
 */
export function blockText(block: BlockNode): string {
  let text = '';
  for (const node of block.content ?? []) {
    text += node.type === 'text' ? node.text : '\n';
  }
  for (const child of block.children ?? []) {
    if (text.length > 0) text += '\n';
    text += blockText(child);
  }
  return text;
}

/** Find one top-level block by AST id (comment anchors target top-level blocks). */
export function findBlock(
  doc: AlterDoc,
  blockId: string,
): BlockNode | undefined {
  return doc.blocks.find((block) => block.id === blockId);
}

/**
 * Whether an anchor still points at a non-empty range of an existing block.
 * Anchors are invalid when the block is gone or `offset + length` exceeds the
 * block's plain-text length.
 */
export function isCommentAnchorValid(
  doc: AlterDoc,
  anchor: CommentAnchor | null | undefined,
): boolean {
  if (anchor === null || anchor === undefined) return false;
  if (
    typeof anchor !== 'object' ||
    typeof anchor.blockId !== 'string' ||
    !Number.isInteger(anchor.offset) ||
    !Number.isInteger(anchor.length) ||
    anchor.offset < 0 ||
    anchor.length <= 0
  )
    return false;
  const block = findBlock(doc, anchor.blockId);
  if (block === undefined) return false;
  return anchor.offset + anchor.length <= blockText(block).length;
}

/** Text covered by an anchor, or undefined when the anchor is invalid. */
export function anchorText(
  doc: AlterDoc,
  anchor: CommentAnchor | null | undefined,
): string | undefined {
  if (anchor === null || anchor === undefined) return undefined;
  if (!isCommentAnchorValid(doc, anchor)) return undefined;
  const block = findBlock(doc, anchor.blockId);
  if (block === undefined) return undefined;
  return blockText(block).slice(anchor.offset, anchor.offset + anchor.length);
}

/** Document order index of every top-level block. */
function blockOrder(doc: AlterDoc): Map<string, number> {
  return new Map(doc.blocks.map((block, index) => [block.id, index]));
}

/**
 * Order comments the way they appear in the document: anchored comments by
 * block order and offset, unanchored/unknown blocks last (by creation time).
 */
export function sortCommentsByAnchor(
  comments: readonly Comment[],
  doc: AlterDoc | undefined,
): Comment[] {
  const order = doc === undefined ? new Map<string, number>() : blockOrder(doc);
  const position = (comment: Comment): number | undefined =>
    comment.anchor == null ? undefined : order.get(comment.anchor.blockId);
  return [...comments].sort((left, right) => {
    const leftBlock = position(left);
    const rightBlock = position(right);
    if (leftBlock === undefined && rightBlock === undefined)
      return left.createdAt.localeCompare(right.createdAt);
    if (leftBlock === undefined) return 1;
    if (rightBlock === undefined) return -1;
    if (leftBlock !== rightBlock) return leftBlock - rightBlock;
    const leftOffset = left.anchor?.offset ?? 0;
    const rightOffset = right.anchor?.offset ?? 0;
    if (leftOffset !== rightOffset) return leftOffset - rightOffset;
    return left.createdAt.localeCompare(right.createdAt);
  });
}
