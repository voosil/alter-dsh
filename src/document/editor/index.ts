/**
 * Public surface of the AST document editor.
 *
 * `AlterDocumentView` (integrated by the view owner) only needs the component
 * and its props; the pure helpers are exported for tests and future callers.
 *
 * @module @alter-dsh/space/document/editor
 */
export {
  AlterTiptapEditor,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIMES,
  uploadImageWithClient,
  validateImageFile,
  type AlterTiptapEditorProps,
  type EditorRestoreRequest,
  type ImageAssetResult,
  type ImageUploader,
} from './AlterTiptapEditor';
export {
  LinkBar,
  isWebUrl,
  linkRangeFromElement,
  normalizeLinkHref,
  parseInternalDocLink,
  type InternalDocLink,
  type LinkBarProps,
} from './link-bar';
export {
  SlashMenu,
  filterSlashCommands,
  slashCommands,
  slashMenuPosition,
  slashParagraphRange,
  slashQueryAtSelection,
  type SlashCommand,
  type SlashCommandContext,
  type SlashMenuPosition,
  type SlashMenuProps,
  type SlashMenuState,
} from './slash-menu';
export {
  COMMENT_DECORATION_PLUGIN_KEY,
  COMMENT_MARK_ACTIVE_CLASS,
  COMMENT_MARK_CLASS,
  COMMENT_MARK_RESOLVED_CLASS,
  MAX_COMMENT_QUOTE_LENGTH,
  blockText,
  buildCommentDecorations,
  commentAnchorFromRange,
  commentAnchorRanges,
  commentAnchorText,
  commentBlockAtPosition,
  commentSelectionAnchor,
  commentSelectionQuote,
  createCommentAnchorExtension,
  findCommentBlock,
  getCommentDecorationState,
  refreshCommentDecorations,
  resolveCommentAnchor,
  scrollToCommentAnchor,
  type CommentAnchor,
  type CommentAnchorRange,
  type CommentMarker,
  type CommentSelectionAnchor,
} from './comment-marks';
export {
  astToTiptap,
  blockToTiptap,
  newBlockId,
  tiptapToBlocks,
} from './mapping';
export {
  DocumentDiffError,
  MAX_DIFF_OPERATIONS,
  computeOperations,
} from './operations';
export {
  BLOCK_ID_ATTRIBUTE,
  BLOCK_NODE_TYPES,
  editorExtensions,
} from './schema';
