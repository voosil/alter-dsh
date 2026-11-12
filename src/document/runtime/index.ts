/**
 * Kernel-agnostic document runtime.
 *
 * Everything the document page needs besides the editor kernel itself:
 *
 * - `alterDocToEditorHtml` projects AST blocks into the frozen editor's HTML
 *   syntax (history diff preview and Markdown export); `parseEditorHtml` reads
 *   that syntax back into AST blocks (clipboard paste);
 * - `createDocumentSaveController` owns the debounce/single-flight/conflict/
 *   draft save lifecycle;
 * - draft storage, document snapshots and the block-level Operations diff;
 * - `anchorForQuote` and the anchor repair helpers for inline comments;
 * - structured error reporting for load/save/conflict/render failures.
 *
 * The page reaches these through the single `@alter-space/document-runtime`
 * alias; it never imports a kernel module directly.
 *
 * @module @alter-dsh/space/document/runtime
 */
import { computeOperations } from './operations';
import type { AlterDoc } from '../types';

export {
  alterDocToEditorHtml,
  formatFileSize,
  renderInline,
  type AlterDocToHtmlOptions,
} from './to-html';
export {
  parseEditorHtml,
  type EditorFileAsset,
  type EditorHtmlParseResult,
  type EditorHtmlParserOptions,
} from './html-parser';
export {
  DRAFT_FORMAT,
  DRAFT_STORAGE_PREFIX,
  blocksContentEquivalent,
  blocksEquivalent,
  clearDraft,
  defaultDraftStorage,
  draftMatchesSnapshot,
  draftStorageKey,
  normalizeTitle,
  parseDocumentDraft,
  readDocumentDraft,
  writeDocumentDraft,
  type DocumentDraft,
  type DocumentDraftPayload,
  type DraftStorage,
} from './draft';
export {
  DRAFT_WRITE_INTERVAL_MS,
  SAVE_DEBOUNCE_MS,
  createDocumentSaveController,
  describeSaveError,
  type DocumentSaveController,
  type DocumentSaveControllerOptions,
  type DocumentSaveSnapshot,
  type DocumentSaveStatus,
  type SaveOutcome,
} from './save-controller';
export {
  normalizeSnapshot,
  parseDocumentContent,
  readDocumentSnapshot,
  readRevisionOf,
  serializeDocument,
  type DocumentSnapshot,
} from './snapshot';
export type { DocumentAssetImporter, DocumentClient } from './client-types';
export {
  anchorForQuote,
  blockPlainText,
  detectAnchorDrift,
  planCommentAnchorRepairs,
  planReanchor,
  quoteMatchesAnchorText,
  validateCommentAnchor,
  type AnchorComment,
  type AnchorDrift,
  type AnchorRepair,
  type AnchorRepairPlan,
  type CommentAnchor,
  type CommentAnchorStatus,
} from './anchors';
export {
  DOCUMENT_ERROR_LOG_PREFIX,
  reportDocumentError,
  type DocumentErrorContext,
  type DocumentErrorReport,
  type DocumentErrorScope,
} from './errors';
export type { EditorBlockType } from '../editors/kernel';
export type { TiptapBodyProps } from '../editors/tiptap/body';
export { TiptapBody } from '../editors/tiptap/body';

/** Block-level Document-Operations diff used for one save. */
export function computeAstOperations(
  oldDoc: AlterDoc,
  newDoc: AlterDoc,
  limit?: number,
): ReturnType<typeof computeOperations> {
  return computeOperations(oldDoc, newDoc, limit);
}

/** AST types re-exported for page consumers. */
export type { AlterDoc, BlockNode, InlineNode, JsonValue } from '../types';