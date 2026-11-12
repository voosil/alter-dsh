/**
 * AST ↔ legacy contentEditable editor adapter.
 *
 * The pre-rebuild Space document UI (restored from the old tree) keeps its
 * DOM/CSS and edits HTML. This module is the seam that lets it edit the
 * authoritative `alter-doc/1` AST:
 *
 * - `alterDocToEditorHtml` projects AST blocks into the editor's HTML syntax;
 * - `parseLegacyHtml` parses that HTML (plus editor-created legacy nodes) back
 *   into AST blocks, reusing `data-block-id` ids;
 * - `materializeLegacyAssets` uploads inline `data:` images/files before a save;
 * - `createLegacySaveController` owns the debounce/single-flight/conflict/draft
 *   save lifecycle;
 * - `anchorForQuote` maps a comment quote to a top-level block anchor.
 *
 * @module @alter-dsh/space/document/editors/legacy
 */
import { computeOperations } from './operations';
import type { AlterDoc } from '../../types';

export {
  alterDocToEditorHtml,
  formatFileSize,
  renderInline,
  type AlterDocToHtmlOptions,
} from './to-html';
export {
  parseLegacyHtml,
  type LegacyFileAsset,
  type LegacyHtmlParseResult,
  type LegacyHtmlParserOptions,
} from './html-parser';
export {
  materializeLegacyAssets,
  type LegacyAssetImporter,
  type MaterializedLegacyHtml,
} from './materialize';
export {
  DRAFT_FORMAT,
  LEGACY_DRAFT_FORMAT,
  LEGACY_DRAFT_STORAGE_PREFIX,
  blocksContentEquivalent,
  blocksEquivalent,
  clearLegacyDraft,
  defaultDraftStorage,
  draftBlocks,
  legacyDraftMatchesSnapshot,
  legacyDraftStorageKey,
  normalizeTitle,
  parseDocumentDraft,
  parseLegacyDraft,
  readLegacyDraft,
  writeDocumentDraft,
  writeLegacyDraft,
  type DocumentDraft,
  type DocumentDraftPayload,
  type LegacyDocumentDraft,
  type LegacyDraftStorage,
  type RecoverableDraft,
} from './draft';
export {
  LEGACY_DRAFT_WRITE_INTERVAL_MS,
  LEGACY_SAVE_DEBOUNCE_MS,
  createLegacySaveController,
  describeLegacySaveError,
  type LegacySaveController,
  type LegacySaveControllerOptions,
  type LegacySaveOutcome,
  type LegacySaveSnapshot,
  type LegacySaveStatus,
} from './save-controller';
export {
  normalizeSnapshot,
  parseDocumentContent,
  readDocumentSnapshot,
  readRevisionOf,
  serializeDocument,
  type LegacyDocumentSnapshot,
} from './snapshot';
export type { LegacyDocumentClient } from './client-types';
export {
  anchorForQuote,
  blockPlainText,
  detectAnchorDrift,
  planCommentAnchorRepairs,
  planReanchor,
  quoteMatchesAnchorText,
  validateCommentAnchor,
  type LegacyAnchorComment,
  type LegacyAnchorDrift,
  type LegacyAnchorRepair,
  type LegacyAnchorRepairPlan,
  type LegacyCommentAnchor,
  type LegacyCommentAnchorStatus,
} from './anchors';
export {
  LEGACY_ERROR_LOG_PREFIX,
  reportLegacyDocumentError,
  type LegacyDocumentErrorContext,
  type LegacyDocumentErrorReport,
  type LegacyDocumentErrorScope,
} from './errors';
export {
  LEGACY_KERNEL_ATTRIBUTE_VALUE,
  LEGACY_KERNEL_KIND,
  captureLegacyBlocks,
  createLegacyKernel,
  normalizeCapturedBlocks,
  normalizeKernelSelection,
  type LegacyEditorProps,
  type LegacyKernelOptions,
  type MountedLegacyKernel,
} from './kernel';
// Kernel-neutral surface the document page (a frozen vendor component) reaches
// through this single adapter alias: the contract types and the preference.
export {
  DEFAULT_EDITOR_KERNEL,
  EDITOR_KERNEL_PREFERENCE_KEY,
  parseEditorKernelPreference,
  readEditorKernelPreference,
  writeEditorKernelPreference,
  type EditorKernelPreference,
} from '../kernel-preference';
export type {
  EditorKernel,
  EditorKernelKind,
  EditorKernelListener,
  EditorKernelProps,
  EditorKernelSelection,
} from '../kernel';
// The AST-native body, mounted by the frozen page when the preference selects
// it. The page never imports a kernel module directly.
export { TiptapBody, type TiptapBodyProps } from '../tiptap/body';

/** Block-level Document-Operations diff used for one legacy save. */
export function computeAstOperations(
  oldDoc: AlterDoc,
  newDoc: AlterDoc,
  limit?: number,
): ReturnType<typeof computeOperations> {
  return computeOperations(oldDoc, newDoc, limit);
}

/** AST types re-exported for adapter consumers. */
export type { AlterDoc, BlockNode, InlineNode, JsonValue } from '../../types';
