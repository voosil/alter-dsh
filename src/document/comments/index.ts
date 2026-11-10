/**
 * Document comment rail: anchor helpers, cards, composer and rail.
 *
 * @module @alter-dsh/space/document/comments
 */
export {
  anchorText,
  blockText,
  findBlock,
  isCommentAnchorValid,
  sortCommentsByAnchor,
} from './anchor';
export { CommentCard, type CommentCardProps } from './CommentCard';
export { CommentComposer, type CommentComposerProps } from './CommentComposer';
export { CommentRail, type CommentRailProps } from './CommentRail';
